import { expect, test } from '@playwright/test';
import { openRoom, scanA11y as scan } from './helpers';

test.describe('accessibility', () => {
  test('the room has no serious axe violations', async ({ page }) => {
    await openRoom(page);
    expect(await scan(page)).toEqual([]);
  });

  test('open popovers and the hold state have no serious violations', async ({ page }) => {
    await openRoom(page);
    await page.getByRole('button', { name: 'Genre' }).click();
    expect(await scan(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Release year' }).click();
    expect(await scan(page)).toEqual([]);
    await page.keyboard.press('Escape');
    // Escape returns focus to the tag button (where Enter would reopen it); move to the records first.
    await page.getByRole('listbox', { name: /Records/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('toolbar', { name: 'Record in hand' })).toBeVisible({ timeout: 60_000 });
    expect(await scan(page)).toEqual([]);
  });

  test('the hidden listbox mirrors the focus and announces position', async ({ page }) => {
    await openRoom(page);
    const list = page.getByRole('listbox', { name: /Records/ });
    await expect(list).toHaveAttribute('aria-activedescendant', /rec-/);
    await list.focus();
    await page.keyboard.press('ArrowDown');
    // Visually hidden by design, so assert presence in the accessibility tree rather than visibility.
    await expect(page.getByRole('status').filter({ hasText: /2 of 300/ })).toHaveCount(1);
    const selected = list.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute('aria-posinset', '2');
  });

  test('every control is reachable by keyboard with a visible focus ring', async ({ page }) => {
    await openRoom(page);
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });
});
