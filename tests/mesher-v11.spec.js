import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('qc-artifacts', 'v1.1');

/** Same skeleton for both meshers so the screenshots are directly comparable. */
const BAKE = {
  attractorCount: 700,
  rootAttractorCount: 315,
  maxIterations: 160,
  maxRootIterations: 104,
  twigDensity: 1.5,
  twigBranchMult: 2,
  forkYM: 1.1,
  seed: 42,
  voxelM: 0.065
};

const VIEWS = [
  { name: 'hero', cam: [7.5, 2.8, 11.5], target: [0, 3.6, 0] },
  { name: 'fork', cam: [1.5, 2.2, 2.3], target: [0, 1.5, 0] },
  { name: 'twigs', cam: [2.4, 5.0, 3.0], target: [0.8, 4.6, 0.6] },
  { name: 'twigs-close', cam: [1.55, 4.55, 1.7], target: [0.8, 4.5, 0.6] }
];

test.describe('v1.1 bark mesher', () => {
  test('hybrid vs marching-cubes: same skeleton, real app, close-ups', async ({ page }) => {
    test.setTimeout(240_000);
    fs.mkdirSync(OUT, { recursive: true });

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/?qc=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();
    await page.waitForFunction(() => window.__SAKURA_QC?.ready === true, null, { timeout: 90_000 });
    await page.evaluate(() => window.__SAKURA_QC.setPaused(true));

    const shoot = async (prefix) => {
      for (const v of VIEWS) {
        await page.evaluate(
          ({ cam, target }) => window.__SAKURA_QC.setCamera(...cam, ...target),
          v
        );
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(OUT, `${prefix}-${v.name}.png`) });
      }
    };

    // ── v1.0 baseline ──
    const mc = await page.evaluate(
      (p) => {
        const t = performance.now();
        const s = window.__SAKURA_QC.engine.bakeBark({ ...p, mesher: 'mc' });
        const e = window.__SAKURA_QC.engine;
        return {
          stats: { mesher: s.mesher, triangles: s.triangles, meshMs: s.meshMs },
          wallMs: performance.now() - t,
          twigProxyTris: e.twigProxy ? e.twigProxy.children[0].count * 16 : 0,
          hasProxy: Boolean(e.twigProxy)
        };
      },
      BAKE
    );
    expect(mc.stats.mesher).toBe('mc');
    expect(mc.hasProxy).toBeTruthy();
    await shoot('v10');
    const snapMc = await page.evaluate(() => window.__SAKURA_QC.getSnapshot());

    // ── v1.1 hybrid ──
    const hy = await page.evaluate(
      (p) => {
        const t = performance.now();
        const e = window.__SAKURA_QC.engine;
        const s = e.bakeBark({ ...p, mesher: 'hybrid' });
        const g = e.barkMesh.geometry;
        // Tube bases are buried, but every blossom seat should hug real bark
        const seats = e.canopy.attachPoints;
        return {
          stats: {
            mesher: s.mesher, triangles: s.triangles, vertices: s.vertices, meshMs: s.meshMs,
            barkTriangles: s.barkTriangles, tubeTriangles: s.tubeTriangles,
            thickChains: s.thickChains, thinChains: s.thinChains
          },
          wallMs: performance.now() - t,
          hasProxy: Boolean(e.twigProxy),
          attrs: Object.keys(g.attributes),
          hasWoodProbe: Boolean(e.skeleton.woodSurface),
          seatCount: seats ? seats.length / 3 : 0
        };
      },
      BAKE
    );
    expect(hy.stats.mesher).toBe('hybrid');
    expect(hy.hasProxy, 'hybrid must not add instanced proxy tubes').toBeFalsy();
    expect(hy.attrs).toEqual(expect.arrayContaining(['position', 'normal', 'uv']));
    expect(hy.hasWoodProbe).toBeTruthy();
    expect(hy.stats.thinChains).toBeGreaterThan(1000);
    expect(hy.stats.barkTriangles).toBeGreaterThan(1000);
    // Fewer triangles than v1.0's bark + proxy cylinders, and faster
    expect(hy.stats.triangles).toBeLessThan(mc.stats.triangles + mc.twigProxyTris);
    expect(hy.stats.meshMs).toBeLessThan(mc.stats.meshMs);

    await shoot('v11');
    const snapHy = await page.evaluate(() => window.__SAKURA_QC.getSnapshot());
    expect(snapHy.bakeDone).toBeTruthy();
    expect(snapHy.barkBoundsY[0]).toBeLessThan(0);

    // Canvas must actually show the tree (non-black), hybrid
    const luma = await page.evaluate(() => {
      const c = document.querySelector('#app');
      const off = document.createElement('canvas');
      off.width = 48; off.height = 27;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0, 48, 27);
      const d = ctx.getImageData(0, 0, 48, 27).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return s / (48 * 27);
    });
    expect(luma).toBeGreaterThan(10);

    fs.writeFileSync(
      path.join(OUT, 'compare.json'),
      JSON.stringify({ mc, hy, snapMc: { drawCalls: snapMc.drawCalls, triangles: snapMc.triangles }, snapHy: { drawCalls: snapHy.drawCalls, triangles: snapHy.triangles }, errors }, null, 2)
    );

    const fatal = errors.filter((e) => !/ResizeObserver|devtools/i.test(e));
    expect(fatal, fatal.join(' | ')).toEqual([]);
  });

  test('GUI exposes the mesher switch', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const sel = page.getByTestId('mesher-select');
    await expect(sel).toBeVisible({ timeout: 60_000 });
    await expect(sel).toHaveValue('hybrid');
    await expect(page.getByRole('button', { name: 'Rebuild now' })).toBeVisible();
  });
});
