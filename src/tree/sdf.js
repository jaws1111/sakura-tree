/**
 * Stage B — Analytic wood SDF (metres).
 * taperedCapsule ∪ polynomial smin ∪ bark groove displacement.
 */

import { BARK_GROOVE_AMP_M, TWIG_MIN_RADIUS_M } from '../units.js';

function saturate(x) {
  return Math.min(1, Math.max(0, x));
}

/**
 * Tapered capsule SDF (Quilez-style). Negative inside.
 * @param {{x:number,y:number,z:number}} p
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @param {number} ra
 * @param {number} rb
 */
export function taperedCapsule(p, a, b, ra, rb) {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = b.z - a.z;
  const pax = p.x - a.x;
  const pay = p.y - a.y;
  const paz = p.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const h = baba > 1e-12 ? saturate((pax * bax + pay * bay + paz * baz) / baba) : 0;
  const r = ra + (rb - ra) * h;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return Math.hypot(dx, dy, dz) - r;
}

/**
 * Polynomial smooth-min (Quilez). k in metres.
 */
export function smin(d1, d2, k) {
  if (k <= 1e-8) return Math.min(d1, d2);
  const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
  return Math.min(d1, d2) - (h * h * k) * 0.25;
}

/**
 * Blend radius scales with local segment radius (~0.35 r).
 * @param {number} r metres
 */
export function blendRadius(r) {
  return Math.max(0.0015, 0.35 * r);
}

/**
 * Project point onto edge; return h∈[0,1], closest C, frames, s, r.
 */
export function projectOnEdge(p, edge) {
  const { pa, pb, ra, rb, sa, sb, Na, Nb, Ba, Bb, Ta, Tb } = edge;
  const bax = pb.x - pa.x;
  const bay = pb.y - pa.y;
  const baz = pb.z - pa.z;
  const pax = p.x - pa.x;
  const pay = p.y - pa.y;
  const paz = p.z - pa.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const h = baba > 1e-12 ? saturate((pax * bax + pay * bay + paz * baz) / baba) : 0;
  const C = {
    x: pa.x + bax * h,
    y: pa.y + bay * h,
    z: pa.z + baz * h
  };
  const r = ra + (rb - ra) * h;
  const s = sa + (sb - sa) * h;
  const N = {
    x: Na.x + (Nb.x - Na.x) * h,
    y: Na.y + (Nb.y - Na.y) * h,
    z: Na.z + (Nb.z - Na.z) * h
  };
  const B = {
    x: Ba.x + (Bb.x - Ba.x) * h,
    y: Ba.y + (Bb.y - Ba.y) * h,
    z: Ba.z + (Bb.z - Ba.z) * h
  };
  const T = {
    x: Ta.x + (Tb.x - Ta.x) * h,
    y: Ta.y + (Tb.y - Ta.y) * h,
    z: Ta.z + (Tb.z - Ta.z) * h
  };
  return { h, C, r, s, N, B, T };
}

/**
 * Bark groove field G ∈ [0,1], amplitude applied as metres outside.
 * Decays to 0 for thin twigs (r < 0.015 m).
 */
export function barkGrooveDisplacement(p, edge, ampM = BARK_GROOVE_AMP_M) {
  const { C, r, s, N, B } = projectOnEdge(p, edge);
  if (r < 0.015) return 0;

  const qx = p.x - C.x;
  const qy = p.y - C.y;
  const qz = p.z - C.z;
  const nDot = qx * N.x + qy * N.y + qz * N.z;
  const bDot = qx * B.x + qy * B.y + qz * B.z;
  const theta = Math.atan2(nDot, bDot);

  // Frequencies in rad per metre of arc-length
  const nLobes = 7;
  const omega = 9.5; // rad·m⁻¹
  const eta = 8.0;
  const phi = 0.55;
  const Gtrunk = Math.abs(Math.sin(nLobes * theta + omega * s + phi * Math.sin(eta * s)));

  const nBranch = 5;
  const omegaB = 14;
  const Gbranch = Math.abs(Math.sin(nBranch * theta * 1.15 + omegaB * s * 0.7));

  // Depth weight: thicker wood → stronger grooves
  const depthW = saturate((r - 0.015) / (0.12 - 0.015));
  const G = Gtrunk * (0.7 + 0.3 * Gbranch);
  return ampM * G * depthW;
}

/**
 * Uniform-grid acceleration over capsule midpoints.
 * @param {import('./skeleton.js').CapsuleEdge[]} edges
 * @param {number} [cellM]
 */
export function buildEdgeSpatialIndex(edges, cellM = 0.35) {
  const cell = Math.max(0.15, cellM);
  const inv = 1 / cell;
  /** @type {Map<string, number[]>} */
  const grid = new Map();
  const mids = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const mx = (e.pa.x + e.pb.x) * 0.5;
    const my = (e.pa.y + e.pb.y) * 0.5;
    const mz = (e.pa.z + e.pb.z) * 0.5;
    mids[i] = { x: mx, y: my, z: mz };
    const key = `${Math.floor(mx * inv)}|${Math.floor(my * inv)}|${Math.floor(mz * inv)}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }
  return { grid, mids, cell, inv, edges };
}

/**
 * Gather up to maxK nearby edge indices via spatial hash (no full sort).
 * @param {{x:number,y:number,z:number}} p
 * @param {ReturnType<typeof buildEdgeSpatialIndex>} index
 * @param {number} maxK
 * @returns {number[]}
 */
export function queryNearbyEdges(p, index, maxK) {
  const { grid, mids, inv } = index;
  const ix = Math.floor(p.x * inv);
  const iy = Math.floor(p.y * inv);
  const iz = Math.floor(p.z * inv);
  /** @type {{ i: number, d2: number }[]} */
  const scored = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${ix + dx}|${iy + dy}|${iz + dz}`);
        if (!bucket) continue;
        for (const i of bucket) {
          const m = mids[i];
          const ddx = p.x - m.x;
          const ddy = p.y - m.y;
          const ddz = p.z - m.z;
          scored.push({ i, d2: ddx * ddx + ddy * ddy + ddz * ddz });
        }
      }
    }
  }
  if (scored.length === 0) {
    // Fallback: a few random / first edges so field never goes empty
    const n = Math.min(maxK, index.edges.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  scored.sort((a, b) => a.d2 - b.d2);
  const out = [];
  const seen = new Set();
  for (const s of scored) {
    if (seen.has(s.i)) continue;
    seen.add(s.i);
    out.push(s.i);
    if (out.length >= maxK) break;
  }
  return out;
}

/**
 * Evaluate wood SDF at p over skeleton edges (smooth union + bark).
 * Uses radius-adaptive blend; optional nearest-K culling for speed.
 *
 * @param {{x:number,y:number,z:number}} p
 * @param {import('./skeleton.js').CapsuleEdge[]} edges
 * @param {object} [opts]
 * @returns {number} signed distance metres (negative = inside wood)
 */
export function evaluateWoodSDF(p, edges, opts = {}) {
  const {
    nearestK = 0,
    ampM = BARK_GROOVE_AMP_M,
    includeBark = true,
    spatialIndex = null
  } = opts;

  if (!edges.length) return 1e3;

  let working = edges;
  if (nearestK > 0 && edges.length > nearestK) {
    if (spatialIndex) {
      const ids = queryNearbyEdges(p, spatialIndex, nearestK);
      working = ids.map((i) => edges[i]);
    } else {
      // Linear scan keep-maxK without allocating per-edge objects
      const ids = new Int32Array(nearestK);
      const d2s = new Float64Array(nearestK);
      ids.fill(-1);
      d2s.fill(Infinity);
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const mx = (e.pa.x + e.pb.x) * 0.5;
        const my = (e.pa.y + e.pb.y) * 0.5;
        const mz = (e.pa.z + e.pb.z) * 0.5;
        const d2 =
          (p.x - mx) * (p.x - mx) +
          (p.y - my) * (p.y - my) +
          (p.z - mz) * (p.z - mz);
        let worst = 0;
        for (let k = 1; k < nearestK; k++) if (d2s[k] > d2s[worst]) worst = k;
        if (d2 < d2s[worst]) {
          d2s[worst] = d2;
          ids[worst] = i;
        }
      }
      working = [];
      for (let k = 0; k < nearestK; k++) if (ids[k] >= 0) working.push(edges[ids[k]]);
    }
  }

  if (!working.length) return 1e3;

  let d = taperedCapsule(p, working[0].pa, working[0].pb, working[0].ra, working[0].rb);
  let closest = working[0];
  let closestCap = d;

  for (let i = 1; i < working.length; i++) {
    const e = working[i];
    const di = taperedCapsule(p, e.pa, e.pb, e.ra, e.rb);
    const k = blendRadius(Math.max(e.ra, e.rb));
    d = smin(d, di, k);
    if (di < closestCap) {
      closestCap = di;
      closest = e;
    }
  }

  if (includeBark && ampM > 0) {
    d += barkGrooveDisplacement(p, closest, ampM);
  }

  void TWIG_MIN_RADIUS_M;
  return d;
}

/**
 * Analytic-ish gradient via central differences.
 * @param {{x:number,y:number,z:number}} p
 * @param {import('./skeleton.js').CapsuleEdge[]} edges
 * @param {number} h metres
 * @param {object} [opts]
 */
export function sdfGradient(p, edges, h, opts) {
  const dx =
    evaluateWoodSDF({ x: p.x + h, y: p.y, z: p.z }, edges, opts) -
    evaluateWoodSDF({ x: p.x - h, y: p.y, z: p.z }, edges, opts);
  const dy =
    evaluateWoodSDF({ x: p.x, y: p.y + h, z: p.z }, edges, opts) -
    evaluateWoodSDF({ x: p.x, y: p.y - h, z: p.z }, edges, opts);
  const dz =
    evaluateWoodSDF({ x: p.x, y: p.y, z: p.z + h }, edges, opts) -
    evaluateWoodSDF({ x: p.x, y: p.y, z: p.z - h }, edges, opts);
  const inv = 1 / (2 * h);
  const gx = dx * inv;
  const gy = dy * inv;
  const gz = dz * inv;
  const L = Math.hypot(gx, gy, gz) || 1;
  return { x: gx / L, y: gy / L, z: gz / L };
}
