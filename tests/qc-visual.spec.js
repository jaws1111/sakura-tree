import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('qc-artifacts');

test.describe('Sakura tree QC', () => {
  test('runtime health + multi-angle visual capture', async ({ page }) => {
    test.setTimeout(180_000);
    fs.mkdirSync(OUT, { recursive: true });

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/?qc=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();

    await page.waitForFunction(() => window.__SAKURA_QC?.ready === true, null, {
      timeout: 90_000
    });
    expect(await page.evaluate(() => window.__SAKURA_QC.error)).toBeNull();

    // Force one render while paused
    await page.evaluate(() => {
      window.__SAKURA_QC.setPaused(true);
    });
    await page.waitForTimeout(200);

    const preBake = await page.evaluate(() => window.__SAKURA_QC.getSnapshot());
    expect(preBake.hasCanopy).toBeTruthy();
    expect(preBake.hasGrass).toBeTruthy();
    expect(preBake.hasFallingPetals).toBeTruthy();

    await page.screenshot({ path: path.join(OUT, '01-initial.png') });

    const views = [
      { name: '02-hero', x: 7.5, y: 2.8, z: 11.5, ty: 3.6 },
      { name: '03-side', x: 12, y: 3.5, z: 0.5, ty: 4.0 },
      { name: '04-canopy-close', x: 3.2, y: 6.5, z: 4.5, ty: 6.5 },
      { name: '05-bole-human', x: 2.5, y: 1.6, z: 4.5, ty: 1.2 },
      { name: '06-ground-low', x: 4.5, y: 0.45, z: 5.5, ty: 0.2 },
      { name: '07-overhead', x: 0.2, y: 14, z: 0.2, ty: 4 }
    ];

    for (const v of views) {
      await page.evaluate(
        ({ x, y, z, ty }) => window.__SAKURA_QC.setCamera(x, y, z, 0, ty, 0),
        v
      );
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${v.name}.png`) });
    }

    // Fast skeleton root check (no MC)
    const skeletonQC = await page.evaluate(() => {
      const sk = window.__SAKURA_QC.engine.barkMesher.buildSkeleton({
        attractorCount: 300,
        rootAttractorCount: 180,
        maxIterations: 70,
        maxRootIterations: 50
      });
      return {
        nodes: sk.nodes.length,
        rootEdges: sk.stats.rootEdges,
        shootEdges: sk.stats.shootEdges,
        minY: sk.bounds.min.y,
        maxY: sk.bounds.max.y
      };
    });
    expect(skeletonQC.rootEdges).toBeGreaterThan(40);
    expect(skeletonQC.minY).toBeLessThan(-0.5);

    // Coarse bark bake — keep tiny so headless stays responsive
    const bakeStats = await page.evaluate(() =>
      window.__SAKURA_QC.engine.bakeBark({
        voxelM: 0.22,
        attractorCount: 220,
        rootAttractorCount: 120,
        maxIterations: 55,
        maxRootIterations: 40,
        nearestK: 10,
        includeBark: false
      })
    );

    const afterBake = await page.evaluate(() => window.__SAKURA_QC.getSnapshot());
    await page.evaluate(() => window.__SAKURA_QC.setCamera(7.5, 2.8, 11.5, 0, 3.6, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, '08-after-bark-bake.png') });
    await page.evaluate(() => window.__SAKURA_QC.setCamera(5, 0.25, 6, 0, -0.4, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, '09-roots-after-bake.png') });

    fs.writeFileSync(
      path.join(OUT, 'snapshot.json'),
      JSON.stringify({ preBake, skeletonQC, afterBake, bakeStats, errors }, null, 2)
    );

    expect(afterBake.bakeDone).toBeTruthy();
    expect(afterBake.barkBoundsY[0]).toBeLessThan(0);
    expect(bakeStats.triangles).toBeGreaterThan(50);

    // Force a present with preserveDrawingBuffer, then sample luma
    await page.evaluate(() => window.__SAKURA_QC.setCamera(7.5, 2.8, 11.5, 0, 3.6, 0));
    await page.waitForTimeout(100);
    const luma = await page.evaluate(() => {
      const c = document.querySelector('#app');
      const off = document.createElement('canvas');
      off.width = 48;
      off.height = 27;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0, 48, 27);
      const d = ctx.getImageData(0, 0, 48, 27).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return s / (48 * 27);
    });
    expect(luma, `canvas luma was ${luma} (is preserveDrawingBuffer on?)`).toBeGreaterThan(10);

    const fatal = errors.filter((e) => !/ResizeObserver|devtools/i.test(e));
    expect(fatal, fatal.join(' | ')).toEqual([]);
  });
});
