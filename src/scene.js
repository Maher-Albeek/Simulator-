// Everything that is drawn: sky, terrain, water, vegetation, the structures
// listed by terrain.js, the drone model, race gates and the camera views.
//
// Rendering is a linear-light pipeline: the scene is drawn into a half-float
// HDR buffer with image-based lighting from the sky, then gfx/postfx.js adds
// ambient occlusion, aerial perspective, bloom and tone mapping. Nothing in
// here feeds back into the flight model - the renderer only reads the drone's
// state.

import * as THREE from '../vendor/three.module.min.js';
import {
  TERRAIN_SIZE, WATER_LEVEL, ROAD_HALF_WIDTH, TURBINE_FRONT, fbm, turbineAngle, balloonPosition,
} from './terrain.js';
import { ATMOSPHERE_GLSL } from './gfx/atmosphere.js';
import { PostFX } from './gfx/postfx.js';
import { ScatterLayer, tuftGeometry } from './gfx/scatter.js';
import { QUALITY, defaultQuality, saveQuality } from './gfx/quality.js';
import * as TEX from './gfx/textures.js';

const SUN_DIR = new THREE.Vector3(0.44, 0.58, 0.32).normalize();
const SUN_COLOR = new THREE.Color(0xfff2dd);
const GIMBAL_FOV = 51;   // 22 mm equivalent lens on a 16:9 frame
const GROUND_SEG = 350;

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

function roofGeometry() {
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5], E = [-0.5, 1, 0], F = [0.5, 1, 0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [D, C, F, D, F, E, B, A, E, B, E, F, A, D, E, C, B, F].flat(), 3));
  geo.computeVertexNormals();
  // Rough UVs so roof tiles have something to follow.
  const p = geo.attributes.position;
  const uv = [];
  for (let i = 0; i < p.count; i++) uv.push(p.getX(i) + 0.5, p.getZ(i) + 0.5 + p.getY(i));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// Gentle wind sway for instanced foliage, plus the vertical shading gradient
// that makes a canopy read as a canopy instead of a painted blob: the underside
// of every crown and tier is darkened, standing in for light that never gets
// through the leaves. The sway offset is applied in world space after the
// instance matrix, so scale and rotation do not distort it.
function windSway(material, shared, canopy = [0.5, 0.5]) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.time;
    shader.uniforms.uWind = shared.wind;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCanopy;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(0.34, 1.12, vCanopy);`);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uWind;
        varying float vCanopy;
        attribute float aSway; attribute float aPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCanopy = clamp(position.y * float(${canopy[0]}) + float(${canopy[1]}), 0.0, 1.0);`)
      .replace('#include <project_vertex>', `
        vec4 swayPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          swayPos = instanceMatrix * swayPos;
        #endif
        float swayT = uTime * 0.9 + aPhase;
        float gust = 0.6 + 0.4 * sin(uTime * 0.31 + aPhase * 0.4);
        swayPos.xz += vec2(sin(swayT) + 0.35 * sin(swayT * 2.7), cos(swayT * 0.86)) * aSway * uWind * gust;
        vec4 mvPosition = modelViewMatrix * swayPos;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  material.customProgramCacheKey = () => `windSway-${canopy.join('-')}`;
}

export class SimScene {
  constructor(canvas, terrain, qualityName = defaultQuality()) {
    this.terrain = terrain;
    this.qualityName = QUALITY[qualityName] ? qualityName : 'high';
    this.q = QUALITY[this.qualityName];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,            // MSAA happens on the HDR target instead
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.renderer.shadowMap.type = this.q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;   // tone mapped in the post stack

    this.scene = new THREE.Scene();
    this.scene.fog = null;                             // aerial perspective is done in post
    this.camera = new THREE.PerspectiveCamera(GIMBAL_FOV, 1, 0.08, 8000);
    this.camera.rotation.order = 'YXZ';
    this.view = 'gimbal';
    this.gates = [];
    this.materials = new Map();
    this.shared = {
      time: { value: 0 },
      wind: { value: 1 },
    };
    this.chaseLook = new THREE.Vector3();
    this.chasePos = new THREE.Vector3();
    this.pilotFov = 40;

    this.#textures();
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
    this.#distantForest();
    this.droneModel = this.#drone();
    this.rebuildTrees();

    this.post = new PostFX(this.renderer, this.q);
    this.#scatter();
    this.resize();
  }

  // ------------------------------------------------------------- quality

  get quality() { return this.qualityName; }

  setQuality(name) {
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    const q = this.q = QUALITY[name];
    saveQuality(name);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    const type = q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== type) {
      this.renderer.shadowMap.type = type;
      this.scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }
    this.#applyShadowQuality();
    this.post.setQuality(q);
    this.#scatter();
    this.#applyCloudQuality();
    this.#applyForestQuality();
    this.rebuildTrees();
    this.waterMaterial.uniforms.uDetail.value = q.waterDetail;
    this.resize();
  }

  #applyShadowQuality() {
    const sun = this.sun;
    const q = this.q;
    if (sun.shadow.mapSize.x !== q.shadowMapSize) {
      sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    const d = q.shadowDistance;
    const c = sun.shadow.camera;
    c.left = -d; c.right = d; c.top = d; c.bottom = -d;
    c.near = 1;
    c.far = d * 4 + 200;
    c.updateProjectionMatrix();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const ratio = this.renderer.getPixelRatio();
    this.post.setSize(w * ratio, h * ratio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- textures

  #textures() {
    this.tex = {
      grass: TEX.texture(TEX.grassAlbedo(512)),
      grassNormal: TEX.texture(TEX.heightToNormal(TEX.grassHeight(256), 1.6), { srgb: false }),
      rock: TEX.texture(TEX.rockAlbedo(512)),
      macro: TEX.texture(TEX.macroNoise(256), { srgb: false }),
      asphalt: TEX.texture(TEX.asphalt(256)),
      roof: TEX.roofTiles(),
      corrugated: TEX.corrugated(),
      concrete: TEX.concreteMaps(),
      bark: TEX.barkMaps(),
      leaf: TEX.leafMaps(),
      water: TEX.waterNormal(256),
      glow: TEX.glowTexture(),
      prop: TEX.propBlur(),
      clouds: TEX.cloudTextures(3),
      cirrus: TEX.cirrusTexture(),
      facades: {
        house1: [TEX.facade(1, 4, { door: true }), TEX.facade(1, 2)],
        house2: [TEX.facade(2, 4, { door: true }), TEX.facade(2, 2)],
        church: [TEX.facade(1, 5, { arched: true }), TEX.facade(1, 1, { arched: true })],
        barn: [TEX.facade(1, 3, { door: true, planks: true }), TEX.facade(1, 1, { planks: true })],
      },
    };
    const aniso = Math.min(this.renderer.capabilities.getMaxAnisotropy(), this.q.anisotropy);
    const walk = (o) => {
      if (o instanceof THREE.Texture) { o.anisotropy = aniso; return; }
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') Object.values(o).forEach(walk);
    };
    walk(this.tex);
  }

  // --------------------------------------------------------------- lights

  #lights() {
    // A small hemisphere term on top of the sky IBL: it only tints the shadows.
    this.scene.add(new THREE.HemisphereLight(0xbcd6f5, 0x6b7355, 0.45));

    const sun = new THREE.DirectionalLight(SUN_COLOR, 3.1);
    sun.castShadow = true;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2.2;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.#applyShadowQuality();

    // Bounce light from the ground, so undersides are never pitch black.
    const bounce = new THREE.DirectionalLight(0xbfa978, 0.22);
    bounce.position.set(-SUN_DIR.x, -0.8, -SUN_DIR.z);
    this.scene.add(bounce);
  }

  // ------------------------------------------------------------------ sky

  #skyMaterial() {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { sunDir: { value: SUN_DIR } },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 sunDir;
        varying vec3 vDir;
        ${ATMOSPHERE_GLSL}
        void main() {
          gl_FragColor = vec4(skyWithSun(normalize(vDir), sunDir), 1.0);
        }`,
    });
  }

  #sky() {
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 48, 24), this.#skyMaterial());
    this.sky.renderOrder = -3;
    this.scene.add(this.sky);

    // Layered ridges on the horizon so the world does not just stop. They are
    // drawn with the same atmosphere model, at the haze colour for their
    // distance, which makes them read as genuine aerial perspective.
    const ridge = (radius, height, seed, fade, colour) => {
      const seg = 160;
      const pos = [];
      const idx = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const h = height * (0.55 + 0.75 * Math.abs(fbm(Math.cos(a) * 3 + seed, Math.sin(a) * 3 + seed, 4)))
          + height * 0.22 * Math.sin(a * 7 + seed);
        pos.push(Math.cos(a) * radius, -30, Math.sin(a) * radius, Math.cos(a) * radius, h, Math.sin(a) * radius);
        if (i < seg) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      // Opaque on purpose: the ridges write depth, so the aerial-perspective
      // pass hazes each band by its true distance instead of a fixed fade.
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(colour).multiplyScalar(fade), side: THREE.DoubleSide,
      }));
      this.scene.add(mesh);
    };
    ridge(2650, 330, 9, 0.52, 0x6f8498);
    ridge(2180, 210, 23, 0.46, 0x66809a);
    ridge(1720, 120, 41, 0.40, 0x5d7a86);
  }

  // Image-based lighting: pre-filter the sky into an environment map so every
  // material picks up sky colour, ground bounce and real reflections.
  #environment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.#skyMaterial()));
    // A dull ground plane keeps reflections from being lit from below by sky.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3f4536 }),
    );
    floor.position.y = -8;
    envScene.add(floor);
    const target = pmrem.fromScene(envScene, 0, 1, 500);
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
    envScene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  #clouds() {
    this.clouds = [];
    const rnd = (() => { let s = 5; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    const layers = [
      { y: 430, spread: 6200, size: [620, 1250], opacity: [0.62, 0.9], bright: 1.5 },
      { y: 760, spread: 8200, size: [900, 1900], opacity: [0.42, 0.72], bright: 1.32 },
      { y: 1180, spread: 10500, size: [1400, 2700], opacity: [0.24, 0.46], bright: 1.18 },
    ];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      for (let i = 0; i < 24; i++) {
        const mat = new THREE.SpriteMaterial({
          map: this.tex.clouds[i % this.tex.clouds.length],
          fog: false,
          depthWrite: false,
          transparent: true,
          opacity: L.opacity[0] + rnd() * (L.opacity[1] - L.opacity[0]),
        });
        mat.color.setScalar(L.bright);     // over 1 so cloud tops catch the bloom
        const sprite = new THREE.Sprite(mat);
        const size = L.size[0] + rnd() * (L.size[1] - L.size[0]);
        sprite.scale.set(size, size * (0.34 + rnd() * 0.16), 1);
        sprite.position.set((rnd() - 0.5) * L.spread, L.y + rnd() * 160, (rnd() - 0.5) * L.spread);
        sprite.renderOrder = -1;
        sprite.userData.layer = li;
        sprite.userData.spread = L.spread;
        sprite.userData.drift = 2 + li * 1.6;
        this.clouds.push(sprite);
        this.scene.add(sprite);
      }
    }

    // High cirrus sheet, for depth above the cumulus.
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: this.tex.cirrus, transparent: true, opacity: 0.5, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }),
    );
    sheet.material.map.repeat.set(3, 3);
    sheet.material.color.setScalar(1.3);
    sheet.position.y = 1750;
    sheet.renderOrder = -1;
    this.scene.add(sheet);
    this.cirrus = sheet;
    this.#applyCloudQuality();
  }

  #applyCloudQuality() {
    const max = this.q.clouds;
    const layers = this.q.cloudLayers;
    let shown = 0;
    for (const c of this.clouds) {
      const ok = c.userData.layer < layers && shown < max;
      c.visible = ok;
      if (ok) shown++;
    }
    if (this.cirrus) this.cirrus.visible = this.q.cloudLayers >= 3;
  }

  // --------------------------------------------------------------- ground

  #ground() {
    const seg = GROUND_SEG;
    const n = seg + 1;
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;

    // One pass over the grid fills the mesh, the vertex colours, the slope
    // attribute and the two data textures the grass and water shaders read.
    for (let i = 0; i < p.count; i++) p.setY(i, this.terrain.landHeight(p.getX(i), p.getZ(i)));
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;

    const colors = new Float32Array(p.count * 3);
    const slopes = new Float32Array(p.count);
    const field = new Uint16Array(p.count * 4);       // height, cover, slope (half float)
    const albedo = new Uint8Array(p.count * 4);
    const half = THREE.DataUtils.toHalfFloat;

    // Meadow greens as they photograph from the air: olive rather than emerald.
    const lush = new THREE.Color(0x66803f);
    const dry = new THREE.Color(0x97965e);
    const dark = new THREE.Color(0x4e6434);
    const sand = new THREE.Color(0xc9ba91);
    const rock = new THREE.Color(0x8b857a);
    const bed = new THREE.Color(0x56604a);
    const verge = new THREE.Color(0x8d8870);
    const c = new THREE.Color();

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const h = p.getY(i);
      const flat = nrm.getY(i);
      const steep = THREE.MathUtils.clamp((1 - flat) / 0.25, 0, 1);
      const patch = fbm(x / 90, z / 90, 3);
      c.copy(lush).lerp(dry, THREE.MathUtils.clamp(0.5 + patch * 1.4 + h * 0.012, 0, 1));
      c.lerp(dark, THREE.MathUtils.clamp(fbm(x / 35 + 40, z / 35, 2) * 1.6, 0, 0.6));
      c.lerp(rock, THREE.MathUtils.smoothstep(1 - flat, 0.14, 0.3));
      if (h < WATER_LEVEL + 1.4) c.lerp(sand, THREE.MathUtils.clamp((WATER_LEVEL + 1.4 - h) / 1.1, 0, 1));
      if (h < WATER_LEVEL - 0.5) c.lerp(bed, THREE.MathUtils.clamp((WATER_LEVEL - 0.5 - h) / 2, 0, 1));
      const rd = this.terrain.roadDistance(x, z);
      if (rd < 12) c.lerp(verge, 0.55 * (1 - rd / 12));
      colors.set([c.r, c.g, c.b], i * 3);
      slopes[i] = steep;

      // Where ground cover may grow: not on water, sand, road or steep rock.
      let cover = 1;
      cover *= THREE.MathUtils.clamp((h - (WATER_LEVEL + 1.1)) / 1.6, 0, 1);
      cover *= 1 - THREE.MathUtils.smoothstep(steep, 0.45, 0.9);
      cover *= THREE.MathUtils.clamp((rd - (ROAD_HALF_WIDTH + 1.5)) / 5, 0, 1);
      cover *= THREE.MathUtils.clamp(0.78 + fbm(x / 60 + 3, z / 60 - 7, 3) * 1.7, 0, 1);
      field[i * 4] = half(h);
      field[i * 4 + 1] = half(cover);
      field[i * 4 + 2] = half(steep);
      field[i * 4 + 3] = half(1);
      albedo[i * 4] = Math.min(255, c.r * 255);
      albedo[i * 4 + 1] = Math.min(255, c.g * 255);
      albedo[i * 4 + 2] = Math.min(255, c.b * 255);
      albedo[i * 4 + 3] = 255;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSlope', new THREE.BufferAttribute(slopes, 1));

    const heightTex = new THREE.DataTexture(field, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
    heightTex.minFilter = heightTex.magFilter = THREE.LinearFilter;
    heightTex.needsUpdate = true;
    const albedoTex = new THREE.DataTexture(albedo, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    albedoTex.minFilter = albedoTex.magFilter = THREE.LinearFilter;
    albedoTex.needsUpdate = true;
    // Texel centres sit on the grid samples, so stretch the lookup slightly.
    this.terrainField = { heightTex, albedoTex, size: TERRAIN_SIZE * n / (n - 1) };

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.tex.grass,
      normalMap: this.tex.grassNormal,
      roughness: 0.94,
      metalness: 0,
    });
    mat.map.repeat.set(TERRAIN_SIZE / 7, TERRAIN_SIZE / 7);
    mat.normalMap.repeat.copy(mat.map.repeat);
    mat.normalScale.set(0.75, 0.75);
    const rockTex = this.tex.rock;
    const macroTex = this.tex.macro;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRock = { value: rockTex };
      shader.uniforms.uMacro = { value: macroTex };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSlope;\nvarying float vSlope;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlope = aSlope;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uRock; uniform sampler2D uMacro; varying float vSlope;`)
        // The detail maps modulate the vertex colour rather than replacing it:
        // each one is normalised around its own mean so the terrain keeps the
        // albedo the colour pass gave it, with texture on top.
        .replace('#include <map_fragment>', /* glsl */`
          const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
          vec3 fine = texture2D(map, vMapUv).rgb;
          vec3 wide = texture2D(map, vMapUv * 0.197).rgb;
          vec3 blend = mix(fine, wide, 0.42);
          float macro = texture2D(uMacro, vMapUv * 0.0135).r;
          float mid = texture2D(uMacro, vMapUv * 0.082).g;
          // Detail is used as a brightness modulation around 1 with only a
          // little of its own colour, otherwise the green stacks twice.
          float lum = dot(blend, LUMA) / 0.155;
          vec3 surface = vec3(lum) * mix(vec3(1.0), blend / max(dot(blend, LUMA), 1e-3), 0.22);
          surface *= (0.82 + 0.36 * macro) * (0.90 + 0.20 * mid);
          vec3 rockCol = texture2D(uRock, vMapUv * 0.31).rgb;
          float rockLum = dot(rockCol, LUMA) / 0.185;
          surface = mix(surface, vec3(rockLum) * (0.85 + 0.3 * macro), smoothstep(0.38, 0.85, vSlope));
          diffuseColor.rgb *= clamp(surface, vec3(0.0), vec3(2.2));
        `)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.82, smoothstep(0.4, 0.85, vSlope));`);
    };
    mat.customProgramCacheKey = () => 'ground';

    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.scene.add(ground);
    this.groundMesh = ground;
  }

  // ---------------------------------------------------------------- water

  #water() {
    const field = this.terrainField;
    this.waterMaterial = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        time: { value: 0 },
        sunDir: { value: SUN_DIR },
        uHeight: { value: field.heightTex },
        uTerrainSize: { value: field.size },
        uRipple: { value: this.tex.water },
        uDetail: { value: this.q.waterDetail },
        deep: { value: new THREE.Color(0x183f55) },
        shallow: { value: new THREE.Color(0x3d7f70) },
        level: { value: WATER_LEVEL },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */`
        uniform float time; uniform vec3 sunDir; uniform vec3 deep; uniform vec3 shallow;
        uniform sampler2D uHeight; uniform sampler2D uRipple; uniform float uTerrainSize;
        uniform float uDetail; uniform float level;
        varying vec3 vWorld;
        ${ATMOSPHERE_GLSL}

        void main() {
          vec2 p = vWorld.xz;
          float toCam = distance(cameraPosition, vWorld);
          float calm = exp(-toCam * 0.022);            // flatten far away, kills shimmer

          vec2 slope = vec2(0.0);
          slope += 0.035 * vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 0.9 + time * 1.3);
          slope += 0.030 * vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 1.7 - time * 1.7);
          slope += 0.020 * vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 3.1 + time * 2.4);
          if (uDetail > 0.5) {
            slope += 0.013 * vec2(0.95, -0.3) * cos(dot(p, vec2(0.95, -0.3)) * 5.3 - time * 3.1);
            vec3 r1 = texture2D(uRipple, p * 0.09 + vec2(time * 0.012, time * 0.009)).xyz * 2.0 - 1.0;
            vec3 r2 = texture2D(uRipple, p * 0.21 - vec2(time * 0.018, time * 0.004)).xyz * 2.0 - 1.0;
            slope += (r1.xy * 0.10 + r2.xy * 0.06) * calm;
          }
          slope *= calm;
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

          // Bed depth from the baked terrain field: shallows go green, the
          // shoreline gets a foam band, and the edge fades out instead of
          // ending in a hard line.
          vec2 huv = p / uTerrainSize + 0.5;
          float bed = texture2D(uHeight, huv).r;
          float depth = max(level - bed, 0.0);
          float shoal = exp(-depth * 0.55);

          vec3 v = normalize(cameraPosition - vWorld);
          float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
          vec3 refl = reflect(-v, n);
          refl.y = abs(refl.y);
          vec3 sky = skyRadiance(refl, sunDir);
          vec3 body = mix(deep, shallow, shoal);
          vec3 col = mix(body, sky, fresnel);
          // Light scattered back out of the water body, and the sky that
          // always sits on the surface even when looking straight down.
          col += body * 0.35 + sky * 0.10;
          float spec = pow(max(dot(refl, sunDir), 0.0), 380.0);
          col += SUN_TINT * spec * 7.0 * (0.35 + 0.65 * calm);
          col += SUN_TINT * mieLobe(dot(refl, sunDir), 0.62) * 0.6 * fresnel;

          // Foam: a moving band where the water meets the shore.
          float band = smoothstep(0.55, 0.0, depth);
          float wobble = 0.5 + 0.5 * sin(dot(p, vec2(1.7, 1.3)) - time * 2.1 + texture2D(uRipple, p * 0.05).r * 6.0);
          float foam = band * (0.3 + 0.7 * wobble) * smoothstep(0.03, 0.3, depth) * 0.75;
          col = mix(col, vec3(0.9, 0.95, 0.98), clamp(foam, 0.0, 0.8));

          float alpha = mix(0.90, 1.0, fresnel) * smoothstep(0.0, 0.14, depth);
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 1, 1).rotateX(-Math.PI / 2), this.waterMaterial);
    water.position.y = WATER_LEVEL;
    water.renderOrder = 2;
    this.scene.add(water);
  }

  // ----------------------------------------------------------------- road

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
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: this.tex.asphalt,
      roughness: 0.72,
      metalness: 0.02,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------ vegetation

  #scatter() {
    for (const layer of this.scatterLayers || []) layer.dispose();
    this.scatterLayers = [];
    const q = this.q;
    if (!q.grass) return;
    const field = this.terrainField;

    const grass = new ScatterLayer(this.scene, tuftGeometry(q.grassBlades, q.grassSegments, 0.022, 0.1), {
      spacing: q.grassSpacing,
      side: q.grass,
      radius: q.grass * q.grassSpacing * 0.49,
      wind: 1,
      sizeRange: [0.15, 0.32],
      shade: [0.6, 1.22],
      roughness: 0.78,
      saturate: 0.85,
      lean: 1,
      name: 'grass',
    });
    grass.setTerrain(field.heightTex, field.albedoTex, field.size);
    this.scatterLayers.push(grass);

    if (q.clump) {
      const clump = new ScatterLayer(this.scene, tuftGeometry(11, 3, 0.05, 0.28), {
        spacing: 3.2,
        side: q.clump,
        radius: q.clump * 3.2 * 0.47,
        wind: 0.5,
        sizeRange: [0.45, 1.05],
        roughness: 0.8,
        saturate: 1.0,
        lean: 0.8,
        shade: [0.6, 0.95],
        name: 'clump',
      });
      clump.setTerrain(field.heightTex, field.albedoTex, field.size);
      this.scatterLayers.push(clump);
    }
  }

  rebuildTrees() {
    if (this.treeMeshes) {
      for (const m of this.treeMeshes) {
        this.scene.remove(m);
        m.dispose();
        m.geometry.dispose();
        m.material.dispose();
      }
    }
    const detail = this.q.treeDetail;
    const conifers = this.terrain.trees.filter((t) => t.conifer);
    const broadleaf = this.terrain.trees.filter((t) => !t.conifer);

    const bark = new THREE.MeshStandardMaterial({
      map: this.tex.bark.map, normalMap: this.tex.bark.normal, roughness: 0.92, metalness: 0,
    });
    bark.map.repeat.set(1, 2);
    bark.normalMap.repeat.set(1, 2);
    const leafMat = (canopy) => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: this.tex.leaf.map,
        normalMap: detail > 0 ? this.tex.leaf.normal : null,
        roughness: 0.85,
        metalness: 0,
      });
      m.normalScale.set(1.4, 1.4);
      windSway(m, this.shared, canopy);
      return m;
    };
    const trunkGeo = new THREE.CylinderGeometry(0.55, 1, 1, detail > 0 ? 8 : 5).translate(0, 0.5, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    const meshes = [];
    const instanced = (geo, mat, rawCount, sway) => {
      // Each instanced mesh gets its own copy: the per-instance sway and phase
      // attributes live on the geometry, so sharing one would cross the wires.
      const count = Math.max(1, rawCount);
      const mesh = new THREE.InstancedMesh(geo.clone(), mat, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      // Per-instance sway strength and phase for the wind shader.
      const swayA = new Float32Array(count);
      const phase = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        swayA[i] = sway;
        phase[i] = (i * 2.399) % 6.283;
      }
      mesh.geometry.setAttribute('aSway', new THREE.InstancedBufferAttribute(swayA, 1));
      mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      meshes.push(mesh);
      this.scene.add(mesh);
      return mesh;
    };

    // Conifers: trunk and overlapping tiers, denser on higher presets.
    const tierPlan = detail > 0
      ? [[0.14, 0.52, 1.0], [0.3, 0.68, 0.84], [0.46, 0.82, 0.64], [0.62, 0.93, 0.45], [0.78, 1.0, 0.26]]
      : [[0.2, 0.62, 1], [0.42, 0.82, 0.72], [0.64, 1, 0.46]];
    const cTrunk = instanced(trunkGeo, bark, conifers.length, 0);
    const tierGeo = new THREE.ConeGeometry(1, 1, detail > 0 ? 11 : 7).translate(0, 0.5, 0);
    const tiers = tierPlan.map(() => instanced(tierGeo, leafMat([1, 0]), conifers.length, 0.08));
    conifers.forEach((t, i) => {
      m.makeScale(0.26, t.height * 0.34 + 0.5, 0.26).setPosition(t.x, t.base - 0.5, t.z);
      cTrunk.setMatrixAt(i, m);
      color.setHSL(0.255 + t.shade * 0.075, 0.4 + t.shade * 0.22, 0.2 + t.shade * 0.11);
      tierPlan.forEach(([from, to, width], k) => {
        const lean = (t.shade - 0.5) * 0.08;
        q.setFromAxisAngle(new THREE.Vector3(Math.cos(t.shade * 9), 0, Math.sin(t.shade * 9)), lean);
        m.compose(
          new THREE.Vector3(t.x, t.base + t.height * from, t.z), q,
          new THREE.Vector3(t.radius * width * 1.05, t.height * (to - from) * 1.25, t.radius * width * 1.05),
        );
        tiers[k].setMatrixAt(i, m);
        tiers[k].setColorAt(i, color.clone().offsetHSL(0, 0, k * 0.012));
      });
      tiers.forEach((mesh) => { mesh.geometry.attributes.aSway.array[i] = 0.05 + t.height * 0.006; });
    });

    // Broadleaf trees: trunk and a cluster of lumpy crowns.
    const bTrunk = instanced(trunkGeo, bark, broadleaf.length, 0);
    const lobes = detail > 1
      ? [[0, 0, 0, 1, 0], [0.55, -0.22, 0.4, 0.62, 1], [-0.5, -0.1, -0.45, 0.55, 2.2], [0.1, 0.3, -0.3, 0.5, 4.1]]
      : [[0, 0, 0, 1, 0], [0.5, -0.25, 0.45, 0.6, 1]];
    const crowns = lobes.map((_, k) => instanced(lumpGeometry(detail > 0 ? 2 : 1, 0.38, 1 + k * 7), leafMat([0.5, 0.5]), broadleaf.length, 0.18));
    broadleaf.forEach((t, i) => {
      const crownY = t.base + t.height - t.radius * 0.9;
      m.makeScale(0.28, t.height - t.radius + 0.5, 0.28).setPosition(t.x, t.base - 0.5, t.z);
      bTrunk.setMatrixAt(i, m);
      color.setHSL(0.185 + t.shade * 0.085, 0.42 + t.shade * 0.22, 0.235 + t.shade * 0.12);
      const spin = t.shade * 6;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, spin);
      lobes.forEach(([ox, oy, oz, scale, hueShift], k) => {
        const a = spin + hueShift;
        m.compose(
          new THREE.Vector3(
            t.x + Math.cos(a) * ox * t.radius,
            crownY + oy * t.radius,
            t.z + Math.sin(a) * oz * t.radius,
          ),
          q,
          new THREE.Vector3(t.radius * scale, t.radius * scale * 0.9, t.radius * scale),
        );
        crowns[k].setMatrixAt(i, m);
        crowns[k].setColorAt(i, color.clone().offsetHSL(0, 0, -0.02 * k + (k === 0 ? 0 : 0.01)));
        crowns[k].geometry.attributes.aSway.array[i] = 0.1 + t.radius * 0.03;
      });
    });
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.attributes.aSway.needsUpdate = true;
    }
    trunkGeo.dispose();
    tierGeo.dispose();
    this.treeMeshes = meshes;
  }

  // Render-only forest band outside the flight area, so the middle distance is
  // never bare. Nothing here has a collision volume - the drone cannot reach it.
  #distantForest() {
    const count = 2600;
    const group = new THREE.Group();
    const rnd = (() => { let s = 1337; return () => ((s = (s * 48271) % 2147483647) / 2147483647); })();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a6b3a, roughness: 0.9, metalness: 0, flatShading: true });
    const coneGeo = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0);
    const lumpGeo = lumpGeometry(1, 0.4, 5);
    const cones = new THREE.InstancedMesh(coneGeo, mat, count);
    const lumps = new THREE.InstancedMesh(lumpGeo, mat, count);
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    let ci = 0;
    let li = 0;
    for (let i = 0; i < count * 3 && ci + li < count * 2; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 880 + rnd() * 620;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) > TERRAIN_SIZE / 2 - 60 || Math.abs(z) > TERRAIN_SIZE / 2 - 60) continue;
      const base = this.terrain.landHeight(x, z);
      if (base < WATER_LEVEL + 1) continue;
      if (fbm(x / 130 + 5, z / 130 - 3, 2) < 0.0) continue;
      const height = 8 + rnd() * 12;
      const conifer = rnd() < 0.55;
      color.setHSL(0.26 + rnd() * 0.07, 0.4, 0.14 + rnd() * 0.08);
      if (conifer && ci < count) {
        m.makeScale(height * 0.22, height, height * 0.22).setPosition(x, base, z);
        cones.setMatrixAt(ci, m);
        cones.setColorAt(ci, color);
        ci++;
      } else if (li < count) {
        const rad = height * 0.38;
        m.makeScale(rad, rad * 0.85, rad).setPosition(x, base + height * 0.55, z);
        lumps.setMatrixAt(li, m);
        lumps.setColorAt(li, color);
        li++;
      }
    }
    for (const mesh of [cones, lumps]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    this.scene.add(group);
    this.distantForest = group;
    this.forestMax = { cones: ci, lumps: li, total: count };
    this.#applyForestQuality();
  }

  #applyForestQuality() {
    if (!this.distantForest) return;
    const want = this.q.distantForest;
    this.distantForest.visible = want > 0;
    const share = Math.min(1, want / (this.forestMax.total || 1));
    const [cones, lumps] = this.distantForest.children;
    cones.count = Math.floor(this.forestMax.cones * share);
    lumps.count = Math.floor(this.forestMax.lumps * share);
  }

  #rocks() {
    const rocks = this.terrain.rocks;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.tex.rock, roughness: 0.88, metalness: 0, flatShading: false,
    });
    mat.map = this.tex.rock;
    const mesh = new THREE.InstancedMesh(lumpGeometry(2, 0.42, 3), mat, rocks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    rocks.forEach((r, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r.spin);
      m.compose(new THREE.Vector3(r.x, r.y, r.z), q, new THREE.Vector3(r.size, r.size * r.squash, r.size * 1.15));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color.setHSL(0.08, 0.05, 0.78 + (r.spin % 1) * 0.18));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------ structures

  #material(name, color) {
    const key = `${name}:${color ?? ''}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const std = (opts) => new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.85, ...opts });
    const walls = (front, end) => {
      const side = std({ map: front.map, roughnessMap: front.spec, metalnessMap: front.spec, color, roughness: 1, metalness: 1 });
      const gable = std({ map: end.map, roughnessMap: end.spec, metalnessMap: end.spec, color, roughness: 1, metalness: 1 });
      const plain = std({ color, roughness: 0.9 });
      return [gable, gable, plain, plain, side, side];
    };
    const f = this.tex.facades;
    const make = {
      concrete: () => std({ color: 0x9d9d97, roughness: 0.92, normalMap: this.tex.concrete.normal }),
      steel: () => std({ color: 0x70767c, roughness: 0.42, metalness: 0.72 }),
      pylon: () => std({ color: 0x8a9299, roughness: 0.55, metalness: 0.55, flatShading: true }),
      dark: () => std({ color: 0x23252a, roughness: 0.5 }),
      wood: () => std({ color: 0x6f5336, roughness: 0.82 }),
      white: () => std({ color: 0xeceff2, roughness: 0.52, metalness: 0.08 }),
      crane: () => std({ color: 0xe8a81c, roughness: 0.55, metalness: 0.25 }),
      metal: () => std({ color: 0xc4c9ce, metalness: 0.85, roughness: 0.3 }),
      lamp: () => new THREE.MeshStandardMaterial({
        color: 0x3a3a3a, emissive: 0xffe9b0, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.2,
      }),
      paint: () => std({ color, roughness: 0.6, metalness: 0.08 }),
      plaster: () => std({ color, roughness: 0.9 }),
      roof: () => {
        const map = this.tex.roof.map.clone();
        const normal = this.tex.roof.normal.clone();
        map.needsUpdate = normal.needsUpdate = true;
        map.repeat.set(2.5, 2.5);
        normal.repeat.set(2.5, 2.5);
        return std({ color: color ?? 0x8a3b2c, map, normalMap: normal, roughness: 0.78, side: THREE.DoubleSide });
      },
      container: () => std({
        color, map: this.tex.corrugated.map, normalMap: this.tex.corrugated.normal,
        roughness: 0.52, metalness: 0.35,
      }),
      house1: () => walls(...f.house1),
      house2: () => walls(...f.house2),
      church: () => walls(...f.church),
      barn: () => walls(...f.barn),
    };
    const mat = make[name]();
    this.materials.set(key, mat);
    return mat;
  }

  // Draws the structures listed by the terrain.
  #parts() {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitRoof = roofGeometry();
    const unitSphere = new THREE.SphereGeometry(1, 24, 14);
    const cableMat = new THREE.LineBasicMaterial({ color: 0x1f2124 });
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
        mesh = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.8, 12, 1, true).rotateZ(Math.PI / 2).translate(0.9, 0, 0),
          new THREE.MeshStandardMaterial({ color: 0xff6a1a, side: THREE.DoubleSide, roughness: 0.7 }));
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
      const nacelle = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 7, 6, 12).rotateX(Math.PI / 2), white);
      nacelle.position.z = -TURBINE_FRONT - 0.5;
      nacelle.castShadow = true;
      const rotor = new THREE.Group();
      const hub = new THREE.Mesh(new THREE.SphereGeometry(1.7, 18, 12), white);
      hub.castShadow = true;
      rotor.add(hub);
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 1.15, t.blade, 10).rotateZ(-Math.PI / 2).translate(t.blade / 2, 0, 0).scale(1, 1, 0.26),
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
      const geo = new THREE.SphereGeometry(8, 32, 20);
      const colors = [];
      const base = new THREE.Color(b.color);
      const pale = new THREE.Color(0xf6f1e4);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const stripe = Math.floor((Math.atan2(p.getZ(i), p.getX(i)) / Math.PI + 1) * 6) % 2;
        const c = stripe ? base : pale;
        colors.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const envelope = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide,
      }));
      envelope.scale.y = 1.12;
      envelope.castShadow = true;
      const throat = new THREE.Mesh(
        new THREE.CylinderGeometry(4.2, 1.2, 5, 20, 1, true),
        new THREE.MeshStandardMaterial({ color: b.color, side: THREE.DoubleSide, roughness: 0.65 }),
      );
      throat.position.y = -8.6;
      const basket = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.8), this.#material('wood'));
      basket.position.y = -11.8;
      basket.castShadow = true;
      group.add(envelope, throat, basket);
      this.scene.add(group);
      return { balloon: b, group };
    });
  }

  #pad(color, letter) {
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        map: TEX.padTexture(color, letter), transparent: true, roughness: 0.6, metalness: 0.05,
        polygonOffset: true, polygonOffsetFactor: -4,
      }),
    );
    pad.receiveShadow = true;
    return pad;
  }

  #homePad() {
    const pad = this.#pad('#d9822b', 'H');
    pad.scale.setScalar(0.6);
    pad.position.set(0, this.terrain.groundHeight(0, 0) + 0.02, 0);
    this.scene.add(pad);
    this.targetPad = this.#pad('#2b7bd9', '');
    this.targetPad.visible = false;
    this.scene.add(this.targetPad);
  }

  showTargetPad(target) {
    this.targetPad.visible = !!target;
    if (!target) return;
    this.targetPad.scale.setScalar(target.radius);
    this.targetPad.position.set(target.x, this.terrain.groundHeight(target.x, target.z) + 0.06, target.z);
  }

  // ---------------------------------------------------------------- drone

  #drone() {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const shell = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.38, metalness: 0.22 });
    const shellDark = new THREE.MeshStandardMaterial({ color: 0x4d5257, roughness: 0.45, metalness: 0.3 });
    const plastic = new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.5, metalness: 0.12 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85, metalness: 0 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.25, metalness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b0e14, roughness: 0.06, metalness: 0.6 });
    const add = (geo, mat, x, y, z, parent = root) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Fuselage: a smooth pod, flattened, with a raised battery deck.
    const body = add(new THREE.CapsuleGeometry(0.036, 0.1, 6, 16).rotateX(Math.PI / 2), shell, 0, 0.016, 0.005);
    body.scale.set(1.08, 0.66, 1);
    add(new THREE.BoxGeometry(0.056, 0.016, 0.092), shellDark, 0, 0.038, 0.016);
    add(new THREE.BoxGeometry(0.044, 0.012, 0.03), plastic, 0, 0.047, 0.03);        // battery latch
    add(new THREE.BoxGeometry(0.03, 0.004, 0.01), metal, 0, 0.0535, 0.03);          // contacts

    // Nose: gimbal cradle, camera block and lens.
    const nose = add(new THREE.SphereGeometry(0.028, 16, 12), shell, 0, 0.006, -0.082);
    nose.scale.set(1, 0.8, 0.9);
    const gimbal = new THREE.Group();
    gimbal.position.set(0, -0.004, -0.098);
    root.add(gimbal);
    add(new THREE.BoxGeometry(0.03, 0.028, 0.026), plastic, 0, 0, 0, gimbal);
    const lens = add(new THREE.CylinderGeometry(0.0115, 0.0125, 0.012, 20).rotateX(Math.PI / 2), plastic, 0, 0, -0.016, gimbal);
    lens.castShadow = false;
    const glassDisc = add(new THREE.CircleGeometry(0.0105, 24), glass, 0, 0, -0.0225, gimbal);
    glassDisc.castShadow = false;
    add(new THREE.TorusGeometry(0.0125, 0.0014, 6, 20).rotateY(0), metal, 0, 0, -0.0215, gimbal);
    this.gimbalModel = gimbal;

    // Obstacle sensors, front and rear.
    for (const z of [-0.07, 0.085]) {
      for (const x of [-0.016, 0.016]) add(new THREE.SphereGeometry(0.0045, 8, 6), glass, x, 0.004, z);
    }

    this.props = [];
    const propBlurMat = new THREE.MeshBasicMaterial({
      map: this.tex.prop, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const mx = sx * 0.128;
      const mz = sz * 0.095;
      // Arm: tapered, swept back from the body.
      const arm = add(new THREE.CapsuleGeometry(0.0085, 0.1, 4, 10).rotateZ(Math.PI / 2), shell, sx * 0.072, 0.016, sz * 0.068);
      arm.rotation.y = -sx * sz * 0.62;
      arm.scale.set(1, 0.7, 0.8);
      // Motor can with a vented top.
      add(new THREE.CylinderGeometry(0.0145, 0.0155, 0.026, 16), shellDark, mx, 0.03, mz);
      add(new THREE.CylinderGeometry(0.013, 0.013, 0.004, 16), metal, mx, 0.044, mz);
      // Landing leg with a rubber foot.
      add(new THREE.CylinderGeometry(0.0035, 0.0045, 0.03, 8), shellDark, mx, -0.004, mz);
      add(new THREE.SphereGeometry(0.0055, 8, 6), rubber, mx, -0.019, mz);

      // Two-blade propeller: thin, cambered, slightly coned.
      const prop = new THREE.Group();
      prop.position.set(mx, 0.0485, mz);
      root.add(prop);
      for (const side of [-1, 1]) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.0016, 0.013), plastic);
        blade.position.set(side * 0.047, 0.0015 * side, 0);
        blade.rotation.set(side * 0.18, 0, side * 0.03);
        prop.add(blade);
        const tip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.0016, 0.008), plastic);
        tip.position.set(side * 0.086, 0.0022 * side, 0);
        tip.rotation.set(side * 0.1, 0, 0);
        prop.add(tip);
      }
      add(new THREE.CylinderGeometry(0.006, 0.008, 0.008, 12), shellDark, 0, 0, 0, prop);

      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.097, 28).rotateX(-Math.PI / 2), propBlurMat);
      disc.position.set(mx, 0.0495, mz);
      disc.renderOrder = 3;
      root.add(disc);

      this.props.push({ prop, disc, dir: sx * sz });

      // Navigation lights: red at the front, green at the back, plus a glow
      // sprite so the bloom pass gives them a halo.
      const front = sz < 0;
      const led = add(
        new THREE.SphereGeometry(0.0075, 10, 8),
        new THREE.MeshStandardMaterial({
          color: front ? 0x2a0000 : 0x002a08,
          emissive: front ? 0xff2a2a : 0x2aff5a,
          emissiveIntensity: 6,
          roughness: 0.4,
        }),
        mx, 0.006, mz,
      );
      led.castShadow = false;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.tex.glow,
        color: front ? 0xff3b2a : 0x3bff6a,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      glow.scale.setScalar(0.055);
      glow.position.set(mx, 0.006, mz);
      root.add(glow);
    }
    this.scene.add(root);
    return root;
  }

  // ---------------------------------------------------------------- gates

  setGates(gates) {
    for (const g of this.gates) { this.scene.remove(g); g.geometry.dispose(); g.material.dispose(); }
    this.gates = gates.map((gate) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(gate.radius, 0.24, 14, 48),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2,
          roughness: 0.35, metalness: 0.1, transparent: true,
        }),
      );
      ring.position.set(gate.x, gate.y, gate.z);
      ring.rotation.y = Math.atan2(gate.nx, gate.nz);
      ring.castShadow = true;
      this.scene.add(ring);
      return ring;
    });
  }

  highlightGate(next) {
    this.gates.forEach((ring, i) => {
      const m = ring.material;
      if (i < next) { m.color.set(0x35d06a); m.emissive.set(0x0d3d1c); m.emissiveIntensity = 0.6; m.opacity = 0.3; }
      else if (i === next) { m.color.set(0xff8a1f); m.emissive.set(0xff6a00); m.emissiveIntensity = 2.2; m.opacity = 1; }
      else { m.color.set(0xffffff); m.emissive.set(0x222222); m.emissiveIntensity = 0.4; m.opacity = 0.6; }
    });
  }

  cycleView() {
    this.view = { gimbal: 'chase', chase: 'pilot', pilot: 'gimbal' }[this.view];
    this.snapCamera = true;
    return this.view;
  }

  // --------------------------------------------------------------- update

  // time is the simulation clock, the same one the collision code uses.
  update(drone, dt, time) {
    const model = this.droneModel;
    const crashed = drone.state === 'crashed';
    model.position.set(drone.pos.x, drone.pos.y, drone.pos.z);
    model.rotation.set(crashed ? 0.5 : -drone.pitch, -drone.heading, crashed ? 2.6 : -drone.roll);
    model.visible = this.view !== 'gimbal';
    if (this.gimbalModel) this.gimbalModel.rotation.x = THREE.MathUtils.clamp(drone.gimbal + drone.pitch, -1.6, 0.6);

    const spin = drone.motorsOn ? 40 + drone.throttleLevel * 90 : 0;
    const blur = Math.min(1, spin / 55);
    for (const p of this.props) {
      p.prop.rotation.y += p.dir * spin * dt;
      p.disc.visible = spin > 0;
      p.disc.material.opacity = 0.18 + 0.42 * blur;
      // Above a few hundred rpm the blades themselves stop reading as solid.
      p.prop.visible = spin === 0 || Math.floor(time * 30) % 2 === 0;
    }

    this.shared.time.value = time;
    for (const r of this.rotors) r.rotor.rotation.z = turbineAngle(r.turbine, time);
    for (const b of this.balloonMeshes) {
      const p = balloonPosition(b.balloon, time);
      b.group.position.set(p.x, p.y, p.z);
    }
    for (const c of this.clouds) {
      c.position.x += dt * c.userData.drift;
      const half = c.userData.spread / 2;
      if (c.position.x > half) c.position.x -= c.userData.spread;
    }
    if (this.cirrus) this.cirrus.material.map.offset.x = time * 0.0009;
    this.waterMaterial.uniforms.time.value = time;

    const cam = this.camera;
    const fx = Math.sin(drone.heading);
    const fz = -Math.cos(drone.heading);
    const speed = Math.hypot(drone.vel.x, drone.vel.z);
    let fov = GIMBAL_FOV;
    let dofStrength = 0;
    let dofFocus = 40;

    if (this.view === 'gimbal') {
      // The pilot's view: exactly where the camera sits, no smoothing, so
      // control feel is untouched.
      cam.position.set(drone.pos.x + fx * 0.1, drone.pos.y, drone.pos.z + fz * 0.1);
      cam.rotation.set(drone.gimbal, -drone.heading, 0);
      cam.up.set(0, 1, 0);
    } else if (this.view === 'chase') {
      // Spring-damped chase camera: it sits further back and widens slightly
      // as the drone accelerates, then settles when the drone does.
      const back = 1.45 + Math.min(speed * 0.075, 1.5);
      const up = 0.42 + Math.min(speed * 0.012, 0.3);
      const target = new THREE.Vector3(
        drone.pos.x - fx * back - drone.vel.x * 0.05,
        drone.pos.y + up,
        drone.pos.z - fz * back - drone.vel.z * 0.05,
      );
      const floor = this.terrain.groundHeight(target.x, target.z) + 0.3;
      target.y = Math.max(target.y, floor);
      const look = new THREE.Vector3(
        drone.pos.x + fx * 2.2 + drone.vel.x * 0.12,
        drone.pos.y + 0.12 + drone.vel.y * 0.06,
        drone.pos.z + fz * 2.2 + drone.vel.z * 0.12,
      );
      if (this.snapCamera) { this.chasePos.copy(target); this.chaseLook.copy(look); }
      else {
        this.chasePos.lerp(target, 1 - Math.exp(-dt * 7));
        this.chaseLook.lerp(look, 1 - Math.exp(-dt * 9));
      }
      cam.position.copy(this.chasePos);
      // A hint of the drone's roll bleeds into the camera for a natural lean.
      cam.up.set(Math.sin(-drone.roll * 0.35), Math.cos(drone.roll * 0.35), 0)
        .applyAxisAngle(THREE.Object3D.DEFAULT_UP, -drone.heading);
      cam.lookAt(this.chaseLook);
      fov = 64 + Math.min(speed, 22) * 0.42;
    } else {
      const hx = drone.home.x + 1.5;
      const hz = drone.home.z + 3;
      cam.position.set(hx, this.terrain.groundHeight(hx, hz) + 1.7, hz);
      cam.up.set(0, 1, 0);
      cam.lookAt(drone.pos.x, drone.pos.y, drone.pos.z);
      const dist = cam.position.distanceTo(model.position);
      const wanted = Math.max(6, Math.min(60, 700 / Math.max(dist, 1)));
      // Ease the long-lens zoom so it does not snap while the drone moves.
      this.pilotFov = this.snapCamera ? wanted : this.pilotFov + (wanted - this.pilotFov) * (1 - Math.exp(-dt * 4));
      fov = this.pilotFov;
      // Long lens, far subject: a touch of depth of field, as a spotter sees it.
      dofFocus = dist;
      dofStrength = 0.5;
    }
    this.snapCamera = false;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }

    this.sky.position.copy(cam.position);
    if (this.cirrus) { this.cirrus.position.x = cam.position.x; this.cirrus.position.z = cam.position.z; }
    // Keep the shadow frustum centred just ahead of the drone.
    const focus = this.sun.target.position.set(
      drone.pos.x + drone.vel.x * 0.4, drone.pos.y, drone.pos.z + drone.vel.z * 0.4,
    );
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, this.q.shadowDistance * 2.2);

    for (const layer of this.scatterLayers || []) layer.update(cam, time, this.shared.wind.value);

    this.post.render(this.scene, cam, SUN_DIR, {
      dt,
      dofStrength,
      dofFocus,
      exposure: 1.06,
      vignette: this.view === 'gimbal' ? 0.34 : 0.26,
    });
  }
}
