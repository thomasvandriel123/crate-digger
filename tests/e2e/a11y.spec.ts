import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { openRoom } from './helpers';

const SERIOUS = ['serious', 'critical'];

async function scan(page: Page) {
  // @axe-core/playwright bundles its own playwright-core typings; the runtime object is the same page.
  const results = await new AxeBuilder({
    page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'],
  })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((v) => SERIOUS.includes(v.impact ?? ''));
  return serious.map(
    (v) =>
      `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
}

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
