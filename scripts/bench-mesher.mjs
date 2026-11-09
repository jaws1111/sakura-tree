/**
 * Bark mesher comparison on the SAME skeleton:
 *   v1.0      marching cubes (thick) + instanced 4-gon proxy cylinders (thin)  ← shipped pipeline
 *   sdf-only  reference branch_mesher recipe (surface nets everywhere, quad-budget cell)
 *   hybrid    v1.1 surface nets (thick) + swept tubes (thin), several settings
 *
 * Usage: node scripts/bench-mesher.mjs [--variants v1.0,sdf-only,hybrid-60,hybrid-40,hybrid-30]
 *                                       [--attractors 700] [--iters 160] [--dens 1.5] [--samples 700]
 *                                       [--canopy 12000] [--json out.json]
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSpaceColonizationSkeleton } from '../src/tree/skeleton.js';
import { bakeMarchingCubes } from '../src/tree/mesher.js';
import { buildTwigProxyGroup } from '../src/tree/twigProxy.js';
import { bakeHybrid } from '../src/tree/hybridMesher.js';
import { CanopyInstancer } from '../src/petals/CanopyInstancer.js';
import {
  topology, weldIndex, triQuality, windingAgreement, buildTriGrid, distToMesh,
  sampleSkeletonSurface, coverage, pctile, expandInstanced, concatMesh
} from './lib/meshMetrics.mjs';

function arg(name, fb) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return v == null ? true : Number.isFinite(Number(v)) ? Number(v) : v;
}
const variants = String(arg('variants', 'v1.0,sdf-only,hybrid-60,hybrid-40,hybrid-30')).split(',');
const attractors = arg('attractors', 700);
const iters = arg('iters', 160);
const dens = arg('dens', 1.5);
const perClass = arg('samples', 700);
const canopyN = arg('canopy', 12000);
const jsonOut = arg('json', null);

const skParams = {
  seed: 42, attractorCount: attractors, maxIterations: iters,
  rootAttractorCount: Math.floor(attractors * 0.45), maxRootIterations: Math.floor(iters * 0.65),
  twigDensity: dens, twigBranchMult: 2, forkYM: 1.1
};
console.log('skeleton params', skParams);
const t0 = performance.now();
const skeleton = buildSpaceColonizationSkeleton(skParams);
console.log(`skeleton: ${skeleton.nodes.length} nodes / ${skeleton.edges.length} edges in ${(performance.now() - t0).toFixed(0)} ms`);

let woodArea = 0;
for (const e of skeleton.edges) woodArea += Math.PI * (e.ra + e.rb) * Math.hypot(e.pb.x - e.pa.x, e.pb.y - e.pa.y, e.pb.z - e.pa.z);
console.log(`analytic wood surface area ≈ ${woodArea.toFixed(1)} m²`);

// Each mesher is judged against the wood model it intends to reproduce.
const classesByModel = {
  capsule: sampleSkeletonSurface(skeleton, perClass, 7, 'capsule'),
  wood: sampleSkeletonSurface(skeleton, perClass, 7, 'wood')
};
console.log('coverage samples (capsule)', classesByModel.capsule.map((c) => `${c.name}:${c.pts.length}`).join('  '));
console.log('coverage samples (wood)   ', classesByModel.wood.map((c) => `${c.name}:${c.pts.length}`).join('  '));

// Canopy seats are re-placed per variant: v1.1 seats come from the exact bark probe, v1.0 from r + 3 mm.
const canopy = new CanopyInstancer(new THREE.Scene(), { count: canopyN });
function seatsFor(variant) {
  if (variant === 'v1.0') delete skeleton.woodSurface;
  canopy.rebindToSkeleton(skeleton);
  return canopy.attachPoints.slice();
}

/** @returns {{pos:Float32Array,nor:Float32Array,idx:Uint32Array,barkIndexCount:number,ms:number,extra:object}} */
function build(name) {
  if (name === 'v1.0') {
    const voxelM = 0.065;
    const t = performance.now();
    const mc = bakeMarchingCubes(skeleton, { voxelM, simplifyCellScale: 1.15, nearestK: 12 });
    const proxy = buildTwigProxyGroup(skeleton, voxelM);
    const ms = performance.now() - t;
    const g = mc.geometry;
    const bark = { pos: g.attributes.position.array, nor: g.attributes.normal.array, idx: g.index.array };
    const tw = proxy ? expandInstanced(proxy.children[0]) : { pos: new Float32Array(0), nor: new Float32Array(0), idx: new Uint32Array(0) };
    const m = concatMesh(bark, tw);
    return { ...m, ms, extra: { barkTris: bark.idx.length / 3, proxyInstances: proxy?.userData?.twigCount ?? 0, drawCalls: 2 } };
  }
  const opts = { sdfOnly: false };
  if (name === 'sdf-only') {
    // reference recipe: cell follows the quad budget (140k quads), twig-aware cell is impossible at this scale
    opts.sdfOnly = true;
    opts.cellM = Math.min(0.2, Math.max(0.012, Math.sqrt(woodArea / 140000)));
    opts.decimateReduction = 0.7;
  } else {
    const mm = Number(name.split('-')[1]);
    opts.cellM = mm / 1000;
    if (name.includes('-nodec')) opts.decimateReduction = 0;
    if (name.includes('-cap')) opts.capTubeBase = true; // close tube bases so shell closure can be verified
  }
  const t = performance.now();
  const r = bakeHybrid(skeleton, opts);
  const ms = performance.now() - t;
  const g = r.geometry;
  return {
    pos: g.attributes.position.array, nor: g.attributes.normal.array, idx: g.index.array,
    barkIndexCount: r.stats.barkIndexCount, ms,
    extra: { stats: r.stats, drawCalls: 1 }
  };
}

const rows = [], details = {};
for (const v of variants) {
  process.stdout.write(`\n▶ ${v} … `);
  let b;
  try { b = build(v); } catch (e) { console.log('FAILED', e); continue; }
  console.log(`${b.ms.toFixed(0)} ms, ${(b.idx.length / 3).toLocaleString()} tris`);
  const widx = weldIndex(b.pos, b.idx);
  const bark = topology(widx, 0, b.barkIndexCount);
  const tube = topology(widx, b.barkIndexCount, b.idx.length);
  const q = triQuality(b.pos, b.idx, 0, b.barkIndexCount);
  const wind = windingAgreement(b.pos, b.nor, b.idx);
  const G = buildTriGrid(b.pos, b.idx);
  const cov = coverage(G, classesByModel[v === 'v1.0' ? 'capsule' : 'wood']);
  const seats = seatsFor(v);
  const gaps = [];
  for (let i = 0; i < seats.length; i += 3) gaps.push(distToMesh(G, seats[i], seats[i + 1], seats[i + 2], 4) * 1000);
  const finite = gaps.filter(isFinite);
  const seat = {
    p50: pctile(finite, 50), p95: pctile(finite, 95),
    over2mmPct: (100 * gaps.filter((g) => !(g <= 2)).length) / gaps.length,
    over4mmPct: (100 * gaps.filter((g) => !(g <= 4)).length) / gaps.length
  };
  const row = {
    variant: v, ms: +b.ms.toFixed(0), tris: b.idx.length / 3, verts: b.pos.length / 3,
    barkTris: bark.tris, tubeTris: tube.tris,
    barkOpenEdges: bark.boundary, barkNonManifold: bark.nonManifold, barkFlipped: bark.flipped, barkShells: bark.components, barkEuler: bark.euler,
    tubeShells: tube.components, windingOkPct: +wind.toFixed(1),
    barkMeanMinAngle: +q.meanMinAngle.toFixed(1), barkPctBelow10: +q.pctBelow10deg.toFixed(1),
    seatGapP50mm: +seat.p50.toFixed(2), seatGapP95mm: +seat.p95.toFixed(2), seatOver2mmPct: +seat.over2mmPct.toFixed(1), seatOver4mmPct: +seat.over4mmPct.toFixed(1)
  };
  rows.push(row);
  details[v] = { row, coverage: cov, extra: b.extra };
  console.log('  topology bark:', bark, '\n  topology tubes/proxy:', { tris: tube.tris, boundary: tube.boundary, nonManifold: tube.nonManifold, shells: tube.components });
  console.log('  coverage (error/r; miss = >0.6 r from mesh):');
  console.table(cov.map((c) => ({ class: c.class, n: c.samples, p50: +c.p50.toFixed(3), p95: +c.p95.toFixed(3), 'miss %': +c.missPct.toFixed(1), 'mean mm': +c.absMeanMm.toFixed(2) })));
  if (b.extra.stats) {
    const s = b.extra.stats;
    console.log('  stages ms:', Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('ms')).map(([k, x]) => [k, +x.toFixed(0)])));
    console.log('  hybrid:', { cellM: s.cellM, rCut: s.rCut, thickChains: s.thickChains, thinChains: s.thinChains, rawTris: s.surfaceTrisRaw, sdfSamples: s.sdfSamples, seamVerts: s.seamVerts, tubeStarts: s.tubeStarts });
  }
}

console.log('\n=== summary ===');
console.table(rows);
const covTable = [];
for (const v of Object.keys(details)) for (const c of details[v].coverage) covTable.push({ variant: v, class: c.class, 'miss %': +c.missPct.toFixed(1), p95: +c.p95.toFixed(2) });
console.table(covTable);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ skParams, rows, details }, null, 2));
