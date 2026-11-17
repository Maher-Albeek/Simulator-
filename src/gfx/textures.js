// Every texture in the simulator is drawn procedurally at load time: no
// downloads, no asset pipeline, and the whole world still ships as a few
// kilobytes of JavaScript. Albedo maps are tagged sRGB; normal, roughness and
// mask maps stay linear.

import * as THREE from '../../vendor/three.module.min.js';
import { fbm } from '../terrain.js';

export function makeCanvas(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d'), w, h);
  return cv;
}

export function texture(canvas, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function canvasTexture(w, h, draw, opts) {
  return texture(makeCanvas(w, h, draw), opts);
}

function rng(seed) {
  let a = seed;
  return () => ((a = (a * 16807) % 2147483647) / 2147483647);
}

// Greyscale speckle, kept from the original look but with finer control.
export function speckle(g, w, h, base, spread, count, size = 2, seed = 12345) {
  g.fillStyle = `rgb(${base},${base},${base})`;
  g.fillRect(0, 0, w, h);
  const rnd = rng(seed);
  for (let i = 0; i < count; i++) {
    const v = Math.round(base + (rnd() - 0.5) * spread);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * w, rnd() * h, size + rnd() * size, size + rnd() * size * 2);
  }
}

// --- normal maps -----------------------------------------------------------

// Sobel a greyscale height canvas into a tangent-space normal map.
export function heightToNormal(canvas, strength = 2.2) {
  const w = canvas.width;
  const h = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h, () => {});
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const at = (x, y) => src[((y + h) % h * w + (x + w) % w) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// --- ground ----------------------------------------------------------------

export function grassAlbedo(size = 512) {
  return makeCanvas(size, size, (g, w, h) => {
    const rnd = rng(4821);
    g.fillStyle = '#5c7f33';
    g.fillRect(0, 0, w, h);
    // Broad colour patches.
    for (let i = 0; i < 180; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 18 + rnd() * 70;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const hue = 72 + rnd() * 26;
      const light = 22 + rnd() * 16;
      grad.addColorStop(0, `hsla(${hue}, ${34 + rnd() * 22}%, ${light}%, .55)`);
      grad.addColorStop(1, 'hsla(90, 30%, 30%, 0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Individual blades, drawn as short strokes in several tints.
    g.lineWidth = 1.2;
    for (let i = 0; i < 26000; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const a = -Math.PI / 2 + (rnd() - 0.5) * 1.5;
      const len = 3 + rnd() * 8;
      const hue = 68 + rnd() * 34;
      const l = 16 + rnd() * 30;
      g.strokeStyle = `hsla(${hue}, ${30 + rnd() * 35}%, ${l}%, ${0.25 + rnd() * 0.5})`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
    // A few dry straws and bare soil flecks.
    for (let i = 0; i < 1800; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      g.fillStyle = rnd() < 0.5 ? 'rgba(146,131,78,.5)' : 'rgba(86,70,48,.35)';
      g.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 2);
    }
  });
}

export function grassHeight(size = 256) {
  return makeCanvas(size, size, (g, w, h) => {
    g.fillStyle = '#808080';
    g.fillRect(0, 0, w, h);
    const rnd = rng(991);
    g.lineWidth = 1.6;
    for (let i = 0; i < 9000; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const a = -Math.PI / 2 + (rnd() - 0.5) * 1.4;
      const len = 3 + rnd() * 7;
      const v = Math.round(90 + rnd() * 110);
      g.strokeStyle = `rgb(${v},${v},${v})`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
  });
}

export function rockAlbedo(size = 512) {
  return makeCanvas(size, size, (g, w, h) => {
    const rnd = rng(1177);
    g.fillStyle = '#7d786f';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 2 + rnd() * 26;
      const v = 86 + rnd() * 72;
      g.fillStyle = `rgba(${v | 0},${(v * 0.97) | 0},${(v * 0.9) | 0},.45)`;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
    // Cracks.
    g.strokeStyle = 'rgba(52,50,46,.22)';
    for (let i = 0; i < 90; i++) {
      g.lineWidth = 0.6 + rnd() * 1.6;
      g.beginPath();
      let x = rnd() * w;
      let y = rnd() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 7; k++) {
        x += (rnd() - 0.5) * 70;
        y += (rnd() - 0.5) * 70;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  });
}

// Low-frequency greyscale used to break up tiling over hundreds of metres.
export function macroNoise(size = 256) {
  return makeCanvas(size, size, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = fbm(x / 26, y / 26, 4) + 0.5 * fbm(x / 7 + 11, y / 7, 2);
        const v = Math.max(0, Math.min(255, 128 + n * 190));
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

export function asphalt(size = 256) {
  return makeCanvas(size, size * 2, (g, w, h) => {
    const rnd = rng(733);
    g.fillStyle = '#3a3a3c';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) {
      const v = 40 + rnd() * 52;
      g.fillStyle = `rgba(${v | 0},${v | 0},${(v * 1.02) | 0},${0.3 + rnd() * 0.5})`;
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2.4, 1 + rnd() * 2.4);
    }
    // Tyre-polished wheel tracks.
    for (const cx of [w * 0.3, w * 0.72]) {
      const grad = g.createLinearGradient(cx - 22, 0, cx + 22, 0);
      grad.addColorStop(0, 'rgba(90,90,94,0)');
      grad.addColorStop(0.5, 'rgba(96,96,100,.22)');
      grad.addColorStop(1, 'rgba(90,90,94,0)');
      g.fillStyle = grad;
      g.fillRect(cx - 22, 0, 44, h);
    }
    // Edge lines and a dashed centre line.
    g.fillStyle = 'rgba(232,230,220,.85)';
    g.fillRect(6, 0, 3, h);
    g.fillRect(w - 9, 0, 3, h);
    for (let y = 0; y < h; y += 64) g.fillRect(w / 2 - 2, y, 4, 34);
    // Cracks and patches.
    g.strokeStyle = 'rgba(24,24,26,.6)';
    for (let i = 0; i < 24; i++) {
      g.lineWidth = 0.6 + rnd() * 1.2;
      g.beginPath();
      let x = rnd() * w;
      let y = rnd() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 50; y += (rnd() - 0.5) * 90; g.lineTo(x, y); }
      g.stroke();
    }
  });
}

// --- buildings -------------------------------------------------------------

function windowRects(w, h, rows, cols, { door = false, arched = false } = {}) {
  const out = [];
  const cw = w / cols;
  const rh = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const isDoor = door && r === rows - 1 && c === Math.floor(cols / 2);
      const ww = cw * (isDoor ? 0.34 : 0.36);
      const wh = rh * (isDoor ? 0.72 : arched ? 0.7 : 0.42);
      const x = c * cw + (cw - ww) / 2;
      const y = isDoor ? (r + 1) * rh - wh : r * rh + rh * (arched ? 0.15 : 0.28);
      out.push({ x, y, w: ww, h: wh, isDoor, arched });
    }
  }
  return out;
}

// Wall with windows (and optionally a door); tinted by the material colour.
export function facade(rows, cols, opts = {}) {
  const { door = false, arched = false, planks = false } = opts;
  const size = [512, 256];
  const albedo = makeCanvas(size[0], size[1], (g, w, h) => {
    const rnd = rng(3301);
    speckle(g, w, h, 236, 20, 1800, 2, 777);
    // Subtle plaster blotches and grime towards the bottom.
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 10 + rnd() * 60;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${200 + rnd() * 40 | 0},${196 + rnd() * 40 | 0},188,.16)`);
      grad.addColorStop(1, 'rgba(200,200,190,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const grime = g.createLinearGradient(0, h * 0.72, 0, h);
    grime.addColorStop(0, 'rgba(90,86,74,0)');
    grime.addColorStop(1, 'rgba(90,86,74,.28)');
    g.fillStyle = grime;
    g.fillRect(0, h * 0.72, w, h * 0.28);
    if (planks) {
      g.fillStyle = 'rgba(0,0,0,.25)';
      for (let x = 0; x < w; x += 16) g.fillRect(x, 0, 2, h);
      g.fillStyle = 'rgba(255,255,255,.10)';
      for (let x = 2; x < w; x += 16) g.fillRect(x, 0, 2, h);
    }
    for (const r of windowRects(w, h, rows, cols, opts)) {
      g.fillStyle = '#f6f3ec';
      g.fillRect(r.x - 5, r.y - 5, r.w + 10, r.h + (r.isDoor ? 5 : 10));
      g.fillStyle = 'rgba(0,0,0,.18)';
      g.fillRect(r.x - 5, r.y - 5, r.w + 10, 3);
      const glass = g.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
      if (r.isDoor) { glass.addColorStop(0, '#6b4a33'); glass.addColorStop(1, '#4a3222'); }
      else { glass.addColorStop(0, '#9fc0d8'); glass.addColorStop(0.45, '#39506a'); glass.addColorStop(1, '#1d2a3a'); }
      g.fillStyle = glass;
      if (r.arched) {
        g.beginPath(); g.arc(r.x + r.w / 2, r.y + r.w / 2, r.w / 2, Math.PI, 0); g.fill();
        g.fillRect(r.x, r.y + r.w / 2, r.w, r.h - r.w / 2);
      } else g.fillRect(r.x, r.y, r.w, r.h);
      if (!r.isDoor && !r.arched) {
        g.fillStyle = '#f6f3ec';
        g.fillRect(r.x + r.w / 2 - 1.5, r.y, 3, r.h);
        g.fillRect(r.x, r.y + r.h / 2 - 1.5, r.w, 3);
      }
    }
  });
  // Glass is smooth and slightly metallic so it mirrors the sky; plaster is not.
  const spec = makeCanvas(size[0], size[1], (g, w, h) => {
    g.fillStyle = 'rgb(0,235,0)';          // roughness .92, metalness 0
    g.fillRect(0, 0, w, h);
    for (const r of windowRects(w, h, rows, cols, opts)) {
      if (r.isDoor) { g.fillStyle = 'rgb(0,190,10)'; } else { g.fillStyle = 'rgb(0,38,150)'; }
      if (r.arched) {
        g.beginPath(); g.arc(r.x + r.w / 2, r.y + r.w / 2, r.w / 2, Math.PI, 0); g.fill();
        g.fillRect(r.x, r.y + r.w / 2, r.w, r.h - r.w / 2);
      } else g.fillRect(r.x, r.y, r.w, r.h);
    }
  });
  return {
    map: texture(albedo, { aniso: 8 }),
    spec: texture(spec, { srgb: false, aniso: 4 }),
  };
}

export function roofTiles() {
  const albedo = makeCanvas(256, 256, (g, w, h) => {
    const rnd = rng(5501);
    g.fillStyle = '#b4b0a8';
    g.fillRect(0, 0, w, h);
    const rowH = 16;
    for (let y = 0; y < h; y += rowH) {
      for (let x = 0; x < w; x += 14) {
        const off = (y / rowH) % 2 ? 7 : 0;
        const v = 168 + rnd() * 62;
        g.fillStyle = `rgb(${v | 0},${(v * 0.97) | 0},${(v * 0.93) | 0})`;
        g.beginPath();
        g.moveTo(x + off, y);
        g.lineTo(x + off + 13, y);
        g.lineTo(x + off + 13, y + rowH - 1);
        g.lineTo(x + off, y + rowH - 1);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(0,0,0,.26)';
        g.fillRect(x + off, y + rowH - 3, 13, 3);
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.fillRect(x + off + 12, y, 2, rowH);
      }
    }
  });
  const height = makeCanvas(256, 256, (g, w, h) => {
    g.fillStyle = '#404040';
    g.fillRect(0, 0, w, h);
    const rowH = 16;
    for (let y = 0; y < h; y += rowH) {
      for (let x = 0; x < w; x += 14) {
        const off = (y / rowH) % 2 ? 7 : 0;
        const grad = g.createLinearGradient(0, y, 0, y + rowH);
        grad.addColorStop(0, '#9a9a9a');
        grad.addColorStop(0.75, '#6a6a6a');
        grad.addColorStop(1, '#262626');
        g.fillStyle = grad;
        g.fillRect(x + off, y, 13, rowH - 1);
      }
    }
  });
  return { map: texture(albedo, { aniso: 8 }), normal: texture(heightToNormal(height, 2.6), { srgb: false }) };
}

export function corrugated() {
  const albedo = makeCanvas(128, 64, (g, w, h) => {
    speckle(g, w, h, 226, 18, 400, 2, 123);
    g.fillStyle = 'rgba(0,0,0,.20)';
    for (let x = 0; x < w; x += 8) g.fillRect(x, 0, 3, h);
    g.fillStyle = 'rgba(255,255,255,.14)';
    for (let x = 4; x < w; x += 8) g.fillRect(x, 0, 2, h);
    // Rust streaks.
    const rnd = rng(61);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(${120 + rnd() * 60 | 0},${70 + rnd() * 30 | 0},40,${0.05 + rnd() * 0.12})`;
      g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 5, 4 + rnd() * 24);
    }
  });
  const height = makeCanvas(128, 64, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 8, 0);
    grad.addColorStop(0, '#111');
    grad.addColorStop(0.5, '#eee');
    grad.addColorStop(1, '#111');
    for (let x = 0; x < w; x += 8) {
      g.save();
      g.translate(x, 0);
      g.fillStyle = grad;
      g.fillRect(0, 0, 8, h);
      g.restore();
    }
  });
  return { map: texture(albedo), normal: texture(heightToNormal(height, 1.8), { srgb: false }) };
}

export function concreteMaps() {
  const height = makeCanvas(256, 256, (g, w, h) => speckle(g, w, h, 128, 70, 7000, 2, 88));
  return { normal: texture(heightToNormal(height, 1.1), { srgb: false }) };
}

export function barkMaps() {
  const albedo = makeCanvas(128, 256, (g, w, h) => {
    const rnd = rng(211);
    g.fillStyle = '#4a3726';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      const x = rnd() * w;
      const v = 40 + rnd() * 60;
      g.fillStyle = `rgba(${v + 22 | 0},${v | 0},${(v * 0.72) | 0},.7)`;
      g.fillRect(x, rnd() * h, 1 + rnd() * 4, 12 + rnd() * 60);
    }
    for (let i = 0; i < 160; i++) {
      g.fillStyle = 'rgba(20,14,8,.45)';
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 20 + rnd() * 90);
    }
  });
  const height = makeCanvas(128, 256, (g, w, h) => {
    const rnd = rng(212);
    g.fillStyle = '#808080';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = Math.round(60 + rnd() * 150);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 4, 14 + rnd() * 70);
    }
  });
  return { map: texture(albedo), normal: texture(heightToNormal(height, 2.0), { srgb: false }) };
}

// Leafy canopy detail: a bumpy normal map so crowns catch the light unevenly.
export function leafMaps() {
  const height = makeCanvas(256, 256, (g, w, h) => {
    const rnd = rng(313);
    g.fillStyle = '#707070';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2200; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 3 + rnd() * 11;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const v = Math.round(110 + rnd() * 140);
      grad.addColorStop(0, `rgba(${v},${v},${v},.9)`);
      grad.addColorStop(1, 'rgba(40,40,40,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  // Near-white on purpose: the per-tree instance colour carries the hue, so
  // this map only breaks up the canopy. A dark green here would multiply with
  // the instance colour and turn every tree into a silhouette.
  const albedo = makeCanvas(256, 256, (g, w, h) => {
    const rnd = rng(314);
    g.fillStyle = '#f2f4ee';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 2 + rnd() * 9;
      g.fillStyle = `hsla(${80 + rnd() * 30}, ${10 + rnd() * 26}%, ${62 + rnd() * 30}%, .5)`;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
  });
  return { map: texture(albedo), normal: texture(heightToNormal(height, 2.4), { srgb: false }) };
}

// --- sky and water ---------------------------------------------------------

// Soft, lit cumulus puffs. The sun is assumed to come from the upper left, so
// the top edge is bright and the base is shaded.
export function cloudTextures(count = 3) {
  return Array.from({ length: count }, (_, n) => canvasTexture(512, 256, (g, w, h) => {
    const rnd = rng(77 + n * 913);
    g.clearRect(0, 0, w, h);
    const puffs = [];
    for (let i = 0; i < 30; i++) {
      const x = 70 + rnd() * (w - 140);
      const base = h * 0.66;
      const y = base - rnd() * rnd() * h * 0.42;
      const r = 26 + rnd() * 62 * (1 - (base - y) / h);
      puffs.push({ x, y, r: Math.max(16, r) });
    }
    // Shaded bellies first, bright tops over them.
    for (const p of puffs) {
      const grad = g.createRadialGradient(p.x, p.y + p.r * 0.35, 0, p.x, p.y + p.r * 0.35, p.r * 1.15);
      grad.addColorStop(0, 'rgba(118,132,152,.42)');
      grad.addColorStop(1, 'rgba(118,132,152,0)');
      g.fillStyle = grad;
      g.fillRect(p.x - p.r * 1.3, p.y - p.r * 1.3, p.r * 2.6, p.r * 2.6);
    }
    for (const p of puffs) {
      const grad = g.createRadialGradient(p.x - p.r * 0.3, p.y - p.r * 0.42, 0, p.x, p.y, p.r);
      grad.addColorStop(0, 'rgba(255,255,255,.92)');
      grad.addColorStop(0.55, 'rgba(246,249,255,.55)');
      grad.addColorStop(1, 'rgba(236,242,252,0)');
      g.fillStyle = grad;
      g.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    }
  }, { repeat: false, aniso: 4 }));
}

export function cirrusTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const streak = fbm(x / 120, y / 26, 4);
        const mask = fbm(x / 240 + 7, y / 240, 3);
        let a = (streak * 1.5 + 0.1) * (mask * 2.2);
        a = Math.max(0, Math.min(1, a));
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = a * 150;
      }
    }
    g.putImageData(img, 0, 0);
  }, { aniso: 4 });
}

// Scrolling ripple normals for the lake surface.
export function waterNormal(size = 256) {
  const height = makeCanvas(size, size, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = fbm(x / 18, y / 18, 3) + 0.5 * fbm(x / 6 + 31, y / 6, 2);
        const v = Math.max(0, Math.min(255, 128 + n * 150));
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
  return texture(heightToNormal(height, 1.4), { srgb: false });
}

// --- drone -----------------------------------------------------------------

// Radial smear used for the spinning propeller discs.
export function propBlur() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const rnd = rng(17);
    for (let i = 0; i < 520; i++) {
      const r0 = 14 + rnd() * (cx - 20);
      const a0 = rnd() * Math.PI * 2;
      const span = 0.25 + rnd() * 1.4;
      g.strokeStyle = `rgba(28,30,34,${0.05 + rnd() * 0.1})`;
      g.lineWidth = 1 + rnd() * 3;
      g.beginPath();
      g.arc(cx, cy, r0, a0, a0 + span);
      g.stroke();
    }
    // Hub shadow and tip darkening.
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, cx);
    grad.addColorStop(0, 'rgba(20,22,26,.55)');
    grad.addColorStop(0.18, 'rgba(20,22,26,.18)');
    grad.addColorStop(0.9, 'rgba(20,22,26,.14)');
    grad.addColorStop(1, 'rgba(20,22,26,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, cx, 0, 7);
    g.fill();
  }, { repeat: false, aniso: 4 });
}

export function padTexture(color, letter) {
  return canvasTexture(512, 512, (g, w, h) => {
    const c = w / 2;
    g.clearRect(0, 0, w, h);
    g.fillStyle = color;
    g.beginPath(); g.arc(c, c, c - 4, 0, 7); g.fill();
    const rnd = rng(9001);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`;
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    g.strokeStyle = '#fff';
    g.lineWidth = 24;
    g.beginPath(); g.arc(c, c, c * 0.78, 0, 7); g.stroke();
    g.lineWidth = 20;
    g.beginPath(); g.arc(c, c, c * 0.3, 0, 7); g.stroke();
    if (letter) {
      g.fillStyle = '#fff';
      g.font = 'bold 150px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(letter, c, c + 6);
    }
    // Scuffs so the pad does not look like clip art.
    g.strokeStyle = 'rgba(0,0,0,.18)';
    for (let i = 0; i < 40; i++) {
      g.lineWidth = 1 + rnd() * 3;
      g.beginPath();
      const a = rnd() * 7;
      const r = rnd() * c;
      g.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      g.lineTo(c + Math.cos(a + 0.4) * (r + 20), c + Math.sin(a + 0.4) * (r + 20));
      g.stroke();
    }
  }, { repeat: false, aniso: 8 });
}

// Soft radial glow for the navigation lights.
export function glowTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,.75)');
    grad.addColorStop(0.5, 'rgba(255,255,255,.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }, { repeat: false, aniso: 2 });
}
