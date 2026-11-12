// World layout: terrain shape, the road, and every obstacle with its collision
// volume. Pure maths (no rendering) so the flight model can be tested against
// it in Node. The renderer draws whatever is listed in `parts`, `trees`,
// `rocks`, `road`, `turbines` and `balloons`, so looks and collisions always
// agree.

export const WORLD_SIZE = 1600;      // flyable area
export const TERRAIN_SIZE = 2800;    // drawn terrain reaches further, into the haze
export const WATER_LEVEL = -3.5;
export const ROAD_HALF_WIDTH = 3.5;

const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// Deterministic pseudo-random numbers so the world is the same every run.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(ix, iz) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  return mix(mix(hash(ix, iz), hash(ix + 1, iz), u), mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v) * 2 - 1;
}

export function fbm(x, z, octaves) {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x, z);
    x = x * 2.03 + 17.1;
    z = z * 2.03 - 9.7;
    amp *= 0.5;
  }
  return sum;
}

// --- Terrain shape ---------------------------------------------------------

const LAKE = { x: 240, z: 150, rx: 80, rz: 175 };

// 0 outside the lake basin, 1 well inside it.
function lakeAmount(x, z) {
  const e = ((x - LAKE.x) / LAKE.rx) ** 2 + ((z - LAKE.z) / LAKE.rz) ** 2;
  return 1 - smooth(0.45, 1.5, e);
}

// Flat take-off field around the origin, hills further out.
const fieldMask = (x, z) => smooth(45, 190, Math.hypot(x, z));

// Broad shape only: used for the road's own height so it stays smooth.
function broadHeight(x, z) {
  const hills = 11 * Math.sin(x * 0.009 + 0.4) * Math.cos(z * 0.011) + 18 * fbm(x / 320, z / 320, 2) + 12;
  return mix(hills, -10, lakeAmount(x, z)) * fieldMask(x, z);
}

function naturalHeight(x, z) {
  const detail = 6 * fbm(x / 70, z / 70, 3) + 0.6 * fbm(x / 9, z / 9, 2);
  return broadHeight(x, z) + detail * fieldMask(x, z) * (1 - lakeAmount(x, z));
}

// --- Road ------------------------------------------------------------------

const ROAD_POINTS = [
  [-1700, 350], [-1300, 330], [-860, 310], [-600, 290], [-400, 262], [-100, 232], [120, 206], [360, 200], [560, 156], [860, 170], [1300, 150], [1700, 160],
];
const ROAD_GROUND = WATER_LEVEL + 2.2;     // lowest the road ever sits on land
const BRIDGE_BELOW = WATER_LEVEL + 2.0;    // natural ground lower than this gets a bridge

function buildRoad() {
  const samples = [];
  const P = ROAD_POINTS;
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const steps = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 4);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const cr = (a, b, c, d) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
      const x = cr(p0[0], p1[0], p2[0], p3[0]);
      if (Math.abs(x) < TERRAIN_SIZE / 2 - 4) samples.push({ x, z: cr(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  let s = 0;
  samples.forEach((p, i) => {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    p.tx = (b.x - a.x) / len;
    p.tz = (b.z - a.z) / len;
    if (i > 0) s += Math.hypot(p.x - samples[i - 1].x, p.z - samples[i - 1].z);
    p.s = s;
    p.broad = broadHeight(p.x, p.z);
    p.bridge = p.broad < BRIDGE_BELOW;
  });
  return samples;
}

const ROAD = buildRoad();
const ROAD_Z_MIN = Math.min(...ROAD.map((p) => p.z)) - 40;
const ROAD_Z_MAX = Math.max(...ROAD.map((p) => p.z)) + 40;

// Distance to the road centre line and the road's ground height there.
function nearestRoad(x, z) {
  if (z < ROAD_Z_MIN || z > ROAD_Z_MAX) return null;
  let best = 1e9;
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < ROAD.length - 1; i++) {
    const a = ROAD[i];
    const b = ROAD[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best) { best = d; bx = px; bz = pz; }
  }
  return { d: Math.sqrt(best), x: bx, z: bz };
}

function landHeight(x, z) {
  const natural = naturalHeight(x, z);
  const near = nearestRoad(x, z);
  if (!near || near.d > 34) return natural;
  // Level the ground under the road, except where it crosses water on a bridge.
  const broad = broadHeight(near.x, near.z);
  const w = (1 - smooth(9, 34, near.d)) * smooth(WATER_LEVEL + 0.3, BRIDGE_BELOW, broad);
  return mix(natural, Math.max(broad, ROAD_GROUND), w);
}

// --- Collision helpers -----------------------------------------------------

const CELL = 16;
const cellKey = (cx, cz) => (cx + 512) * 1024 + (cz + 512);
const cellOf = (v) => Math.floor(v / CELL);

function segmentDistance(px, py, pz, s) {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const dz = s.bz - s.az;
  const t = Math.max(0, Math.min(1,
    ((px - s.ax) * dx + (py - s.ay) * dy + (pz - s.az) * dz) / (dx * dx + dy * dy + dz * dz)));
  return Math.hypot(px - s.ax - dx * t, py - s.ay - dy * t, pz - s.az - dz * t);
}

function hitsShape(o, x, y, z, r) {
  if (o.t === 'box') {
    if (y < o.y0 - r || y > o.y1 + r) return false;
    const dx = x - o.x;
    const dz = z - o.z;
    return Math.abs(dx * o.c - dz * o.s) < o.hw + r && Math.abs(dx * o.s + dz * o.c) < o.hd + r;
  }
  if (o.t === 'cyl') {
    return y > o.y0 - r && y < o.y1 + r && Math.hypot(x - o.x, z - o.z) < o.r + r;
  }
  if (o.t === 'seg') return segmentDistance(x, y, z, o) < o.r + r;
  return Math.hypot(x - o.x, y - o.y, z - o.z) < o.r + r;   // sphere
}

// --- Moving obstacles ------------------------------------------------------

const TURBINE_HUB = 58;
const TURBINE_BLADE = 27;
export const TURBINE_FRONT = 3.5;   // rotor sits this far in front of the tower

export function turbineAngle(turbine, time) { return turbine.phase + time * turbine.speed; }

export function balloonPosition(b, time) {
  const a = b.phase + time * b.speed;
  return { x: b.cx + Math.cos(a) * b.orbit, y: b.alt + 5 * Math.sin(time * 0.11 + b.phase), z: b.cz + Math.sin(a) * b.orbit };
}

// --- The world -------------------------------------------------------------

export class Terrain {
  constructor() {
    this.limit = WORLD_SIZE / 2 - 60;
    this.time = 0;            // set by the game each step; drives moving obstacles
    this.parts = [];          // things to draw: boxes, cylinders, roofs, spheres, lines
    this.shapes = [];         // static collision volumes
    this.grid = new Map();
    this.keepClear = [];      // circles where no trees or rocks may grow
    this.trees = [];
    this.treeGrid = new Map();
    this.rocks = [];
    this.turbines = [];
    this.balloons = [];
    this.road = ROAD;
    this.rand = mulberry32(7);

    this.#field();
    this.#bridge();
    this.#village();
    this.#farm();
    this.#constructionSite();
    this.#powerLine();
    this.#mast();
    this.#trainingYard();
    this.#windFarm();
    this.#balloons();
    this.#rocks();
    this.#trees();
  }

  landHeight(x, z) { return landHeight(x, z); }
  groundHeight(x, z) { return Math.max(landHeight(x, z), WATER_LEVEL); }
  isWater(x, z) { return landHeight(x, z) < WATER_LEVEL; }
  roadDistance(x, z) { const n = nearestRoad(x, z); return n ? n.d : Infinity; }

  // ----- building blocks -----

  #shape(o, minX, maxX, minZ, maxZ) {
    this.shapes.push(o);
    for (let cx = cellOf(minX - 1); cx <= cellOf(maxX + 1); cx++) {
      for (let cz = cellOf(minZ - 1); cz <= cellOf(maxZ + 1); cz++) {
        const key = cellKey(cx, cz);
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(o);
      }
    }
  }

  // Box standing on y0. w runs along its own X axis, d along its Z axis; yaw
  // turns it about the vertical. `solid: false` draws it without collision.
  #box({ x, z, y0, h, w, d, yaw = 0, tilt = 0, mat, color, solid = true }) {
    this.parts.push({ kind: 'box', x, y: y0 + h / 2, z, w, h, d, yaw, tilt, mat, color });
    if (!solid) return;
    const reach = Math.hypot(w, d) / 2;
    this.#shape({ t: 'box', x, z, y0, y1: y0 + h, hw: w / 2, hd: d / 2, c: Math.cos(yaw), s: Math.sin(yaw) },
      x - reach, x + reach, z - reach, z + reach);
  }

  #cylinder({ x, z, y0, h, r, rTop = r, mat, color, sides = 12, solid = true, hitRadius = Math.max(r, rTop) }) {
    this.parts.push({ kind: 'cyl', x, y: y0 + h / 2, z, h, r, rTop, sides, mat, color });
    if (solid) this.#shape({ t: 'cyl', x, z, r: hitRadius, y0, y1: y0 + h }, x - hitRadius, x + hitRadius, z - hitRadius, z + hitRadius);
  }

  #sphere({ x, y, z, r, mat, color, solid = true }) {
    this.parts.push({ kind: 'sphere', x, y, z, r, mat, color });
    if (solid) this.#shape({ t: 'sph', x, y, z, r }, x - r, x + r, z - r, z + r);
  }

  // Thin cable through a list of [x, y, z] points.
  #cable(points, radius = 0.08) {
    this.parts.push({ kind: 'line', points });
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay, az] = points[i];
      const [bx, by, bz] = points[i + 1];
      this.#shape({ t: 'seg', ax, ay, az, bx, by, bz, r: radius },
        Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz));
    }
  }

  // House with a pitched roof; the ridge runs along its X axis.
  #house({ x, z, w, d, wallH, roofH, yaw, mat, color, roofColor }) {
    const base = this.landHeight(x, z);
    this.#box({ x, z, y0: base - 3, h: wallH + 3, w, d, yaw, mat, color });
    this.parts.push({ kind: 'roof', x, y: base + wallH, z, w: w + 0.8, d: d + 0.8, h: roofH, yaw, mat: 'roof', color: roofColor });
    const reach = Math.hypot(w, d) / 2;
    this.#shape({ t: 'box', x, z, y0: base + wallH, y1: base + wallH + roofH * 0.9, hw: w / 2, hd: d / 4, c: Math.cos(yaw), s: Math.sin(yaw) },
      x - reach, x + reach, z - reach, z + reach);
    this.keepClear.push({ x, z, r: reach + 3 });
    return base;
  }

  // ----- features -----

  #field() {
    this.keepClear.push({ x: 0, z: 0, r: 38 });
    // Parked van and a windsock next to the take-off pad.
    const g = (x, z) => this.landHeight(x, z);
    this.#box({ x: 11, z: 9, y0: g(11, 9) + 0.35, h: 1.7, w: 4.8, d: 2, yaw: 0.5, mat: 'paint', color: 0xe8e8e8 });
    this.#box({ x: 11, z: 9, y0: g(11, 9), h: 0.5, w: 4.2, d: 1.9, yaw: 0.5, mat: 'dark', solid: false });
    this.#cylinder({ x: -10, z: 7, y0: g(-10, 7), h: 5, r: 0.06, mat: 'steel', hitRadius: 0.12 });
    this.parts.push({ kind: 'windsock', x: -10, y: g(-10, 7) + 4.8, z: 7 });
  }

  #bridge() {
    const road = this.road;
    for (let i = 0; i < road.length; i++) {
      if (!road[i].bridge) continue;
      let end = i;
      while (end + 1 < road.length && road[end + 1].bridge) end++;
      const start = Math.max(0, i - 1);
      const stop = Math.min(road.length - 1, end + 1);
      // Humped deck so there is room to fly underneath.
      for (let k = start; k <= stop; k++) {
        const u = (k - start) / (stop - start);
        road[k].deck = ROAD_GROUND + 0.2 + 4.5 * Math.sin(Math.PI * u);
      }
      for (let k = start; k < stop; k++) {
        const a = road[k];
        const b = road[k + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
        const tilt = Math.atan2(b.deck - a.deck, len);
        const x = (a.x + b.x) / 2;
        const z = (a.z + b.z) / 2;
        const y = (a.deck + b.deck) / 2;
        this.#box({ x, z, y0: y - 0.6, h: 0.6, w: len + 0.4, d: 8.4, yaw, tilt, mat: 'concrete' });
        for (const side of [-1, 1]) {
          this.#box({ x: x - a.tz * side * 4, z: z + a.tx * side * 4, y0: y, h: 1, w: len + 0.4, d: 0.2, yaw, tilt, mat: 'steel' });
        }
        if ((k - start) % 6 === 3) {
          const bed = this.landHeight(x, z);
          this.#cylinder({ x, z, y0: bed - 1, h: y - 0.6 - bed + 1, r: 0.8, mat: 'concrete' });
        }
      }
      i = end;
    }
  }

  #village() {
    const rand = this.rand;
    const wallColors = [0xf2ead8, 0xe6d3b3, 0xd9c7a8, 0xf5f0e6, 0xc9b79c, 0xe0b8a0];
    const roofColors = [0x8a3b2c, 0x6b4a3a, 0x4d4f55, 0x9c4a32];
    const along = (from, to, step) => {
      const out = [];
      let next = -Infinity;
      for (const p of this.road) {
        if (p.x < from || p.x > to || p.s < next) continue;
        out.push(p);
        next = p.s + step;
      }
      return out;
    };
    const yawOf = (p) => Math.atan2(-p.tz, p.tx);
    const offset = (p, side, dist) => ({ x: p.x - p.tz * side * dist, z: p.z + p.tx * side * dist });

    // Church with a tower and spire on the south side of the road.
    const cp = along(-235, -200, 1000)[0];
    const c = offset(cp, 1, 34);
    const cyaw = yawOf(cp);
    const cbase = this.#house({ ...c, w: 18, d: 9, wallH: 7, roofH: 4.5, yaw: cyaw, mat: 'church', color: 0xe9e4d8, roofColor: 0x4d4f55 });
    const t = { x: c.x - Math.cos(cyaw) * 11, z: c.z + Math.sin(cyaw) * 11 };
    this.#box({ ...t, y0: cbase - 3, h: 21, w: 5, d: 5, yaw: cyaw, mat: 'plaster', color: 0xe9e4d8 });
    this.#cylinder({ ...t, y0: cbase + 18, h: 10, r: 3.6, rTop: 0, sides: 4, mat: 'roof', color: 0x4d4f55, hitRadius: 1.7 });
    this.keepClear.push({ x: t.x, z: t.z, r: 9 });

    // Houses on both sides.
    for (const p of along(-395, -70, 27)) {
      for (const side of [-1, 1]) {
        if (rand() < 0.15) continue;
        const pos = offset(p, side, 17 + rand() * 7);
        const w = 9 + rand() * 5;
        const d = 7 + rand() * 2.5;
        if (this.landHeight(pos.x, pos.z) < WATER_LEVEL + 1.5) continue;
        if (this.hitsObstacle(pos.x, this.landHeight(pos.x, pos.z) + 1, pos.z, 11)) continue;
        const tall = rand() < 0.4;
        this.#house({
          ...pos, w, d, wallH: tall ? 5.8 : 3.2, roofH: 2.4 + rand() * 1.4, yaw: yawOf(p) + (rand() - 0.5) * 0.12,
          mat: tall ? 'house2' : 'house1',
          color: wallColors[Math.floor(rand() * wallColors.length)],
          roofColor: roofColors[Math.floor(rand() * roofColors.length)],
        });
      }
    }

    // Street lamps, alternating sides.
    along(-400, -60, 32).forEach((p, i) => {
      const side = i % 2 ? 1 : -1;
      const pos = offset(p, side, 5.2);
      const base = this.landHeight(pos.x, pos.z);
      this.#cylinder({ ...pos, y0: base, h: 6.5, r: 0.09, mat: 'steel', hitRadius: 0.15 });
      const head = offset(p, side, 4.1);
      this.#box({ ...head, y0: base + 6.4, h: 0.15, w: 0.4, d: 2.4, yaw: yawOf(p), mat: 'lamp', solid: false });
    });
  }

  #farm() {
    const x = 215;
    const z = -165;
    this.#house({ x, z, w: 22, d: 12, wallH: 6, roofH: 5, yaw: 0.35, mat: 'barn', color: 0x9b3a2e, roofColor: 0x55585e });
    for (const [sx, sz] of [[243, -178], [246, -168]]) {
      const base = this.landHeight(sx, sz);
      this.#cylinder({ x: sx, z: sz, y0: base - 2, h: 16, r: 3, mat: 'metal', sides: 20 });
      this.#sphere({ x: sx, y: base + 14, z: sz, r: 3, mat: 'metal' });
      this.keepClear.push({ x: sx, z: sz, r: 7 });
    }
    // Paddock fence.
    const posts = [[190, -140], [190, -110], [225, -105], [250, -125]];
    posts.forEach(([px, pz], i) => {
      const [nx, nz] = posts[(i + 1) % posts.length];
      const len = Math.hypot(nx - px, nz - pz);
      const mx = (px + nx) / 2;
      const mz = (pz + nz) / 2;
      this.#box({ x: mx, z: mz, y0: this.landHeight(mx, mz) + 0.5, h: 0.9, w: len, d: 0.12, yaw: Math.atan2(-(nz - pz), nx - px), mat: 'wood' });
    });
    this.keepClear.push({ x: 220, z: -125, r: 30 });
  }

  #constructionSite() {
    const x = -330;
    const z = 185;
    const base = this.landHeight(x, z);
    this.keepClear.push({ x, z, r: 34 });
    // Unfinished concrete frame.
    for (let floor = 0; floor < 3; floor++) {
      this.#box({ x: x - 16, z, y0: base + 4 * floor + 3.6, h: 0.4, w: 16, d: 11, mat: 'concrete' });
      for (const [cx, cz] of [[-7.5, -5], [7.5, -5], [-7.5, 5], [7.5, 5], [0, -5], [0, 5]]) {
        this.#box({ x: x - 16 + cx, z: z + cz, y0: base + 4 * floor - (floor ? 0 : 3), h: floor ? 3.6 : 6.6, w: 0.5, d: 0.5, mat: 'concrete' });
      }
    }
    // Tower crane: mast, jib, counterweight and a hanging hook.
    const top = base + 38;
    this.#box({ x, z, y0: base - 2, h: 42, w: 1.8, d: 1.8, mat: 'crane' });
    const dir = { x: -0.92, z: -0.39 };
    const yaw = Math.atan2(-dir.z, dir.x);
    this.#box({ x: x + dir.x * 13, z: z + dir.z * 13, y0: top, h: 1.2, w: 46, d: 1.2, yaw, mat: 'crane' });
    this.#box({ x: x - dir.x * 8, z: z - dir.z * 8, y0: top - 2.2, h: 2.2, w: 3.5, d: 2, yaw, mat: 'concrete' });
    const hx = x + dir.x * 27;
    const hz = z + dir.z * 27;
    this.#cable([[hx, top, hz], [hx, top - 17, hz]], 0.12);
    this.#box({ x: hx, z: hz, y0: top - 18.2, h: 1.2, w: 0.8, d: 0.8, mat: 'crane' });
  }

  #powerLine() {
    const a = { x: -275, z: -735 };
    const b = { x: -205, z: 735 };
    const count = 14;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const px = -(b.z - a.z) / len;      // across the line
    const pz = (b.x - a.x) / len;
    const yaw = Math.atan2(-pz, px);
    const arms = [{ y: 23, half: 6.5 }, { y: 28, half: 4 }];
    const pylons = [];
    for (let i = 0; i < count; i++) {
      const x = mix(a.x, b.x, i / (count - 1));
      const z = mix(a.z, b.z, i / (count - 1));
      const base = this.landHeight(x, z);
      pylons.push({ x, z, base });
      this.keepClear.push({ x, z, r: 6 });
      this.#cylinder({ x, z, y0: base - 2, h: 34, r: 2.2, rTop: 0.35, sides: 4, mat: 'pylon', hitRadius: 1.3 });
      for (const arm of arms) {
        this.#box({ x, z, y0: base + arm.y, h: 0.35, w: arm.half * 2, d: 0.35, yaw, mat: 'pylon' });
      }
    }
    // Conductors hang from the arm ends and sag between pylons.
    const attach = [[-6.5, 22.6], [6.5, 22.6], [-4, 27.6], [4, 27.6], [0, 32]];
    for (let i = 0; i < pylons.length - 1; i++) {
      const p = pylons[i];
      const q = pylons[i + 1];
      for (const [side, up] of attach) {
        const points = [];
        for (let k = 0; k <= 8; k++) {
          const u = k / 8;
          points.push([
            mix(p.x, q.x, u) + px * side,
            mix(p.base, q.base, u) + up - 4 * 4 * u * (1 - u) * (up > 30 ? 0.5 : 1),
            mix(p.z, q.z, u) + pz * side,
          ]);
        }
        this.#cable(points);
      }
    }
  }

  #mast() {
    const x = -30;
    const z = -230;
    const base = this.landHeight(x, z);
    this.keepClear.push({ x, z, r: 38 });
    for (let i = 0; i < 6; i++) {
      this.#box({ x, z, y0: base + i * 10 - (i ? 0 : 2), h: i ? 10 : 12, w: 1.4, d: 1.4, mat: 'paint', color: i % 2 ? 0xf2f2f2 : 0xd0392b });
    }
    // Guy wires: hard to see, just like the real thing.
    for (const height of [28, 52]) {
      for (let k = 0; k < 3; k++) {
        const a = k * (Math.PI * 2 / 3) + 0.5;
        const gx = x + Math.cos(a) * 34;
        const gz = z + Math.sin(a) * 34;
        this.#cable([[x, base + height, z], [gx, this.landHeight(gx, gz), gz]]);
      }
    }
  }

  // Practice obstacles east of the take-off field.
  #trainingYard() {
    this.keepClear.push({ x: 100, z: -30, r: 62 });
    const g = (x, z) => this.landHeight(x, z);
    // Slalom poles.
    for (let i = 0; i < 7; i++) {
      const x = 72 + (i % 2) * 5;
      const z = -78 + i * 11;
      this.#cylinder({ x, z, y0: g(x, z), h: 9, r: 0.14, mat: 'paint', color: i % 2 ? 0xff7a1a : 0xf2f2f2, hitRadius: 0.2 });
    }
    // Arches to fly under, each one tighter than the last.
    const arch = (x, z, width, height, yaw, color) => {
      const base = g(x, z);
      const ax = Math.cos(yaw) * width / 2;
      const az = -Math.sin(yaw) * width / 2;
      for (const s of [-1, 1]) {
        this.#box({ x: x + ax * s, z: z + az * s, y0: base - 1, h: height + 1, w: 0.5, d: 0.5, yaw, mat: 'paint', color });
      }
      this.#box({ x, z, y0: base + height, h: 0.5, w: width + 0.5, d: 0.5, yaw, mat: 'paint', color });
    };
    arch(100, -70, 9, 7, 0, 0x2f81f7);
    arch(100, -45, 7, 5, 0, 0x2f81f7);
    arch(100, -20, 5, 3.5, 0, 0x2f81f7);
    // A square window frame raised off the ground.
    const fx = 125;
    const fz = -50;
    const fb = g(fx, fz);
    arch(fx, fz, 5, 9, Math.PI / 2, 0xf0b429);
    this.#box({ x: fx, z: fz, y0: fb + 5, h: 0.5, w: 5.5, d: 0.5, yaw: Math.PI / 2, mat: 'paint', color: 0xf0b429 });
    // Shipping containers, two down and one on top.
    const cx = 128;
    const cz = 8;
    const cb = g(cx, cz);
    const yaw = 0.3;
    const across = { x: Math.sin(yaw) * 1.4, z: Math.cos(yaw) * 1.4 };
    this.#box({ x: cx - across.x, z: cz - across.z, y0: cb - 0.5, h: 3.1, w: 12.2, d: 2.5, yaw, mat: 'container', color: 0x2f6f9f });
    this.#box({ x: cx + across.x, z: cz + across.z, y0: cb - 0.5, h: 3.1, w: 12.2, d: 2.5, yaw, mat: 'container', color: 0xb5452f });
    this.#box({ x: cx, z: cz, y0: cb + 2.6, h: 2.6, w: 12.2, d: 2.5, yaw: yaw + 0.25, mat: 'container', color: 0x4f8f4a });
  }

  #windFarm() {
    const facing = 0.7;   // direction the rotors face
    for (const [x, z, phase] of [[-430, -330, 0], [-545, -215, 1.3], [-380, -470, 2.6], [470, -360, 0.7]]) {
      const base = this.landHeight(x, z);
      this.keepClear.push({ x, z, r: 9 });
      this.#cylinder({ x, z, y0: base - 3, h: TURBINE_HUB + 3, r: 2.3, rTop: 1.2, sides: 16, mat: 'white', hitRadius: 2 });
      const hub = { x: x + Math.sin(facing) * TURBINE_FRONT, y: base + TURBINE_HUB, z: z + Math.cos(facing) * TURBINE_FRONT };
      this.#shape({ t: 'sph', x, y: hub.y, z, r: 4 }, x - 4, x + 4, z - 4, z + 4);
      this.turbines.push({ x, z, base, hub, facing, phase, speed: 1.1, blade: TURBINE_BLADE });
    }
  }

  #balloons() {
    this.balloons.push(
      { cx: 130, cz: -340, orbit: 150, alt: 75, speed: 0.02, phase: 0.5, color: 0xd9412b },
      { cx: -120, cz: 430, orbit: 110, alt: 60, speed: -0.025, phase: 2.2, color: 0x2f7fd9 },
    );
  }

  #clear(x, z, margin) {
    if (this.roadDistance(x, z) < ROAD_HALF_WIDTH + 4 + margin) return false;
    return !this.keepClear.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + margin);
  }

  #slope(x, z) {
    return Math.hypot(this.landHeight(x + 2, z) - this.landHeight(x - 2, z), this.landHeight(x, z + 2) - this.landHeight(x, z - 2)) / 4;
  }

  #rocks() {
    const rand = mulberry32(99);
    const half = WORLD_SIZE / 2 + 100;
    for (let i = 0; i < 2500 && this.rocks.length < 320; i++) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      const size = 0.4 + rand() * rand() * 3;
      const base = this.landHeight(x, z);
      if (base < WATER_LEVEL - 0.5 || !this.#clear(x, z, size)) continue;
      // Rocks collect on slopes and along the shore.
      if (this.#slope(x, z) < 0.12 && base > WATER_LEVEL + 1.2 && rand() < 0.85) continue;
      const rock = { x, z, y: base + size * 0.15, size, spin: rand() * 6, squash: 0.55 + rand() * 0.35 };
      this.rocks.push(rock);
      if (size > 0.9) this.#shape({ t: 'sph', x, y: rock.y, z, r: size * 0.85 }, x - size, x + size, z - size, z + size);
    }
  }

  #trees() {
    const rand = mulberry32(42);
    const half = WORLD_SIZE / 2 + 220;
    for (let i = 0; i < 12000 && this.trees.length < 3200; i++) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      const base = this.landHeight(x, z);
      const conifer = rand() < 0.35 + base * 0.03;
      const height = conifer ? 7 + rand() * 10 : 5 + rand() * 6;
      if (base < WATER_LEVEL + 0.7 || !this.#clear(x, z, 5)) continue;
      // Woods and clearings: more trees where this noise is high.
      if (fbm(x / 110 + 5, z / 110 - 3, 2) + rand() * 0.35 < 0.12) continue;
      if (this.#slope(x, z) > 0.5) continue;
      const tree = {
        x, z, base, height, conifer,
        radius: conifer ? height * 0.2 : height * (0.34 + rand() * 0.08),
        shade: rand(),
      };
      this.trees.push(tree);
      const key = cellKey(cellOf(x), cellOf(z));
      if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
      this.treeGrid.get(key).push(tree);
    }
  }

  // Removes trees and rocks inside a circle (keeps race gates flyable).
  clearTrees(x, z, radius) {
    const outside = (t) => Math.hypot(t.x - x, t.z - z) > radius;
    this.trees = this.trees.filter(outside);
    for (const [key, list] of this.treeGrid) this.treeGrid.set(key, list.filter(outside));
  }

  #hitsTree(t, x, y, z, r) {
    const up = y - t.base;
    if (up > t.height + r) return false;
    const flat = Math.hypot(x - t.x, z - t.z);
    if (t.conifer) {
      // Thin trunk below, cone-shaped canopy above.
      const trunkTop = t.height * 0.2;
      const reach = up < trunkTop ? 0.25 : t.radius * (1 - (up - trunkTop) / (t.height - trunkTop));
      return flat < Math.max(reach, 0) + r;
    }
    // Broadleaf: trunk with a round crown.
    const crownY = t.height - t.radius;
    if (Math.hypot(flat, up - crownY) < t.radius + r) return true;
    return up < crownY && flat < 0.3 + r;
  }

  hitsObstacle(x, y, z, r) {
    const cx = cellOf(x);
    const cz = cellOf(z);
    const list = this.grid.get(cellKey(cx, cz));
    if (list) for (const o of list) if (hitsShape(o, x, y, z, r)) return true;

    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        const trees = this.treeGrid.get(cellKey(cx + i, cz + k));
        if (trees) for (const t of trees) if (this.#hitsTree(t, x, y, z, r)) return true;
      }
    }

    for (const t of this.turbines) {
      if (Math.hypot(x - t.hub.x, y - t.hub.y, z - t.hub.z) > t.blade + r + 1) continue;
      const sideX = Math.cos(t.facing);
      const sideZ = -Math.sin(t.facing);
      for (let b = 0; b < 3; b++) {
        const a = turbineAngle(t, this.time) + b * (Math.PI * 2 / 3);
        const blade = {
          ax: t.hub.x, ay: t.hub.y, az: t.hub.z,
          bx: t.hub.x + sideX * Math.cos(a) * t.blade,
          by: t.hub.y + Math.sin(a) * t.blade,
          bz: t.hub.z + sideZ * Math.cos(a) * t.blade,
        };
        if (segmentDistance(x, y, z, blade) < 1 + r) return true;
      }
    }

    for (const b of this.balloons) {
      const p = balloonPosition(b, this.time);
      if (Math.hypot(x - p.x, y - p.y, z - p.z) < 8.5 + r) return true;
      if (Math.hypot(x - p.x, y - (p.y - 11.5), z - p.z) < 1.3 + r) return true;
    }
    return false;
  }
}
