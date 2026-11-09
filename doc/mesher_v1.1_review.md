# Sakura Tree v1.1 — bark meshing review

Compared on one skeleton (seed 42, 700 attractors, 25 394 nodes, 136.6 m² of wood), same machine, Node 22.
Reproduce: `npm run bench:mesher` · invariants: `npm run test:mesh` · UI: `npx playwright test tests/mesher-v11.spec.js`.
Raw numbers: `bench-results/mesher-v1.1.json`.

## What v1.0 actually did

| | |
|---|---|
| thick wood | marching cubes @ 65 mm voxel → 8 k triangles, blocky ("plates" at forks, stepped limbs) |
| everything < ~5 cm radius | 24.7 k edges (97 %) → **separate instanced 4-gon capped cylinders** (~396 k triangles), not joined to the parent wood |
| blossom seats | `edge radius + 3 mm`, blind to the real surface (p50 gap 3.2 mm, p95 7.2 mm, 15 % > 4 mm) |

## What `doc/branch_mesher.html` brings (and where it stops)

Good, adopted: exact min inside a limb + polynomial smooth-min *between* limbs (no bulge at nodes), fillet
radius following the child limb, narrow-band flood fill from tips (cost ∝ surface area), Newton projection
onto the SDF, radius-weighted QEM with junction protection, open-addressing lattice hash.

Where it stops — measured by running its recipe unchanged on this tree (`sdf-only`, cell from its own
140 k-quad budget = 31 mm):

| | surface nets only (reference recipe) |
|---|---|
| time | 3.4 s |
| bark shells | **612** (shattered) |
| tips ≤ 4 mm present | **2.4 %** |
| twigs 4–14 mm present | **11 %** |
| shoots 14–50 mm present | 83 % |

No grid can hold a 3 mm tip on a 9 m tree: a cell fine enough (≈ 2.7 mm) is ~10⁷ cells of surface. So the
reference's own caveat is structural, not a tuning problem.

## v1.1 design

```
skeleton ─► chains (dominant child continues; others start a limb) ─┬─ thick head → ChainSDF → surface nets → relax → QEM
                                                                    └─ thin tail  → swept tube (3…10 sides, zipper-stitched)
```

* **Thick/thin split by radius** (`rCut = max(30 mm, 1.4 × cell)`): surface nets only where a limb spans ≥ ~2.8 cells.
* **Tubes** are exact at any radius, O(points): parallel-transport frames (no twist), bisector rings with clamped miter,
  area-equivalent ring radius, side count follows radius, cone tips, UV seam welded with an extra column. Side-limb
  bases start *inside* the parent at their own radius → no gap, no flare.
* **ChainSDF**: dense 0.25 m bucket grid (graph skeleton, not a handful of limbs), per-limb min then smin between limbs;
  `uv = (θ/2π, arc length)` and analytic normals per vertex; seam triangles duplicated so UVs stay continuous.
* **Wood probe** (`woodSurface.js`): `radiusAt(edge, t, dir)` returns the exact meshed radius from the same ring data;
  `CanopyInstancer` roots stems 0.4 mm *inside* the bark with it. Legacy `r + 3 mm` remains the fallback for `mesher:'mc'`.
* `skeleton.edges[i].raWood`: the wood model (side limb starts at its own radius). Skeleton, MC and v1.0 are unchanged.

## Results (cell = 40 mm, the default; each mesher judged against the wood model it intends)

| | v1.0 | hybrid |
|---|---|---|
| mesh time | 1305 ms | **240 ms** (5.4×) |
| full rebuild (skeleton+mesh+25 k canopy) | 2336 ms | **1333 ms** |
| triangles | 404 k | **214 k** |
| draw calls for bark | 2 (+ instancing) | **1** |
| thick wood | 2 shells, χ = 31 | **1 closed shell, χ = 2**, 0 open edges, 10 non-manifold edges |
| winding vs normals | 98 % | 99.9 % |
| limb > 50 mm mean error | 7.5 mm | **1.6 mm** |
| shoot 14–50 mm mean error | 5.3 mm | **1.0 mm** |
| twig 4–14 mm mean error / miss | 1.4 mm / 0 % | 0.8 mm / 0.4 % |
| tip ≤ 4 mm mean error | 0.6 mm | 0.65 mm (3-gon) |
| blossom seat gap p50 / p95 | 3.2 / 7.2 mm | **0.32 / 0.64 mm** |
| seats > 4 mm off | 15 % | **0.4 %** |

Cell sweep (same skeleton): 60 mm → 153 ms / 202 k tris · **40 mm → 240 ms / 214 k** · 30 mm → 411 ms / 239 k · 20 mm → 1.1 s / 316 k
(limb error 2.7 → 1.6 → 1.3 → 0.9 mm). Cost is the QEM pass; the surface-net stage stays under 350 ms even at 20 mm.

Playwright (real app, same skeleton, screenshots in `qc-artifacts/v1.1/`): v1.0 shows square plates and stepped
joints at forks; v1.1 shows continuous filleted forks with every twig intact; 328 k vs 493 k triangles drawn.

## Known limits / next ideas

1. Thick limbs follow the skeleton polyline, so large bends look faceted. Next: centripetal Catmull-Rom resample of each
   chain before SDF/tubes (also helps seat placement).
2. The tube/thick hand-off is a buried overlap, not a fused surface; a visible crease is possible at the 30 mm boundary
   (lower `rCutMin`/`cellM` moves it, cost grows).
3. ~10–30 non-manifold edges remain in the surface-net shell (diagonal sheet contact); harmless for rendering, matters
   for 3-D printing/physics — a dual-contouring-style split pass would clear them.
4. Bark grooves (4 mm) are no longer baked into geometry (below grid Nyquist at any playable cell); the lenticel shader
   carries bark detail. A tileable normal map is the right next step.
5. LOD: tubes could drop to 3 sides beyond ~15 m and merge collinear twig segments (≈ −35 % triangles).
6. Quad-dominant output (surface nets are already quads) → keep quads through QEM for cleaner shading.
