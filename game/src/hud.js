// hud.js — ISLA BRASA 3D: HUD, minimap, weapon wheel, shop/garage/crew/help
// overlays (round 6, worker W6).
//
// The HUD bar shows cash, wanted stars (0–5), respect rank + payout bonus,
// the mission tracker (name, current step, distance, timer) and a health
// bar. A 180×180 minimap canvas (top-right) draws the road grid, the water
// strip, landmark dots, police dots, the mission target diamond and the
// player dot. Holding Q opens the weapon wheel (click or press 1–7 to
// equip); G opens the shop (or the garage near Brasa Garage); H opens the
// help overlay; Esc closes overlays.
//
// Shared contract: exports init(ctx) and update(dt, ctx), plus WEAPONS and
// OUTFITS. ctx = { scene, camera, renderer, state, input, config }.
// DOM ids (created here when index.html did not provide them):
// hud-cash, hud-wanted, hud-respect, hud-mission, hud-health, minimap,
// hud-message, weapon-wheel, overlay-shop, overlay-garage, overlay-crew,
// overlay-weapons, overlay-casino, overlay-help. Every lookup is
// null-guarded. The casino overlay element created here is only an empty
// shell — casino.js builds its own playable panel inside it dynamically.
import * as CFG from './config.js';
import * as ECON from './economy.js';

const WORLD_SIZE = typeof CFG.WORLD_SIZE === 'number' ? CFG.WORLD_SIZE : 400;
const ROAD_SPACING = typeof CFG.ROAD_SPACING === 'number' ? CFG.ROAD_SPACING : 40;

const CARS = ECON.CARS || {};
const CREW = ECON.CREW || {};
const RESPECT_RANKS = ECON.RESPECT_RANKS || ['Nobody', 'Hustler', 'Dealer', 'Boss', 'Kingpin', 'Legend'];
const RESPECT_THRESHOLDS = ECON.RESPECT_THRESHOLDS || [0, 1000, 5000, 12000, 22000, 35000];
const TOTAL_RESPECT = ECON.TOTAL_RESPECT || 35000;

// Fallback landmark layout (used only if config.js exposes no landmarks).
const FALLBACK_LANDMARKS = [
  { name: 'Feria Market', x: 0, z: -80 },
  { name: 'Old Pier', x: -160, z: 170 },
  { name: 'Marina Docks', x: -120, z: 175 },
  { name: 'Brasa Garage', x: 80, z: -40 },
  { name: 'Rook Arcade', x: 40, z: 80 },
  { name: 'Coral Room Casino', x: 120, z: 120 },
  { name: 'Coast Tunnel', x: -80, z: -160 },
  { name: 'Motel Vela', x: -40, z: 40 },
  { name: 'Underpass', x: 0, z: 150 },
  { name: 'Old Church', x: -120, z: -120 },
  { name: 'Plaza Tower', x: 0, z: 0 },
  { name: 'Beachfront', x: 160, z: 170 },
];

export const WEAPONS = [
  { id: 'fists', name: 'Fists', key: '1', price: 0 },
  { id: 'pistol', name: 'Pistol', key: '2', price: 0 },
  { id: 'smg', name: 'SMG', key: '3', price: 2500 },
  { id: 'shotgun', name: 'Shotgun', key: '4', price: 3500 },
  { id: 'rifle', name: 'Rifle', key: '5', price: 5000 },
  { id: 'sniper', name: 'Sniper', key: '6', price: 6000 },
  { id: 'rpg', name: 'RPG', key: '7', price: 9000 },
];

// Clothes shop: 4 outfits (feature 10). Buying one sets state.outfit; the
// player module recolours the player mesh from state.outfit.
export const OUTFITS = [
  { id: 'street', name: 'Street', price: 200, colors: ['#2b6cb0', '#1a202c'] },
  { id: 'beach', name: 'Beach', price: 350, colors: ['#ed8936', '#f6e05e'] },
  { id: 'suit', name: 'Sharp Suit', price: 800, colors: ['#1a202c', '#ffffff'] },
  { id: 'club', name: 'Nightclub', price: 1200, colors: ['#9b2c2c', '#d53f8c'] },
];

let els = {};
let minimapCtx = null;
let wheelVisible = false;
let messageTimer = null;
let messageQueue = [];
let trackerOverride = null; // set via setMissionTracker(...)
let boundCtx = null;
let listenersAttached = false;

function $(id) { return document.getElementById(id); }

function makeEl(id, tag, cssText, parent) {
  let el = $(id);
  if (el) return el;
  el = document.createElement(tag);
  el.id = id;
  if (cssText) el.style.cssText = cssText;
  (parent || document.body).appendChild(el);
  return el;
}

function overlayCss() {
  return [
    'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
    'min-width:320px', 'max-width:560px', 'max-height:80vh', 'overflow:auto',
    'padding:18px 20px', 'background:rgba(10,10,18,0.95)', 'color:#fff',
    'border:1px solid rgba(255,255,255,0.3)', 'border-radius:12px',
    'font-family:system-ui,sans-serif', 'font-size:15px', 'line-height:1.5',
    'z-index:70', 'display:none', 'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
  ].join(';');
}

function buttonCss(disabled) {
  return [
    'display:inline-block', 'margin:4px 6px 4px 0', 'padding:6px 12px',
    'background:' + (disabled ? '#444' : '#e53e3e'), 'color:#fff', 'border:none',
    'border-radius:6px', 'font-size:14px', 'cursor:' + (disabled ? 'default' : 'pointer'),
  ].join(';');
}

function ensureElements() {
  const hudBarCss = 'position:fixed;z-index:50;font-family:system-ui,sans-serif;color:#fff;';
  els.cash = makeEl('hud-cash', 'div', hudBarCss + 'top:12px;left:12px;font-size:20px;font-weight:700;text-shadow:0 1px 3px #000;');
  els.wanted = makeEl('hud-wanted', 'div', hudBarCss + 'top:12px;left:50%;transform:translateX(-50%);font-size:22px;letter-spacing:2px;text-shadow:0 1px 3px #000;');
  els.respect = makeEl('hud-respect', 'div', hudBarCss + 'top:44px;left:12px;font-size:14px;text-shadow:0 1px 3px #000;');
  els.mission = makeEl('hud-mission', 'div', hudBarCss + 'top:76px;left:12px;font-size:14px;background:rgba(0,0,0,0.45);padding:6px 10px;border-radius:8px;max-width:320px;');
  els.health = makeEl('hud-health', 'div', hudBarCss + 'bottom:16px;left:12px;width:200px;height:16px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.4);border-radius:8px;overflow:hidden;');
  if (!els.healthBar) {
    els.healthBar = document.createElement('div');
    els.healthBar.style.cssText = 'height:100%;width:100%;background:#48bb78;';
    els.health.appendChild(els.healthBar);
  }
  // Minimap canvas (top-right).
  let mm = $('minimap');
  if (!mm) {
    mm = document.createElement('canvas');
    mm.id = 'minimap';
    mm.width = 180; mm.height = 180;
    mm.style.cssText = hudBarCss + 'top:12px;right:12px;border:2px solid rgba(255,255,255,0.5);border-radius:8px;background:#0f2a1a;';
    document.body.appendChild(mm);
  }
  els.minimap = mm;
  minimapCtx = mm.getContext('2d');

  // Toast / message line (bottom-centre).
  els.message = makeEl('hud-message', 'div', [
    'position:fixed', 'left:50%', 'bottom:170px', 'transform:translateX(-50%)',
    'padding:8px 16px', 'background:rgba(0,0,0,0.75)', 'color:#ffd34d',
    'border-radius:8px', 'font-family:system-ui,sans-serif', 'font-size:15px',
    'z-index:65', 'display:none', 'pointer-events:none', 'text-align:center',
    'max-width:80vw',
  ].join(';'));

  // Weapon wheel (radial list, shown while Q is held).
  els.wheel = makeEl('weapon-wheel', 'div', [
    'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
    'padding:16px 20px', 'background:rgba(10,10,18,0.9)', 'color:#fff',
    'border:1px solid rgba(255,255,255,0.3)', 'border-radius:50%',
    'width:260px', 'height:260px', 'font-family:system-ui,sans-serif',
    'z-index:75', 'display:none', 'text-align:center',
  ].join(';'));

  // Overlays (created if index.html did not provide them).
  els.shop = makeEl('overlay-shop', 'div', overlayCss());
  els.garage = makeEl('overlay-garage', 'div', overlayCss());
  els.crew = makeEl('overlay-crew', 'div', overlayCss());
  els.weapons = makeEl('overlay-weapons', 'div', overlayCss());
  els.casino = makeEl('overlay-casino', 'div', overlayCss());
  els.help = makeEl('overlay-help', 'div', overlayCss());
  return els;
}

function fmtCash(n) {
  return '$' + Math.floor(Number(n) || 0).toLocaleString('en-US');
}

function getPlayerPos(ctx) {
  const s = ctx && ctx.state ? ctx.state : {};
  // state.playerPos is an ARRAY [x, y, z] (state.js); other modules keep it
  // as an object — accept both, then the player mesh / pos Vector3.
  if (Array.isArray(s.playerPos)) return { x: s.playerPos[0] || 0, z: s.playerPos[2] || 0 };
  if (s.playerPos && typeof s.playerPos.x === 'number') return { x: s.playerPos.x, z: s.playerPos.z || 0 };
  if (s.player && typeof s.player.x === 'number') return { x: s.player.x, z: s.player.z || 0 };
  if (ctx && ctx.player) {
    if (ctx.player.mesh && ctx.player.mesh.position) return { x: ctx.player.mesh.position.x, z: ctx.player.mesh.position.z };
    if (ctx.player.pos) return { x: ctx.player.pos.x, z: ctx.player.pos.z || 0 };
    if (ctx.player.position) return { x: ctx.player.position.x, z: ctx.player.position.z || 0 };
    if (typeof ctx.player.x === 'number') return { x: ctx.player.x, z: ctx.player.z || 0 };
  }
  return { x: 0, z: 0 };
}

function getMission(ctx) {
  if (trackerOverride) return trackerOverride;
  const s = ctx && ctx.state ? ctx.state : {};
  return s.mission || s.currentMission || (ctx && ctx.mission) || null;
}

function landmarks() {
  const raw = CFG.LANDMARKS || CFG.landmarks;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((l) => ({
      name: l.name || l.id || '?',
      x: typeof l.x === 'number' ? l.x : (l.pos ? l.pos[0] : 0),
      z: typeof l.z === 'number' ? l.z : (l.pos ? l.pos[2] : 0),
    }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([name, v]) => ({
      name,
      x: Array.isArray(v) ? v[0] : (v.x || 0),
      z: Array.isArray(v) ? v[1] : (v.z || 0),
    }));
  }
  return FALLBACK_LANDMARKS;
}

function garagePos() {
  const g = landmarks().find((l) => /garage/i.test(l.name));
  return g || { x: 80, z: -40, name: 'Brasa Garage' };
}

function isNearGarage(ctx) {
  const s = ctx && ctx.state ? ctx.state : {};
  if (typeof s.nearGarage === 'boolean') return s.nearGarage;
  const p = getPlayerPos(ctx);
  const g = garagePos();
  const dx = p.x - g.x, dz = p.z - g.z;
  return dx * dx + dz * dz < 20 * 20;
}

function ownedWeapons(ctx) {
  const s = ctx && ctx.state ? ctx.state : {};
  // Canonical field is state.weaponsOwned (state.js, combat.js, shops.js);
  // the older ownedWeapons / weapons spellings are read as fallbacks only.
  if (Array.isArray(s.weaponsOwned) && s.weaponsOwned.length) return s.weaponsOwned;
  if (Array.isArray(s.ownedWeapons) && s.ownedWeapons.length) return s.ownedWeapons;
  if (Array.isArray(s.weapons) && s.weapons.length) return s.weapons;
  return ['fists', 'pistol'];
}

function currentWeapon(ctx) {
  const s = ctx && ctx.state ? ctx.state : {};
  return s.currentWeapon || s.weapon || 'fists';
}

// --- Minimap ---------------------------------------------------------------
function drawMinimap(ctx) {
  if (!minimapCtx || !els.minimap) return;
  const c = minimapCtx;
  const W = els.minimap.width, H = els.minimap.height;
  const half = WORLD_SIZE / 2;
  const scale = W / WORLD_SIZE;
  const toX = (x) => (x + half) * scale;
  const toY = (z) => (z + half) * scale;

  c.clearRect(0, 0, W, H);
  c.fillStyle = '#14301f';
  c.fillRect(0, 0, W, H);
  // Water strip on the south edge (beach / pier / marina).
  c.fillStyle = '#1d4e6b';
  c.fillRect(0, toY(half - 30), W, H - toY(half - 30));
  // Roads: grid.
  c.strokeStyle = '#3a3a3a';
  c.lineWidth = 5;
  for (let v = -half; v <= half; v += ROAD_SPACING) {
    c.beginPath(); c.moveTo(toX(v), 0); c.lineTo(toX(v), H); c.stroke();
    c.beginPath(); c.moveTo(0, toY(v)); c.lineTo(W, toY(v)); c.stroke();
  }
  c.strokeStyle = '#8a8a3a';
  c.lineWidth = 1;
  c.setLineDash([4, 4]);
  for (let v = -half; v <= half; v += ROAD_SPACING) {
    c.beginPath(); c.moveTo(toX(v), 0); c.lineTo(toX(v), H); c.stroke();
    c.beginPath(); c.moveTo(0, toY(v)); c.lineTo(W, toY(v)); c.stroke();
  }
  c.setLineDash([]);
  // Landmarks.
  for (const lm of landmarks()) {
    c.fillStyle = '#ffd34d';
    c.beginPath(); c.arc(toX(lm.x), toY(lm.z), 3, 0, Math.PI * 2); c.fill();
  }
  // Police dots.
  const s = ctx && ctx.state ? ctx.state : {};
  const police = s.police || s.policeCars || (ctx && ctx.police) || [];
  if (Array.isArray(police)) {
    c.fillStyle = '#3b82f6';
    for (const p of police) {
      const px = p.x != null ? p.x : (p.position ? p.position.x : 0);
      const pz = p.z != null ? p.z : (p.position ? p.position.z : 0);
      c.beginPath(); c.arc(toX(px), toY(pz), 3, 0, Math.PI * 2); c.fill();
    }
  }
  // Mission marker (yellow diamond).
  const m = getMission(ctx);
  const target = m && (m.target || m.marker || m.destination);
  if (target && typeof target.x === 'number') {
    const mx = toX(target.x), my = toY(target.z || 0);
    c.fillStyle = '#ffdd00';
    c.beginPath();
    c.moveTo(mx, my - 7); c.lineTo(mx + 6, my); c.lineTo(mx, my + 7); c.lineTo(mx - 6, my);
    c.closePath(); c.fill();
    c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
  }
  // Player dot (white, black ring) — always on top.
  const p = getPlayerPos(ctx);
  c.fillStyle = '#ffffff';
  c.beginPath(); c.arc(toX(p.x), toY(p.z), 4.5, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#000'; c.lineWidth = 1.5; c.stroke();
}

// --- Overlays ---------------------------------------------------------------
const OVERLAY_IDS = ['shop', 'garage', 'crew', 'weapons', 'casino', 'help'];

function closeOverlays() {
  for (const id of OVERLAY_IDS) {
    if (els[id]) els[id].style.display = 'none';
  }
}

function openOverlay(id) {
  ensureElements();
  closeOverlays();
  const renderers = { shop: renderShop, garage: renderGarage, crew: renderCrew, weapons: renderWeapons, casino: renderCasino, help: renderHelp };
  if (renderers[id]) renderers[id](boundCtx);
  if (els[id]) els[id].style.display = 'block';
}

function elButton(label, disabled, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = buttonCss(disabled);
  b.disabled = !!disabled;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function renderShop(ctx) {
  const el = els.shop;
  if (!el) return;
  el.innerHTML = '';
  const econ = ctx && ctx.economy;
  const title = document.createElement('h2'); title.textContent = 'Shop — Isla Brasa'; el.appendChild(title);
  const cash = document.createElement('p');
  cash.textContent = 'Cash: ' + fmtCash(econ && typeof econ.cash === 'number' ? econ.cash : (ctx.state ? ctx.state.cash : 0));
  el.appendChild(cash);

  const wTitle = document.createElement('h3'); wTitle.textContent = 'Weapon Shop'; el.appendChild(wTitle);
  for (const w of WEAPONS.filter((x) => x.price > 0)) {
    const owned = ownedWeapons(ctx).includes(w.id);
    const row = document.createElement('div');
    row.textContent = w.name + ' — ' + fmtCash(w.price) + (owned ? ' (owned)' : '') + ' ';
    row.appendChild(elButton(owned ? 'Owned' : 'Buy', owned || !econ || econ.cash < w.price, () => {
      if (!econ) return;
      if (econ.spend(w.price)) {
        const s = ctx.state;
        if (!s.weaponsOwned) s.weaponsOwned = ['fists', 'pistol'];
        if (!s.weaponsOwned.includes(w.id)) s.weaponsOwned.push(w.id);
        showMessage('Bought the ' + w.name + '! Press Q to open the weapon wheel.');
        renderShop(ctx);
      } else showMessage('Not enough cash.');
    }));
    el.appendChild(row);
  }

  const cTitle = document.createElement('h3'); cTitle.textContent = 'Clothes Shop'; el.appendChild(cTitle);
  const s2 = ctx && ctx.state ? ctx.state : {};
  for (const o of OUTFITS) {
    // State field is outfitsOwned (state.js); shops.js keeps the same list
    // in sync. (Was ownedOutfits — a field that does not exist, so bought
    // outfits were never recognised as owned and could be re-bought.)
    const owned = Array.isArray(s2.outfitsOwned) && s2.outfitsOwned.includes(o.id);
    const wearing = s2.outfit === o.id;
    const row = document.createElement('div');
    row.textContent = o.name + ' — ' + fmtCash(o.price) + (wearing ? ' (wearing)' : owned ? ' (owned)' : '') + ' ';
    row.appendChild(elButton(wearing ? 'Wearing' : owned ? 'Wear' : 'Buy', false, () => {
      if (!econ) return;
      if (!owned && !econ.spend(o.price)) { showMessage('Not enough cash.'); return; }
      if (!owned) {
        if (!s2.outfitsOwned) s2.outfitsOwned = [];
        s2.outfitsOwned.push(o.id);
      }
      s2.outfit = o.id;
      if (ctx && ctx.player && typeof ctx.player.setOutfit === 'function') ctx.player.setOutfit(o.id);
      showMessage('You are wearing ' + o.name + '.');
      renderShop(ctx);
    }));
    el.appendChild(row);
  }

  const vTitle = document.createElement('h3'); vTitle.textContent = 'Vehicles'; el.appendChild(vTitle);
  const vehicles = [
    { id: 'motorbike', name: 'Motorbike', price: 1500, desc: 'Fast, nimble — top speed 38' },
    { id: 'boat', name: 'Brasa Boat', price: 4500, desc: 'Drives on the water by the pier/marina' },
  ];
  const ownedCars = (ctx.state && ctx.state.carsOwned) || [];
  for (const v of vehicles) {
    const owned = ownedCars.includes(v.id);
    const row = document.createElement('div');
    row.textContent = v.name + ' — ' + fmtCash(v.price) + ' · ' + v.desc + (owned ? ' (owned)' : '') + ' ';
    row.appendChild(elButton(owned ? 'Owned' : 'Buy', owned || !econ || econ.cash < v.price, () => {
      if (ctx.shops && typeof ctx.shops.buyVehicle === 'function') {
        if (ctx.shops.buyVehicle(v.id)) renderShop(ctx);
      } else showMessage('Vehicle shop is not ready yet.');
    }));
    el.appendChild(row);
  }
  el.appendChild(elButton('Garage', false, () => openOverlay('garage')));
  el.appendChild(elButton('Crew', false, () => openOverlay('crew')));
  el.appendChild(elButton('Close (G)', false, () => closeOverlays()));
}

function renderGarage(ctx) {
  const el = els.garage;
  if (!el) return;
  el.innerHTML = '';
  const econ = ctx && ctx.economy;
  const title = document.createElement('h2'); title.textContent = 'Brasa Garage'; el.appendChild(title);
  const s = ctx && ctx.state ? ctx.state : {};
  const owned = (s.garage && s.garage.owned) || {};
  for (const car of Object.values(CARS)) {
    const o = owned[car.type];
    const stats = econ && typeof econ.carStats === 'function' ? econ.carStats(car.type) : null;
    const row = document.createElement('div');
    row.style.cssText = 'border-top:1px solid rgba(255,255,255,0.2);padding:8px 0;';
    const head = document.createElement('div');
    head.textContent = car.name + ' — ' + fmtCash(car.price) + ' · top speed ' + car.speed +
      (o ? ' · OWNED' + (s.garage && s.garage.current === car.type ? ' (current car)' : '') : '');
    row.appendChild(head);
    if (!o) {
      row.appendChild(elButton('Buy', !econ || econ.cash < car.price, () => {
        if (econ && econ.buyCar(car.type)) renderGarage(ctx);
        else showMessage('Not enough cash.');
      }));
    } else {
      for (const part of ['engine', 'armor', 'handling']) {
        const tier = o.upgrades[part];
        const next = tier + 1;
        const cost = next <= 3 ? Math.round(car.price * [0.25, 0.45, 0.7][next - 1]) : null;
        row.appendChild(elButton(
          part + ' ' + tier + '/3' + (cost != null ? ' — ' + fmtCash(cost) : ' (max)'),
          cost == null || !econ || econ.cash < cost,
          () => { if (econ && econ.upgradeCar(car.type, part)) renderGarage(ctx); else showMessage('Not enough cash.'); },
        ));
      }
      row.appendChild(elButton('Use this car', s.garage && s.garage.current === car.type, () => {
        if (s.garage) s.garage.current = car.type;
        showMessage('Current car: ' + car.name + '.');
        renderGarage(ctx);
      }));
      const sellValue = Math.round(car.price * 0.6 + (o.spent || 0) * 0.4);
      row.appendChild(elButton('Sell — ' + fmtCash(sellValue), false, () => {
        if (econ) { econ.sellCar(car.type); renderGarage(ctx); }
      }));
      if (stats) {
        const st = document.createElement('div');
        st.style.cssText = 'font-size:13px;color:#ccc;';
        st.textContent = 'Upgraded speed ' + stats.speed.toFixed(1) + ' · handling ' + stats.handling.toFixed(2) + ' · armor +' + stats.armor;
        row.appendChild(st);
      }
    }
    el.appendChild(row);
  }
  el.appendChild(elButton('Shop', false, () => openOverlay('shop')));
  el.appendChild(elButton('Crew', false, () => openOverlay('crew')));
  el.appendChild(elButton('Close (G)', false, () => closeOverlays()));
}

function renderCrew(ctx) {
  const el = els.crew;
  if (!el) return;
  el.innerHTML = '';
  const econ = ctx && ctx.economy;
  const title = document.createElement('h2'); title.textContent = 'Crew'; el.appendChild(title);
  for (const member of Object.values(CREW)) {
    const level = econ && typeof econ.crewLevel === 'function' ? econ.crewLevel(member.id) : -1;
    const hired = level >= 0;
    const row = document.createElement('div');
    row.style.cssText = 'border-top:1px solid rgba(255,255,255,0.2);padding:8px 0;';
    row.textContent = member.name + ' — ' + member.role + ' — ' + fmtCash(member.cost) + ' · ' + member.desc + ' ' +
      (hired ? 'Level ' + level + '/3' : 'Not hired');
    row.appendChild(document.createElement('br'));
    if (!hired) {
      row.appendChild(elButton('Hire', !econ || econ.cash < member.cost, () => {
        if (econ && econ.hireCrew(member.id)) renderCrew(ctx);
        else showMessage('Not enough cash.');
      }));
    } else if (level < 3) {
      row.appendChild(elButton('Level up — ' + fmtCash(member.cost), !econ || econ.cash < member.cost, () => {
        if (econ && econ.levelCrew(member.id)) renderCrew(ctx);
        else showMessage('Not enough cash.');
      }));
    } else {
      row.appendChild(elButton('Max level', true, null));
    }
    el.appendChild(row);
  }
  el.appendChild(elButton('Shop', false, () => openOverlay('shop')));
  el.appendChild(elButton('Garage', false, () => openOverlay('garage')));
  el.appendChild(elButton('Close (G)', false, () => closeOverlays()));
}

function renderWeapons(ctx) {
  const el = els.weapons;
  if (!el) return;
  el.innerHTML = '';
  const title = document.createElement('h2'); title.textContent = 'Weapons'; el.appendChild(title);
  const owned = ownedWeapons(ctx);
  const cur = currentWeapon(ctx);
  for (const w of WEAPONS) {
    const isOwned = owned.includes(w.id);
    const row = document.createElement('div');
    row.textContent = w.key + '. ' + w.name + (isOwned ? '' : ' — buy in Shop for ' + fmtCash(w.price)) + (cur === w.id ? ' (equipped)' : '') + ' ';
    row.appendChild(elButton(isOwned ? 'Equip' : 'Locked', !isOwned, () => selectWeapon(ctx, w.id)));
    el.appendChild(row);
  }
  el.appendChild(elButton('Close', false, () => closeOverlays()));
}

function renderCasino(ctx) {
  const el = els.casino;
  if (!el) return;
  el.innerHTML = '';
  const title = document.createElement('h2'); title.textContent = 'Coral Room Casino'; el.appendChild(title);
  const note = document.createElement('p');
  note.textContent = 'Slots, blackjack and roulette — bet your cash.';
  el.appendChild(note);
  const casino = ctx && ctx.casino;
  el.appendChild(elButton('Play Slots', false, () => {
    if (casino && typeof casino.playSlots === 'function') { closeOverlays(); casino.playSlots(); }
    else showMessage('Slots are not ready yet — step inside the casino.');
  }));
  el.appendChild(elButton('Play Blackjack', false, () => {
    if (casino && typeof casino.playBlackjack === 'function') { closeOverlays(); casino.playBlackjack(); }
    else showMessage('Blackjack is not ready yet — step inside the casino.');
  }));
  el.appendChild(elButton('Play Roulette', false, () => {
    if (casino && typeof casino.playRoulette === 'function') { closeOverlays(); casino.playRoulette(); }
    else showMessage('Roulette is not ready yet — step inside the casino.');
  }));
  el.appendChild(elButton('Close', false, () => closeOverlays()));
}

function renderHelp(ctx) {
  const el = els.help;
  if (!el) return;
  el.innerHTML = '';
  const title = document.createElement('h2'); title.textContent = 'Controls — Isla Brasa'; el.appendChild(title);
  const lines = [
    'WASD — move / drive (W accelerate, S brake, A/D steer)',
    'Shift — run',
    'E — enter / exit car',
    'F — interact / talk / pick up',
    'Q (hold) — weapon wheel, then click or press 1–7',
    'Mouse click — attack / shoot',
    'G — shop / garage / crew (garage options near Brasa Garage)',
    'R — start race near a race marker (cycle radio while driving)',
    'M — map overlay',
    'N — mute audio',
    'V — toggle rain',
    'H — this help',
    'Esc — close overlays',
  ];
  const ul = document.createElement('ul');
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  }
  el.appendChild(ul);
  el.appendChild(elButton('Close (H)', false, () => closeOverlays()));
}

// --- Weapon wheel ------------------------------------------------------------
function renderWheel(ctx) {
  const el = els.wheel;
  if (!el) return;
  el.innerHTML = '';
  const owned = ownedWeapons(ctx);
  const cur = currentWeapon(ctx);
  const head = document.createElement('div');
  head.textContent = 'Weapons';
  head.style.cssText = 'font-weight:700;margin-bottom:6px;';
  el.appendChild(head);
  for (const w of WEAPONS) {
    const isOwned = owned.includes(w.id);
    const row = document.createElement('div');
    row.textContent = w.key + '. ' + w.name + (cur === w.id ? ' ★' : '') + (isOwned ? '' : ' (locked)');
    row.style.cssText = 'padding:3px 6px;cursor:' + (isOwned ? 'pointer' : 'default') +
      ';color:' + (cur === w.id ? '#ffd34d' : isOwned ? '#fff' : '#888') + ';';
    if (isOwned) row.addEventListener('click', () => selectWeapon(ctx, w.id));
    el.appendChild(row);
  }
}

function showWeaponWheel(ctx) {
  if (wheelVisible) return;
  wheelVisible = true;
  ensureElements();
  renderWheel(ctx || boundCtx);
  if (els.wheel) els.wheel.style.display = 'block';
}

function hideWeaponWheel() {
  if (!wheelVisible) return;
  wheelVisible = false;
  if (els.wheel) els.wheel.style.display = 'none';
}

function selectWeapon(ctx, weaponId) {
  const c = ctx || boundCtx;
  if (!c) return false;
  if (!ownedWeapons(c).includes(weaponId)) return false;
  if (c.combat && typeof c.combat.selectWeapon === 'function') {
    c.combat.selectWeapon(weaponId);
  } else if (c.state) {
    c.state.currentWeapon = weaponId;
  }
  hideWeaponWheel();
  return true;
}

// --- Toast messages ------------------------------------------------------------
function showMessage(text) {
  ensureElements();
  messageQueue.push(String(text == null ? '' : text));
  if (!els.message || els.message.style.display === 'block') return;
  const next = messageQueue.shift();
  if (next == null) return;
  els.message.textContent = next;
  els.message.style.display = 'block';
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    if (!els.message) return;
    if (messageQueue.length) {
      els.message.textContent = messageQueue.shift();
      messageTimer = setTimeout(() => {
        if (els.message) els.message.style.display = 'none';
        if (messageQueue.length) showMessage(messageQueue.shift());
      }, 3500);
    } else {
      els.message.style.display = 'none';
    }
  }, 3500);
}

function keyIsDown(ctx, code) {
  if (!ctx || !ctx.input) return false;
  const inp = ctx.input;
  if (typeof inp.isDown === 'function') { try { return !!inp.isDown(code); } catch (e) { return false; } }
  if (inp.keys instanceof Set) return inp.keys.has(code);
  if (Array.isArray(inp.keys)) return inp.keys.includes(code);
  if (inp.keys && typeof inp.keys === 'object') return !!inp.keys[code];
  return false;
}

function attachListeners() {
  if (listenersAttached || typeof document === 'undefined') return;
  listenersAttached = true;
  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.repeat) return;
    if (e.code === 'KeyQ') showWeaponWheel(boundCtx);
    else if (e.code === 'KeyG') {
      const anyOpen = OVERLAY_IDS.some((id) => els[id] && els[id].style.display === 'block');
      if (anyOpen) closeOverlays();
      else if (isNearGarage(boundCtx)) openOverlay('garage');
      else openOverlay('shop');
    } else if (e.code === 'KeyH') {
      if (els.help && els.help.style.display === 'block') closeOverlays();
      else openOverlay('help');
    } else if (e.code === 'Escape') { closeOverlays(); hideWeaponWheel(); }
    else if (wheelVisible && /^Digit[1-7]$/.test(e.code)) {
      const w = WEAPONS[Number(e.code.slice(5)) - 1];
      if (w) selectWeapon(boundCtx, w.id);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyQ') hideWeaponWheel();
  });
}

// --- init / update -------------------------------------------------------------
export function init(ctx) {
  boundCtx = ctx || null;
  if (typeof document !== 'undefined') ensureElements();
  attachListeners();

  const api = {
    showMessage(text) { showMessage(text); },
    setMissionTracker(name, stepLabel, distance, timeLeft) {
      if (name && typeof name === 'object') {
        trackerOverride = name;
      } else {
        trackerOverride = { name, stepLabel, distance, timeLeft };
      }
    },
    clearMissionTracker() { trackerOverride = null; },
    updateMinimap() { drawMinimap(boundCtx); },
    openOverlay(id) { openOverlay(id); },
    closeOverlays() { closeOverlays(); },
    toggleShop() {
      const anyOpen = OVERLAY_IDS.some((id) => els[id] && els[id].style.display === 'block');
      if (anyOpen) closeOverlays();
      else if (isNearGarage(boundCtx)) openOverlay('garage');
      else openOverlay('shop');
    },
    showWeaponWheel() { showWeaponWheel(boundCtx); },
    hideWeaponWheel() { hideWeaponWheel(); },
    selectWeapon(id) { return selectWeapon(boundCtx, id); },
    renderShop() { renderShop(boundCtx); },
    renderGarage() { renderGarage(boundCtx); },
    renderCrew() { renderCrew(boundCtx); },
    renderWeapons() { renderWeapons(boundCtx); },
    renderCasino() { renderCasino(boundCtx); },
    renderHelp() { renderHelp(boundCtx); },
    get wheelVisible() { return wheelVisible; },
  };

  if (ctx) ctx.hud = api;
  return api;
}

export function update(dt, ctx) {
  if (typeof document === 'undefined') return;
  ensureElements();
  const c = ctx || boundCtx;
  const s = c && c.state ? c.state : {};

  // Poll ctx.input as a fallback for the Q-hold wheel (own listeners are primary).
  if (keyIsDown(c, 'KeyQ')) showWeaponWheel(c);

  // Cash.
  if (els.cash) {
    const cash = c && c.economy && typeof c.economy.cash === 'number' ? c.economy.cash : (typeof s.cash === 'number' ? s.cash : 0);
    els.cash.textContent = fmtCash(cash);
  }
  // Wanted stars (0–5).
  if (els.wanted) {
    const wanted = Math.max(0, Math.min(5, Math.floor(s.wanted || 0)));
    els.wanted.textContent = '★'.repeat(wanted) + '☆'.repeat(5 - wanted);
    els.wanted.style.color = wanted >= 3 ? '#ff5252' : '#ffd34d';
  }
  // Respect rank + progress to next rank.
  if (els.respect) {
    const respect = Math.max(0, Math.min(TOTAL_RESPECT, Math.floor(s.respect || 0)));
    let rank = 0;
    for (let i = 0; i < RESPECT_THRESHOLDS.length; i++) if (respect >= RESPECT_THRESHOLDS[i]) rank = i;
    const cur = RESPECT_THRESHOLDS[rank];
    const next = rank + 1 < RESPECT_THRESHOLDS.length ? RESPECT_THRESHOLDS[rank + 1] : TOTAL_RESPECT;
    const pct = next > cur ? Math.round(((respect - cur) / (next - cur)) * 100) : 100;
    els.respect.textContent = RESPECT_RANKS[rank] + ' · Respect ' + respect.toLocaleString('en-US') + '/' + TOTAL_RESPECT.toLocaleString('en-US') + ' (' + pct + '%) · Payout +' + (rank * 5) + '%';
  }
  // Mission tracker.
  if (els.mission) {
    const m = getMission(c);
    if (!m) {
      els.mission.textContent = 'No active mission — find work at the Plaza or Garage.';
    } else {
      const name = m.name || m.title || 'Mission';
      const step = m.stepLabel || m.step || m.label || '';
      let dist = '';
      const target = m.target || m.marker || m.destination;
      if (typeof m.distance === 'number') dist = ' · ' + Math.round(m.distance) + 'm';
      else if (target && typeof target.x === 'number') {
        const p = getPlayerPos(c);
        const d = Math.hypot(target.x - p.x, (target.z || 0) - p.z);
        dist = ' · ' + Math.round(d) + 'm';
      }
      let timer = '';
      const tl = m.timeLeft != null ? m.timeLeft : (m.timer != null ? m.timer : m.time);
      if (typeof tl === 'number') {
        const t = Math.max(0, Math.ceil(tl));
        timer = ' · ' + Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
      }
      els.mission.textContent = name + (step ? ' — ' + step : '') + dist + timer;
    }
  }
  // Health bar.
  if (els.healthBar) {
    const health = typeof s.health === 'number' ? s.health : 100;
    const max = typeof s.maxHealth === 'number' ? s.maxHealth : 100;
    const pct = Math.max(0, Math.min(100, (health / max) * 100));
    els.healthBar.style.width = pct + '%';
    els.healthBar.style.background = pct > 50 ? '#48bb78' : pct > 25 ? '#ed8936' : '#e53e3e';
  }
  // Minimap (redraw every frame; cheap 2D canvas).
  drawMinimap(c);
}

export default { init, update, WEAPONS, OUTFITS };
