import * as THREE from 'three';
import { WIND_AMBIENT_MPS, WIND_GUST_MPS } from '../units.js';

const _out = new THREE.Vector3();

/**
 * Shared world wind field W(x,y,z,t) in m·s⁻¹.
 * Dual-octave XZ gust so grass, moss, petals and branches stay coherent (§7.4).
 *
 * @param {number} x metres
 * @param {number} y metres
 * @param {number} z metres
 * @param {number} t seconds
 * @param {THREE.Vector3} [target]
 * @returns {THREE.Vector3} wind velocity (m·s⁻¹)
 */
export function sampleWind(x, y, z, t, target = _out) {
  // Ambient park breeze (mostly +X with a little +Z)
  const ax = WIND_AMBIENT_MPS;
  const az = WIND_AMBIENT_MPS * 0.17;

  // Macro gust (wavelength ~12–18 m, period ~4–6 s)
  const g1 =
    Math.sin(x * 0.085 + z * 0.055 + t * 1.15) *
    Math.sin(z * 0.07 - t * 0.65);
  // Micro flutter (wavelength ~1.5–3 m)
  const g2 =
    Math.sin(x * 0.55 + z * 0.42 + t * 3.4) *
    Math.cos(z * 0.48 - x * 0.22 + t * 2.1);

  // Mild height shear: freer flow above ~1 m
  const shear = 1.0 + Math.min(Math.max(y, 0) * 0.08, 0.35);

  const gustScale = (WIND_GUST_MPS - WIND_AMBIENT_MPS) * 0.55;
  const wx = (ax + gustScale * (0.72 * g1 + 0.28 * g2)) * shear;
  const wz = (az + gustScale * (0.55 * g1 * 0.85 + 0.35 * g2)) * shear;
  // Tiny vertical puff for tip flutter (kept small — blades bend in XZ)
  const wy = 0.04 * g2 * shear;

  return target.set(wx, wy, wz);
}

/** GLSL snippet mirroring sampleWind for vertex shaders (world-space metres, t in seconds). */
export const WIND_GLSL = /* glsl */ `
vec3 sampleWindGLSL(vec3 p, float t) {
  float ax = ${WIND_AMBIENT_MPS.toFixed(4)};
  float az = ${(WIND_AMBIENT_MPS * 0.17).toFixed(4)};
  float gustScale = ${((WIND_GUST_MPS - WIND_AMBIENT_MPS) * 0.55).toFixed(4)};
  float g1 = sin(p.x * 0.085 + p.z * 0.055 + t * 1.15) * sin(p.z * 0.07 - t * 0.65);
  float g2 = sin(p.x * 0.55 + p.z * 0.42 + t * 3.4) * cos(p.z * 0.48 - p.x * 0.22 + t * 2.1);
  float shear = 1.0 + clamp(p.y * 0.08, 0.0, 0.35);
  float wx = (ax + gustScale * (0.72 * g1 + 0.28 * g2)) * shear;
  float wz = (az + gustScale * (0.55 * g1 * 0.85 + 0.35 * g2)) * shear;
  float wy = 0.04 * g2 * shear;
  return vec3(wx, wy, wz);
}
`;
