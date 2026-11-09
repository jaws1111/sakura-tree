import * as THREE from 'three';
import {
  PETAL_LENGTH_M,
  PETAL_WIDTH_M,
  FLOWER_DIAMETER_M
} from '../units.js';

/**
 * Folded-plane sakura petal (4 triangles) + 5-leaf blossom.
 * Shape / edge fade live in the blossom ShaderMaterial (see SakuraMaterialFactory).
 */
export class ParametricPetalBuilder {
  /**
   * Single leaf — folded plane, 2 quads / 4 triangles (~7° crease).
   * Local space: Y along length (base→tip), X width, Z fold depth.
   * @param {object} [opts]
   * @param {number} [opts.length=PETAL_LENGTH_M]
   * @param {number} [opts.width=PETAL_WIDTH_M]
   * @param {number} [opts.foldDegrees=7]
   * @returns {THREE.BufferGeometry}
   */
  static createFoldedPetalGeometry({
    length = PETAL_LENGTH_M,
    width = PETAL_WIDTH_M,
    foldDegrees = 7
  } = {}) {
    const geo = new THREE.BufferGeometry();
    const rad = (foldDegrees * Math.PI) / 180;
    const halfW = width * 0.5;
    const halfH = length * 0.5;
    const z = Math.tan(rad) * halfW;

    // Base at y=-halfH (flower center), tip at y=+halfH
    const positions = new Float32Array([
      -halfW, -halfH, z, // 0 left bottom
      -halfW, halfH, z, // 1 left top
      0, -halfH, 0, // 2 center bottom
      0, halfH, 0, // 3 center top
      halfW, -halfH, z, // 4 right bottom
      halfW, halfH, z // 5 right top
    ]);

    const uvs = new Float32Array([0, 0, 0, 1, 0.5, 0, 0.5, 1, 1, 0, 1, 1]);

    const indices = [
      0, 2, 1, 1, 2, 3, // left quad
      2, 4, 3, 3, 4, 5 // right quad
    ];

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    geo.userData.triangleCount = 4;
    return geo;
  }

  /** @deprecated Prefer createFoldedPetalGeometry — kept for callers. */
  static createPetalGeometry(opts = {}) {
    return this.createFoldedPetalGeometry({
      length: opts.length ?? PETAL_LENGTH_M,
      width: opts.maxWidth ?? opts.width ?? PETAL_WIDTH_M,
      foldDegrees: opts.foldDegrees ?? 7
    });
  }

  static createBudGeometry() {
    return this.createFoldedPetalGeometry({
      length: PETAL_LENGTH_M * 0.55,
      width: PETAL_WIDTH_M * 0.45,
      foldDegrees: 10
    });
  }

  static createStamenCoreGeometry() {
    const r = FLOWER_DIAMETER_M * 0.12;
    const geom = new THREE.SphereGeometry(r, 8, 6);
    geom.scale(1, 1.35, 1);
    return geom;
  }

  static #appendTransformed(source, matrix, arrays, indexOffset) {
    const posAttr = source.getAttribute('position');
    const normAttr = source.getAttribute('normal');
    const uvAttr = source.getAttribute('uv');
    const index = source.getIndex();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
      n.fromBufferAttribute(normAttr, i).applyMatrix3(normalMatrix).normalize();
      arrays.positions.push(v.x, v.y, v.z);
      arrays.normals.push(n.x, n.y, n.z);
      arrays.uvs.push(uvAttr.getX(i), uvAttr.getY(i));
    }

    if (index) {
      for (let i = 0; i < index.count; i++) {
        arrays.indices.push(index.getX(i) + indexOffset);
      }
    }

    return indexOffset + posAttr.count;
  }

  /**
   * Standard blossom: 5 folded leaves in a star.
   * Pivot is at each leaf's BASE (not mid-leaf) so tips radiate outward.
   * 5 × 4 tris = 20 triangles.
   * @param {object} [opts]
   * @returns {THREE.BufferGeometry}
   */
  static createFiveLeafBlossom(opts = {}) {
    const seed = (opts.seed >>> 0) || 1;
    const leafCount = opts.petalsPerFlower ?? 5;
    const length = opts.length ?? PETAL_LENGTH_M * 1.05;
    const width = opts.width ?? PETAL_WIDTH_M * 1.1;
    // Pitch from upright: ~1.05–1.25 ≈ flat star with slight cup (reference top-down)
    const open = opts.open ?? 1.12;

    let s = seed;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };

    const leaf = this.createFoldedPetalGeometry({
      length,
      width,
      foldDegrees: opts.foldDegrees ?? 7
    });

    const arrays = { positions: [], normals: [], uvs: [], indices: [] };
    let indexOffset = 0;
    const halfH = length * 0.5;
    // Folded petal spans y∈[-halfH,+halfH]; shift so BASE (y=-halfH) → origin
    const toBasePivot = new THREE.Matrix4().makeTranslation(0, halfH, 0);
    // Tiny gap at the flower eye (reference has a clear center)
    const eye = length * 0.08;

    for (let p = 0; p < leafCount; p++) {
      const yaw = (p / leafCount) * Math.PI * 2;
      const pitch = open + (rand() - 0.5) * 0.06;
      // M = T_eye * R_yaw * R_pitch * T_basePivot
      // Tip points radially outward; rotation hinge is the base at the eye.
      const m = new THREE.Matrix4()
        .makeTranslation(
          Math.cos(yaw) * eye,
          length * 0.01,
          Math.sin(yaw) * eye
        )
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationX(pitch))
        .multiply(toBasePivot);
      indexOffset = this.#appendTransformed(leaf, m, arrays, indexOffset);
    }

    leaf.dispose();

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
    geom.setIndex(arrays.indices);
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    geom.userData.triangleCount = arrays.indices.length / 3;
    geom.userData.leafCount = leafCount;
    return geom;
  }

  /**
   * Canopy instance mesh — one 5-leaf blossom (far LOD can use same, slightly tighter).
   * @param {number|object} [seedOrOpts=1]
   * @returns {THREE.BufferGeometry}
   */
  static createBlossomClusterGeometry(seedOrOpts = 1) {
    const opts =
      typeof seedOrOpts === 'object' && seedOrOpts ? seedOrOpts : { seed: seedOrOpts };
    const far = opts.quality === 'lite' && opts.segmentsU != null && opts.segmentsU <= 2;
    return this.createFiveLeafBlossom({
      seed: opts.seed ?? 1,
      petalsPerFlower: 5,
      length: PETAL_LENGTH_M * (far ? 0.95 : 1.05),
      width: PETAL_WIDTH_M * (far ? 1.0 : 1.1),
      open: far ? 0.65 : 0.72,
      foldDegrees: 7
    });
  }
}
