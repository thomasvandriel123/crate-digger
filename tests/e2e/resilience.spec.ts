import { expect, test } from '@playwright/test';
import { counter, openRoom, snapshot, watchErrors } from './helpers';

test('without WebGL2 the library is a browsable cover grid with the same filters', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto('/?renderer=fallback');
  await expect(page.getByText(/can't show the record room/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.cover-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'Type' }).click();
  await page.getByRole('button', { name: 'Compilation' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => counter(page)).not.toBe('300 of 300 records');
  await page.locator('.cover-card').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  errs.assertClean();
});

test('the view survives WebGL context loss and restores', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(() => {
    const canvas = document.getElementById('scene') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_lose_context');
    (window as unknown as { __lose: unknown }).__lose = ext;
    ext?.loseContext();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext(),
  );
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await snapshot(page)).drawCalls, { timeout: 10_000 }).toBeGreaterThan(10);
});

test('a missing library shows a helpful message, not a blank page', async ({ page }) => {
  await page.route('**/data/library.json', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('library.json');
  await expect(page.getByRole('alert')).toContainText('ingest.run mock');
});
