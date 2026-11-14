/**
 * Skeleton graph → limb chains (v1.1 meshing front-end).
 *
 * A chain is a root→tip polyline following the *dominant* (thickest) child at
 * every fork; every other child starts a new chain at the fork position.
 * Chains are what both back-ends consume:
 *   - thick head → SDF + surface nets (closed, filleted manifold)
 *   - thin tail  → swept tube (see tubeSweep.js)
 *
 * Each chain stores per-point radius, arc length (for UV.v), bisector tangent
 * and a parallel-transport frame (N,B) so UV.u = θ/2π is continuous along the limb.
 */

/**
 * @typedef {object} Chain
 * @property {number} id
 * @property {number} parent       parent chain id (-1 for root chain)
 * @property {number} depth
 * @property {boolean} isRoot      underground wood
 * @property {number} n            point count
 * @property {Float64Array} x
 * @property {Float64Array} y
 * @property {Float64Array} z
 * @property {Float64Array} r      radius (m)
 * @property {Float64Array} s      arc length (m) for UV.v
 * @property {Float64Array} T      3n bisector tangents
 * @property {Float64Array} N      3n frame normal
 * @property {Float64Array} B      3n frame binormal
 * @property {number} head         leading points belonging to the SDF (thick) domain; 0 = pure tube
 * @property {number} tailStart    first point index owned by the tube
 */

import { dominantChildId } from './skeleton.js';

const isRootKind = (k) => k === 'root' || k === 'taproot';

function rotateAbout(v, a, b, out) {
  // Rotation taking unit a → unit b (parallel transport step).
  const ax = a[0], ay = a[1], az = a[2];
  const kx = ay * b[2] - az * b[1];
  const ky = az * b[0] - ax * b[2];
  const kz = ax * b[1] - ay * b[0];
  const s = Math.hypot(kx, ky, kz);
  const c = ax * b[0] + ay * b[1] + az * b[2];
  if (s < 1e-9) {
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
    return;
  }
  const ux = kx / s, uy = ky / s, uz = kz / s;
  const d = ux * v[0] + uy * v[1] + uz * v[2];
  out[0] = v[0] * c + (uy * v[2] - uz * v[1]) * s + ux * d * (1 - c);
  out[1] = v[1] * c + (uz * v[0] - ux * v[2]) * s + uy * d * (1 - c);
  out[2] = v[2] * c + (ux * v[1] - uy * v[0]) * s + uz * d * (1 - c);
}

/**
 * @param {import('./skeleton.js').Skeleton} skeleton
 * @param {{ rCut?: number }} [opts] radius at/above which a point belongs to the SDF domain
 * @returns {{ chains: Chain[], rCut: number }}
 */
export function buildChains(skeleton, opts = {}) {
  const rCut = opts.rCut ?? 0.05;
  const nodes = skeleton.nodes;
  /** @type {Chain[]} */
  const chains = [];
  // skeleton.edges[nodeId - 1] is the edge into nodeId → which chain / segment owns it
  const edgeChain = new Int32Array(Math.max(0, nodes.length - 1)).fill(-1);
  const edgeSeg = new Int32Array(edgeChain.length).fill(-1);

  // work list of [startNode, firstChild, parentChain, depth]
  const work = [];
  if (nodes[0].children.length) work.push([0, dominantChildId(nodes, 0), -1, 0]);

  while (work.length) {
    const [startId, firstId, parentChain, depth] = work.pop();
    const id = chains.length;
    const ids = [startId, firstId];
    let cur = firstId;
    const forks = [];
    for (;;) {
      const kids = nodes[cur].children;
      if (!kids.length) break;
      const dom = dominantChildId(nodes, cur);
      for (const k of kids) if (k !== dom) forks.push([cur, k]);
      ids.push(dom);
      cur = dom;
    }

    const n = ids.length;
    const c = {
      id, parent: parentChain, depth,
      isRoot: isRootKind(nodes[firstId].kind),
      n,
      x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n),
      r: new Float64Array(n), s: new Float64Array(n),
      T: new Float64Array(n * 3), N: new Float64Array(n * 3), B: new Float64Array(n * 3),
      head: 0, tailStart: 0
    };
    for (let i = 0; i < n; i++) {
      const nd = nodes[ids[i]];
      c.x[i] = nd.position.x; c.y[i] = nd.position.y; c.z[i] = nd.position.z;
      c.r[i] = nd.radius; c.s[i] = nd.arcLength;
    }
    // Side limb base is as thick as the limb itself, not as its parent (== edge.raWood).
    c.r[0] = Math.min(nodes[startId].radius, nodes[firstId].radius);
    for (let i = 1; i < n; i++) { edgeChain[ids[i] - 1] = id; edgeSeg[ids[i] - 1] = i - 1; }

    // bisector tangents
    const seg = (i) => {
      const dx = c.x[i + 1] - c.x[i], dy = c.y[i + 1] - c.y[i], dz = c.z[i + 1] - c.z[i];
      const l = Math.hypot(dx, dy, dz) || 1;
      return [dx / l, dy / l, dz / l];
    };
    const segs = [];
    for (let i = 0; i < n - 1; i++) segs.push(seg(i));
    for (let i = 0; i < n; i++) {
      const a = segs[Math.max(0, i - 1)], b = segs[Math.min(n - 2, i)];
      let tx = a[0] + b[0], ty = a[1] + b[1], tz = a[2] + b[2];
      const l = Math.hypot(tx, ty, tz);
      if (l < 1e-9) { tx = b[0]; ty = b[1]; tz = b[2]; } else { tx /= l; ty /= l; tz /= l; }
      c.T[i * 3] = tx; c.T[i * 3 + 1] = ty; c.T[i * 3 + 2] = tz;
    }

    // parallel-transport frame, seeded from the skeleton's own frame so θ matches v1.0 UVs
    const f = nodes[firstId];
    let N = [f.N.x, f.N.y, f.N.z], B = [f.B.x, f.B.y, f.B.z];
    const t0 = [c.T[0], c.T[1], c.T[2]];
    // re-orthogonalise against bisector tangent
    {
      const d = N[0] * t0[0] + N[1] * t0[1] + N[2] * t0[2];
      N = [N[0] - d * t0[0], N[1] - d * t0[1], N[2] - d * t0[2]];
      let l = Math.hypot(N[0], N[1], N[2]);
      if (l < 1e-6) {
        N = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const dd = N[0] * t0[0] + N[1] * t0[1] + N[2] * t0[2];
        N = [N[0] - dd * t0[0], N[1] - dd * t0[1], N[2] - dd * t0[2]];
        l = Math.hypot(N[0], N[1], N[2]);
      }
      N = [N[0] / l, N[1] / l, N[2] / l];
      B = [t0[1] * N[2] - t0[2] * N[1], t0[2] * N[0] - t0[0] * N[2], t0[0] * N[1] - t0[1] * N[0]];
      // frame handedness of skeleton: N = B × T  ⇒  B = T × N
    }
    const tn = [0, 0, 0], tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const ta = [c.T[(i - 1) * 3], c.T[(i - 1) * 3 + 1], c.T[(i - 1) * 3 + 2]];
        tn[0] = c.T[i * 3]; tn[1] = c.T[i * 3 + 1]; tn[2] = c.T[i * 3 + 2];
        rotateAbout(N, ta, tn, tmp); N = [tmp[0], tmp[1], tmp[2]];
        rotateAbout(B, ta, tn, tmp); B = [tmp[0], tmp[1], tmp[2]];
      }
      c.N.set(N, i * 3); c.B.set(B, i * 3);
    }

    // thick / thin split along the limb
    let h = 0;
    while (h < n && c.r[h] >= rCut) h++;
    c.head = h >= 2 ? h : 0;
    c.tailStart = c.head >= 2 ? c.head - 1 : 0;

    chains.push(c);
    for (const [fn, fk] of forks) work.push([fn, fk, id, depth + 1]);
  }
  return { chains, rCut, edgeChain, edgeSeg };
}
