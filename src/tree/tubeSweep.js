/**
 * Thin-wood back-end (v1.1): swept tubes along limb chains.
 *
 * Why not the SDF here: below ~1.3 cells a limb can't be resolved by any grid, and a grid fine enough for
 * 3 mm tips is hopeless for a 9 m tree. A sweep is exact at any radius and costs O(points).
 *
 *  - ring side count follows radius (3…10) and changes smoothly along a limb (zipper stitching)
 *  - rings sit on the bisector plane with a parallel-transport frame (no twist, no pinch)
 *  - side-limb bases start *inside* the parent at the fork point with the child's own radius, so the fork
 *    is buried in solid wood: no gap, no flare
 *  - tips close with a short cone; UV seam is welded by an extra column (u = 0 … 1)
 *  - ring radius is area-equivalent (a 4-gon of "r" carries the cross-section of a round r), clamped
 */

/** Circumradius factor so an n-gon has the cross-section of a circle of radius r. */
export function ringScale(n) {
  const s = Math.sin((2 * Math.PI) / n);
  return Math.min(1.25, Math.sqrt((2 * Math.PI) / (n * s)));
}

/** Mean polygon surface radius (between inradius and circumradius) — what blossoms should seat on. */
export function tubeSurfaceRadius(r, n) {
  const rc = r * ringScale(n);
  return rc * 0.5 * (1 + Math.cos(Math.PI / n));
}

export const DEFAULT_SIDES = Object.freeze([
  [0.04, 10],
  [0.025, 8],
  [0.012, 6],
  [0.0055, 5],
  [0.0032, 4],
  [0, 3]
]);

export function sidesFor(r, table = DEFAULT_SIDES, minSides = 3) {
  for (const [rr, n] of table) if (r >= rr) return Math.max(minSides, n);
  return minSides;
}

/** Width-preserving miter factor for a ring on a bend (clamped). */
export function miterAt(c, i) {
  if (i <= 0 || i >= c.n - 1) return 1;
  const ax = c.x[i] - c.x[i - 1], ay = c.y[i] - c.y[i - 1], az = c.z[i] - c.z[i - 1];
  const bx = c.x[i + 1] - c.x[i], by = c.y[i + 1] - c.y[i], bz = c.z[i + 1] - c.z[i];
  const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
  const cs = (ax * bx + ay * by + az * bz) / (la * lb); // cos(turn)
  const halfTurn = Math.acos(Math.max(-1, Math.min(1, cs))) * 0.5;
  return Math.min(1.35, 1 / Math.max(0.5, Math.cos(halfTurn)));
}

/** Ring description for chain point i: side count and circumradius actually emitted. */
export function ringAt(c, i, o = {}) {
  const r = Math.max(o.minRadius ?? 0.0028, c.r[i]);
  const ns = sidesFor(r, o.sides ?? DEFAULT_SIDES, o.minSides ?? 3);
  return { ns, rc: r * ringScale(ns) * miterAt(c, i) };
}

/** Radial distance from axis to the n-gon surface in direction θ (θ measured like the UVs: from B toward N). */
export function polygonRadius(ns, rc, theta) {
  const sector = (Math.PI * 2) / ns;
  let a = theta % sector;
  if (a < 0) a += sector;
  a -= sector * 0.5;
  return (rc * Math.cos(sector * 0.5)) / Math.cos(a);
}

/**
 * @param {import('./chains.js').Chain[]} chains
 * @param {{ sides?: number[][], minSides?: number, capBase?: boolean, tipCone?: number, minRadius?: number }} [o]
 */
export function buildTubes(chains, o = {}) {
  const table = o.sides ?? DEFAULT_SIDES;
  const minSides = o.minSides ?? 3;
  const capBase = o.capBase ?? false;
  const tipCone = o.tipCone ?? 0.9;
  const minR = o.minRadius ?? 0.0028;
  const ringOpts = { sides: table, minSides, minRadius: minR };

  const pos = [], nor = [], uv = [], idx = [];
  let rings = 0, startRings = 0;

  for (const c of chains) {
    const i0 = c.tailStart, n = c.n;
    if (n - i0 < 2) continue;

    let prev = null; // { base, n }
    for (let i = i0; i < n; i++) {
      const { ns, rc } = ringAt(c, i, ringOpts); // circumradius incl. area-equivalence + miter
      const base = pos.length / 3;
      const cx = c.x[i], cy = c.y[i], cz = c.z[i];
      for (let k = 0; k <= ns; k++) {
        const th = (k / ns) * Math.PI * 2, ct = Math.cos(th), st = Math.sin(th);
        // θ convention matches ChainSDF.uvAt: q = R (B cosθ + N sinθ)
        const dx = c.B[i * 3] * ct + c.N[i * 3] * st;
        const dy = c.B[i * 3 + 1] * ct + c.N[i * 3 + 1] * st;
        const dz = c.B[i * 3 + 2] * ct + c.N[i * 3 + 2] * st;
        pos.push(cx + dx * rc, cy + dy * rc, cz + dz * rc);
        nor.push(dx, dy, dz);
        uv.push(k / ns, c.s[i]);
      }
      rings++;
      if (i === i0) startRings++;

      if (prev) {
        // zipper between ring prev (na) and ring cur (nb), both closed with duplicate seam column
        const na = prev.n, nb = ns;
        let a = 0, b = 0;
        while (a < na || b < nb) {
          const advA = a < na && (b >= nb || (a + 1) / na <= (b + 1) / nb);
          if (advA) { idx.push(prev.base + a, base + b, prev.base + a + 1); a++; }
          else { idx.push(prev.base + a, base + b, base + b + 1); b++; }
        }
      } else if (capBase) {
        // fan cap at the buried base (watertight shells; off by default — hidden inside the parent)
        const apex = pos.length / 3;
        pos.push(cx, cy, cz);
        nor.push(-c.T[i * 3], -c.T[i * 3 + 1], -c.T[i * 3 + 2]);
        uv.push(0.5, c.s[i]);
        for (let k = 0; k < ns; k++) idx.push(apex, base + k, base + k + 1);
      }
      prev = { base, n: ns };
    }

    // tip cone
    const last = n - 1;
    if (prev) {
      const r = Math.max(minR, c.r[last]);
      const apex = pos.length / 3;
      const tx = c.T[last * 3], ty = c.T[last * 3 + 1], tz = c.T[last * 3 + 2];
      pos.push(c.x[last] + tx * r * tipCone, c.y[last] + ty * r * tipCone, c.z[last] + tz * r * tipCone);
      nor.push(tx, ty, tz);
      uv.push(0.5, c.s[last] + r * tipCone);
      for (let k = 0; k < prev.n; k++) idx.push(prev.base + k, apex, prev.base + k + 1);
    }
  }
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nor),
    uvs: Float32Array.from(uv),
    indices: Uint32Array.from(idx),
    stats: { rings, tubeStarts: startRings }
  };
}
