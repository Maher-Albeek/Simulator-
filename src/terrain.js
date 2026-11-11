// Terrain shape and obstacle list. Pure maths (no rendering) so the flight
// model can be tested against it in Node.

export const WORLD_SIZE = 1600;
export const WATER_LEVEL = -3.5;

const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rawHeight(x, z) {
  const r = Math.hypot(x, z);
  const hills =
    11 * Math.sin(x * 0.011 + 0.4) * Math.cos(z * 0.013) +
    6 * Math.sin(x * 0.027 + 1.3) * Math.sin(z * 0.023 + 0.7) +
    1.6 * Math.sin(x * 0.071) * Math.cos(z * 0.063 + 2.1) +
    3;
  // Flat take-off field around the origin, hills further out.
  return hills * smooth(45, 190, r);
}

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

const CELL = 16;
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

export class Terrain {
  constructor() {
    this.limit = WORLD_SIZE / 2 - 60;
    this.buildings = [];
    this.trees = [];
    this.treeGrid = new Map();
    this.#placeBuildings();
    this.#placeTrees();
  }

  landHeight(x, z) { return rawHeight(x, z); }
  groundHeight(x, z) { return Math.max(rawHeight(x, z), WATER_LEVEL); }
  isWater(x, z) { return rawHeight(x, z) < WATER_LEVEL; }

  #placeBuildings() {
    const rand = mulberry32(7);
    const village = { x: 150, z: -120 };
    for (let i = 0; i < 14; i++) {
      const w = 8 + rand() * 10;
      const d = 8 + rand() * 10;
      const h = 5 + rand() * 14;
      const x = village.x + (i % 5) * 26 + rand() * 6;
      const z = village.z + Math.floor(i / 5) * 30 + rand() * 6;
      const base = this.landHeight(x, z);
      if (base < WATER_LEVEL + 1) continue;
      this.buildings.push({ x, z, w, d, h, base, color: 0.55 + rand() * 0.35 });
    }
    // A tall mast as a landmark north of the field.
    this.buildings.push({ x: -30, z: -230, w: 3, d: 3, h: 60, base: this.landHeight(-30, -230), color: 0.9, mast: true });
  }

  #placeTrees() {
    const rand = mulberry32(42);
    const half = WORLD_SIZE / 2 - 20;
    for (let i = 0; i < 2600 && this.trees.length < 1300; i++) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      const height = 6 + rand() * 9;
      // Keep the take-off field and the gate corridor near home clear.
      if (Math.hypot(x, z) < 38) continue;
      const base = this.landHeight(x, z);
      if (base < WATER_LEVEL + 0.6) continue;
      // Clumps: more trees where this noise is high.
      if (Math.sin(x * 0.02) + Math.cos(z * 0.017 + 1) + rand() * 1.2 < 0.5) continue;
      if (this.buildings.some((b) => Math.abs(x - b.x) < b.w / 2 + 4 && Math.abs(z - b.z) < b.d / 2 + 4)) continue;
      const tree = { x, z, base, height, radius: height * 0.22 };
      this.trees.push(tree);
      const key = cellKey(x, z);
      if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
      this.treeGrid.get(key).push(tree);
    }
  }

  // Removes trees inside a circle (used to keep race gates flyable).
  clearTrees(x, z, radius) {
    this.trees = this.trees.filter((t) => Math.hypot(t.x - x, t.z - z) > radius);
    for (const [key, list] of this.treeGrid) {
      this.treeGrid.set(key, list.filter((t) => Math.hypot(t.x - x, t.z - z) > radius));
    }
  }

  hitsObstacle(x, y, z, r) {
    for (const b of this.buildings) {
      if (
        Math.abs(x - b.x) < b.w / 2 + r &&
        Math.abs(z - b.z) < b.d / 2 + r &&
        y < b.base + b.h + r
      ) return true;
    }
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        const list = this.treeGrid.get(cellKey(x + cx * CELL, z + cz * CELL));
        if (!list) continue;
        for (const t of list) {
          const up = y - t.base;
          if (up > t.height + r) continue;
          // Thin trunk below, cone-shaped canopy above.
          const trunkTop = t.height * 0.25;
          const reach = up < trunkTop ? 0.25 : t.radius * (1 - (up - trunkTop) / (t.height - trunkTop));
          if (Math.hypot(x - t.x, z - t.z) < Math.max(reach, 0) + r) return true;
        }
      }
    }
    return false;
  }
}
