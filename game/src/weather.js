// weather.js — W2 (player + vehicles), ISLA BRASA 3D round-6 rebuild.
// Rain toggle (V key): visible rain streaks (THREE.Points, one draw call),
// wet-road look (road materials darken and turn glossy), and car grip drops
// to 0.75 while it rains (ctx.state.raining = true; cars.js reads it).
// init(ctx) / update(dt, ctx). Attaches ctx.weather = { raining, toggle }.
// Written fresh from the design spec. No code copied from any other repo.
import * as THREE from 'three';
import * as Config from './config.js';

const DROP_COUNT = Config.RAIN_DROPS ?? 900;
const FALL_SPEED = 55;
const AREA = (Config.WORLD_SIZE ?? 400) / 2; // rain box half-extent around player
const RAIN_GRIP = Config.RAIN_GRIP ?? 0.75;

let ctxRef = null;
let raining = false;
let points = null;
let positions = null;
let velocities = null;
let roadMats = []; // { mat, baseColor, baseRoughness } captured on first toggle
let roadsScanned = false;

function playerPos(ctx) {
  const s = ctx.state || {};
  if (s.playerPos && typeof s.playerPos.x === 'number') return s.playerPos;
  if (Array.isArray(s.playerPos)) {
    return { x: s.playerPos[0] || 0, y: s.playerPos[1] || 0, z: s.playerPos[2] || 0 };
  }
  if (ctx.player && ctx.player.pos) return ctx.player.pos;
  if (ctx.player && ctx.player.mesh) return ctx.player.mesh.position;
  return { x: 0, y: 0, z: 0 };
}

// Roads are the meshes world.js tagged with userData.isRoad. Capture their
// materials once so the wet look can be applied and reverted cleanly.
function scanRoads() {
  roadMats = [];
  if (!ctxRef || !ctxRef.scene) return;
  ctxRef.scene.traverse((obj) => {
    if (obj.isMesh && obj.userData.isRoad && obj.material && obj.material.color) {
      roadMats.push({
        mat: obj.material,
        base: obj.material.color.clone(),
        baseRoughness: typeof obj.material.roughness === 'number' ? obj.material.roughness : 0.9,
      });
    }
  });
  roadsScanned = true;
}

function applyWetLook(wet) {
  if (!roadsScanned) scanRoads();
  for (const r of roadMats) {
    if (wet) {
      r.mat.color.copy(r.base).multiplyScalar(0.45);
      if ('roughness' in r.mat) r.mat.roughness = 0.25; // glossy wet asphalt
    } else {
      r.mat.color.copy(r.base);
      if ('roughness' in r.mat) r.mat.roughness = r.baseRoughness;
    }
    r.mat.needsUpdate = true;
  }
}

function notify(ctx, msg) {
  if (ctx && typeof ctx.notify === 'function') { ctx.notify(msg); return; }
  if (ctx && ctx.hud && typeof ctx.hud.showMessage === 'function') { ctx.hud.showMessage(msg); return; }
  console.log('[weather]', msg);
}

function toggle() {
  raining = !raining;
  if (ctxRef) {
    ctxRef.state = ctxRef.state || {};
    ctxRef.state.raining = raining;
  }
  if (points) points.visible = raining;
  applyWetLook(raining);
  if (ctxRef) {
    notify(ctxRef, raining
      ? 'Rain — roads slippery, grip ' + RAIN_GRIP + ' (V to stop)'
      : 'Rain stopped (V for rain)');
  }
  return raining;
}

export function init(ctx) {
  ctxRef = ctx;
  ctx.state = ctx.state || {};
  ctx.state.raining = false;

  positions = new Float32Array(DROP_COUNT * 3);
  velocities = new Float32Array(DROP_COUNT);
  for (let i = 0; i < DROP_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * AREA * 2;
    positions[i * 3 + 1] = Math.random() * 60;
    positions[i * 3 + 2] = (Math.random() - 0.5) * AREA * 2;
    velocities[i] = FALL_SPEED * (0.8 + Math.random() * 0.4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9db8d6, size: 0.35, transparent: true, opacity: 0.65,
    sizeAttenuation: true, depthWrite: false,
  });
  points = new THREE.Points(geo, mat);
  points.visible = false;
  points.frustumCulled = false; // positions wrap around the player; never cull
  points.userData.isRain = true;
  ctx.scene.add(points);

  // V toggles the rain. Ignore repeats and keypresses aimed at a text field.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV' || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    toggle();
  });

  ctx.weather = {
    toggle,
    get raining() { return raining; },
  };
}

export function update(dt, ctx) {
  if (!raining || !points) return;
  const p = playerPos(ctx);
  // Rain box follows the player so drops are always overhead.
  for (let i = 0; i < DROP_COUNT; i++) {
    let y = positions[i * 3 + 1] - velocities[i] * dt;
    if (y < 0) {
      y = 45 + Math.random() * 15;
      positions[i * 3] = p.x + (Math.random() - 0.5) * AREA;
      positions[i * 3 + 2] = p.z + (Math.random() - 0.5) * AREA;
    }
    positions[i * 3 + 1] = y;
    // Slight wind slant: drift drops -x as they fall.
    positions[i * 3] -= 6 * dt;
  }
  points.geometry.attributes.position.needsUpdate = true;
}
