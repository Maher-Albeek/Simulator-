// Ground cover: grass blades and low bushes, scattered on the GPU.
//
// Placement happens entirely in the vertex shader from a baked terrain
// heightmap, so adding a hundred thousand blades costs no CPU time and the
// grass never disagrees with the terrain mesh it stands on. Instances are
// anchored to absolute world cells (the jitter is hashed from the cell index),
// so nothing swims or pops as the camera moves.

import * as THREE from '../../vendor/three.module.min.js';

const PLACEMENT_GLSL = /* glsl */`
uniform sampler2D uHeight;        // r: terrain height, g: cover mask, b: slope
uniform sampler2D uAlbedo;        // terrain colour, so cover matches the ground
uniform vec2 uAnchor;             // camera cell, snapped to the spacing
uniform vec3 uCamera;
uniform float uTime;
uniform float uSpacing;
uniform float uSide;
uniform float uRadius;
uniform float uWind;
uniform float uTerrainSize;
uniform vec2 uSizeRange;          // min, max scale
attribute vec2 aCell;
varying vec3 vCover;
varying float vFade;
varying float vTip;
varying float vShade;

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export class ScatterLayer {
  // geometry: a single blade / bush, standing on y = 0, one unit tall.
  constructor(scene, geometry, {
    spacing = 0.7, side = 128, radius = 48, wind = 1, sizeRange = [0.55, 1.1],
    roughness = 0.82, tint = 0xffffff, saturate = 1, lean = 1, shade = [0.6, 1.2], name = 'cover',
  } = {}) {
    this.params = { spacing, side, radius, wind, sizeRange, lean };
    this.scene = scene;

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = geometry.index;
    for (const key of Object.keys(geometry.attributes)) geo.setAttribute(key, geometry.attributes[key]);
    geo.instanceCount = side * side;
    const cells = new Float32Array(side * side * 2);
    for (let i = 0; i < side * side; i++) {
      cells[i * 2] = i % side;
      cells[i * 2 + 1] = Math.floor(i / side);
    }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;

    const mat = new THREE.MeshStandardMaterial({
      color: tint, roughness, metalness: 0, side: THREE.DoubleSide,
      vertexColors: !!geometry.attributes.color,
    });
    this.uniforms = {
      uHeight: { value: null },
      uAlbedo: { value: null },
      uAnchor: { value: new THREE.Vector2() },
      uCamera: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSpacing: { value: spacing },
      uSide: { value: side },
      uRadius: { value: radius },
      uWind: { value: wind },
      uTerrainSize: { value: 2800 },
      uSizeRange: { value: new THREE.Vector2(sizeRange[0], sizeRange[1]) },
      uSaturate: { value: saturate },
      uShade: { value: new THREE.Vector2(shade[0], shade[1]) },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${PLACEMENT_GLSL}`)
        .replace('#include <beginnormal_vertex>', /* glsl */`
          vec2 cellIndex = floor(uAnchor / uSpacing) + aCell - uSide * 0.5;
          vec2 rnd = hash22(cellIndex);
          float rot = rnd.x * 6.2831853;
          vec2 world2 = (cellIndex + vec2(rnd.x, rnd.y) * 0.92) * uSpacing;
          vec2 huv = world2 / uTerrainSize + 0.5;
          vec4 terrain = texture2D(uHeight, huv);
          float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
          float scatterNoise = hash12(cellIndex * 0.113);
          // Patchy coverage: thinner where the terrain mask says rock, road or water.
          float keep = inside * step(0.10 + scatterNoise * 0.42, terrain.g);
          float dist = length(world2 - uCamera.xz);
          vFade = 1.0 - smoothstep(uRadius * 0.40, uRadius, dist);
          float scale = mix(uSizeRange.x, uSizeRange.y, hash12(cellIndex * 1.7 + 3.3)) * keep * vFade;

          float ca = cos(rot), sa = sin(rot);
          mat2 spin = mat2(ca, -sa, sa, ca);
          vec3 local = position;
          local.xz = spin * local.xz;
          vec3 nrm = normal;
          nrm.xz = spin * nrm.xz;

          // Wind: a travelling wave plus a faster flutter, strongest at the tip.
          float phase = dot(world2, vec2(0.08, 0.11)) + uTime * 1.25;
          float gust = 0.55 + 0.45 * sin(dot(world2, vec2(0.012, 0.009)) + uTime * 0.35);
          float bend = uWind * gust * (0.22 * sin(phase) + 0.08 * sin(phase * 3.1 + 1.7));
          float up = clamp(position.y, 0.0, 1.0);
          local.xz += vec2(bend, bend * 0.6) * up * up * float(${lean.toFixed(3)});

          vec3 objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), nrm, 0.3));
          vTip = clamp(position.y, 0.0, 1.0);
          vShade = 0.78 + 0.44 * hash12(cellIndex * 5.1 + 1.9);
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          vec3 transformed = vec3(local.x * scale, local.y * scale, local.z * scale);
          transformed.x += world2.x;
          transformed.z += world2.y;
          transformed.y += terrain.r;
          vCover = texture2D(uAlbedo, huv).rgb;
        `);
      shader.fragmentShader = shader.fragmentShader
        // Blades are double sided, and three flips the normal on back faces.
        // Undoing that keeps a leaf lit the same from either side instead of
        // turning half the cover into black spikes.
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal *= faceDirection;`)
        .replace('#include <common>', `#include <common>
          varying vec3 vCover; varying float vFade; varying float vTip; varying float vShade;
          uniform float uSaturate; uniform vec2 uShade;`)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          vec3 ground = vCover;
          float gl = dot(ground, vec3(0.333));
          ground = mix(vec3(gl), ground, uSaturate);
          // Darker at the root, brighter at the tip: cheap self-shadowing
          // that stops the cover reading as a field of spikes.
          diffuseColor.rgb *= ground * vShade * mix(uShade.x, uShade.y, vTip) * 0.98;
        `);
    };
    mat.customProgramCacheKey = () => `scatter-${name}`;
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  setTerrain(heightTex, albedoTex, terrainSize) {
    this.uniforms.uHeight.value = heightTex;
    this.uniforms.uAlbedo.value = albedoTex;
    this.uniforms.uTerrainSize.value = terrainSize;
  }

  update(camera, time, windScale = 1) {
    const { spacing } = this.params;
    this.uniforms.uAnchor.value.set(
      Math.floor(camera.position.x / spacing) * spacing,
      Math.floor(camera.position.z / spacing) * spacing,
    );
    this.uniforms.uCamera.value.copy(camera.position);
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value = this.params.wind * windScale;
    // Nothing to draw when the camera is high above the ground.
    this.mesh.visible = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// A tuft of blades fanning out from one root. Instancing single blades cannot
// reach a believable density, so each instance is a small clump instead.
export function tuftGeometry(blades = 5, segments = 2, width = 0.05, spread = 0.1) {
  const parts = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rnd() * 0.9;
    const lean = 0.12 + rnd() * 0.5;
    const blade = bladeGeometry(segments, width * (0.75 + rnd() * 0.5), 0.18 + rnd() * 0.3);
    blade.scale(1, 0.55 + rnd() * 0.6, 1);
    blade.rotateZ(lean * (i % 2 ? 1 : -1));
    blade.rotateY(a);
    blade.translate(Math.cos(a) * spread * rnd(), 0, Math.sin(a) * spread * rnd());
    parts.push(blade);
  }
  return mergeGeometries(parts);
}

// A single curved grass blade, three segments tall, tapering to a point.
export function bladeGeometry(segments = 3, width = 0.045, curve = 0.3) {
  const pos = [];
  const nrm = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = width * (1 - t * 0.92);
    const x = curve * t * t;
    pos.push(-w, t, x, w, t, x);
    nrm.push(0, 0.35, 1, 0, 0.35, 1);
    uvs.push(0, t, 1, t);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

// A small bush: a few crossed, drooping leaves around a stem.
export function bushGeometry(leaves = 6) {
  const parts = [];
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + 0.4;
    const leaf = bladeGeometry(3, 0.17, 0.75);
    leaf.rotateZ(0.5 + (i % 2) * 0.25);
    leaf.rotateY(a);
    leaf.scale(1, 0.85 + (i % 3) * 0.1, 1);
    parts.push(leaf);
  }
  return mergeGeometries(parts);
}

export function mergeGeometries(list) {
  let vertices = 0;
  let indices = 0;
  for (const g of list) {
    vertices += g.attributes.position.count;
    indices += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(vertices * 3);
  const nrm = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const idx = new Uint32Array(indices);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    io += gi.length;
    vo += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  return out;
}
