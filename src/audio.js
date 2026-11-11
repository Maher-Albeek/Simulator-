// Propeller sound: two detuned oscillators through a low-pass filter whose
// pitch follows the motor load.

export class PropAudio {
  constructor() {
    this.muted = false;
    this.ctx = null;
  }

  // Browsers only allow audio after a click or key press.
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    this.oscs = [0, 7].map((detune) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = detune * 5;
      o.connect(filter);
      o.start();
      return o;
    });
    filter.connect(this.gain).connect(ctx.destination);
  }

  toggleMute() { this.muted = !this.muted; return this.muted; }

  // level 0..1, distance in metres from the listener (camera).
  update(motorsOn, level, distance) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const volume = motorsOn && !this.muted ? 0.07 / (1 + distance * 0.04) : 0;
    this.gain.gain.setTargetAtTime(volume, t, 0.08);
    const f = 95 + level * 150;
    this.oscs[0].frequency.setTargetAtTime(f, t, 0.06);
    this.oscs[1].frequency.setTargetAtTime(f * 2.01, t, 0.06);
  }
}
