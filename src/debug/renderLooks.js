/**
 * Frozen render looks. One id in, one picture out.
 * The documents stay private. Callers see { id, label } and pass an id.
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SakuraMaterialFactory } from '../petals/SakuraMaterialFactory.js';

const RENDER_LOOKS = Object.freeze({
  photoreal: Object.freeze({
    id: 'photoreal',
    label: 'Photorealistic',
    grade: false,
    scales: Object.freeze({ exposure: 1, sun: 1, hemi: 1, haze: 1 }),
    fillWarmth: 0,
    fill: '#ffffff',
    iblIntensity: 0.55,
    bloom: Object.freeze({ strength: 0.22, radius: 0.55, threshold: 0.88 }),
    rayScale: 1,
    blossom: Object.freeze({
      transmission: 0.85,
      thickness: 0.018,
      aoStrength: 0.55,
      roughness: 0.6,
      brightBoost: 0.1
    })
  }),
  ghibli: Object.freeze({
    id: 'ghibli',
    label: 'Anime-Ghibli',
    grade: Object.freeze({
      saturation: 0.82,
      warmth: 0.16,
      contrast: 1.08,
      vignette: 0.28,
      edge: 0.45
    }),
    scales: Object.freeze({ exposure: 1.06, sun: 0.92, hemi: 1.15, haze: 0.85 }),
    fillWarmth: 0.35,
    fill: '#ffb07a',
    iblIntensity: 0.28,
    bloom: Object.freeze({ strength: 0.32, radius: 0.62, threshold: 0.78 }),
    rayScale: 0.25,
    blossom: Object.freeze({
      transmission: 0.45,
      thickness: 0.03,
      aoStrength: 0.28,
      roughness: 0.85,
      brightBoost: 0.22
    })
  })
});

const GRADE_SHADER = {
  name: 'LookGrade',
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 1 },
    uWarmth: { value: 0 },
    uContrast: { value: 1 },
    uVignette: { value: 0 },
    uEdge: { value: 0 },
    uFill: { value: new THREE.Color('#ffffff') },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uWarmth;
    uniform float uContrast;
    uniform float uVignette;
    uniform float uEdge;
    uniform vec3 uFill;
    uniform vec2 uTexel;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    const float MID_GREY = 0.18;

    float lumaAt(vec2 uv) {
      return dot(texture2D(tDiffuse, uv).rgb, LUMA);
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 c = base.rgb;
      float luma = dot(c, LUMA);
      c = mix(vec3(luma), c, uSaturation);
      float fillLuma = max(dot(uFill, LUMA), 1e-4);
      c = mix(c, uFill * (luma / fillLuma), clamp(uWarmth, 0.0, 1.0));
      c = (c - MID_GREY) * uContrast + MID_GREY;
      float vig = smoothstep(0.35, 0.92, length(vUv - 0.5) * 1.7);
      c *= 1.0 - uVignette * vig;
      if (uEdge > 0.001) {
        float l0 = lumaAt(vUv + vec2(-uTexel.x, -uTexel.y));
        float l1 = lumaAt(vUv + vec2(0.0, -uTexel.y));
        float l2 = lumaAt(vUv + vec2(uTexel.x, -uTexel.y));
        float l3 = lumaAt(vUv + vec2(-uTexel.x, 0.0));
        float l4 = lumaAt(vUv + vec2(uTexel.x, 0.0));
        float l5 = lumaAt(vUv + vec2(-uTexel.x, uTexel.y));
        float l6 = lumaAt(vUv + vec2(0.0, uTexel.y));
        float l7 = lumaAt(vUv + vec2(uTexel.x, uTexel.y));
        float gx = -l0 - 2.0 * l3 - l5 + l2 + 2.0 * l4 + l7;
        float gy = -l0 - 2.0 * l1 - l2 + l5 + 2.0 * l6 + l7;
        float edge = smoothstep(0.08, 0.45, length(vec2(gx, gy)));
        c *= 1.0 - uEdge * edge;
      }
      gl_FragColor = vec4(max(c, 0.0), base.a);
    }
  `
};

let activeId = 'photoreal';
let gradePass = null;
let setLookBases = null;
let getAtmosphere = null;
let getCanopies = null;
const blossomUser = { ao: 1, bright: 1, rough: 1 };

export function lookCatalog() {
  return Object.keys(RENDER_LOOKS).map((key) => {
    const look = RENDER_LOOKS[key];
    return { id: look.id, label: look.label };
  });
}

export function parseRenderLookId(raw) {
  if (typeof raw === 'string' && Object.hasOwn(RENDER_LOOKS, raw) && RENDER_LOOKS[raw].id === raw) {
    return raw;
  }
  return null;
}

function writeBlossom(look, user, canopy) {
  const material = canopy?.material;
  if (!material) return;
  const blossom = look.blossom;
  SakuraMaterialFactory.setTransmission(material, blossom.transmission, blossom.thickness);
  const uniforms = material.uniforms ?? material.userData?.uniforms;
  if (!uniforms) return;
  if (uniforms.uAOStrength) uniforms.uAOStrength.value = blossom.aoStrength * user.ao;
  if (uniforms.uBrightBoost) uniforms.uBrightBoost.value = blossom.brightBoost * user.bright;
  const roughness = THREE.MathUtils.clamp(blossom.roughness * user.rough, 0.05, 1);
  material.roughness = roughness;
  if (uniforms.uRoughness) uniforms.uRoughness.value = roughness;
}

function restampCanopy(canopy) {
  if (!getCanopies) return;
  writeBlossom(RENDER_LOOKS[activeId], blossomUser, canopy);
}

/**
 * Installs the grade pass. Does not apply a look.
 * @param {{
 *   postFX: { installGrade: Function, setLookBases: Function },
 *   getAtmosphere: Function,
 *   getCanopies: Function
 * }} targets
 */
export function bindRenderLooks({ postFX, getAtmosphere: atmosGet, getCanopies: canopyGet } = {}) {
  if (gradePass) throw new Error('bindRenderLooks called twice');
  if (typeof atmosGet !== 'function' || typeof canopyGet !== 'function') {
    throw new Error('bindRenderLooks requires getAtmosphere and getCanopies');
  }
  if (typeof postFX?.installGrade !== 'function' || typeof postFX?.setLookBases !== 'function') {
    throw new Error('bindRenderLooks requires a postFX grade slot');
  }
  const pass = new ShaderPass(GRADE_SHADER);
  pass.enabled = false;
  postFX.installGrade(pass);
  gradePass = pass;
  setLookBases = postFX.setLookBases;
  getAtmosphere = atmosGet;
  getCanopies = canopyGet;
  return { restampCanopy };
}

/**
 * Unknown ids throw and leave the previous look in place.
 * @param {string} id
 * @returns {{ id: string, label: string }}
 */
export function applyRenderLook(id) {
  if (!gradePass || !getAtmosphere || !setLookBases) {
    throw new Error('applyRenderLook before bindRenderLooks');
  }
  if (typeof id !== 'string' || !Object.hasOwn(RENDER_LOOKS, id) || RENDER_LOOKS[id].id !== id) {
    throw new Error(`Unknown render look: ${String(id)}`);
  }
  const look = RENDER_LOOKS[id];
  activeId = id;
  if (look.grade === false) {
    // Off, not an identity blit. SMAA keeps reading the godray buffer.
    gradePass.enabled = false;
  } else {
    const uniforms = gradePass.uniforms;
    uniforms.uSaturation.value = look.grade.saturation;
    uniforms.uWarmth.value = look.grade.warmth;
    uniforms.uContrast.value = look.grade.contrast;
    uniforms.uVignette.value = look.grade.vignette;
    uniforms.uEdge.value = look.grade.edge;
    uniforms.uFill.value.set(look.fill);
    gradePass.enabled = true;
  }
  setLookBases(look.bloom, look.rayScale);
  const atmosphere = getAtmosphere();
  atmosphere.look.exposure = look.scales.exposure;
  atmosphere.look.sun = look.scales.sun;
  atmosphere.look.hemi = look.scales.hemi;
  atmosphere.look.haze = look.scales.haze;
  atmosphere.look.fillWarmth = look.fillWarmth;
  atmosphere.look.fill.set(look.fill);
  atmosphere.recompute();
  atmosphere.pmrem?.setIntensity(look.iblIntensity);
  for (const canopy of getCanopies()) writeBlossom(look, blossomUser, canopy);
  return { id: look.id, label: look.label };
}

/** AO, bright, and roughness multipliers on the active document. Transmission stays at ×1. */
export function setBlossomUserScale(partial = {}) {
  for (const key of ['ao', 'bright', 'rough']) {
    const value = partial[key];
    if (typeof value === 'number' && Number.isFinite(value)) blossomUser[key] = value;
  }
  if (!getCanopies) return;
  const look = RENDER_LOOKS[activeId];
  for (const canopy of getCanopies()) writeBlossom(look, blossomUser, canopy);
}
