// Merges every control source into one set of stick values (Mode 2):
//   left stick  — up/down = throttle, left/right = yaw
//   right stick — up/down = pitch (forward/back), left/right = roll
// The RC-N1 wins whenever it is sending data; otherwise gamepad, keyboard and
// on-screen sticks are added together.

const DEADZONE = 0.04;
const clamp = (v) => Math.max(-1, Math.min(1, v));
const dead = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

const KEY_AXES = {
  KeyW: ['throttle', 1], KeyS: ['throttle', -1],
  KeyD: ['yaw', 1], KeyA: ['yaw', -1],
  ArrowUp: ['pitch', 1], ArrowDown: ['pitch', -1],
  ArrowRight: ['roll', 1], ArrowLeft: ['roll', -1],
  KeyX: ['wheel', 1], KeyZ: ['wheel', -1],
};

const AXES = ['throttle', 'yaw', 'pitch', 'roll', 'wheel'];
const SETTINGS_KEY = 'air2s-sim-rc-invert';

export class Input {
  constructor(rc) {
    this.rc = rc;
    this.source = 'Keyboard';
    this.value = { throttle: 0, yaw: 0, pitch: 0, roll: 0, wheel: 0 };
    this.keys = new Set();
    this.keyAxes = { throttle: 0, yaw: 0, pitch: 0, roll: 0, wheel: 0 };
    this.touch = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    this.padButtons = [];
    this.onButton = () => {};     // called with 'takeoff' | 'rth' | 'view' | 'mode' | 'menu'
    try { this.invert = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { this.invert = {}; }

    window.addEventListener('keydown', (e) => { if (KEY_AXES[e.code]) { this.keys.add(e.code); e.preventDefault(); } });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setInvert(axis, on) {
    this.invert[axis] = on;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.invert)); } catch { /* private mode */ }
  }

  // Turns a round on-screen pad into a stick. axes = [horizontal, vertical].
  bindTouchStick(el, axes) {
    const knob = el.firstElementChild;
    let id = null;
    const move = (e) => {
      if (e.pointerId !== id) return;
      const r = el.getBoundingClientRect();
      let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let y = -(e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.touch[axes[0]] = x;
      this.touch[axes[1]] = y;
      knob.style.transform = `translate(${x * 50}%, ${-y * 50}%)`;
    };
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.touch[axes[0]] = 0;
      this.touch[axes[1]] = 0;
      knob.style.transform = '';
    };
    el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.setPointerCapture(id); move(e); e.preventDefault(); });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  #gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected && p.axes.length >= 4);
    if (!pad) { this.padButtons = []; return null; }
    const pressed = pad.buttons.map((b) => b.pressed);
    const names = { 0: 'takeoff', 1: 'rth', 2: 'mode', 3: 'view', 9: 'menu' };
    for (const [i, name] of Object.entries(names)) {
      if (pressed[i] && !this.padButtons[i]) this.onButton(name);
    }
    this.padButtons = pressed;
    return {
      yaw: dead(pad.axes[0]),
      throttle: dead(-pad.axes[1]),
      roll: dead(pad.axes[2]),
      pitch: dead(-pad.axes[3]),
      wheel: (pad.buttons[7]?.value || 0) - (pad.buttons[6]?.value || 0),
      id: pad.id,
    };
  }

  update(dt) {
    // Keys ramp towards full deflection so they feel less on/off.
    const want = { throttle: 0, yaw: 0, pitch: 0, roll: 0, wheel: 0 };
    for (const code of this.keys) { const [axis, dir] = KEY_AXES[code]; want[axis] += dir; }
    for (const a of AXES) {
      const step = (want[a] === 0 ? 6 : 3.5) * dt;
      const diff = want[a] - this.keyAxes[a];
      this.keyAxes[a] += Math.max(-step, Math.min(step, diff));
    }

    const pad = this.#gamepad();
    const v = this.value;
    if (this.rc.live) {
      const r = this.rc.axes;
      v.throttle = dead(r.leftY);
      v.yaw = dead(r.leftX);
      v.pitch = dead(r.rightY);
      v.roll = dead(r.rightX);
      v.wheel = dead(r.wheel);
      for (const a of AXES) if (this.invert[a]) v[a] = -v[a];
      this.source = 'RC-N1';
    } else {
      for (const a of AXES) v[a] = clamp(this.keyAxes[a] + (pad ? pad[a] : 0) + (this.touch[a] || 0));
      this.source = pad ? 'Gamepad' : 'Keyboard';
    }
    return v;
  }
}
