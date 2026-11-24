// radio.js — 3 radio stations while driving (press R in a car to cycle).
// Each station is a different WebAudio pattern played through ctx.audio
// (see audio.js: 'brasa' = 112 BPM upbeat, 'chill' = 84 BPM mellow,
// 'rock' = 132 BPM driving rock). On foot, R is NOT the radio — it starts
// races — so the key handler only fires while the player is driving.
// init(ctx) / update(dt, ctx). Attaches:
//   ctx.radio = { cycle, station, stationName, stations }
import * as THREE from 'three';
import * as Config from './config.js';

const STATIONS = [
  { name: 'Brasa FM', pattern: 'brasa', desc: 'Upbeat 112 BPM' },
  { name: 'Coral Chill', pattern: 'chill', desc: 'Slow & mellow' },
  { name: 'Turbo Rock', pattern: 'rock', desc: 'Driving rock' },
];

let ctxRef = null;
let station = 0;

function isInCar(ctx) {
  const s = ctx.state || {};
  // inCar lives on ctx.player (player.js) and on ctx.cars.current — the
  // state.* spellings below are fallbacks only.
  return !!(
    s.inCar || s.driving || s.vehicle || ctx.vehicle
    || (ctx.player && ctx.player.inCar)
    || (ctx.cars && ctx.cars.current)
  );
}

function applyStation() {
  const st = STATIONS[station];
  if (ctxRef.audio && ctxRef.audio.setPattern) ctxRef.audio.setPattern(st.pattern);
  if (ctxRef.audio && ctxRef.audio.setMusic) ctxRef.audio.setMusic(true);
  if (ctxRef.hud && ctxRef.hud.showMessage) {
    ctxRef.hud.showMessage('Radio: ' + st.name + ' — ' + st.desc);
  }
}

function cycle() {
  station = (station + 1) % STATIONS.length;
  applyStation();
  return STATIONS[station].name;
}

export function init(ctx) {
  ctxRef = ctx;
  ctx.state = ctx.state || {};
  station = 0;
  // R cycles stations, but only while driving (R on foot starts races).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat && isInCar(ctxRef)) {
      e.preventDefault();
      cycle();
    }
  });
  ctx.radio = {
    cycle,
    get station() { return station; },
    get stationName() { return STATIONS[station].name; },
    stations: STATIONS.map((s) => s.name),
  };
}

export function update(dt, ctx) {
  // Radio is event-driven (R key); nothing per frame. But if the audio
  // context was (re)created after a gesture, re-apply the current station
  // so driving never falls back to the on-foot music choice.
  if (ctx.audio && ctx.audio.pattern !== STATIONS[station].pattern) {
    if (isInCar(ctx)) ctx.audio.setPattern(STATIONS[station].pattern);
  }
}
