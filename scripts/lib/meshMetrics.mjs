/**
 * Mesh quality metrics used to compare bark meshers on identical skeletons.
 * Pure typed-array code (no THREE needed except for expandInstanced).
 */
import * as THREE from 'three';

// ───────────────────────── topology ─────────────────────────
/**
 * Merge vertices that share a position (UV-seam duplicates, per-instance copies) so topology reflects
 * geometry, not texture cuts. Returns a remapped Uint32 index array.
 */
export function weldIndex(pos, idx, eps = 1e-5) {
  const inv = 1 / eps, map = new Map(), remap = new Int32Array(pos.length / 3);
  let next = 0;
  for (let v = 0; v < remap.length; v++) {
    const k = `${Math.round(pos[v * 3] * inv)},${Math.round(pos[v * 3 + 1] * inv)},${Math.round(pos[v * 3 + 2] * inv)}`;
    let id = map.get(k);
    if (id === undefined) { id = next++; map.set(k, id); }
    remap[v] = id;
  }
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = remap[idx[i]];
  return out;
}

/**
 * @param {ArrayLike<number>} idx
 * @param {number} i0 first index (multiple of 3)
 * @param {number} i1 end index
 */
export function topology(idx, i0 = 0, i1 = idx.length) {
  const edges = new Map(); // key → [count, dirSum]
  const used = new Set();
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(a) !== r) { const n = parent.get(a); parent.set(a, r); a = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const BIGN = 4294967296;
  let tris = 0, degenerate = 0;
  for (let t = i0; t < i1; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    tris++;
    for (const v of [a, b, c]) { if (!parent.has(v)) parent.set(v, v); used.add(v); }
    union(a, b); union(b, c);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const lo = Math.min(p, q), hi = Math.max(p, q), key = lo * BIGN + hi;
      let e = edges.get(key);
      if (!e) { e = [0, 0]; edges.set(key, e); }
      e[0]++; e[1] += p < q ? 1 : -1;
    }
  }
  let boundary = 0, nonManifold = 0, flipped = 0;
  for (const [c, d] of edges.values()) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
    else if (c === 2 && d !== 0) flipped++; // two faces traversing the edge the same way
  }
  const comps = new Set();
  for (const v of used) comps.add(find(v));
  const chi = used.size - edges.size + tris;
  return { tris, degenerate, verts: used.size, edges: edges.size, boundary, nonManifold, flipped, components: comps.size, euler: chi };
}

// ───────────────────────── triangle quality ─────────────────────────
export function triQuality(pos, idx, i0 = 0, i1 = idx.length) {
  let n = 0, sum = 0, thin = 0, worst = 180, maxAspect = 0, aspect10 = 0;
  for (let t = i0; t < i1; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ab = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    const bc = Math.hypot(pos[c] - pos[b], pos[c + 1] - pos[b + 1], pos[c + 2] - pos[b + 2]);
    const ca = Math.hypot(pos[a] - pos[c], pos[a + 1] - pos[c + 1], pos[a + 2] - pos[c + 2]);
    if (ab < 1e-9 || bc < 1e-9 || ca < 1e-9) continue;
    const ang = (x, y, z) => Math.acos(Math.max(-1, Math.min(1, (x * x + y * y - z * z) / (2 * x * y)))) * 180 / Math.PI;
    const A = ang(ab, ca, bc), B = ang(ab, bc, ca), mn = Math.min(A, B, 180 - A - B);
    n++; sum += mn; if (mn < 10) thin++; if (mn < worst) worst = mn;
    const asp = Math.max(ab, bc, ca) / Math.min(ab, bc, ca);
    if (asp > maxAspect) maxAspect = asp;
    if (asp > 10) aspect10++;
  }
  return { tris: n, meanMinAngle: n ? sum / n : 0, pctBelow10deg: n ? (100 * thin) / n : 0, worstMinAngle: worst, pctAspectOver10: n ? (100 * aspect10) / n : 0 };
}

/** Fraction of triangles whose geometric normal agrees with the average stored vertex normal. */
export function windingAgreement(pos, nor, idx, i0 = 0, i1 = idx.length) {
  let ok = 0, n = 0;
  for (let t = i0; t < i1; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = nor[a] + nor[b] + nor[c], ny = nor[a + 1] + nor[b + 1] + nor[c + 1], nz = nor[a + 2] + nor[b + 2] + nor[c + 2];
    n++;
    if (fx * nx + fy * ny + fz * nz > 0) ok++;
  }
  return n ? (100 * ok) / n : 0;
}

// ───────────────────────── distance to mesh ─────────────────────────
function closestPointOnTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(px - (ax + abx * v), py - (ay + aby * v), pz - (az + abz * v));
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(px - (ax + acx * w), py - (ay + acy * w), pz - (az + acz * w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + d5 - d6);
    return Math.hypot(px - (bx + (cx - bx) * w), py - (by + (cy - by) * w), pz - (bz + (cz - bz) * w));
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Math.hypot(px - (ax + abx * v + acx * w), py - (ay + aby * v + acy * w), pz - (az + abz * v + acz * w));
}

export function buildTriGrid(pos, idx, cell = 0.08) {
  const inv = 1 / cell, grid = new Map();
  const key = (x, y, z) => (x + 2048) + 4096 * ((y + 2048) + 4096 * (z + 2048));
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(pos[a + k], pos[b + k], pos[c + k]) * inv));
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(pos[a + k], pos[b + k], pos[c + k]) * inv));
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      const k = key(x, y, z);
      let l = grid.get(k);
      if (!l) { l = []; grid.set(k, l); }
      l.push(t);
    }
  }
  return { grid, inv, cell, pos, idx, key };
}

export function distToMesh(G, x, y, z, maxRing = 3) {
  const { grid, inv, pos, idx, key, cell } = G;
  const ix = Math.floor(x * inv), iy = Math.floor(y * inv), iz = Math.floor(z * inv);
  let best = Infinity;
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dz = -ring; dz <= ring; dz++) for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
      const l = grid.get(key(ix + dx, iy + dy, iz + dz));
      if (!l) continue;
      for (const t of l) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const d = closestPointOnTri(x, y, z, pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
        if (d < best) best = d;
      }
    }
    if (best <= ring * cell) break; // nothing in a farther ring can be closer
  }
  return best;
}

// ───────────────────────── analytic sampling ─────────────────────────
function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

export const RADIUS_CLASSES = Object.freeze([
  { name: 'tip ≤4mm', lo: 0, hi: 0.004 },
  { name: 'twig 4–14mm', lo: 0.004, hi: 0.014 },
  { name: 'shoot 14–50mm', lo: 0.014, hi: 0.05 },
  { name: 'limb >50mm', lo: 0.05, hi: 9 }
]);

/** Points on the analytic skeleton surface (visible ones only), grouped by radius class. */
export function sampleSkeletonSurface(skeleton, perClass = 700, seed = 7, model = 'capsule') {
  // 'capsule' = literal skeleton edge (ra→rb, v1.0 intent); 'wood' = side limbs start at their own radius (v1.1 intent)
  const A = (e) => (model === 'wood' ? e.raWood : e.ra);
  const R = rng(seed), edges = skeleton.edges;
  const out = RADIUS_CLASSES.map((c) => ({ ...c, pts: [] }));
  const buckets = RADIUS_CLASSES.map(() => []);
  edges.forEach((e, i) => {
    const r = (A(e) + e.rb) / 2;
    const k = RADIUS_CLASSES.findIndex((c) => r > c.lo && r <= c.hi);
    if (k >= 0 && !e.isRoot) buckets[k].push(i);
  });
  // spatial hash of edges for the occlusion test
  const cell = 0.5, inv = 1 / cell, H = new Map();
  const hk = (x, y, z) => x * 73856093 ^ y * 19349663 ^ z * 83492791;
  edges.forEach((e, i) => {
    const r = Math.max(e.ra, e.rb);
    const lo = [Math.min(e.pa.x, e.pb.x) - r, Math.min(e.pa.y, e.pb.y) - r, Math.min(e.pa.z, e.pb.z) - r].map((v) => Math.floor(v * inv));
    const hi = [Math.max(e.pa.x, e.pb.x) + r, Math.max(e.pa.y, e.pb.y) + r, Math.max(e.pa.z, e.pb.z) + r].map((v) => Math.floor(v * inv));
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      const k = hk(x, y, z); let l = H.get(k); if (!l) { l = []; H.set(k, l); } l.push(i);
    }
  });
  const capDist = (px, py, pz, e) => {
    const bx = e.pb.x - e.pa.x, by = e.pb.y - e.pa.y, bz = e.pb.z - e.pa.z, qx = px - e.pa.x, qy = py - e.pa.y, qz = pz - e.pa.z;
    const l2 = bx * bx + by * by + bz * bz;
    let h = l2 > 1e-12 ? (qx * bx + qy * by + qz * bz) / l2 : 0; h = h < 0 ? 0 : h > 1 ? 1 : h;
    return Math.hypot(qx - bx * h, qy - by * h, qz - bz * h) - (A(e) + (e.rb - A(e)) * h);
  };
  for (let k = 0; k < out.length; k++) {
    const pool = buckets[k];
    let tries = 0;
    while (out[k].pts.length < perClass && pool.length && tries++ < perClass * 12) {
      const i = pool[Math.floor(R() * pool.length)], e = edges[i];
      const t = 0.25 + R() * 0.5, th = R() * Math.PI * 2;
      const r = A(e) + (e.rb - A(e)) * t;
      const cx = e.pa.x + (e.pb.x - e.pa.x) * t, cy = e.pa.y + (e.pb.y - e.pa.y) * t, cz = e.pa.z + (e.pb.z - e.pa.z) * t;
      // basis ⟂ this edge (the stored node frame belongs to the parent edge and is NOT perpendicular on forks)
      let dx = e.pb.x - e.pa.x, dy = e.pb.y - e.pa.y, dz = e.pb.z - e.pa.z;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      let ux = e.Na.x, uy = e.Na.y, uz = e.Na.z;
      const dd = ux * dx + uy * dy + uz * dz; ux -= dd * dx; uy -= dd * dy; uz -= dd * dz;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-6) { ux = Math.abs(dy) < 0.9 ? 0 : 1; uy = Math.abs(dy) < 0.9 ? 1 : 0; uz = 0; const d2 = ux * dx + uy * dy + uz * dz; ux -= d2 * dx; uy -= d2 * dy; uz -= d2 * dz; ul = Math.hypot(ux, uy, uz); }
      ux /= ul; uy /= ul; uz /= ul;
      const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
      const px = cx + r * (Math.cos(th) * ux + Math.sin(th) * vx);
      const py = cy + r * (Math.cos(th) * uy + Math.sin(th) * vy);
      const pz = cz + r * (Math.cos(th) * uz + Math.sin(th) * vz);
      // visible only if no other limb swallows it
      const l = H.get(hk(Math.floor(px * inv), Math.floor(py * inv), Math.floor(pz * inv)));
      let hidden = false;
      if (l) for (const j of l) if (j !== i && capDist(px, py, pz, edges[j]) < -0.04 * r - 0.0004) { hidden = true; break; }
      if (!hidden) out[k].pts.push([px, py, pz, r]);
    }
  }
  return out;
}

export function pctile(arr, p) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

/** Distance from analytic-surface samples to the mesh, normalised by sample radius. */
export function coverage(G, classes) {
  return classes.map((c) => {
    const errs = c.pts.map(([x, y, z, r]) => distToMesh(G, x, y, z) / r);
    const abs = c.pts.map(([x, y, z]) => distToMesh(G, x, y, z));
    return {
      class: c.name,
      samples: c.pts.length,
      p50: pctile(errs, 50), p95: pctile(errs, 95),
      missPct: errs.length ? (100 * errs.filter((e) => !(e < 0.6)).length) / errs.length : NaN,
      absMeanMm: abs.length ? (1000 * abs.reduce((s, v) => s + (isFinite(v) ? v : 0.3), 0)) / abs.length : NaN
    };
  });
}

// ───────────────────────── helpers ─────────────────────────
/** Bake an InstancedMesh into plain geometry (so the old proxy tubes can be measured like everything else). */
export function expandInstanced(inst) {
  const g = inst.geometry, src = g.index ? g : g.toNonIndexed();
  const pa = g.attributes.position, na = g.attributes.normal, ia = g.index;
  const n = inst.count, nv = pa.count, ni = ia ? ia.count : 0;
  const P = new Float32Array(n * nv * 3), N = new Float32Array(n * nv * 3), I = new Uint32Array(n * ni);
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    inst.getMatrixAt(i, m);
    nm.getNormalMatrix(m);
    for (let k = 0; k < nv; k++) {
      v.fromBufferAttribute(pa, k).applyMatrix4(m);
      P.set([v.x, v.y, v.z], (i * nv + k) * 3);
      v.fromBufferAttribute(na, k).applyMatrix3(nm).normalize();
      N.set([v.x, v.y, v.z], (i * nv + k) * 3);
    }
    for (let k = 0; k < ni; k++) I[i * ni + k] = ia.getX(k) + i * nv;
  }
  void src;
  return { pos: P, nor: N, idx: I };
}

export function concatMesh(a, b) {
  const nv = a.pos.length / 3;
  const pos = new Float32Array(a.pos.length + b.pos.length), nor = new Float32Array(a.nor.length + b.nor.length);
  pos.set(a.pos); pos.set(b.pos, a.pos.length); nor.set(a.nor); nor.set(b.nor, a.nor.length);
  const idx = new Uint32Array(a.idx.length + b.idx.length);
  idx.set(a.idx);
  for (let i = 0; i < b.idx.length; i++) idx[a.idx.length + i] = b.idx[i] + nv;
  return { pos, nor, idx, barkIndexCount: a.idx.length };
}
