/**
 * v1.1 bark mesher: closed filleted surface for thick wood + swept tubes for thin wood, one BufferGeometry.
 *
 *   skeleton ─► chains ─┬─ thick head ─► ChainSDF ─► surface nets ─► relax ─► QEM ─┐
 *                       └─ thin tail  ─► tube sweep ───────────────────────────────┴─► merged mesh
 *
 * Output contract matches bakeMarchingCubes(): { geometry, stats } with uv = (θ/2π, arc length m).
 * Index buffer order: [ bark surface | tubes ] (stats.barkIndexCount splits them for analysis).
 */

import * as THREE from 'three';
import { buildChains } from './chains.js';
import { ChainSDF, buildSurface, relax, decimate } from './surfaceNets.js';
import { buildTubes } from './tubeSweep.js';
import { createWoodSurface } from './woodSurface.js';

export const HYBRID_DEFAULTS = Object.freeze({
  /** surface-net cell (m). Thick domain starts at rCutScale × cell. */
  cellM: 0.04,
  rCutScale: 1.4,
  /** absolute floor for the thick domain radius (m) */
  rCutMin: 0.03,
  relaxSteps: 1,
  decimateReduction: 0.45,
  relError: 0.1,
  crotchPreservation: 3.5,
  fillet: 0.12,
  filletRatio: 1.2,
  minSides: 3,
  capTubeBase: false,
  /** true → every limb goes through the SDF (reference "surface nets only" mode, used by the benchmark) */
  sdfOnly: false
});

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Duplicate vertices of triangles that straddle the u=0/1 seam so texture coordinates stay continuous. */
function weldUvSeams(pos, nor, uv, idx) {
  const nv = pos.length / 3;
  const clone = new Int32Array(nv).fill(-1);
  const extraP = [], extraN = [], extraUv = [];
  let next = nv;
  const out = Uint32Array.from(idx);
  for (let t = 0; t < out.length; t += 3) {
    const a = out[t], b = out[t + 1], c = out[t + 2];
    const ua = uv[a * 2], ub = uv[b * 2], uc = uv[c * 2];
    if (Math.max(ua, ub, uc) - Math.min(ua, ub, uc) <= 0.5) continue;
    for (let j = 0; j < 3; j++) {
      const v = out[t + j];
      if (uv[v * 2] >= 0.5) continue;
      if (clone[v] < 0) {
        clone[v] = next++;
        extraP.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        extraN.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
        extraUv.push(uv[v * 2] + 1, uv[v * 2 + 1]);
      }
      out[t + j] = clone[v];
    }
  }
  if (next === nv) return { pos, nor, uv, idx: out, seamVerts: 0 };
  const P = new Float32Array(next * 3), Nn = new Float32Array(next * 3), U = new Float32Array(next * 2);
  P.set(pos); Nn.set(nor); U.set(uv);
  P.set(extraP, nv * 3); Nn.set(extraN, nv * 3); U.set(extraUv, nv * 2);
  return { pos: P, nor: Nn, uv: U, idx: out, seamVerts: next - nv };
}

/**
 * @param {import('./skeleton.js').Skeleton} skeleton
 * @param {object} [opts] see HYBRID_DEFAULTS
 * @returns {{ geometry: THREE.BufferGeometry, stats: object, chains: object[] }}
 */
export function bakeHybrid(skeleton, opts = {}) {
  const o = { ...HYBRID_DEFAULTS, ...opts };
  const t0 = now();
  const cs = o.cellM;
  const rCut = o.sdfOnly ? 0 : Math.max(o.rCutMin, o.rCutScale * cs);

  const { chains, edgeChain, edgeSeg } = buildChains(skeleton, { rCut });
  const tChains = now();

  // ── thick domain ──
  let barkPos = new Float32Array(0), barkNor = new Float32Array(0), barkUv = new Float32Array(0), barkIdx = new Uint32Array(0);
  const stats = {
    mesher: 'hybrid', voxelM: cs, cellM: cs, rCut,
    chains: chains.length,
    thickChains: 0, thinChains: 0,
    simplify: null
  };
  let sdf = null;
  let tSdf = tChains, tSurf = tChains, tRelax = tChains, tDec = tChains, tAttr = tChains;
  const thick = chains.filter((c) => c.head >= 2);
  stats.thickChains = thick.length;
  stats.thinChains = chains.length - thick.length;
  if (thick.length) {
    sdf = new ChainSDF(chains, { fillet: o.fillet, filletRatio: o.filletRatio, pad: cs * 2.5 });
    tSdf = now();
    let { pos, idx, cornerEvals } = buildSurface(sdf, chains, cs);
    tSurf = now();
    stats.surfaceVertsRaw = pos.length / 3;
    stats.surfaceTrisRaw = idx.length / 3;
    stats.sdfSamples = cornerEvals;
    if (o.relaxSteps > 0) relax(pos, idx, sdf, o.relaxSteps, 0.35);
    tRelax = now();
    if (o.decimateReduction > 0.02) {
      const junctions = [];
      for (const c of thick) if (c.parent >= 0) junctions.push([c.x[0], c.y[0], c.z[0]]);
      const r = decimate(pos, idx, sdf, Math.max(0.02, o.fillet), { ...o, junctions });
      pos = r.pos; idx = r.idx;
      stats.simplify = {
        trianglesBefore: stats.surfaceTrisRaw,
        trianglesAfter: idx.length / 3,
        reduction: 1 - idx.length / 3 / Math.max(1, stats.surfaceTrisRaw)
      };
    }
    tDec = now();

    const nv = pos.length / 3;
    barkPos = new Float32Array(nv * 3); barkNor = new Float32Array(nv * 3); barkUv = new Float32Array(nv * 2);
    const uvo = [0, 0];
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      sdf.eval(x, y, z, true);
      const g = sdf.g, l = Math.hypot(g[0], g[1], g[2]) || 1;
      barkNor[v * 3] = g[0] / l; barkNor[v * 3 + 1] = g[1] / l; barkNor[v * 3 + 2] = g[2] / l;
      barkPos[v * 3] = x; barkPos[v * 3 + 1] = y; barkPos[v * 3 + 2] = z;
      sdf.uvAt(x, y, z, uvo);
      barkUv[v * 2] = uvo[0]; barkUv[v * 2 + 1] = uvo[1];
    }
    const w = weldUvSeams(barkPos, barkNor, barkUv, Uint32Array.from(idx));
    barkPos = w.pos; barkNor = w.nor; barkUv = w.uv; barkIdx = w.idx;
    stats.seamVerts = w.seamVerts;
    tAttr = now();
  }

  // ── thin domain ──
  const tubeOpts = { minSides: o.minSides, capBase: o.capTubeBase };
  const tubes = o.sdfOnly
    ? { positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), stats: { rings: 0, tubeStarts: 0 } }
    : buildTubes(chains, tubeOpts);
  // Exact bark radius for blossom seats (CanopyInstancer reads skeleton.woodSurface)
  skeleton.woodSurface = createWoodSurface(chains, edgeChain, edgeSeg, tubeOpts);
  const tTube = now();

  // ── merge ──
  const nb = barkPos.length / 3, nt = tubes.positions.length / 3;
  const P = new Float32Array((nb + nt) * 3), N = new Float32Array((nb + nt) * 3), U = new Float32Array((nb + nt) * 2);
  P.set(barkPos); P.set(tubes.positions, nb * 3);
  N.set(barkNor); N.set(tubes.normals, nb * 3);
  U.set(barkUv); U.set(tubes.uvs, nb * 2);
  const I = new Uint32Array(barkIdx.length + tubes.indices.length);
  I.set(barkIdx);
  for (let i = 0; i < tubes.indices.length; i++) I[barkIdx.length + i] = tubes.indices[i] + nb;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  geometry.setIndex(new THREE.BufferAttribute(I, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bb = geometry.boundingBox;
  const t1 = now();

  Object.assign(stats, {
    vertices: P.length / 3,
    triangles: I.length / 3,
    barkVertices: nb,
    barkTriangles: barkIdx.length / 3,
    barkIndexCount: barkIdx.length,
    tubeVertices: nt,
    tubeTriangles: tubes.indices.length / 3,
    tubeRings: tubes.stats.rings,
    tubeStarts: tubes.stats.tubeStarts,
    msChains: tChains - t0,
    msSdf: tSdf - tChains,
    msSurface: tSurf - tSdf,
    msRelax: tRelax - tSurf,
    msDecimate: tDec - tRelax,
    msAttributes: tAttr - tDec,
    msTubes: tTube - tAttr,
    msMerge: t1 - tTube,
    msTotal: t1 - t0,
    boundsMinM: { x: bb.min.x, y: bb.min.y, z: bb.min.z },
    boundsMaxM: { x: bb.max.x, y: bb.max.y, z: bb.max.z }
  });
  return { geometry, stats, chains, sdf };
}
