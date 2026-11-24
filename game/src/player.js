// player.js — W2 (player + vehicles), ISLA BRASA 3D round-6 rebuild.
// Low-poly third-person humanoid: camera-relative WASD movement, run, jump,
// enter/exit vehicles (E), interact (F), walk/run limb-swing animation,
// outfit colour swaps for the clothes shop, health + respawn.
// Written fresh from the design spec. No code copied from any other repo.
import * as THREE from 'three';
import * as Config from './config.js';

// --- Outfit colour map: default + 4 buyable clothes-shop outfits. ---
// The clothes shop (shops.js) buys by these ids; setOutfit(name) applies them.
const OUTFITS = Config.OUTFITS ?? {
  default: { shirt: 0x2e86c1, pants: 0x2c3e50, sleeves: 0x2e86c1, shoes: 0x1a1a1a, hair: 0x2b1d12 },
  street:  { shirt: 0xe74c3c, pants: 0x34495e, sleeves: 0xe74c3c, shoes: 0xf5f5f5, hair: 0x111111 },
  suit:    { shirt: 0x1c1c1c, pants: 0x1c1c1c, sleeves: 0x1c1c1c, shoes: 0x000000, hair: 0x3a2a1a },
  beach:   { shirt: 0x1abc9c, pants: 0xe8d27a, sleeves: 0x1abc9c, shoes: 0x8b5a2b, hair: 0x6b4a1f },
  biker:   { shirt: 0x111111, pants: 0x2f3542, sleeves: 0x111111, shoes: 0x222222, hair: 0x000000 },
  club:    { shirt: 0x9b2c2c, pants: 0x1a202c, sleeves: 0x9b2c2c, shoes: 0xd53f8c, hair: 0x111111 },
};

const WALK_SPEED = Config.PLAYER_WALK_SPEED ?? 5;
const RUN_SPEED = Config.PLAYER_RUN_SPEED ?? 9;
const JUMP_SPEED = Config.PLAYER_JUMP_SPEED ?? 7.5;
const GRAVITY = Config.GRAVITY ?? 20;
const SPAWN = Config.PLAYER_SPAWN ?? { x: 0, z: 8 };

// Read a key from the many shapes ctx.input may take:
// a Set of codes (input.js), an object of code->bool, or direct props.
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

// Normalise a world building entry to an AABB { minX, maxX, minZ, maxZ }.
// Supports {minX,maxX,minZ,maxZ}, {x,z,w,d} / {x,z,halfW,halfD}, {x,z,width,depth}.
export function buildingAABB(b) {
  if (b.minX !== undefined) {
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  }
  const hw = (b.halfW ?? b.w ?? b.width ?? 2) / (b.w !== undefined || b.width !== undefined ? 2 : 1);
  const hd = (b.halfD ?? b.d ?? b.depth ?? 2) / (b.d !== undefined || b.depth !== undefined ? 2 : 1);
  const cx = b.x ?? b.cx ?? 0;
  const cz = b.z ?? b.cz ?? 0;
  return { minX: cx - hw, maxX: cx + hw, minZ: cz - hd, maxZ: cz + hd };
}

// Circle-vs-AABB push-out for a position vector; radius r. Returns true if pushed.
// Shared by cars.js (same collision shape for vehicles).
export function pushOutOfBuildings(pos, buildings, r) {
  if (!buildings) return false;
  let pushed = false;
  for (const b of buildings) {
    const box = buildingAABB(b);
    if (pos.x > box.minX - r && pos.x < box.maxX + r &&
        pos.z > box.minZ - r && pos.z < box.maxZ + r) {
      const dxl = pos.x - (box.minX - r);
      const dxr = (box.maxX + r) - pos.x;
      const dzl = pos.z - (box.minZ - r);
      const dzr = (box.maxZ + r) - pos.z;
      const m = Math.min(dxl, dxr, dzl, dzr);
      if (m === dxl) pos.x = box.minX - r;
      else if (m === dxr) pos.x = box.maxX + r;
      else if (m === dzl) pos.z = box.minZ - r;
      else pos.z = box.maxZ + r;
      pushed = true;
    }
  }
  return pushed;
}

// A limb whose geometry is translated so its pivot sits at the top:
// rotating it around x swings it like a real arm/leg.
function makeLimb(mat, w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  return new THREE.Mesh(geo, mat);
}

// Keep the shared state position in sync with the live mesh position.
// state.playerPos is an ARRAY [x, y, z] (state.js); main.js's camera and the
// HUD/minimap read it, so every frame the player (or the car/plane, via their
// own sync) writes the current position into it.
function syncSharedPos(ctx, x, y, z, heading) {
  const s = ctx.state;
  if (s) {
    if (Array.isArray(s.playerPos)) {
      s.playerPos[0] = x;
      s.playerPos[1] = y;
      s.playerPos[2] = z;
    } else if (s.playerPos && typeof s.playerPos === 'object') {
      s.playerPos.x = x;
      s.playerPos.y = y;
      s.playerPos.z = z;
    }
    if (heading !== undefined) s.playerHeading = heading;
  }
  if (heading !== undefined) ctx.playerHeading = heading;
}

function notify(ctx, msg) {
  if (ctx && typeof ctx.notify === 'function') { ctx.notify(msg); return; }
  if (ctx && ctx.hud && typeof ctx.hud.showMessage === 'function') { ctx.hud.showMessage(msg); return; }
  console.log('[player]', msg);
}

export function init(ctx) {
  const scene = ctx.scene;

  const skinMat = new THREE.MeshLambertMaterial({ color: 0xd9a066 });
  const shirtMat = new THREE.MeshLambertMaterial({ color: OUTFITS.default.shirt });
  const pantsMat = new THREE.MeshLambertMaterial({ color: OUTFITS.default.pants });
  const sleeveMat = new THREE.MeshLambertMaterial({ color: OUTFITS.default.sleeves });
  const shoeMat = new THREE.MeshLambertMaterial({ color: OUTFITS.default.shoes });
  const hairMat = new THREE.MeshLambertMaterial({ color: OUTFITS.default.hair });

  const mesh = new THREE.Group();
  mesh.name = 'player';

  // Torso: capsule body.
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.45, 4, 10), shirtMat);
  torso.position.y = 1.05;
  mesh.add(torso);

  // Head + hair cap.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 12), skinMat);
  head.position.y = 1.72;
  mesh.add(head);
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
  hair.position.y = 1.75;
  mesh.add(hair);

  // Arms pivot at the shoulders (y ~1.42), legs at the hips (y ~0.82).
  const armL = makeLimb(sleeveMat, 0.16, 0.62, 0.16);
  armL.position.set(-0.42, 1.42, 0);
  mesh.add(armL);
  const armR = makeLimb(sleeveMat, 0.16, 0.62, 0.16);
  armR.position.set(0.42, 1.42, 0);
  mesh.add(armR);
  const handGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
  const handL = new THREE.Mesh(handGeo, skinMat);
  handL.position.y = -0.66;
  armL.add(handL);
  const handR = new THREE.Mesh(handGeo, skinMat);
  handR.position.y = -0.66;
  armR.add(handR);

  const legL = makeLimb(pantsMat, 0.2, 0.78, 0.2);
  legL.position.set(-0.16, 0.82, 0);
  mesh.add(legL);
  const legR = makeLimb(pantsMat, 0.2, 0.78, 0.2);
  legR.position.set(0.16, 0.82, 0);
  mesh.add(legR);
  const shoeGeo = new THREE.BoxGeometry(0.2, 0.1, 0.32);
  const shoeL = new THREE.Mesh(shoeGeo, shoeMat);
  shoeL.position.set(0, -0.8, 0.05);
  legL.add(shoeL);
  const shoeR = new THREE.Mesh(shoeGeo, shoeMat);
  shoeR.position.set(0, -0.8, 0.05);
  legR.add(shoeR);

  mesh.position.set(SPAWN.x, 0, SPAWN.z);
  scene.add(mesh);

  const player = {
    mesh,
    pos: mesh.position, // THREE.Vector3, same reference as mesh.position
    speed: 0,
    inCar: false,
    outfit: 'default',
    _vy: 0,
    _grounded: true,
    _walkPhase: 0,
    _vel: new THREE.Vector3(),
    _camYaw: null,
    _prevE: false,
    _prevF: false,
    _prevSpace: false,
    _mats: { shirt: shirtMat, pants: pantsMat, sleeves: sleeveMat, shoes: shoeMat, hair: hairMat },

    // Live position aliases: other modules read ctx.player.position,
    // ctx.player.getPosition() or ctx.player.setPosition(v).
    get position() { return mesh.position; },
    getPosition() { return mesh.position; },
    setPosition(v) {
      mesh.position.copy(v);
      syncSharedPos(ctx, v.x, v.y, v.z, mesh.rotation.y);
    },

    // Health lives in state.health (0-100); this is the live view of it.
    get health() { return ctx.state ? ctx.state.health : 100; },
    set health(v) { if (ctx.state) ctx.state.health = Math.max(0, Math.min(100, v)); },

    // Take damage: armour absorbs first, the rest hits health.
    // At 0 health the player is wasted and wakes up at the spawn point.
    damage(amount) {
      if (!ctx.state || amount <= 0) return false;
      let left = amount;
      if (ctx.state.armor > 0) {
        const absorbed = Math.min(ctx.state.armor, left);
        ctx.state.armor -= absorbed;
        left -= absorbed;
      }
      if (left > 0) ctx.state.health = Math.max(0, ctx.state.health - left);
      if (ctx.state.health <= 0) {
        this.respawn();
        return true; // died
      }
      return false;
    },

    heal(amount) {
      if (!ctx.state || amount <= 0) return;
      ctx.state.health = Math.min(100, ctx.state.health + amount);
    },

    respawn() {
      mesh.position.set(SPAWN.x, 0, SPAWN.z);
      mesh.rotation.y = 0;
      if (ctx.state) {
        ctx.state.health = 100;
        ctx.state.armor = 0;
      }
      this._vel.set(0, 0, 0);
      this._vy = 0;
      this._grounded = true;
      syncSharedPos(ctx, SPAWN.x, 0, SPAWN.z, 0);
      notify(ctx, 'You were wasted! You wake up at Plaza Tower.');
    },

    enterCar(car) {
      if (!car) return false;
      this.inCar = true;
      this._car = car;
      mesh.visible = false;
      this._vel.set(0, 0, 0);
      if (ctx.cars) ctx.cars.current = car;
      if (ctx.state) ctx.state.currentCar = car.type;
      return true;
    },

    exitCar() {
      const car = this._car || (ctx.cars && ctx.cars.current);
      if (!car) { this.inCar = false; mesh.visible = true; return false; }
      // Step out on the driver's side (left of the car's forward axis).
      const fwd = new THREE.Vector3(Math.sin(car.heading || 0), 0, Math.cos(car.heading || 0));
      const left = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const p = car.pos || car.mesh.position;
      mesh.position.set(p.x + left.x * 2.2, 0, p.z + left.z * 2.2);
      mesh.visible = true;
      this.inCar = false;
      this._car = null;
      if (ctx.cars) ctx.cars.current = null;
      if (ctx.state) ctx.state.currentCar = null;
      syncSharedPos(ctx, mesh.position.x, 0, mesh.position.z, mesh.rotation.y);
      return true;
    },

    setOutfit(name) {
      const o = OUTFITS[name];
      if (!o) return false;
      this.outfit = name;
      this._mats.shirt.color.setHex(o.shirt);
      this._mats.pants.color.setHex(o.pants);
      this._mats.sleeves.color.setHex(o.sleeves);
      this._mats.shoes.color.setHex(o.shoes);
      this._mats.hair.color.setHex(o.hair);
      if (ctx.state) ctx.state.currentOutfit = name;
      return true;
    },
  };

  ctx.player = player;
  return player;
}

export function update(dt, ctx) {
  const player = ctx.player;
  if (!player) return;
  const input = ctx.input || {};
  const camera = ctx.camera;
  const mesh = player.mesh;

  // While flying the plane, the plane module owns the player anchor and E.
  if (ctx.plane && ctx.plane.inPlane) return;

  // An open overlay (shop / garage / map / dialogue) swallows game keys.
  const uiOpen = (ctx.state && ctx.state.uiOpen) || ctx.uiOpen;

  // --- E: enter / exit vehicle (edge-triggered) ---
  const eDown = !uiOpen && keyDown(input, 'KeyE');
  if (eDown && !player._prevE) {
    if (player.inCar) {
      player.exitCar();
    } else if (ctx.cars && ctx.cars.getNearbyCar) {
      const car = ctx.cars.getNearbyCar(player.pos);
      if (car) player.enterCar(car);
      // If no car is near, the plane module may still board on the same press.
    }
  }
  player._prevE = eDown;

  // In a car, cars.js drive() owns movement and the camera.
  if (player.inCar) return;

  // --- F: interact (edge-triggered). Dialogue / NPC module hooks ctx.onInteract. ---
  const fDown = !uiOpen && keyDown(input, 'KeyF');
  if (fDown && !player._prevF) {
    // Fists punching is owned by combat.js; only fire the interact hook when
    // the player is not about to punch (combat decides that itself).
    if (typeof ctx.onInteract === 'function') ctx.onInteract(player.pos);
  }
  player._prevF = fDown;

  // --- Camera-relative movement ---
  const fwd = new THREE.Vector3();
  if (camera) camera.getWorldDirection(fwd);
  else fwd.set(0, 0, -1);
  fwd.y = 0;
  if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

  const move = new THREE.Vector3();
  if (!uiOpen) {
    if (keyDown(input, 'KeyW', 'ArrowUp')) move.add(fwd);
    if (keyDown(input, 'KeyS', 'ArrowDown')) move.sub(fwd);
    if (keyDown(input, 'KeyD', 'ArrowRight')) move.add(right);
    if (keyDown(input, 'KeyA', 'ArrowLeft')) move.sub(right);
  }

  const running = keyDown(input, 'ShiftLeft', 'ShiftRight');
  const targetSpeed = move.lengthSq() > 0 ? (running ? RUN_SPEED : WALK_SPEED) : 0;
  if (move.lengthSq() > 0) move.normalize();

  // Smooth acceleration toward the target velocity.
  const k = Math.min(1, 10 * dt);
  player._vel.x += (move.x * targetSpeed - player._vel.x) * k;
  player._vel.z += (move.z * targetSpeed - player._vel.z) * k;
  player.speed = Math.hypot(player._vel.x, player._vel.z);

  mesh.position.x += player._vel.x * dt;
  mesh.position.z += player._vel.z * dt;

  // Building collision (circle push-out, radius 0.5).
  if (ctx.world && ctx.world.buildings) pushOutOfBuildings(mesh.position, ctx.world.buildings, 0.5);

  // --- Jump (Space, edge-triggered, only when grounded) ---
  const spaceDown = !uiOpen && keyDown(input, 'Space');
  if (spaceDown && !player._prevSpace && player._grounded) {
    player._vy = JUMP_SPEED;
    player._grounded = false;
  }
  player._prevSpace = spaceDown;

  // Gravity.
  if (!player._grounded || player._vy !== 0) {
    player._vy -= GRAVITY * dt;
    mesh.position.y += player._vy * dt;
    if (mesh.position.y <= 0) {
      mesh.position.y = 0;
      player._vy = 0;
      player._grounded = true;
    }
  }

  // Face the movement direction.
  if (player.speed > 0.5) {
    const targetYaw = Math.atan2(player._vel.x, player._vel.z);
    let d = targetYaw - mesh.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    mesh.rotation.y += d * Math.min(1, 12 * dt);
  }

  // --- Walk / run limb-swing animation ---
  // Children order: 0 torso, 1 head, 2 hair, 3 armL, 4 armR, 5 legL, 6 legR.
  const swing = player.speed > 0.5 ? (running ? 0.85 : 0.55) : 0;
  player._walkPhase += dt * player.speed * 1.6;
  const s = Math.sin(player._walkPhase) * swing;
  const armL = mesh.children[3];
  const armR = mesh.children[4];
  const legL = mesh.children[5];
  const legR = mesh.children[6];
  if (armL && armR && legL && legR) {
    legL.rotation.x = s;
    legR.rotation.x = -s;
    armL.rotation.x = -s * 0.8;
    armR.rotation.x = s * 0.8;
    const torso = mesh.children[0];
    if (torso) torso.position.y = 1.05 + Math.abs(Math.cos(player._walkPhase)) * 0.04 * (swing / 0.85 || 0);
  }

  // Share the live position/heading: main.js's camera, HUD and minimap read these.
  syncSharedPos(ctx, mesh.position.x, mesh.position.y, mesh.position.z, mesh.rotation.y);

  // --- Third-person camera follow (skipped if another module owns the camera) ---
  if (camera && ctx.cameraControl !== 'external' && !ctx.cameraHandled) {
    // Mouse-look delta, if the input layer provides one.
    const lookDX = input.lookDX || input.mouseDX || 0;
    if (player._camYaw === null) player._camYaw = mesh.rotation.y + Math.PI;
    if (lookDX) player._camYaw -= lookDX * 0.004;
    // Auto-follow behind the player's facing when moving.
    if (player.speed > 0.5 && !lookDX) {
      const targetYaw = mesh.rotation.y + Math.PI;
      let d = targetYaw - player._camYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      player._camYaw += d * Math.min(1, 2.5 * dt);
    }
    const camDist = 7;
    const camHeight = 3.4;
    const cx = mesh.position.x + Math.sin(player._camYaw) * camDist;
    const cz = mesh.position.z + Math.cos(player._camYaw) * camDist;
    camera.position.set(cx, mesh.position.y + camHeight, cz);
    camera.lookAt(mesh.position.x, mesh.position.y + 1.4, mesh.position.z);
  }
}

export { OUTFITS };
