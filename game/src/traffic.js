// traffic.js — W2 (player + vehicles), ISLA BRASA 3D round-6 rebuild.
// 8 AI traffic cars driving the road grid: they follow right-hand lanes,
// slow down and stop when another car (or the player's car, or the player
// on foot) is ahead in the same lane, and respawn on a fresh road at the
// city edge. Adds life to the roads without any pathfinding.
// init(ctx) / update(dt, ctx). Attaches ctx.traffic = { list }.
// Written fresh from the design spec. No code copied from any other repo.
import * as THREE from 'three';
import * as Config from './config.js';

const COUNT = 8;
const GRID = Config.ROAD_SPACING ?? 40;
const EXTENT = (Config.WORLD_SIZE ?? 400) / 2 - 10;
const LANE_OFFSET = 2.2; // right-hand lanes
const STOP_DIST = 12;
const SLOW_DIST = 22;

const CAR_COLORS = [0xc0392b, 0x2980b9, 0xf39c12, 0x7f8c8d, 0x27ae60, 0x8e44ad, 0xdfe6e9, 0x2d3436];

let ctxRef = null;
const list = [];

function roadLines() {
  if (Array.isArray(Config.ROAD_LINES) && Config.ROAD_LINES.length) {
    return Config.ROAD_LINES;
  }
  const lines = [];
  for (let v = -EXTENT; v <= EXTENT; v += GRID) lines.push(v);
  return lines;
}

function makeTrafficCar(color) {
  const g = new THREE.Group();
  g.name = 'traffic-car';
  const paint = new THREE.MeshLambertMaterial({ color, emissive: 0x000000 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x1a2a3a });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.2), paint);
  body.position.y = 0.55;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 2.0), glass);
  cabin.position.set(0, 1.05, -0.2);
  g.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const wheels = [];
  for (const [x, z] of [[-0.95, 1.35], [0.95, 1.35], [-0.95, -1.35], [0.95, -1.35]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(x, 0.34, z);
    g.add(w);
    wheels.push(w);
  }
  // Headlights so traffic reads at night.
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6c0 });
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 0.08), lightMat);
    h.position.set(x, 0.55, 2.12);
    g.add(h);
  }
  g.userData.isTrafficCar = true;
  g.userData.wheels = wheels;
  return g;
}

function placeOnRoad(car, along) {
  const m = car.mesh;
  if (car.axis === 'x') {
    m.position.set(along, 0, car.road + car.lane);
    m.rotation.y = car.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    m.position.set(car.road + car.lane, 0, along);
    m.rotation.y = car.dir > 0 ? 0 : Math.PI;
  }
}

function spawnCar(i) {
  const lines = roadLines();
  const axis = Math.random() < 0.5 ? 'x' : 'z'; // road runs along this axis
  const road = lines[Math.floor(Math.random() * lines.length)];
  const dir = Math.random() < 0.5 ? 1 : -1;
  const mesh = makeTrafficCar(CAR_COLORS[i % CAR_COLORS.length]);
  const car = {
    mesh,
    axis,
    road,
    dir,
    lane: LANE_OFFSET * dir,
    speed: 7 + Math.random() * 5,
    baseSpeed: 0,
    stopped: false,
  };
  car.baseSpeed = car.speed;
  // Place at a random point along the road.
  placeOnRoad(car, (Math.random() - 0.5) * EXTENT * 2);
  ctxRef.scene.add(mesh);
  return car;
}

function respawn(car) {
  const lines = roadLines();
  car.axis = Math.random() < 0.5 ? 'x' : 'z';
  car.road = lines[Math.floor(Math.random() * lines.length)];
  car.dir = Math.random() < 0.5 ? 1 : -1;
  car.lane = LANE_OFFSET * car.dir;
  car.speed = car.baseSpeed;
  car.stopped = false;
  // Enter from the far edge so the car drives across the city.
  placeOnRoad(car, -car.dir * EXTENT);
}

function forwardOf(car) {
  // Unit forward vector for this car's heading.
  if (car.axis === 'x') return new THREE.Vector3(car.dir, 0, 0);
  return new THREE.Vector3(0, 0, car.dir);
}

// The player's position as a Vector3, whether on foot, in a car or in the plane.
function playerWorldPos(ctx) {
  if (ctx.player) {
    if (ctx.player.mesh && ctx.player.mesh.position) return ctx.player.mesh.position;
    if (ctx.player.pos) return ctx.player.pos;
    if (ctx.player.position) return ctx.player.position;
  }
  if (ctx.cars && ctx.cars.current && ctx.cars.current.pos) return ctx.cars.current.pos;
  return null;
}

export function init(ctx) {
  ctxRef = ctx;
  ctx.state = ctx.state || {};
  for (let i = 0; i < COUNT; i++) list.push(spawnCar(i));
  ctx.traffic = { list };
}

export function update(dt, ctx) {
  const pp = playerWorldPos(ctx);
  for (const car of list) {
    const m = car.mesh;
    const fwd = forwardOf(car);
    let targetSpeed = car.baseSpeed;
    car.stopped = false;

    // Simple stop/avoid: if another traffic car, the player's car, or the
    // player on foot is ahead in the same lane within STOP_DIST, stop;
    // ease off within SLOW_DIST.
    const checkAhead = (pos) => {
      const to = new THREE.Vector3().subVectors(pos, m.position);
      to.y = 0;
      const ahead = to.dot(fwd);
      if (ahead <= 0 || ahead > SLOW_DIST) return 0;
      const side = Math.abs(to.x * fwd.z - to.z * fwd.x);
      return side < 3 ? ahead : 0;
    };
    let nearest = Infinity;
    for (const other of list) {
      if (other === car) continue;
      const d = checkAhead(other.mesh.position);
      if (d > 0 && d < nearest) nearest = d;
    }
    if (pp) {
      const d = checkAhead(new THREE.Vector3(pp.x, 0, pp.z));
      if (d > 0 && d < nearest) nearest = d;
    }
    if (nearest <= STOP_DIST) { targetSpeed = 0; car.stopped = true; }
    else if (nearest <= SLOW_DIST) targetSpeed = car.baseSpeed * 0.4;

    car.speed += (targetSpeed - car.speed) * Math.min(1, dt * 2.5);
    m.position.addScaledVector(fwd, car.speed * dt);

    // Spin the wheels with road speed.
    const wheels = m.userData.wheels || [];
    for (const w of wheels) w.rotation.x += (car.speed / 0.34) * dt;

    // Despawn at the edge, respawn on a fresh random road.
    const along = car.axis === 'x' ? m.position.x : m.position.z;
    if (Math.abs(along) > EXTENT + 15) respawn(car);
  }
}
