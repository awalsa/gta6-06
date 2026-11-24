// combat.js — ISLA BRASA 3D: weapons, shooting, weapon wheel, thug enemies.
//
// W3 (combat + police + missions + races). Built from the design specs only.
// Contract: exports init(ctx) and update(dt, ctx); attaches ctx.combat.
//   ctx.combat = {
//     weapons, current, enemies, kills,
//     selectWeapon(name), shoot(), punch(),
//     spawnEnemy(x, z, hp), spawnEnemies(count, center, opts),
//     spawnWave(count, center, opts), damageEnemy(enemy, amount),
//     wheelOpen, stats,
//   }
// The weapon wheel UI itself is rendered by hud.js (it shows while Q is held
// and calls ctx.combat.selectWeapon on click / Digit 1-7). This module owns
// the selection state, the Q-hold tracking and the number-key fallback, so the
// wheel works even if the HUD is still loading.
// Muzzle flashes go through ctx.particles (muzzle/burst) and shot sounds
// through ctx.audio.playSfx, both guarded — combat works without them.
// Hitting an enemy raises state.wanted by 1 (first hit per enemy); kills are
// counted on combat.kills and state.kills so missions.js 'clear' steps see
// them. A shot also stamps state.lastGunshot so pedestrians flee.

import THREE_SHIM from './three.js';
import * as Config from './config.js';

// Damage / range / shots-per-second come from config.js (single source of
// truth); the extra fields here are local combat behaviour.
const CFG_STATS = Config.WEAPON_STATS || {};
function stat(id, fallback) {
  const c = CFG_STATS[id] || {};
  return {
    damage: c.damage ?? fallback.damage,
    range: c.range ?? fallback.range,
    // config rate = shots per second; cooldown is the time between shots.
    cooldown: c.rate ? 1 / c.rate : fallback.cooldown,
    spread: fallback.spread,
    auto: fallback.auto,
    explosive: !!fallback.explosive,
    pellets: fallback.pellets || 1,
    name: fallback.name,
  };
}
const WEAPON_STATS = {
  fists: stat('fists', { damage: 15, range: 2.2, cooldown: 0.5, spread: 0, auto: false, name: 'Fists' }),
  pistol: stat('pistol', { damage: 25, range: 40, cooldown: 0.35, spread: 0.02, auto: false, name: 'Pistol' }),
  smg: stat('smg', { damage: 12, range: 30, cooldown: 0.11, spread: 0.06, auto: true, name: 'SMG' }),
  shotgun: stat('shotgun', { damage: 45, range: 18, cooldown: 0.9, spread: 0.22, auto: false, pellets: 5, name: 'Shotgun' }),
  rifle: stat('rifle', { damage: 40, range: 60, cooldown: 0.15, spread: 0.01, auto: true, name: 'Rifle' }),
  sniper: stat('sniper', { damage: 100, range: 120, cooldown: 1.2, spread: 0, auto: false, name: 'Sniper' }),
  rpg: stat('rpg', { damage: 150, range: 60, cooldown: 1.5, spread: 0, auto: false, explosive: true, name: 'RPG' }),
};

// The five wheel weapons; sniper and RPG join the wheel once bought.
const BASE_WEAPONS = ['fists', 'pistol', 'smg', 'shotgun', 'rifle'];
const SHOP_WEAPONS = ['sniper', 'rpg'];
const WHEEL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'];
const WHEEL_ORDER = [...BASE_WEAPONS, ...SHOP_WEAPONS];

const ENEMY_MELEE_DAMAGE = 4;
const ENEMY_MELEE_RANGE = 2.0;
const ENEMY_MELEE_COOLDOWN = 1.5;
const ENEMY_CHASE_RANGE = 25;
const ENEMY_WALK_SPEED = 2.6;

let T = THREE_SHIM || null; // THREE namespace, resolved in init from ctx.THREE or the shim.

function keyDown(input, ...codes) {
  if (!input) return false;
  const keys = input.keys;
  if (keys) {
    if (typeof keys.has === 'function') {
      for (const c of codes) if (keys.has(c)) return true;
    } else {
      for (const c of codes) {
        if (keys[c]) return true;
        const letter = c.replace(/^Key/, '');
        if (keys[letter] || keys[letter.toLowerCase()]) return true;
      }
    }
  }
  for (const c of codes) if (input[c]) return true;
  return false;
}

// Audio is best-effort: only the SFX names audio.js actually implements are
// used here (gunshot, pickup, click, siren, explosion).
function playSfx(ctx, name) {
  try {
    const a = ctx && ctx.audio;
    if (a && typeof a.playSfx === 'function') a.playSfx(name);
  } catch (e) { /* audio is decoration */ }
}

// Particles use the real particles.js API: burst(pos, color, count, speed)
// plus the muzzle/sparkle/explosion helpers. Anything else is ignored.
function burstParticles(ctx, pos, color, count, speed) {
  try {
    const p = ctx && ctx.particles;
    if (!p) return;
    if (typeof p.burst === 'function') p.burst(pos, color, count, speed);
  } catch (e) { /* particles are decoration */ }
}

function muzzleParticles(ctx, pos) {
  try {
    const p = ctx && ctx.particles;
    if (!p) return;
    if (typeof p.muzzle === 'function') p.muzzle(pos);
    else if (typeof p.burst === 'function') p.burst(pos, 0xffd34d, 6, 9);
  } catch (e) { /* particles are decoration */ }
}

// Aim follows the camera on foot (camera-relative shooting); while driving
// there is no shooting, so the car heading is only a fallback.
function aimDirection(ctx) {
  const dir = new T.Vector3();
  if (ctx.camera) ctx.camera.getWorldDirection(dir);
  else if (ctx.player && ctx.player.mesh) {
    dir.set(Math.sin(ctx.player.mesh.rotation.y), 0, Math.cos(ctx.player.mesh.rotation.y));
  } else dir.set(0, 0, -1);
  dir.y = 0;
  if (dir.lengthSq() < 0.001) dir.set(0, 0, -1);
  return dir.normalize();
}

function aimOrigin(ctx) {
  if (ctx.player && ctx.player.pos) {
    return new T.Vector3(ctx.player.pos.x, ctx.player.pos.y + 1.4, ctx.player.pos.z);
  }
  return new T.Vector3(0, 1.4, 0);
}

// --- Enemy HP bar: a small canvas sprite floating above the head. ---
function makeHpBar() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 10;
  const tex = new T.CanvasTexture(canvas);
  const sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.4, 0.22, 1);
  sprite.position.y = 2.35;
  return { canvas, tex, sprite };
}

function drawHpBar(bar, frac) {
  const c = bar.canvas.getContext('2d');
  c.clearRect(0, 0, 64, 10);
  c.fillStyle = 'rgba(0,0,0,0.7)';
  c.fillRect(0, 0, 64, 10);
  c.fillStyle = frac > 0.5 ? '#2ecc71' : frac > 0.25 ? '#f1c40f' : '#e74c3c';
  c.fillRect(1, 1, Math.max(0, 62 * frac), 8);
  bar.tex.needsUpdate = true;
}

function buildThugMesh() {
  const group = new T.Group();
  group.name = 'thug';
  const shirtMat = new T.MeshLambertMaterial({ color: 0x7f8c8d });
  const pantsMat = new T.MeshLambertMaterial({ color: 0x2c3e50 });
  const skinMat = new T.MeshLambertMaterial({ color: 0xc68642 });
  const capMat = new T.MeshLambertMaterial({ color: 0x8e44ad });

  const torso = new T.Mesh(new T.CapsuleGeometry(0.32, 0.45, 4, 10), shirtMat);
  torso.position.y = 1.05;
  group.add(torso);
  const head = new T.Mesh(new T.SphereGeometry(0.26, 12, 10), skinMat);
  head.position.y = 1.72;
  group.add(head);
  // Cap so thugs read as thugs, not civilians.
  const cap = new T.Mesh(new T.CylinderGeometry(0.27, 0.28, 0.12, 12), capMat);
  cap.position.y = 1.9;
  group.add(cap);
  const armGeo = new T.BoxGeometry(0.16, 0.62, 0.16);
  const armL = new T.Mesh(armGeo, shirtMat);
  armL.position.set(-0.42, 1.15, 0);
  group.add(armL);
  const armR = new T.Mesh(armGeo, shirtMat);
  armR.position.set(0.42, 1.15, 0);
  group.add(armR);
  const legGeo = new T.BoxGeometry(0.2, 0.78, 0.2);
  const legL = new T.Mesh(legGeo, pantsMat);
  legL.position.set(-0.16, 0.41, 0);
  group.add(legL);
  const legR = new T.Mesh(legGeo, pantsMat);
  legR.position.set(0.16, 0.41, 0);
  group.add(legR);
  return group;
}

export function init(ctx) {
  T = (ctx && ctx.THREE) || THREE_SHIM;
  if (!T) throw new Error('combat: THREE is not available (ctx.THREE / ./three.js)');

  const combat = {
    weapons: [...BASE_WEAPONS],
    current: 'fists',
    enemies: [],
    kills: 0,
    stats: WEAPON_STATS,
    _cooldown: 0,
    _prevMouse: false,
    _prevF: false,
    _prevWheelKeys: {},
    _wheelOpen: false,
    _flash: null,
    _flashT: 0,

    get wheelOpen() { return this._wheelOpen; },

    // Brief muzzle-flash quad at the gun tip.
    _showFlash(origin, dir) {
      if (!this._flash) {
        const mat = new T.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95 });
        this._flash = new T.Mesh(new T.PlaneGeometry(0.5, 0.5), mat);
        ctx.scene.add(this._flash);
      }
      this._flash.position.copy(origin).addScaledVector(dir, 1.0);
      this._flash.position.y = origin.y;
      this._flash.lookAt(ctx.camera ? ctx.camera.position : origin);
      this._flash.visible = true;
      this._flashT = 0.06;
    },

    _refreshWeapons() {
      const owned = (ctx.state && ctx.state.weaponsOwned) || [];
      const list = [...BASE_WEAPONS];
      for (const w of SHOP_WEAPONS) if (owned.includes(w)) list.push(w);
      this.weapons = list;
      if (!list.includes(this.current)) this.current = 'fists';
    },

    // Called by the weapon wheel (hud.js) and by the Digit 1-7 fallback in
    // update(). Returns false when the weapon is not owned / not on the wheel.
    selectWeapon(name) {
      this._refreshWeapons();
      if (!this.weapons.includes(name)) return false;
      this.current = name;
      if (ctx.state) {
        ctx.state.currentWeapon = name;
        ctx.state.weapon = name;
      }
      return true;
    },

    // Nearest living enemy inside range and inside the aim cone.
    _pickTarget(origin, dir, range, maxAngle) {
      let best = null;
      let bestScore = Infinity;
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const to = new T.Vector3(e.pos.x - origin.x, 0, e.pos.z - origin.z);
        const dist = to.length();
        if (dist > range) continue;
        to.normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, to.dot(dir))));
        if (angle > maxAngle) continue;
        const score = dist + angle * 10;
        if (score < bestScore) { bestScore = score; best = e; }
      }
      return best;
    },

    shoot() {
      if (this._cooldown > 0) return false;
      if (ctx.player && ctx.player.inCar) return false; // no drive-by shooting
      const stats = WEAPON_STATS[this.current] || WEAPON_STATS.fists;
      this._cooldown = stats.cooldown;

      const origin = aimOrigin(ctx);
      const dir = aimDirection(ctx);

      // Fists = punch: melee range, no muzzle flash, no gunshot.
      if (this.current === 'fists') return this.punch();

      this._showFlash(origin, dir);
      muzzleParticles(ctx, origin.clone().addScaledVector(dir, 1.0));
      playSfx(ctx, 'gunshot');
      // Pedestrians flee from the sound (pedestrians.js reads this).
      if (ctx.state) {
        ctx.state.lastGunshot = {
          x: origin.x,
          y: typeof origin.y === 'number' ? origin.y : 0,
          z: origin.z,
          t: (typeof performance !== 'undefined' ? performance.now() : 0) / 1000,
        };
      }

      // Shotgun: wide cone, one damage roll per pellet against the same pick.
      const cone = stats.spread > 0.1 ? 0.35 : stats.spread > 0.03 ? 0.18 : 0.08;
      const target = this._pickTarget(origin, dir, stats.range, cone);
      if (target) {
        // A pellet spread still lands as one hit on one target; the extra
        // pellets only matter at point-blank range.
        const dist = Math.hypot(target.pos.x - origin.x, target.pos.z - origin.z);
        const dmg = stats.pellets > 1
          ? stats.damage * (dist < 4 ? stats.pellets : 1)
          : stats.damage;
        this.damageEnemy(target, dmg);
        burstParticles(ctx, new T.Vector3(target.pos.x, 1.4, target.pos.z), 0xffdd55, 5, 6);
        if (stats.explosive) {
          burstParticles(ctx, new T.Vector3(target.pos.x, 1.0, target.pos.z), 0xff7722, 30, 14);
          playSfx(ctx, 'explosion');
          // RPG splash: nearby thugs take half damage.
          for (const e of [...this.enemies]) {
            if (e === target || !e.alive) continue;
            if (Math.hypot(e.pos.x - target.pos.x, e.pos.z - target.pos.z) <= 5) {
              this.damageEnemy(e, Math.round(stats.damage / 2));
            }
          }
        }
      }
      return true; // shot fired, whether or not anything was hit
    },

    punch() {
      const stats = WEAPON_STATS.fists;
      if (this.current !== 'fists') {
        // F with a gun equipped: quick melee shove, own cooldown.
        if (this._cooldown > 0) return false;
        this._cooldown = 0.4;
      }
      const origin = aimOrigin(ctx);
      const dir = aimDirection(ctx);
      const target = this._pickTarget(origin, dir, stats.range, 0.9);
      if (target) {
        this.damageEnemy(target, stats.damage);
        playSfx(ctx, 'click');
        return true;
      }
      return false;
    },

    spawnEnemy(x, z, hp = 100) {
      const mesh = buildThugMesh();
      mesh.position.set(x, 0, z);
      ctx.scene.add(mesh);
      const bar = makeHpBar();
      mesh.add(bar.sprite);
      drawHpBar(bar, 1);
      const enemy = {
        mesh,
        pos: mesh.position, // THREE.Vector3, same reference as mesh.position
        hp,
        maxHp: hp,
        alive: true,
        bar,
        wantedCounted: false,
        attackCooldown: 0,
        _phase: Math.random() * Math.PI * 2,
      };
      this.enemies.push(enemy);
      return enemy;
    },

    // Batch spawner the missions module calls for 'clear' steps.
    // center is a THREE.Vector3 or an [x, z] array. Returns the spawned
    // enemies so missions can track them.
    spawnEnemies(count = 1, center, opts) {
      const out = [];
      const cx = center ? (typeof center.x === 'number' ? center.x : center[0] || 0) : 0;
      const cz = center ? (typeof center.z === 'number' ? center.z : center[1] || 0) : 0;
      const n = Math.max(1, Math.floor(count) || 1);
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        out.push(this.spawnEnemy(cx + Math.cos(angle) * 6, cz + Math.sin(angle) * 6));
      }
      return out;
    },

    spawnWave(count, center, opts) {
      return this.spawnEnemies(count, center, opts);
    },

    // Returns true when the hit killed the enemy.
    damageEnemy(e, amount) {
      if (!e || !e.alive) return false;
      e.hp -= amount;
      drawHpBar(e.bar, Math.max(0, e.hp / e.maxHp));
      // First hit on an NPC raises the heat (police module reads state.wanted).
      if (!e.wantedCounted) {
        e.wantedCounted = true;
        if (ctx.state) ctx.state.wanted = Math.min(5, (ctx.state.wanted || 0) + 1);
      }
      if (e.hp <= 0) {
        e.alive = false;
        burstParticles(ctx, new T.Vector3(e.pos.x, 1.0, e.pos.z), 0xff7722, 12, 10);
        playSfx(ctx, 'explosion');
        ctx.scene.remove(e.mesh);
        const i = this.enemies.indexOf(e);
        if (i >= 0) this.enemies.splice(i, 1);
        // Missions count kills via combat.kills (first) or state.kills.
        this.kills += 1;
        if (ctx.state) ctx.state.kills = (ctx.state.kills || 0) + 1;
        return true;
      }
      return false;
    },
  };

  combat._refreshWeapons();
  // Restore the saved weapon when it is owned.
  if (ctx.state && ctx.state.currentWeapon && combat.weapons.includes(ctx.state.currentWeapon)) {
    combat.current = ctx.state.currentWeapon;
  }
  ctx.combat = combat;
  return combat;
}

export function update(dt, ctx) {
  const combat = ctx.combat;
  if (!combat) return;
  const step = typeof dt === 'number' && dt > 0 ? Math.min(dt, 0.1) : 0.016;

  if (combat._cooldown > 0) combat._cooldown -= step;
  if (combat._flash) {
    combat._flashT -= step;
    if (combat._flashT <= 0) combat._flash.visible = false;
  }

  // Keep the wheel list in sync with shop purchases.
  combat._refreshWeapons();

  const input = ctx.input || {};
  const onFoot = !(ctx.player && ctx.player.inCar);
  const uiOpen = !!(ctx.state && ctx.state.uiOpen);

  // --- Weapon wheel: Q held opens it (hud.js renders the wheel DOM). ---
  const qHeld = keyDown(input, 'KeyQ');
  combat._wheelOpen = qHeld && onFoot && !uiOpen;
  if (combat._wheelOpen) {
    // Digit 1-7 while the wheel is open selects a weapon. hud.js also does
    // this when its wheel is visible; selectWeapon is idempotent, so the
    // fallback here only fills the gap if the HUD listener is not attached.
    for (let i = 0; i < WHEEL_ORDER.length; i++) {
      const code = WHEEL_KEYS[i];
      const down = keyDown(input, code);
      if (down && !combat._prevWheelKeys[code]) {
        combat.selectWeapon(WHEEL_ORDER[i]);
      }
      combat._prevWheelKeys[code] = down;
    }
  }

  // --- Mouse click to shoot (hold for auto weapons, click for semi-auto). ---
  const mouse = input.mouse || {};
  const mouseDown = !!(mouse.down || input.mouseDown || input.clicked || input.fire || input.mouse0);
  const stats = WEAPON_STATS[combat.current] || WEAPON_STATS.fists;
  if (onFoot && !uiOpen && mouseDown) {
    if (stats.auto) {
      if (combat._cooldown <= 0) combat.shoot();
    } else if (!combat._prevMouse) {
      combat.shoot();
    }
  }
  combat._prevMouse = mouseDown;

  // --- F: punch when fists are selected, or shove a close enemy. ---
  const fDown = keyDown(input, 'KeyF');
  if (onFoot && !uiOpen && fDown && !combat._prevF) {
    if (combat.current === 'fists') {
      combat._cooldown = 0; // let the punch through immediately
      combat.punch();
    } else {
      const origin = aimOrigin(ctx);
      const dir = aimDirection(ctx);
      const near = combat._pickTarget(origin, dir, WEAPON_STATS.fists.range, 0.9);
      if (near) combat.punch();
    }
  }
  combat._prevF = fDown;

  // Publish the live attack state for pedestrians.js: peds flee when the
  // player is firing a gun or punching right next to them. Written every
  // frame so the flags clear the moment the player stops attacking (and so
  // they exist as false/null from boot via state.js DEFAULT_STATE).
  if (ctx.state) {
    ctx.state.playerFiring = !!(onFoot && !uiOpen && mouseDown && combat.current !== 'fists');
    ctx.state.playerAttacking = !!(ctx.state.playerFiring || (onFoot && !uiOpen && fDown));
  }

  // --- Enemy behaviour: face the player, close in, melee when point-blank. ---
  const playerPos = ctx.player && ctx.player.pos;
  if (playerPos) {
    for (const e of [...combat.enemies]) {
      if (!e.alive) continue;
      const dx = playerPos.x - e.pos.x;
      const dz = playerPos.z - e.pos.z;
      const dist = Math.hypot(dx, dz);
      e.mesh.rotation.y = Math.atan2(dx, dz);
      if (dist > 2.2 && dist < ENEMY_CHASE_RANGE) {
        const s = ENEMY_WALK_SPEED * step;
        e.pos.x += (dx / dist) * s;
        e.pos.z += (dz / dist) * s;
        e._phase += step * 6;
        e.mesh.position.y = Math.abs(Math.sin(e._phase)) * 0.05;
      }
      if (e.attackCooldown > 0) e.attackCooldown -= step;
      if (dist <= ENEMY_MELEE_RANGE && e.attackCooldown <= 0) {
        e.attackCooldown = ENEMY_MELEE_COOLDOWN;
        if (ctx.state && typeof ctx.state.health === 'number') {
          // Armor absorbs the hit first when the player has any.
          if (ctx.state.armor > 0) {
            ctx.state.armor = Math.max(0, ctx.state.armor - ENEMY_MELEE_DAMAGE);
          } else {
            ctx.state.health = Math.max(0, ctx.state.health - ENEMY_MELEE_DAMAGE);
          }
          if (ctx.state.health <= 0 && typeof ctx.onPlayerDowned === 'function') {
            ctx.onPlayerDowned();
          }
        }
      }
    }
  }
}

export { WEAPON_STATS };

export default { init, update, WEAPON_STATS };
