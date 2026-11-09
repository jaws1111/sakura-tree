import * as THREE from 'three';
import {
  MOSS_STRAND_MIN_M,
  MOSS_STRAND_MAX_M,
  TRUNK_BASE_RADIUS_M,
  CROWN_RADIUS_M
} from '../units.js';
import { heightAt, normalAt } from './terrain.js';
import { WIND_GLSL } from './wind.js';

import { PLAYABLE } from '../budget.js';

const STRAND_SEGS = 3;
const GROUND_MOSS_COUNT = PLAYABLE.groundMossCount;
const BARK_MOSS_MAX = PLAYABLE.barkMossMax;

function hash2(a, b) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Short tapered moss strand; local y ∈ [0,1], scaled to millimetre lengths. */
function createStrandGeometry() {
  const w0 = 0.0012; // m base half-width ~1.2 mm
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= STRAND_SEGS; i++) {
    const t = i / STRAND_SEGS;
    const half = w0 * (1.0 - t * 0.85);
    positions.push(-half, t, 0, half, t, 0);
    normals.push(0, 0, 1, 0, 0, 1);
    uvs.push(0, t, 1, t);
    if (i < STRAND_SEGS) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

function createMossMaterial(baseColor = 0x3d5c38) {
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         ${WIND_GLSL}
        `
      )
      .replace(
        '#include <project_vertex>',
        `float tip = clamp(position.y, 0.0, 1.0);
         tip *= tip;
         #ifdef USE_INSTANCING
           vec4 worldH = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
         #else
           vec4 worldH = modelMatrix * vec4(transformed, 1.0);
         #endif
         vec3 wind = sampleWindGLSL(worldH.xyz, uTime);
         transformed.x += wind.x * tip * 0.008;
         transformed.z += wind.z * tip * 0.008;
         #include <project_vertex>
        `
      );
  };
  mat.customProgramCacheKey = () => 'sakura-moss-wind-v1';
  return mat;
}

/**
 * Ground moss: short instances in shade pools + a dense ring near the bole.
 * Also builds a soft carpet patch mesh with micro-displacement (2–8 mm).
 */
export function createMoss(opts = {}) {
  const maxGround = opts.maxGround ?? GROUND_MOSS_COUNT;
  const group = new THREE.Group();
  group.name = 'mossRoot';

  // --- Soft carpet patches (displaced discs in shade) ---
  const carpetGroup = new THREE.Group();
  carpetGroup.name = 'mossCarpet';
  const carpetMat = new THREE.MeshStandardMaterial({
    color: 0x2f4a2c,
    roughness: 0.98,
    metalness: 0.0
  });

  const patchCount = 48;
  for (let i = 0; i < patchCount; i++) {
    const a = hash2(i, 1) * Math.PI * 2;
    // Prefer shade under canopy + damp hollows
    const r = 0.8 + hash2(i, 2) * (CROWN_RADIUS_M + 2.5);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = heightAt(x, z);
    const radius = 0.25 + hash2(i, 3) * 0.55;
    const segs = 16;
    const geom = new THREE.CircleGeometry(radius, segs);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const px = pos.getX(v) + x;
      const pz = pos.getZ(v) + z;
      const localR = Math.hypot(pos.getX(v), pos.getZ(v));
      const edge = 1.0 - THREE.MathUtils.smoothstep(radius * 0.55, radius, localR);
      // Micro-displacement 2–8 mm
      const disp = (0.002 + hash2(v + i * 13, i) * 0.006) * edge;
      pos.setY(v, heightAt(px, pz) - y + disp);
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, carpetMat);
    mesh.position.set(x, y + 0.001, z);
    mesh.receiveShadow = true;
    carpetGroup.add(mesh);
  }
  group.add(carpetGroup);

  // --- Instanced short strands in deep shade near bole ---
  const strandGeom = createStrandGeometry();
  const strandMat = createMossMaterial(0x3a5534);
  const strands = new THREE.InstancedMesh(strandGeom, strandMat, maxGround);
  strands.name = 'groundMossStrands';
  strands.frustumCulled = true;

  const dummy = new THREE.Object3D();
  const n = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();
  let count = 0;

  // Dense ring of clumps near bole (ground) until bark mesh exists
  const ringInner = TRUNK_BASE_RADIUS_M + 0.05;
  const ringOuter = TRUNK_BASE_RADIUS_M + 1.4;

  for (let i = 0; i < maxGround; i++) {
    const u = hash2(i, 4);
    const v = hash2(i, 5);
    // Bias toward bole ring + shade under crown
    const inRing = u < 0.55;
    let x;
    let z;
    if (inRing) {
      const ang = v * Math.PI * 2;
      const rad = ringInner + hash2(i, 6) * (ringOuter - ringInner);
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
    } else {
      const ang = hash2(i, 7) * Math.PI * 2;
      const rad = hash2(i, 8) * CROWN_RADIUS_M * 1.1;
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
    }

    const dist = Math.hypot(x, z);
    if (dist < TRUNK_BASE_RADIUS_M * 0.85) continue;

    normalAt(x, z, n);
    if (n.y < 0.55) continue; // upward-facing ground only

    const y = heightAt(x, z);
    const len =
      MOSS_STRAND_MIN_M +
      hash2(i, 9) * (MOSS_STRAND_MAX_M - MOSS_STRAND_MIN_M);

    dummy.position.set(x, y, z);
    quat.setFromUnitVectors(up, n);
    dummy.quaternion.copy(quat);
    dummy.rotateY(hash2(i, 10) * Math.PI * 2);
    // Slight lean toward shade (inward under canopy)
    dummy.rotateX((hash2(i, 11) - 0.5) * 0.35);
    dummy.scale.set(1, len, 1);
    dummy.updateMatrix();
    strands.setMatrixAt(count, dummy.matrix);

    const g = 0.32 + hash2(i, 12) * 0.2;
    strands.setColorAt(count, new THREE.Color(0.18, g, 0.16));
    count++;
  }

  strands.count = count;
  strands.instanceMatrix.needsUpdate = true;
  if (strands.instanceColor) strands.instanceColor.needsUpdate = true;
  group.add(strands);

  return {
    group,
    strands,
    groundCount: count,
    update(t) {
      const shader = strandMat.userData.shader;
      if (shader) shader.uniforms.uTime.value = t;
    }
  };
}

/**
 * Scatter epiphytic moss on a bark / trunk mesh.
 * Instances strands on upward-facing triangles (n·y > 0.35).
 * Lengths from MOSS_STRAND_* units.
 *
 * @param {THREE.Mesh} mesh
 * @param {object} [opts]
 * @param {number} [opts.maxCount]
 * @returns {THREE.InstancedMesh | null}
 */
export function scatterMossOnMesh(mesh, opts = {}) {
  if (!mesh || !mesh.geometry) return null;

  const maxCount = opts.maxCount ?? BARK_MOSS_MAX;
  const geom = mesh.geometry.index
    ? mesh.geometry.toNonIndexed()
    : mesh.geometry.clone();

  const pos = geom.attributes.position;
  const triCount = pos.count / 3;
  const strandGeom = createStrandGeometry();
  const mat = createMossMaterial(0x456640);
  const instanced = new THREE.InstancedMesh(strandGeom, mat, maxCount);
  instanced.name = 'barkMoss';

  mesh.updateWorldMatrix(true, false);
  const world = mesh.matrixWorld;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();

  let count = 0;
  // Stride through triangles; denser sample when fewer tris
  const stride = Math.max(1, Math.floor(triCount / maxCount));

  for (let t = 0; t < triCount && count < maxCount; t += stride) {
    const i = t * 3;
    a.fromBufferAttribute(pos, i).applyMatrix4(world);
    b.fromBufferAttribute(pos, i + 1).applyMatrix4(world);
    c.fromBufferAttribute(pos, i + 2).applyMatrix4(world);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac).normalize();

    if (normal.y <= 0.35) continue;

    // Prefer flatter / upward faces; shade bias via hash on X (north-ish -Z)
    const upFactor = normal.y;
    const shadeBias = 0.55 + 0.45 * Math.max(0, -((a.z + b.z + c.z) / 3));
    if (hash2(t, 1) > upFactor * shadeBias) continue;

    // Barycentric sample
    let u = hash2(t, 2);
    let v = hash2(t, 3);
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    centroid
      .copy(a)
      .multiplyScalar(1 - u - v)
      .addScaledVector(b, u)
      .addScaledVector(c, v);

    // Skip very thin radii (twigs): approximate by distance from Y-axis near top
    // Prefer lower trunk / forks — keep all upward faces with mild radius gate via height
    const len =
      MOSS_STRAND_MIN_M +
      hash2(t, 4) * (MOSS_STRAND_MAX_M - MOSS_STRAND_MIN_M);

    dummy.position.copy(centroid);
    quat.setFromUnitVectors(up, normal);
    dummy.quaternion.copy(quat);
    dummy.rotateY(hash2(t, 5) * Math.PI * 2);
    dummy.scale.set(1, len, 1);
    dummy.updateMatrix();
    instanced.setMatrixAt(count, dummy.matrix);

    const g = 0.35 + hash2(t, 6) * 0.22;
    instanced.setColorAt(count, new THREE.Color(0.2, g, 0.18));
    count++;
  }

  if (count === 0) {
    instanced.dispose();
    strandGeom.dispose();
    mat.dispose();
    return null;
  }

  instanced.count = count;
  instanced.instanceMatrix.needsUpdate = true;
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;

  // Attach under mesh parent if available
  if (mesh.parent) mesh.parent.add(instanced);
  else mesh.add(instanced);

  instanced.userData.update = (t) => {
    const shader = mat.userData.shader;
    if (shader) shader.uniforms.uTime.value = t;
  };
  instanced.userData.strandCount = count;

  return instanced;
}
