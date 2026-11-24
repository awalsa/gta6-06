// police.js — ISLA BRASA 3D: wanted level, police pursuit, REAL roadblocks,
// CONDOR-1 helicopter.
//
// W3 (combat + police + missions + races). Built from the design specs only.
// Contract: exports init(ctx) and update(dt, ctx); attaches ctx.police.
//   ctx.police = {
//     wanted, addWanted(n), setWanted(n), clearWanted(),
//     roadblocks, heli, heliActive, policeCars, isHidden,
//   }
// Wanted is 0-5 stars in state.wanted. It rises when the player harms NPCs
// (combat.js), steals a car (missions.js sets state.stoleCar) or when another
// module sets state.offence / state.harmedNpc. It decays one star at a time
// after the player stays unseen for a while. Police cars chase and ram.
// At 3+ stars: two REAL roadblocks (police-car barricades across the road
// ahead of the player, with collision — they stop cars and push the player
// out) plus the CONDOR-1 helicopter (low-poly heli mesh, spinning rotor,
// searchlight cone + spotlight tracking the player). While the heli is up the
// player counts as seen, so the wanted level cannot decay.

import THREE_SHIM from './three.js';
import * as Config from './config.js';

const LANDMARKS = (Config && Config.LANDMARKS) || {};
const WORLD_SIZE = (Config && Config.WORLD_SIZE) || 400;
const ROAD_SPACING = (Config && Config.ROAD_SPACING) || 40;
const ROADBLOCK_WANTED = (Config && Config.ROADBLOCK_WANTED) || 3;

const MAX_WANTED = 5;
const MAX_POLICE_CARS = 5;
// Seconds unseen before one star decays (longer at higher heat).
const HIDE_DECAY_BASE = 15;
const HIDE_DECAY_PER_STAR = 3;
// Distance inside which a police car counts as "seeing" the player.
const SIGHT_RANGE = 45;
const POLICE_SPAWN_DIST = 55;
const POLICE_DESPAWN_DIST = 130;
const ROADBLOCK_COUNT = 2;
const ROADBLOCK_REPLACE_SECONDS = 18;

let T = THREE_SHIM || null; // THREE namespace, resolved in init from ctx.THREE or the shim.
let boundCtx = null;
let policeCars = []; // { group, speed, heading, ramCooldown, lightTimer }
let roadblocks = []; // { group, cars:[group, group], anchor:Vector3 }
let heli = null; // { group, rotor, cone, leaving }
let heliLight = null;
let hiddenTime = 0;
let roadblockTimer = 0;
let wantedHudEl = null;

function stateOf(ctx) {
  if (!ctx) return {};
  if (!ctx.state) ctx.state = {};
  if (typeof ctx.state.wanted !== 'number' || Number.isNaN(ctx.state.wanted)) {
    ctx.state.wanted = 0;
  }
  return ctx.state;
}

export function getWanted(ctx) {
  return stateOf(ctx || boundCtx).wanted || 0;
}

// Player position, accepting every shape the player / vehicle modules use.
export function playerPos(ctx) {
  const c = ctx || boundCtx;
  if (!c) return new T.Vector3(0, 0, 0);
  const p = c.player;
  if (p) {
    if (p.pos && typeof p.pos.x === 'number') return p.pos.clone();
    if (p.position && typeof p.position.x === 'number') {
      return new T.Vector3(p.position.x, p.position.y || 0, p.position.z || 0);
    }
    if (p.mesh && p.mesh.position && typeof p.mesh.position.x === 'number') {
      return p.mesh.position.clone();
    }
    if (typeof p.x === 'number') return new T.Vector3(p.x, p.y || 0, p.z || 0);
  }
  const s = c.state || {};
  if (s.playerPos) {
    if (typeof s.playerPos.x === 'number') {
      return new T.Vector3(s.playerPos.x, s.playerPos.y || 0, s.playerPos.z || 0);
    }
    if (Array.isArray(s.playerPos)) {
      return new T.Vector3(s.playerPos[0] || 0, 0, s.playerPos[1] || 0);
    }
  }
  if (c.camera && c.camera.position) return c.camera.position.clone().setY(0);
  return new T.Vector3(0, 0, 0);
}

function playerHeading(ctx) {
  const c = ctx || boundCtx;
  if (!c) return 0;
  if (c.player && typeof c.player.heading === 'number') return c.player.heading;
  if (typeof c.playerHeading === 'number') return c.playerHeading;
  if (c.state && typeof c.state.playerHeading === 'number') return c.state.playerHeading;
  if (c.camera) {
    const dir = new T.Vector3();
    c.camera.getWorldDirection(dir);
    return Math.atan2(dir.x, dir.z);
  }
  return 0;
}

function playerInCar(ctx) {
  const c = ctx || boundCtx;
  if (!c) return false;
  const s = c.state || {};
  if (s.inCar || s.driving) return true;
  if (c.player && (c.player.inCar || c.player.driving)) return true;
  if (c.cars && c.cars.current) return true;
  return false;
}

function setPlayerPos(ctx, pos) {
  const c = ctx || boundCtx;
  if (!c) return;
  const p = c.player;
  if (p && p.pos && typeof p.pos.x === 'number') {
    p.pos.set(pos.x, pos.y, pos.z);
    return;
  }
  if (p && p.mesh && p.mesh.position) {
    p.mesh.position.set(pos.x, pos.y, pos.z);
    return;
  }
  const s = c.state || {};
  if (Array.isArray(s.playerPos)) {
    s.playerPos[0] = pos.x; s.playerPos[1] = pos.y; s.playerPos[2] = pos.z;
  }
}

function damagePlayer(ctx, amount) {
  const c = ctx || boundCtx;
  if (!c) return;
  const s = c.state || {};
  if (typeof s.health === 'number') {
    if (s.armor > 0) {
      const absorbed = Math.min(s.armor, amount);
      s.armor -= absorbed;
      s.health = Math.max(0, s.health - (amount - absorbed));
    } else {
      s.health = Math.max(0, s.health - amount);
    }
    if (s.health <= 0 && typeof c.onPlayerDowned === 'function') c.onPlayerDowned();
    return;
  }
  if (c.player && typeof c.player.damage === 'function') c.player.damage(amount);
}

function playSfx(ctx, name) {
  try {
    const a = ctx && ctx.audio;
    if (a && typeof a.playSfx === 'function') a.playSfx(name);
  } catch (e) { /* audio is decoration */ }
}

function showMessage(ctx, text) {
  try {
    if (ctx && ctx.hud && typeof ctx.hud.showMessage === 'function') {
      ctx.hud.showMessage(text);
      return;
    }
    if (ctx && typeof ctx.notify === 'function') ctx.notify(text);
  } catch (e) { /* HUD is best-effort */ }
}

// --- Mesh builders -------------------------------------------------------

function makePoliceCarMesh() {
  const group = new T.Group();
  const bodyMat = new T.MeshStandardMaterial({ color: 0x111318, roughness: 0.4, metalness: 0.5 });
  const whiteMat = new T.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.3 });
  const glassMat = new T.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.1, metalness: 0.8 });
  const body = new T.Mesh(new T.BoxGeometry(2.0, 0.55, 4.4), whiteMat);
  body.position.y = 0.55;
  group.add(body);
  const lower = new T.Mesh(new T.BoxGeometry(2.05, 0.35, 4.5), bodyMat);
  lower.position.y = 0.28;
  group.add(lower);
  const cabin = new T.Mesh(new T.BoxGeometry(1.7, 0.5, 2.2), glassMat);
  cabin.position.set(0, 1.05, -0.2);
  group.add(cabin);
  // Light bar: red left, blue right — flashed alternately in update().
  const red = new T.Mesh(
    new T.BoxGeometry(0.45, 0.18, 0.3),
    new T.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 1.5 }),
  );
  red.position.set(-0.45, 1.35, -0.2);
  red.name = 'lightRed';
  group.add(red);
  const blue = new T.Mesh(
    new T.BoxGeometry(0.45, 0.18, 0.3),
    new T.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x0022ff, emissiveIntensity: 1.5 }),
  );
  blue.position.set(0.45, 1.35, -0.2);
  blue.name = 'lightBlue';
  group.add(blue);
  const wheelGeo = new T.CylinderGeometry(0.38, 0.38, 0.3, 10);
  const wheelMat = new T.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
  for (const [wx, wz] of [[-1.0, 1.5], [1.0, 1.5], [-1.0, -1.5], [1.0, -1.5]]) {
    const w = new T.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.38, wz);
    group.add(w);
  }
  group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return group;
}

function makeHeliMesh() {
  const group = new T.Group();
  group.name = 'CONDOR-1';
  const bodyMat = new T.MeshStandardMaterial({ color: 0x1c2a44, roughness: 0.5, metalness: 0.4 });
  const glassMat = new T.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.1, metalness: 0.6 });
  const body = new T.Mesh(new T.BoxGeometry(2.2, 1.6, 4.2), bodyMat);
  group.add(body);
  const nose = new T.Mesh(new T.BoxGeometry(1.9, 1.2, 1.2), glassMat);
  nose.position.set(0, -0.1, 2.4);
  group.add(nose);
  const tail = new T.Mesh(new T.BoxGeometry(0.5, 0.5, 4.0), bodyMat);
  tail.position.set(0, 0.3, -3.8);
  group.add(tail);
  const fin = new T.Mesh(new T.BoxGeometry(0.2, 1.4, 0.9), bodyMat);
  fin.position.set(0, 0.9, -5.5);
  group.add(fin);
  // Main rotor (spins in update).
  const rotor = new T.Group();
  rotor.position.y = 1.1;
  const bladeGeo = new T.BoxGeometry(9.0, 0.08, 0.35);
  const bladeMat = new T.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  rotor.add(new T.Mesh(bladeGeo, bladeMat));
  const blade2 = new T.Mesh(bladeGeo, bladeMat);
  blade2.rotation.y = Math.PI / 2;
  rotor.add(blade2);
  rotor.name = 'rotor';
  group.add(rotor);
  // Skids.
  const skidMat = new T.MeshStandardMaterial({ color: 0x333333, roughness: 0.7 });
  for (const sx of [-0.9, 0.9]) {
    const skid = new T.Mesh(new T.BoxGeometry(0.12, 0.12, 3.4), skidMat);
    skid.position.set(sx, -1.1, 0);
    group.add(skid);
  }
  // Searchlight cone (additive, translucent): apex at the heli, opening down.
  const coneGeo = new T.ConeGeometry(4.5, 30, 20, 1, true);
  const coneMat = new T.MeshBasicMaterial({
    color: 0xfff6c0, transparent: true, opacity: 0.16,
    side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending,
  });
  const cone = new T.Mesh(coneGeo, coneMat);
  cone.name = 'searchCone';
  cone.rotation.x = Math.PI;
  cone.position.y = -16;
  group.add(cone);
  group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return group;
}

// --- Wanted stars HUD ----------------------------------------------------

function ensureWantedHud() {
  if (typeof document === 'undefined') return;
  if (wantedHudEl && document.body.contains(wantedHudEl)) return;
  wantedHudEl = document.getElementById('wanted-stars') || document.getElementById('wanted');
  if (!wantedHudEl) {
    wantedHudEl = document.createElement('div');
    wantedHudEl.id = 'wanted-stars';
    wantedHudEl.style.cssText = [
      'position:fixed', 'top:12px', 'right:14px', 'z-index:55',
      'font-size:26px', 'letter-spacing:4px', 'color:#ffd34d',
      'text-shadow:0 0 8px rgba(0,0,0,0.8)', 'pointer-events:none',
      'font-family:system-ui,sans-serif',
    ].join(';');
    document.body.appendChild(wantedHudEl);
  }
}

function renderWantedHud(wanted) {
  if (typeof document === 'undefined') return;
  ensureWantedHud();
  if (!wantedHudEl) return;
  const text = '★'.repeat(wanted) + '☆'.repeat(Math.max(0, MAX_WANTED - wanted));
  if (wantedHudEl.textContent !== text) wantedHudEl.textContent = text;
  wantedHudEl.style.display = wanted > 0 ? 'block' : 'none';
  wantedHudEl.style.color = wanted >= 3 ? '#ff4444' : '#ffd34d';
}

// --- Police API ----------------------------------------------------------

function addWanted(n, ctx) {
  const c = ctx || boundCtx;
  const s = stateOf(c);
  const amount = Math.max(0, Math.floor(Number(n) || 0));
  if (amount <= 0) return s.wanted;
  s.wanted = Math.min(MAX_WANTED, s.wanted + amount);
  hiddenTime = 0; // committing a crime resets the "hidden" clock
  if (s.wanted >= 3) {
    playSfx(c, 'siren');
    showMessage(c, `Wanted level ${s.wanted}! Roadblocks ahead — lose the cops!`);
  }
  renderWantedHud(s.wanted);
  return s.wanted;
}

function setWanted(n, ctx) {
  const s = stateOf(ctx || boundCtx);
  s.wanted = Math.max(0, Math.min(MAX_WANTED, Math.floor(Number(n) || 0)));
  hiddenTime = 0;
  renderWantedHud(s.wanted);
  return s.wanted;
}

function clearWanted(ctx) {
  return setWanted(0, ctx);
}

// --- Spawning ------------------------------------------------------------

function snapToRoad(pos) {
  const spacing = ROAD_SPACING;
  if (Math.abs(pos.x % spacing) < Math.abs(pos.z % spacing)) {
    pos.x = Math.round(pos.x / spacing) * spacing;
  } else {
    pos.z = Math.round(pos.z / spacing) * spacing;
  }
  const half = WORLD_SIZE / 2 - 10;
  pos.x = Math.max(-half, Math.min(half, pos.x));
  pos.z = Math.max(-half, Math.min(half, pos.z));
  return pos;
}

function spawnPoliceCar(ctx, nearPos) {
  const scene = ctx && ctx.scene;
  if (!scene) return null;
  const angle = Math.random() * Math.PI * 2;
  const dist = POLICE_SPAWN_DIST + Math.random() * 20;
  const pos = snapToRoad(new T.Vector3(
    nearPos.x + Math.cos(angle) * dist,
    0,
    nearPos.z + Math.sin(angle) * dist,
  ));
  const group = makePoliceCarMesh();
  group.position.copy(pos);
  scene.add(group);
  const car = {
    group,
    speed: 0,
    heading: Math.atan2(nearPos.x - pos.x, nearPos.z - pos.z),
    ramCooldown: 0,
    lightTimer: Math.random(),
  };
  policeCars.push(car);
  return car;
}

function removePoliceCar(ctx, car) {
  const scene = ctx && ctx.scene;
  if (scene && car.group) scene.remove(car.group);
  const i = policeCars.indexOf(car);
  if (i >= 0) policeCars.splice(i, 1);
}

function spawnHeli(ctx, nearPos) {
  const scene = ctx && ctx.scene;
  if (!scene || heli) return heli;
  const group = makeHeliMesh();
  group.position.set(nearPos.x + 30, 42, nearPos.z - 30);
  scene.add(group);
  heliLight = new T.SpotLight(0xfff2b0, 60, 90, 0.35, 0.45, 1.2);
  heliLight.position.copy(group.position);
  heliLight.target = new T.Object3D();
  heliLight.target.position.copy(nearPos);
  scene.add(heliLight);
  scene.add(heliLight.target);
  heli = {
    group,
    rotor: group.getObjectByName('rotor'),
    cone: group.getObjectByName('searchCone'),
    leaving: false,
  };
  return heli;
}

function removeHeli(ctx) {
  const scene = ctx && ctx.scene;
  if (!heli) return;
  if (scene) {
    scene.remove(heli.group);
    if (heliLight) {
      scene.remove(heliLight);
      if (heliLight.target) scene.remove(heliLight.target);
    }
  }
  heli = null;
  heliLight = null;
}

// A roadblock is two police cars parked broadside across the road plus a
// striped barrier between them. The car positions are kept on the block
// record so update() can collide the player / the player's car with them.
function placeRoadblock(ctx, anchorPos, heading) {
  const scene = ctx && ctx.scene;
  if (!scene) return null;
  const group = new T.Group();
  const acrossX = Math.cos(heading + Math.PI / 2);
  const acrossZ = Math.sin(heading + Math.PI / 2);
  const cars = [];
  for (const offset of [-3.2, 3.2]) {
    const car = makePoliceCarMesh();
    car.position.set(anchorPos.x + acrossX * offset, 0, anchorPos.z + acrossZ * offset);
    car.rotation.y = heading + Math.PI / 2; // broadside across the road
    group.add(car);
    cars.push(car);
  }
  const barrier = new T.Mesh(
    new T.BoxGeometry(4.4, 0.5, 0.25),
    new T.MeshStandardMaterial({ color: 0xffcc00, emissive: 0x664400, emissiveIntensity: 0.6 }),
  );
  barrier.position.set(anchorPos.x, 0.9, anchorPos.z);
  barrier.rotation.y = heading + Math.PI / 2;
  group.add(barrier);
  scene.add(group);
  const block = { group, cars, anchor: anchorPos.clone(), placedAt: 0 };
  roadblocks.push(block);
  return block;
}

function clearRoadblocks(ctx) {
  const scene = ctx && ctx.scene;
  for (const block of roadblocks) {
    if (scene && block.group) scene.remove(block.group);
  }
  roadblocks = [];
}

function updateRoadblocks(ctx, dt, pPos, heading) {
  const wanted = getWanted(ctx);
  if (wanted < ROADBLOCK_WANTED) {
    if (roadblocks.length) clearRoadblocks(ctx);
    return;
  }
  roadblockTimer -= dt;
  // Keep ROADBLOCK_COUNT roadblocks ahead of the player, on the road grid.
  // A block is only moved when the player has passed it or left it behind —
  // never while they are closing in on it, or it would leapfrog away and the
  // player could never reach (or crash into) a real roadblock.
  const ahead = snapToRoad(new T.Vector3(
    pPos.x + Math.sin(heading) * 38,
    0,
    pPos.z + Math.cos(heading) * 38,
  ));
  let needReplace = roadblocks.length < ROADBLOCK_COUNT;
  if (roadblocks.length) {
    const anchor = roadblocks[0].anchor;
    const d = anchor.distanceTo(pPos);
    const toAnchor = anchor.clone().sub(pPos);
    const aheadDist = toAnchor.x * Math.sin(heading) + toAnchor.z * Math.cos(heading);
    if (d > 90 || aheadDist < -10) needReplace = true; // passed it / left it behind
    else if (roadblockTimer <= 0 && d > 30) needReplace = true; // stale, far away
  }
  if (needReplace) {
    clearRoadblocks(ctx);
    placeRoadblock(ctx, ahead, heading);
    // Second block further ahead, on the cross road.
    const ahead2 = snapToRoad(new T.Vector3(
      pPos.x + Math.sin(heading) * 70,
      0,
      pPos.z + Math.cos(heading) * 70,
    ));
    placeRoadblock(ctx, ahead2, heading + Math.PI / 2);
    roadblockTimer = ROADBLOCK_REPLACE_SECONDS;
  }
}

// REAL roadblocks: a car (or the player on foot) cannot drive through the
// barricade cars. Circle push-out against each barricade car; a car that
// hits one loses its speed.
function collideRoadblocks(ctx, pPos) {
  if (!roadblocks.length) return;
  const car = ctx.cars && ctx.cars.current;
  const inCar = !!(ctx.player && ctx.player.inCar) && car;
  for (const block of roadblocks) {
    for (const mesh of block.cars) {
      const cx = mesh.position.x;
      const cz = mesh.position.z;
      if (inCar) {
        const dx = car.pos.x - cx;
        const dz = car.pos.z - cz;
        let d = Math.hypot(dx, dz);
        // Dead-centre hit: no direction to push along, so shove sideways.
        const px = d < 0.001 ? 1 : dx / d;
        const pz = d < 0.001 ? 0 : dz / d;
        if (d < 2.6) {
          car.pos.x = cx + px * 2.6;
          car.pos.z = cz + pz * 2.6;
          car.speed = 0;
        }
      } else {
        const dx = pPos.x - cx;
        const dz = pPos.z - cz;
        let d = Math.hypot(dx, dz);
        const px = d < 0.001 ? 1 : dx / d;
        const pz = d < 0.001 ? 0 : dz / d;
        if (d < 1.8) {
          const pushed = new T.Vector3(cx + px * 1.8, pPos.y, cz + pz * 1.8);
          setPlayerPos(ctx, pushed);
          pPos.copy(pushed);
        }
      }
    }
  }
}

// --- Public API ----------------------------------------------------------

export function init(ctx) {
  T = (ctx && ctx.THREE) || THREE_SHIM;
  if (!T) throw new Error('police: THREE is not available (ctx.THREE / ./three.js)');
  boundCtx = ctx || null;
  policeCars = [];
  roadblocks = [];
  heli = null;
  heliLight = null;
  hiddenTime = 0;
  roadblockTimer = 0;
  if (ctx) {
    stateOf(ctx);
    if (typeof document !== 'undefined') ensureWantedHud();
    renderWantedHud(getWanted(ctx));
  }

  const api = {
    get wanted() { return getWanted(ctx); },
    set wanted(v) { setWanted(v, ctx); },
    addWanted(n) { return addWanted(n, ctx); },
    setWanted(n) { return setWanted(n, ctx); },
    clearWanted() { return clearWanted(ctx); },
    get roadblocks() { return roadblocks; },
    get heli() { return heli ? heli.group : null; },
    get heliActive() { return !!heli && !heli.leaving; },
    get policeCars() { return policeCars; },
    get isHidden() { return hiddenTime > 0; },
  };
  if (ctx) ctx.police = api;
  return api;
}

export function update(dt, ctx) {
  const c = ctx || boundCtx;
  if (!c || !c.scene) return;
  const s = stateOf(c);
  const wanted = s.wanted || 0;
  const pPos = playerPos(c);
  const heading = playerHeading(c);
  const step = typeof dt === 'number' && dt > 0 ? Math.min(dt, 0.1) : 0.016;

  // --- Consume offence flags other modules may set ----------------------
  if (s.offence) {
    const n = typeof s.offence === 'number' ? s.offence : 1;
    s.offence = null;
    addWanted(n, c);
  }
  if (s.stoleCar) {
    s.stoleCar = false;
    addWanted(1, c);
  }
  if (s.harmedNpc) {
    s.harmedNpc = false;
    addWanted(1, c);
  }

  // --- Spawn / despawn pursuit cars: up to one per wanted star ----------
  const wantCars = Math.min(wanted, MAX_POLICE_CARS);
  while (policeCars.length < wantCars) spawnPoliceCar(c, pPos);
  while (policeCars.length > wantCars) {
    // Remove the farthest car first.
    let far = policeCars[0];
    for (const car of policeCars) {
      if (car.group.position.distanceTo(pPos) > far.group.position.distanceTo(pPos)) far = car;
    }
    removePoliceCar(c, far);
  }
  for (const car of [...policeCars]) {
    if (car.group.position.distanceTo(pPos) > POLICE_DESPAWN_DIST) {
      removePoliceCar(c, car);
    }
  }

  // --- Pursuit steering + ramming ---------------------------------------
  const inCar = playerInCar(c);
  for (const car of policeCars) {
    const gp = car.group.position;
    const toPlayer = new T.Vector3(pPos.x - gp.x, 0, pPos.z - gp.z);
    const dist = toPlayer.length();
    const targetHeading = Math.atan2(toPlayer.x, toPlayer.z);
    let dh = targetHeading - car.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, dh * 2));
    car.heading += steer * 2.2 * step;
    // Police are fast but not faster than a good getaway car.
    const topSpeed = 11 + wanted * 2.2;
    const targetSpeed = dist > 6 ? topSpeed : topSpeed * 0.5;
    car.speed += (targetSpeed - car.speed) * Math.min(1, step * 1.5);
    gp.x += Math.sin(car.heading) * car.speed * step;
    gp.z += Math.cos(car.heading) * car.speed * step;
    gp.y = 0;
    car.group.rotation.y = car.heading;
    // Flash the light bar.
    car.lightTimer += step;
    const phase = Math.floor(car.lightTimer * 6) % 2 === 0;
    const red = car.group.getObjectByName('lightRed');
    const blue = car.group.getObjectByName('lightBlue');
    if (red) red.material.emissiveIntensity = phase ? 2.5 : 0.3;
    if (blue) blue.material.emissiveIntensity = phase ? 0.3 : 2.5;
    // Ram: shove the player and deal a little damage, once per second.
    car.ramCooldown -= step;
    if (dist < 3.0 && car.ramCooldown <= 0) {
      car.ramCooldown = 1.0;
      const push = toPlayer.clone().normalize().multiplyScalar(-3.5);
      setPlayerPos(c, pPos.clone().add(push));
      damagePlayer(c, inCar ? 4 : 8);
      playSfx(c, 'click');
    }
  }

  // --- Roadblocks at 3+ stars (real: they collide) ------------------------
  updateRoadblocks(c, step, pPos, heading);
  collideRoadblocks(c, pPos);

  // --- CONDOR-1 helicopter at 3+ stars -----------------------------------
  if (wanted >= ROADBLOCK_WANTED) {
    if (!heli) spawnHeli(c, pPos);
    if (heli) {
      heli.leaving = false;
      const hp = heli.group.position;
      // Hover above and slightly behind the player, tracking them.
      const target = new T.Vector3(pPos.x - Math.sin(heading) * 8, 34, pPos.z - Math.cos(heading) * 8);
      hp.lerp(target, Math.min(1, step * 1.2));
      if (heli.rotor) heli.rotor.rotation.y += step * 22;
      // Searchlight: spotlight + cone both track the player.
      if (heliLight) {
        heliLight.position.copy(hp);
        heliLight.target.position.copy(pPos);
      }
      if (heli.cone) {
        heli.cone.lookAt(pPos.clone().sub(hp).add(new T.Vector3(0, -16, 0)));
        heli.cone.position.set(0, -16, 0);
        heli.cone.material.opacity = 0.13 + Math.sin(performance.now() * 0.004) * 0.04;
      }
    }
  } else if (heli) {
    // Wanted dropped: heli climbs away, then is removed.
    heli.leaving = true;
    const hp = heli.group.position;
    hp.y += step * 14;
    hp.x += step * 10;
    hp.z -= step * 10;
    if (heli.rotor) heli.rotor.rotation.y += step * 22;
    if (hp.y > 90) removeHeli(c);
  }

  // --- Wanted decay: hidden / out of sight for a while -------------------
  const anyNear = policeCars.some((car) => car.group.position.distanceTo(pPos) < SIGHT_RANGE);
  const seenByHeli = !!heli && !heli.leaving;
  if (wanted > 0 && !anyNear && !seenByHeli) {
    hiddenTime += step;
    const need = HIDE_DECAY_BASE + wanted * HIDE_DECAY_PER_STAR;
    if (hiddenTime >= need) {
      s.wanted = Math.max(0, wanted - 1);
      hiddenTime = 0;
      if (s.wanted > 0) showMessage(c, `You lost them — wanted level ${s.wanted}.`);
      else showMessage(c, 'You lost the cops. You are clean.');
    }
  } else {
    hiddenTime = 0;
  }

  renderWantedHud(s.wanted || 0);
}

export default { init, update, getWanted, addWanted, playerPos };
