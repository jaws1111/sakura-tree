/**
 * Regression gate for the v1.1 hybrid bark mesher (pure Node, ~15 s).
 *   npm run test:mesh
 * Exit code 1 if any invariant fails. Thresholds come from the v1.0-vs-v1.1 benchmark
 * (doc/mesher_v1.1_review.md); loosen only with a new benchmark run.
 */
import * as THREE from 'three';
import { buildSpaceColonizationSkeleton } from '../src/tree/skeleton.js';
import { bakeHybrid } from '../src/tree/hybridMesher.js';
import { CanopyInstancer } from '../src/petals/CanopyInstancer.js';
import {
  topology, weldIndex, windingAgreement, buildTriGrid, distToMesh,
  sampleSkeletonSurface, coverage, pctile
} from './lib/meshMetrics.mjs';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

const skeleton = buildSpaceColonizationSkeleton({
  seed: 7, attractorCount: 450, maxIterations: 110, rootAttractorCount: 200,
  maxRootIterations: 70, twigDensity: 1.2, twigBranchMult: 2, forkYM: 1.1
});

for (const cellM of [0.05, 0.035]) {
  console.log(`\n── hybrid cell ${cellM} m ──`);
  const r = bakeHybrid(skeleton, { cellM, capTubeBase: true });
  const g = r.geometry, pos = g.attributes.position.array, nor = g.attributes.normal.array, uv = g.attributes.uv.array, idx = g.index.array;
  const s = r.stats;

  check('finite attributes', [pos, nor, uv].every((a) => a.every(Number.isFinite)));
  check('indices in range', idx.every((i) => i < pos.length / 3));
  check('uv.v is arc length (finite, bounded)', uv.every((v, i) => (i % 2 === 0 ? v > -0.01 && v < 1.6 : Math.abs(v) < 60)));

  const widx = weldIndex(pos, idx);
  const bark = topology(widx, 0, s.barkIndexCount);
  check('thick surface is ONE shell', bark.components === 1, `shells=${bark.components}`);
  check('thick surface is closed (no open edges)', bark.boundary === 0, `open=${bark.boundary}`);
  check('thick surface sphere topology (χ=2)', bark.euler === 2, `χ=${bark.euler}`);
  check('thick surface consistently oriented', bark.flipped === 0, `flipped=${bark.flipped}`);
  check('non-manifold edges stay rare', bark.nonManifold <= Math.max(40, bark.tris * 0.002), `nm=${bark.nonManifold}/${bark.tris} tris`);
  const tube = topology(widx, s.barkIndexCount, idx.length);
  check('capped tubes are closed', tube.boundary === 0, `open=${tube.boundary}`);
  check('winding agrees with normals ≥ 99%', windingAgreement(pos, nor, idx) >= 99, `${windingAgreement(pos, nor, idx).toFixed(1)}%`);
  check('single draw call geometry', Boolean(g.index) && !('instanceMatrix' in g.attributes));

  const G = buildTriGrid(pos, idx);
  const cov = coverage(G, sampleSkeletonSurface(skeleton, 300, 3, 'wood'));
  for (const c of cov) {
    const lim = c.class.startsWith('tip') ? 2 : 1;
    check(`coverage ${c.class}: miss ≤ ${lim}%`, c.missPct <= lim, `miss=${c.missPct.toFixed(1)}% p95=${c.p95.toFixed(2)}r`);
  }

  const canopy = new CanopyInstancer(new THREE.Scene(), { count: 6000 });
  canopy.rebindToSkeleton(skeleton); // skeleton.woodSurface set by bakeHybrid
  const seats = canopy.attachPoints, gaps = [];
  for (let i = 0; i < seats.length; i += 3) gaps.push(distToMesh(G, seats[i], seats[i + 1], seats[i + 2], 4) * 1000);
  const p50 = pctile(gaps, 50), p95 = pctile(gaps, 95);
  check('blossom seat gap p50 ≤ 0.8 mm', p50 <= 0.8, `p50=${p50.toFixed(2)} mm`);
  check('blossom seat gap p95 ≤ 2 mm', p95 <= 2, `p95=${p95.toFixed(2)} mm`);
}

// Reference-recipe failure mode must stay documented: surface nets alone cannot hold thin wood.
{
  console.log('\n── reference recipe (sdfOnly) must lose thin wood — proves why the hybrid exists ──');
  const r = bakeHybrid(skeleton, { sdfOnly: true, cellM: 0.032, decimateReduction: 0.5 });
  const g = r.geometry;
  const G = buildTriGrid(g.attributes.position.array, g.index.array);
  const cov = coverage(G, sampleSkeletonSurface(skeleton, 150, 3, 'wood'));
  const tip = cov.find((c) => c.class.startsWith('tip'));
  check('sdfOnly misses most 3 mm tips (expected)', tip.missPct > 50, `miss=${tip.missPct.toFixed(0)}%`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
