import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export interface Snapshot {
  p95: number;
  mean: number;
  samples: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  coverMB: number;
  pixelRatio: number;
  focus: number;
  activeCrate: number;
  hold: string;
  deck: string;
  moving: boolean;
}

/** Collects page errors and console errors; call `assertClean()` at the end of a test. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return {
    errors,
    assertClean: () => expect(errors, errors.join('\n')).toEqual([]),
  };
}

/** Opens the room and waits for the first frame and a focused record. */
export async function openRoom(page: Page, query = '') {
  await page.goto(`/${query}`);
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('.caption-plate:not(.is-out) .title')).not.toBeEmpty();
}

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() =>
    (window as unknown as { __crateDigger: { snapshot(): Snapshot } }).__crateDigger.snapshot(),
  );
}

export async function captionTitle(page: Page): Promise<string> {
  return (await page.locator('.caption-plate:not(.is-out) .title').last().textContent()) ?? '';
}

export async function counter(page: Page): Promise<string> {
  return (await page.locator('.counter').textContent()) ?? '';
}

/**
 * Waits until nothing in the scene is animating (software GL runs at a few fps, and the 50 ms frame-delta
 * clamp stretches animations accordingly), then a little longer for the frame to be presented.
 */
export async function settle(page: Page, maxMs = 30_000) {
  await expect
    .poll(async () => (await snapshot(page)).moving, { timeout: maxMs, intervals: [250] })
    .toBe(false);
  await page.waitForTimeout(300);
}

const SERIOUS = ['serious', 'critical'];

/** Serious or critical WCAG 2.1 AA violations on the page, as readable strings (empty when clean). */
export async function scanA11y(page: Page): Promise<string[]> {
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
