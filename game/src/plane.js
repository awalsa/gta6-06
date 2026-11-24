// plane.js — W2 (player + vehicles), ISLA BRASA 3D round-6 rebuild.
// "Brasa Air" flyable plane, parked on the runway strip (z = -195,
// x in [-150, 150]). Press E near it to board. Takeoff needs speed >= 22
// units/s; ceiling 120 units; can land on the runway or the beach.
// Ground: W/S throttle, A/D steer. Air: W/S pitch (climb/descend),
// A/D bank + turn, Shift/ArrowUp throttle up, ArrowDown throttle down.
// E exits when stopped on the ground.
// Written fresh from the design spec. No code copied from any other repo.
import * as THREE from 'three';
import * as Config from './config.js';

const RUNWAY_Z = Config.RUNWAY_Z ?? -195;
const RUNWAY_HALF = Config.RUNWAY_X_MAX ?? 150;
const TAKEOFF_SPEED = Config.PLANE_TAKEOFF_SPEED ?? 22;
const CEILING = Config.PLANE_CEILING ?? 120;
const WATER_Z_MIN = Config.WATER_Z_MIN ?? 165;
const MAX_SPEED = 38;
const BOARD_DIST = 8;

function keyDown(ctx, code) {
  const inp = (ctx && ctx.input) || {};
  if (typeof inp.isDown === 'function') return !!inp.isDown(code);
  if (inp.keys instanceof Set) return inp.keys.has(code);
  if (inp.keys) return !!inp.keys[code];
  if (typeof inp[code] === 'boolean') return inp[code];
  return false;
}

// The player's live position as a THREE.Vector3 (never the state array).
function playerPos(ctx) {
  if (ctx.player) {
    if (ctx.player.position) return ctx.player.position;
    if (ctx.player.mesh && ctx.player.mesh.position) return ctx.player.mesh.position;
    if (typeof ctx.player.getPosition === 'function') return ctx.player.getPosition();
  }
  if (ctx.state && ctx.state.playerPos) return ctx.state.playerPos;
  if (ctx.camera) return ctx.camera.position;
  return new THREE.Vector3(0, 0, 0);
}

function setPlayerPos(ctx, v) {
  if (ctx.player) {
    if (ctx.player.position && typeof ctx.player.position.copy === 'function') {
      ctx.player.position.copy(v);
    } else if (ctx.player.mesh && ctx.player.mesh.position) {
      ctx.player.mesh.position.copy(v);
    } else if (typeof ctx.player.setPosition === 'function') {
      ctx.player.setPosition(v);
    }
  }
  const s = ctx.state;
  if (s && Array.isArray(s.playerPos)) {
    s.playerPos[0] = v.x;
    s.playerPos[1] = v.y;
    s.playerPos[2] = v.z;
  }
}

function toast(ctx, msg) {
  if (ctx && typeof ctx.notify === 'function') { ctx.notify(msg); return; }
  if (ctx && ctx.hud && typeof ctx.hud.showMessage === 'function') { ctx.hud.showMessage(msg); return; }
  if (typeof document !== 'undefined') {
    let el = document.getElementById('hud-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hud-toast';
      el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;padding:8px 14px;border-radius:6px;font:14px sans-serif;z-index:9999;pointer-events:none;transition:opacity .4s;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2800);
  }
  console.log('[plane]', msg);
}

function setPrompt(msg) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('hud-prompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hud-prompt';
    el.style.cssText = 'position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.65);color:#ffe9a8;padding:6px 12px;border-radius:6px;font:13px sans-serif;z-index:9998;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function buildPlaneMesh() {
  const g = new THREE.Group();
  g.name = 'plane-brasa-air';
  const white = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
  const orange = new THREE.MeshLambertMaterial({ color: 0xff6b1a });
  const dark = new THREE.MeshLambertMaterial({ color: 0x222831 });

  // Fuselage (along local +X).
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 7, 12), white);
  body.rotation.z = Math.PI / 2;
  body.position.y = 1.4;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2, 12), orange);
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(4.5, 1.4, 0);
  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.6, 12), white);
  tailCone.rotation.z = Math.PI / 2;
  tailCone.position.set(-4.2, 1.4, 0);
  // Orange cheatline stripe.
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.28, 2.24), orange);
  stripe.position.y = 1.4;
  // Main wings.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 13), white);
  wing.position.set(0.4, 1.35, 0);
  // Tailplane + fin.
  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.14, 5), white);
  tailWing.position.set(-3.6, 1.5, 0);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 0.18), orange);
  fin.position.set(-3.8, 2.6, 0);
  // Cockpit windows.
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.6), dark);
  cockpit.position.set(3.2, 2.1, 0);
  // Propeller (spins while throttle > 0).
  const prop = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), dark);
  const bladeGeo = new THREE.BoxGeometry(0.08, 2.6, 0.3);
  const b1 = new THREE.Mesh(bladeGeo, dark);
  const b2 = new THREE.Mesh(bladeGeo, dark);
  b2.rotation.x = Math.PI / 2;
  prop.add(hub, b1, b2);
  prop.position.set(5.6, 1.4, 0);
  // Landing gear.
  const gearMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  for (const [gx, gz] of [[1.5, 0.9], [1.5, -0.9], [-2.5, 0]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6), gearMat);
    leg.position.set(gx, 0.45, gz);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.2, 10), gearMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(gx, 0.32, gz);
    g.add(leg, wheel);
  }
  // Nav lights (blink in update).
  const navL = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2222 }));
  navL.position.set(0.4, 1.4, 6.5);
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x22ff66 }));
  navR.position.set(0.4, 1.4, -6.5);
  g.add(body, nose, tailCone, stripe, wing, tailWing, fin, cockpit, prop, navL, navR);
  g.userData.prop = prop;
  g.userData.navL = navL;
  g.userData.navR = navR;
  return g;
}

let S = null;

export function init(ctx) {
  S = {
    ctx,
    mesh: null,
    pos: new THREE.Vector3(0, 0, RUNWAY_Z),
    heading: Math.PI / 2, // facing +X down the runway
    speed: 0,
    throttle: 0,
    airborne: false,
    pitch: 0,
    bank: 0,
    inPlane: false,
    prevE: false,
    time: 0,
  };

  if (ctx.scene) {
    S.mesh = buildPlaneMesh();
    S.mesh.position.copy(S.pos);
    S.mesh.rotation.y = -S.heading + Math.PI / 2; // model forward is +X
    ctx.scene.add(S.mesh);

    // Runway edge lights (small emissive markers along both edges).
    const lightGeo = new THREE.BoxGeometry(0.5, 0.35, 0.5);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xffcc33 });
    for (let x = -RUNWAY_HALF; x <= RUNWAY_HALF; x += 15) {
      for (const dz of [-4, 4]) {
        const l = new THREE.Mesh(lightGeo, lightMat);
        l.position.set(x, 0.18, RUNWAY_Z + dz);
        ctx.scene.add(l);
      }
    }
    // Windsock near the runway.
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 5, 6),
      new THREE.MeshLambertMaterial({ color: 0x888888 })
    );
    pole.position.set(-RUNWAY_HALF - 6, 2.5, RUNWAY_Z - 8);
    const sock = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 2.2, 8),
      new THREE.MeshLambertMaterial({ color: 0xff6b1a })
    );
    sock.rotation.z = Math.PI / 2;
    sock.position.set(-RUNWAY_HALF - 5, 4.6, RUNWAY_Z - 8);
    ctx.scene.add(pole, sock);
  }

  const api = {
    get inPlane() { return S.inPlane; },
    get speed() { return S.speed; },
    get altitude() { return S.pos.y; },
    get heading() { return S.heading; },
    get airborne() { return S.airborne; },
    takeoffSpeed: TAKEOFF_SPEED,
    ceiling: CEILING,
    runwayZ: RUNWAY_Z,
    board() { return board(ctx); },
    exit() { return exitPlane(ctx); },
  };
  ctx.plane = api;
  return api;
}

function board(ctx) {
  if (!S || S.inPlane) return false;
  // Cannot board from inside a car.
  if (ctx.player && ctx.player.inCar) return false;
  const p = playerPos(ctx);
  if (!p || typeof p.distanceTo !== 'function') return false;
  if (p.distanceTo(S.pos) > BOARD_DIST) return false;
  S.inPlane = true;
  S.throttle = 0;
  S.speed = 0;
  if (ctx.player && ctx.player.mesh) ctx.player.mesh.visible = false;
  if (ctx.state) ctx.state.inPlane = true;
  toast(ctx, 'Boarded Brasa Air. W/S throttle, A/D steer — reach 22 speed to take off. Shift = more throttle in the air.');
  return true;
}

function exitPlane(ctx) {
  if (!S || !S.inPlane) return false;
  if (S.airborne || S.speed > 3) return false;
  S.inPlane = false;
  S.throttle = 0;
  S.speed = 0;
  const out = S.pos.clone().add(new THREE.Vector3(0, 0, 5));
  setPlayerPos(ctx, out);
  if (ctx.player && ctx.player.mesh) ctx.player.mesh.visible = true;
  if (ctx.state) ctx.state.inPlane = false;
  toast(ctx, 'You left the plane.');
  return true;
}

export function update(dt, ctx) {
  if (!S) return;
  S.time += dt;
  const p = playerPos(ctx);
  const uiOpen = (ctx.state && ctx.state.uiOpen) || ctx.uiOpen;

  // Blink nav lights.
  if (S.mesh) {
    const on = Math.sin(S.time * 4) > 0;
    S.mesh.userData.navL.material.color.setHex(on ? 0xff2222 : 0x440000);
    S.mesh.userData.navR.material.color.setHex(on ? 0x22ff66 : 0x003311);
    if (S.throttle > 0.05) S.mesh.userData.prop.rotation.x += dt * (4 + S.throttle * 30);
  }

  const eDown = !uiOpen && keyDown(ctx, 'KeyE');
  const ePressed = eDown && !S.prevE;
  S.prevE = eDown;

  if (!S.inPlane) {
    if (ePressed && p && typeof p.distanceTo === 'function' && p.distanceTo(S.pos) < BOARD_DIST) {
      board(ctx);
    }
    if (p && typeof p.distanceTo === 'function' && p.distanceTo(S.pos) < BOARD_DIST && !uiOpen) {
      setPrompt('Press E — Board the Brasa Air plane');
    } else {
      setPrompt('');
    }
    return;
  }

  // ---- flying ----
  const w = !uiOpen && keyDown(ctx, 'KeyW');
  const s = !uiOpen && keyDown(ctx, 'KeyS');
  const a = !uiOpen && keyDown(ctx, 'KeyA');
  const d = !uiOpen && keyDown(ctx, 'KeyD');
  const shift = keyDown(ctx, 'ShiftLeft') || keyDown(ctx, 'ShiftRight');

  if (!S.airborne) {
    // On the ground: W/S = throttle.
    if (w) S.throttle = Math.min(1, S.throttle + dt * 0.5);
    if (s) S.throttle = Math.max(0, S.throttle - dt * 0.7);
  } else {
    // In the air: W/S = pitch, throttle holds (Shift / arrows adjust it).
    if (shift || keyDown(ctx, 'ArrowUp')) S.throttle = Math.min(1, S.throttle + dt * 0.3);
    if (keyDown(ctx, 'ArrowDown')) S.throttle = Math.max(0.15, S.throttle - dt * 0.3);
    if (w) S.pitch = Math.min(0.5, S.pitch + dt * 0.6);
    else if (s) S.pitch = Math.max(-0.45, S.pitch - dt * 0.6);
    else S.pitch *= Math.max(0, 1 - dt * 1.5);
  }

  // Speed chases throttle.
  const targetSpeed = S.throttle * MAX_SPEED;
  S.speed += (targetSpeed - S.speed) * Math.min(1, dt * 0.8);

  // Steering / banking.
  const steer = (a ? 1 : 0) - (d ? 1 : 0);
  const turnRate = S.airborne ? 0.9 : 0.35;
  if (S.speed > 1) {
    S.heading += steer * turnRate * dt * Math.min(1, S.speed / 10);
  }
  const targetBank = S.airborne ? steer * 0.55 : 0;
  S.bank += (targetBank - S.bank) * Math.min(1, dt * 4);

  // Takeoff.
  if (!S.airborne && S.speed >= TAKEOFF_SPEED && S.throttle > 0.55) {
    S.airborne = true;
    S.pitch = 0.25;
    toast(ctx, 'Takeoff! Brasa Air is airborne — W climbs, S descends, A/D banks.');
  }

  // Move.
  const fwd = new THREE.Vector3(Math.sin(S.heading), 0, Math.cos(S.heading));
  S.pos.addScaledVector(fwd, S.speed * dt);
  if (S.airborne) {
    S.pos.y += Math.sin(S.pitch) * S.speed * dt;
    if (S.pos.y > CEILING) { S.pos.y = CEILING; S.pitch = Math.min(S.pitch, 0); }
    if (S.pos.y <= 0.05) {
      // Touchdown — allowed anywhere flat, runway/beach are the clean spots.
      // Cut the throttle so the plane stays down (and can be exited) until
      // the pilot throttles up again; otherwise it would lift straight off.
      S.pos.y = 0;
      S.airborne = false;
      S.pitch = 0;
      S.throttle = 0;
      const onRunway = Math.abs(S.pos.z - RUNWAY_Z) < 8 && Math.abs(S.pos.x) <= RUNWAY_HALF + 10;
      const onBeach = S.pos.z > WATER_Z_MIN;
      toast(ctx, onRunway || onBeach ? 'Landed cleanly.' : 'Landed off-strip — the plane is fine, walk it back to the runway.');
    }
  }

  // Keep the plane inside a generous play area.
  S.pos.x = THREE.MathUtils.clamp(S.pos.x, -320, 320);
  S.pos.z = THREE.MathUtils.clamp(S.pos.z, -320, 320);

  // Apply transform. Model forward is +X, so yaw = -heading + PI/2.
  // YXZ order: yaw, then pitch (nose up/down), then bank roll.
  if (S.mesh) {
    S.mesh.position.copy(S.pos);
    S.mesh.rotation.order = 'YXZ';
    S.mesh.rotation.y = -S.heading + Math.PI / 2;
    S.mesh.rotation.x = -S.pitch;
    S.mesh.rotation.z = S.bank;
  }

  // Camera follows: keep the player anchor on the plane so the main
  // third-person camera tracks it.
  setPlayerPos(ctx, S.pos.clone().add(new THREE.Vector3(0, 1.5, 0)));
  if (ctx.state) ctx.state.inPlane = true;
  ctx.playerHeading = S.heading;
  if (ctx.state) ctx.state.playerHeading = S.heading;

  // Chase camera for flight (main.js may override with its own follow cam;
  // both agree on the same anchor, so there is no visible fight).
  const camera = ctx.camera;
  if (camera && ctx.cameraControl !== 'external' && !ctx.cameraHandled) {
    const camDist = 16;
    camera.position.set(
      S.pos.x - fwd.x * camDist,
      S.pos.y + 5.5,
      S.pos.z - fwd.z * camDist
    );
    camera.lookAt(S.pos.x + fwd.x * 8, S.pos.y + 1, S.pos.z + fwd.z * 8);
  }

  // Exit with E when stopped on the ground.
  if (ePressed && !S.airborne && S.speed < 3) exitPlane(ctx);

  setPrompt(
    S.airborne
      ? 'Flying — W climb / S descend · A/D bank · Shift throttle · Alt ' + Math.round(S.pos.y) + ' / ' + CEILING + ' · Speed ' + Math.round(S.speed)
      : 'On runway — W throttle (need 22 to take off) · Speed ' + Math.round(S.speed) + ' · E to exit when stopped'
  );
}
