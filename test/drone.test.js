import test from 'node:test';
import assert from 'node:assert/strict';
import { Drone } from '../src/drone.js';
import { Terrain } from '../src/terrain.js';

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

test('real terrain: field is flat, trees and buildings are solid', () => {
  const t = new Terrain();
  assert.equal(t.groundHeight(0, 0), 0);
  assert.ok(t.trees.length > 300);
  const tree = t.trees[0];
  assert.ok(t.hitsObstacle(tree.x, tree.base + tree.height * 0.4, tree.z, 0.2));
  assert.ok(!t.hitsObstacle(tree.x, tree.base + tree.height + 2, tree.z, 0.2));
  const b = t.buildings[0];
  assert.ok(t.hitsObstacle(b.x, b.base + 1, b.z, 0.2));
  assert.ok(!t.hitsObstacle(0, 1, 0, 0.2));
});
