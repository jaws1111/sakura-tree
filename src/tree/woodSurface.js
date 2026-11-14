/**
 * Wood-surface probe (v1.1): where is the *meshed* bark relative to a skeleton edge's axis?
 *
 * Blossom seats and peduncle roots used to be placed at `radius + 3 mm`, a guess that ignored the actual
 * geometry (n-gon tubes, tapered ends, thinner side-limb bases) and left stems hovering or buried by
 * several millimetres. The probe answers exactly, from the same ring data the tube builder emits.
 */

import { ringAt, polygonRadius } from './tubeSweep.js';

/**
 * @param {import('./chains.js').Chain[]} chains
 * @param {Int32Array} edgeChain
 * @param {Int32Array} edgeSeg
 * @param {object} [tubeOpts] same sides/minSides/minRadius given to buildTubes
 */
export function createWoodSurface(chains, edgeChain, edgeSeg, tubeOpts = {}) {
  const thetaOf = (c, i, dx, dy, dz) => {
    const o = i * 3;
    let th = Math.atan2(dx * c.N[o] + dy * c.N[o + 1] + dz * c.N[o + 2], dx * c.B[o] + dy * c.B[o + 1] + dz * c.B[o + 2]);
    if (th < 0) th += Math.PI * 2;
    return th;
  };
  return {
    kind: 'v1.1-wood-surface',
    /**
     * Distance from the limb axis to the meshed surface along unit direction d (⟂ axis) at fraction t of skeleton edge.
     * @returns {number} metres, or NaN if the edge is unknown
     */
    radiusAt(edgeIndex, t, dx, dy, dz) {
      const ci = edgeChain[edgeIndex];
      if (ci < 0) return NaN;
      const c = chains[ci], i = edgeSeg[edgeIndex];
      if (c.head >= 2 && i + 1 < c.head) return c.r[i] + (c.r[i + 1] - c.r[i]) * t; // surface-net domain
      const a = ringAt(c, i, tubeOpts), b = ringAt(c, i + 1, tubeOpts);
      const ra = polygonRadius(a.ns, a.rc, thetaOf(c, i, dx, dy, dz));
      const rb = polygonRadius(b.ns, b.rc, thetaOf(c, i + 1, dx, dy, dz));
      return ra + (rb - ra) * t;
    },
    isTube(edgeIndex) {
      const ci = edgeChain[edgeIndex];
      if (ci < 0) return false;
      const c = chains[ci];
      return !(c.head >= 2 && edgeSeg[edgeIndex] + 1 < c.head);
    }
  };
}
