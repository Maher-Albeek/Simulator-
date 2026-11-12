import test from 'node:test';
import assert from 'node:assert/strict';
import { Drone } from '../src/drone.js';
import { Terrain, WATER_LEVEL, balloonPosition } from '../src/terrain.js';
import { GATE_COURSE, LANDING_TARGET } from '../src/course.js';

const flat = { limit: 5000, groundHeight: () => 0, isWater: () => false, hitsObstacle: () => false };
const sticks = (o = {}) => ({ throttle: 0, yaw: 0, pitch: 0, roll: 0, wheel: 0, ...o });
const run = (drone, seconds, input, wind) => {
  for (let i = 0; i < seconds * 120; i++) drone.update(1 / 120, input, wind);
};
const airborne = (mode = 'N') => {
  const d = new Drone(flat);
  d.setMode(mode);
  d.toggleTakeoffLand();
  run(d, 3, sticks());
  run(d, 4, sticks({ throttle: 1 }));
  run(d, 2, sticks());
  return d;
};

test('auto take-off hovers at about 1.2 m', () => {
  const d = new Drone(flat);
  d.toggleTakeoffLand();
  run(d, 4, sticks());
  assert.equal(d.state, 'flying');
  assert.ok(Math.abs(d.agl - 1.2) < 0.15, `agl ${d.agl}`);
  assert.ok(d.groundSpeed < 0.01);
});

test('stick command starts the motors and throttle lifts off', () => {
  const d = new Drone(flat);
  run(d, 1.2, sticks({ throttle: -1, yaw: 1, pitch: -1, roll: -1 }));
  assert.equal(d.state, 'armed');
  run(d, 1, sticks({ throttle: 1 }));
  assert.equal(d.state, 'flying');
  assert.ok(d.agl > 1);
});

test('top speeds match the Air 2S figures', () => {
  for (const [mode, speed] of [['C', 5], ['N', 15], ['S', 19]]) {
    const d = airborne(mode);
    run(d, 15, sticks({ pitch: 1 }));
    assert.ok(Math.abs(d.groundSpeed - speed) < 0.6, `${mode}: ${d.groundSpeed}`);
    assert.ok(d.pos.z < -20, 'flies north');
    run(d, 6, sticks());
    assert.ok(d.groundSpeed < 0.3, `${mode} brakes to a hover: ${d.groundSpeed}`);
  }
});

test('climb rate and altitude limit', () => {
  const d = airborne('N');
  const y0 = d.pos.y;
  run(d, 3, sticks({ throttle: 1 }));
  assert.ok(Math.abs((d.pos.y - y0) / 3 - 6) < 0.8);
  run(d, 40, sticks({ throttle: 1 }));
  assert.ok(d.altitude <= 120.5 && d.altitude > 119, `alt ${d.altitude}`);
});

test('holds position in wind', () => {
  const d = airborne('N');
  const start = { ...d.pos };
  run(d, 20, sticks(), { x: 8, z: 0 });
  assert.ok(Math.hypot(d.pos.x - start.x, d.pos.z - start.z) < 3);
  assert.ok(Math.abs(d.roll) > 0.02, 'leans into the wind');
});

test('return to home flies back and lands', () => {
  const d = airborne('S');
  run(d, 12, sticks({ pitch: 1, roll: 0.5 }));
  assert.ok(d.homeDistance > 100);
  d.toggleRth();
  run(d, 90, sticks());
  assert.equal(d.state, 'idle');
  assert.ok(d.homeDistance < 1, `landed ${d.homeDistance} m from home`);
});

test('manual landing needs the throttle held down; a hard hit crashes', () => {
  const d = airborne('N');
  run(d, 30, sticks({ throttle: -1 }));
  assert.equal(d.state, 'idle');
  const c = airborne('S');
  run(c, 4, sticks({ pitch: 1 }));
  c.pos.y = 0.3;
  run(c, 1, sticks({ pitch: 1, throttle: -1 }));
  assert.equal(c.state, 'crashed');
});

test('battery lasts about 31 minutes in a hover, then forces a landing', () => {
  const d = airborne('N');
  d.batteryRate = 60;
  run(d, 20, sticks());
  assert.ok(d.battery > 30 && d.battery < 45, `battery ${d.battery}`);
  d.batteryRate = 1;
  d.battery = 6.2;
  run(d, 40, sticks());
  assert.equal(d.state, 'idle');
  assert.ok(d.battery > 0);
});

const terrain = new Terrain();
const clearOfTrees = () => {
  const t = new Terrain();
  for (const [x, z] of GATE_COURSE) t.clearTrees(x, z, 14);
  t.clearTrees(LANDING_TARGET.x, LANDING_TARGET.z, 12);
  return t;
};

test('take-off field is flat and clear, with water and hills further out', () => {
  assert.equal(terrain.groundHeight(0, 0), 0);
  assert.ok(!terrain.hitsObstacle(0, 1, 0, 0.5));
  assert.ok(terrain.isWater(240, 150), 'lake');
  assert.ok(terrain.trees.length > 1500 && terrain.rocks.length > 100);
});

test('trees, houses and rocks are solid but can be flown over', () => {
  for (const tree of [terrain.trees.find((t) => t.conifer), terrain.trees.find((t) => !t.conifer)]) {
    assert.ok(terrain.hitsObstacle(tree.x, tree.base + tree.height * 0.6, tree.z, 0.2));
    assert.ok(terrain.hitsObstacle(tree.x, tree.base + 0.5, tree.z, 0.2), 'trunk');
    assert.ok(!terrain.hitsObstacle(tree.x, tree.base + tree.height + 2, tree.z, 0.2));
  }
  const roof = terrain.parts.find((p) => p.kind === 'roof');
  assert.ok(terrain.hitsObstacle(roof.x, roof.y - 1, roof.z, 0.2), 'inside the walls');
  assert.ok(terrain.hitsObstacle(roof.x, roof.y + roof.h * 0.5, roof.z, 0.2), 'roof ridge');
  assert.ok(!terrain.hitsObstacle(roof.x, roof.y + roof.h + 2, roof.z, 0.2));
});

test('power lines and guy wires are thin but solid', () => {
  const cable = terrain.parts.find((p) => p.kind === 'line' && p.points.length > 2);
  const [x, y, z] = cable.points[4];
  assert.ok(terrain.hitsObstacle(x, y, z, 0.2));
  assert.ok(!terrain.hitsObstacle(x, y - 3, z, 0.2), 'room underneath');
  assert.ok(!terrain.hitsObstacle(x, y + 12, z, 0.2), 'room above');
});

test('the bridge can be flown under but not through', () => {
  const span = terrain.road.filter((p) => p.bridge && Math.abs(p.x - 240) < 100);
  const mid = span[Math.floor(span.length / 2)];
  assert.ok(span.length > 20 && terrain.isWater(mid.x, mid.z));
  assert.ok(terrain.hitsObstacle(mid.x, mid.deck - 0.3, mid.z, 0.2), 'deck');
  assert.ok(!terrain.hitsObstacle(mid.x, mid.deck - 3, mid.z, 0.2), 'under the deck');
  assert.ok(mid.deck - 3 > WATER_LEVEL + 1);
});

test('turbine blades sweep through the air', () => {
  const t = terrain.turbines[0];
  const tip = { x: t.hub.x + Math.cos(t.facing) * 20, y: t.hub.y, z: t.hub.z - Math.sin(t.facing) * 20 };
  const hits = [];
  for (let time = 0; time < 6; time += 0.05) {
    terrain.time = time;
    hits.push(terrain.hitsObstacle(tip.x, tip.y, tip.z, 0.2));
  }
  terrain.time = 0;
  assert.ok(hits.includes(true) && hits.includes(false));
  assert.ok(terrain.hitsObstacle(t.x, t.base + 20, t.z, 0.2), 'tower');
});

test('balloons drift and are solid', () => {
  const b = terrain.balloons[0];
  const p0 = balloonPosition(b, 0);
  assert.ok(terrain.hitsObstacle(p0.x, p0.y, p0.z, 0.2));
  terrain.time = 60;
  assert.ok(!terrain.hitsObstacle(p0.x, p0.y, p0.z, 0.2), 'it moved on');
  terrain.time = 0;
});

test('gate course and landing pad are not blocked by anything', () => {
  const t = clearOfTrees();
  for (const [x, z, up] of GATE_COURSE) {
    const y = t.groundHeight(x, z) + up;
    for (const [dx, dy, dz] of [[0, 0, 0], [3, 0, 0], [-3, 0, 0], [0, 3, 0], [0, -3, 0], [0, 0, 3], [0, 0, -3]]) {
      assert.ok(!t.hitsObstacle(x + dx, y + dy, z + dz, 0.5), `gate at ${x},${z}`);
    }
  }
  const pad = LANDING_TARGET;
  assert.ok(!t.isWater(pad.x, pad.z));
  assert.ok(!t.hitsObstacle(pad.x, t.groundHeight(pad.x, pad.z) + 1, pad.z, pad.radius));
  // A straight climb out of the field in every direction is clear too.
  for (let a = 0; a < 6.28; a += 0.3) assert.ok(!t.hitsObstacle(Math.cos(a) * 30, 3, Math.sin(a) * 30, 0.5));
});

test('flying into a house crashes the drone', () => {
  const roof = terrain.parts.find((p) => p.kind === 'roof');
  const d = new Drone(terrain);
  d.state = 'flying';
  d.pos = { x: roof.x, y: roof.y - 1, z: roof.z - 30 };
  d.heading = Math.PI;
  d.setMode('S');
  for (let i = 0; i < 120 * 8 && d.state === 'flying'; i++) d.update(1 / 120, sticks({ pitch: 1 }));
  assert.equal(d.state, 'crashed');
});
