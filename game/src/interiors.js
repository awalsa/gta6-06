// interiors.js — Enterable interiors for ISLA BRASA 3D (round 6, worker W6).
//
// Three enterable places: the Brasa Garage, the Coral Room Casino and the
// Vela Safehouse (at the Motel Vela landmark). Press F at a glowing green
// door outside a building to step inside: the screen fades and the player
// is moved into a small interior room built far outside the city (x ~ 1000)
// so it can never collide with the street map. F at the glowing exit door
// walks back out to the exact spot the player entered from.
//   - Garage: workbench, tool shelf, tyres, lift pad. F inside reports how
//     many cars the player owns (buying happens outside, with G).
//   - Casino: slot machines, a card table and a bar. F at the card table
//     opens the casino games via ctx.casino.open().
//   - Safehouse: bed, table, TV, wardrobe. F at the bed sleeps: one day
//     passes (owned properties pay their daily income — the properties
//     module pays out whenever state.day increments) and the game saves.
//
// Three.js ES module. Exports init(ctx) and update(dt, ctx).
// ctx = { scene, camera, renderer, state, input, config }.

import * as THREE from 'three';
import { LANDMARKS } from './config.js';

// Landmark keys in config.js for each interior's door.
const LM = {
  garage: 'brasaGarage',
  casino: 'coralCasino',
  safehouse: 'motelVela',
};

// Fallbacks used only if config.js has no landmark for a door.
const FALLBACK = {
  garage: { x: 80, z: -40 },
  casino: { x: 120, z: 120 },
  safehouse: { x: -40, z: 40 },
};

function lmPos(name) {
  const key = LM[name] || name;
  const src = (LANDMARKS && LANDMARKS[key]) || FALLBACK[name] || { x: 0, z: 0 };
  if (Array.isArray(src)) return new THREE.Vector3(src[0], 0, src[1]);
  if (src && src.position) return new THREE.Vector3(src.position.x || 0, 0, src.position.z || 0);
  if (src && typeof src.x === 'number') return new THREE.Vector3(src.x, 0, src.z || 0);
  return new THREE.Vector3(0, 0, 0);
}

function keyDown(ctx, code) {
  const inp = (ctx && ctx.input) || {};
  if (typeof inp.isDown === 'function') return !!inp.isDown(code);
  if (inp.keys instanceof Set) return inp.keys.has(code);
  if (Array.isArray(inp.keys)) return inp.keys.includes(code);
  if (inp.keys) return !!inp.keys[code];
  if (typeof inp[code] === 'boolean') return inp[code];
  return false;
}

// The player's position, from whichever representation the player module
// keeps. state.playerPos is an ARRAY [x, y, z] (see state.js).
function playerPos(ctx) {
  if (ctx.player) {
    if (ctx.player.position && typeof ctx.player.position.x === 'number') return ctx.player.position;
    if (ctx.player.mesh && ctx.player.mesh.position) return ctx.player.mesh.position;
    if (typeof ctx.player.getPosition === 'function') {
      const p = ctx.player.getPosition();
      if (p) return p;
    }
  }
  if (ctx.state && Array.isArray(ctx.state.playerPos)) {
    return new THREE.Vector3(ctx.state.playerPos[0] || 0, ctx.state.playerPos[1] || 0, ctx.state.playerPos[2] || 0);
  }
  if (ctx.state && ctx.state.playerPos && typeof ctx.state.playerPos.x === 'number') return ctx.state.playerPos;
  if (ctx.camera) return ctx.camera.position;
  return new THREE.Vector3(0, 0, 0);
}

// Move the player: write EVERY representation so the player module and the
// follow camera (which reads state.playerPos) agree on the new spot.
function setPlayerPos(ctx, v) {
  if (ctx.player) {
    if (ctx.player.position && typeof ctx.player.position.copy === 'function') ctx.player.position.copy(v);
    if (ctx.player.mesh && ctx.player.mesh.position && typeof ctx.player.mesh.position.copy === 'function') ctx.player.mesh.position.copy(v);
    if (typeof ctx.player.setPosition === 'function') {
      try { ctx.player.setPosition(v); } catch (e) { /* ignore */ }
    }
  }
  if (ctx.state && Array.isArray(ctx.state.playerPos)) {
    ctx.state.playerPos[0] = v.x;
    ctx.state.playerPos[1] = v.y;
    ctx.state.playerPos[2] = v.z;
  } else if (ctx.state && ctx.state.playerPos && typeof ctx.state.playerPos.copy === 'function') {
    ctx.state.playerPos.copy(v);
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
  console.log('[interiors]', msg);
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

// Interior rooms live far outside the city so they never collide with it.
const ROOMS = {
  garage: { center: new THREE.Vector3(1000, 0, 1000), wall: 0x3a3f4a, floor: 0x555a66, label: 'Brasa Garage' },
  casino: { center: new THREE.Vector3(1060, 0, 1000), wall: 0x4a1030, floor: 0x2a0a1a, label: 'Coral Room' },
  safehouse: { center: new THREE.Vector3(1120, 0, 1000), wall: 0x2a3a4a, floor: 0x6b4a2a, label: 'Safehouse' },
};

function box(w, h, d, color, x, y, z, emissive) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: emissive || 0x000000,
    emissiveIntensity: emissive ? 0.6 : 0,
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function buildRoom(ctx, place) {
  const room = ROOMS[place];
  const g = new THREE.Group();
  g.position.copy(room.center);

  // Floor + 4 walls (no ceiling, so the scene light reaches in).
  g.add(box(14, 0.3, 11, room.floor, 0, -0.15, 0));
  g.add(box(14, 4, 0.4, room.wall, 0, 2, -5.5));
  g.add(box(14, 4, 0.4, room.wall, 0, 2, 5.5));
  g.add(box(0.4, 4, 11, room.wall, -7, 2, 0));
  g.add(box(0.4, 4, 11, room.wall, 7, 2, 0));

  // Warm ceiling lamp.
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
  );
  lamp.position.set(0, 3.6, 0);
  g.add(lamp);
  const light = new THREE.PointLight(0xffe9a8, 60, 18);
  light.position.set(0, 3.4, 0);
  g.add(light);

  // Exit door: glowing green panel on the south wall.
  const door = box(1.6, 2.6, 0.2, 0x2ecc71, 0, 1.3, 5.3, 0x2ecc71);
  door.name = 'exitDoor';
  g.add(door);

  if (place === 'garage') {
    // Workbench, tool shelf, tyres, a car lift pad, an oil drum.
    g.add(box(3.5, 0.9, 1.2, 0x8b5a2b, -4.5, 0.45, -4.2));
    g.add(box(2.5, 2.2, 0.6, 0x5a5a5a, 4.5, 1.1, -4.8));
    for (let i = 0; i < 3; i++) {
      const tire = new THREE.Mesh(
        new THREE.TorusGeometry(0.45, 0.2, 8, 16),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
      );
      tire.position.set(5.5 - i * 1.1, 0.45, 3.5);
      tire.rotation.y = Math.PI / 2;
      g.add(tire);
    }
    g.add(box(4, 0.25, 2, 0xd4af37, 0, 0.12, -1)); // lift pad
    g.add(box(0.8, 1.6, 0.8, 0xe74c3c, -5.5, 0.8, 2)); // oil drum
  } else if (place === 'casino') {
    // Slot machines along the north wall, card table, bar counter, chips.
    for (let i = -1; i <= 1; i++) {
      const slot = box(1.1, 1.9, 0.7, 0xd4af37, i * 2.2, 0.95, -4.6, 0xd4af37);
      slot.name = 'slotMachine';
      g.add(slot);
    }
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 0.25, 12),
      new THREE.MeshStandardMaterial({ color: 0x0a6b2a })
    );
    table.position.set(0, 0.8, -1);
    table.name = 'cardTable';
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.5, 0.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1a })
    );
    leg.position.set(0, 0.4, -1);
    g.add(table, leg);
    g.add(box(4, 1.1, 1, 0x6b2a1a, -4.5, 0.55, 3.5)); // bar
    const chipColors = [0xff3366, 0x2ecc71, 0x3498db, 0xffc300];
    for (let i = 0; i < 4; i++) {
      const chip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, 0.08, 12),
        new THREE.MeshStandardMaterial({ color: chipColors[i] })
      );
      chip.position.set(-0.8 + i * 0.5, 0.97, -1);
      g.add(chip);
    }
  } else {
    // Safehouse: bed (with pillow + blanket), table, TV, wardrobe, crate.
    const bed = box(2.2, 0.5, 4, 0x7a4a6b, -4.5, 0.25, -3);
    bed.name = 'bed';
    g.add(bed);
    g.add(box(1.8, 0.25, 0.8, 0xf5f5f5, -4.5, 0.6, -4.6)); // pillow
    g.add(box(2.0, 0.12, 2.4, 0x2e86c1, -4.5, 0.55, -2.2)); // blanket
    g.add(box(2, 0.8, 1.2, 0x8b5a2b, 3.5, 0.4, -4.2)); // table
    g.add(box(2.2, 1.3, 0.15, 0x111111, 3.5, 1.8, -5.2, 0x224466)); // TV
    g.add(box(2, 2.4, 0.8, 0x5a3a2a, 5.5, 1.2, 2.5)); // wardrobe
    g.add(box(1.2, 0.8, 1.2, 0x2ecc71, -5.5, 0.4, 3.5)); // crate
  }

  ctx.scene.add(g);
  return g;
}

function fadeTo(opacity, ms, done) {
  if (typeof document === 'undefined') { if (done) done(); return; }
  let el = document.getElementById('interior-fade');
  if (!el) {
    el = document.createElement('div');
    el.id = 'interior-fade';
    el.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .3s;z-index:10001;';
    document.body.appendChild(el);
  }
  el.style.transition = 'opacity ' + (ms / 1000) + 's';
  el.style.opacity = String(opacity);
  setTimeout(() => { if (done) done(); }, ms + 30);
}

let S = null;

export function init(ctx) {
  S = {
    ctx,
    inside: null,
    returnPos: null,
    rooms: {},
    doors: {
      // Doors sit just OUTSIDE each building's footprint: the world pushes
      // the player out of building AABBs, so a door at the landmark centre
      // (or an offset still inside the footprint) could never be reached.
      garage: lmPos('garage').add(new THREE.Vector3(0, 0, 11)),
      casino: lmPos('casino').add(new THREE.Vector3(-14, 0, 0)),
      safehouse: lmPos('safehouse').add(new THREE.Vector3(0, 0, 8)),
    },
    prevF: false,
    transitioning: false,
  };

  if (ctx.scene) {
    for (const place of Object.keys(ROOMS)) {
      S.rooms[place] = buildRoom(ctx, place);
    }
    // Door markers in the world: glowing green doorway panels + floor rings.
    for (const [place, pos] of Object.entries(S.doors)) {
      const marker = box(1.6, 2.6, 0.2, 0x2ecc71, pos.x, 1.3, pos.z, 0x2ecc71);
      ctx.scene.add(marker);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.2, 1.7, 24),
        new THREE.MeshBasicMaterial({ color: 0x2ecc71, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.15, pos.z);
      ctx.scene.add(ring);
    }
  }

  const api = {
    get inside() { return S.inside; },
    enter(place) { return enter(ctx, place); },
    exit() { return exitInterior(ctx); },
  };
  ctx.interiors = api;
  return api;
}

function enter(ctx, place) {
  if (!S || !ROOMS[place] || S.inside || S.transitioning) return false;
  if (ctx.plane && ctx.plane.inPlane) return false;
  S.transitioning = true;
  S.returnPos = playerPos(ctx).clone();
  fadeTo(1, 300, () => {
    S.inside = place;
    const room = ROOMS[place];
    setPlayerPos(ctx, room.center.clone().add(new THREE.Vector3(0, 0, 3)));
    if (ctx.state) ctx.state.insideInterior = place;
    fadeTo(0, 300, () => { S.transitioning = false; });
    let hint = 'You enter the ' + room.label + '.';
    if (place === 'safehouse') hint += ' Press F at the bed to sleep & save.';
    if (place === 'casino') hint += ' Press F at the card table to play.';
    toast(ctx, hint);
  });
  return true;
}

function exitInterior(ctx) {
  if (!S || !S.inside || S.transitioning) return false;
  const place = S.inside;
  S.transitioning = true;
  fadeTo(1, 300, () => {
    S.inside = null;
    if (S.returnPos) setPlayerPos(ctx, S.returnPos);
    if (ctx.state) ctx.state.insideInterior = null;
    fadeTo(0, 300, () => { S.transitioning = false; });
    toast(ctx, 'You leave the ' + ROOMS[place].label + '.');
  });
  return true;
}

function saveNow(ctx) {
  // main.js attaches the real save as ctx.saveGame (and ctx.save).
  if (typeof ctx.saveGame === 'function') { try { ctx.saveGame(); return true; } catch (e) { /* fall through */ } }
  if (typeof ctx.save === 'function') { try { ctx.save(); return true; } catch (e) { /* fall through */ } }
  if (ctx.state && typeof ctx.state.saveGame === 'function') { try { ctx.state.saveGame(); return true; } catch (e) { /* fall through */ } }
  return false;
}

function sleep(ctx) {
  // A new day begins: increment the day counter (the properties module pays
  // daily income whenever state.day goes up) and save the game.
  if (ctx.state && typeof ctx.state.day === 'number') ctx.state.day += 1;
  const saved = saveNow(ctx);
  if (saved) {
    const day = ctx.state && typeof ctx.state.day === 'number' ? ctx.state.day : '?';
    toast(ctx, 'You sleep… game saved. A new day begins (Day ' + day + ').');
  } else {
    toast(ctx, 'You sleep… but no save function is available (ctx.saveGame missing).');
  }
}

function countGarageCars(ctx) {
  const st = ctx.state || {};
  if (Array.isArray(st.carsOwned)) return st.carsOwned.length;
  if (Array.isArray(st.garageOwned)) return st.garageOwned.length;
  if (st.garage && st.garage.owned && typeof st.garage.owned === 'object') return Object.keys(st.garage.owned).length;
  return 0;
}

export function update(dt, ctx) {
  if (!S || S.transitioning) return;
  const p = playerPos(ctx);
  const fDown = keyDown(ctx, 'KeyF');
  const fPressed = fDown && !S.prevF;
  S.prevF = fDown;

  const overlayOpen = ctx.state && ctx.state.uiOpen;
  const inPlane = ctx.plane && ctx.plane.inPlane;

  if (!S.inside) {
    // Outside: F at a door enters that interior.
    if (fPressed && !overlayOpen && !inPlane) {
      for (const [place, doorPos] of Object.entries(S.doors)) {
        if (p.distanceTo(doorPos) < 4) { enter(ctx, place); return; }
      }
    }
    if (!overlayOpen && !inPlane) {
      for (const [place, doorPos] of Object.entries(S.doors)) {
        if (p.distanceTo(doorPos) < 4) {
          setPrompt('Press F — Enter the ' + ROOMS[place].label);
          return;
        }
      }
    }
    setPrompt('');
    return;
  }

  // Inside an interior.
  const room = ROOMS[S.inside];
  const exitPos = room.center.clone().add(new THREE.Vector3(0, 0, 5));
  const bedPos = room.center.clone().add(new THREE.Vector3(-4.5, 0, -3));
  const tablePos = room.center.clone().add(new THREE.Vector3(0, 0, -1));

  if (fPressed && !overlayOpen) {
    if (p.distanceTo(exitPos) < 3.5) { exitInterior(ctx); return; }
    if (S.inside === 'safehouse' && p.distanceTo(bedPos) < 3.5) { sleep(ctx); return; }
    if (S.inside === 'casino' && p.distanceTo(tablePos) < 3.5) {
      if (ctx.casino && typeof ctx.casino.open === 'function') ctx.casino.open();
      else toast(ctx, 'The casino games are not loaded (ctx.casino missing).');
      return;
    }
    if (S.inside === 'garage') {
      toast(ctx, 'Your garage holds ' + countGarageCars(ctx) + ' car(s). Buy more outside with G.');
      return;
    }
  }

  // Contextual prompt while inside.
  let prompt = '';
  if (!overlayOpen) {
    if (p.distanceTo(exitPos) < 3.5) prompt = 'Press F — Leave the ' + room.label;
    else if (S.inside === 'safehouse' && p.distanceTo(bedPos) < 3.5) prompt = 'Press F — Sleep & save the game';
    else if (S.inside === 'casino' && p.distanceTo(tablePos) < 3.5) prompt = 'Press F — Play slots, blackjack & roulette';
  }
  setPrompt(prompt);
}

export default { init, update };
