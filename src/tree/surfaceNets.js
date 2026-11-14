/**
 * Thick-wood back-end (v1.1): chain SDF → flood-fill surface nets → relax → radius-aware QEM.
 * Ideas adapted from doc/branch_mesher.html:
 *   - exact min inside a limb, polynomial smooth-min only *between* limbs (no node bulges)
 *   - fillet k follows the child limb radius
 *   - narrow-band flood fill: work scales with surface area, not volume
 *   - vertices re-projected onto the SDF (Newton) so thin parts never shrink
 *   - quadric decimation with error weighted by 1/localRadius² and junction protection
 * Differences: uniform bucket grid culling (graph skeleton, not a handful of limbs),
 * UV (θ, arc length) + analytic normals emitted per vertex.
 */

const BIG = 1e3;

export class ChainSDF {
  /**
   * @param {import('./chains.js').Chain[]} chains
   * @param {{ fillet?: number, filletRatio?: number, pad?: number, bucketM?: number }} [o]
   */
  constructor(chains, o = {}) {
    const K = o.fillet ?? 0.12;
    const ratio = o.filletRatio ?? 1.2;
    const pad = o.pad ?? 0.1;
    const bucket = o.bucketM ?? 0.25;

    const segs = [];
    const segChain = [];
    const frames = []; // Na(3) Ba(3) Nb(3) Bb(3) + arc a,b
    this.chains = chains;
    this.k = new Float64Array(chains.length);
    this.chainSeg0 = new Int32Array(chains.length).fill(-1);
    this.chainSeg1 = new Int32Array(chains.length).fill(-1);

    let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
    for (const c of chains) {
      if (c.head < 2) continue;
      this.k[c.id] = c.parent < 0 ? 0 : Math.min(K, Math.max(0.006, c.r[0] * ratio));
      this.chainSeg0[c.id] = segs.length / 8;
      for (let i = 0; i < c.head - 1; i++) {
        segs.push(c.x[i], c.y[i], c.z[i], c.x[i + 1], c.y[i + 1], c.z[i + 1], c.r[i], c.r[i + 1]);
        segChain.push(c.id);
        frames.push(
          c.N[i * 3], c.N[i * 3 + 1], c.N[i * 3 + 2], c.B[i * 3], c.B[i * 3 + 1], c.B[i * 3 + 2],
          c.N[i * 3 + 3], c.N[i * 3 + 4], c.N[i * 3 + 5], c.B[i * 3 + 3], c.B[i * 3 + 4], c.B[i * 3 + 5],
          c.s[i], c.s[i + 1]
        );
        const r = Math.max(c.r[i], c.r[i + 1]) + this.k[c.id] + pad;
        mnx = Math.min(mnx, c.x[i] - r, c.x[i + 1] - r); mxx = Math.max(mxx, c.x[i] + r, c.x[i + 1] + r);
        mny = Math.min(mny, c.y[i] - r, c.y[i + 1] - r); mxy = Math.max(mxy, c.y[i] + r, c.y[i + 1] + r);
        mnz = Math.min(mnz, c.z[i] - r, c.z[i + 1] - r); mxz = Math.max(mxz, c.z[i] + r, c.z[i + 1] + r);
      }
      this.chainSeg1[c.id] = segs.length / 8;
    }
    this.S = Float64Array.from(segs);
    this.segChain = Int32Array.from(segChain);
    this.F = Float64Array.from(frames);
    this.nSeg = segChain.length;
    this.g = new Float64Array(3);
    this.rad = 0;
    this.hitSeg = -1;
    this.hitT = 0;
    this.empty = this.nSeg === 0;
    if (this.empty) return;

    // dense bucket grid: per-bucket list of segment ids (ascending → chains contiguous)
    this.bs = bucket;
    this.inv = 1 / bucket;
    this.ox = mnx; this.oy = mny; this.oz = mnz;
    const nx = (this.nx = Math.max(1, Math.ceil((mxx - mnx) * this.inv)));
    const ny = (this.ny = Math.max(1, Math.ceil((mxy - mny) * this.inv)));
    const nz = (this.nz = Math.max(1, Math.ceil((mxz - mnz) * this.inv)));
    const cells = nx * ny * nz;
    const counts = new Int32Array(cells + 1);
    const S = this.S;
    const span = (s) => {
      const o8 = s * 8, ch = this.segChain[s];
      const r = Math.max(S[o8 + 6], S[o8 + 7]) + this.k[ch] + pad;
      const lo = (a, b, off) => Math.max(0, Math.floor((Math.min(a, b) - r - off) * this.inv));
      const hi = (a, b, off, n) => Math.min(n - 1, Math.floor((Math.max(a, b) + r - off) * this.inv));
      return [
        lo(S[o8], S[o8 + 3], this.ox), hi(S[o8], S[o8 + 3], this.ox, nx),
        lo(S[o8 + 1], S[o8 + 4], this.oy), hi(S[o8 + 1], S[o8 + 4], this.oy, ny),
        lo(S[o8 + 2], S[o8 + 5], this.oz), hi(S[o8 + 2], S[o8 + 5], this.oz, nz)
      ];
    };
    for (let s = 0; s < this.nSeg; s++) {
      const [x0, x1, y0, y1, z0, z1] = span(s);
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[x + nx * (y + ny * z) + 1]++;
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.bStart = counts;
    this.items = new Int32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let s = 0; s < this.nSeg; s++) {
      const [x0, x1, y0, y1, z0, z1] = span(s);
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.items[fill[x + nx * (y + ny * z)]++] = s;
    }
  }

  /** Signed distance (negative inside). With wg: this.g = ∇, this.rad = local radius, this.hitSeg/hitT = nearest limb segment. */
  eval(x, y, z, wg) {
    const g = this.g;
    if (this.empty) { g[0] = g[1] = g[2] = 0; this.rad = 0; return BIG; }
    const ix = Math.floor((x - this.ox) * this.inv), iy = Math.floor((y - this.oy) * this.inv), iz = Math.floor((z - this.oz) * this.inv);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) { g[0] = g[1] = g[2] = 0; this.rad = 0; return BIG; }
    const cell = ix + this.nx * (iy + this.ny * iz);
    const a = this.bStart[cell], b = this.bStart[cell + 1];
    if (a === b) { g[0] = g[1] = g[2] = 0; this.rad = 0; return BIG; }

    const S = this.S, items = this.items, segChain = this.segChain;
    let d = 1e9, gx = 0, gy = 0, gz = 0, rd = 0, first = true;
    let curCh = -1, best = 1e9, bi = -1, hitBest = 1e9, hitSeg = -1, hitT = 0;

    for (let it = a; it <= b; it++) {
      let ch = -2, s = -1;
      if (it < b) { s = items[it]; ch = segChain[s]; }
      if (ch !== curCh) {
        if (curCh >= 0) {
          let lx = 0, ly = 0, lz = 0, lr = 0, th = 0;
          {
            const o = bi * 8, ax = S[o], ay = S[o + 1], az = S[o + 2], bx = S[o + 3] - ax, by = S[o + 4] - ay, bz = S[o + 5] - az;
            const px = x - ax, py = y - ay, pz = z - az;
            const l2 = bx * bx + by * by + bz * bz;
            const hr = l2 > 1e-12 ? (px * bx + py * by + pz * bz) / l2 : 0, h = hr < 0 ? 0 : hr > 1 ? 1 : hr;
            th = h;
            if (wg) {
              const ex = px - bx * h, ey = py - by * h, ez = pz - bz * h;
              const dist = Math.sqrt(ex * ex + ey * ey + ez * ez), inv = dist > 1e-9 ? 1 / dist : 0, dr = S[o + 7] - S[o + 6];
              lx = ex * inv; ly = ey * inv; lz = ez * inv;
              if (hr > 0 && hr < 1) { const t = dr / l2; lx -= t * bx; ly -= t * by; lz -= t * bz; }
              lr = S[o + 6] + dr * h;
            }
          }
          if (best < hitBest) { hitBest = best; hitSeg = bi; hitT = th; }
          const k = this.k[curCh], diff = best - d;
          if (first) { d = best; gx = lx; gy = ly; gz = lz; rd = lr; first = false; }
          else if (k <= 1e-9) {
            if (diff < 0) { d = best; gx = lx; gy = ly; gz = lz; rd = lr; }
          } else if (diff >= k) { /* far */ }
          else if (diff <= -k) { d = best; gx = lx; gy = ly; gz = lz; rd = lr; }
          else {
            const h = (k - Math.abs(diff)) / k, wn = diff < 0 ? 1 - h * 0.5 : h * 0.5, wo = 1 - wn;
            d = Math.min(d, best) - h * h * k * 0.25;
            gx = wo * gx + wn * lx; gy = wo * gy + wn * ly; gz = wo * gz + wn * lz; rd = wo * rd + wn * lr;
          }
        }
        curCh = ch; best = 1e9; bi = -1;
        if (it === b) break;
      }
      const o = s * 8, ax = S[o], ay = S[o + 1], az = S[o + 2], bx = S[o + 3] - ax, by = S[o + 4] - ay, bz = S[o + 5] - az;
      const px = x - ax, py = y - ay, pz = z - az;
      const l2 = bx * bx + by * by + bz * bz;
      let h = l2 > 1e-12 ? (px * bx + py * by + pz * bz) / l2 : 0;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      const ex = px - bx * h, ey = py - by * h, ez = pz - bz * h;
      const v = Math.sqrt(ex * ex + ey * ey + ez * ez) - (S[o + 6] + (S[o + 7] - S[o + 6]) * h);
      if (v < best) { best = v; bi = s; }
    }
    g[0] = gx; g[1] = gy; g[2] = gz;
    this.rad = rd; this.hitSeg = hitSeg; this.hitT = hitT;
    return d;
  }

  /** Newton steps onto the zero set. */
  project(p, n) {
    for (let i = 0; i < n; i++) {
      const d = this.eval(p[0], p[1], p[2], true), g = this.g, gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (gg < 1e-10) break;
      const t = d / gg;
      p[0] -= t * g[0]; p[1] -= t * g[1]; p[2] -= t * g[2];
    }
  }

  /** (u,v) = (θ/2π, arc length) from the nearest limb segment — call right after eval(…, true). */
  uvAt(x, y, z, out) {
    const s = this.hitSeg;
    if (s < 0) { out[0] = 0; out[1] = 0; return; }
    const o = s * 8, S = this.S, F = this.F, f = s * 14, t = this.hitT;
    const cx = S[o] + (S[o + 3] - S[o]) * t, cy = S[o + 1] + (S[o + 4] - S[o + 1]) * t, cz = S[o + 2] + (S[o + 5] - S[o + 2]) * t;
    const qx = x - cx, qy = y - cy, qz = z - cz;
    const nx = F[f] + (F[f + 6] - F[f]) * t, ny = F[f + 1] + (F[f + 7] - F[f + 1]) * t, nz = F[f + 2] + (F[f + 8] - F[f + 2]) * t;
    const bx = F[f + 3] + (F[f + 9] - F[f + 3]) * t, by = F[f + 4] + (F[f + 10] - F[f + 4]) * t, bz = F[f + 5] + (F[f + 11] - F[f + 5]) * t;
    let th = Math.atan2(qx * nx + qy * ny + qz * nz, qx * bx + qy * by + qz * bz);
    if (th < 0) th += Math.PI * 2;
    out[0] = th / (Math.PI * 2);
    out[1] = F[f + 12] + (F[f + 13] - F[f + 12]) * t;
  }
}

// Open-addressing hash on integer lattice keys — no strings, no per-lookup allocation.
class GMap {
  constructor() { this.c = 1 << 14; this.n = 0; this.alloc(); }
  alloc() {
    const c = this.c;
    this.kx = new Int32Array(c); this.ky = new Int32Array(c); this.kz = new Int32Array(c);
    this.u = new Uint8Array(c); this.v = new Float32Array(c);
  }
  slot(x, y, z) {
    const m = this.c - 1;
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & m;
    while (this.u[h]) { if (this.kx[h] === x && this.ky[h] === y && this.kz[h] === z) return h; h = (h + 1) & m; }
    return -1 - h;
  }
  set(x, y, z, val) {
    let s = this.slot(x, y, z);
    if (s >= 0) { this.v[s] = val; return; }
    if ((this.n + 1) * 2 > this.c) { this.grow(); s = this.slot(x, y, z); }
    s = -1 - s;
    this.kx[s] = x; this.ky[s] = y; this.kz[s] = z; this.u[s] = 1; this.v[s] = val; this.n++;
  }
  grow() {
    const ox = this.kx, oy = this.ky, oz = this.kz, ou = this.u, ov = this.v, oc = this.c;
    this.c *= 2; this.alloc(); this.n = 0;
    for (let i = 0; i < oc; i++) if (ou[i]) this.set(ox[i], oy[i], oz[i], ov[i]);
  }
}

/**
 * Narrow-band surface nets from tip seeds.
 * @param {ChainSDF} sdf
 * @param {import('./chains.js').Chain[]} chains
 * @param {number} cs cell size (m)
 */
export function buildSurface(sdf, chains, cs) {
  const corner = new GMap(), cells = new GMap(), V = new Float64Array(8), P = new Float64Array(3);
  const verts = [], ac = [], stack = [];
  const cv = (x, y, z) => {
    const s = corner.slot(x, y, z);
    if (s >= 0) return corner.v[s];
    const v = sdf.eval(x * cs, y * cs, z * cs, false);
    corner.set(x, y, z, v);
    return v;
  };
  const seed = (px, py, pz, dx, dy, dz) => {
    let t = 0;
    for (let i = 0; i < 2000 && sdf.eval(px + dx * t, py + dy * t, pz + dz * t, false) < 0; i++) t += cs * 0.5;
    const sx = Math.floor((px + dx * t) / cs), sy = Math.floor((py + dy * t) / cs), sz = Math.floor((pz + dz * t) / cs);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) stack.push(sx + a, sy + b, sz + c);
  };
  for (const c of chains) {
    if (c.head < 2) continue;
    const i = c.head - 1;
    seed(c.x[i], c.y[i], c.z[i], c.T[i * 3], c.T[i * 3 + 1], c.T[i * 3 + 2]);
    if (c.parent < 0) seed(c.x[0], c.y[0], c.z[0], 0, -1, 0);
  }
  while (stack.length) {
    const cz = stack.pop(), cy = stack.pop(), cx = stack.pop();
    if (cells.slot(cx, cy, cz) >= 0) continue;
    let ins = 0, out = 0;
    for (let c = 0; c < 8; c++) {
      const v = cv(cx + (c & 1), cy + ((c >> 1) & 1), cz + (c >> 2));
      V[c] = v;
      if (v <= 0) ins = 1; else out = 1;
    }
    if (!(ins && out)) { cells.set(cx, cy, cz, -1); continue; }
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let c = 0; c < 8; c++) for (let b = 0; b < 3; b++) {
      if (c & (1 << b)) continue;
      const a = V[c], e = V[c | (1 << b)];
      if ((a <= 0) === (e <= 0)) continue;
      const t = a / (a - e);
      sx += (cx + (c & 1) + (b === 0 ? t : 0)) * cs;
      sy += (cy + ((c >> 1) & 1) + (b === 1 ? t : 0)) * cs;
      sz += (cz + (c >> 2) + (b === 2 ? t : 0)) * cs;
      n++;
    }
    P[0] = sx / n; P[1] = sy / n; P[2] = sz / n;
    sdf.project(P, 2);
    cells.set(cx, cy, cz, verts.length / 3);
    verts.push(P[0], P[1], P[2]);
    ac.push(cx, cy, cz);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++)
      if ((a | b | c) && cells.slot(cx + a, cy + b, cz + c) < 0) stack.push(cx + a, cy + b, cz + c);
  }

  const idx = [], OFF = [[-1, -1], [0, -1], [0, 0], [-1, 0]], q = [0, 0, 0, 0], cc = [0, 0, 0];
  const dist = (i, j) => Math.hypot(verts[i * 3] - verts[j * 3], verts[i * 3 + 1] - verts[j * 3 + 1], verts[i * 3 + 2] - verts[j * 3 + 2]);
  for (let i = 0; i < ac.length; i += 3) {
    const x = ac[i], y = ac[i + 1], z = ac[i + 2], v0 = cv(x, y, z);
    for (let ax = 0; ax < 3; ax++) {
      const v1 = cv(x + (ax === 0), y + (ax === 1), z + (ax === 2));
      if ((v0 <= 0) === (v1 <= 0)) continue;
      const u = ax === 0 ? 1 : 0, w = ax === 2 ? 1 : 2;
      let ok = true;
      for (let k = 0; k < 4; k++) {
        cc[0] = x; cc[1] = y; cc[2] = z; cc[u] += OFF[k][0]; cc[w] += OFF[k][1];
        const s = cells.slot(cc[0], cc[1], cc[2]), id = s >= 0 ? cells.v[s] : -1;
        if (id < 0) { ok = false; break; }
        q[k] = id;
      }
      if (!ok) continue;
      if ((v0 <= 0) === (ax === 1)) { const t = q[1]; q[1] = q[3]; q[3] = t; }
      if (dist(q[0], q[2]) <= dist(q[1], q[3])) idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
      else idx.push(q[1], q[2], q[3], q[1], q[3], q[0]);
    }
  }
  // outward winding (inside = negative SDF ⇒ signed volume must be positive)
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
      - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
      + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
  }
  if (vol < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  return { pos: Float64Array.from(verts), idx, cornerEvals: corner.n };
}

/** Tangential relaxation re-projected onto the SDF (thin tubes never shrink). */
export function relax(pos, idx, sdf, iters, lam) {
  const n = pos.length / 3, S = new Float64Array(n * 3), C = new Float64Array(n), P = new Float64Array(3);
  for (let it = 0; it < iters; it++) {
    S.fill(0); C.fill(0);
    for (let t = 0; t < idx.length; t += 3) for (let j = 0; j < 3; j++) {
      const a = idx[t + j], b = idx[t + (j + 1) % 3];
      for (let k = 0; k < 3; k++) { S[a * 3 + k] += pos[b * 3 + k]; S[b * 3 + k] += pos[a * 3 + k]; }
      C[a]++; C[b]++;
    }
    for (let v = 0; v < n; v++) {
      if (!C[v]) continue;
      for (let k = 0; k < 3; k++) P[k] = pos[v * 3 + k] + lam * (S[v * 3 + k] / C[v] - pos[v * 3 + k]);
      sdf.project(P, 1);
      pos[v * 3] = P[0]; pos[v * 3 + 1] = P[1]; pos[v * 3 + 2] = P[2];
    }
  }
}

/**
 * Quadric edge-collapse. Plane errors weighted 1/localRadius² (relative error: thick limbs go coarse,
 * thinner ones keep detail); junction neighbourhoods get extra weight. Link condition + normal-flip
 * test keep the mesh manifold; new vertices re-projected onto the SDF.
 */
export function decimate(pos, idx, sdf, K, o) {
  const nv = pos.length / 3, nf = idx.length / 3, P = pos, F = Int32Array.from(idx);
  const alive = new Uint8Array(nf).fill(1), dead = new Uint8Array(nv), ver = new Int32Array(nv);
  const vf = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nf; t++) for (let j = 0; j < 3; j++) vf[F[t * 3 + j]].push(t);
  const w = new Float64Array(nv), Q = new Float64Array(nv * 10), J = o.junctions || [], K2 = K * K * 2.25;
  for (let v = 0; v < nv; v++) {
    sdf.eval(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], true);
    const r = Math.max(sdf.rad, 0.01);
    let wt = 1 / (r * r);
    for (const j of J) {
      const dx = P[v * 3] - j[0], dy = P[v * 3 + 1] - j[1], dz = P[v * 3 + 2] - j[2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < K2 * 9) wt *= 1 + o.crotchPreservation * Math.exp(-d2 / K2);
    }
    w[v] = wt;
  }
  for (let t = 0; t < nf; t++) {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-14) continue;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2]), wf = (w[a] + w[b] + w[c]) / 3;
    const m = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const vi of [a, b, c]) for (let k = 0; k < 10; k++) Q[vi * 10 + k] += wf * m[k];
  }
  const qe = (a, b, x, y, z) => {
    const g = (k) => Q[a * 10 + k] + Q[b * 10 + k];
    return g(0) * x * x + 2 * g(1) * x * y + 2 * g(2) * x * z + 2 * g(3) * x + g(4) * y * y + 2 * g(5) * y * z + 2 * g(6) * y + g(7) * z * z + 2 * g(8) * z + g(9);
  };
  const ec = (u, v) => {
    const ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2], vx = P[v * 3], vy = P[v * 3 + 1], vz = P[v * 3 + 2];
    return Math.min(qe(u, v, ux, uy, uz), qe(u, v, vx, vy, vz), qe(u, v, (ux + vx) / 2, (uy + vy) / 2, (uz + vz) / 2));
  };
  const H = [];
  const push = (e) => {
    let i = H.length; H.push(e);
    while (i > 0) { const p = (i - 1) >> 1; if (H[p].c <= e.c) break; H[i] = H[p]; i = p; }
    H[i] = e;
  };
  const pop = () => {
    const top = H[0], last = H.pop();
    if (H.length) {
      let i = 0; const n = H.length;
      for (;;) {
        let l = 2 * i + 1; if (l >= n) break;
        if (l + 1 < n && H[l + 1].c < H[l].c) l++;
        if (H[l].c >= last.c) break;
        H[i] = H[l]; i = l;
      }
      H[i] = last;
    }
    return top;
  };
  const seen = new Set();
  for (let t = 0; t < nf; t++) for (let j = 0; j < 3; j++) {
    const a = F[t * 3 + j], b = F[t * 3 + (j + 1) % 3], lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv + hi;
    if (!seen.has(key)) { seen.add(key); push({ c: ec(lo, hi), u: lo, v: hi, su: 0, sv: 0 }); }
  }
  const nrm = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
  };
  const bad = (t, self, x, y, z, other) => {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
    if (a === other || b === other || c === other) return false;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const o1 = nrm(ax, ay, az, bx, by, bz, cx, cy, cz);
    const n1 = nrm(a === self ? x : ax, a === self ? y : ay, a === self ? z : az, b === self ? x : bx, b === self ? y : by, b === self ? z : bz, c === self ? x : cx, c === self ? y : cy, c === self ? z : cz);
    const lo = Math.hypot(o1[0], o1[1], o1[2]), ln = Math.hypot(n1[0], n1[1], n1[2]);
    return ln < 1e-12 || (o1[0] * n1[0] + o1[1] * n1[1] + o1[2] * n1[2]) < 0.25 * lo * ln;
  };
  let left = nf;
  const target = Math.floor(nf * (1 - o.decimateReduction)), maxC = o.relError * o.relError * 8, N = new Float64Array(3);
  while (H.length && left > target) {
    const e = pop(), u = e.u, v = e.v;
    if (dead[u] || dead[v] || ver[u] !== e.su || ver[v] !== e.sv) continue;
    if (e.c > maxC) break;
    const fu = (vf[u] = vf[u].filter((t) => alive[t])), fv = (vf[v] = vf[v].filter((t) => alive[t]));
    const nu = new Set(), nvs = new Set();
    let shared = 0;
    for (const t of fu) for (let j = 0; j < 3; j++) { const q = F[t * 3 + j]; if (q !== u) nu.add(q); }
    for (const t of fv) {
      let hu = false;
      for (let j = 0; j < 3; j++) { const q = F[t * 3 + j]; if (q === u) hu = true; else if (q !== v) nvs.add(q); }
      if (hu) shared++;
    }
    let common = 0;
    for (const q of nvs) if (nu.has(q)) common++;
    if (shared !== 2 || common !== 2) continue;
    const ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2], vx = P[v * 3], vy = P[v * 3 + 1], vz = P[v * 3 + 2];
    const c1 = qe(u, v, ux, uy, uz), c2 = qe(u, v, vx, vy, vz), mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2, c3 = qe(u, v, mx, my, mz);
    if (c3 <= c1 && c3 <= c2) { N[0] = mx; N[1] = my; N[2] = mz; sdf.project(N, 1); }
    else if (c1 <= c2) { N[0] = ux; N[1] = uy; N[2] = uz; } else { N[0] = vx; N[1] = vy; N[2] = vz; }
    let ok = true;
    for (const t of fu) if (bad(t, u, N[0], N[1], N[2], v)) { ok = false; break; }
    if (ok) for (const t of fv) if (bad(t, v, N[0], N[1], N[2], u)) { ok = false; break; }
    if (!ok) continue;
    P[u * 3] = N[0]; P[u * 3 + 1] = N[1]; P[u * 3 + 2] = N[2]; dead[v] = 1;
    for (const t of fv) {
      for (let j = 0; j < 3; j++) if (F[t * 3 + j] === v) F[t * 3 + j] = u;
      const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
      if (a === b || b === c || a === c) { alive[t] = 0; left--; } else vf[u].push(t);
    }
    for (let k = 0; k < 10; k++) Q[u * 10 + k] += Q[v * 10 + k];
    ver[u]++;
    const nb = new Set();
    for (const t of vf[u]) if (alive[t]) for (let j = 0; j < 3; j++) { const q = F[t * 3 + j]; if (q !== u) nb.add(q); }
    for (const q of nb) push({ c: ec(u, q), u, v: q, su: ver[u], sv: ver[q] });
  }
  const map = new Int32Array(nv).fill(-1), op = [], oi = [];
  for (let t = 0; t < nf; t++) if (alive[t]) for (let j = 0; j < 3; j++) {
    const q = F[t * 3 + j];
    if (map[q] < 0) { map[q] = op.length / 3; op.push(P[q * 3], P[q * 3 + 1], P[q * 3 + 2]); }
    oi.push(map[q]);
  }
  return { pos: Float64Array.from(op), idx: oi, collapsed: nf - left };
}
