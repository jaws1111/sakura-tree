import * as THREE from 'three';
import {
  PETAL_LENGTH_M,
  PETAL_WIDTH_M,
  CLUSTER_SPAN_M,
  FLOWER_DIAMETER_M
} from '../units.js';

/**
 * Analytic sakura petal / blossom-cluster geometry.
 * All lengths are metres (1 world unit = 1 m). Cup/curl/crease are fractions of L.
 */
export class ParametricPetalBuilder {
  /**
   * @param {object} [opts]
   * @param {number} [opts.length=PETAL_LENGTH_M] Petal length (m)
   * @param {number} [opts.maxWidth=PETAL_WIDTH_M] Full lamina width (m)
   * @param {number} [opts.notchDepth=0.55] Apical cleft depth β (dimensionless)
   * @param {number} [opts.sigmaNotch=0.06] Notch decay along v
   * @param {number} [opts.sigmaCleft=0.04] Cleft decay along u
   * @param {number} [opts.cupIntensity=0.12] Cup amplitude as fraction of L (~2 mm)
   * @param {number} [opts.curlIntensity=0.08] Longitudinal curl as fraction of L
   * @param {number} [opts.creaseIntensity=0.05] Central V-crease as fraction of L
   * @param {number} [opts.segmentsU=7] Lateral subdivisions (M)
   * @param {number} [opts.segmentsV=11] Longitudinal subdivisions (N)
   * @returns {THREE.BufferGeometry}
   */
  static createPetalGeometry({
    length = PETAL_LENGTH_M,
    maxWidth = PETAL_WIDTH_M,
    notchDepth = 0.55,
    sigmaNotch = 0.06,
    sigmaCleft = 0.04,
    cupIntensity = 0.12,
    curlIntensity = 0.08,
    creaseIntensity = 0.05,
    segmentsU = 7,
    segmentsV = 11
  } = {}) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    // Peak of v^0.6 * (1-v)^0.4 so envelope normalizes ~1 at widest section
    const envelopePeak = Math.pow(0.6, 0.6) * Math.pow(0.4, 0.4);

    const samplePoint = (u, v) => {
      const xRel = u - 0.5;
      const vv = Math.min(Math.max(v, 1e-6), 1 - 1e-6);

      // Spade-like half-width envelope with apical notch (§2.1)
      const envelope = Math.pow(vv, 0.6) * Math.pow(1.0 - vv, 0.4);
      const notch =
        Math.exp(-(v - 1.0) * (v - 1.0) / (2.0 * sigmaNotch * sigmaNotch)) *
        Math.exp(-(xRel * xRel) / (2.0 * sigmaCleft * sigmaCleft));
      const widthFactor = Math.max(0.0, (envelope / envelopePeak) * (1.0 - notchDepth * notch));

      // maxWidth is full lamina width in metres
      const x = xRel * maxWidth * widthFactor;
      const y = v * length;

      // Vertical deflection in metres (intensities are fractions of length)
      const cup = -cupIntensity * length * 4.0 * (xRel * xRel) * Math.sqrt(Math.max(v, 0));
      const curl = curlIntensity * length * v * v;
      const crease = -creaseIntensity * length * Math.abs(xRel) * (1.0 - v);
      const z = cup + curl + crease;

      return new THREE.Vector3(x, y, z);
    };

    for (let iv = 0; iv <= segmentsV; iv++) {
      const v = iv / segmentsV;
      for (let iu = 0; iu <= segmentsU; iu++) {
        const u = iu / segmentsU;
        const pt = samplePoint(u, v);
        positions.push(pt.x, pt.y, pt.z);
        uvs.push(u, v);

        // Finite-difference normals
        const delta = 0.005;
        const ptU = samplePoint(Math.min(1.0, u + delta), v);
        const ptV = samplePoint(u, Math.min(1.0, v + delta));
        const dU = new THREE.Vector3().subVectors(ptU, pt);
        const dV = new THREE.Vector3().subVectors(ptV, pt);
        const norm = new THREE.Vector3().crossVectors(dU, dV).normalize();
        if (norm.z < 0) norm.negate();
        normals.push(norm.x, norm.y, norm.z);
      }
    }

    const stride = segmentsU + 1;
    for (let iv = 0; iv < segmentsV; iv++) {
      for (let iu = 0; iu < segmentsU; iu++) {
        const a = iv * stride + iu;
        const b = (iv + 1) * stride + iu;
        const c = (iv + 1) * stride + (iu + 1);
        const d = iv * stride + (iu + 1);
        indices.push(a, b, d, b, c, d);
      }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
  }

  /** Compact bud: low-segment petal, tightly cupped. */
  static createBudGeometry() {
    return this.createPetalGeometry({
      length: PETAL_LENGTH_M * 0.55,
      maxWidth: PETAL_WIDTH_M * 0.45,
      cupIntensity: 0.22,
      curlIntensity: 0.18,
      creaseIntensity: 0.03,
      notchDepth: 0.2,
      segmentsU: 4,
      segmentsV: 5
    });
  }

  /** Simple stamen / receptacle core (~80 tris). */
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
   * Blossom cluster. `lite` ≈ Kanzan pom-pom (dense double-flower, low segs).
   * Physical span ≈ CLUSTER_SPAN_M.
   * @param {number|object} [seedOrOpts=1]
   * @returns {THREE.BufferGeometry}
   */
  static createBlossomClusterGeometry(seedOrOpts = 1) {
    const opts =
      typeof seedOrOpts === 'object' && seedOrOpts
        ? seedOrOpts
        : { seed: seedOrOpts };
    const seed = (opts.seed >>> 0) || 1;
    const quality =
      opts.quality === 'high' ? 'high' : opts.quality === 'playable' ? 'playable' : 'lite';
    const kanzan = opts.kanzan !== false && quality === 'lite';
    const flowers =
      opts.flowers ?? (quality === 'high' ? 4 : quality === 'playable' ? 2 : 1);
    const buds =
      opts.buds ?? (quality === 'high' ? 2 : quality === 'playable' ? 1 : 0);
    const segU =
      opts.segmentsU ?? (quality === 'high' ? 7 : quality === 'playable' ? 4 : 2);
    const segV =
      opts.segmentsV ?? (quality === 'high' ? 11 : quality === 'playable' ? 6 : 2);
    const includeStamen = opts.includeStamen ?? quality === 'high';
    // Kanzan-style: many petals in 2 layers → pom-pom mass
    const petalsPerFlower =
      opts.petalsPerFlower ??
      (kanzan ? 16 : quality === 'lite' ? 5 : 5);
    const layers = opts.layers ?? (kanzan ? 2 : 1);

    let s = seed;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };

    const petalScale = kanzan ? 0.9 : 1;
    const petalBase = this.createPetalGeometry({
      length: PETAL_LENGTH_M * petalScale,
      maxWidth: PETAL_WIDTH_M * petalScale * 1.05,
      cupIntensity: kanzan ? 0.2 : 0.12,
      curlIntensity: kanzan ? 0.14 : 0.08,
      creaseIntensity: 0.04,
      notchDepth: kanzan ? 0.35 : 0.55,
      segmentsU: segU,
      segmentsV: segV
    });
    const budBase = this.createPetalGeometry({
      length: PETAL_LENGTH_M * 0.55,
      maxWidth: PETAL_WIDTH_M * 0.45,
      cupIntensity: 0.22,
      curlIntensity: 0.18,
      creaseIntensity: 0.03,
      notchDepth: 0.2,
      segmentsU: Math.max(2, segU - 1),
      segmentsV: Math.max(2, segV - 1)
    });
    const stamen = this.createStamenCoreGeometry();

    const arrays = { positions: [], normals: [], uvs: [], indices: [] };
    let indexOffset = 0;
    const halfSpan = CLUSTER_SPAN_M * (kanzan ? 0.38 : 0.5);

    for (let f = 0; f < flowers; f++) {
      const flowerOrigin = new THREE.Vector3(
        (rand() - 0.5) * halfSpan * (kanzan ? 0.9 : 1.6),
        (rand() - 0.5) * halfSpan * (kanzan ? 0.55 : 0.9),
        (rand() - 0.5) * halfSpan * (kanzan ? 0.9 : 1.6)
      );

      for (let layer = 0; layer < layers; layer++) {
        const layerPetals = Math.max(
          5,
          Math.round(petalsPerFlower / layers + (layer === 0 ? 2 : -1))
        );
        const pitchBase = layer === 0 ? 0.55 : 0.22; // outer open, inner upright
        for (let p = 0; p < layerPetals; p++) {
          const angle =
            (p / layerPetals) * Math.PI * 2 +
            layer * 0.17 +
            (rand() - 0.5) * 0.12;
          const pitch = pitchBase + rand() * 0.18;
          const radial = (kanzan ? 0.004 : 0) * (1 + layer);
          const origin = flowerOrigin
            .clone()
            .add(
              new THREE.Vector3(
                Math.cos(angle) * radial,
                layer * 0.003,
                Math.sin(angle) * radial
              )
            );
          const euler = new THREE.Euler(pitch, 0, angle, 'ZYX');
          const matrix = new THREE.Matrix4()
            .makeRotationFromEuler(euler)
            .setPosition(origin);
          indexOffset = this.#appendTransformed(petalBase, matrix, arrays, indexOffset);
        }
      }
    }

    for (let b = 0; b < buds; b++) {
      const budOrigin = new THREE.Vector3(
        (rand() - 0.5) * halfSpan,
        (rand() - 0.5) * halfSpan * 0.6,
        (rand() - 0.5) * halfSpan
      );
      const euler = new THREE.Euler(
        0.15 + rand() * 0.35,
        rand() * Math.PI * 2,
        (rand() - 0.5) * 0.4,
        'YXZ'
      );
      const matrix = new THREE.Matrix4()
        .makeRotationFromEuler(euler)
        .setPosition(budOrigin);
      indexOffset = this.#appendTransformed(budBase, matrix, arrays, indexOffset);
    }

    if (includeStamen) {
      const matrix = new THREE.Matrix4().makeTranslation(0, 0.002, 0);
      this.#appendTransformed(stamen, matrix, arrays, indexOffset);
    }

    petalBase.dispose();
    budBase.dispose();
    stamen.dispose();

    const clusterGeom = new THREE.BufferGeometry();
    clusterGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(arrays.positions, 3)
    );
    clusterGeom.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(arrays.normals, 3)
    );
    clusterGeom.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
    clusterGeom.setIndex(arrays.indices);
    clusterGeom.computeBoundingBox();
    clusterGeom.computeBoundingSphere();
    clusterGeom.userData.triangleCount = arrays.indices.length / 3;

    return clusterGeom;
  }
}
