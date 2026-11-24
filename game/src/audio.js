// audio.js — WebAudio music + synthesized SFX for ISLA BRASA 3D (round 6).
// No audio files anywhere: every sound is built from oscillators and noise.
// init(ctx) / update(dt, ctx). Attaches:
//   ctx.audio = { playSfx, playPickup, setMusic, setPattern, toggleMute,
//                 muted, musicOn, pattern, bpm }
// Music only starts after a first user gesture (browser autoplay policy:
// the AudioContext is created/resumed on keydown / pointerdown / click).
// Mute key is N (M is taken by the map overlay).
import * as THREE from 'three';
import * as Config from './config.js';

const BPM = Config.BPM ?? 112;
const MASTER_LEVEL = 0.9;
const MUSIC_LEVEL = 0.32;

// 16-step patterns. Bass notes are semitone offsets from A2 (110 Hz),
// lead notes from A4 (440 Hz); -1 means rest on that step.
const PATTERNS = {
  brasa: { // Brasa FM — the default, upbeat 112 BPM
    bpm: 112,
    bass: [0, -1, 0, -1, 3, -1, 0, -1, 5, -1, 3, -1, 7, -1, 5, 3],
    lead: [12, -1, 15, -1, 19, -1, 15, 12, 17, -1, 19, -1, 24, -1, 19, 15],
    wave: 'sawtooth', leadWave: 'square', hatEvery: 2,
  },
  chill: { // Coral Chill — slow and mellow
    bpm: 84,
    bass: [0, -1, -1, -1, -3, -1, -1, -1, 5, -1, -1, -1, 3, -1, -1, -1],
    lead: [12, -1, -1, 16, -1, -1, 19, -1, -1, 17, -1, -1, 16, -1, -1, -1],
    wave: 'sine', leadWave: 'sine', hatEvery: 4,
  },
  rock: { // Turbo Rock — driving rock loop
    bpm: 132,
    bass: [0, 0, -1, 0, -1, 0, 3, -1, 0, 0, -1, 0, 5, -1, 7, -1],
    lead: [12, 12, -1, 15, -1, 12, -1, 19, -1, 17, -1, 15, -1, 12, -1, 24],
    wave: 'sawtooth', leadWave: 'sawtooth', hatEvery: 1,
  },
};

function semitoneToFreq(semi, base) {
  return base * Math.pow(2, semi / 12);
}

let ctxRef = null;
let ac = null;          // AudioContext (created lazily on first gesture)
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let noiseBuffer = null; // shared 1 s white-noise buffer for hats / shots

let musicOn = true;
let muted = false;
let patternName = 'brasa';
let stepIdx = 0;
let nextStepTime = 0;
let schedulerId = null;

// Engine hum (persistent sawtooth through a lowpass; gain/pitch follow speed).
let engineOsc = null;
let engineGain = null;

// Wanted siren (two-tone wail driven by an LFO on the oscillator frequency).
let sirenOsc = null;
let sirenLfo = null;
let sirenGain = null;
let sirenActive = false;

function buildContext() {
  if (ac) {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  masterGain = ac.createGain();
  masterGain.gain.value = muted ? 0 : MASTER_LEVEL;
  masterGain.connect(ac.destination);
  musicGain = ac.createGain();
  musicGain.gain.value = MUSIC_LEVEL;
  musicGain.connect(masterGain);
  sfxGain = ac.createGain();
  sfxGain.gain.value = 0.9;
  sfxGain.connect(masterGain);

  const len = ac.sampleRate;
  noiseBuffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // Engine hum: quiet at idle, louder + higher-pitched with speed (see update).
  engineOsc = ac.createOscillator();
  engineOsc.type = 'sawtooth';
  engineOsc.frequency.value = 42;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;
  engineGain = ac.createGain();
  engineGain.gain.value = 0;
  engineOsc.connect(lp);
  lp.connect(engineGain);
  engineGain.connect(sfxGain);
  engineOsc.start();

  startScheduler();
  return ac;
}

function scheduleStep(idx, t) {
  const p = PATTERNS[patternName] || PATTERNS.brasa;
  const stepDur = 60 / p.bpm / 4; // one 16th note
  const bass = p.bass[idx % 16];
  if (bass >= 0) {
    const o = ac.createOscillator();
    o.type = p.wave;
    o.frequency.value = semitoneToFreq(bass, 110);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 0.95);
    o.connect(g);
    g.connect(musicGain);
    o.start(t);
    o.stop(t + stepDur);
  }
  const lead = p.lead[idx % 16];
  if (lead >= 0) {
    const o = ac.createOscillator();
    o.type = p.leadWave;
    o.frequency.value = semitoneToFreq(lead, 440);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.8);
    o.connect(g);
    g.connect(musicGain);
    o.start(t);
    o.stop(t + stepDur * 2);
  }
  if (idx % p.hatEvery === 0) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 0.5);
    src.connect(hp);
    hp.connect(g);
    g.connect(musicGain);
    src.start(t, Math.random() * 0.5, stepDur);
  }
}

function startScheduler() {
  if (schedulerId || !ac) return;
  stepIdx = 0;
  nextStepTime = ac.currentTime + 0.05;
  schedulerId = setInterval(() => {
    const p = PATTERNS[patternName] || PATTERNS.brasa;
    const stepDur = 60 / p.bpm / 4;
    // When music is off/muted, advance the clock silently so resuming
    // lands back on the beat instead of stacking overdue notes.
    while (nextStepTime < ac.currentTime + 0.15) {
      if (musicOn && !muted) scheduleStep(stepIdx, nextStepTime);
      nextStepTime += stepDur;
      stepIdx = (stepIdx + 1) % 16;
    }
  }, 40);
}

function setSiren(on) {
  if (!ac || on === sirenActive) return;
  sirenActive = on;
  if (on) {
    sirenOsc = ac.createOscillator();
    sirenOsc.type = 'sine';
    sirenOsc.frequency.value = 770;
    sirenLfo = ac.createOscillator();
    sirenLfo.type = 'square';
    sirenLfo.frequency.value = 0.55; // ~0.9 s per tone
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 165; // swings 770 +/- 165 Hz (605 / 935 Hz)
    sirenLfo.connect(lfoGain);
    lfoGain.connect(sirenOsc.frequency);
    sirenGain = ac.createGain();
    sirenGain.gain.value = 0.0;
    sirenGain.gain.linearRampToValueAtTime(0.07, ac.currentTime + 0.4);
    sirenOsc.connect(sirenGain);
    sirenGain.connect(sfxGain);
    sirenOsc.start();
    sirenLfo.start();
  } else if (sirenOsc) {
    const t = ac.currentTime;
    sirenGain.gain.linearRampToValueAtTime(0.0, t + 0.2);
    sirenOsc.stop(t + 0.3);
    sirenLfo.stop(t + 0.3);
    sirenOsc = null;
    sirenLfo = null;
    sirenGain = null;
  }
}

// One-shot sound effects. Names used by the rest of the game:
// 'gunshot', 'pickup', 'click', 'siren' (2.5 s burst), 'explosion'.
function playSfx(name) {
  if (muted) return;
  buildContext();
  if (!ac) return;
  const t = ac.currentTime;
  if (name === 'gunshot') {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(lp);
    lp.connect(g);
    g.connect(sfxGain);
    src.start(t, Math.random() * 0.4, 0.2);
  } else if (name === 'pickup') {
    [880, 1318.5].forEach((freq, i) => {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = ac.createGain();
      const t0 = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      o.connect(g);
      g.connect(sfxGain);
      o.start(t0);
      o.stop(t0 + 0.4);
    });
  } else if (name === 'click') {
    const o = ac.createOscillator();
    o.type = 'square';
    o.frequency.value = 1200;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g);
    g.connect(sfxGain);
    o.start(t);
    o.stop(t + 0.07);
  } else if (name === 'siren') {
    setSiren(true);
    setTimeout(() => setSiren(false), 2500);
  } else if (name === 'explosion') {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g = ac.createGain();
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(lp);
    lp.connect(g);
    g.connect(sfxGain);
    src.start(t, 0, 1.0);
  }
}

function toggleMute() {
  muted = !muted;
  if (masterGain && ac) {
    masterGain.gain.linearRampToValueAtTime(muted ? 0 : MASTER_LEVEL, ac.currentTime + 0.1);
  }
  if (ctxRef && ctxRef.hud && ctxRef.hud.showMessage) {
    ctxRef.hud.showMessage(muted ? 'Audio muted (N)' : 'Audio on (N)');
  }
  return muted;
}

function onFirstGesture() {
  buildContext();
}

export function init(ctx) {
  ctxRef = ctx;
  ctx.state = ctx.state || {};
  // N toggles all audio. Gesture listeners create/resume the AudioContext.
  window.addEventListener('keydown', (e) => {
    buildContext();
    if (e.code === 'KeyN' && !e.repeat) toggleMute();
  });
  window.addEventListener('pointerdown', onFirstGesture);
  window.addEventListener('click', onFirstGesture);

  ctx.audio = {
    playSfx,
    playPickup() { playSfx('pickup'); },
    // Mission-complete jingle (missions.js calls this, guarded). Reuses the
    // pickup chime twice — the only melodic SFX this module implements.
    playMissionComplete() { playSfx('pickup'); setTimeout(() => playSfx('pickup'), 180); },
    setMusic(on) { musicOn = !!on; },
    setPattern(name) {
      if (PATTERNS[name]) {
        patternName = name;
        stepIdx = 0;
      }
    },
    toggleMute,
    get muted() { return muted; },
    get musicOn() { return musicOn; },
    get pattern() { return patternName; },
  };
  // Expose the default tempo so other modules (e.g. HUD) can show it.
  ctx.audio.bpm = BPM;
}

function readSpeed(ctx) {
  const s = ctx.state || {};
  if (typeof s.speed === 'number') return s.speed;
  if (s.vehicle && typeof s.vehicle.speed === 'number') return s.vehicle.speed;
  if (ctx.vehicle && typeof ctx.vehicle.speed === 'number') return ctx.vehicle.speed;
  return 0;
}

function readInCar(ctx) {
  const s = ctx.state || {};
  return !!(s.inCar || s.driving || s.vehicle || ctx.vehicle);
}

export function update(dt, ctx) {
  if (!ac) return;
  // Engine hum follows car speed; silent on foot.
  const inCar = readInCar(ctx);
  const speed = Math.abs(readSpeed(ctx));
  if (engineGain && engineOsc) {
    const target = inCar ? Math.min(0.22, 0.05 + speed * 0.006) : 0;
    engineGain.gain.setTargetAtTime(muted ? 0 : target, ac.currentTime, 0.08);
    engineOsc.frequency.setTargetAtTime(42 + speed * 3.2, ac.currentTime, 0.1);
  }
  // Wanted siren while wanted level is 3 or higher.
  const wanted = ctx.state && typeof ctx.state.wanted === 'number' ? ctx.state.wanted : 0;
  setSiren(wanted >= 3 && !muted);
}
