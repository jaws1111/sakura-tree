import * as THREE from 'three';
import { PARK_EXTENT_M } from '../units.js';

/** Max |h| for the gentle park mound (metres). */
export const TERRAIN_MAX_ABS_H_M = 0.35;

/**
 * Analytic heightfield h(x,z) in metres. Same function drives CPU queries
 * and mesh vertex displacement so petals / grass / camera stay bit-compatible.
 * Tree collar at (0,0) sits near y = 0.
 */
export function heightAt(x, z) {
  const r2 = x * x + z * z;
  // Broad soft mound away from bole, slight hollow near drip-line
  const mound = 0.12 * Math.exp(-r2 / (18 * 18)) - 0.04 * Math.exp(-r2 / (5.5 * 5.5));
  const undulation =
    0.11 * Math.sin(x * 0.28) * Math.cos(z * 0.22) +
    0.07 * Math.sin(x * 0.11 + z * 0.15) +
    0.045 * Math.sin(x * 0.55 - z * 0.4) * Math.cos(z * 0.35);
  const ripple = 0.025 * Math.sin(x * 1.1 + z * 0.9) * Math.sin(z * 0.85);
  let h = mound + undulation + ripple;
  // Keep collar flat for root contact
  const collar = Math.exp(-(r2) / (0.55 * 0.55));
  h *= 1.0 - 0.92 * collar;
  return THREE.MathUtils.clamp(h, -TERRAIN_MAX_ABS_H_M, TERRAIN_MAX_ABS_H_M);
}

/**
 * Approximate terrain normal from central differences (metres).
 * @param {THREE.Vector3} [target]
 */
export function normalAt(x, z, target = new THREE.Vector3()) {
  const e = 0.05; // m
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return target.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
}

/**
 * Slope angle in radians from horizontal.
 */
export function slopeAt(x, z) {
  const n = normalAt(x, z);
  return Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
}

/**
 * Build the park ground mesh (40×40 m) with heightfield displacement.
 * @returns {{ mesh: THREE.Mesh, heightAt: Function, normalAt: Function, slopeAt: Function, group: THREE.Group }}
 */
export function createTerrain() {
  const extent = PARK_EXTENT_M;
  // ~1 m quads near-ish: 40 segments → 1 m; fine enough for soft park
  const segs = 64;
  const geom = new THREE.PlaneGeometry(extent, extent, segs, segs);
  geom.rotateX(-Math.PI / 2);

  const pos = geom.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const _n = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);

    // Splat-ish vertex colour: damp hollows darker, slight rock on steeper
    normalAt(x, z, _n);
    const slope = 1.0 - _n.y;
    const damp = THREE.MathUtils.smoothstep(-0.05, 0.15, -h);
    const grassR = 0.28 - damp * 0.06;
    const grassG = 0.38 - damp * 0.08 + slope * 0.04;
    const grassB = 0.2 - damp * 0.04 + slope * 0.06;
    colors[i * 3] = grassR;
    colors[i * 3 + 1] = grassG;
    colors[i * 3 + 2] = grassB;
  }
  pos.needsUpdate = true;
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: false
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  const group = new THREE.Group();
  group.name = 'terrainRoot';
  group.add(mesh);

  return {
    group,
    mesh,
    heightAt,
    normalAt,
    slopeAt,
    maxAbsH: TERRAIN_MAX_ABS_H_M
  };
}
