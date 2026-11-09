/**
 * Procedural cherry bark — MeshStandardMaterial with horizontal lenticels.
 * Mesh uv.y is skeleton arc length in metres; pitch from units.js.
 */

import * as THREE from 'three';
import { LENTICEL_PITCH_M } from '../units.js';

/**
 * @param {object} [opts]
 * @returns {THREE.MeshStandardMaterial}
 */
export function createBarkMaterial(opts = {}) {
  const {
    color = 0x3a2e30,
    roughness = 0.92,
    metalness = 0.02,
    lenticelPitchM = LENTICEL_PITCH_M
  } = opts;

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness
  });

  material.userData.lenticelPitchM = lenticelPitchM;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLenticelPitchM = { value: lenticelPitchM };
    shader.uniforms.uBarkTint = { value: new THREE.Color(0x2a2224) };
    shader.uniforms.uLenticelColor = { value: new THREE.Color(0xc4a882) };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vBarkUv;
`
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vBarkUv = uv;
`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uLenticelPitchM;
uniform vec3 uBarkTint;
uniform vec3 uLenticelColor;
varying vec2 vBarkUv;

float barkHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float proceduralBarkLenticels(vec2 uv) {
  // uv.x = θ/2π ; uv.y = arc length (metres)
  float pitch = max(uLenticelPitchM, 1e-4);
  vec2 st = vec2(uv.x * 8.0, uv.y / pitch);
  vec2 ipos = floor(st);
  vec2 fpos = fract(st);
  float n = barkHash21(ipos);
  float lenticel = 0.0;
  if (n > 0.62) {
    float xCenter = 0.5 + 0.3 * sin(n * 6.2831853);
    float dist = abs(fpos.x - xCenter) * 1.8 + abs(fpos.y - 0.5) * 6.0;
    lenticel = smoothstep(0.4, 0.0, dist) * n;
  }
  return lenticel;
}
`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float lent = proceduralBarkLenticels(vBarkUv);
  float furrow = 0.08 * abs(sin(vBarkUv.x * 6.2831853 * 7.0));
  vec3 bark = mix(diffuseColor.rgb, uBarkTint, 0.35 + furrow);
  diffuseColor.rgb = mix(bark, uLenticelColor, lent * 0.85);
}
`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
{
  float lentR = proceduralBarkLenticels(vBarkUv);
  roughnessFactor = clamp(roughnessFactor - lentR * 0.15, 0.05, 1.0);
}
`
      );

    material.userData.shader = shader;
  };

  material.customProgramCacheKey = () => `bark-lenticels-${lenticelPitchM}`;

  return material;
}
