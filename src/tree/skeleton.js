/**
 * Stage A — Space-colonization skeleton (SI metres).
 * Includes aerial crown AND underground roots (y < 0).
 * Leonardo radius exponent Δ = 2.45; parallel-transport frames for UV.
 *
 * Graph hub = root collar at (0,0,0):
 *   • shoots grow upward (y ≥ 0)
 *   • roots grow underground (y < 0) — taproot + spreading laterals
 */

import {
  TREE_HEIGHT_M,
  CROWN_RADIUS_M,
  Y_FORK_M,
  TRUNK_BASE_RADIUS_M,
  TWIG_MIN_RADIUS_M,
  ROOT_DEPTH_M,
  TAPROOT_DEPTH_M,
  ROOT_SPREAD_M,
  ROOT_BASE_RADIUS_M,
  ROOT_TIP_RADIUS_M,
  TAPROOT_TIP_RADIUS_M
} from '../units.js';

export const LEONARDO_DELTA = 2.45;

/** @typedef {'collar'|'trunk'|'branch'|'twig'|'root'|'taproot'} NodeKind */

/** @typedef {{ x: number, y: number, z: number }} Vec3 */

/**
 * @typedef {object} SkeletonNode
 * @property {number} id
 * @property {Vec3} position
 * @property {number} radius  metres
 * @property {number|null} parent
 * @property {number[]} children
 * @property {number} arcLength  metres from collar (signed: − underground, + aerial)
 * @property {NodeKind} kind
 * @property {Vec3} T
 * @property {Vec3} N
 * @property {Vec3} B
 */

/**
 * @typedef {object} CapsuleEdge
 * @property {number} a  node id
 * @property {number} b  node id
 * @property {Vec3} pa
 * @property {Vec3} pb
 * @property {number} ra
 * @property {number} rb
 * @property {number} sa  arc length at a (m)
 * @property {number} sb  arc length at b (m)
 * @property {boolean} isRoot
 * @property {Vec3} Ta
 * @property {Vec3} Na
 * @property {Vec3} Ba
 * @property {Vec3} Tb
 * @property {Vec3} Nb
 * @property {Vec3} Bb
 */

/**
 * @typedef {object} Skeleton
 * @property {SkeletonNode[]} nodes
 * @property {CapsuleEdge[]} edges
 * @property {{ min: Vec3, max: Vec3 }} bounds
 * @property {number} collarId
 * @property {{ rootEdges: number, shootEdges: number }} stats
 */

function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function copy(a) {
  return { x: a.x, y: a.y, z: a.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function len(a) {
  return Math.hypot(a.x, a.y, a.z);
}

function normalize(a) {
  const L = len(a) || 1;
  return { x: a.x / L, y: a.y / L, z: a.z / L };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dist(a, b) {
  return len(sub(a, b));
}

function isRootKind(kind) {
  return kind === 'root' || kind === 'taproot';
}

/**
 * Uniform grid for nearest-node queries — colonization was O(attractors×nodes).
 * @param {SkeletonNode[]} nodes
 * @param {number} cellSize
 * @param {(n: SkeletonNode) => boolean} [accept]
 */
function buildNodeGrid(nodes, cellSize, accept) {
  const map = new Map();
  const inv = 1 / Math.max(1e-4, cellSize);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (accept && !accept(n)) continue;
    const p = n.position;
    const key = `${(p.x * inv) | 0},${(p.y * inv) | 0},${(p.z * inv) | 0}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(i);
    else map.set(key, [i]);
  }
  return { map, inv, cellSize };
}

/**
 * @param {{ map: Map, inv: number, cellSize: number }} grid
 * @param {SkeletonNode[]} nodes
 * @param {Vec3} point
 * @param {number} maxDist
 * @param {(n: SkeletonNode, id: number) => boolean} [accept]
 */
function nearestInGrid(grid, nodes, point, maxDist, accept) {
  const reach = Math.max(1, Math.ceil(maxDist * grid.inv));
  const ix = (point.x * grid.inv) | 0;
  const iy = (point.y * grid.inv) | 0;
  const iz = (point.z * grid.inv) | 0;
  let best = -1;
  let bestD = maxDist;
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const bucket = grid.map.get(`${ix + dx},${iy + dy},${iz + dz}`);
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const i = bucket[b];
          const n = nodes[i];
          if (accept && !accept(n, i)) continue;
          const d = dist(n.position, point);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
  }
  return best;
}

/** Mulberry32 — deterministic seed. */
function makeRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scatter attractors in inverted asymmetrical paraboloid crown envelope (y ≥ fork).
 * @param {number} n
 * @param {() => number} rng
 * @returns {Vec3[]}
 */
export function scatterAttractors(n, rng, forkYM = Y_FORK_M) {
  const pts = [];
  const H = TREE_HEIGHT_M;
  const Yf = Math.max(0.2, Math.min(H * 0.75, forkYM));
  const Rc = CROWN_RADIUS_M;
  let guard = 0;
  while (pts.length < n && guard < n * 50) {
    guard += 1;
    // Bias mid–upper crown (cherry blooms sit on outer twigs)
    const u = Math.pow(rng(), 0.72);
    const y = Yf + u * (H - Yf);
    const t = (y - Yf) / Math.max(1e-6, H - Yf);
    // Broader vase envelope + outer-shell bias (r closer to rMax)
    const envelope =
      Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, t * 1.05)))) *
      Rc *
      (0.95 + 0.4 * t);
    const noise = (rng() - 0.5) * 0.28;
    const rMax = Math.max(0.2, envelope + noise);
    const ang = rng() * Math.PI * 2;
    const shell = 0.55 + 0.45 * rng(); // prefer periphery over trunk axis
    const r = Math.sqrt(rng()) * rMax * shell + rMax * (1 - shell) * 0.15;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r * (0.9 + 0.2 * rng());
    if (x * x + z * z <= rMax * rMax + 0.05) {
      pts.push(v3(x, y, z));
    }
  }
  return pts;
}

/**
 * Scatter underground root attractors in a shallow spreading plate.
 * Biased toward the upper soil horizon (cherry laterals are shallow).
 * y ∈ (−ROOT_DEPTH_M, −0.04], radial ≤ ROOT_SPREAD_M.
 * @param {number} n
 * @param {() => number} rng
 * @returns {Vec3[]}
 */
export function scatterRootAttractors(n, rng) {
  const pts = [];
  const depth = ROOT_DEPTH_M;
  const spread = ROOT_SPREAD_M;
  let guard = 0;
  while (pts.length < n && guard < n * 50) {
    guard += 1;
    // Bias shallow: y = −depth * u^1.7 → more samples near surface
    const u = rng();
    const y = -0.04 - (depth - 0.04) * Math.pow(u, 1.7);
    const depthT = Math.min(1, -y / depth);
    // Plate widens with slight depth then contracts (root bowl)
    const rEnv = spread * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, depthT * 1.15)));
    const ang = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * rEnv;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r * (0.9 + 0.2 * rng());
    if (Math.hypot(x, z) <= spread + 0.05) {
      pts.push(v3(x, y, z));
    }
  }
  return pts;
}

/**
 * Grow space-colonization graph: underground roots + trunk + crown.
 * Collar at (0,0,0) is the hub — roots y<0, shoots y≥0.
 * @param {object} [params]
 * @returns {Skeleton}
 */
export function buildSpaceColonizationSkeleton(params = {}) {
  const {
    seed = 42,
    attractorCount = 900,
    rootAttractorCount = 420,
    stepPrimaryM = 0.25,
    stepTwigM = 0.1,
    stepRootM = 0.14,
    killRadiusM = 0.4,
    influenceRadiusM = 1.15,
    rootKillRadiusM = 0.32,
    rootInfluenceRadiusM = 0.95,
    maxIterations = 220,
    maxRootIterations = 140,
    tropism = 0.14,
    geotropism = 0.28, // downward bias for roots
    includeRoots = true,
    leaderCount = 6,
    /** Relative density of blossom-attachment (thin) shoots. 1 = default. */
    twigDensity = 1,
    /** Fork multiplier on thin blossom-attachment wood. 2 ≈ current default. */
    twigBranchMult = 2,
    /** Height of first crown fork on the trunk (m). Low ≈ bush, high ≈ tree. */
    forkYM = Y_FORK_M
  } = params;

  const dens = Math.max(0.15, Math.min(4, Number(twigDensity) || 1));
  const branchMul = Math.max(0.35, Math.min(5, Number(twigBranchMult) || 2));
  const forkY = Math.max(0.25, Math.min(TREE_HEIGHT_M * 0.72, Number(forkYM) || Y_FORK_M));
  // Soft-cap expensive twig passes (UI can go to 3–4×; wall-clock stays interactive)
  const densEff = Math.min(dens, 2.0);
  const MAX_AERIAL_NODES = 28_000;

  const rng = makeRng(seed);

  /** @type {SkeletonNode[]} */
  const nodes = [];
  const addNode = (position, parent, kind) => {
    const id = nodes.length;
    const node = {
      id,
      position: copy(position),
      radius: isRootKind(kind) ? ROOT_TIP_RADIUS_M : TWIG_MIN_RADIUS_M,
      parent,
      children: [],
      arcLength: 0,
      kind,
      T: v3(0, 1, 0),
      N: v3(1, 0, 0),
      B: v3(0, 0, 1)
    };
    nodes.push(node);
    if (parent !== null) nodes[parent].children.push(id);
    return node;
  };

  // ── Collar hub ──────────────────────────────────────────────
  const collar = addNode(v3(0, 0, 0), null, 'collar');
  const collarId = collar.id;

  // ── Underground: taproot + lateral colonization ─────────────
  if (includeRoots) {
    growTaproot(nodes, addNode, collarId, stepRootM);
    seedLateralRootLeaders(nodes, addNode, collarId, rng, stepRootM);
    growRootColonization(nodes, addNode, {
      rng,
      attractors: scatterRootAttractors(rootAttractorCount, rng),
      stepRootM,
      rootKillRadiusM,
      rootInfluenceRadiusM,
      maxRootIterations,
      geotropism
    });
  }

  // ── Aerial: trunk bole to first fork ────────────────────────
  const trunkSteps = Math.max(2, Math.round(forkY / stepPrimaryM));
  let prev = collar;
  for (let i = 1; i <= trunkSteps; i++) {
    const y = (i / trunkSteps) * forkY;
    const wobble = 0.02 * Math.sin(i * 1.7);
    prev = addNode(v3(wobble, y, wobble * 0.4), prev.id, i === trunkSteps ? 'trunk' : 'trunk');
  }

  const forkId = prev.id;

  // Seed crown leaders at the fork (vase habit — more leaders = fuller skeleton)
  const nLeaders = Math.max(3, Math.floor(leaderCount));
  for (let i = 0; i < nLeaders; i++) {
    const a = (i / nLeaders) * Math.PI * 2 + 0.35;
    const elev = 0.62 + 0.22 * ((i % 3) / 2);
    const dir = normalize(v3(Math.cos(a) * 0.7, elev, Math.sin(a) * 0.7));
    addNode(add(nodes[forkId].position, scale(dir, stepPrimaryM)), forkId, 'branch');
  }
  // Secondary mid-bole laterals for denser lower crown
  const midId = nodes.find((n) => n.kind === 'trunk' && n.position.y > forkY * 0.45)?.id;
  if (midId != null) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.9;
      const dir = normalize(v3(Math.cos(a), 0.35, Math.sin(a)));
      addNode(add(nodes[midId].position, scale(dir, stepPrimaryM * 0.85)), midId, 'branch');
    }
  }

  // Crown space colonization (spatial grid — was O(attractors×nodes) per iter)
  let attractors = scatterAttractors(attractorCount, rng, forkY);
  for (let iter = 0; iter < maxIterations && attractors.length > 0; iter++) {
    if (nodes.length > MAX_AERIAL_NODES) break;
    const phase = iter / maxIterations;
    const step = phase < 0.45 ? stepPrimaryM : phase < 0.75 ? stepTwigM * 1.15 : stepTwigM;
    const Di = influenceRadiusM * (phase < 0.45 ? 1.05 : phase < 0.75 ? 0.8 : 0.58);
    const Dk = killRadiusM * (phase < 0.45 ? 1.0 : phase < 0.75 ? 0.72 : 0.5);

    const grid = buildNodeGrid(nodes, Math.max(0.2, Di * 0.55), (n) => !isRootKind(n.kind));
    /** @type {Map<number, Vec3>} */
    const pull = new Map();

    for (const attr of attractors) {
      const best = nearestInGrid(grid, nodes, attr, Di, (n) => !isRootKind(n.kind));
      if (best < 0) continue;
      const dir = normalize(sub(attr, nodes[best].position));
      const acc = pull.get(best) || v3();
      pull.set(best, add(acc, dir));
    }

    if (pull.size === 0) break;

    const grown = [];
    for (const [nodeId, acc] of pull) {
      let dir = normalize(acc);
      dir = normalize(add(dir, v3(0, tropism, 0)));
      const p = nodes[nodeId].position;
      const outward = normalize(v3(p.x, 0, p.z));
      if (len(outward) > 0.01) dir = normalize(add(dir, scale(outward, 0.08)));
      const nextPos = add(nodes[nodeId].position, scale(dir, step));
      if (nextPos.y > TREE_HEIGHT_M + 0.15) continue;
      if (nextPos.y < forkY * 0.85 && nodeId !== forkId) {
        if (Math.hypot(nextPos.x, nextPos.z) > 0.6) continue;
      }
      // Never let aerial growth punch underground
      if (nextPos.y < 0.02 && nodes[nodeId].kind !== 'collar') continue;
      const child = addNode(nextPos, nodeId, 'branch');
      grown.push(child);
    }

    if (grown.length === 0) break;

    const grownGrid = buildNodeGrid(grown, Math.max(0.15, Dk * 0.6));
    attractors = attractors.filter((a) => {
      const hit = nearestInGrid(grownGrid, grown, a, Dk);
      return hit < 0;
    });
  }

  // Fine-twig pass: blossom-attachment scaffolding (capped densEff keeps rebuild interactive)
  growFineTwigs(nodes, addNode, {
    rng,
    attractors: scatterAttractors(
      Math.min(900, Math.max(80, Math.floor(attractorCount * 0.7 * densEff))),
      rng,
      forkY
    ),
    stepTwigM: stepTwigM * (0.58 / Math.sqrt(Math.max(0.5, densEff))),
    influenceRadiusM: influenceRadiusM * 0.55,
    killRadiusM: killRadiusM * (0.42 / Math.sqrt(Math.max(0.5, densEff))),
    maxIterations: Math.min(90, Math.max(25, Math.floor(maxIterations * 0.35 * densEff))),
    tropism: tropism * 0.5,
    maxChildren: Math.max(2, Math.round(2 * Math.min(branchMul, 3))),
    forkY,
    maxAerialNodes: MAX_AERIAL_NODES
  });
  if (nodes.length < MAX_AERIAL_NODES) {
    growTerminalTwigs(nodes, addNode, rng, stepTwigM * 0.5, densEff, Math.min(branchMul, 3), forkY);
  }

  assignArcLengths(nodes);
  assignLeonardoRadii(nodes);
  // Once shoots hit blossom-attachment gauge, fork by twigBranchMult
  if (nodes.length < MAX_AERIAL_NODES) {
    growThinScaffoldBoom(
      nodes,
      addNode,
      rng,
      stepTwigM * 0.45,
      densEff,
      Math.min(branchMul, 3),
      forkY
    );
  }
  assignArcLengths(nodes);
  assignLeonardoRadii(nodes);
  assignParallelTransport(nodes);

  const edges = buildCapsuleEdges(nodes);
  const bounds = computeBounds(nodes, edges);

  let rootEdges = 0;
  let shootEdges = 0;
  let twigEdges = 0;
  for (const e of edges) {
    if (e.isRoot) rootEdges += 1;
    else {
      shootEdges += 1;
      if (Math.max(e.ra, e.rb) <= TWIG_MIN_RADIUS_M * 3) twigEdges += 1;
    }
  }

  return {
    nodes,
    edges,
    bounds,
    collarId,
    forkYM: forkY,
    stats: { rootEdges, shootEdges, twigEdges }
  };
}

/**
 * Short colonization phase that only extends near-tip aerial nodes.
 */
function growFineTwigs(nodes, addNode, opts) {
  const {
    rng,
    attractors: startAttractors,
    stepTwigM,
    influenceRadiusM,
    killRadiusM,
    maxIterations,
    tropism,
    maxChildren = 4,
    forkY = Y_FORK_M,
    maxAerialNodes = 28000
  } = opts;
  let attractors = startAttractors;
  const acceptTwigHost = (n) =>
    !isRootKind(n.kind) &&
    n.kind !== 'collar' &&
    n.kind !== 'trunk' &&
    n.children.length <= maxChildren &&
    n.position.y >= forkY * 0.95;

  for (let iter = 0; iter < maxIterations && attractors.length > 0; iter++) {
    if (nodes.length >= maxAerialNodes) break;
    const grid = buildNodeGrid(nodes, Math.max(0.15, influenceRadiusM * 0.5), acceptTwigHost);
    /** @type {Map<number, Vec3>} */
    const pull = new Map();
    for (const attr of attractors) {
      const best = nearestInGrid(grid, nodes, attr, influenceRadiusM, acceptTwigHost);
      if (best < 0) continue;
      const dir = normalize(sub(attr, nodes[best].position));
      pull.set(best, add(pull.get(best) || v3(), dir));
    }
    if (pull.size === 0) break;

    const grown = [];
    for (const [nodeId, acc] of pull) {
      if (nodes.length + grown.length >= maxAerialNodes) break;
      let dir = normalize(acc);
      dir = normalize(add(dir, v3(0, tropism, 0)));
      const outward = normalize(
        v3(nodes[nodeId].position.x, 0.05, nodes[nodeId].position.z)
      );
      if (len(outward) > 0.01) dir = normalize(add(dir, scale(outward, 0.18)));
      dir = normalize(
        add(dir, v3((rng() - 0.5) * 0.25, (rng() - 0.5) * 0.1, (rng() - 0.5) * 0.25))
      );
      const nextPos = add(nodes[nodeId].position, scale(dir, stepTwigM));
      if (nextPos.y > TREE_HEIGHT_M + 0.25) continue;
      if (nextPos.y < forkY * 0.85) continue;
      if (Math.hypot(nextPos.x, nextPos.z) > CROWN_RADIUS_M * 1.15) continue;
      grown.push(addNode(nextPos, nodeId, 'twig'));
    }
    if (grown.length === 0) break;
    const grownGrid = buildNodeGrid(grown, Math.max(0.1, killRadiusM * 0.6));
    attractors = attractors.filter((a) => nearestInGrid(grownGrid, grown, a, killRadiusM) < 0);
  }
}

/**
 * Guarantee every aerial leaf sprouts lean tip twigs for blossom anchors.
 * @param {number} dens  twigDensity
 * @param {number} branchMul  twigBranchMult
 * @param {number} forkY
 */
function growTerminalTwigs(nodes, addNode, rng, stepM, dens = 1, branchMul = 2, forkY = Y_FORK_M) {
  const leaves = [];
  for (const n of nodes) {
    if (isRootKind(n.kind) || n.kind === 'collar') continue;
    if (n.position.y < forkY * 0.9) continue;
    if (n.children.length === 0) leaves.push(n);
  }
  // Density < 1 sparsifies which leaves fan; > 1 keeps all
  const keepChance = Math.min(1, dens);
  for (const leaf of leaves) {
    if (rng() > keepChance) continue;
    // Base ~2 tips × branchMul (clamped)
    const nTwig = Math.max(
      1,
      Math.min(10, Math.round((1.5 + rng() * 1.5) * branchMul))
    );
    for (let i = 0; i < nTwig; i++) {
      const a = (i / nTwig) * Math.PI * 2 + rng() * 0.4;
      const elev = 0.25 + rng() * 0.65;
      let dir = normalize(v3(Math.cos(a) * 0.85, elev, Math.sin(a) * 0.85));
      const outward = normalize(v3(leaf.position.x, 0, leaf.position.z));
      if (len(outward) > 0.05) dir = normalize(add(dir, scale(outward, 0.35)));
      const lenStep = stepM * (0.7 + rng() * 0.55);
      let p = add(leaf.position, scale(dir, lenStep));
      if (p.y < forkY) p.y = forkY + 0.05;
      if (p.y > TREE_HEIGHT_M + 0.2) continue;
      const tw = addNode(p, leaf.id, 'twig');
      // Extend more often when branching multiplier is high
      if (rng() > 0.55 / Math.max(0.5, branchMul)) {
        const dir2 = normalize(
          add(dir, v3((rng() - 0.5) * 0.4, 0.15 + rng() * 0.25, (rng() - 0.5) * 0.4))
        );
        const p2 = add(tw.position, scale(dir2, lenStep * 0.75));
        if (p2.y <= TREE_HEIGHT_M + 0.25) addNode(p2, tw.id, 'twig');
      }
    }
  }
}

/**
 * After Leonardo radii: shoots that have thinned to blossom gauge fork by
 * twigBranchMult — capped by twigDensity so the crown stays tractable.
 * @param {SkeletonNode[]} nodes
 * @param {Function} addNode
 * @param {() => number} rng
 * @param {number} stepM
 * @param {number} dens
 * @param {number} branchMul
 * @param {number} forkY
 */
function growThinScaffoldBoom(
  nodes,
  addNode,
  rng,
  stepM,
  dens = 1,
  branchMul = 2,
  forkY = Y_FORK_M
) {
  const thinR = 0.014; // blossom-attachment gauge (metres)
  /** Under-branched thin shoots only (not every tip twig). */
  const hosts = [];
  for (const n of nodes) {
    if (isRootKind(n.kind) || n.kind === 'collar' || n.kind === 'trunk') continue;
    if (n.position.y < forkY * 0.9) continue;
    if (n.radius > thinR) continue;
    // Prefer thin branchlets that still have room to fork
    const childCap = Math.max(2, Math.round(2 * branchMul));
    if (n.children.length > childCap) continue;
    // Skip already-tiny tip stubs — boom from their parent branchlets
    if (n.kind === 'twig' && n.children.length === 0 && n.radius <= TWIG_MIN_RADIUS_M * 1.1) {
      continue;
    }
    hosts.push(n);
  }
  // Shuffle so cap doesn't bias one side of the crown
  for (let i = hosts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = hosts[i];
    hosts[i] = hosts[j];
    hosts[j] = tmp;
  }

  let added = 0;
  const maxAdd = Math.min(8_000, Math.max(500, Math.floor(4500 * dens)));
  const hostKeep = Math.min(1, dens);
  for (const n of hosts) {
    if (added >= maxAdd) break;
    if (rng() > hostKeep) continue;
    const room = Math.max(0, Math.round(2 * branchMul) - n.children.length);
    if (room <= 0) continue;
    const forks = Math.min(
      room,
      Math.max(1, Math.round(branchMul * (0.45 + rng() * 0.55)))
    );

    let baseT = v3(0, 1, 0);
    if (n.parent != null) {
      const d = sub(n.position, nodes[n.parent].position);
      if (len(d) > 1e-6) baseT = normalize(d);
    } else if (n.T && len(n.T) > 1e-6) {
      baseT = normalize(n.T);
    }

    for (let i = 0; i < forks; i++) {
      if (added >= maxAdd) break;
      const a = (i / Math.max(1, forks)) * Math.PI * 2 + rng() * 0.55;
      const elev = 0.15 + rng() * 0.55;
      let dir = normalize(
        add(
          scale(baseT, 0.45 + rng() * 0.35),
          v3(Math.cos(a) * 0.9, elev, Math.sin(a) * 0.9)
        )
      );
      const outward = normalize(v3(n.position.x, 0.02, n.position.z));
      if (len(outward) > 0.05) dir = normalize(add(dir, scale(outward, 0.28)));
      const lenStep = stepM * (0.55 + rng() * 0.65);
      let p = add(n.position, scale(dir, lenStep));
      if (p.y < forkY * 0.95) p.y = forkY * 0.95 + 0.02;
      if (p.y > TREE_HEIGHT_M + 0.25) continue;
      if (Math.hypot(p.x, p.z) > CROWN_RADIUS_M * 1.2) continue;
      const tw = addNode(p, n.id, 'twig');
      added += 1;
      if (rng() > 0.4 && added < maxAdd) {
        const dir2 = normalize(
          add(dir, v3((rng() - 0.5) * 0.45, 0.12 + rng() * 0.3, (rng() - 0.5) * 0.45))
        );
        const p2 = add(tw.position, scale(dir2, lenStep * 0.7));
        if (
          p2.y <= TREE_HEIGHT_M + 0.25 &&
          p2.y >= forkY * 0.9 &&
          Math.hypot(p2.x, p2.z) <= CROWN_RADIUS_M * 1.2
        ) {
          addNode(p2, tw.id, 'twig');
          added += 1;
        }
      }
    }
  }
}

/** Central tap / sinker root straight-ish down from collar. */
function growTaproot(nodes, addNode, collarId, stepRootM) {
  const steps = Math.max(3, Math.round(TAPROOT_DEPTH_M / stepRootM));
  let prevId = collarId;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const y = -t * TAPROOT_DEPTH_M;
    // Mild corkscrew so it isn't a perfect stick
    const wobble = 0.03 * Math.sin(i * 1.3);
    const n = addNode(v3(wobble, y, wobble * 0.5), prevId, 'taproot');
    prevId = n.id;
  }
}

/** Seed several primary laterals from collar + upper taproot. */
function seedLateralRootLeaders(nodes, addNode, collarId, rng, stepRootM) {
  const leaderCount = 6;
  for (let i = 0; i < leaderCount; i++) {
    const a = (i / leaderCount) * Math.PI * 2 + rng() * 0.2;
    const dip = 0.25 + rng() * 0.35; // downward component
    const dir = normalize(v3(Math.cos(a), -dip, Math.sin(a)));
    addNode(add(nodes[collarId].position, scale(dir, stepRootM)), collarId, 'root');
  }

  // Extra laterals branching from upper taproot nodes (first ~40% of depth)
  for (const n of nodes) {
    if (n.kind !== 'taproot') continue;
    if (n.position.y < -ROOT_DEPTH_M * 0.45) continue;
    if (rng() > 0.45) continue;
    const a = rng() * Math.PI * 2;
    const dir = normalize(v3(Math.cos(a), -0.15 - rng() * 0.25, Math.sin(a)));
    addNode(add(n.position, scale(dir, stepRootM * 0.9)), n.id, 'root');
  }
}

/**
 * Space-colonization for underground laterals only.
 * Geotropism + radial spread; hard clamp to stay below soil.
 */
function growRootColonization(nodes, addNode, opts) {
  let {
    rng,
    attractors,
    stepRootM,
    rootKillRadiusM,
    rootInfluenceRadiusM,
    maxRootIterations,
    geotropism
  } = opts;

  for (let iter = 0; iter < maxRootIterations && attractors.length > 0; iter++) {
    const Di = rootInfluenceRadiusM * (iter < maxRootIterations * 0.5 ? 1 : 0.75);
    const Dk = rootKillRadiusM * (iter < maxRootIterations * 0.5 ? 1 : 0.7);
    const step = iter < maxRootIterations * 0.55 ? stepRootM : stepRootM * 0.7;

    /** @type {Map<number, Vec3>} */
    const pull = new Map();

    for (const attr of attractors) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        // Only root / taproot / collar compete for soil attractors
        if (n.kind !== 'collar' && !isRootKind(n.kind)) continue;
        const d = dist(n.position, attr);
        if (d < bestD && d < Di) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) continue;
      const dir = normalize(sub(attr, nodes[best].position));
      const acc = pull.get(best) || v3();
      pull.set(best, add(acc, dir));
    }

    if (pull.size === 0) break;

    const grown = [];
    for (const [nodeId, acc] of pull) {
      // Collar itself shouldn't sprout endless laterals mid-loop — leaders already seeded
      if (nodes[nodeId].kind === 'collar' && nodes[nodeId].children.filter((c) => isRootKind(nodes[c].kind)).length > 10) {
        continue;
      }

      let dir = normalize(acc);
      // Geotropism (down) + outward plate bias
      dir = normalize(add(dir, v3(0, -geotropism, 0)));
      const p = nodes[nodeId].position;
      const outward = normalize(v3(p.x, 0, p.z));
      if (len(outward) > 0.05) {
        dir = normalize(add(dir, scale(outward, 0.22)));
      } else {
        // Near axis: push randomly outward so we don't pile on the taproot
        const a = rng() * Math.PI * 2;
        dir = normalize(add(dir, scale(v3(Math.cos(a), 0, Math.sin(a)), 0.35)));
      }

      let nextPos = add(nodes[nodeId].position, scale(dir, step));

      // Stay underground (just below soil surface)
      if (nextPos.y > -0.03) {
        nextPos = { x: nextPos.x, y: -0.03 - rng() * 0.02, z: nextPos.z };
      }
      // Depth clamp
      if (nextPos.y < -ROOT_DEPTH_M - 0.15) continue;
      // Radial clamp near drip-line
      if (Math.hypot(nextPos.x, nextPos.z) > ROOT_SPREAD_M * 1.08) continue;

      const child = addNode(nextPos, nodeId, 'root');
      grown.push(child);
    }

    if (grown.length === 0) break;

    attractors = attractors.filter((a) => {
      for (const g of grown) {
        if (dist(a, g.position) < Dk) return false;
      }
      return true;
    });
  }
}

/**
 * Signed arc-length from collar: + aerial path, − underground path (metres).
 * @param {SkeletonNode[]} nodes
 */
function assignArcLengths(nodes) {
  const root = nodes[0];
  root.arcLength = 0;
  const queue = [0];
  const seen = new Set([0]);
  while (queue.length) {
    const id = queue.shift();
    const n = nodes[id];
    for (const c of n.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      const d = dist(n.position, nodes[c].position);
      if (isRootKind(nodes[c].kind)) {
        // Deeper underground → more negative
        nodes[c].arcLength = n.arcLength - d;
      } else {
        nodes[c].arcLength = n.arcLength + d;
      }
      queue.push(c);
    }
  }
}

/**
 * Leonardo radii separately for shoot vs root subgraphs so roots
 * don't inflate the bole, and shoots don't thicken laterals.
 * @param {SkeletonNode[]} nodes
 */
export function assignLeonardoRadii(nodes) {
  const delta = LEONARDO_DELTA;
  const collar = nodes[0];

  const shootChild = (id) =>
    nodes[id].children.filter((c) => !isRootKind(nodes[c].kind));
  const rootChild = (id) =>
    nodes[id].children.filter((c) => isRootKind(nodes[c].kind));

  // ── Shoots (trunk / branches) ──
  const shootOrder = [];
  const visitShoot = (id) => {
    for (const c of shootChild(id)) visitShoot(c);
    shootOrder.push(id);
  };
  visitShoot(0);

  for (const id of shootOrder) {
    const n = nodes[id];
    if (n.kind === 'collar') continue;
    if (isRootKind(n.kind)) continue;
    const kids = shootChild(id);
    if (kids.length === 0) {
      n.radius = TWIG_MIN_RADIUS_M;
      continue;
    }
    let sum = 0;
    for (const c of kids) sum += Math.pow(nodes[c].radius, delta);
    n.radius = Math.pow(sum, 1 / delta);
  }

  // Scale shoots so first trunk child / collar flare matches base radius
  const trunkKids = shootChild(0);
  if (trunkKids.length > 0) {
    const trunkRoot = nodes[trunkKids[0]];
    // Walk to get max radius along trunk chain near collar
    let maxShoot = TWIG_MIN_RADIUS_M;
    for (const id of shootOrder) {
      if (id === 0) continue;
      maxShoot = Math.max(maxShoot, nodes[id].radius);
    }
    const scaleR = TRUNK_BASE_RADIUS_M / Math.max(trunkRoot.radius, 1e-6);
    for (const id of shootOrder) {
      if (id === 0) continue;
      nodes[id].radius = Math.max(TWIG_MIN_RADIUS_M, nodes[id].radius * scaleR);
    }
  }

  // ── Roots (laterals + taproot) ──
  const rootOrder = [];
  const visitRoot = (id) => {
    for (const c of rootChild(id)) visitRoot(c);
    if (isRootKind(nodes[id].kind)) rootOrder.push(id);
  };
  // Start from collar's root children and taproot chain
  for (const c of rootChild(0)) visitRoot(c);

  for (const id of rootOrder) {
    const n = nodes[id];
    const kids = rootChild(id);
    if (kids.length === 0) {
      n.radius =
        n.kind === 'taproot' ? TAPROOT_TIP_RADIUS_M : ROOT_TIP_RADIUS_M;
      continue;
    }
    let sum = 0;
    for (const c of kids) sum += Math.pow(nodes[c].radius, delta);
    n.radius = Math.pow(sum, 1 / delta);
  }

  // Normalize primary laterals / upper taproot to ROOT_BASE_RADIUS_M
  const primaryRoots = rootChild(0);
  let maxPrimary = 0;
  for (const id of primaryRoots) maxPrimary = Math.max(maxPrimary, nodes[id].radius);
  if (maxPrimary > 1e-8) {
    const scaleRoot = ROOT_BASE_RADIUS_M / maxPrimary;
    for (const id of rootOrder) {
      const tip =
        nodes[id].kind === 'taproot' ? TAPROOT_TIP_RADIUS_M : ROOT_TIP_RADIUS_M;
      nodes[id].radius = Math.max(tip, nodes[id].radius * scaleRoot);
    }
  }

  // Collar = trunk flare (roots attach but do not redefine bole radius)
  collar.radius = TRUNK_BASE_RADIUS_M;

  // Force lean tips: every aerial leaf / twig stays thin so MC skips them
  // but canopy has real attachment points.
  for (const n of nodes) {
    if (isRootKind(n.kind) || n.kind === 'collar' || n.kind === 'trunk') continue;
    if (n.kind === 'twig' || n.children.length === 0) {
      n.radius = TWIG_MIN_RADIUS_M * (n.kind === 'twig' ? 1.0 : 1.4);
    } else if (n.children.every((c) => nodes[c].kind === 'twig' || nodes[c].children.length === 0)) {
      n.radius = Math.min(n.radius, Math.max(TWIG_MIN_RADIUS_M * 2.5, 0.012));
    }
  }
}

/**
 * Parallel-transport frames along each parent→child edge.
 * @param {SkeletonNode[]} nodes
 */
export function assignParallelTransport(nodes) {
  nodes[0].T = v3(0, 1, 0);
  nodes[0].N = v3(1, 0, 0);
  nodes[0].B = v3(0, 0, 1);

  const queue = [0];
  while (queue.length) {
    const id = queue.shift();
    const parent = nodes[id];
    for (const c of parent.children) {
      const child = nodes[c];
      const T = normalize(sub(child.position, parent.position));
      let B = cross(T, parent.N);
      if (len(B) < 1e-6) {
        B = cross(T, parent.B);
      }
      B = normalize(B);
      const N = normalize(cross(B, T));
      child.T = T;
      child.N = N;
      child.B = B;
      queue.push(c);
    }
  }
}

/** @param {SkeletonNode[]} nodes @returns {CapsuleEdge[]} */
export function buildCapsuleEdges(nodes) {
  /** @type {CapsuleEdge[]} */
  const edges = [];
  for (const n of nodes) {
    if (n.parent === null) continue;
    const p = nodes[n.parent];
    const childIsRoot = isRootKind(n.kind);
    const parentIsRoot = isRootKind(p.kind);
    edges.push({
      a: p.id,
      b: n.id,
      pa: copy(p.position),
      pb: copy(n.position),
      ra: p.radius,
      rb: n.radius,
      sa: p.arcLength,
      sb: n.arcLength,
      isRoot: childIsRoot || (parentIsRoot && p.kind !== 'collar'),
      Ta: copy(p.T),
      Na: copy(p.N),
      Ba: copy(p.B),
      Tb: copy(n.T),
      Nb: copy(n.N),
      Bb: copy(n.B)
    });
  }
  return edges;
}

function computeBounds(nodes, edges) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let pad = 0;
  for (const e of edges) {
    pad = Math.max(pad, e.ra, e.rb);
    for (const p of [e.pa, e.pb]) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  // Include nodes with no edges (degenerate) + underground extent
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    minZ = Math.min(minZ, n.position.z);
    maxX = Math.max(maxX, n.position.x);
    maxY = Math.max(maxY, n.position.y);
    maxZ = Math.max(maxZ, n.position.z);
  }
  pad += 0.08;
  // CRITICAL: do NOT clamp minY to 0 — roots live underground
  return {
    min: v3(minX - pad, minY - pad, minZ - pad),
    max: v3(maxX + pad, maxY + pad, maxZ + pad)
  };
}

export const skeletonMath = { v3, add, sub, scale, len, normalize, dot, cross, dist, isRootKind };
