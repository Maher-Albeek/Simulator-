// Mission layout, kept apart from the game code so tests can check that
// nothing in the world blocks it.

export const GATE_RADIUS = 4;
// x, z, height above ground
export const GATE_COURSE = [
  [0, -45, 5], [-45, -95, 9], [-110, -90, 14], [-140, -30, 18],
  [-110, 40, 12], [-50, 75, 8], [15, 60, 6], [30, 15, 4],
];
export const LANDING_TARGET = { x: 60, z: 40, radius: 2.5 };
