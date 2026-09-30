import { expect, test } from '@playwright/test';
import { captionTitle, counter, openRoom, settle, snapshot, watchErrors } from './helpers';

/**
 * The play ritual is ~4 s of animation. Under software GL (CI) frames take hundreds of ms and the 50 ms
 * frame-delta clamp stretches it, so allow generous wall-clock time.
 */
const RITUAL_MS = 120_000;

test.describe('the record room', () => {
  test('opens on the mock library with a focused record and no errors', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);
    const snap = await snapshot(page);
    expect(snap.drawCalls).toBeGreaterThan(10);
    expect(snap.drawCalls).toBeLessThanOrEqual(250);
    expect(snap.triangles).toBeLessThanOrEqual(300_000);
    await settle(page);
    await page.screenshot({ path: 'test-results/screens/room.png' });
    errs.assertClean();
  });

  test('keyboard flips through the crate and switches crates', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    const first = await captionTitle(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => captionTitle(page)).not.toBe(first);
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => (await snapshot(page)).focus, { timeout: 5000 }).toBeCloseTo(6, 0);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await snapshot(page)).activeCrate).toBe(1);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await snapshot(page)).activeCrate).toBe(0);
    errs.assertClean();
  });

  test('hold, flip and put back', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('toolbar', { name: 'Record in hand' })).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).hold).toBe('held');
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: /Front/ })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: 'test-results/screens/held-back.png' });
    await page.keyboard.press('f');
    await settle(page);
    await page.screenshot({ path: 'test-results/screens/held-front.png' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('toolbar', { name: 'Record in hand' })).toHaveCount(0);
    await expect.poll(async () => (await snapshot(page)).hold).toBe('idle');
    errs.assertClean();
  });

  test('the turntable ritual: play, pause, put away', async ({ page }) => {
    test.setTimeout(RITUAL_MS * 3);
    const errs = watchErrors(page);
    await openRoom(page);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot(page)).hold).toBe('held');
    await page.keyboard.press('Space');
    const deck = page.getByRole('region', { name: 'Turntable' });
    await expect(deck).toBeVisible();
    await expect(deck.getByText('Now playing')).toBeVisible({ timeout: RITUAL_MS });
    // The platter keeps turning while playing, so the scene never "settles"; give it a moment instead.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/screens/playing.png' });
    await deck.getByRole('button', { name: /Pause/ }).click();
    await expect(deck.getByText('Paused')).toBeVisible();
    await deck.getByRole('button', { name: /Put away/ }).click();
    await expect(deck).toHaveCount(0, { timeout: RITUAL_MS });
    expect((await snapshot(page)).deck).toBe('empty');
    errs.assertClean();
  });

  test('loading a second record while one plays puts the first away first', async ({ page }) => {
    test.setTimeout(RITUAL_MS * 4);
    const errs = watchErrors(page);
    await openRoom(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    const deck = page.getByRole('region', { name: 'Turntable' });
    await expect(deck.getByText('Now playing')).toBeVisible({ timeout: RITUAL_MS });
    const firstTitle = await deck.locator('.np-title').textContent();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot(page)).hold, { timeout: 60_000 }).toBe('held');
    await page.keyboard.press('Space');
    // Put-away of the first record runs first, then the new one is cued: wait for the title to change.
    await expect(deck.locator('.np-title')).not.toHaveText(firstTitle ?? '', { timeout: RITUAL_MS * 2 });
    await expect(deck.getByText('Now playing')).toBeVisible({ timeout: RITUAL_MS });
    errs.assertClean();
  });

  test('filters re-shelve, show chips, live in the URL and survive a reload', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    await page.getByRole('button', { name: 'Colour' }).click();
    await page.getByRole('button', { name: 'Blue', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.chip', { hasText: 'Blue' })).toBeVisible();
    await expect.poll(() => counter(page)).toMatch(/^\d+ of 300 records$/);
    const filtered = await counter(page);
    expect(filtered).not.toContain('300 of 300');
    await expect(page).toHaveURL(/colour=blue/);
    await settle(page);
    // The focused record is written to the URL too (r=), so a reload lands on it.
    await expect(page).toHaveURL(/[?&]r=/);
    const focusedBefore = await captionTitle(page);
    await page.screenshot({ path: 'test-results/screens/filtered-blue.png' });

    await page.reload();
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 45_000 });
    await expect(page.locator('.chip', { hasText: 'Blue' })).toBeVisible();
    await expect.poll(() => counter(page)).toBe(filtered);
    await expect.poll(() => captionTitle(page)).toBe(focusedBefore);

    await page.getByRole('button', { name: 'Remove filter: Blue' }).click();
    await expect.poll(() => counter(page)).toBe('300 of 300 records');
    errs.assertClean();
  });

  test('sort modes change the arrangement and the back button restores it', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    await page.getByRole('button', { name: /^Sort:/ }).click();
    await page.getByRole('radio', { name: 'Colour sweep' }).check();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/sort=colour/);
    await settle(page);
    await page.screenshot({ path: 'test-results/screens/colour-sweep.png' });
    await page.goBack();
    await expect(page).not.toHaveURL(/sort=colour/);
    await expect(page.getByRole('button', { name: /^Sort: Artist/ })).toBeVisible();
    errs.assertClean();
  });

  test('search narrows the crates, Enter focuses the best match, and the empty state recovers', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    const target = await captionTitle(page);
    await page.keyboard.press('/');
    await expect(page.locator('#search')).toBeFocused();
    await page.keyboard.type(target.slice(0, Math.min(10, target.length)));
    await expect.poll(() => counter(page)).not.toBe('300 of 300 records');
    await page.keyboard.press('Enter');
    await expect.poll(() => captionTitle(page)).toBe(target);

    await page.locator('#search').fill('zzqqxxnothingmatches');
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: 'test-results/screens/empty.png' });
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect.poll(() => counter(page)).toBe('300 of 300 records');
    errs.assertClean();
  });

  test('pointer: wheel scrolls the crate, clicking the focused record pulls it', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page);
    await page.mouse.move(720, 520);
    const before = (await snapshot(page)).focus;
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(60);
    }
    await expect
      .poll(async () => (await snapshot(page)).focus, { timeout: 5000 })
      .toBeGreaterThan(before + 1);
    errs.assertClean();
  });

  test('phone portrait: one crate, filters in a bottom sheet', async ({ page }) => {
    const errs = watchErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters and sort' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Single/EP' }).click();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.chip', { hasText: 'Single/EP' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: 'test-results/screens/portrait.png' });
    errs.assertClean();
  });

  test('reduced motion still works end to end', async ({ page }) => {
    const errs = watchErrors(page);
    await openRoom(page, '?motion=reduced');
    const first = await captionTitle(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => captionTitle(page)).not.toBe(first);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot(page)).hold).toBe('held');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await snapshot(page)).hold).toBe('idle');
    errs.assertClean();
  });
});
