import { Terrain } from './terrain.js';
import { Drone, FLIGHT_MODES, GIMBAL_MIN, GIMBAL_MAX } from './drone.js';
import { SimScene } from './scene.js';
import { Input } from './input.js';
import { RCN1 } from './rcn1.js';
import { PropAudio } from './audio.js';
import { GATE_COURSE, GATE_RADIUS, LANDING_TARGET } from './course.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ---------- Missions ----------

const terrain = new Terrain();
for (const [x, z] of GATE_COURSE) terrain.clearTrees(x, z, 14);
terrain.clearTrees(LANDING_TARGET.x, LANDING_TARGET.z, 12);

const gates = GATE_COURSE.map(([x, z, up], i) => {
  const prev = GATE_COURSE[i - 1] || [0, 0];
  const next = GATE_COURSE[i + 1] || [x + (x - prev[0]), z + (z - prev[1])];
  const dx = next[0] - prev[0];
  const dz = next[1] - prev[1];
  const len = Math.hypot(dx, dz);
  return { x, z, y: terrain.groundHeight(x, z) + up, nx: dx / len, nz: dz / len, radius: GATE_RADIUS };
});

// ---------- Core objects ----------

// Default graphics preset: a sensible guess from the display, overridden by a
// saved choice. Changing it never touches flight behaviour.
const QUALITY_KEY = 'air2s-sim-quality';
function defaultQuality() {
  try { const saved = localStorage.getItem(QUALITY_KEY); if (saved) return saved; } catch { /* private mode */ }
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 4 && dpr <= 1) return 'medium';
  return 'high';
}
const quality = defaultQuality();
const sim = new SimScene($('view'), terrain, quality);
const drone = new Drone(terrain);
const rc = new RCN1();
const input = new Input(rc);
const audio = new PropAudio();

const game = {
  mission: 'free',
  paused: true,
  windSpeed: 0,
  nextGate: 0,
  missionTime: 0,
  running: false,       // mission clock running
  result: null,         // { text, kind, until }
  time: 0,
};
window.__sim = { drone, game, input, rc, sim, terrain };

function bestKey() { return `air2s-sim-best-${game.mission}`; }
function readBest() { try { return Number(localStorage.getItem(bestKey())) || 0; } catch { return 0; } }
function saveBest(v) { try { localStorage.setItem(bestKey(), String(v)); } catch { /* private mode */ } }

function restart() {
  drone.reset(0, 0, 0);
  drone.batteryRate = Number($('opt-battery').value);
  game.nextGate = 0;
  game.missionTime = 0;
  game.running = false;
  game.result = null;
  sim.setGates(game.mission === 'gates' ? gates : []);
  sim.highlightGate(0);
  sim.showTargetPad(game.mission === 'landing' ? LANDING_TARGET : null);
  sim.snapCamera = true;
}

function showResult(text, kind = 'good', seconds = 8) {
  game.result = { text, kind, until: game.time + seconds };
}

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function handleEvents() {
  for (const e of drone.events.splice(0)) {
    if (e === 'takeoff' && game.mission !== 'free' && game.missionTime === 0) game.running = true;
    if (e === 'crash') game.running = false;
    if (e === 'landed' && game.mission === 'landing' && game.running) {
      game.running = false;
      const miss = Math.hypot(drone.pos.x - LANDING_TARGET.x, drone.pos.z - LANDING_TARGET.z);
      if (miss <= LANDING_TARGET.radius) {
        const score = Math.round(100 * (1 - miss / LANDING_TARGET.radius));
        const best = readBest();
        if (score > best) saveBest(score);
        showResult(`Landed ${miss.toFixed(2)} m from centre — ${score} points in ${fmtTime(game.missionTime)}${score > best ? ' (new best)' : ''}`);
      } else {
        showResult(`Missed the pad by ${(miss - LANDING_TARGET.radius).toFixed(1)} m — press R to try again`, 'bad');
      }
    }
  }
}

function checkGates(prev) {
  if (game.mission !== 'gates' || game.nextGate >= gates.length) return;
  const g = gates[game.nextGate];
  const before = (prev.x - g.x) * g.nx + (prev.z - g.z) * g.nz;
  const after = (drone.pos.x - g.x) * g.nx + (drone.pos.z - g.z) * g.nz;
  if (before * after > 0 || before === after) return;
  // Point where the path crossed the gate's plane.
  const t = before / (before - after);
  const cx = prev.x + (drone.pos.x - prev.x) * t - g.x;
  const cy = prev.y + (drone.pos.y - prev.y) * t - g.y;
  const cz = prev.z + (drone.pos.z - prev.z) * t - g.z;
  if (Math.hypot(cx, cy, cz) > g.radius) return;
  game.nextGate++;
  sim.highlightGate(game.nextGate);
  if (game.nextGate === gates.length) {
    game.running = false;
    const best = readBest();
    const isBest = !best || game.missionTime < best;
    if (isBest) saveBest(game.missionTime);
    showResult(`Course complete in ${fmtTime(game.missionTime)}${isBest ? ' — new best!' : ` (best ${fmtTime(best)})`}`);
  }
}

function wind(t) {
  if (!game.windSpeed) return { x: 0, z: 0 };
  const speed = game.windSpeed * (1 + 0.3 * Math.sin(t * 0.5) + 0.15 * Math.sin(t * 1.7 + 1));
  const dir = 0.9 + 0.3 * Math.sin(t * 0.13);
  return { x: Math.sin(dir) * speed, z: -Math.cos(dir) * speed };
}

// ---------- Buttons and keys ----------

function setMode(m) { drone.setMode(m); }
function cycleMode() { setMode({ C: 'N', N: 'S', S: 'C' }[drone.mode]); }
function setPaused(p) {
  game.paused = p;
  $('menu').hidden = !p;
  $('hud').hidden = p;
  if (!p) audio.start();
}

const actions = {
  takeoff: () => drone.toggleTakeoffLand(),
  rth: () => drone.toggleRth(),
  view: () => sim.cycleView(),
  mode: cycleMode,
  menu: () => setPaused(!game.paused),
};
input.onButton = (name) => { if (name === 'menu' || !game.paused) actions[name](); };

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') return actions.menu();
  if (game.paused) return;
  const map = {
    KeyT: actions.takeoff, KeyH: actions.rth, KeyV: actions.view, KeyR: restart,
    Digit1: () => setMode('C'), Digit2: () => setMode('N'), Digit3: () => setMode('S'),
    KeyM: () => audio.toggleMute(),
  };
  map[e.code]?.();
});

$('btn-menu').onclick = actions.menu;
$('btn-mode').onclick = cycleMode;
$('btn-takeoff').onclick = () => (drone.state === 'crashed' ? restart() : actions.takeoff());
$('btn-rth').onclick = actions.rth;
$('btn-view').onclick = actions.view;
for (const b of document.querySelectorAll('#hud button')) b.addEventListener('click', () => b.blur());

for (const card of document.querySelectorAll('#missions button')) {
  card.onclick = () => {
    document.querySelector('#missions .on')?.classList.remove('on');
    card.classList.add('on');
  };
}
$('btn-start').onclick = () => {
  const mission = document.querySelector('#missions .on').dataset.mission;
  const battery = Number($('opt-battery').value);
  if (mission !== game.mission || battery !== drone.batteryRate || drone.state === 'crashed') {
    game.mission = mission;
    restart();
  }
  game.windSpeed = Number($('opt-wind').value);
  setPaused(false);
};

// Graphics preset: apply immediately (works mid-flight) and remember the choice.
$('opt-quality').value = quality;
$('opt-quality').onchange = (e) => {
  sim.applyQuality(e.target.value);
  try { localStorage.setItem(QUALITY_KEY, e.target.value); } catch { /* private mode */ }
};

input.bindTouchStick($('touch-left'), ['yaw', 'throttle']);
input.bindTouchStick($('touch-right'), ['roll', 'pitch']);

// ---------- RC-N1 connection ----------

const rcStatus = $('rc-status');
rc.onStatus = (text) => {
  rcStatus.textContent = text;
  rcStatus.className = rc.live ? 'ok' : '';
  $('btn-rc').textContent = rc.connected ? 'Disconnect RC-N1' : 'Connect RC-N1';
};
async function connectRc(anyDevice) {
  try {
    if (rc.connected && !anyDevice) await rc.disconnect();
    else await rc.connect({ anyDevice });
  } catch (e) {
    if (e.name === 'NotFoundError') {
      rcStatus.textContent = anyDevice
        ? 'No port selected.'
        : 'No DJI port selected. Check the controller is on and the cable is in the bottom USB-C port.';
    } else {
      rcStatus.textContent = e.message;
    }
    rcStatus.className = 'err';
  }
}
$('btn-rc').onclick = () => connectRc(false);
$('btn-rc-any').onclick = () => connectRc(true);
if (!rc.supported) {
  rcStatus.textContent = 'This browser cannot talk to the RC-N1 directly. Open the simulator in Chrome or Edge on a computer.';
  $('btn-rc').disabled = true;
}
for (const box of document.querySelectorAll('#invert input')) {
  box.checked = !!input.invert[box.dataset.axis];
  box.onchange = () => input.setInvert(box.dataset.axis, box.checked);
}

// ---------- HUD ----------

const el = {
  mode: $('btn-mode'), status: $('status'), src: $('src'), battery: $('battery'), clock: $('clock'),
  banner: $('banner'), mission: $('mission'), d: $('t-d'), h: $('t-h'), hs: $('t-hs'), vs: $('t-vs'),
  takeoff: $('btn-takeoff'), rth: $('btn-rth'), gimbalMark: $('gimbal-mark'), gimbalText: $('gimbal-text'),
  rcRaw: $('rc-raw'),
};
const mapCtx = $('map').getContext('2d');
const stickCtx = $('sticks').getContext('2d');

function banner() {
  if (drone.state === 'crashed') return [`${drone.crashReason} — press R to reset`, 'bad'];
  if (game.result && game.time < game.result.until) return [game.result.text, game.result.kind];
  if (drone.auto === 'land' && drone.battery <= 6) return ['Critically low battery — landing now', 'bad'];
  if (drone.auto === 'rth') return ['Returning to home — press H to cancel', 'info'];
  if (drone.auto === 'land') return ['Landing — press T to cancel', 'info'];
  if (drone.atAltitudeLimit) return ['Maximum altitude reached (120 m)', 'bad'];
  if (Math.max(Math.abs(drone.pos.x), Math.abs(drone.pos.z)) > terrain.limit) return ['Edge of the flight area — turn back', 'bad'];
  if (drone.state === 'flying' && drone.battery <= 20) return ['Low battery — return and land', 'bad'];
  if (drone.state === 'armed') return ['Motors running — push the left stick up to take off', 'info'];
  if (drone.state === 'idle' && drone.flightTime === 0) return ['Press T to take off, or hold both sticks down and inward to start the motors', 'info'];
  return null;
}

function drawMap() {
  const c = mapCtx;
  const size = 320;
  const range = Math.max(60, drone.homeDistance * 1.25);
  const scale = (size / 2 - 24) / range;
  const px = (x) => size / 2 + (x - drone.pos.x) * scale;
  const py = (z) => size / 2 + (z - drone.pos.z) * scale;
  c.clearRect(0, 0, size, size);
  c.strokeStyle = 'rgba(255,255,255,.25)';
  c.lineWidth = 2;
  c.beginPath(); c.arc(size / 2, size / 2, (size / 2 - 24) / 2, 0, 7); c.stroke();
  c.fillStyle = '#fff'; c.font = 'bold 22px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('N', size / 2, 16);

  const dot = (x, z, color, label) => {
    let dx = px(x) - size / 2;
    let dy = py(z) - size / 2;
    const len = Math.hypot(dx, dy);
    const max = size / 2 - 26;
    if (len > max) { dx *= max / len; dy *= max / len; }
    c.fillStyle = color;
    c.beginPath(); c.arc(size / 2 + dx, size / 2 + dy, 13, 0, 7); c.fill();
    if (label) { c.fillStyle = '#111'; c.font = 'bold 18px sans-serif'; c.fillText(label, size / 2 + dx, size / 2 + dy + 1); }
  };
  dot(drone.home.x, drone.home.z, '#f08a24', 'H');
  if (game.mission === 'gates' && game.nextGate < gates.length) {
    const g = gates[game.nextGate];
    dot(g.x, g.z, '#fff', String(game.nextGate + 1));
  }
  if (game.mission === 'landing') dot(LANDING_TARGET.x, LANDING_TARGET.z, '#4aa3ff', '');

  c.save();
  c.translate(size / 2, size / 2);
  c.rotate(drone.heading);
  c.fillStyle = '#35d06a';
  c.beginPath(); c.moveTo(0, -20); c.lineTo(13, 14); c.lineTo(0, 7); c.lineTo(-13, 14); c.closePath(); c.fill();
  c.restore();
}

function drawSticks(v) {
  const c = stickCtx;
  c.clearRect(0, 0, 260, 120);
  const box = (ox, x, y) => {
    c.strokeStyle = 'rgba(255,255,255,.6)';
    c.lineWidth = 2;
    c.strokeRect(ox + 2, 2, 116, 116);
    c.beginPath(); c.moveTo(ox + 60, 2); c.lineTo(ox + 60, 118); c.moveTo(ox + 2, 60); c.lineTo(ox + 118, 60);
    c.strokeStyle = 'rgba(255,255,255,.2)'; c.stroke();
    c.fillStyle = '#f08a24';
    c.beginPath(); c.arc(ox + 60 + x * 52, 60 - y * 52, 9, 0, 7); c.fill();
  };
  box(0, v.yaw, v.throttle);
  box(140, v.roll, v.pitch);
}

function updateHud(v) {
  el.mode.textContent = drone.mode;
  el.mode.className = `pill ${drone.mode === 'S' ? 'sport' : drone.mode === 'C' ? 'cine' : ''}`;
  el.mode.title = `${FLIGHT_MODES[drone.mode].label} mode`;
  el.status.textContent = {
    idle: 'Ready to fly', armed: 'Motors running', crashed: 'Crashed',
    flying: { takeoff: 'Taking off', land: 'Landing', rth: 'Returning home' }[drone.auto] || 'In flight',
  }[drone.state];
  el.src.textContent = input.source;

  const minutesLeft = (drone.battery / 100) * 31 / drone.batteryRate;
  el.battery.textContent = `${Math.ceil(drone.battery)}% · ${Math.floor(minutesLeft)}:${String(Math.floor((minutesLeft % 1) * 60)).padStart(2, '0')}`;
  el.battery.className = `chip ${drone.battery <= 10 ? 'bad' : drone.battery <= 20 ? 'warn' : ''}`;
  const ft = Math.floor(drone.flightTime);
  el.clock.textContent = `${String(Math.floor(ft / 60)).padStart(2, '0')}:${String(ft % 60).padStart(2, '0')}`;

  el.d.textContent = drone.homeDistance.toFixed(0);
  el.h.textContent = drone.altitude.toFixed(1);
  el.hs.textContent = drone.groundSpeed.toFixed(1);
  el.vs.textContent = (Math.abs(drone.vel.y) < 0.05 ? 0 : drone.vel.y).toFixed(1);

  const b = banner();
  el.banner.hidden = !b;
  if (b) { el.banner.textContent = b[0]; el.banner.className = `banner ${b[1] === 'bad' ? '' : b[1]}`; }

  let m = '';
  if (game.mission === 'gates') {
    const best = readBest();
    m = `Gate ${Math.min(game.nextGate + 1, gates.length)}/${gates.length} · ${fmtTime(game.missionTime)}${best ? ` · best ${fmtTime(best)}` : ''}`;
  } else if (game.mission === 'landing') {
    const dist = Math.hypot(drone.pos.x - LANDING_TARGET.x, drone.pos.z - LANDING_TARGET.z);
    m = `Blue pad ${dist.toFixed(0)} m away · ${fmtTime(game.missionTime)}`;
  }
  el.mission.hidden = !m;
  el.mission.textContent = m;

  el.takeoff.textContent = drone.state === 'crashed' ? 'Reset' : drone.state === 'flying' ? 'Land' : 'Take off';
  el.takeoff.classList.toggle('active', drone.auto === 'land');
  el.rth.classList.toggle('active', drone.auto === 'rth');

  const g = (GIMBAL_MAX - drone.gimbal) / (GIMBAL_MAX - GIMBAL_MIN);
  el.gimbalMark.style.top = `${g * 136}px`;
  el.gimbalText.textContent = `${Math.round(drone.gimbal / DEG)}°`;

  drawMap();
  drawSticks(v);
}

function updateMenu(v) {
  if (!rc.connected) { el.rcRaw.textContent = ''; return; }
  rcStatus.className = rc.live ? 'ok' : '';
  const f = (n) => n.toFixed(2).padStart(5);
  el.rcRaw.textContent = rc.live
    ? `throttle ${f(v.throttle)}  yaw ${f(v.yaw)}  pitch ${f(v.pitch)}  roll ${f(v.roll)}  wheel ${f(v.wheel)}  |  raw: ${rc.lastPayloadHex}`
    : '';
}

// ---------- Main loop ----------

const STEP = 1 / 120;
let last = performance.now();
let carry = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const v = input.update(dt);

  if (!game.paused) {
    game.time += dt;
    carry += dt;
    while (carry >= STEP) {
      carry -= STEP;
      const prev = { ...drone.pos };
      terrain.time = game.time;
      drone.update(STEP, v, wind(game.time));
      if (game.running) game.missionTime += STEP;
      checkGates(prev);
      handleEvents();
    }
    updateHud(v);
  } else {
    updateMenu(v);
  }

  sim.update(drone, dt, game.time);
  const camDist = Math.hypot(
    sim.camera.position.x - drone.pos.x, sim.camera.position.y - drone.pos.y, sim.camera.position.z - drone.pos.z,
  );
  audio.update(drone.motorsOn && !game.paused, drone.throttleLevel, camDist);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => sim.resize());
restart();
requestAnimationFrame(frame);
