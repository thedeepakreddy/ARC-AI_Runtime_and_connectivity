import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// The website's sky: ARC's routing drawn as orbital mechanics.
//
// · Earth's limb sits low in the frame and catches the sunrise in horizon blue, as on the icon.
// · Provider stations ride an orbit above it; your apps launch requests from the left.
// · Each request is a comet: gravity bends it around the planet while it steers for the
//   station ARC chose. When a station rate-limits (it turns amber and rests), the comets bound
//   for it re-route mid-flight to the next healthy one: fallback, made visible.
// · Stars are short streaks that stretch into a warp when you scroll fast; the pointer is a
//   gravity well that bends every comet's path; a click is a solar flare that scatters them,
//   and they find their routes again.
// · The opening (the load page): out of a warp, the limb ignites from the centre outward, the
//   sun crests, the stations light one by one and the first requests fly.
// The camera moves between shots set by the page (setShot), easing with a little lag.

export interface Sky {
  /**
   * Where the camera is on its flight (0–9, fractional between shots): 0 sunrise · 1 skimming the
   * limb · 2 the orbit from above · 3 close on a station · 4 low over the clouds · 5 wide, rising ·
   * 6 high orbit · 7 over the night side's city lights · 8 the whole globe · 9 far away.
   */
  setShot(s: number): void;
  /** How ARC works, acted out in the sky: beams to candidates, gates, ranking, the failed attempt and its fallback, the record (−1 clears). */
  flowStage(stage: number): void;
  setVelocity(v: number): void;
  setPointer(x: number | null, y: number | null): void;
  flare(x: number, y: number): void;
  /** A rate-limit on a station, with its comets re-routing (used by the fallback section). */
  failStation(): void;
  /** Warp out (Try now). */
  warp(): void;
  skipIntro(): void;
  resize(): void;
  dispose(): void;
}

const BLUE = new THREE.Color('#559ade');
const RIM = new THREE.Color('#96c4f5');
const AMBER = new THREE.Color('#ffb340');
const R_PLANET = 6;
const PLANET_Y = -7.15;

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** A soft round glow, drawn once. */
function glowTexture(stops: Array<[number, string]>) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PLANET_VERT = /* glsl */ `
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vUv = uv;
  vNw = normalize(mat3(modelMatrix) * normal);
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;
// Earth from orbit at sunrise, from real 4K maps (Solar System Scope, CC BY 4.0, from NASA
// imagery): the day side lit by the sun just behind the planet, the night side with its city
// lights, ocean glints from the roughness map, bump shading, and the atmosphere's blue fresnel.
// The intro reveals the limb from the centre outward (uReveal) and lets the lights come up.
const PLANET_FRAG = /* glsl */ `
uniform sampler2D tDay, tNight, tBRC;
uniform vec3 uBlue, uRim, uSunDir; uniform float uReveal, uSun, uLights, uDim;
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vec3 n = normalize(vNw);
  vec3 v = normalize(cameraPosition - vW);
  vec3 brc = texture2D(tBRC, vUv).rgb;
  // A little relief from the bump channel.
  vec2 px = vec2(1.0 / 4096.0, 1.0 / 2048.0);
  float bx = texture2D(tBRC, vUv + vec2(px.x, 0.0)).r - brc.r;
  float by = texture2D(tBRC, vUv + vec2(0.0, px.y)).r - brc.r;
  vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n) + 1e-4);
  vec3 b = cross(n, t);
  vec3 nb = normalize(n - (t * bx + b * by) * 2.5);
  float ndl = dot(nb, uSunDir);
  float day = smoothstep(-0.12, 0.32, ndl);
  vec3 dayCol = texture2D(tDay, vUv).rgb;
  vec3 night = texture2D(tNight, vUv).rgb;
  // Ocean glint where the surface is smooth.
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(dot(n, h), 0.0), 48.0) * (1.0 - brc.g) * day;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.6);
  float side = abs(atan(vW.x, vW.y - ${PLANET_Y.toFixed(2)}));
  float reveal = smoothstep(uReveal, uReveal - 0.35, side);
  float sunGlow = exp(-side * side * 8.0) * uSun;
  vec3 col = dayCol * day * 1.15 * reveal;
  col += night * vec3(1.0, 0.82, 0.55) * (1.0 - day) * 1.6 * uLights * (1.0 - brc.b * 0.85);
  col += vec3(0.75, 0.85, 1.0) * spec * 0.9 * reveal;
  // Atmosphere: blue at the limb, brightest towards the sun; a soft haze on the night side.
  float lit = smoothstep(-0.35, 0.55, dot(n, uSunDir));
  col = mix(col, uBlue * (0.35 + lit * 1.4), fres * (0.35 + lit * 0.5) * reveal);
  col += mix(uBlue, uRim, sunGlow) * pow(fres, 2.2) * (0.2 + sunGlow * 1.4) * reveal;
  gl_FragColor = vec4(col * uDim, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// The cloud shell, lit by the same sun, drifting a little faster than the ground.
const CLOUD_FRAG = /* glsl */ `
uniform sampler2D tBRC; uniform vec3 uSunDir; uniform float uReveal, uLights, uDim;
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vec3 n = normalize(vNw);
  float c = smoothstep(0.18, 0.9, texture2D(tBRC, vUv).b);
  float day = smoothstep(-0.1, 0.4, dot(n, uSunDir));
  float side = abs(atan(vW.x, vW.y - ${PLANET_Y.toFixed(2)}));
  float reveal = smoothstep(uReveal, uReveal - 0.35, side);
  vec3 col = vec3(1.0) * (0.03 + day * 0.95);
  gl_FragColor = vec4(col, c * (0.35 + day * 0.6) * reveal * uDim);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const ATMOS_FRAG = /* glsl */ `
uniform vec3 uBlue, uRim, uSunDir; uniform float uReveal, uSun;
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vec3 n = normalize(vNw);
  vec3 v = normalize(cameraPosition - vW);
  float rim = pow(1.0 - abs(dot(n, v)), 4.5);
  float lit = smoothstep(-0.45, 0.6, dot(n, uSunDir));
  float side = abs(atan(vW.x, vW.y - ${PLANET_Y.toFixed(2)}));
  float reveal = smoothstep(uReveal, uReveal - 0.4, side);
  float sun = exp(-side * side * 7.0) * uSun;
  vec3 col = mix(uBlue, uRim, sun) * rim * (0.25 + lit * 1.1 + sun * 1.8) * reveal;
  gl_FragColor = vec4(col, rim * reveal);
}`;

const STAR_VERT = /* glsl */ `
attribute float aEnd; attribute float aBright;
uniform float uWarp, uFade;
varying float vA;
void main(){
  vec3 p = position;
  // The tail end of each streak trails behind along the view direction; warp stretches it.
  p.z -= aEnd * (0.04 + uWarp * 3.5);
  vA = aBright * uFade * mix(1.0, 0.0, aEnd);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const STAR_FRAG = /* glsl */ `
varying float vA;
void main(){ gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * vA, vA); }`;

const TRAIL_VERT = /* glsl */ `
attribute float aA; attribute vec3 aC;
varying float vA; varying vec3 vC;
void main(){ vA = aA; vC = aC; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TRAIL_FRAG = /* glsl */ `
varying float vA; varying vec3 vC;
void main(){ gl_FragColor = vec4(vC * vA, vA); }`;

interface Station {
  pos: THREE.Vector3;
  angle: number;
  resting: number;
  pulse: number;
  lit: number;
}
interface Comet {
  p: THREE.Vector3;
  v: THREE.Vector3;
  target: number;
  trail: Float32Array;
  head: number;
  age: number;
  rerouted: number;
  alive: boolean;
}

export function createSky(
  canvas: HTMLCanvasElement,
  opts: {
    tier: 'high' | 'low' | 'software';
    intro: boolean;
    still: boolean;
    onIntroDone?: () => void;
  },
): Sky {
  const { tier, still } = opts;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: tier === 'high',
    alpha: false,
    powerPreference: 'high-performance',
  });
  const PR = Math.min(window.devicePixelRatio || 1, tier === 'high' ? 1.75 : 1.25);
  renderer.setPixelRatio(PR);
  renderer.setClearColor(0x000000, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  const rand = rng(7);

  // ---- Stars: streaks that stretch into a warp. ----
  const STARS = tier === 'high' ? 5200 : tier === 'low' ? 2600 : 1500;
  const starPos = new Float32Array(STARS * 6);
  const starEnd = new Float32Array(STARS * 2);
  const starBright = new Float32Array(STARS * 2);
  for (let i = 0; i < STARS; i++) {
    const x = (rand() - 0.5) * 160,
      y = (rand() - 0.5) * 100 + 8,
      z = -rand() * 180 + 10;
    starPos.set([x, y, z, x, y, z], i * 6);
    starEnd.set([0, 1], i * 2);
    const b = Math.pow(rand(), 2.2) * 0.9 + 0.08;
    starBright.set([b, b], i * 2);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(starPos, 3).setUsage(THREE.DynamicDrawUsage),
  );
  starGeo.setAttribute('aEnd', new THREE.BufferAttribute(starEnd, 1));
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(starBright, 1));
  const starMat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uWarp: { value: 0 }, uFade: { value: opts.intro ? 0 : 1 } },
  });
  const stars = new THREE.LineSegments(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);
  // Plus round points so stars read as stars when still.
  const dotGeo = new THREE.BufferGeometry();
  const dotPos = new Float32Array(STARS * 3);
  for (let i = 0; i < STARS; i++) dotPos.set(starPos.subarray(i * 6, i * 6 + 3), i * 3);
  dotGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(dotPos, 3).setUsage(THREE.DynamicDrawUsage),
  );
  const dotTex = glowTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(200,220,255,0.5)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const dotMat = new THREE.PointsMaterial({
    size: 0.38,
    map: dotTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: opts.intro ? 0 : 0.85,
    sizeAttenuation: true,
  });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.frustumCulled = false;
  scene.add(dots);

  // ---- Earth: real 4K maps, its clouds, and the atmosphere. ----
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const map = (name: string, srgb: boolean) => {
    const tex = loader.load(`/site-assets/earth/${name}`);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, maxAniso);
    return tex;
  };
  const tDay = map('earth_day_4096.jpg', true);
  const tNight = map('earth_night_4096.jpg', true);
  const tBRC = map('earth_bump_roughness_clouds_4096.jpg', false);
  // The sun sits just behind the planet, over the limb: a thin sunlit crescent, the rest at night.
  const sunDir = new THREE.Vector3(0, 0.42, -1).normalize();
  const pu = {
    uBlue: { value: BLUE },
    uRim: { value: RIM },
    uSunDir: { value: sunDir },
    uReveal: { value: opts.intro ? 0 : 3.2 },
    uTime: { value: 0 },
    uSun: { value: opts.intro ? 0 : 1 },
    uLights: { value: opts.intro ? 0 : 1 },
    uDim: { value: 1 },
    tDay: { value: tDay },
    tNight: { value: tNight },
    tBRC: { value: tBRC },
  };
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(R_PLANET, 192, 128),
    new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: pu,
    }),
  );
  planet.position.y = PLANET_Y;
  // Turn Europe and Africa towards the camera, their lights on the night side.
  planet.rotation.y = -Math.PI * 0.62;
  planet.rotation.x = 0.35;
  scene.add(planet);
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(R_PLANET * 1.006, 160, 112),
    new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: pu,
      transparent: true,
      depthWrite: false,
    }),
  );
  clouds.position.y = PLANET_Y;
  clouds.rotation.copy(planet.rotation);
  scene.add(clouds);
  const atmos = new THREE.Mesh(
    new THREE.SphereGeometry(R_PLANET * 1.035, 128, 96),
    new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: ATMOS_FRAG,
      uniforms: pu,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    }),
  );
  atmos.position.y = PLANET_Y;
  scene.add(atmos);
  // The sun, cresting the limb.
  const sunTex = glowTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.08, 'rgba(220,236,255,0.95)'],
    [0.25, 'rgba(120,180,240,0.35)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: opts.intro ? 0 : 0.9,
    }),
  );
  sun.position.set(0, PLANET_Y + R_PLANET + 0.02, -0.4);
  sun.scale.set(5, 5, 1);
  scene.add(sun);
  const streak = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: opts.intro ? 0 : 0.5,
      color: RIM,
    }),
  );
  streak.position.copy(sun.position);
  streak.scale.set(22, 0.55, 1);
  scene.add(streak);

  // ---- Provider stations on an orbit, and the apps that launch requests. ----
  const ORBIT_R = R_PLANET + 1.7;
  const stations: Station[] = Array.from({ length: 36 }, (_, i) => {
    const a = -1.25 + (i / 35) * 2.5; // across the upper arc of the orbit
    const tilt = (i % 3) * 0.18 - 0.18;
    const pos = new THREE.Vector3(
      Math.sin(a) * ORBIT_R,
      PLANET_Y + Math.cos(a) * ORBIT_R,
      tilt * 3 - 0.6,
    );
    return { pos, angle: a, resting: 0, pulse: 0, lit: opts.intro ? 0 : 1 };
  });
  const stationGeo = new THREE.BufferGeometry();
  const stationPos = new Float32Array(36 * 3),
    stationCol = new Float32Array(36 * 3),
    stationSize = new Float32Array(36);
  stations.forEach((s, i) => stationPos.set([s.pos.x, s.pos.y, s.pos.z], i * 3));
  stationGeo.setAttribute('position', new THREE.BufferAttribute(stationPos, 3));
  stationGeo.setAttribute(
    'color',
    new THREE.BufferAttribute(stationCol, 3).setUsage(THREE.DynamicDrawUsage),
  );
  stationGeo.setAttribute(
    'size',
    new THREE.BufferAttribute(stationSize, 1).setUsage(THREE.DynamicDrawUsage),
  );
  const nodeTex = glowTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.18, 'rgba(255,255,255,0.9)'],
    [0.4, 'rgba(255,255,255,0.18)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const stationMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTex: { value: nodeTex }, uPR: { value: PR } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uPR; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * uPR * (14.0 / -mv.z); }`,
    fragmentShader: `uniform sampler2D uTex; varying vec3 vC; void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vC * t.a, t.a); }`,
  });
  const stationPts = new THREE.Points(stationGeo, stationMat);
  stationPts.frustumCulled = false;
  scene.add(stationPts);
  const apps = [
    new THREE.Vector3(-9.5, 1.6, 0.6),
    new THREE.Vector3(-10.5, -0.6, -0.4),
    new THREE.Vector3(-8.6, -2.4, 0.8),
  ];

  // ---- Requests: comets with trails. ----
  const COMETS = tier === 'high' ? 220 : tier === 'low' ? 110 : 60;
  const TRAIL = tier === 'software' ? 12 : 22;
  const comets: Comet[] = Array.from({ length: COMETS }, () => ({
    p: new THREE.Vector3(),
    v: new THREE.Vector3(),
    target: 0,
    trail: new Float32Array(TRAIL * 3),
    head: 0,
    age: 0,
    rerouted: 0,
    alive: false,
  }));
  const segs = COMETS * (TRAIL - 1);
  const trailPos = new Float32Array(segs * 6),
    trailA = new Float32Array(segs * 2),
    trailC = new Float32Array(segs * 6);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage),
  );
  trailGeo.setAttribute(
    'aA',
    new THREE.BufferAttribute(trailA, 1).setUsage(THREE.DynamicDrawUsage),
  );
  trailGeo.setAttribute(
    'aC',
    new THREE.BufferAttribute(trailC, 3).setUsage(THREE.DynamicDrawUsage),
  );
  const trails = new THREE.LineSegments(
    trailGeo,
    new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  trails.frustumCulled = false;
  scene.add(trails);
  const headGeo = new THREE.BufferGeometry();
  const headPos = new Float32Array(COMETS * 3);
  headGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage),
  );
  const heads = new THREE.Points(
    headGeo,
    new THREE.PointsMaterial({
      size: 0.22,
      map: nodeTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color('#cfe4ff'),
    }),
  );
  heads.frustumCulled = false;
  scene.add(heads);

  // ---- How ARC works, acted out: beams from your app to candidate stations. ----
  const BEAM_SEG = 64;
  const beamStations = [4, 9, 14, 18, 22, 26, 30, 33];
  const gated = new Set([9, 22, 26, 33]);
  const ranked = [14, 4, 18, 30];
  const beamMat = (i: number) =>
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(BLUE) },
        uAlpha: { value: 0 },
        uTime: { value: 0 },
        uSpeed: { value: 0.6 + i * 0.05 },
        uHead: { value: -1 },
      },
      vertexShader:
        'varying float vT; void main(){ vT = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform vec3 uColor; uniform float uAlpha, uTime, uSpeed, uHead; varying float vT; void main(){ float dash = 0.45 + 0.55 * smoothstep(0.55, 1.0, fract(vT * 7.0 - uTime * uSpeed)); float head = uHead < 0.0 ? 0.0 : exp(-pow((vT - uHead) * 22.0, 2.0)) * 3.0; float a = uAlpha * (dash * (0.25 + 0.75 * vT) + head); gl_FragColor = vec4(uColor * a, a); }',
    });
  const beams = beamStations.map((si, i) => {
    const from = apps[0]!,
      to = stations[si]!.pos;
    const mid = from.clone().add(to).multiplyScalar(0.5);
    mid.y += 3.2 + i * 0.12;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    // A thin glowing tube (its uv.x runs along the route), so the beam has real width and depth.
    const g = new THREE.TubeGeometry(curve, BEAM_SEG * 2, 0.035, 6, false);
    const line = new THREE.Mesh(g, beamMat(i));
    line.frustumCulled = false;
    scene.add(line);
    return {
      line,
      station: si,
      alpha: 0,
      target: 0,
      color: new THREE.Color(BLUE),
      toColor: new THREE.Color(BLUE),
      head: -1,
    };
  });
  // The record: a ring of light that runs once round the planet.
  const ringTex = glowTexture([
    [0, 'rgba(0,0,0,0)'],
    [0.82, 'rgba(0,0,0,0)'],
    [0.9, 'rgba(150,196,245,0.9)'],
    [0.95, 'rgba(85,154,222,0.4)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const ring = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: ringTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    }),
  );
  ring.position.set(0, PLANET_Y, 0);
  scene.add(ring);
  let flow = -1,
    flowAt = 0,
    ringAt = -99;
  const setFlow = (stage: number) => {
    flow = stage;
    flowAt = t;
    beams.forEach((b) => {
      b.head = -1;
      if (stage < 2 || stage === 6) b.target = 0;
      else if (stage === 2) {
        b.target = 0.55;
        b.toColor.copy(BLUE);
      } else if (stage === 3) {
        b.target = gated.has(b.station) ? 0 : 0.55;
        b.toColor.copy(gated.has(b.station) ? new THREE.Color('#ff5f57') : BLUE);
        b.color.copy(gated.has(b.station) ? new THREE.Color('#ff5f57') : b.color);
      } else if (stage === 4) {
        const r = ranked.indexOf(b.station);
        b.target = r < 0 ? 0 : 1 - r * 0.2;
        b.toColor.copy(r === 0 ? RIM : BLUE);
      } else if (stage === 5) {
        const r = ranked.indexOf(b.station);
        b.target = r === 0 || r === 1 ? 0.9 : 0;
        b.toColor.copy(BLUE);
      }
    });
    if (stage === 6) ringAt = t;
  };

  // The best healthy station for a request (free, healthy, fast: here, simply the nearest healthy).
  const pickStation = (from: THREE.Vector3, avoid = -1) => {
    let best = -1,
      bestScore = Infinity;
    for (let k = 0; k < 6; k++) {
      const i = Math.floor(rand() * stations.length);
      const s = stations[i]!;
      if (i === avoid || s.resting > 0 || s.lit < 0.5) continue;
      const score = s.pos.distanceTo(from) + rand() * 4;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0)
      best = stations.findIndex((s, i) => i !== avoid && s.resting <= 0 && s.lit >= 0.5);
    return Math.max(0, best);
  };
  const launch = (c: Comet) => {
    const a = apps[Math.floor(rand() * apps.length)]!;
    c.p
      .copy(a)
      .add(new THREE.Vector3((rand() - 0.5) * 0.6, (rand() - 0.5) * 0.6, (rand() - 0.5) * 0.6));
    c.v.set(2.4 + rand() * 1.8, 1.2 + rand() * 2.4, (rand() - 0.5) * 1.2);
    c.target = pickStation(c.p);
    for (let k = 0; k < TRAIL; k++) c.trail.set([c.p.x, c.p.y, c.p.z], k * 3);
    c.head = 0;
    c.age = 0;
    c.rerouted = 0;
    c.alive = true;
  };

  // ---- Glow. ----
  let composer: EffectComposer | null = null,
    bloom: UnrealBloomPass | null = null;
  if (tier === 'high') {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.6, 0.18);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  // ---- Camera shots. ----
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const SHOTS: Array<{ pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = [
    { pos: V(0, 0.6, 13), look: V(0, -0.6, 0), fov: 38 }, // sunrise
    { pos: V(1.5, -1.5, 5.4), look: V(-2.2, -1.1, -3.2), fov: 56 }, // skimming the limb
    { pos: V(0, 9, 7.5), look: V(0, -1.2, -0.5), fov: 44 }, // the orbit from above
    { pos: V(3.2, 1.6, 6.2), look: V(1.4, -0.2, -0.4), fov: 36 }, // close on a station
    { pos: V(-4.5, -0.3, 6.2), look: V(2, -2.6, -2), fov: 50 }, // low over the clouds
    { pos: V(-6, 2.4, 14), look: V(0, -1, 0), fov: 42 }, // wide, rising
    { pos: V(5, 7, 11), look: V(0, -3, 0), fov: 40 }, // high orbit
    { pos: V(0.5, -4.2, 10.4), look: V(0, -6.6, 0), fov: 44 }, // the night side's city lights
    { pos: V(0, -3, 22), look: V(0, -6.2, 0), fov: 40 }, // the whole globe
    { pos: V(0, -1.5, 31), look: V(0, -4.4, 0), fov: 36 }, // far away
  ];

  let shot = 0,
    shown = 0,
    scrollV = 0,
    warp = opts.intro ? 3 : 0,
    warpOut = 0;
  let px: number | null = null,
    py: number | null = null;
  const lean = new THREE.Vector2();
  const camPos = SHOTS[0]!.pos.clone(),
    camLook = SHOTS[0]!.look.clone();
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  const well = new THREE.Vector3(99, 99, 99);
  let flareAt = -99;
  const flarePos = new THREE.Vector3();
  let t = 0,
    last = performance.now(),
    raf = 0,
    nextFail = 6,
    introClock = 0,
    introOn = opts.intro,
    introDoneSent = false,
    spawnAcc = 0;

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth,
      h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    bloom?.setSize(Math.floor(w / 2), Math.floor(h / 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  const ray = new THREE.Raycaster(),
    plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    ndc = new THREE.Vector2();
  const toWorld = (x: number, y: number, out: THREE.Vector3) => {
    ndc.set(x, y);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(plane, out) ?? out.set(99, 99, 99);
  };

  const smooth = (x: number) => x * x * (3 - 2 * x);
  const tmp = new THREE.Vector3(),
    tmp2 = new THREE.Vector3(),
    center = new THREE.Vector3(0, PLANET_Y, 0);

  const step = (now: number) => {
    const real = Math.min(0.1, (now - last) / 1000);
    last = now;
    const dt = Math.min(0.033, real);
    t += dt;

    // ---- The opening. ----
    let netOn = 1;
    if (introOn) {
      if (!introClock) introClock = now;
      const it = (now - introClock) / 1000;
      // Out of a warp (0–1.6 s), the limb ignites from the centre (1.4–2.8 s), the sun crests
      // (2.2–3.2 s), the stations light (2.8–4.0 s), the first requests fly (from 3.4 s).
      warp = Math.max(0, 3 * (1 - smooth(Math.min(1, it / 1.6))));
      starMat.uniforms.uFade!.value = Math.min(1, it / 0.6);
      dotMat.opacity = Math.min(0.85, it / 1.2);
      pu.uReveal.value = 3.2 * smooth(Math.min(1, Math.max(0, (it - 1.4) / 1.4)));
      pu.uSun.value = smooth(Math.min(1, Math.max(0, (it - 2.2) / 1.0)));
      pu.uLights.value = smooth(Math.min(1, Math.max(0, (it - 1.8) / 1.6)));
      (sun.material as THREE.SpriteMaterial).opacity =
        0.9 * pu.uSun.value + 0.6 * Math.max(0, 1 - Math.abs(it - 2.6) * 1.5);
      (streak.material as THREE.SpriteMaterial).opacity = 0.5 * pu.uSun.value;
      sun.scale.setScalar(5 + Math.max(0, 1 - Math.abs(it - 2.6)) * 6);
      stations.forEach((s, i) => {
        s.lit = it > 2.8 + i * 0.03 ? 1 : 0;
      });
      netOn = it > 3.4 ? 1 : 0;
      if (it > 4.4 && !introDoneSent) {
        introDoneSent = true;
        opts.onIntroDone?.();
      }
      if (it > 4.6) introOn = false;
    }

    // ---- Camera: ease to the shot, lean to the pointer, shake on flare. ----
    shown += (shot - shown) * Math.min(1, real * 1.8);
    const a = Math.floor(shown),
      b = Math.min(SHOTS.length - 1, a + 1),
      f = smooth(shown - a);
    const A = SHOTS[a]!,
      B = SHOTS[b]!;
    tmp.lerpVectors(A.pos, B.pos, f);
    tmp2.lerpVectors(A.look, B.look, f);
    lean.x += ((px ?? 0) * 0.9 - lean.x) * Math.min(1, real * 2);
    lean.y += ((py ?? 0) * 0.5 - lean.y) * Math.min(1, real * 2);
    camPos.lerp(tmp, Math.min(1, real * 2.4));
    camLook.lerp(tmp2, Math.min(1, real * 2.4));
    const flareAge = t - flareAt;
    const shake = flareAge < 0.6 ? (0.6 - flareAge) * 0.25 : 0;
    camera.position.set(
      camPos.x + lean.x + (Math.random() - 0.5) * shake,
      camPos.y + lean.y + (Math.random() - 0.5) * shake,
      camPos.z - warpOut * 10,
    );
    camera.fov =
      THREE.MathUtils.lerp(A.fov, B.fov, f) + warpOut * 30 + Math.min(10, Math.abs(scrollV) / 700);
    camera.updateProjectionMatrix();
    camera.lookAt(camLook);

    // ---- Stars: drift, and stream past in a warp. ----
    scrollV *= Math.pow(0.04, real);
    const w = warp + warpOut * 6 + Math.min(2.5, Math.abs(scrollV) / 1600);
    starMat.uniforms.uWarp!.value = w;
    const sp = (0.4 + w * 26) * dt;
    for (let i = 0; i < STARS; i++) {
      const o = i * 6;
      let z = starPos[o + 2]! + sp;
      if (z > 14) z -= 190;
      starPos[o + 2] = z;
      starPos[o + 5] = z;
      dotPos[i * 3 + 2] = z;
    }
    (starGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (dotGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    dotMat.opacity = introOn ? dotMat.opacity : Math.max(0.15, 0.85 - w * 0.25);

    // ---- Stations: resting after a rate limit, pulses on arrival. ----
    nextFail -= dt;
    if (nextFail <= 0 && netOn) {
      failOne();
      nextFail = 7 + rand() * 5;
    }
    stations.forEach((s, i) => {
      s.resting = Math.max(0, s.resting - dt);
      s.pulse *= Math.pow(0.02, dt);
      const col = s.resting > 0 ? AMBER : BLUE;
      const k =
        s.lit * (0.55 + s.pulse * 1.6 + (s.resting > 0 ? 0.35 + 0.35 * Math.sin(t * 9) : 0));
      stationCol.set(
        [col.r * k + s.pulse * 0.6, col.g * k + s.pulse * 0.6, col.b * k + s.pulse * 0.6],
        i * 3,
      );
      stationSize[i] = (s.resting > 0 ? 1.6 : 1.1) + s.pulse * 1.8;
    });
    (stationGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (stationGeo.attributes.size as THREE.BufferAttribute).needsUpdate = true;

    // ---- Requests: gravity, steering, the pointer's well, flares, fallback. ----
    if (px != null && py != null) toWorld(px, py, well);
    else well.set(99, 99, 99);
    const rate = netOn
      ? (tier === 'software' ? 8 : 18) * (1 + Math.min(2, Math.abs(scrollV) / 1500))
      : 0;
    spawnAcc += rate * dt;
    for (const c of comets) {
      if (!c.alive) {
        if (spawnAcc >= 1) {
          launch(c);
          spawnAcc -= 1;
        }
        continue;
      }
      c.age += dt;
      const target = stations[c.target]!;
      if (target.resting > 0 && c.rerouted < 2) {
        // Fallback: the next healthy station, without starting over.
        c.target = pickStation(c.p, c.target);
        c.rerouted++;
      }
      // Gravity of the planet (softened inverse square).
      tmp.subVectors(center, c.p);
      const d2 = Math.max(tmp.lengthSq(), R_PLANET * R_PLANET * 0.9);
      tmp.normalize().multiplyScalar(52 / d2);
      // Steering for the chosen station, arriving gently.
      tmp2.subVectors(target.pos, c.p);
      const dist = tmp2.length();
      const desired = tmp2.normalize().multiplyScalar(Math.min(9, dist * 2.2));
      desired.sub(c.v).multiplyScalar(1.6);
      c.v.addScaledVector(tmp, dt).addScaledVector(desired, dt);
      // The pointer bends paths, like a small mass.
      const dw = well.distanceTo(c.p);
      if (dw < 5) {
        tmp
          .subVectors(well, c.p)
          .normalize()
          .multiplyScalar((5 - dw) * 4.5);
        c.v.addScaledVector(tmp, dt);
      }
      // A flare pushes outward from where it struck.
      if (flareAge < 1.2) {
        tmp.subVectors(c.p, flarePos);
        const fd = tmp.length() + 0.1;
        const ring = Math.exp(-Math.pow((fd - flareAge * 14) * 0.7, 2));
        c.v.addScaledVector(tmp.normalize(), ring * 60 * dt);
      }
      // Never fall into the planet: slide along the atmosphere.
      tmp.subVectors(c.p, center);
      if (tmp.length() < R_PLANET * 1.06) {
        tmp.normalize();
        c.p.copy(center).addScaledVector(tmp, R_PLANET * 1.06);
        c.v.addScaledVector(tmp, -c.v.dot(tmp));
      }
      c.p.addScaledVector(c.v, dt);
      c.head = (c.head + 1) % TRAIL;
      c.trail.set([c.p.x, c.p.y, c.p.z], c.head * 3);
      if (dist < 0.28 || c.age > 9) {
        if (dist < 0.28) target.pulse = Math.min(1.4, target.pulse + 0.5);
        c.alive = false;
      }
    }
    // Write trails (newest bright, oldest gone; re-routed comets carry a touch of amber).
    let s = 0;
    for (let ci = 0; ci < COMETS; ci++) {
      const c = comets[ci]!;
      headPos.set(c.alive ? [c.p.x, c.p.y, c.p.z] : [0, -999, 0], ci * 3);
      const col = c.rerouted ? tmp.set(0.95, 0.78, 0.5) : tmp.set(0.55, 0.78, 1);
      for (let k = 0; k < TRAIL - 1; k++) {
        const i0 = ((c.head - k + TRAIL) % TRAIL) * 3,
          i1 = ((c.head - k - 1 + TRAIL) % TRAIL) * 3;
        const o = s * 6;
        trailPos[o] = c.trail[i0]!;
        trailPos[o + 1] = c.trail[i0 + 1]!;
        trailPos[o + 2] = c.trail[i0 + 2]!;
        trailPos[o + 3] = c.trail[i1]!;
        trailPos[o + 4] = c.trail[i1 + 1]!;
        trailPos[o + 5] = c.trail[i1 + 2]!;
        const fade = c.alive ? 1 - k / (TRAIL - 1) : 0;
        trailA[s * 2] = fade * 0.9;
        trailA[s * 2 + 1] = fade * 0.85;
        trailC.set([col.x, col.y, col.z, col.x, col.y, col.z], o);
        s++;
      }
    }
    (trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (trailGeo.attributes.aA as THREE.BufferAttribute).needsUpdate = true;
    (trailGeo.attributes.aC as THREE.BufferAttribute).needsUpdate = true;
    (headGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    pu.uTime.value = t;
    planet.rotation.y += dt * 0.004;
    clouds.rotation.y += dt * 0.0055;
    if (bloom) bloom.strength = 0.7 + Math.max(0, 0.6 - flareAge) * 1.5 + warpOut * 1.5;
    // The walkthrough's beams: fade to their targets; during "execute", a packet runs the best
    // route, the station refuses (it rests, amber), and a second packet takes the next route.
    const since = t - flowAt;
    beams.forEach((b) => {
      let target = b.target;
      if (flow === 5) {
        const r = ranked.indexOf(b.station);
        if (r === 0) {
          b.head = Math.min(1, since / 0.9);
          if (since > 0.9 && stations[b.station]!.resting <= 0 && since < 1.2) {
            stations[b.station]!.resting = 5;
            flareAt = t;
            flarePos.copy(stations[b.station]!.pos);
          }
          if (since > 0.9) {
            b.toColor.set('#ffb340');
            target = Math.max(0, 0.9 - (since - 0.9) * 0.6);
          }
        } else if (r === 1) {
          b.head = since > 1.1 ? Math.min(1, (since - 1.1) / 0.9) : -1;
          if (since > 2.0)
            stations[b.station]!.pulse = Math.min(1.4, stations[b.station]!.pulse + dt * 2);
          b.toColor.copy(since > 1.1 ? RIM : BLUE);
        }
      }
      b.alpha += (target - b.alpha) * Math.min(1, real * 3);
      b.color.lerp(b.toColor, Math.min(1, real * 3));
      const u = (b.line.material as THREE.ShaderMaterial).uniforms;
      u.uAlpha!.value = b.alpha;
      u.uTime!.value = t;
      u.uHead!.value = b.head;
      (u.uColor!.value as THREE.Color).copy(b.color);
      b.line.visible = b.alpha > 0.005;
    });
    const ringAge = t - ringAt;
    const rm = ring.material as THREE.SpriteMaterial;
    rm.opacity = ringAge < 2.4 ? Math.max(0, 1 - ringAge / 2.4) * 0.9 : 0;
    ring.scale.setScalar(R_PLANET * 2.05 * (1 + Math.min(1, ringAge / 2.4) * 0.35));

    if (composer) composer.render();
    else renderer.render(scene, camera);
    if (!still) raf = requestAnimationFrame(step);
  };

  function failOne() {
    const healthy = stations.map((s, i) => [s, i] as const).filter(([s]) => s.resting <= 0);
    const pick = healthy[Math.floor(rand() * healthy.length)];
    if (pick) pick[0].resting = 4 + rand() * 3;
  }

  if (still) {
    // A finished, still frame: the limb lit, stations on, no motion.
    for (let k = 0; k < 90; k++) step(performance.now() + k * 16);
  } else raf = requestAnimationFrame(step);

  return {
    setShot(v) {
      shot = Math.max(0, Math.min(SHOTS.length - 1, v));
    },
    setVelocity(v) {
      scrollV = Math.max(-8000, Math.min(8000, v));
    },
    setPointer(x, y) {
      px = x;
      py = y;
    },
    flare(x, y) {
      toWorld(x, y, flarePos);
      flareAt = t;
    },
    failStation() {
      failOne();
    },
    flowStage(stage) {
      setFlow(stage);
    },
    warp() {
      const t0 = performance.now();
      const tick = () => {
        warpOut = Math.min(1, (performance.now() - t0) / 700);
        if (warpOut < 1) requestAnimationFrame(tick);
      };
      tick();
    },
    skipIntro() {
      if (introOn) introClock = performance.now() - 4300;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      [dotTex, sunTex, nodeTex, tDay, tNight, tBRC, ringTex].forEach((x) => x.dispose());
      composer?.dispose();
      renderer.dispose();
    },
  };
}

/** How much the device can take. */
export function skyTier(): 'high' | 'low' | 'software' {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'software';
  } catch {
    // Unknown: assume a real GPU.
  }
  const coarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return window.innerWidth < 768 || coarse ? 'low' : 'high';
}
