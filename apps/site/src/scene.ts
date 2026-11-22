import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { noteError, skyDebug } from './debug';
import { buildStation, buildTrain } from './orbiters';
import { type Res, SKY_ASSETS } from './skyAssets';

// The website's sky: ARC's routing drawn as orbital mechanics, over a real sky.
//
// · Earth from real 4K maps, lit by a sun far away: a sunlit crescent that reddens at the
//   terminator, ocean glints, cloud shadows, city lights on the night side, and an atmosphere that
//   blazes into an arc of light around the limb when you look towards the sun.
// · Behind it, the real night sky at infinity: the catalogue's stars at their true positions,
//   brightness and colour, and the Milky Way (its core rising behind the planet), both built from
//   real catalogues by scripts/build-sky.py.
// · In orbit, a space station (its solar wings turning to the sun) and a train of broadband
//   satellites that glint in sunlight and go dark in Earth's shadow.
// · Provider stations ride an orbit above it; your apps launch requests from the left.
// · Each request is a comet: gravity bends it around the planet while it steers for the
//   station ARC chose. When a station rate-limits (it turns amber and rests), the comets bound
//   for it re-route mid-flight to the next healthy one: fallback, made visible.
// · Nearby motes stretch into a warp when you scroll fast; the pointer is a gravity well that
//   bends every comet's path; a click is a solar flare that scatters them.
// · The opening (the load page): out of a warp, the limb ignites from the centre outward, the
//   sun crests, the stations light one by one and the first requests fly.
// The camera flies between shots set by the page (setShot), easing with a little lag.

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
  /** Undo the warp (the page came back, e.g. from the back/forward cache). */
  unwarp(): void;
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
// Earth from real 4K maps (Solar System Scope, CC BY 4.0, from NASA imagery), lit by a sun far
// away: the day side in sunlight that reddens through the long air path near the terminator,
// ocean glints, clouds that cast shadows, city lights on the night side under those clouds, and
// the atmosphere thickening into a blue haze towards the limb. The intro reveals the limb from
// the centre outward (uReveal) and lets the lights come up (uLights).
const PLANET_FRAG = /* glsl */ `
uniform sampler2D tDay, tNight, tBRC;
uniform vec3 uBlue, uSunDir, uAxis; uniform float uReveal, uLights, uCloudU, uReady;
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vec3 n = normalize(vNw);
  vec3 v = normalize(cameraPosition - vW);
  vec3 L = uSunDir;
  vec3 brc = texture2D(tBRC, vUv).rgb;
  // Relief from the bump channel, along the planet's own east and north.
  vec2 px = vec2(1.0 / 4096.0, 1.0 / 2048.0);
  float bx = texture2D(tBRC, vUv + vec2(px.x, 0.0)).r - brc.r;
  float by = texture2D(tBRC, vUv + vec2(0.0, px.y)).r - brc.r;
  vec3 east = normalize(cross(uAxis, n) + 1e-4);
  vec3 north = cross(n, east);
  vec3 nb = normalize(n - (east * bx + north * by) * 3.0);
  float mu = dot(n, L);
  float day = smoothstep(-0.05, 0.22, dot(nb, L));
  vec3 sunCol = mix(vec3(1.0, 0.4, 0.14), vec3(1.0, 0.97, 0.93), smoothstep(-0.02, 0.14, mu));
  float ocean = 1.0 - brc.g;
  vec3 albedo = texture2D(tDay, vUv).rgb;
  albedo = mix(albedo, albedo * vec3(0.7, 0.84, 1.0), ocean * 0.45);
  vec2 cuv = vUv - vec2(uCloudU, 0.0);
  float cloud = smoothstep(0.18, 0.9, texture2D(tBRC, cuv).b);
  float shade = smoothstep(0.18, 0.9, texture2D(tBRC, cuv + vec2(dot(L, east), dot(L, north)) * 0.004).b);
  vec3 col = albedo * sunCol * day * (1.0 - shade * 0.5) * 1.3;
  // The sun's reflection on the sea: a sharp glint and a broad sheen.
  float nh = max(dot(n, normalize(L + v)), 0.0);
  col += sunCol * (pow(nh, 300.0) * 4.0 + pow(nh, 24.0) * 0.16) * ocean * day * (1.0 - cloud);
  // City lights, only where it is night, dimmed under cloud.
  float night = 1.0 - smoothstep(-0.16, 0.05, mu);
  vec3 lights = pow(texture2D(tNight, vUv).rgb, vec3(1.3)) * vec3(1.0, 0.76, 0.46);
  lights *= night * (1.0 - cloud * 0.75) * 1.9 * uLights;
  // Looking through more air towards the limb: blue haze where the air is sunlit.
  float path = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  float air = smoothstep(-0.22, 0.35, mu);
  vec3 sky = uBlue * 1.15 + vec3(0.04, 0.07, 0.11);
  col = mix(col, sky * air, path * 0.7 * air) + sky * path * air * 0.3;
  // Twilight: the band along the terminator glows orange.
  float twi = exp(-pow((mu - 0.03) / 0.07, 2.0));
  col += vec3(1.0, 0.42, 0.16) * twi * (0.015 + path * 0.35) * day;
  float side = abs(atan(vW.x, vW.y - ${PLANET_Y.toFixed(2)}));
  float reveal = smoothstep(uReveal, uReveal - 0.35, side);
  col = (col * reveal + lights) * uReady;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// The cloud shell, drifting a little faster than the ground: white in sunlight, orange at the
// terminator, dark grey at night (where it hides the city lights below).
const CLOUD_FRAG = /* glsl */ `
uniform sampler2D tBRC; uniform vec3 uSunDir; uniform float uReveal, uReady;
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vec3 n = normalize(vNw);
  float c = smoothstep(0.18, 0.9, texture2D(tBRC, vUv).b);
  float mu = dot(n, uSunDir);
  float day = smoothstep(-0.06, 0.25, mu);
  vec3 sunCol = mix(vec3(1.0, 0.42, 0.16), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.15, mu));
  vec3 col = sunCol * day * 1.08 + vec3(0.012, 0.016, 0.024);
  col += vec3(1.0, 0.45, 0.18) * exp(-pow(mu / 0.1, 2.0)) * 0.35;
  float side = abs(atan(vW.x, vW.y - ${PLANET_Y.toFixed(2)}));
  float reveal = smoothstep(uReveal, uReveal - 0.35, side);
  gl_FragColor = vec4(col, c * (0.55 + day * 0.4) * reveal * uReady);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// The atmosphere as seen against space: for each ray from the camera, how close it passes to the
// ground sets how much air it crosses. Sunlit air scatters blue (Rayleigh); looking towards the sun
// through the limb it blazes white-gold (forward scattering): the arc of sunrise around the planet.
const ATMOS_FRAG = /* glsl */ `
uniform vec3 uBlue, uSunDir, uCenter; uniform float uReveal, uSun, uR;
varying vec3 vNw; varying vec3 vW; varying vec2 vUv;
void main(){
  vec3 rd = normalize(vW - cameraPosition);
  vec3 oc = uCenter - cameraPosition;
  vec3 closest = cameraPosition + rd * dot(oc, rd);
  vec3 up = closest - uCenter;
  float h = (length(up) - uR) / (uR * 0.05);
  if (h < 0.0) h = 0.0;
  float dens = exp(-h * 4.5) * (1.0 - smoothstep(0.7, 1.0, h));
  float mu = dot(normalize(up), uSunDir);
  float lit = smoothstep(-0.3, 0.4, mu);
  float toward = max(dot(rd, uSunDir), 0.0);
  float mie = pow(toward, 8.0) * 0.9 + pow(toward, 40.0) * 1.1;
  vec3 col = uBlue * (0.25 + 1.6 * lit) * lit * dens;
  col += vec3(1.0, 0.86, 0.64) * mie * dens * smoothstep(-0.4, 0.1, mu) * uSun;
  col += vec3(1.0, 0.45, 0.18) * exp(-pow(mu / 0.14, 2.0)) * dens * 0.9;
  float side = abs(atan(vW.x, vW.y - ${PLANET_Y.toFixed(2)}));
  float reveal = smoothstep(uReveal, uReveal - 0.4, side);
  gl_FragColor = vec4(col * reveal, 1.0);
}`;

// The real night sky, at infinity: the Milky Way drawn from the Milky Way Outline Catalog, in
// galactic coordinates (built by scripts/build-sky.py), sampled per pixel so there is no seam.
const MW_VERT = /* glsl */ `
varying vec3 vD;
void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MW_FRAG = /* glsl */ `
uniform sampler2D tMW; uniform float uFade, uExposure;
varying vec3 vD;
void main(){
  vec3 d = normalize(vD);
  float u = fract(atan(-d.z, d.x) / 6.2831853);
  float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  gl_FragColor = vec4(texture2D(tMW, vec2(u, v)).rgb * uExposure * uFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// Catalogue stars (Hipparcos, to magnitude 7.5): size and brightness from magnitude, colour from B−V.
const SKYSTAR_VERT = /* glsl */ `
attribute float aSize; attribute vec3 aCol;
uniform float uPR, uFade;
varying vec3 vC;
void main(){
  vC = aCol * uFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPR;
}`;
const SKYSTAR_FRAG = /* glsl */ `
varying vec3 vC;
void main(){
  vec2 q = gl_PointCoord - 0.5;
  float a = exp(-dot(q, q) * 22.0);
  gl_FragColor = vec4(vC * a, a);
}`;

/** A star's colour from its B−V index (via its temperature). */
function bvColor(bv: number): [number, number, number] {
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = T / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (x: number) => Math.min(1, Math.max(0, x / 255));
  return [c(r), c(g), c(b)];
}

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
  // iPads and iPhones: Safari caps a page's graphics memory, and running over it drops the whole
  // canvas (black). On iOS, render at a lower density and never hold two sets of maps at once.
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const PR = Math.min(
    window.devicePixelRatio || 1,
    ios ? (tier === 'high' ? 1.5 : 1.25) : tier === 'high' ? 1.75 : 1.25,
  );
  renderer.setPixelRatio(PR);
  renderer.setClearColor(0x000000, 1);
  // Diagnostics (?debug=1): the GPU, its limits, a lost context, shader errors.
  skyDebug.tier = ios ? `${tier} (iOS)` : tier;
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    skyDebug.gpu = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
  } catch (e) {
    noteError('gpu', e);
  }
  skyDebug.maxTexture = renderer.capabilities.maxTextureSize;
  canvas.addEventListener('webglcontextlost', () => skyDebug.contextLost++);
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    noteError(
      'shader',
      gl.getProgramInfoLog(program) || gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs),
    );
  };
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
    const b = Math.pow(rand(), 2.2) * 0.5 + 0.04;
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
  // Nearby motes for depth: they drift past as the camera flies; the real stars sit behind them.
  const DOTS = 0.32;
  const dotMat = new THREE.PointsMaterial({
    size: 0.38,
    map: dotTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: opts.intro ? 0 : DOTS,
    sizeAttenuation: true,
  });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.frustumCulled = false;
  scene.add(dots);

  // ---- Loading: a still frame (reduced motion) draws again once the maps arrive. ----
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url) => skyDebug.loaded.push(url.split('/').pop() ?? url);
  manager.onError = (url) => skyDebug.failed.push(url.split('/').pop() ?? url);
  const loader = new THREE.TextureLoader(manager);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---- The real sky, at infinity: the Milky Way and the catalogue's stars. ----
  // Both are in galactic coordinates (x towards the galactic centre, y to its north pole); the
  // frame is turned so the core rises behind the planet on the left and the band arcs across.
  const celestial = new THREE.Group();
  {
    const gc = new THREE.Vector3(-0.42, 0.2, -0.885).normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(gc, -gc.y).normalize();
    const right = new THREE.Vector3().crossVectors(gc, up).normalize();
    const pole = up.multiplyScalar(Math.cos(0.62)).addScaledVector(right, Math.sin(0.62));
    const third = new THREE.Vector3().crossVectors(gc, pole);
    celestial.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(gc, pole, third));
  }
  scene.add(celestial);
  // Maps load at 2K first (quick, and all a phone or tablet needs); capable desktops then swap in
  // the 4K versions in the background.
  // Map sizes: every screen with a real GPU gets the 4K maps, loaded once (never a 2K set and a
  // 4K set in memory together); software renderers get 2K.
  const RES: Res = tier === 'software' ? 2048 : 4096;
  const prepMW = (t: THREE.Texture) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false; // sampled by direction: mipmaps would show the u seam
    t.minFilter = THREE.LinearFilter;
    return t;
  };
  const tMW = prepMW(loader.load(SKY_ASSETS.milkyway[RES]));
  const mwMat = new THREE.ShaderMaterial({
    vertexShader: MW_VERT,
    fragmentShader: MW_FRAG,
    uniforms: {
      tMW: { value: tMW },
      uFade: { value: opts.intro ? 0 : 1 },
      uExposure: { value: tier === 'high' ? 0.19 : 0.27 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(300, 64, 32), mwMat);
  milkyWay.renderOrder = -10;
  milkyWay.frustumCulled = false;
  celestial.add(milkyWay);
  const skyStarMat = new THREE.ShaderMaterial({
    vertexShader: SKYSTAR_VERT,
    fragmentShader: SKYSTAR_FRAG,
    uniforms: { uPR: { value: PR }, uFade: { value: opts.intro ? 0 : 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const SKY_STARS = tier === 'high' ? 26000 : tier === 'low' ? 12000 : 5000;
  let skyStars: THREE.Points | null = null;
  let disposed = false;
  fetch(SKY_ASSETS.stars)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((buf) => {
      if (disposed) return;
      const rec = new Int16Array(buf);
      const n = Math.min(SKY_STARS, Math.floor(rec.length / 5));
      const pos = new Float32Array(n * 3),
        col = new Float32Array(n * 3),
        size = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 5,
          k = 290 / 32767;
        pos.set([rec[o]! * k, rec[o + 1]! * k, rec[o + 2]! * k], i * 3);
        const mag = rec[o + 3]! / 1000;
        const [r, g, b] = bvColor(rec[o + 4]! / 1000);
        // Brightness from magnitude: faint stars just glimmer; the brightest overflow into the bloom.
        const lum = Math.min(4, 0.95 * Math.pow(10, -0.2 * (mag - 3.2)));
        col.set([r * lum, g * lum, b * lum], i * 3);
        size[i] = Math.min(9, Math.max(2.2, 7.5 * Math.pow(10, -0.09 * (mag + 0.5))));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      skyStars = new THREE.Points(g, skyStarMat);
      skyStars.renderOrder = -9;
      skyStars.frustumCulled = false;
      celestial.add(skyStars);
      if (still) render();
    })
    .catch(() => undefined);

  // ---- Earth: real 4K maps, its clouds, and the atmosphere. ----
  let earthLoaded = 0,
    earthReady = false,
    readyAt = 0;
  // A map that fails still counts, so the opening never waits on it (the planet shows what it has).
  // The planet shows once its day and night maps are in; the bump/roughness/clouds map (the
  // largest) fills in when it lands, with a neutral stand-in until then.
  const arrived = () => {
    if (++earthLoaded === 2) {
      earthReady = true;
      readyAt = performance.now();
    }
  };
  const prepMap = (tex: THREE.Texture, srgb: boolean) => {
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, maxAniso);
    return tex;
  };
  const map = (name: 'earth_day' | 'earth_night', srgb: boolean) =>
    prepMap(loader.load(SKY_ASSETS[name][RES], arrived, undefined, arrived), srgb);
  const tDay = map('earth_day', true);
  const tNight = map('earth_night', true);
  // Stand-in for the bump/roughness/clouds map: flat (bump 0.5), rough land (no glint), no cloud.
  const brcStandIn = new THREE.DataTexture(new Uint8Array([128, 255, 0, 255]), 1, 1);
  brcStandIn.needsUpdate = true;
  const brcLoaded = prepMap(
    loader.load(SKY_ASSETS.earth_bump_roughness_clouds[RES], (t) => {
      if (disposed) return;
      pu.tBRC.value = t;
      if (still) render();
    }),
    false,
  );
  const tBRC: THREE.Texture = brcStandIn;
  // The sun, far away and just over the limb (from the opening shot): Earth is lit from behind
  // and to the right, so its day side is a crescent and the sunlit air makes an arc of light.
  const sunDir = new THREE.Vector3(0.34, 0.17, -0.925).normalize();
  const center = new THREE.Vector3(0, PLANET_Y, 0);
  const pu = {
    uBlue: { value: BLUE },
    uSunDir: { value: sunDir },
    uAxis: { value: new THREE.Vector3(0, 1, 0) },
    uCenter: { value: center },
    uR: { value: R_PLANET },
    uCloudU: { value: 0 },
    uReveal: { value: opts.intro ? 0 : 3.2 },
    uTime: { value: 0 },
    uSun: { value: opts.intro ? 0 : 1 },
    uLights: { value: opts.intro ? 0 : 1 },
    uReady: { value: 0 },
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
  pu.uAxis.value.set(0, 1, 0).applyQuaternion(planet.quaternion);
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
    new THREE.SphereGeometry(R_PLANET * 1.05, 128, 96),
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

  // ---- In orbit: a space station and a train of broadband satellites. ----
  // Lit by the sun (and a little blue earthshine from below), dark in Earth's shadow.
  const sunLight = new THREE.DirectionalLight(0xfff6ea, 3.2);
  sunLight.position.copy(sunDir).multiplyScalar(50);
  scene.add(sunLight, sunLight.target);
  const earthLight = new THREE.DirectionalLight(0x6f9fd8, 0.5);
  scene.add(earthLight, earthLight.target);
  scene.add(new THREE.AmbientLight(0x1a2230, 1.4));
  const orbitBasis = (n: THREE.Vector3) => {
    const nn = n.clone().normalize();
    const e1 = new THREE.Vector3(0, 1, 0).addScaledVector(nn, -nn.y).normalize();
    return { e1, e2: new THREE.Vector3().crossVectors(nn, e1) };
  };
  /** 1 in sunlight, 0 in Earth's shadow (a cylinder behind the planet, away from the sun). */
  const sunlit = (p: THREE.Vector3) => {
    const sx = p.x - center.x,
      sy = p.y - center.y,
      sz = p.z - center.z;
    const along = sx * sunDir.x + sy * sunDir.y + sz * sunDir.z;
    if (along > 0) return 1;
    const perp = Math.sqrt(Math.max(0, sx * sx + sy * sy + sz * sz - along * along));
    return smooth(Math.min(1, Math.max(0, (perp - R_PLANET * 0.98) / (R_PLANET * 0.06))));
  };
  const station = buildStation();
  station.group.scale.setScalar(1.45);
  scene.add(station.group);
  const ST = {
    r: R_PLANET + 1.05,
    w: (Math.PI * 2) / 260,
    a: -0.5,
    ...orbitBasis(new THREE.Vector3(0.18, 0.3, 1)),
  };
  const TRAIN_N = tier === 'software' ? 16 : 26;
  const train = buildTrain(TRAIN_N);
  scene.add(train.mesh, train.glints);
  const TR = {
    r: R_PLANET + 0.85,
    w: (Math.PI * 2) / 240,
    a: 0.18,
    gap: 0.021,
    ...orbitBasis(new THREE.Vector3(-0.35, 0.22, 1)),
  };
  const oP = new THREE.Vector3(),
    oT = new THREE.Vector3(),
    oR = new THREE.Vector3(),
    oX = new THREE.Vector3(),
    oM = new THREE.Matrix4(),
    oQ = new THREE.Quaternion(),
    oS = new THREE.Vector3(1, 1, 1),
    oC = new THREE.Color();
  /** Position and flight direction on an orbit at angle a. */
  const orbitAt = (o: typeof ST, a: number, pos: THREE.Vector3, dir: THREE.Vector3) => {
    pos
      .copy(center)
      .addScaledVector(o.e1, Math.cos(a) * o.r)
      .addScaledVector(o.e2, Math.sin(a) * o.r);
    dir.copy(o.e1).multiplyScalar(-Math.sin(a)).addScaledVector(o.e2, Math.cos(a));
  };
  const placeOrbiters = (dt: number) => {
    ST.a += ST.w * dt;
    orbitAt(ST, ST.a, oP, oT);
    oR.subVectors(oP, center).normalize();
    oX.crossVectors(oR, oT).normalize();
    station.group.position.copy(oP);
    station.group.quaternion.setFromRotationMatrix(
      oM.makeBasis(oX, oR.clone().crossVectors(oT, oX), oT),
    );
    station.track(sunDir);
    const lit = sunlit(oP);
    sunLight.intensity = 3.2 * lit;
    earthLight.position.copy(center);
    earthLight.target.position.copy(oP);
    earthLight.intensity = 0.9 + 0.6 * lit;
    TR.a -= TR.w * dt;
    const gp = train.glints.geometry.attributes.position as THREE.BufferAttribute,
      gc = train.glints.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < TRAIN_N; i++) {
      orbitAt(TR, TR.a + i * TR.gap, oP, oT);
      oT.negate();
      oR.subVectors(oP, center).normalize();
      oX.crossVectors(oR, oT).normalize();
      oQ.setFromRotationMatrix(oM.makeBasis(oT, oR, oX));
      train.mesh.setMatrixAt(i, oM.compose(oP, oQ, oS));
      const l = sunlit(oP);
      train.mesh.setColorAt(i, oC.setScalar(0.08 + 0.92 * l));
      // Each catches the sun now and then as it turns: a soft glow, and brief flashes.
      const flash = Math.pow(Math.max(0, Math.sin(t * 0.9 + i * 0.73)), 24);
      const k = l * (0.85 + 1.8 * flash);
      gp.setXYZ(i, oP.x, oP.y, oP.z);
      gc.setXYZ(i, k, k, k * 1.05);
    }
    train.mesh.instanceMatrix.needsUpdate = true;
    if (train.mesh.instanceColor) train.mesh.instanceColor.needsUpdate = true;
    gp.needsUpdate = true;
    gc.needsUpdate = true;
  };

  // ---- The sun, at infinity: a small white-hot disc, its glare, and the lens's ghosts. ----
  const sunCoreTex = glowTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.1, 'rgba(255,253,246,1)'],
    [0.16, 'rgba(255,240,214,0.55)'],
    [0.45, 'rgba(255,220,180,0.08)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const glareTex = glowTexture([
    [0, 'rgba(255,248,236,0.55)'],
    [0.2, 'rgba(200,222,250,0.16)'],
    [0.55, 'rgba(85,154,222,0.04)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const sprite = (tex: THREE.Texture, color: THREE.Color, depth: boolean) => {
    const m = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        color,
        transparent: true,
        depthWrite: false,
        depthTest: depth,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const SUN_D = 250;
  const sun = sprite(sunCoreTex, new THREE.Color(2.2, 2.1, 1.95), true);
  sun.scale.setScalar(14);
  const glare = sprite(glareTex, new THREE.Color(1, 1, 1), false);
  glare.scale.setScalar(70);
  const streak = sprite(glareTex, RIM, false);
  streak.scale.set(240, 3.2, 1);
  const ringTexG = glowTexture([
    [0, 'rgba(0,0,0,0)'],
    [0.7, 'rgba(0,0,0,0)'],
    [0.86, 'rgba(150,196,245,0.5)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const discTex = glowTexture([
    [0, 'rgba(150,196,245,0.5)'],
    [0.6, 'rgba(85,154,222,0.2)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  // Ghosts sit along the line from the sun through the centre of the frame.
  const GHOSTS: Array<[number, number, THREE.Texture, number]> = [
    [0.35, 0.5, discTex, 0.1],
    [0.62, 0.22, ringTexG, 0.16],
    [1.18, 0.8, ringTexG, 0.08],
    [1.45, 0.3, discTex, 0.12],
    [1.9, 1.3, ringTexG, 0.05],
  ];
  const ghosts =
    tier === 'software'
      ? []
      : GHOSTS.map(([f, sc, tex, op]) => ({ f, sc, op, s: sprite(tex, RIM, false) }));
  let sunVis = 0,
    sunFlash = 0;

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
    const g = new THREE.TubeGeometry(curve, BEAM_SEG * 2, 0.055, 8, false);
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
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.38, 0.3);
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

  let sizedW = 0,
    sizedH = 0;
  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth,
      h = canvas.clientHeight || window.innerHeight;
    sizedW = w;
    sizedH = h;
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
    tmp2 = new THREE.Vector3();

  const bornAt = performance.now();
  // How long the opening may wait for the Earth's maps (the 4K set takes longer on a first visit).
  const HOLD_MS = RES === 4096 ? 9000 : 5000;
  const frame = (now: number) => {
    skyDebug.frames++;
    // The canvas can change size without a resize event (on a phone the address bar hides as you
    // scroll): match it every frame, or the picture stretches and the Earth turns oval.
    if (
      (canvas.clientWidth && canvas.clientWidth !== sizedW) ||
      (canvas.clientHeight && canvas.clientHeight !== sizedH)
    )
      resize();
    const real = Math.min(0.1, (now - last) / 1000);
    last = now;
    const dt = Math.min(0.033, real);
    t += dt;

    // ---- The opening. ----
    let netOn = 1;
    if (introOn) {
      if (!introClock) introClock = now;
      // The opening is the load page: it holds in the warp until the Earth's maps are in (5 s at
      // most), so the limb never ignites over a planet that isn't there yet.
      if (!earthReady && now - bornAt < HOLD_MS && (now - introClock) / 1000 > 1.25)
        introClock = now - 1250;
      const it = (now - introClock) / 1000;
      // Out of a warp (0–1.6 s), the limb ignites from the centre (1.4–2.8 s), the sun crests
      // (2.2–3.2 s), the stations light (2.8–4.0 s), the first requests fly (from 3.4 s).
      warp = Math.max(0, 3 * (1 - smooth(Math.min(1, it / 1.6))));
      starMat.uniforms.uFade!.value = Math.min(1, it / 0.6);
      dotMat.opacity = Math.min(DOTS, it / 1.2);
      // The sky comes up on real time, so a wait for the Earth's maps shows the galaxy, not black.
      const up = (now - bornAt) / 1000;
      mwMat.uniforms.uFade!.value = smooth(Math.min(1, Math.max(0, (up - 0.4) / 1.4)));
      skyStarMat.uniforms.uFade!.value = smooth(Math.min(1, Math.max(0, (up - 0.2) / 1.0)));
      pu.uReveal.value = 3.2 * smooth(Math.min(1, Math.max(0, (it - 1.4) / 1.4)));
      pu.uSun.value = smooth(Math.min(1, Math.max(0, (it - 2.2) / 1.0)));
      pu.uLights.value = smooth(Math.min(1, Math.max(0, (it - 1.8) / 1.6)));
      sunFlash = Math.max(0, 1 - Math.abs(it - 2.6) * 1.5);
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
    dotMat.opacity = introOn ? dotMat.opacity : Math.max(0.12, DOTS - w * 0.1);

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
    planet.rotation.y += dt * 0.005;
    clouds.rotation.y += dt * 0.0068;
    if (bloom) bloom.strength = 0.55 + Math.max(0, 0.6 - flareAge) * 1.5 + warpOut * 1.5;
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

    placeOrbiters(dt);
    // The planet fades in as its maps arrive (never a black disc).
    if (earthReady) pu.uReady.value = Math.min(1, (now - readyAt) / 600);
    // ---- The sky at infinity, and the sun: they move with the camera, never closer. ----
    celestial.position.copy(camera.position);
    pu.uCloudU.value = (clouds.rotation.y - planet.rotation.y) / (Math.PI * 2);
    // Is the sun behind the planet? Compare its direction with the planet's disc as seen from here.
    tmp.subVectors(center, camera.position);
    const dist = tmp.length();
    const sep = Math.acos(Math.min(1, Math.max(-1, tmp.dot(sunDir) / dist)));
    const disc = Math.asin(Math.min(1, (R_PLANET * 1.012) / dist));
    sunVis = smooth(Math.min(1, Math.max(0, (sep - disc + 0.004) / 0.02)));
    const sunK = pu.uSun.value;
    tmp.copy(camera.position).addScaledVector(sunDir, SUN_D);
    sun.position.copy(tmp);
    glare.position.copy(tmp);
    streak.position.copy(tmp);
    (sun.material as THREE.SpriteMaterial).opacity = sunK + sunFlash * 0.6;
    sun.scale.setScalar(14 + sunFlash * 22);
    // Just after the sun slips behind the limb, a little glare still spills round it.
    const near = Math.max(
      sunVis,
      0.35 * smooth(Math.min(1, Math.max(0, (sep - disc + 0.05) / 0.05))),
    );
    (glare.material as THREE.SpriteMaterial).opacity = (0.4 * near + sunFlash * 0.5) * sunK;
    (streak.material as THREE.SpriteMaterial).opacity = (0.45 * near + sunFlash * 0.4) * sunK;
    tmp2.copy(tmp).project(camera);
    const onScreen = tmp2.z < 1 && Math.abs(tmp2.x) < 1.4 && Math.abs(tmp2.y) < 1.4;
    ghosts.forEach((gh) => {
      const m = gh.s.material as THREE.SpriteMaterial;
      if (!onScreen) {
        m.opacity = 0;
        return;
      }
      const k = 1 - 2 * gh.f;
      tmp
        .set(tmp2.x * k, tmp2.y * k, 0.5)
        .unproject(camera)
        .sub(camera.position)
        .normalize();
      gh.s.position.copy(camera.position).addScaledVector(tmp, 10);
      gh.s.scale.setScalar(gh.sc);
      m.opacity = gh.op * sunVis * sunK * (1 - Math.min(1, Math.hypot(tmp2.x, tmp2.y) * 0.35));
    });

    render();
  };
  // One bad frame (an error on some device) must never stop the loop: the error is recorded for
  // ?debug=1 and the next frame still runs, so the sky can't freeze black.
  let frameErrors = 0;
  const step = (now: number) => {
    try {
      frame(now);
    } catch (e) {
      if (frameErrors++ < 3) noteError('frame', e);
      try {
        render();
      } catch {
        // Nothing more to do for this frame.
      }
    }
    if (!still) raf = requestAnimationFrame(step);
  };
  function render() {
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  // A still frame draws once more when the maps have arrived.
  manager.onLoad = () => {
    if (still && !disposed) {
      // A still frame has no fade: show the planet at once.
      pu.uReady.value = 1;
      render();
    }
  };
  function failOne() {
    const healthy = stations.map((s, i) => [s, i] as const).filter(([s]) => s.resting <= 0);
    const pick = healthy[Math.floor(rand() * healthy.length)];
    if (pick) pick[0].resting = 4 + rand() * 3;
  }

  placeOrbiters(0);
  if (still) {
    // A finished, still frame: the limb lit, stations on, no motion.
    for (let k = 0; k < 90; k++) step(performance.now() + k * 16);
  } else raf = requestAnimationFrame(step);

  // Warping out (Try now) and back (a page restored from the back/forward cache), from wherever
  // the warp is now; a newer ramp replaces an older one.
  let warpRun = 0;
  function rampWarp(to: number, ms: number) {
    const run = ++warpRun,
      from = warpOut,
      t0 = performance.now();
    const tick = () => {
      if (run !== warpRun) return;
      const k = Math.min(1, (performance.now() - t0) / ms);
      warpOut = from + (to - from) * smooth(k);
      if (k < 1) requestAnimationFrame(tick);
    };
    tick();
  }

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
      rampWarp(1, 700);
    },
    unwarp() {
      rampWarp(0, 900);
    },
    skipIntro() {
      if (introOn) introClock = performance.now() - 4300;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      disposed = true;
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      [
        dotTex,
        sunCoreTex,
        glareTex,
        ringTexG,
        discTex,
        nodeTex,
        tDay,
        tNight,
        brcStandIn,
        brcLoaded,
        tMW,
        ringTex,
      ].forEach((x) => x.dispose());
      station.dispose();
      train.dispose();
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
