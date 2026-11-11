// Everything that is drawn: terrain, trees, buildings, sky, the drone model,
// race gates and the three camera views.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD_SIZE, WATER_LEVEL } from './terrain.js';

const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
const GIMBAL_FOV = 51;   // 22 mm equivalent lens on a 16:9 frame

export class SimScene {
  constructor(canvas, terrain) {
    this.terrain = terrain;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xbfd9ee, 250, 1100);
    this.camera = new THREE.PerspectiveCamera(GIMBAL_FOV, 1, 0.05, 2500);
    this.camera.rotation.order = 'YXZ';
    this.view = 'gimbal';
    this.gates = [];

    this.#lights();
    this.#sky();
    this.#ground();
    this.#buildings();
    this.#homePad();
    this.droneModel = this.#drone();
    this.rebuildTrees();
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #lights() {
    this.scene.add(new THREE.HemisphereLight(0xdcebff, 0x4a5a35, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.near = 1; c.far = 300;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target);
    this.sun = sun;
  }

  #sky() {
    const geo = new THREE.SphereGeometry(2000, 24, 16);
    const top = new THREE.Color(0x3b7fd1);
    const horizon = new THREE.Color(0xbfd9ee);
    const colors = [];
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = Math.pow(Math.max(0, p.getY(i) / 2000), 0.55);
      const c = horizon.clone().lerp(top, t);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.scene.add(this.sky);
  }

  #ground() {
    const seg = 220;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const colors = [];
    const grass = new THREE.Color(0x5f8f3a);
    const dry = new THREE.Color(0x8a9a4a);
    const sand = new THREE.Color(0xc9b98a);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const h = this.terrain.landHeight(x, z);
      p.setY(i, h);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.05) * Math.cos(z * 0.043);
      c.copy(grass).lerp(dry, patch * 0.6 + Math.max(0, h) * 0.02);
      if (h < WATER_LEVEL + 1.2) c.lerp(sand, Math.min(1, (WATER_LEVEL + 1.2 - h) / 1.2));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    this.scene.add(ground);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE * 2, WORLD_SIZE * 2),
      new THREE.MeshPhongMaterial({ color: 0x2f6f9f, shininess: 90, transparent: true, opacity: 0.85 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_LEVEL;
    this.scene.add(water);
  }

  rebuildTrees() {
    if (this.treeMeshes) for (const m of this.treeMeshes) { this.scene.remove(m); m.dispose(); }
    const trees = this.terrain.trees;
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.28, 1, 6).translate(0, 0.5, 0),
      new THREE.MeshLambertMaterial({ color: 0x5a4028 }),
      trees.length,
    );
    const canopy = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      trees.length,
    );
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    trees.forEach((t, i) => {
      const trunkTop = t.height * 0.25;
      m.makeScale(1, trunkTop + 0.5, 1).setPosition(t.x, t.base - 0.3, t.z);
      trunk.setMatrixAt(i, m);
      m.makeScale(t.radius, t.height - trunkTop, t.radius).setPosition(t.x, t.base + trunkTop, t.z);
      canopy.setMatrixAt(i, m);
      canopy.setColorAt(i, color.setHSL(0.27 + ((i * 37) % 10) * 0.006, 0.5, 0.2 + ((i * 13) % 7) * 0.012));
    });
    trunk.castShadow = true;
    canopy.castShadow = true;
    this.treeMeshes = [trunk, canopy];
    this.scene.add(trunk, canopy);
  }

  #buildings() {
    for (const b of this.terrain.buildings) {
      const sink = 6;
      const color = b.mast ? new THREE.Color(0xd94a3a) : new THREE.Color().setHSL(0.08, 0.12, b.color * 0.8);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(b.w, b.h + sink, b.d),
        new THREE.MeshLambertMaterial({ color }),
      );
      mesh.position.set(b.x, b.base + (b.h - sink) / 2, b.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      if (!b.mast) {
        const roof = new THREE.Mesh(
          new THREE.BoxGeometry(b.w + 0.6, 0.4, b.d + 0.6),
          new THREE.MeshLambertMaterial({ color: 0x5b4a44 }),
        );
        roof.position.set(b.x, b.base + b.h + 0.2, b.z);
        this.scene.add(roof);
      }
    }
  }

  #pad(color, letter) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = color;
    g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 12;
    g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(128, 128, 40, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 60px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, 128, 132);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
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
    this.targetPad.position.set(target.x, this.terrain.groundHeight(target.x, target.z) + 0.03, target.z);
  }

  #drone() {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const grey = new THREE.MeshStandardMaterial({ color: 0x8b8f94, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.5 });
    const add = (geo, mat, x, y, z) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      root.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(0.085, 0.05, 0.18), grey, 0, 0.015, 0);
    add(new THREE.BoxGeometry(0.06, 0.02, 0.1), dark, 0, 0.045, 0.02);       // battery
    add(new THREE.SphereGeometry(0.024, 12, 8), dark, 0, -0.005, -0.1);      // gimbal camera
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
        new THREE.CircleGeometry(0.09, 20).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.25, depthWrite: false }),
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

  update(drone, dt, time) {
    const model = this.droneModel;
    const crashed = drone.state === 'crashed';
    model.position.set(drone.pos.x, drone.pos.y, drone.pos.z);
    model.rotation.set(crashed ? 0.5 : -drone.pitch, -drone.heading, crashed ? 2.6 : -drone.roll);
    model.visible = this.view !== 'gimbal';

    const spin = drone.motorsOn ? 40 + drone.throttleLevel * 90 : 0;
    for (const p of this.props) {
      p.prop.rotation.y += p.dir * spin * dt;
      p.disc.visible = spin > 0;
      p.prop.visible = spin === 0 || Math.floor(time * 30) % 2 === 0;
    }

    const cam = this.camera;
    const fx = Math.sin(drone.heading);
    const fz = -Math.cos(drone.heading);
    let fov = GIMBAL_FOV;
    if (this.view === 'gimbal') {
      cam.position.set(drone.pos.x + fx * 0.1, drone.pos.y, drone.pos.z + fz * 0.1);
      cam.rotation.set(drone.gimbal, -drone.heading, 0);
    } else if (this.view === 'chase') {
      fov = 65;
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
    this.sun.position.set(drone.pos.x, drone.pos.y, drone.pos.z).addScaledVector(SUN_DIR, 120);
    this.sun.target.position.set(drone.pos.x, drone.pos.y, drone.pos.z);
    this.renderer.render(this.scene, cam);
  }
}
