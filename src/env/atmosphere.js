import * as THREE from 'three';
import { GLSL_NOISE } from './glslCommon.js';
import { ATMOS_U } from './sceneUniforms.js';
import { createPmremSky } from './pmremSky.js';

/**
 * Sky dome + time-of-day controller.
 *
 * One scalar (clock hour 0–24) drives everything: sun / moon position, key-light colour + intensity,
 * hemisphere fill, sky gradient, haze colour/density, clouds, stars and exposure. Colours are keyed by *solar
 * elevation* (not by hour) so sunrise and sunset share one physically-plausible palette, with a warm/pink twist.
 */

/** Keyframes by sun elevation (sin of altitude). */
const STOPS = [
  { e: -0.4, zen: 0x03061a, hor: 0x0a1226, glow: 0x0e1832, sun: 0x000000, hs: 0x34498c, hg: 0x10162c, cl: 0x242e50, cs: 0x0c1124, sunI: 0, hemiI: 0.75, expo: 1.95, stars: 1, haze: 1.0 },
  { e: -0.16, zen: 0x07102c, hor: 0x1c2750, glow: 0x2c3668, sun: 0x000000, hs: 0x3c5090, hg: 0x141a30, cl: 0x323c68, cs: 0x10173a, sunI: 0, hemiI: 0.72, expo: 1.7, stars: 0.9, haze: 1.1 },
  { e: -0.07, zen: 0x102252, hor: 0x4a5a8c, glow: 0xc86a62, sun: 0x000000, hs: 0x4a5a98, hg: 0x262a40, cl: 0x7a6a90, cs: 0x252c50, sunI: 0, hemiI: 0.66, expo: 1.4, stars: 0.3, haze: 1.3 },
  { e: 0.0, zen: 0x274684, hor: 0xeea47c, glow: 0xff8838, sun: 0xff8c3c, hs: 0xb4a4c0, hg: 0x5a4640, cl: 0xffb88a, cs: 0x6a5878, sunI: 0.7, hemiI: 0.88, expo: 1.18, stars: 0, haze: 1.5 },
  { e: 0.09, zen: 0x3a68ae, hor: 0xf2c8a6, glow: 0xffb468, sun: 0xffbf78, hs: 0xc4c4dc, hg: 0x625044, cl: 0xffd9b0, cs: 0x8890b0, sunI: 1.1, hemiI: 0.9, expo: 1.08, stars: 0, haze: 1.25 },
  { e: 0.3, zen: 0x3278cc, hor: 0xc0d9f0, glow: 0xffe0b0, sun: 0xffe6c8, hs: 0xd0e0f6, hg: 0x4e4238, cl: 0xffffff, cs: 0x9db0cc, sunI: 1.28, hemiI: 0.8, expo: 1.0, stars: 0, haze: 1.05 },
  { e: 0.95, zen: 0x2064c6, hor: 0xa8d0f2, glow: 0xfff0d6, sun: 0xfff4ea, hs: 0xf4ecf6, hg: 0x4a3830, cl: 0xffffff, cs: 0xa6b6d4, sunI: 1.35, hemiI: 0.72, expo: 1.0, stars: 0, haze: 1.0 }
];

const COLOR_KEYS = ['zen', 'hor', 'glow', 'sun', 'hs', 'hg', 'cl', 'cs'];
const NUM_KEYS = ['sunI', 'hemiI', 'expo', 'stars', 'haze'];
const STOP_COLORS = STOPS.map((s) => Object.fromEntries(COLOR_KEYS.map((k) => [k, new THREE.Color(s[k])])));

/** Dawn tints: pinker, cooler at sunrise; deeper orange at sunset. */
const DAWN_HOR = new THREE.Color(0xf4a8b4);
const DAWN_GLOW = new THREE.Color(0xff9a88);
const DUSK_HOR = new THREE.Color(0xf08a50);
const DUSK_GLOW = new THREE.Color(0xff6a26);

export const TIME_PRESETS = Object.freeze({
  sunrise: 6.6,
  day: 13.0,
  sunset: 17.4,
  night: 20.0
});

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Force the dome onto the far plane. With reversed-Z, far is NDC z = 0
  // (the classic xyww trick is near and would paint over the whole scene).
  #ifdef USE_REVERSED_DEPTH_BUFFER
    gl_Position = vec4(p.xy, 0.0, p.w);
  #else
    gl_Position = p.xyww;
  #endif
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunVis;
uniform float uMoonVis;
uniform float uStars;
uniform float uCloudCover;
uniform float uCloudTime;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uTime;
varying vec3 vDir;
${GLSL_NOISE}

float starLayer(vec3 d, float scale, float density, float twinkleSeed) {
  vec3 p = d * scale;
  vec3 ip = floor(p);
  vec3 fp = fract(p) - 0.5;
  float r = sk_hash13(ip);
  if (r < density) return 0.0;
  vec3 off = vec3(sk_hash13(ip + 3.1), sk_hash13(ip + 7.7), sk_hash13(ip + 11.3)) - 0.5;
  float dd = length(fp - off * 0.7);
  float mag = (r - density) / (1.0 - density);
  float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * mag) + r * 60.0 + twinkleSeed);
  return smoothstep(0.1 * (0.4 + mag), 0.0, dd) * (0.35 + 1.6 * mag * mag) * tw;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float hp = max(h, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(hp, 0.45));
  // sun scattering: broad aureole + tight halo, strongest near the horizon
  float mu = dot(d, uSunDir);
  float low = pow(1.0 - hp, 2.5);
  col += uGlow * (pow(max(mu, 0.0), 4.0) * 0.5 + pow(max(mu, 0.0), 28.0) * 0.9) * (0.3 + 0.7 * low);
  // anti-solar twilight band (belt of Venus)
  float anti = pow(max(-mu, 0.0), 2.0) * low * smoothstep(0.35, 0.0, uSunDir.y) * smoothstep(-0.2, 0.0, uSunDir.y);
  col = mix(col, uHorizon * vec3(1.05, 0.85, 1.05), anti * 0.45);
  // below the horizon: continue as haze so the far terrain edge disappears
  col = mix(col, uHorizon, smoothstep(0.02, -0.06, h));

  // stars + faint milky way
  if (uStars > 0.01 && h > -0.02) {
    float s = starLayer(d, 90.0, 0.965, 0.0) + 0.7 * starLayer(d, 200.0, 0.93, 4.0) + 0.5 * starLayer(d, 420.0, 0.9, 9.0);
    vec3 mwN = normalize(vec3(0.35, 0.78, 0.52));
    float band = exp(-pow(dot(d, mwN) * 3.4, 2.0));
    float mw = band * (0.25 + 0.75 * sk_fbm2(d.xz * 5.0 + d.y * 3.0)) * 0.1;
    vec3 sc = vec3(0.85, 0.9, 1.0) * s + vec3(0.5, 0.6, 0.9) * mw;
    col += sc * uStars * smoothstep(0.0, 0.12, h);
  }

  // sun disc with limb darkening + bright core (better bloom / god-ray source)
  float crOuter = cos(0.012);
  float crInner = cos(0.0065);
  float disc = smoothstep(crOuter, crInner, mu);
  float limb = pow(clamp((mu - crOuter) / max(crInner - crOuter, 1e-4), 0.0, 1.0), 0.55);
  float core = pow(max(mu, 0.0), 1200.0);
  col += uSunCol * (disc * (0.55 + 0.45 * limb) * 22.0 + core * 18.0) * uSunVis * smoothstep(-0.01, 0.02, h);

  // moon: disc with maria + halo
  float mm = dot(d, uMoonDir);
  if (uMoonVis > 0.01 && mm > 0.9) {
    vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
    vec3 mu2 = cross(uMoonDir, mr);
    vec2 mp = vec2(dot(d, mr), dot(d, mu2)) / 0.0125;
    float md = length(mp);
    float moonDisc = smoothstep(1.0, 0.92, md);
    float maria = sk_fbm2(mp * 2.2 + 4.0);
    float craters = sk_noise2(mp * 11.0);
    vec3 mc = mix(vec3(0.62, 0.64, 0.7), vec3(0.95, 0.96, 1.0), smoothstep(0.35, 0.65, maria));
    mc *= 0.88 + 0.12 * craters;
    float shade = sqrt(max(0.0, 1.0 - md * md)) * 0.35 + 0.65;
    col += mc * moonDisc * 2.4 * shade * uMoonVis;
    col += vec3(0.5, 0.6, 0.9) * (pow(max(mm, 0.0), 220.0) * 0.45 + pow(max(mm, 0.0), 36.0) * 0.08) * uMoonVis;
  }

  // clouds: two drifting layers projected on planes, lit from the sun side
  if (h > 0.0) {
    vec2 cp = d.xz / (h + 0.07) * 0.5 + vec2(uCloudTime, uCloudTime * 0.4);
    float c1 = sk_fbm2(cp * 1.15);
    float thr = mix(0.80, 0.32, uCloudCover);
    float cov = smoothstep(thr, thr + 0.2, c1);
    vec2 toSun = uSunDir.xz * 0.05 / max(length(uSunDir.xz), 0.2);
    float c2 = sk_fbm2(cp * 1.15 + toSun * (1.0 + 2.0 * (1.0 - uSunDir.y)));
    float lit = clamp(0.5 + (c1 - c2) * 3.2, 0.0, 1.0);
    vec3 cc = mix(uCloudShade, uCloudLit, lit);
    float rim = pow(1.0 - cov, 3.0) * smoothstep(0.02, 0.3, cov) * pow(max(mu, 0.0), 3.0);
    cc += uCloudLit * rim * 0.6;
    float fadeH = smoothstep(0.0, 0.16, h);
    col = mix(col, cc, cov * fadeH * 0.92);

    vec2 cq = vec2(d.x, d.z) / (h + 0.28) * vec2(0.45, 1.5) + vec2(uCloudTime * 0.6, 0.0);
    float c3 = sk_fbm2(cq * 1.7 + 11.0);
    float cirr = smoothstep(mix(0.72, 0.5, uCloudCover), 0.86, c3) * 0.38 * smoothstep(0.05, 0.4, h);
    col = mix(col, mix(uCloudShade, uCloudLit, 0.8), cirr);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function lerpStops(e, out) {
  let i = 0;
  while (i < STOPS.length - 2 && e >= STOPS[i + 1].e) i++;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const t = THREE.MathUtils.clamp((e - a.e) / (b.e - a.e), 0, 1);
  for (const k of COLOR_KEYS) out[k].copy(STOP_COLORS[i][k]).lerp(STOP_COLORS[i + 1][k], t);
  for (const k of NUM_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

export class Atmosphere {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ sun: THREE.DirectionalLight|object, hemi: THREE.HemisphereLight, csm?: object }} lights
   */
  constructor(scene, renderer, { sun, hemi, csm = null }) {
    this.scene = scene;
    this.renderer = renderer;
    this.sun = sun;
    this.hemi = hemi;
    this.csm = csm;
    this.pmrem = null;

    /** clock hour 0–24 */
    this.hours = TIME_PRESETS.day;
    this.autoCycle = false;
    /** real seconds for one full 24 h cycle when autoCycle is on */
    this.cycleSeconds = 120;
    /** extra exposure multiplier (UI) */
    this.exposureBias = 1;
    this.cloudCover = 0.42;
    this.cloudSpeed = 1;
    this.hazeScale = 1;
    this.starScale = 1;
    /** rotate the whole sun/moon path around the vertical axis (degrees) */
    this.azimuthDeg = -33;
    this.moonLightScale = 1;
    this.sunLightScale = 1;
    this.hemiScale = 1;
    // Look bases. User sliders stay on the fields above. #compute is the only bus writer.
    this.look = {
      exposure: 1,
      sun: 1,
      hemi: 1,
      haze: 1,
      fillWarmth: 0,
      fill: new THREE.Color(0xffffff)
    };

    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.state = {
      zen: new THREE.Color(),
      hor: new THREE.Color(),
      glow: new THREE.Color(),
      sun: new THREE.Color(),
      hs: new THREE.Color(),
      hg: new THREE.Color(),
      cl: new THREE.Color(),
      cs: new THREE.Color(),
      sunI: 0,
      hemiI: 0,
      expo: 1,
      stars: 0,
      haze: 1
    };
    /** what the key light is currently showing: 'sun' | 'moon' */
    this.keyLight = 'sun';
    this._cloudT = 0;
    this._treeH = 9;
    this._treeR = 4;
    this._tmp = new THREE.Color();

    const u = {
      uZenith: { value: new THREE.Color() },
      uHorizon: ATMOS_U.uHazeColor,
      uGlow: { value: new THREE.Color() },
      uSunCol: { value: new THREE.Color() },
      uSunDir: ATMOS_U.uSunDir,
      uMoonDir: ATMOS_U.uMoonDir,
      uSunVis: { value: 1 },
      uMoonVis: { value: 0 },
      uStars: { value: 0 },
      uCloudCover: { value: this.cloudCover },
      uCloudTime: { value: 0 },
      uCloudLit: { value: new THREE.Color() },
      uCloudShade: { value: new THREE.Color() },
      uTime: ATMOS_U.uTime
    };
    this.skyUniforms = u;
    const reversed = Boolean(renderer?.capabilities?.reversedDepthBuffer);
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      // ShaderMaterial does not get renderer defines automatically — pin far-plane depth for reversed-Z
      defines: reversed ? { USE_REVERSED_DEPTH_BUFFER: '' } : {}
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), this.skyMaterial);
    this.sky.name = 'sky';
    this.sky.frustumCulled = false;
    // draw last among opaques: only the pixels no terrain/tree has covered pay for the sky shader
    this.sky.renderOrder = 1000;
    scene.add(this.sky);

    scene.background = new THREE.Color(0x9fc4ea);
    if (sun.target && !csm) scene.add(sun.target);

    this.pmrem = createPmremSky({ renderer, scene, skyMesh: this.sky });
    this.setTime(this.hours);
  }

  /** Tell the shadow frustum / light target about the tree footprint. */
  setTreeBounds(heightM, crownRadiusM) {
    this._treeH = heightM;
    this._treeR = crownRadiusM;
    if (this.csm) {
      this.csm.setTreeBounds(heightM, crownRadiusM);
      return;
    }
    const ext = Math.max(7, crownRadiusM * 1.35 + 2, heightM * 0.62);
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = Math.max(90, ext * 6 + heightM * 2);
    cam.updateProjectionMatrix();
    this.sun.target.position.set(0, heightM * 0.38, 0);
    this.#placeLight();
  }

  /** @param {'sunrise'|'day'|'sunset'|'night'} name */
  setPreset(name) {
    if (TIME_PRESETS[name] != null) this.setTime(TIME_PRESETS[name]);
  }

  /** @param {number} hours 0–24 (wraps) */
  setTime(hours) {
    this.hours = ((hours % 24) + 24) % 24;
    this.#compute();
  }

  get clockLabel() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Name of the nearest named period, for the UI. */
  get periodLabel() {
    const e = this.sunDir.y;
    const morning = this.hours < 12;
    if (e < -0.12) return 'night';
    if (e < 0.16) return morning ? 'sunrise' : 'sunset';
    return 'day';
  }

  #sunDirection(h) {
    const ang = ((h - 6) / 12) * Math.PI;
    const y = Math.sin(ang) * 0.9;
    const c = Math.cos(ang);
    // path hugs the −z side near the horizon (so dawn/dusk glow is in the hero view) and swings toward +z at noon
    let hx = c * 0.6; // the arc is centred on the hero view (see the azimuthDeg default)
    let hz = 0.15 - c * c * 1.0;
    const rot = THREE.MathUtils.degToRad(this.azimuthDeg);
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const rx = hx * cr - hz * sr;
    const rz = hx * sr + hz * cr;
    hx = rx;
    hz = rz;
    const hl = Math.hypot(hx, hz) || 1;
    const k = Math.sqrt(Math.max(0, 1 - y * y)) / hl;
    return this.sunDir.set(hx * k, y, hz * k).normalize();
  }

  #placeLight() {
    const dir = this.keyLight === 'sun' ? this.sunDir : this.moonDir;
    if (this.csm) {
      this.csm.setLightDirectionFromSunDir(dir);
      return;
    }
    const d = Math.max(60, this._treeH * 4);
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, d);
    this.sun.target.updateMatrixWorld();
  }

  #compute() {
    const dir = this.#sunDirection(this.hours);
    this.moonDir.copy(dir).negate();
    const e = dir.y;
    const S = lerpStops(e, this.state);

    // dawn/dusk tints
    const w = 1 - THREE.MathUtils.smoothstep(Math.abs(e), 0.02, 0.28);
    const morning = this.hours < 12;
    S.hor.lerp(morning ? DAWN_HOR : DUSK_HOR, w * 0.42);
    S.glow.lerp(morning ? DAWN_GLOW : DUSK_GLOW, w * 0.55);
    S.cl.lerp(morning ? DAWN_GLOW : DUSK_GLOW, w * 0.3);

    // ── key light: sun above the horizon, moon below ──
    const sunFade = THREE.MathUtils.smoothstep(e, -0.03, 0.05);
    const moonFade = 1 - THREE.MathUtils.smoothstep(e, -0.2, -0.03);
    let keyI;
    if (e > -0.03) {
      this.keyLight = 'sun';
      this.sun.color.copy(S.sun);
      keyI = S.sunI * sunFade * this.sunLightScale * this.look.sun;
    } else {
      this.keyLight = 'moon';
      this.sun.color.set(0xa6c0ff);
      // Daylight look scale does not dim the moon.
      keyI = 1.5 * moonFade * this.moonLightScale;
    }
    this.sun.intensity = keyI;
    this.#placeLight();

    this.hemi.color.copy(S.hs);
    this.hemi.groundColor.copy(S.hg);
    this.hemi.intensity = S.hemiI * this.hemiScale * this.look.hemi;
    const warmth = this.look.fillWarmth;
    if (warmth > 0) {
      this.hemi.color.lerp(this.look.fill, warmth);
      this.hemi.groundColor.lerp(this.look.fill, warmth);
    }

    this.renderer.toneMappingExposure = S.expo * this.exposureBias * this.look.exposure;

    // ── shared uniforms for shaders that do their own lighting (blossoms, moss, haze) ──
    ATMOS_U.uSunDir.value.copy(dir);
    ATMOS_U.uMoonDir.value.copy(this.moonDir);
    ATMOS_U.uKeyDir.value.copy(this.keyLight === 'sun' ? dir : this.moonDir);
    ATMOS_U.uSunLight.value.copy(this.sun.color).multiplyScalar(keyI / 1.35);
    ATMOS_U.uSkyLight.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity / 0.72);
    ATMOS_U.uGroundLight.value.copy(this.hemi.groundColor).multiplyScalar(this.hemi.intensity / 0.72);
    ATMOS_U.uNight.value = THREE.MathUtils.smoothstep(-e, 0.0, 0.16);

    const haze = this.hazeScale * S.haze * this.look.haze;
    ATMOS_U.uHazeDensity.value = 0.00028 * haze;
    ATMOS_U.uHazeColor.value.copy(S.hor);
    if (warmth > 0) ATMOS_U.uHazeColor.value.lerp(this.look.fill, warmth * 0.5);
    ATMOS_U.uHazeSunColor.value.copy(S.glow).lerp(S.hor, 0.35);
    if (this.scene.background?.isColor) this.scene.background.copy(S.hor);

    const u = this.skyUniforms;
    u.uZenith.value.copy(S.zen);
    u.uGlow.value.copy(S.glow);
    u.uSunCol.value.copy(S.sun).lerp(this._tmp.set(0xffffff), 0.3);
    u.uSunVis.value = THREE.MathUtils.smoothstep(e, -0.06, 0.0);
    u.uMoonVis.value = THREE.MathUtils.smoothstep(-e, 0.0, 0.1);
    u.uStars.value = S.stars * this.starScale * (1 - 0.8 * this.cloudCover);
    u.uCloudCover.value = this.cloudCover;
    u.uCloudLit.value.copy(S.cl);
    u.uCloudShade.value.copy(S.cs);
    this.#bakePmrem(false);
  }

  #bakePmrem(force) {
    this.pmrem?.bake({
      sunDirY: this.sunDir.y,
      cloudCover: this.cloudCover,
      hours: this.hours,
      force: Boolean(force)
    });
  }

  /** Per-frame: advance the clock (if cycling), drift the clouds, keep the sky centred on the camera. */
  update(dt, camera, t) {
    if (this.autoCycle) {
      this.hours = (this.hours + (dt * 24) / Math.max(5, this.cycleSeconds)) % 24;
      this.#compute();
    }
    this._cloudT += dt * 0.004 * this.cloudSpeed;
    this.skyUniforms.uCloudTime.value = this._cloudT;
    ATMOS_U.uTime.value = t;
    this.skyUniforms.uCloudCover.value = this.cloudCover;
    if (camera) this.sky.position.copy(camera.position);
    this.csm?.update?.();
  }

  /** Re-derive everything after changing a user knob (haze, clouds, exposure …). */
  refresh() {
    this.#compute();
    this.#bakePmrem(true);
  }

  /** Same bus write as a clock tick. Does not force a PMREM bake the way refresh() does. */
  recompute() {
    this.#compute();
  }

  dispose() {
    this.pmrem?.dispose?.();
    this.scene.remove(this.sky);
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
  }
}
