import { test, expect } from '@playwright/test';

const collectErrors = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/WebSocket connection|ERR_CONNECTION_REFUSED|\[vite\]/i.test(text)) return;
    errors.push(text);
  });
  return errors;
};

async function openViewTab(page) {
  const tab = page.getByTestId('tab-view');
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click({ timeout: 30_000, noWaitAfter: true });
  await expect(page.getByTestId('look-photoreal')).toBeVisible({ timeout: 15_000 });
}

async function bootInteractive(page, query = '') {
  await page.goto(`/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SAKURA_QC?.ready === true, null, { timeout: 90_000 });
  await openViewTab(page);
}

test.describe('render looks', () => {
  test('view tab selects photoreal and ghibli', async ({ page }) => {
    const errors = collectErrors(page);
    await bootInteractive(page);

    const photoreal = page.getByTestId('look-photoreal');
    const ghibli = page.getByTestId('look-ghibli');
    await expect(photoreal).toBeVisible();
    await expect(ghibli).toBeVisible();
    await expect(photoreal).toHaveText('Photorealistic');
    await expect(ghibli).toHaveText('Anime-Ghibli');
    await expect(photoreal).toHaveClass(/\bon\b/);
    await expect(ghibli).not.toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => window.__SAKURA_QC.gradeEnabled())).toBe(false);

    await ghibli.click();
    await expect(ghibli).toHaveClass(/\bon\b/);
    await expect(photoreal).not.toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => window.__SAKURA_QC.gradeEnabled())).toBe(true);

    await photoreal.click();
    await expect(photoreal).toHaveClass(/\bon\b/);
    await expect(ghibli).not.toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => window.__SAKURA_QC.gradeEnabled())).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('saved look restores, and a valid query replaces it', async ({ page }) => {
    test.setTimeout(480_000);
    const errors = collectErrors(page);
    await bootInteractive(page);
    await page.getByTestId('look-ghibli').click();
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-msg')).toContainText('Saved');

    const stored = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('sakura.v12.settings') || 'null');
      return data?.values?.renderLook ?? null;
    });
    expect(stored).toBe('ghibli');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SAKURA_QC?.ready === true, null, { timeout: 90_000 });
    await openViewTab(page);
    await expect(page.getByTestId('look-ghibli')).toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => window.__SAKURA_QC.gradeEnabled())).toBe(true);

    await page.goto('/?look=photoreal', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SAKURA_QC?.ready === true, null, { timeout: 90_000 });
    await openViewTab(page);
    await expect(page.getByTestId('look-photoreal')).toHaveClass(/\bon\b/);
    await expect(page.getByTestId('look-ghibli')).not.toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => window.__SAKURA_QC.gradeEnabled())).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('qc mode does not install the grade for a look query', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/?qc=1&look=ghibli', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SAKURA_QC?.ready === true, null, { timeout: 90_000 });
    await expect(page.getByTestId('control-panel')).toHaveCount(0);
    expect(await page.evaluate(() => window.__SAKURA_QC.gradeEnabled())).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
