// Everything that is drawn: sky, terrain, water, vegetation, the structures
// listed by terrain.js, the drone model, race gates and the camera views.
// Rendering goes through a post-processing chain (bloom, ACES tone mapping,
// a gentle colour grade and anti-aliasing) whose cost is set by the quality
// preset; none of this touches the flight model or controls.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import {
  TERRAIN_SIZE, WATER_LEVEL, ROAD_HALF_WIDTH, TURBINE_FRONT, fbm, turbineAngle, balloonPosition,
} from './terrain.js';

const SUN_DIR = new THREE.Vector3(0.45, 0.62, 0.35).normalize();
const GIMBAL_FOV = 51;   // 22 mm equivalent lens on a 16:9 frame
const HORIZON = 0xc9dff0;
const ZENITH = 0x2f6fc4;

// Visual presets. pixelRatio is capped to the display's own ratio so "Ultra"
// never upscales past what the screen can show. Everything here only changes
// how the scene looks or how expensive it is to draw.
export const QUALITY = {
  low: { label: 'Low', pixelRatio: 1, shadows: false, shadowMap: 0, treeShadows: false, post: false, bloom: 0, anisotropy: 2, clouds: 22 },
  medium: { label: 'Medium', pixelRatio: 1, shadows: true, shadowMap: 1024, treeShadows: false, post: true, bloom: 0.45, anisotropy: 4, clouds: 34 },
  high: { label: 'High', pixelRatio: 1.5, shadows: true, shadowMap: 2048, treeShadows: true, post: true, bloom: 0.6, anisotropy: 8, clouds: 46 },
  ultra: { label: 'Ultra', pixelRatio: 2, shadows: true, shadowMap: 4096, treeShadows: true, post: true, bloom: 0.7, anisotropy: 16, clouds: 46 },
};

// Final-image grade: a touch of contrast and saturation, and a soft vignette.
// Runs after tone mapping, in display colour, so the numbers are intuitive.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.055 },
    saturation: { value: 1.12 },
    vignette: { value: 0.32 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float contrast; uniform float saturation; uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = (c - 0.5) * contrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = clamp(mix(vec3(l), c, saturation), 0.0, 1.0);
      float d = length(vUv - 0.5);
      c *= mix(1.0, smoothstep(0.85, 0.32, d), vignette);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

function canvasTexture(width, height, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  draw(cv.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Speckled greyscale noise, used to break up flat colours.
function speckle(g, w, h, base, spread, count, size = 2) {
  g.fillStyle = `rgb(${base},${base},${base})`;
  g.fillRect(0, 0, w, h);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const v = Math.round(base + (rnd() - 0.5) * spread);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * w, rnd() * h, size + rnd() * size, size + rnd() * size * 2);
  }
}

// Wall with windows (and optionally a door); tinted by the material colour.
function facade(rows, cols, { door = false, arched = false, planks = false } = {}) {
  return canvasTexture(512, 256, (g, w, h) => {
    speckle(g, w, h, 235, 22, 1500);
    if (planks) {
      g.fillStyle = 'rgba(0,0,0,.25)';
      for (let x = 0; x < w; x += 16) g.fillRect(x, 0, 2, h);
    }
    const cw = w / cols;
    const rh = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isDoor = door && r === rows - 1 && c === Math.floor(cols / 2);
        const ww = cw * (isDoor ? 0.34 : 0.36);
        const wh = rh * (isDoor ? 0.72 : arched ? 0.7 : 0.42);
        const x = c * cw + (cw - ww) / 2;
        const y = isDoor ? (r + 1) * rh - wh : r * rh + rh * (arched ? 0.15 : 0.28);
        g.fillStyle = '#f4f1ea';
        g.fillRect(x - 4, y - 4, ww + 8, wh + (isDoor ? 4 : 8));
        g.fillStyle = isDoor ? '#5b4030' : '#2e3f52';
        if (arched) { g.beginPath(); g.arc(x + ww / 2, y + ww / 2, ww / 2, Math.PI, 0); g.fill(); g.fillRect(x, y + ww / 2, ww, wh - ww / 2); }
        else g.fillRect(x, y, ww, wh);
        if (!isDoor && !arched) {
          g.fillStyle = '#f4f1ea';
          g.fillRect(x + ww / 2 - 1.5, y, 3, wh);
          g.fillRect(x, y + wh / 2 - 1.5, ww, 3);
        }
      }
    }
  });
}

function roofGeometry() {
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5], E = [-0.5, 1, 0], F = [0.5, 1, 0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [D, C, F, D, F, E, B, A, E, B, E, F, A, D, E, C, B, F].flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

// Lumpy ball for rocks and tree crowns.
function lumpGeometry(detail, amount, seed) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + amount * fbm(x * 1.7 + seed, z * 1.7 + y * 1.3, 2);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

export class SimScene {
  constructor(canvas, terrain, quality = 'high') {
    this.terrain = terrain;
    this.settings = QUALITY[quality] || QUALITY.high;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(HORIZON, 300, 1500);
    this.camera = new THREE.PerspectiveCamera(GIMBAL_FOV, 1, 0.05, 4000);
    this.camera.rotation.order = 'YXZ';
    this.view = 'gimbal';
    this.chaseFov = 65;
    this.gates = [];
    this.materials = new Map();

    this.#lights();
    this.#sky();
    this.#environment();
    this.#clouds();
    this.#ground();
    this.#water();
    this.#road();
    this.#rocks();
    this.#parts();
    this.#turbines();
    this.#balloons();
    this.#homePad();
    this.droneModel = this.#drone();
    this.rebuildTrees();

    this.#buildComposer();
    this.applyQuality(quality);
    this.resize();
  }

  // Sky-lit reflections for the metal parts of the drone and the structures.
  // A one-off cube render of the sky dome, turned into a PMREM probe.
  #environment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileCubemapShader();
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(this.sky.geometry, this.sky.material));
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.65;
    pmrem.dispose();
  }

  #buildComposer() {
    this.composer?.dispose();
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.settings.bloom, 0.5, 0.82);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    const smaa = new SMAAPass();
    composer.addPass(smaa);
    this.composer = composer;
    this.bloomPass = bloom;
  }

  // Switch visual quality at any time. Only looks and cost change.
  applyQuality(name) {
    const s = QUALITY[name] || this.settings;
    this.settings = s;
    const pr = Math.min(s.pixelRatio, Math.max(1, window.devicePixelRatio || 1));
    this.renderer.setPixelRatio(pr);

    if (this.renderer.shadowMap.enabled !== s.shadows) {
      this.renderer.shadowMap.enabled = s.shadows;
      this.scene.traverse((o) => { if (o.material) this.#flagRecompile(o.material); });
    }
    if (s.shadows) {
      this.sun.shadow.mapSize.setScalar(s.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    for (const m of this.treeMeshes || []) m.castShadow = s.treeShadows;

    if (this.bloomPass) this.bloomPass.strength = s.bloom;
    for (const c of this.clouds || []) c.visible = c.userData.rank < s.clouds;
    this.#setAnisotropy(Math.min(s.anisotropy, this.maxAnisotropy));
    this.resize();
  }

  #flagRecompile(material) {
    for (const m of Array.isArray(material) ? material : [material]) m.needsUpdate = true;
  }

  #setAnisotropy(a) {
    for (const key of Object.keys(this.textures || {})) {
      const t = this.textures[key];
      for (const tex of Array.isArray(t) ? t : [t]) if (tex?.isTexture) tex.anisotropy = a;
    }
    if (this.groundDetail) this.groundDetail.anisotropy = a;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = this.renderer.getPixelRatio();
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #lights() {
    this.scene.add(new THREE.HemisphereLight(0xdcebff, 0x8a8f6a, 1.25));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -60; c.right = 60; c.top = 60; c.bottom = -60; c.near = 1; c.far = 400;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun, sun.target);
    this.sun = sun;
  }

  #sky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        sunDir: { value: SUN_DIR },
        horizon: { value: new THREE.Color(HORIZON) },
        zenith: { value: new THREE.Color(ZENITH) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 sunDir; uniform vec3 horizon; uniform vec3 zenith;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = mix(horizon, zenith, pow(max(d.y, 0.0), 0.55));
          float s = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.9, 0.7) * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.22);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 32, 16), mat);
    this.sky.renderOrder = -2;
    this.scene.add(this.sky);

    // Hazy mountains on the horizon so the world does not just stop.
    const seg = 96;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const h = 120 + 150 * Math.abs(fbm(Math.cos(a) * 3 + 9, Math.sin(a) * 3, 4)) + 40 * Math.sin(a * 5);
      pos.push(Math.cos(a) * 2300, -20, Math.sin(a) * 2300, Math.cos(a) * 2600, h, Math.sin(a) * 2600);
      if (i < seg) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const hills = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x8fa9c4, side: THREE.DoubleSide, fog: false }));
    hills.renderOrder = -1;
    this.scene.add(hills);
  }

  #clouds() {
    const textures = [0, 1, 2].map((n) => canvasTexture(256, 128, (g) => {
      let seed = 77 + n * 31;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 16; i++) {
        const x = 50 + rnd() * 156;
        const y = 50 + rnd() * 36;
        const r = 22 + rnd() * 30;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(255,255,255,.55)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 128);
      }
    }));
    this.clouds = [];
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 46; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: textures[i % 3], fog: false, depthWrite: false, transparent: true, opacity: 0.75 + rnd() * 0.2,
      }));
      const size = 320 + rnd() * 420;
      sprite.scale.set(size, size * 0.42, 1);
      sprite.position.set((rnd() - 0.5) * 5200, 330 + rnd() * 260, (rnd() - 0.5) * 5200);
      sprite.userData.rank = i;   // lower-quality presets show fewer clouds
      this.clouds.push(sprite);
      this.scene.add(sprite);
    }
  }

  #ground() {
    const seg = 350;
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, this.terrain.landHeight(p.getX(i), p.getZ(i)));
    geo.computeVertexNormals();

    const n = geo.attributes.normal;
    const colors = new Float32Array(p.count * 3);
    const lush = new THREE.Color(0x6f9a3c);
    const dry = new THREE.Color(0xa3a556);
    const dark = new THREE.Color(0x4e7a34);
    const sand = new THREE.Color(0xd8c796);
    const rock = new THREE.Color(0x8d8a80);
    const bed = new THREE.Color(0x5f6b52);
    const verge = new THREE.Color(0x8f8a70);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const h = p.getY(i);
      const patch = fbm(x / 90, z / 90, 3);
      c.copy(lush).lerp(dry, THREE.MathUtils.clamp(0.5 + patch * 1.4 + h * 0.012, 0, 1));
      c.lerp(dark, THREE.MathUtils.clamp(fbm(x / 35 + 40, z / 35, 2) * 1.6, 0, 0.6));
      c.lerp(rock, THREE.MathUtils.smoothstep(1 - n.getY(i), 0.1, 0.22));
      if (h < WATER_LEVEL + 1.4) c.lerp(sand, THREE.MathUtils.clamp((WATER_LEVEL + 1.4 - h) / 1.1, 0, 1));
      if (h < WATER_LEVEL - 0.5) c.lerp(bed, THREE.MathUtils.clamp((WATER_LEVEL - 0.5 - h) / 2, 0, 1));
      const rd = this.terrain.roadDistance(x, z);
      if (rd < 12) c.lerp(verge, 0.55 * (1 - rd / 12));
      colors.set([c.r * 1.25, c.g * 1.25, c.b * 1.25], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const detail = canvasTexture(256, 256, (g, w, h) => speckle(g, w, h, 205, 70, 9000, 1.5), true);
    detail.repeat.set(TERRAIN_SIZE / 14, TERRAIN_SIZE / 14);
    this.groundDetail = detail;
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, map: detail }));
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  #water() {
    this.waterMaterial = new THREE.ShaderMaterial({
      transparent: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 },
        sunDir: { value: SUN_DIR },
        horizon: { value: new THREE.Color(HORIZON) },
        zenith: { value: new THREE.Color(ZENITH) },
        deep: { value: new THREE.Color(0x12384f) },
      }]),
      vertexShader: `
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vec4 mvPosition = viewMatrix * world;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform float time; uniform vec3 sunDir; uniform vec3 horizon; uniform vec3 zenith; uniform vec3 deep;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        void main() {
          vec2 p = vWorld.xz;
          vec2 slope = vec2(0.0);
          slope += 0.035 * vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 0.9 + time * 1.3);
          slope += 0.030 * vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 1.7 - time * 1.7);
          slope += 0.020 * vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 3.1 + time * 2.4);
          slope /= 1.0 + distance(cameraPosition, vWorld) * 0.012;   // calmer far away, avoids shimmer
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          vec3 v = normalize(cameraPosition - vWorld);
          float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
          vec3 r = reflect(-v, n);
          vec3 sky = mix(horizon, zenith, pow(max(r.y, 0.0), 0.55));
          vec3 col = mix(deep, sky, fresnel);
          col += vec3(1.0, 0.9, 0.7) * pow(max(dot(r, sunDir), 0.0), 220.0) * 2.5;
          gl_FragColor = vec4(col, mix(0.78, 1.0, fresnel));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE).rotateX(-Math.PI / 2), this.waterMaterial);
    water.position.y = WATER_LEVEL;
    this.scene.add(water);
  }

  #road() {
    const road = this.terrain.road;
    const pos = [];
    const uv = [];
    const idx = [];
    road.forEach((s, i) => {
      const y = s.deck !== undefined ? s.deck + 0.04 : this.terrain.landHeight(s.x, s.z) + 0.2;
      for (const side of [-1, 1]) {
        pos.push(s.x - s.tz * side * ROAD_HALF_WIDTH, y, s.z + s.tx * side * ROAD_HALF_WIDTH);
        uv.push(side < 0 ? 0 : 1, s.s / 12);
      }
      if (i < road.length - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = canvasTexture(128, 256, (g, w, h) => {
      speckle(g, w, h, 70, 26, 2500);
      g.fillStyle = '#e8e8e0';
      g.fillRect(5, 0, 3, h);
      g.fillRect(w - 8, 0, 3, h);
      g.fillRect(w / 2 - 1.5, 0, 3, h * 0.5);
    }, true);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  rebuildTrees() {
    if (this.treeMeshes) for (const m of this.treeMeshes) { this.scene.remove(m); m.dispose(); }
    const conifers = this.terrain.trees.filter((t) => t.conifer);
    const broadleaf = this.terrain.trees.filter((t) => !t.conifer);
    const bark = new THREE.MeshLambertMaterial({ color: 0x5a4330 });
    const leaves = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
    const trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6).translate(0, 0.5, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    const meshes = [];
    const instanced = (geo, mat, count) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      meshes.push(mesh);
      this.scene.add(mesh);
      return mesh;
    };

    // Conifers: trunk and three overlapping tiers.
    const cTrunk = instanced(trunkGeo, bark, conifers.length);
    const tierGeo = new THREE.ConeGeometry(1, 1, 9).translate(0, 0.5, 0);
    const tiers = [[0.2, 0.62, 1], [0.42, 0.82, 0.72], [0.64, 1, 0.46]].map(() => instanced(tierGeo, leaves(), conifers.length));
    conifers.forEach((t, i) => {
      m.makeScale(0.28, t.height * 0.3 + 0.5, 0.28).setPosition(t.x, t.base - 0.5, t.z);
      cTrunk.setMatrixAt(i, m);
      color.setHSL(0.30 + t.shade * 0.06, 0.42, 0.17 + t.shade * 0.07);
      [[0.2, 0.62, 1], [0.42, 0.82, 0.72], [0.64, 1, 0.46]].forEach(([from, to, width], k) => {
        m.makeScale(t.radius * width, t.height * (to - from), t.radius * width).setPosition(t.x, t.base + t.height * from, t.z);
        tiers[k].setMatrixAt(i, m);
        tiers[k].setColorAt(i, color);
      });
    });

    // Broadleaf trees: trunk, a lumpy crown and a smaller side lobe.
    const bTrunk = instanced(trunkGeo, bark, broadleaf.length);
    const crowns = [instanced(lumpGeometry(2, 0.35, 1), leaves(), broadleaf.length), instanced(lumpGeometry(1, 0.35, 8), leaves(), broadleaf.length)];
    broadleaf.forEach((t, i) => {
      const crownY = t.base + t.height - t.radius;
      m.makeScale(0.3, t.height - t.radius + 0.5, 0.3).setPosition(t.x, t.base - 0.5, t.z);
      bTrunk.setMatrixAt(i, m);
      color.setHSL(0.22 + t.shade * 0.08, 0.48, 0.24 + t.shade * 0.1);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.shade * 6);
      m.compose(new THREE.Vector3(t.x, crownY, t.z), q, new THREE.Vector3(t.radius, t.radius * 0.88, t.radius));
      crowns[0].setMatrixAt(i, m);
      crowns[0].setColorAt(i, color);
      const a = t.shade * 20;
      m.compose(
        new THREE.Vector3(t.x + Math.cos(a) * t.radius * 0.5, crownY - t.radius * 0.25, t.z + Math.sin(a) * t.radius * 0.5),
        q, new THREE.Vector3(t.radius * 0.6, t.radius * 0.5, t.radius * 0.6));
      crowns[1].setMatrixAt(i, m);
      crowns[1].setColorAt(i, color.offsetHSL(0, 0, -0.03));
    });
    this.treeMeshes = meshes;
  }

  #rocks() {
    const rocks = this.terrain.rocks;
    const mesh = new THREE.InstancedMesh(lumpGeometry(1, 0.5, 3), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), rocks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    rocks.forEach((r, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r.spin);
      m.compose(new THREE.Vector3(r.x, r.y, r.z), q, new THREE.Vector3(r.size, r.size * r.squash, r.size * 1.15));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color.setHSL(0.09, 0.06, 0.42 + (r.spin % 1) * 0.15));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  #material(name, color) {
    const key = `${name}:${color ?? ''}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const lambert = (opts) => new THREE.MeshLambertMaterial(opts);
    const walls = (front, end) => {
      const side = lambert({ map: front, color });
      const gable = lambert({ map: end, color });
      const plain = lambert({ color });
      return [gable, gable, plain, plain, side, side];
    };
    this.textures ??= {
      house1: [facade(1, 4, { door: true }), facade(1, 2)],
      house2: [facade(2, 4, { door: true }), facade(2, 2)],
      church: [facade(1, 5, { arched: true }), facade(1, 1, { arched: true })],
      barn: [facade(1, 3, { door: true, planks: true }), facade(1, 1, { planks: true })],
      container: canvasTexture(128, 64, (g, w, h) => {
        speckle(g, w, h, 225, 20, 300);
        g.fillStyle = 'rgba(0,0,0,.22)';
        for (let x = 0; x < w; x += 8) g.fillRect(x, 0, 3, h);
      }),
    };
    const make = {
      concrete: () => lambert({ color: 0xa8a8a2 }),
      steel: () => lambert({ color: 0x6f757b }),
      pylon: () => lambert({ color: 0x8a9299, flatShading: true }),
      dark: () => lambert({ color: 0x24262a }),
      wood: () => lambert({ color: 0x7a5a3a }),
      white: () => lambert({ color: 0xf2f3f4 }),
      crane: () => lambert({ color: 0xf2b01e }),
      metal: () => new THREE.MeshStandardMaterial({ color: 0xc4c9ce, metalness: 0.8, roughness: 0.38, envMapIntensity: 1.1 }),
      steelPbr: () => new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.5, envMapIntensity: 0.9 }),
      lamp: () => new THREE.MeshBasicMaterial({ color: 0xfff3c4 }),
      paint: () => lambert({ color }),
      plaster: () => lambert({ color }),
      roof: () => lambert({ color: color ?? 0x8a3b2c, side: THREE.DoubleSide }),
      container: () => lambert({ color, map: this.textures.container }),
      house1: () => walls(...this.textures.house1),
      house2: () => walls(...this.textures.house2),
      church: () => walls(...this.textures.church),
      barn: () => walls(...this.textures.barn),
    };
    const mat = make[name]();
    this.materials.set(key, mat);
    return mat;
  }

  // Draws the structures listed by the terrain.
  #parts() {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitRoof = roofGeometry();
    const unitSphere = new THREE.SphereGeometry(1, 20, 12);
    const cableMat = new THREE.LineBasicMaterial({ color: 0x2b2d30 });
    for (const part of this.terrain.parts) {
      let mesh;
      if (part.kind === 'box') {
        mesh = new THREE.Mesh(unitBox, this.#material(part.mat, part.color));
        mesh.scale.set(part.w, part.h, part.d);
        mesh.rotation.set(0, part.yaw, part.tilt, 'YXZ');
      } else if (part.kind === 'roof') {
        mesh = new THREE.Mesh(unitRoof, this.#material(part.mat, part.color));
        mesh.scale.set(part.w, part.h, part.d);
        mesh.rotation.y = part.yaw;
      } else if (part.kind === 'cyl') {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(part.rTop, part.r, part.h, part.sides), this.#material(part.mat, part.color));
        if (part.sides === 4) mesh.rotation.y = Math.PI / 4;
      } else if (part.kind === 'sphere') {
        mesh = new THREE.Mesh(unitSphere, this.#material(part.mat, part.color));
        mesh.scale.setScalar(part.r);
      } else if (part.kind === 'line') {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(part.points.flat(), 3));
        this.scene.add(new THREE.Line(geo, cableMat));
        continue;
      } else if (part.kind === 'windsock') {
        mesh = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.8, 10, 1, true).rotateZ(Math.PI / 2).translate(0.9, 0, 0),
          new THREE.MeshLambertMaterial({ color: 0xff6a1a, side: THREE.DoubleSide }));
        mesh.rotation.y = -0.9;
      }
      mesh.position.set(part.x, part.y, part.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  #turbines() {
    const white = this.#material('white');
    this.rotors = this.terrain.turbines.map((t) => {
      const head = new THREE.Group();
      head.position.set(t.hub.x, t.hub.y, t.hub.z);
      head.rotation.y = t.facing;
      const nacelle = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 9), white);
      nacelle.position.z = -TURBINE_FRONT - 0.5;
      const rotor = new THREE.Group();
      rotor.add(new THREE.Mesh(new THREE.SphereGeometry(1.7, 14, 10), white));
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(
          new THREE.CylinderGeometry(0.25, 1.1, t.blade, 8).rotateZ(-Math.PI / 2).translate(t.blade / 2, 0, 0).scale(1, 1, 0.3),
          white,
        );
        blade.rotation.z = b * (Math.PI * 2 / 3);
        blade.castShadow = true;
        rotor.add(blade);
      }
      head.add(nacelle, rotor);
      this.scene.add(head);
      return { turbine: t, rotor };
    });
  }

  #balloons() {
    this.balloonMeshes = this.terrain.balloons.map((b) => {
      const group = new THREE.Group();
      const geo = new THREE.SphereGeometry(8, 24, 16);
      // Vertical stripes.
      const colors = [];
      const base = new THREE.Color(b.color);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const stripe = Math.floor((Math.atan2(p.getZ(i), p.getX(i)) / Math.PI + 1) * 6) % 2;
        const c = stripe ? base : new THREE.Color(0xf6f1e4);
        colors.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const envelope = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
      envelope.scale.y = 1.12;
      const throat = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 1.2, 5, 16, 1, true), new THREE.MeshLambertMaterial({ color: b.color, side: THREE.DoubleSide }));
      throat.position.y = -8.6;
      const basket = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.8), this.#material('wood'));
      basket.position.y = -11.8;
      group.add(envelope, throat, basket);
      this.scene.add(group);
      return { balloon: b, group };
    });
  }

  #pad(color, letter) {
    const tex = canvasTexture(256, 256, (g) => {
      g.fillStyle = color;
      g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 12;
      g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(128, 128, 40, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 60px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(letter, 128, 132);
    });
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    pad.receiveShadow = true;
    return pad;
  }

  #homePad() {
    const pad = this.#pad('#d9822b', 'H');
    pad.scale.setScalar(0.6);
    pad.position.set(0, this.terrain.groundHeight(0, 0) + 0.01, 0);
    this.scene.add(pad);
    this.targetPad = this.#pad('#2b7bd9', '');
    this.targetPad.visible = false;
    this.scene.add(this.targetPad);
  }

  showTargetPad(target) {
    this.targetPad.visible = !!target;
    if (!target) return;
    this.targetPad.scale.setScalar(target.radius);
    this.targetPad.position.set(target.x, this.terrain.groundHeight(target.x, target.z) + 0.05, target.z);
  }

  #drone() {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    // Light grey magnesium shell with a clear-coat sheen, dark composite parts.
    const grey = new THREE.MeshPhysicalMaterial({
      color: 0x9398a0, roughness: 0.42, metalness: 0.15,
      clearcoat: 0.7, clearcoatRoughness: 0.35, envMapIntensity: 1.0,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x25272b, roughness: 0.38, metalness: 0.25, envMapIntensity: 0.8 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0c10, roughness: 0.08, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.4 });
    const add = (geo, mat, x, y, z) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      root.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(0.085, 0.05, 0.18), grey, 0, 0.015, 0);
    add(new THREE.BoxGeometry(0.06, 0.02, 0.1), dark, 0, 0.045, 0.02);       // battery
    add(new THREE.SphereGeometry(0.03, 16, 12), dark, 0, -0.004, -0.09);     // gimbal housing
    add(new THREE.SphereGeometry(0.02, 16, 12), glass, 0, -0.006, -0.108);   // lens
    // Soft blurred discs stand in for the spinning blades (motion blur).
    const discTex = canvasTexture(128, 128, (g) => {
      for (let i = 0; i < 90; i++) {
        const a = (i / 90) * Math.PI * 2;
        g.strokeStyle = `rgba(30,30,34,${0.03 + 0.03 * Math.random()})`;
        g.lineWidth = 2 + Math.random() * 3;
        g.beginPath();
        g.arc(64, 64, 20 + Math.random() * 40, a, a + 0.5 + Math.random());
        g.stroke();
      }
    });
    this.props = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const mx = sx * 0.125;
      const mz = sz * 0.09;
      const arm = add(new THREE.BoxGeometry(0.11, 0.012, 0.018), grey, sx * 0.07, 0.02, sz * 0.065);
      arm.rotation.y = -sx * sz * 0.6;
      add(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 10), dark, mx, 0.03, mz);
      add(new THREE.BoxGeometry(0.008, 0.035, 0.008), dark, mx, -0.005, mz);  // leg
      const prop = add(new THREE.BoxGeometry(0.18, 0.003, 0.016), dark, mx, 0.05, mz);
      prop.castShadow = false;
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.1, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: discTex, color: 0x33363c, transparent: true, opacity: 0, depthWrite: false }),
      );
      disc.position.set(mx, 0.051, mz);
      root.add(disc);
      this.props.push({ prop, disc, dir: sx * sz });
      // Front LEDs red, rear LEDs green.
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.009, 8, 6),
        new THREE.MeshBasicMaterial({ color: sz < 0 ? 0xff2a2a : 0x2aff5a }),
      );
      led.position.set(mx, 0.012, mz);
      root.add(led);
    }
    this.scene.add(root);
    return root;
  }

  // gates: [{ x, y, z, nx, nz, radius }]
  setGates(gates) {
    for (const g of this.gates) this.scene.remove(g);
    this.gates = gates.map((gate) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(gate.radius, 0.22, 10, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }),
      );
      ring.position.set(gate.x, gate.y, gate.z);
      ring.rotation.y = Math.atan2(gate.nx, gate.nz);
      this.scene.add(ring);
      return ring;
    });
  }

  highlightGate(next) {
    this.gates.forEach((ring, i) => {
      const m = ring.material;
      if (i < next) { m.color.set(0x35d06a); m.opacity = 0.25; }
      else if (i === next) { m.color.set(0xff8a1f); m.opacity = 1; }
      else { m.color.set(0xffffff); m.opacity = 0.55; }
    });
  }

  cycleView() {
    this.view = { gimbal: 'chase', chase: 'pilot', pilot: 'gimbal' }[this.view];
    this.snapCamera = true;
    return this.view;
  }

  // time is the simulation clock, the same one the collision code uses.
  update(drone, dt, time) {
    const model = this.droneModel;
    const crashed = drone.state === 'crashed';
    model.position.set(drone.pos.x, drone.pos.y, drone.pos.z);
    model.rotation.set(crashed ? 0.5 : -drone.pitch, -drone.heading, crashed ? 2.6 : -drone.roll);
    model.visible = this.view !== 'gimbal';

    const spin = drone.motorsOn ? 40 + drone.throttleLevel * 90 : 0;
    const blur = THREE.MathUtils.clamp((spin - 25) / 55, 0, 1);
    for (const p of this.props) {
      p.prop.rotation.y += p.dir * spin * dt;
      p.prop.visible = blur < 1;              // solid blades give way to the blurred disc
      p.disc.visible = blur > 0;
      p.disc.rotation.y += p.dir * dt * 6;
      p.disc.material.opacity = 0.5 * blur;
    }

    for (const r of this.rotors) r.rotor.rotation.z = turbineAngle(r.turbine, time);
    for (const b of this.balloonMeshes) {
      const p = balloonPosition(b.balloon, time);
      b.group.position.set(p.x, p.y, p.z);
    }
    for (const c of this.clouds) {
      c.position.x += dt * 3;
      if (c.position.x > 2600) c.position.x -= 5200;
    }
    this.waterMaterial.uniforms.time.value = time;

    const cam = this.camera;
    const fx = Math.sin(drone.heading);
    const fz = -Math.cos(drone.heading);
    let fov = GIMBAL_FOV;
    if (this.view === 'gimbal') {
      cam.position.set(drone.pos.x + fx * 0.1, drone.pos.y, drone.pos.z + fz * 0.1);
      cam.rotation.set(drone.gimbal, -drone.heading, 0);
    } else if (this.view === 'chase') {
      // A little FOV stretch with speed to sell the sense of motion.
      fov = this.chaseFov + Math.min(drone.groundSpeed, 20) * 0.35;
      const target = new THREE.Vector3(drone.pos.x - fx * 1.5, drone.pos.y + 0.5, drone.pos.z - fz * 1.5);
      const floor = this.terrain.groundHeight(target.x, target.z) + 0.25;
      target.y = Math.max(target.y, floor);
      if (this.snapCamera) cam.position.copy(target);
      else cam.position.lerp(target, 1 - Math.exp(-dt * 8));
      cam.lookAt(drone.pos.x + fx * 1.5, drone.pos.y + 0.1, drone.pos.z + fz * 1.5);
    } else {
      const hx = drone.home.x + 1.5;
      const hz = drone.home.z + 3;
      cam.position.set(hx, this.terrain.groundHeight(hx, hz) + 1.7, hz);
      cam.lookAt(drone.pos.x, drone.pos.y, drone.pos.z);
      const dist = cam.position.distanceTo(model.position);
      fov = Math.max(6, Math.min(60, 700 / Math.max(dist, 1)));
    }
    this.snapCamera = false;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }

    this.sky.position.copy(cam.position);
    this.sun.position.set(drone.pos.x, drone.pos.y, drone.pos.z).addScaledVector(SUN_DIR, 160);
    this.sun.target.position.set(drone.pos.x, drone.pos.y, drone.pos.z);

    if (this.settings.post) this.composer.render(dt);
    else this.renderer.render(this.scene, cam);
  }
}
