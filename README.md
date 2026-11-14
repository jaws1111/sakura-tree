# Sakura Tree

Procedural ornamental cherry (Kanzan-class) in SI metres — Three.js + Vite.

## Run

```bash
npm install
npm run dev
```

Mesher checks: `npm run test:mesh` (invariants, ~15 s), `npm run bench:mesher` (v1.0 vs reference vs hybrid), `npm run test:qc` (Playwright).

Or double-click `start.bat` (Windows) to kill stale Vite ports and launch the TUI.

## Highlights

- Space-colonization skeleton with Leonardo radii
- **v1.1 bark mesher**: filleted flood-fill surface nets for thick wood (one closed shell) + swept tubes for twigs, a single draw call; blossom seats come from the exact bark surface. v1.0 marching cubes stays available (`mesher: 'mc'`, GUI → Bark mesher). Benchmarks and rationale: [doc/mesher_v1.1_review.md](doc/mesher_v1.1_review.md)
- Dense canopy on thin twigs with peduncle pockets
- Shared blossom mesh/material (edge-fade shader) for canopy + falling petals
- Analysis GUI: bake quality, foliage density, blossom render, first-branch height
