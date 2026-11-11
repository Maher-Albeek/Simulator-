// Flight model for a GPS-stabilised camera drone tuned to DJI Air 2S figures:
// 595 g, 19 m/s in Sport, 15 m/s in Normal, 5 m/s in Cine, 6 m/s climb,
// about 31 minutes of battery. Sticks command velocities, the drone tilts to
// reach them and brakes to a hover when the sticks are released.
// No rendering code in here so it can be tested in Node.

const DEG = Math.PI / 180;
const G = 9.81;
const DRAG = 0.016;               // 1/m, gives ~19 m/s at 35° tilt
const HOVER_MINUTES = 31;
const GEAR = 0.04;                // body centre height when standing on the ground
const RADIUS = 0.2;

export const FLIGHT_MODES = {
  C: { label: 'Cine', maxSpeed: 5, maxUp: 2, maxDown: 2, maxTilt: 15 * DEG, yawRate: 60 * DEG },
  N: { label: 'Normal', maxSpeed: 15, maxUp: 6, maxDown: 6, maxTilt: 25 * DEG, yawRate: 120 * DEG },
  S: { label: 'Sport', maxSpeed: 19, maxUp: 6, maxDown: 6, maxTilt: 35 * DEG, yawRate: 200 * DEG },
};

export const GIMBAL_MIN = -90 * DEG;
export const GIMBAL_MAX = 24 * DEG;
export const MAX_ALTITUDE = 120;   // metres above the take-off point
const RTH_ALTITUDE = 30;
const RTH_SPEED = 10;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const expo = (v) => v * (0.35 + 0.65 * v * v);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Drone {
  constructor(world) {
    this.world = world;
    this.mode = 'N';
    this.batteryRate = 1;
    this.reset(0, 0, 0);
  }

  reset(x, z, heading = 0) {
    this.pos = { x, y: this.world.groundHeight(x, z) + GEAR, z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.thrust = { x: 0, z: 0 };    // horizontal acceleration produced by tilting
    this.heading = heading;          // radians, clockwise from north (-Z)
    this.yawRate = 0;
    this.pitch = 0;                  // visual attitude, radians (positive = nose down)
    this.roll = 0;                   // positive = right side down
    this.gimbal = 0;
    this.state = 'idle';             // idle | armed | flying | crashed
    this.auto = null;                // null | takeoff | land | rth
    this.home = { ...this.pos };
    this.battery = 100;
    this.flightTime = 0;
    this.odometer = 0;
    this.throttleLevel = 0;          // 0..1, for sound and propeller speed
    this.crashReason = '';
    this.atAltitudeLimit = false;
    this.events = [];
    this.cscTime = 0;
    this.cscLatched = false;
    this.groundTime = 0;
    this.lowBatteryWarned = false;
    this.lowBatteryRth = false;
  }

  get agl() { return this.pos.y - GEAR - this.world.groundHeight(this.pos.x, this.pos.z); }
  get altitude() { return this.pos.y - this.home.y; }
  get homeDistance() { return Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z); }
  get groundSpeed() { return Math.hypot(this.vel.x, this.vel.z); }
  get motorsOn() { return this.state === 'armed' || this.state === 'flying'; }

  setMode(mode) { if (FLIGHT_MODES[mode]) this.mode = mode; }

  // One button for take-off and landing, like the app's on-screen button.
  toggleTakeoffLand() {
    if (this.state === 'crashed') return;
    if (this.state === 'idle' || this.state === 'armed') {
      if (this.battery <= 6) return;
      this.#liftOff();
      this.auto = 'takeoff';
    } else {
      this.auto = this.auto === 'land' && this.battery > 6 ? null : 'land';
    }
  }

  toggleRth() {
    if (this.state !== 'flying') return;
    if (this.auto === 'rth') { this.auto = null; return; }
    if (this.battery <= 6) return;
    this.auto = 'rth';
    this.rthAltitude = Math.max(this.pos.y, this.home.y + RTH_ALTITUDE);
    this.events.push('rth');
  }

  #liftOff() {
    this.state = 'flying';
    this.home = { ...this.pos };
    this.groundTime = 0;
    this.events.push('takeoff');
  }

  #crash(reason) {
    this.state = 'crashed';
    this.auto = null;
    this.crashReason = reason;
    this.vel = { x: 0, y: 0, z: 0 };
    this.throttleLevel = 0;
    this.events.push('crash');
  }

  // input: { throttle, yaw, pitch, roll, wheel } each -1..1. wind: { x, z } m/s.
  update(dt, input, wind = { x: 0, z: 0 }) {
    this.gimbal = clamp(this.gimbal + input.wheel * 45 * DEG * dt, GIMBAL_MIN, GIMBAL_MAX);
    if (this.state === 'crashed') return;

    this.#stickCommand(dt, input);

    if (this.state === 'idle') { this.throttleLevel = 0; return; }
    this.#drainBattery(dt);
    if (this.state === 'armed') {
      this.throttleLevel = 0.15;
      if (input.throttle > 0.15 && this.battery > 6) this.#liftOff();
      return;
    }
    this.#fly(dt, input, wind);
  }

  // Both sticks down and inward for a second starts or stops the motors.
  #stickCommand(dt, input) {
    const held = input.throttle < -0.8 && input.yaw > 0.8 && input.pitch < -0.8 && input.roll < -0.8;
    if (!held) { this.cscTime = 0; this.cscLatched = false; return; }
    if (this.cscLatched || this.state === 'flying') return;
    this.cscTime += dt;
    if (this.cscTime < 1) return;
    this.cscLatched = true;
    this.state = this.state === 'idle' ? 'armed' : 'idle';
  }

  #drainBattery(dt) {
    const tilt = Math.hypot(this.thrust.x, this.thrust.z) / (G * Math.tan(FLIGHT_MODES.S.maxTilt));
    const load = this.state === 'armed' ? 0.3 : 1 + 0.5 * tilt * tilt + 0.35 * Math.max(0, this.vel.y) / 6;
    this.battery = Math.max(0, this.battery - (100 / (HOVER_MINUTES * 60)) * load * this.batteryRate * dt);
    if (this.state !== 'flying') return;
    if (this.battery <= 20 && !this.lowBatteryWarned) {
      this.lowBatteryWarned = true;
      this.events.push('lowbattery');
    }
    if (this.battery <= 15 && !this.lowBatteryRth) {
      this.lowBatteryRth = true;
      if (this.auto !== 'rth' && this.auto !== 'land' && this.homeDistance > 10) this.toggleRth();
    }
    if (this.battery <= 6) this.auto = 'land';
    if (this.battery === 0) this.#crash('Battery empty');
  }

  // Target velocity in world axes plus yaw rate, from the sticks or the autopilot.
  #targets(input) {
    const m = FLIGHT_MODES[this.mode];
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const fwd = expo(input.pitch) * m.maxSpeed;
    const right = expo(input.roll) * m.maxSpeed;
    const t = {
      x: sin * fwd + cos * right,
      z: -cos * fwd + sin * right,
      y: input.throttle > 0 ? expo(input.throttle) * m.maxUp : expo(input.throttle) * m.maxDown,
      yaw: expo(input.yaw) * m.yawRate,
    };

    if (this.auto === 'takeoff') {
      const gap = 1.2 - this.agl;
      t.x = 0; t.z = 0;
      t.y = clamp(gap * 2, 0.3, 2);
      if (gap < 0.05) this.auto = null;
    } else if (this.auto === 'land') {
      t.y = this.agl > 3 ? -2.5 : -0.6;
    } else if (this.auto === 'rth') {
      const dx = this.home.x - this.pos.x;
      const dz = this.home.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      t.x = 0; t.z = 0; t.y = 0; t.yaw = 0;
      if (dist < 0.4 && this.groundSpeed < 0.5) {
        this.auto = 'land';
      } else if (dist > 20 && this.pos.y < this.rthAltitude - 0.5) {
        t.y = 4;
      } else {
        const speed = Math.min(RTH_SPEED, dist * 0.8 + 0.2);
        t.x = (dx / dist) * speed;
        t.z = (dz / dist) * speed;
        if (dist > 5) t.yaw = clamp(wrapAngle(Math.atan2(dx, -dz) - this.heading) * 2, -1.5, 1.5);
      }
    }
    return t;
  }

  #fly(dt, input, wind) {
    const m = FLIGHT_MODES[this.mode];
    const t = this.#targets(input);
    const { pos, vel, world } = this;

    // Limits: altitude ceiling, flight-area fence, gentle descent near the ground.
    const headroom = MAX_ALTITUDE - this.altitude;
    this.atAltitudeLimit = headroom < 0.5 && t.y > 0;
    t.y = Math.min(t.y, Math.max(0, headroom) * 1.5);
    const fence = world.limit;
    if (pos.x > fence) t.x = Math.min(t.x, -1);
    if (pos.x < -fence) t.x = Math.max(t.x, 1);
    if (pos.z > fence) t.z = Math.min(t.z, -1);
    if (pos.z < -fence) t.z = Math.max(t.z, 1);
    const agl = this.agl;
    if (agl < 0.6) t.y = Math.max(t.y, -0.6);
    else if (agl < 3) t.y = Math.max(t.y, -2.5);

    // Horizontal: tilt-limited acceleration against quadratic drag.
    const rx = vel.x - wind.x;
    const rz = vel.z - wind.z;
    const rel = Math.hypot(rx, rz);
    const dragX = -DRAG * rel * rx;
    const dragZ = -DRAG * rel * rz;
    let ax = (t.x - vel.x) * 2.2 - dragX;
    let az = (t.z - vel.z) * 2.2 - dragZ;
    const aMax = G * Math.tan(this.auto ? FLIGHT_MODES.N.maxTilt : m.maxTilt);
    const a = Math.hypot(ax, az);
    if (a > aMax) { ax *= aMax / a; az *= aMax / a; }
    const k = 1 - Math.exp(-dt / 0.18);
    this.thrust.x += (ax - this.thrust.x) * k;
    this.thrust.z += (az - this.thrust.z) * k;
    vel.x += (this.thrust.x + dragX) * dt;
    vel.z += (this.thrust.z + dragZ) * dt;

    const ay = clamp((t.y - vel.y) * 5, -8, 8);
    vel.y += ay * dt;

    this.yawRate += (t.yaw - this.yawRate) * (1 - Math.exp(-dt / 0.1));
    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    this.pitch = Math.atan2(sin * this.thrust.x - cos * this.thrust.z, G);
    this.roll = Math.atan2(cos * this.thrust.x + sin * this.thrust.z, G);
    this.throttleLevel = clamp(0.5 + Math.hypot(this.thrust.x, this.thrust.z) / 20 + ay / 16, 0.2, 1);

    const nx = pos.x + vel.x * dt;
    const ny = pos.y + vel.y * dt;
    const nz = pos.z + vel.z * dt;
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    if (world.hitsObstacle(nx, ny, nz, RADIUS)) {
      if (speed > 2.5) { this.#crash('Hit an obstacle'); return; }
      vel.x = 0; vel.y = 0; vel.z = 0;
      this.thrust.x = 0; this.thrust.z = 0;
    } else {
      this.odometer += Math.hypot(nx - pos.x, nz - pos.z);
      pos.x = nx; pos.y = ny; pos.z = nz;
    }

    const floor = world.groundHeight(pos.x, pos.z) + GEAR;
    if (pos.y <= floor) {
      pos.y = floor;
      if (world.isWater(pos.x, pos.z)) { this.#crash('Landed in water'); return; }
      if (vel.y < -3 || this.groundSpeed > 4) { this.#crash('Hit the ground too hard'); return; }
      vel.y = Math.max(vel.y, 0);
      vel.x *= 0.8; vel.z *= 0.8;
      this.groundTime += dt;
      const wantsDown = this.auto === 'land' || input.throttle < -0.5;
      if (wantsDown && this.groundTime > (this.auto === 'land' ? 0.2 : 0.8)) {
        this.state = 'idle';
        this.auto = null;
        this.vel = { x: 0, y: 0, z: 0 };
        this.thrust = { x: 0, z: 0 };
        this.pitch = 0; this.roll = 0;
        this.events.push('landed');
        return;
      }
    } else {
      this.groundTime = 0;
    }
    this.flightTime += dt;
  }
}
