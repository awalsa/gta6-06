// dialogue.js — ISLA BRASA 3D (round 6): dialogue boxes, NPC lines, mission briefs.
// Contract: exports init(ctx) and update(dt, ctx).
// ctx = { scene, camera, renderer, state, input, config, THREE }.
// Renders into #dialogue-box (created here when the page has none).
// Lines queue up and play one at a time; each line shows for a few seconds
// and then the next one takes over automatically.

const LINE_MS = 4000;
const BRIEF_MS = 5000;

// Idle chatter pedestrians say when the player walks up and presses F.
export const NPC_LINES = [
  'You look new around Brasa. Watch yourself after dark.',
  'The Coral Room pays out big tonight, or so they say.',
  'Rico at the garage can get you a car that actually runs.',
  'Heard the Vela job went sideways. Again.',
  'Feria Market has the best tamales on the island. Fact.',
  'Police have been stopping everyone near the tunnel.',
  'If you want work, ask around the plaza. Somebody always needs a driver.',
  'The beach at sunset? Best free thing on this island.',
  "Ghost says the casino cameras are blind on Tuesdays. Don't quote me.",
  "Marta doesn't miss. If she offers to ride along, say yes.",
];

export const MISSION_GIVER_LINES = {
  default: 'Got a job for you. Read the brief and get moving — time is money.',
};

let lineQueue = [];
let showing = null; // { speaker, text, leftMs }
let box = null;
let speakerEl = null;
let textEl = null;

function buildBox() {
  if (box && document.body.contains(box)) return box;
  box = document.getElementById('dialogue-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'dialogue-box';
    box.className = 'dialogue-box';
    box.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:90px', 'transform:translateX(-50%)',
      'min-width:280px', 'max-width:560px', 'padding:12px 16px',
      'background:rgba(10,10,18,0.88)', 'color:#fff',
      'border:1px solid rgba(255,255,255,0.25)', 'border-radius:10px',
      'font-family:system-ui,sans-serif', 'font-size:15px', 'line-height:1.4',
      'z-index:60', 'display:none', 'pointer-events:none',
    ].join(';');
    speakerEl = document.createElement('div');
    speakerEl.id = 'dialogue-speaker';
    speakerEl.style.cssText = 'font-weight:700;color:#ffd34d;margin-bottom:4px;';
    textEl = document.createElement('div');
    textEl.id = 'dialogue-text';
    box.appendChild(speakerEl);
    box.appendChild(textEl);
    document.body.appendChild(box);
  } else {
    speakerEl = box.querySelector('#dialogue-speaker');
    textEl = box.querySelector('#dialogue-text');
    if (!speakerEl) {
      speakerEl = document.createElement('div');
      speakerEl.id = 'dialogue-speaker';
      box.prepend(speakerEl);
    }
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.id = 'dialogue-text';
      box.appendChild(textEl);
    }
  }
  return box;
}

function playNext() {
  const el = buildBox();
  if (!lineQueue.length) {
    showing = null;
    el.style.display = 'none';
    return;
  }
  showing = lineQueue.shift();
  if (speakerEl) speakerEl.textContent = showing.speaker || '';
  if (textEl) textEl.textContent = showing.text || '';
  el.style.display = 'block';
}

function randomLine() {
  return NPC_LINES[Math.floor(Math.random() * NPC_LINES.length)];
}

export function init(ctx) {
  lineQueue = [];
  showing = null;
  if (typeof document !== 'undefined') buildBox();

  const api = {
    // Queue one spoken line. Returns true; the line plays when its turn comes.
    show(speaker, text, ms) {
      lineQueue.push({
        speaker: speaker || '???',
        text: String(text == null ? '' : text),
        leftMs: typeof ms === 'number' && ms > 0 ? ms : LINE_MS,
      });
      if (!showing) playNext();
      return true;
    },
    // Same as show(), under the plain name other modules use.
    showDialogue(speaker, text, ms) { return api.show(speaker, text, ms); },

    // Mission brief: a title line, then each brief line in turn.
    // `lines` may be one string or an array of strings.
    showBrief(title, lines) {
      const parts = Array.isArray(lines) ? lines : [String(lines == null ? '' : lines)];
      const who = String(title || 'Mission');
      for (const part of parts) {
        lineQueue.push({ speaker: who, text: String(part), leftMs: BRIEF_MS });
      }
      if (!showing) playNext();
      return true;
    },

    // An NPC speaks when the player presses F near them. With no text given,
    // the NPC says a random chatter line.
    speakTo(speakerName, text) {
      return api.show(speakerName || 'Pedestrian', text || randomLine(), LINE_MS);
    },
    randomNpcLine: randomLine,

    // Skip the line on screen right now; the next queued line plays.
    dismiss() {
      showing = null;
      playNext();
    },
    clear() {
      lineQueue = [];
      showing = null;
      buildBox().style.display = 'none';
    },
    get isShowing() { return !!showing; },
    get queuedCount() { return lineQueue.length; },
  };

  if (ctx) ctx.dialogue = api;

  // F-interact hook: the nearest pedestrian within 4.5 units says a line.
  // player.js calls ctx.onInteract(playerPos) on an F edge. Combat owns F
  // while a live enemy is in punch range, so never talk over a punch.
  if (ctx && typeof ctx.onInteract !== 'function') {
    ctx.onInteract = (pos) => {
      if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return false;
      const foes = ctx.combat && Array.isArray(ctx.combat.enemies) ? ctx.combat.enemies : [];
      for (const foe of foes) {
        if (foe && foe.alive && foe.pos && Math.hypot(foe.pos.x - pos.x, foe.pos.z - pos.z) < 3) return false;
      }
      const crowd = ctx.pedestrians && Array.isArray(ctx.pedestrians.list) ? ctx.pedestrians.list : [];
      let nearest = null;
      let nearestD = 4.5;
      for (const ped of crowd) {
        if (!ped || !ped.mesh) continue;
        const d = Math.hypot(ped.mesh.position.x - pos.x, ped.mesh.position.z - pos.z);
        if (d < nearestD) { nearestD = d; nearest = ped; }
      }
      if (!nearest) return false;
      api.speakTo('Pedestrian');
      return true;
    };
  }
  return api;
}

export function update(dt, ctx) {
  if (!showing) {
    if (lineQueue.length) playNext();
    return;
  }
  showing.leftMs -= (typeof dt === 'number' ? dt : 0) * 1000;
  if (showing.leftMs <= 0) playNext();
}

export default { init, update, NPC_LINES };
