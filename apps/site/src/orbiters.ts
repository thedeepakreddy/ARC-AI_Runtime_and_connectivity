import * as THREE from 'three';

// Things in orbit, built from geometry (no models are loaded): a space station and a train of
// broadband satellites. Both are lit by the real sun direction and go dark in Earth's shadow.
// Sizes are exaggerated (a real station would be a speck at this scale); proportions are not.

/** Canvas textures, drawn once. */
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A solar array blanket: a grid of dark blue cells with silver busbars and a gold frame. */
function solarTexture() {
  return canvasTex(256, 1024, (g) => {
    g.fillStyle = '#b08a3e';
    g.fillRect(0, 0, 256, 1024);
    const cols = 4,
      rows = 32,
      pad = 6;
    const cw = (256 - pad * 2) / cols,
      ch = (1024 - pad * 2) / rows;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = pad + c * cw,
          y = pad + r * ch;
        const shade = 22 + ((r * 7 + c * 13) % 9);
        g.fillStyle = `rgb(${shade - 8},${shade + 2},${shade + 34})`;
        g.fillRect(x + 1.5, y + 1.5, cw - 3, ch - 3);
        g.strokeStyle = 'rgba(190,200,215,0.35)';
        g.lineWidth = 1;
        for (let k = 1; k < 4; k++) {
          g.beginPath();
          g.moveTo(x + (cw * k) / 4, y + 2);
          g.lineTo(x + (cw * k) / 4, y + ch - 2);
          g.stroke();
        }
      }
    // A seam down the middle where the blanket folds.
    g.fillStyle = 'rgba(200,170,100,0.9)';
    g.fillRect(126, 0, 4, 1024);
  });
}

/** Module skin: off-white thermal blankets, quilted, with panel seams and handrails. */
function skinTexture() {
  return canvasTex(512, 256, (g) => {
    g.fillStyle = '#dcdcd6';
    g.fillRect(0, 0, 512, 256);
    const rnd = (n: number) => (Math.sin(n * 91.7) * 43758.5) % 1;
    for (let y = 0; y < 256; y += 32)
      for (let x = 0; x < 512; x += 64) {
        const v = 200 + Math.floor(Math.abs(rnd(x * 3 + y)) * 30);
        g.fillStyle = `rgb(${v},${v},${v - 6})`;
        g.fillRect(x + 1, y + 1, 62, 30);
      }
    g.strokeStyle = 'rgba(90,90,90,0.5)';
    g.lineWidth = 1.5;
    for (let x = 0; x < 512; x += 128) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 256);
      g.stroke();
    }
    g.strokeStyle = 'rgba(200,160,60,0.8)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 60);
    g.lineTo(512, 60);
    g.moveTo(0, 196);
    g.lineTo(512, 196);
    g.stroke();
  });
}

/** Radiator panels: white with fine fluid lines. */
function radiatorTexture() {
  return canvasTex(128, 256, (g) => {
    g.fillStyle = '#f2f2ee';
    g.fillRect(0, 0, 128, 256);
    g.strokeStyle = 'rgba(150,150,150,0.45)';
    for (let x = 4; x < 128; x += 8) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 256);
      g.stroke();
    }
    g.strokeStyle = 'rgba(80,80,80,0.6)';
    g.strokeRect(1, 1, 126, 254);
  });
}

export interface Station {
  group: THREE.Group;
  /** Turn the solar wings towards the sun (direction in world space). */
  track(sun: THREE.Vector3): void;
  dispose(): void;
}

/**
 * A modular station in the familiar layout: a pressurised spine along the direction of flight,
 * a long truss across it, four pairs of solar wings on rotary joints at the truss ends, and
 * radiators. The group's local +x is the truss, +z the direction of flight.
 */
export function buildStation(): Station {
  const group = new THREE.Group();
  const solarTex = solarTexture(),
    skinTex = skinTexture(),
    radTex = radiatorTexture();
  const skin = new THREE.MeshStandardMaterial({ map: skinTex, roughness: 0.72, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({
    color: 0x9a9ea6,
    roughness: 0.42,
    metalness: 0.75,
  });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xc89b45,
    roughness: 0.38,
    metalness: 0.85,
  });
  const solar = new THREE.MeshStandardMaterial({
    map: solarTex,
    roughness: 0.3,
    metalness: 0.35,
    side: THREE.DoubleSide,
  });
  const radiator = new THREE.MeshStandardMaterial({
    map: radTex,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const mats = [skin, metal, gold, solar, radiator];
  const geos: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = group) => {
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    parent.add(mesh);
    return mesh;
  };

  // The pressurised spine: modules and nodes along +z.
  const cyl = (r: number, len: number, z: number, x = 0, y = 0) => {
    const m = add(new THREE.CylinderGeometry(r, r, len, 28, 1), skin);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    // End rings.
    for (const s of [-1, 1]) {
      const ring = add(new THREE.TorusGeometry(r * 1.01, r * 0.06, 6, 28), metal);
      ring.position.set(x, y, z + (s * len) / 2);
    }
    return m;
  };
  cyl(0.034, 0.16, 0.0);
  cyl(0.03, 0.12, 0.15);
  cyl(0.034, 0.14, -0.15);
  cyl(0.028, 0.1, 0.27);
  cyl(0.026, 0.12, -0.28);
  const node = (z: number) =>
    add(new THREE.SphereGeometry(0.04, 20, 14), skin).position.set(0, 0, z);
  node(0.085);
  node(-0.08);
  // Side modules off the forward node.
  const side = add(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 24), skin);
  side.rotation.z = Math.PI / 2;
  side.position.set(0.09, 0, 0.085);
  const side2 = add(new THREE.CylinderGeometry(0.028, 0.028, 0.1, 24), skin);
  side2.rotation.z = Math.PI / 2;
  side2.position.set(-0.08, 0, 0.085);
  // The aft service module's small wings.
  for (const s of [-1, 1]) {
    const w = add(new THREE.PlaneGeometry(0.11, 0.035), solar);
    w.position.set(s * 0.085, 0, -0.3);
  }

  // The truss across the spine: a long lattice beam above the lab.
  const TRUSS = 0.62;
  const truss = new THREE.Group();
  truss.position.set(0, 0.05, -0.01);
  group.add(truss);
  add(new THREE.BoxGeometry(TRUSS, 0.016, 0.022), metal, truss);
  for (let i = -6; i <= 6; i++) {
    const strut = add(new THREE.BoxGeometry(0.003, 0.026, 0.028), gold, truss);
    strut.position.x = (i / 6) * (TRUSS / 2);
    const diag = add(new THREE.BoxGeometry(0.05, 0.002, 0.002), metal, truss);
    diag.position.set((i / 6) * (TRUSS / 2) + 0.022, 0.009, 0.012);
    diag.rotation.z = 0.5;
  }
  // Radiators, hanging below the truss inboard of the wings.
  for (const s of [-1, 1]) {
    const r = add(new THREE.PlaneGeometry(0.05, 0.16), radiator, truss);
    r.position.set(s * 0.12, -0.075, 0);
    r.rotation.y = Math.PI / 2;
  }
  // A dish antenna on top.
  const dish = add(new THREE.SphereGeometry(0.018, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), metal);
  dish.position.set(0.03, 0.08, -0.01);
  dish.rotation.x = -0.7;

  // Solar wings: at each truss end a rotary joint carries two wings (up and down), each a long
  // blanket on a central mast.
  const wings: THREE.Group[] = [];
  const WING_L = 0.3,
    WING_W = 0.07;
  for (const s of [-1, 1])
    for (const o of [-1, 1]) {
      const joint = new THREE.Group();
      joint.position.set(s * (TRUSS / 2 - 0.02 - (o > 0 ? 0 : 0.09)), 0, 0);
      truss.add(joint);
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 12), metal, joint).rotation.z =
        Math.PI / 2;
      for (const up of [-1, 1]) {
        const mast = add(new THREE.CylinderGeometry(0.0025, 0.0025, WING_L, 6), metal, joint);
        mast.position.y = up * (WING_L / 2 + 0.02);
        for (const side of [-1, 1]) {
          const blanket = add(new THREE.PlaneGeometry(WING_W / 2 - 0.003, WING_L), solar, joint);
          blanket.position.set(0, up * (WING_L / 2 + 0.02), side * (WING_W / 4 + 0.002));
          blanket.rotation.y = Math.PI / 2;
        }
      }
      wings.push(joint);
    }

  const local = new THREE.Vector3();
  return {
    group,
    track(sun) {
      // Each wing turns about the truss (its local x) to face the sun.
      local.copy(sun).applyQuaternion(group.quaternion.clone().invert());
      const ang = Math.atan2(local.y, local.z);
      wings.forEach((w) => (w.rotation.x = -ang + Math.PI / 2));
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      [solarTex, skinTex, radTex].forEach((t) => t.dispose());
    },
  };
}

export interface Train {
  /** The satellites, as one instanced mesh (bodies and panels). */
  mesh: THREE.InstancedMesh;
  /** Sunlight glints, one per satellite. */
  glints: THREE.Points;
  count: number;
  dispose(): void;
}

/** A train of flat broadband satellites, each a slab with one long solar panel. */
export function buildTrain(count: number): Train {
  // One merged shape: the body slab and its panel.
  const body = new THREE.BoxGeometry(0.06, 0.008, 0.028);
  const panel = new THREE.BoxGeometry(0.15, 0.002, 0.032);
  panel.translate(0.104, 0.006, 0);
  const merged = mergeBoxes([body, panel]);
  body.dispose();
  panel.dispose();
  const mat = new THREE.MeshStandardMaterial({ color: 0x8c95a6, roughness: 0.28, metalness: 0.8 });
  const mesh = new THREE.InstancedMesh(merged, mat, count);
  mesh.frustumCulled = false;
  const gpos = new Float32Array(count * 3),
    gcol = new Float32Array(count * 3);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gpos, 3).setUsage(THREE.DynamicDrawUsage));
  gg.setAttribute('color', new THREE.BufferAttribute(gcol, 3).setUsage(THREE.DynamicDrawUsage));
  const glintTex = canvasTex(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(220,235,255,0.45)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  const gm = new THREE.PointsMaterial({
    size: 0.17,
    map: glintTex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const glints = new THREE.Points(gg, gm);
  glints.frustumCulled = false;
  return {
    mesh,
    glints,
    count,
    dispose() {
      merged.dispose();
      mat.dispose();
      gg.dispose();
      gm.dispose();
      glintTex.dispose();
    },
  };
}

/** Merges non-indexed copies of simple geometries (enough for two boxes). */
function mergeBoxes(list: THREE.BufferGeometry[]) {
  const parts = list.map((g) => g.toNonIndexed());
  const n = parts.reduce((s, g) => s + g.attributes.position!.count, 0);
  const pos = new Float32Array(n * 3),
    nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position!.array as Float32Array, o * 3);
    nor.set(g.attributes.normal!.array as Float32Array, o * 3);
    o += g.attributes.position!.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
