// daynight.js — 360-second day/night cycle for ISLA BRASA 3D.
// The sun and moon orbit the sky, sky/fog colours lerp through
// dawn -> day -> dusk -> night, and street lamps + window lights switch on
// at night. The visible sky is darkened in two places: scene.background /
// fog AND the world's gradient sky dome via ctx.world.setNightFactor (the
// dome covers the background, so without that call the sky would stay
// day-blue all night even though isNight is true).
// init(ctx) / update(dt, ctx). Attaches:
//   ctx.daynight = { timeOfDay, isNight }
// Writes ctx.state.timeOfDay in [0, 1): 0 = dawn, 0.25 = noon,
// 0.5 = dusk, 0.75 = midnight. Also writes ctx.state.isNight.
import * as THREE from 'three';
import * as Config from './config.js';

const CYCLE_SECONDS = Config.DAY_LENGTH_SECONDS ?? Config.DAY_LENGTH ?? 360;
const WORLD_R = (Config.WORLD_SIZE ?? 400) / 2 + 60;

const SKY_DAY = new THREE.Color(0x87ceeb);
const SKY_DAWN = new THREE.Color(0xffb27a);
const SKY_DUSK = new THREE.Color(0xff7e47);
const SKY_NIGHT = new THREE.Color(0x0b1026);

let ctxRef = null;
let timeOfDay = 0.08; // start just after dawn
let sunLight = null;
let moonLight = null;
let hemiLight = null;
let sunMesh = null;
let moonMesh = null;

function skyColorAt(t) {
  // Piecewise lerp: dawn (0) -> day (0.25) -> dusk (0.5) -> night (0.75) -> dawn (1).
  const c = new THREE.Color();
  if (t < 0.25) c.lerpColors(SKY_DAWN, SKY_DAY, t / 0.25);
  else if (t < 0.5) c.lerpColors(SKY_DAY, SKY_DUSK, (t - 0.25) / 0.25);
  else if (t < 0.75) c.lerpColors(SKY_DUSK, SKY_NIGHT, (t - 0.5) / 0.25);
  else c.lerpColors(SKY_NIGHT, SKY_DAWN, (t - 0.75) / 0.25);
  return c;
}

function isNight() {
  // Night while the sun is at or below the horizon.
  return Math.sin(timeOfDay * Math.PI * 2) < 0.05;
}

export function init(ctx) {
  ctxRef = ctx;
  ctx.state = ctx.state || {};
  ctx.state.timeOfDay = timeOfDay;

  // Sun: warm directional light + visible disc. Moon: cool dim light + disc.
  sunLight = new THREE.DirectionalLight(0xfff2d0, 1.6);
  sunLight.position.set(100, 180, 60);
  ctx.scene.add(sunLight);
  moonLight = new THREE.DirectionalLight(0x8fa8ff, 0.0);
  moonLight.position.set(-100, 160, -60);
  ctx.scene.add(moonLight);
  hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x3a2f28, 0.7);
  ctx.scene.add(hemiLight);

  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(9, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffdf6b, fog: false }),
  );
  sunMesh.userData.isSun = true;
  ctx.scene.add(sunMesh);
  moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(6.5, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xe8ecf5, fog: false }),
  );
  moonMesh.userData.isMoon = true;
  ctx.scene.add(moonMesh);

  if (!ctx.scene.fog) ctx.scene.fog = new THREE.Fog(0x87ceeb, 120, 420);
  ctx.scene.background = skyColorAt(timeOfDay);

  ctx.daynight = {
    get timeOfDay() { return timeOfDay; },
    set timeOfDay(v) { timeOfDay = ((v % 1) + 1) % 1; },
    isNight,
  };
}

function setLampAndWindowLights(night) {
  // World tags lamp meshes (userData.isLamp) and lit windows
  // (userData.isWindow) — toggle their emissive glow at night.
  ctxRef.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.userData.isLamp && obj.material && obj.material.emissive) {
      obj.material.emissiveIntensity = night ? 2.2 : 0.0;
    }
    if (obj.userData.isWindow && obj.material && obj.material.emissive) {
      obj.material.emissiveIntensity = night ? 1.6 : 0.15;
    }
  });
}

export function update(dt, ctx) {
  timeOfDay = (timeOfDay + dt / CYCLE_SECONDS) % 1;
  ctx.state.timeOfDay = timeOfDay;

  const ang = timeOfDay * Math.PI * 2; // 0 = dawn (sun at east horizon)
  const sunElev = Math.sin(ang);
  const night = isNight();

  // Sun / moon orbit east -> overhead -> west -> below horizon.
  sunMesh.position.set(Math.cos(ang) * WORLD_R, Math.sin(ang) * WORLD_R * 0.9 + 10, 40);
  moonMesh.position.set(-Math.cos(ang) * WORLD_R, -Math.sin(ang) * WORLD_R * 0.9 + 10, -40);
  sunLight.position.copy(sunMesh.position);
  moonLight.position.copy(moonMesh.position);
  sunLight.intensity = THREE.MathUtils.clamp(sunElev * 1.8, 0, 1.6);
  moonLight.intensity = night ? 0.35 : 0;
  hemiLight.intensity = night ? 0.25 : 0.7;
  sunMesh.visible = sunElev > -0.08;
  moonMesh.visible = sunElev < 0.08;

  // Sky + fog follow the sun.
  const sky = skyColorAt(timeOfDay);
  if (ctx.scene.background && ctx.scene.background.isColor) {
    ctx.scene.background.copy(sky);
  } else {
    ctx.scene.background = sky;
  }
  if (ctx.scene.fog) ctx.scene.fog.color.copy(sky);

  // Drive the sky dome: the visible sky is the world's gradient dome, not
  // scene.background (the dome covers it). Without this call the dome
  // stays day-blue all night even though the module reports isNight.
  // Night factor: 0 at noon, 1 at midnight.
  if (ctx.world && typeof ctx.world.setNightFactor === 'function') {
    ctx.world.setNightFactor(THREE.MathUtils.clamp((1 - sunElev) / 2, 0, 1));
  }

  setLampAndWindowLights(night);
  ctx.state.isNight = night;
}
