import * as THREE from 'three';
import {
  PARK_EXTENT_M,
  GRASS_HEIGHT_MIN_M,
  GRASS_HEIGHT_MAX_M,
  GRASS_WIDTH_M,
  CROWN_RADIUS_M
} from '../units.js';
import { PLAYABLE } from '../budget.js';
import { heightAt, normalAt, slopeAt } from './terrain.js';
import { WIND_GLSL } from './wind.js';
import { exponentialDensity } from '../optimize/screenSpace.js';

const BLADE_SEGS = PLAYABLE.grassBladeSegs;
const SPACING_M = PLAYABLE.grassSpacingM;
const NEAR_RADIUS_M = 18;
const CANOPY_THIN_RADIUS_M = CROWN_RADIUS_M;
const MAX_SLOPE_RAD = (35 * Math.PI) / 180;
/** Characteristic falloff length for grass density (m). */
const DENSITY_LAMBDA_M = 7.5;
export const GRASS_DEFAULT_COUNT = PLAYABLE.grassCount;

function hash2(ix, iz) {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function hash3(ix, iz, salt) {
  const n = Math.sin(ix * 269.5 + iz * 183.3 + salt * 91.7) * 43758.5453;
  return n - Math.floor(n);
}

function clumpCell(x, z) {
  const cell = 1.15;
  const cx = Math.floor(x / cell);
  const cz = Math.floor(z / cell);
  let best = 1e9;
  let bid = 0;
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const nx = cx + ox;
      const nz = cz + oz;
      const px = (nx + hash2(nx, nz)) * cell;
      const pz = (nz + hash2(nz + 17, nx)) * cell;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < best) {
        best = d;
        bid = nx * 73856093 ^ nz * 19349663;
      }
    }
  }
  return { id: bid >>> 0, dist2: best };
}

function createBladeGeometry() {
  const w = GRASS_WIDTH_M;
  const segs = BLADE_SEGS;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const half = w * 0.5 * (1.0 - t * 0.55);
    positions.push(-half, t, 0, half, t, 0);
    normals.push(0, 0, 1, 0, 0, 1);
    uvs.push(0, t, 1, t);
    if (i < segs) {
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

function createGrassMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5a7a3e,
    roughness: 0.85,
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
        ${WIND_GLSL}`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Tip-only bend: bladeT=0 at base (planted), 1 at tip
        float bladeT = uv.y;
        vec4 world = modelMatrix * vec4(transformed, 1.0);
        vec3 wind = sampleWindGLSL(world.xyz, uTime);
        transformed.xz += wind.xz * bladeT * bladeT * 0.35;`
      );
  };
  mat.customProgramCacheKey = () => 'grass-wind-v3';
  return mat;
}

/**
 * Grass with scientific density control:
 *  1) Slope / canopy rejection at placement
 *  2) Exponential distance falloff ρ=exp(−(d−d0)/λ) vs camera each frame
 *  3) Instance count capped — far blades are not drawn (tris eliminated)
 */
export function createGrass(opts = {}) {
  const maxCount = opts.maxCount ?? GRASS_DEFAULT_COUNT;
  const spacing = opts.spacing ?? SPACING_M;
  const half = PARK_EXTENT_M * 0.5;

  const geom = createBladeGeometry();
  const mat = createGrassMaterial();
  const mesh = new THREE.InstancedMesh(geom, mat, maxCount);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.name = 'grass';

  const dummy = new THREE.Object3D();
  const n = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();
  const color = new THREE.Color();

  /** Packed: x,y,z, h, yaw, cr, cg, hash */
  const pool = [];

  const iMin = Math.floor(-half / spacing);
  const iMax = Math.ceil(half / spacing);

  for (let iz = iMin; iz <= iMax; iz++) {
    for (let ix = iMin; ix <= iMax; ix++) {
      const jx = (hash2(ix, iz) - 0.5) * spacing * 0.9;
      const jz = (hash3(ix, iz, 3) - 0.5) * spacing * 0.9;
      const x = ix * spacing + jx;
      const z = iz * spacing + jz;

      if (Math.abs(x) > half - 0.2 || Math.abs(z) > half - 0.2) continue;

      const distOrigin = Math.hypot(x, z);
      const feather = NEAR_RADIUS_M * (0.86 + 0.28 * hash2(ix + 5, iz - 3));
      if (distOrigin > feather) continue;

      // Placement density: canopy shade + clump (not camera-dependent)
      let density = 1.0 - (distOrigin / NEAR_RADIUS_M) * 0.35;
      if (distOrigin < CANOPY_THIN_RADIUS_M) {
        density *= 0.35 + 0.45 * (distOrigin / CANOPY_THIN_RADIUS_M);
      }
      if (distOrigin < 0.35) density *= distOrigin / 0.35;

      const clump = clumpCell(x, z);
      const clumpBoost =
        0.75 + 0.45 * (1.0 - Math.min(Math.sqrt(clump.dist2) / 0.7, 1));
      density *= clumpBoost;

      const hHash = hash3(ix, iz, 7);
      if (hHash > density) continue;
      if (slopeAt(x, z) > MAX_SLOPE_RAD) continue;

      const clumpAngle = (clump.id % 360) * (Math.PI / 180) * 0.3;
      const yaw = clumpAngle + (hash2(iz, ix) - 0.5) * 0.85;
      const h =
        GRASS_HEIGHT_MIN_M +
        (GRASS_HEIGHT_MAX_M - GRASS_HEIGHT_MIN_M) *
          (0.35 + 0.65 * hash3(ix, iz, 11)) *
          (0.9 + 0.2 * (clumpBoost - 0.75));
      const y = heightAt(x, z);

      pool.push({
        x,
        y,
        z,
        h,
        yaw,
        cr: 0.25 + hash3(ix, iz, 23) * 0.12,
        cg: 0.45 + hash3(ix, iz, 19) * 0.25,
        keep: hHash
      });
    }
  }

  // Cap pool to maxCount with even stride (budget)
  const stride = pool.length > maxCount ? pool.length / maxCount : 1;
  const blades = [];
  for (let s = 0; s < pool.length && blades.length < maxCount; s += stride) {
    blades.push(pool[Math.floor(s)]);
  }

  const matrices = new Array(blades.length);
  for (let i = 0; i < blades.length; i++) {
    const b = blades[i];
    normalAt(b.x, b.z, n);
    dummy.position.set(b.x, b.y, b.z);
    quat.setFromUnitVectors(up, n);
    dummy.quaternion.copy(quat);
    dummy.rotateY(b.yaw);
    dummy.scale.set(1, b.h, 1);
    dummy.updateMatrix();
    matrices[i] = dummy.matrix.clone();
    color.setRGB(b.cr, b.cg, 0.18);
    mesh.setColorAt(i, color);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  /**
   * Rebuild drawn set: exponential camera falloff eliminates far tris.
   * Blades with keep-hash above ρ(d) are culled this frame.
   */
  const rebuildVisible = (camera) => {
    let count = 0;
    if (!camera) {
      for (let i = 0; i < blades.length; i++) {
        mesh.setMatrixAt(i, matrices[i]);
        count++;
      }
    } else {
      const cx = camera.position.x;
      const cy = camera.position.y;
      const cz = camera.position.z;
      for (let i = 0; i < blades.length; i++) {
        const b = blades[i];
        const d = Math.hypot(b.x - cx, b.y - cy, b.z - cz);
        const rho = exponentialDensity(d, 4.0, DENSITY_LAMBDA_M);
        // Stochastic keep stable per blade (not flicker): compare stored hash
        if (b.keep > rho) continue;
        mesh.setMatrixAt(count, matrices[i]);
        if (mesh.instanceColor) {
          color.setRGB(b.cr, b.cg, 0.18);
          mesh.setColorAt(count, color);
        }
        count++;
      }
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return count;
  };

  rebuildVisible(null);

  const group = new THREE.Group();
  group.name = 'grassRoot';
  group.add(mesh);

  return {
    group,
    mesh,
    count: blades.length,
    heightRange: [GRASS_HEIGHT_MIN_M, GRASS_HEIGHT_MAX_M],
    spacing,
    update(t, camera) {
      const shader = mat.userData.shader;
      if (shader) shader.uniforms.uTime.value = t;
      if (camera) rebuildVisible(camera);
    }
  };
}
