/**
 * End-to-end tree refresh timing (skeleton → MC → twig proxy → canopy).
 * Usage: node scripts/bench-rebuild.mjs
 *        node scripts/bench-rebuild.mjs --dens 3 --branch 4 --canopy 25000
 */
import * as THREE from 'three';
import { buildSpaceColonizationSkeleton } from '../src/tree/skeleton.js';
import { bakeMarchingCubes } from '../src/tree/mesher.js';
import { buildTwigProxyGroup } from '../src/tree/twigProxy.js';
import { CanopyInstancer } from '../src/petals/CanopyInstancer.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v == null ? true : Number.isFinite(Number(v)) ? Number(v) : v;
}

// Also accept: node scripts/bench-rebuild.mjs <dens> <branch> <canopy>
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--') && Number.isFinite(Number(a)));

function ms(t0) {
  return performance.now() - t0;
}

function pct(n, d) {
  return d > 0 ? ((100 * n) / d).toFixed(1) + '%' : '—';
}

const dens = arg('dens', pos[0] != null ? Number(pos[0]) : 1.5);
const branch = arg('branch', pos[1] != null ? Number(pos[1]) : 2);
const canopyN = arg('canopy', pos[2] != null ? Number(pos[2]) : 25000);
const voxelM = arg('voxel', 0.065);
const attractors = arg('attractors', 700);
const iters = arg('iters', 160);
const size = arg('size', 1);

const bakeParams = {
  seed: 42,
  attractorCount: attractors,
  maxIterations: iters,
  rootAttractorCount: Math.floor(attractors * 0.45),
  maxRootIterations: Math.floor(iters * 0.65),
  twigDensity: dens,
  twigBranchMult: branch,
  forkYM: 1.1,
  voxelM
};

console.log('=== sakura rebuild bench ===');
console.log('params', bakeParams, { canopyN, size });

const tAll = performance.now();

let t = performance.now();
const skeleton = buildSpaceColonizationSkeleton(bakeParams);
const skMs = ms(t);
console.log('1 skeleton', {
  ms: +skMs.toFixed(0),
  nodes: skeleton.nodes.length,
  edges: skeleton.edges.length,
  twigs: skeleton.stats.twigEdges,
  shoots: skeleton.stats.shootEdges
});

t = performance.now();
const mc = bakeMarchingCubes(skeleton, {
  voxelM,
  simplifyCellScale: 1.15,
  nearestK: 12
});
const mcMs = ms(t);
console.log('2 marchingCubes', {
  ms: +mcMs.toFixed(0),
  tris: mc.stats.triangles,
  simplify: mc.stats.simplify
    ? `${(mc.stats.simplify.reduction * 100).toFixed(0)}%`
    : null
});

t = performance.now();
const proxy = buildTwigProxyGroup(skeleton, voxelM);
const twMs = ms(t);
console.log('3 twigProxy', {
  ms: +twMs.toFixed(0),
  count: proxy?.userData?.twigCount ?? 0
});

t = performance.now();
const scene = new THREE.Scene();
const canopy = new CanopyInstancer(scene, { count: canopyN, sizeScale: size });
canopy.rebindToSkeleton(skeleton);
const canMs = ms(t);

// Spread quality: seats in mid-crown band (not only tip cloud)
let midish = 0;
const forkY = skeleton.forkYM ?? 2;
const yMax = skeleton.bounds?.max?.y ?? forkY + 6;
const yLo = forkY + 0.35;
const yHi = forkY + (yMax - forkY) * 0.82;
for (let i = 0; i < canopy.placed; i++) {
  const y = canopy._centers[i * 3 + 1];
  if (y > yLo && y < yHi) midish += 1;
}

console.log('4 canopy', {
  ms: +canMs.toFixed(0),
  target: canopy.count,
  placed: canopy.placed,
  fill: pct(canopy.placed, canopy.count),
  midCrownShare: pct(midish, canopy.placed)
});

const total = ms(tAll);
console.log('=== total refresh ===', {
  ms: +total.toFixed(0),
  breakdown: {
    skeleton: pct(skMs, total),
    mc: pct(mcMs, total),
    twigs: pct(twMs, total),
    canopy: pct(canMs, total)
  }
});

if (total > 8000) {
  console.warn('WARN: refresh > 8s — check dens/branch/voxel');
  process.exitCode = 2;
} else if (total > 4000) {
  console.warn('NOTE: refresh > 4s');
}
