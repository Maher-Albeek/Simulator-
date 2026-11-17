// Hand-rolled post-processing stack. The project vendors the three.js core
// only (no examples/addons), so the whole chain is written here:
//
//   scene  ->  half-float HDR buffer (+ depth)
//          ->  SSAO from depth (half res, blurred)
//          ->  aerial perspective fog + AO composite
//          ->  bright pass + mip bloom (dual filtering)
//          ->  exposure, ACES tone map, grade, vignette, grain
//          ->  FXAA (only when MSAA is off)
//
// Everything is optional per quality preset.

import * as THREE from '../../vendor/three.module.min.js';
import { ATMOSPHERE_GLSL } from './atmosphere.js';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DEPTH_GLSL = /* glsl */`
uniform sampler2D tDepth;
uniform vec2 uCamPlanes;      // near, far
uniform vec2 uProjInv;        // 1/P00, 1/P11

float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

float viewZ(float raw) {
  float near = uCamPlanes.x, far = uCamPlanes.y;
  return (near * far) / ((far - near) * raw - far);   // negative in front of the eye
}

vec3 viewPos(vec2 uv, float vz) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc * uProjInv * -vz, vz);
}`;

// sRGB encode, done by hand so the chain never depends on three's material
// prefix (these are raw shaders) and so FXAA can run in gamma space.
const ENCODE_GLSL = /* glsl */`
vec3 linearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - 0.055, step(0.0031308, c));
}`;

function fullscreen(uniforms, fragment, defines = {}) {
  return new THREE.RawShaderMaterial({
    uniforms,
    defines,
    vertexShader: `precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n${QUAD_VERT}`,
    fragmentShader: `precision highp float;\nprecision highp sampler2D;\n${fragment}`,
    depthTest: false,
    depthWrite: false,
  });
}

export class PostFX {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.size = new THREE.Vector2(1, 1);
    this.enabled = true;
    this.time = 0;

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.#buildMaterials();
  }

  // ---------------------------------------------------------------- targets

  #makeScene(w, h) {
    this.sceneRT?.dispose();
    const depth = new THREE.DepthTexture(w, h);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      samples: this.quality.msaa || 0,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    this.sceneRT = rt;
  }

  #makeTarget(w, h, { type = THREE.HalfFloatType, filter = THREE.LinearFilter } = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: filter, magFilter: filter, generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  setSize(width, height) {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    if (this.size.x === w && this.size.y === h && this.sceneRT) return;
    this.size.set(w, h);

    this.#makeScene(w, h);
    for (const rt of this.extra || []) rt.dispose();
    this.extra = [];
    const keep = (rt) => { this.extra.push(rt); return rt; };

    this.hdrRT = keep(this.#makeTarget(w, h));
    this.ldrRT = keep(this.#makeTarget(w, h, { type: THREE.UnsignedByteType }));

    const aw = Math.max(2, w >> 1);
    const ah = Math.max(2, h >> 1);
    this.aoRT = keep(this.#makeTarget(aw, ah, { type: THREE.UnsignedByteType }));
    this.aoBlurRT = keep(this.#makeTarget(aw, ah, { type: THREE.UnsignedByteType }));

    this.bloomRT = [];
    let bw = w >> 1;
    let bh = h >> 1;
    for (let i = 0; i < 5; i++) {
      this.bloomRT.push(keep(this.#makeTarget(Math.max(2, bw), Math.max(2, bh))));
      bw >>= 1; bh >>= 1;
    }
  }

  setQuality(quality) {
    this.quality = quality;
    this.#buildMaterials();
    const { x, y } = this.size;
    this.size.set(0, 0);
    this.setSize(x || 2, y || 2);
  }

  // -------------------------------------------------------------- materials

  #buildMaterials() {
    const q = this.quality;
    for (const m of this.materials || []) m.dispose();
    this.materials = [];
    const own = (m) => { this.materials.push(m); return m; };

    const depthUniforms = () => ({
      tDepth: { value: null },
      uCamPlanes: { value: new THREE.Vector2(0.05, 4000) },
      uProjInv: { value: new THREE.Vector2(1, 1) },
    });

    // ----- SSAO -------------------------------------------------------
    this.aoMat = own(fullscreen({
      ...depthUniforms(),
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.9 },
      uIntensity: { value: 1.0 },
    }, /* glsl */`
      varying vec2 vUv;
      ${DEPTH_GLSL}
      uniform vec2 uTexel; uniform float uRadius; uniform float uIntensity;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        float raw = rawDepth(vUv);
        if (raw >= 0.999999) { gl_FragColor = vec4(1.0); return; }
        float vz = viewZ(raw);
        vec3 p = viewPos(vUv, vz);
        // Normal from two neighbouring depth taps. Derivatives would be
        // cheaper but are not available to a GLSL1 raw shader on WebGL2.
        vec3 px = viewPos(vUv + vec2(uTexel.x, 0.0), viewZ(rawDepth(vUv + vec2(uTexel.x, 0.0))));
        vec3 py = viewPos(vUv + vec2(0.0, uTexel.y), viewZ(rawDepth(vUv + vec2(0.0, uTexel.y))));
        vec3 n = normalize(cross(px - p, py - p));
        if (n.z < 0.0) n = -n;

        float dist = -vz;
        float radius = clamp(uRadius * (1.0 + dist * 0.035), 0.35, 6.0);
        float ang = hash12(vUv * uTexel * 1.37) * 6.2831853;
        float occ = 0.0;
        const int N = ${Math.max(4, q.ssaoSamples | 0)};
        for (int i = 0; i < N; i++) {
          float f = (float(i) + 0.5) / float(N);
          float a = ang + f * 6.2831853 * 2.39996;      // golden-angle spiral
          float r = radius * sqrt(f);
          vec3 dir = vec3(cos(a), sin(a), 0.0);
          vec3 s = p + (dir + n * 0.65) * r;
          vec4 clip = vec4(s.x / (uProjInv.x * -s.z), s.y / (uProjInv.y * -s.z), 0.0, 1.0);
          vec2 suv = clip.xy * 0.5 + 0.5;
          if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
          float sraw = rawDepth(suv);
          if (sraw >= 0.999999) continue;
          float sz = viewZ(sraw);
          float delta = sz - s.z;                        // >0 means the sample is occluded
          if (delta > 0.015) {
            occ += clamp(1.0 - (delta - 0.015) / (radius * 2.2), 0.0, 1.0);
          }
        }
        float ao = 1.0 - uIntensity * occ / float(N) * 1.6;
        ao = mix(1.0, clamp(ao, 0.0, 1.0), smoothstep(900.0, 500.0, dist));
        gl_FragColor = vec4(vec3(ao), 1.0);
      }`));

    this.aoBlurMat = own(fullscreen({
      tAO: { value: null },
      ...depthUniforms(),
      uTexel: { value: new THREE.Vector2() },
      uDir: { value: new THREE.Vector2(1, 0) },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tAO; uniform vec2 uTexel; uniform vec2 uDir;
      ${DEPTH_GLSL}
      void main() {
        float centre = viewZ(rawDepth(vUv));
        float sum = 0.0, wsum = 0.0;
        for (int i = -3; i <= 3; i++) {
          vec2 uv = vUv + uDir * uTexel * float(i) * 1.4;
          float w = exp(-float(i * i) / 6.0);
          float z = viewZ(rawDepth(uv));
          w *= exp(-abs(z - centre) * 1.2);
          sum += texture2D(tAO, uv).r * w;
          wsum += w;
        }
        gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
      }`));

    // ----- fog + AO composite ----------------------------------------
    this.fogMat = own(fullscreen({
      tDiffuse: { value: null },
      tAO: { value: null },
      ...depthUniforms(),
      uCamPos: { value: new THREE.Vector3() },
      uCamWorld: { value: new THREE.Matrix4() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFog: { value: new THREE.Vector3(0.00058, 620.0, 0.92) },   // density, scale height, tint
      uAO: { value: q.ssao ? 1.0 : 0.0 },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse; uniform sampler2D tAO;
      uniform vec3 uCamPos; uniform mat4 uCamWorld; uniform vec3 uSunDir; uniform vec3 uFog;
      uniform float uAO;
      ${DEPTH_GLSL}
      ${ATMOSPHERE_GLSL}
      void main() {
        vec4 src = texture2D(tDiffuse, vUv);
        float raw = rawDepth(vUv);
        if (uAO > 0.5) {
          float ao = texture2D(tAO, vUv).r;
          // Ambient occlusion darkens the shaded part only, never to pitch black.
          src.rgb *= mix(1.0, ao, 0.85);
        }
        if (raw >= 0.999999) { gl_FragColor = src; return; }

        float vz = viewZ(raw);
        vec3 vp = viewPos(vUv, vz);
        vec3 world = (uCamWorld * vec4(vp, 1.0)).xyz;
        vec3 ray = world - uCamPos;
        float dist = length(ray);
        vec3 dir = ray / max(dist, 1e-4);

        float amount = aerialAmount(dist, uCamPos.y, world.y, uFog.x, uFog.y);
        vec3 hazeCol = skyRadiance(dir, uSunDir) * uFog.z;
        // Extra forward scattering so looking into the sun washes out properly.
        hazeCol += SUN_TINT * mieLobe(dot(dir, uSunDir), 0.70) * 0.35;
        gl_FragColor = vec4(mix(src.rgb, hazeCol, clamp(amount, 0.0, 1.0)), src.a);
      }`));

    // ----- bloom -----------------------------------------------------
    this.brightMat = own(fullscreen({
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.65 },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
      void main() {
        vec3 c = vec3(0.0);
        c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
        c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
        c *= 0.25;
        float l = max(c.r, max(c.g, c.b));
        float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        soft = soft * soft / (4.0 * uKnee + 1e-4);
        float w = max(soft, l - uThreshold) / max(l, 1e-4);
        gl_FragColor = vec4(c * w, 1.0);
      }`));

    this.downMat = own(fullscreen({
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse; uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb * 0.25;
        c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 0.125;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, 0.0)).rgb * 0.125;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 0.0,-1.0)).rgb * 0.125;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 0.0, 1.0)).rgb * 0.125;
        c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,-1.0)).rgb * 0.0625;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,-1.0)).rgb * 0.0625;
        c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 0.0625;
        c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, 1.0)).rgb * 0.0625;
        gl_FragColor = vec4(c, 1.0);
      }`));

    this.upMat = own(fullscreen({
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uScale: { value: 1.0 },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uScale;
      void main() {
        vec2 t = uTexel * uScale;
        vec3 c = texture2D(tDiffuse, vUv).rgb * 4.0;
        c += (texture2D(tDiffuse, vUv + vec2(-t.x, 0.0)).rgb + texture2D(tDiffuse, vUv + vec2(t.x, 0.0)).rgb) * 2.0;
        c += (texture2D(tDiffuse, vUv + vec2(0.0, -t.y)).rgb + texture2D(tDiffuse, vUv + vec2(0.0, t.y)).rgb) * 2.0;
        c += texture2D(tDiffuse, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tDiffuse, vUv + vec2(t.x, -t.y)).rgb;
        c += texture2D(tDiffuse, vUv + vec2(-t.x,  t.y)).rgb + texture2D(tDiffuse, vUv + vec2(t.x,  t.y)).rgb;
        gl_FragColor = vec4(c / 16.0, 1.0);
      }`));
    this.upMat.blending = THREE.AdditiveBlending;
    this.upMat.transparent = true;

    // ----- tone map, grade, DOF, vignette ----------------------------
    this.finalMat = own(fullscreen({
      tDiffuse: { value: null },
      tBloom: { value: null },
      ...depthUniforms(),
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uExposure: { value: 1.08 },
      uBloom: { value: q.bloom ? 0.055 : 0.0 },
      uVignette: { value: 0.30 },
      uSaturation: { value: 1.12 },
      uContrast: { value: 1.045 },
      uGrain: { value: 0.012 },
      uTime: { value: 0 },
      uDof: { value: new THREE.Vector2(0.0, 40.0) },   // strength, focus distance
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse; uniform sampler2D tBloom;
      uniform vec2 uTexel; uniform vec2 uResolution;
      uniform float uExposure; uniform float uBloom; uniform float uVignette;
      uniform float uSaturation; uniform float uContrast; uniform float uGrain; uniform float uTime;
      uniform vec2 uDof;
      ${DEPTH_GLSL}
      ${ENCODE_GLSL}

      // ACES filmic approximation (Stephen Hill fit), in linear sRGB.
      vec3 rrt(vec3 c) {
        const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
        const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
        c = IN * c;
        vec3 a = c * (c + 0.0245786) - 0.000090537;
        vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
        return clamp(OUT * (a / b), 0.0, 1.0);
      }

      void main() {
        vec3 col;
      #ifdef USE_DOF
        float raw = rawDepth(vUv);
        float dist = raw >= 0.999999 ? 1.0e5 : -viewZ(raw);
        float coc = clamp(abs(dist - uDof.y) / max(uDof.y, 1.0) * uDof.x, 0.0, 1.0);
        if (coc > 0.004) {
          float r = coc * 9.0;
          col = texture2D(tDiffuse, vUv).rgb;
          float wsum = 1.0;
          for (int i = 0; i < 10; i++) {
            float a = float(i) * 2.39996;
            vec2 off = vec2(cos(a), sin(a)) * uTexel * r * (0.45 + 0.55 * fract(float(i) * 0.618));
            col += texture2D(tDiffuse, vUv + off).rgb;
            wsum += 1.0;
          }
          col /= wsum;
        } else {
          col = texture2D(tDiffuse, vUv).rgb;
        }
      #else
        col = texture2D(tDiffuse, vUv).rgb;
      #endif

        col += texture2D(tBloom, vUv).rgb * uBloom;
        col *= uExposure;
        col = rrt(col);

        // Gentle grade: a touch of contrast and saturation, cool shadows.
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSaturation);
        col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
        col = mix(col, col * vec3(0.96, 0.99, 1.06), 0.35 * (1.0 - l));

        // Vignette.
        vec2 q = (vUv - 0.5) * vec2(1.0, 1.0);
        float v = 1.0 - uVignette * dot(q, q) * 1.6;
        col *= clamp(v, 0.0, 1.0);

        // Fine grain + dithering, kills banding in the sky gradient.
        float n = fract(sin(dot(vUv * uResolution + uTime, vec2(12.9898, 78.233))) * 43758.5453);
        col += (n - 0.5) * uGrain;

        gl_FragColor = vec4(linearToSRGB(col), 1.0);
      }`, q.dof ? { USE_DOF: '' } : {}));

    // ----- FXAA ------------------------------------------------------
    this.fxaaMat = own(fullscreen({
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse; uniform vec2 uTexel;
      float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
      void main() {
        vec3 m  = texture2D(tDiffuse, vUv).rgb;
        vec3 nw = texture2D(tDiffuse, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
        vec3 ne = texture2D(tDiffuse, vUv + vec2( uTexel.x, -uTexel.y)).rgb;
        vec3 sw = texture2D(tDiffuse, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;
        vec3 se = texture2D(tDiffuse, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
        float lm = lum(m), lnw = lum(nw), lne = lum(ne), lsw = lum(sw), lse = lum(se);
        float lo = min(lm, min(min(lnw, lne), min(lsw, lse)));
        float hi = max(lm, max(max(lnw, lne), max(lsw, lse)));
        if (hi - lo < 0.06 * hi + 0.02) { gl_FragColor = vec4(m, 1.0); return; }
        vec2 dir = vec2(-((lnw + lne) - (lsw + lse)), ((lnw + lsw) - (lne + lse)));
        float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + 1e-4);
        dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
        vec3 a = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                      + texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
        vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb
                                 + texture2D(tDiffuse, vUv + dir * 0.5).rgb);
        float lb = lum(b);
        gl_FragColor = vec4((lb < lo || lb > hi) ? a : b, 1.0);
      }`));
  }

  // ----------------------------------------------------------------- render

  #blit(material, target, keep = false) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.autoClear = !keep;        // additive passes must not wipe the target
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.autoClear = true;
  }

  #setDepth(mat, camera) {
    const u = mat.uniforms;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uCamPlanes.value.set(camera.near, camera.far);
    const p = camera.projectionMatrix.elements;
    u.uProjInv.value.set(1 / p[0], 1 / p[5]);
  }

  render(scene, camera, sunDir, opts = {}) {
    const r = this.renderer;
    const q = this.quality;
    this.time += opts.dt || 0;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    const { x: w, y: h } = this.size;

    // --- SSAO
    let aoTex = null;
    if (q.ssao) {
      const aw = this.aoRT.width;
      const ah = this.aoRT.height;
      this.#setDepth(this.aoMat, camera);
      this.aoMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
      this.#blit(this.aoMat, this.aoRT);

      this.#setDepth(this.aoBlurMat, camera);
      this.aoBlurMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
      this.aoBlurMat.uniforms.tAO.value = this.aoRT.texture;
      this.aoBlurMat.uniforms.uDir.value.set(1, 0);
      this.#blit(this.aoBlurMat, this.aoBlurRT);
      this.aoBlurMat.uniforms.tAO.value = this.aoBlurRT.texture;
      this.aoBlurMat.uniforms.uDir.value.set(0, 1);
      this.#blit(this.aoBlurMat, this.aoRT);
      aoTex = this.aoRT.texture;
    }

    // --- fog + AO
    const fu = this.fogMat.uniforms;
    this.#setDepth(this.fogMat, camera);
    fu.tDiffuse.value = this.sceneRT.texture;
    fu.tAO.value = aoTex;
    fu.uAO.value = q.ssao ? 1 : 0;
    fu.uCamPos.value.copy(camera.position);
    fu.uCamWorld.value.copy(camera.matrixWorld);
    fu.uSunDir.value.copy(sunDir);
    this.#blit(this.fogMat, this.hdrRT);

    // --- bloom
    let bloomTex = null;
    if (q.bloom) {
      this.brightMat.uniforms.tDiffuse.value = this.hdrRT.texture;
      this.brightMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      this.#blit(this.brightMat, this.bloomRT[0]);
      for (let i = 1; i < this.bloomRT.length; i++) {
        const src = this.bloomRT[i - 1];
        this.downMat.uniforms.tDiffuse.value = src.texture;
        this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.#blit(this.downMat, this.bloomRT[i]);
      }
      for (let i = this.bloomRT.length - 1; i > 0; i--) {
        const src = this.bloomRT[i];
        this.upMat.uniforms.tDiffuse.value = src.texture;
        this.upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.upMat.uniforms.uScale.value = 1.4;
        this.#blit(this.upMat, this.bloomRT[i - 1], true);
      }
      bloomTex = this.bloomRT[0].texture;
    }

    // --- tone map and grade
    const u = this.finalMat.uniforms;
    this.#setDepth(this.finalMat, camera);
    u.tDiffuse.value = this.hdrRT.texture;
    u.tBloom.value = bloomTex || this.bloomRT[0].texture;
    u.uBloom.value = q.bloom ? (opts.bloom ?? 0.055) : 0;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uResolution.value.set(w, h);
    u.uTime.value = this.time;
    u.uExposure.value = opts.exposure ?? 1.08;
    u.uVignette.value = opts.vignette ?? 0.3;
    if (q.dof) u.uDof.value.set(opts.dofStrength ?? 0, opts.dofFocus ?? 40);
    this.#blit(this.finalMat, q.fxaa ? this.ldrRT : null);

    if (q.fxaa) {
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture;
      this.fxaaMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      this.#blit(this.fxaaMat, null);
    }
    r.setRenderTarget(null);
  }

  dispose() {
    this.sceneRT?.dispose();
    for (const rt of this.extra || []) rt.dispose();
    for (const m of this.materials || []) m.dispose();
    this.quad.geometry.dispose();
  }
}
