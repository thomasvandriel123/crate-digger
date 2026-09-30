import { expect, test } from '@playwright/test';
import { openRoom, snapshot } from './helpers';

/**
 * Frame-time budget: scroll the crate programmatically for 30 s and check the 95th percentile frame time
 * (16.6 ms at 1080p on an integrated GPU). Budgets only mean something on real hardware, so the test
 * records numbers everywhere and fails only with PERF_STRICT=1.
 */
test.skip(!process.env.PERF, 'set PERF=1 to run the frame-time test');

test('fast scrolling across the library holds the frame budget', async ({ page }, info) => {
  test.setTimeout(120_000);
  await openRoom(page, '?motion=full');
  const durationMs = Number(process.env.PERF_SECONDS ?? 30) * 1000;
  const start = Date.now();
  let dir = 1;
  let crate = 0;
  while (Date.now() - start < durationMs) {
    await page.evaluate(
      (v) => (window as unknown as { __crateDigger: { impulse(v: number): void } }).__crateDigger.impulse(v),
      dir * 30,
    );
    await page.waitForTimeout(400);
    const s = await snapshot(page);
    if (s.focus > 40) dir = -1;
    if (s.focus < 2) {
      dir = 1;
      crate = (crate + 1) % 3;
      await page.keyboard.press(crate === 0 ? 'Home' : 'ArrowRight');
    }
  }
  const s = await snapshot(page);
  const report = `p95 ${s.p95.toFixed(1)} ms, mean ${s.mean.toFixed(1)} ms over ${s.samples} frames; ${s.drawCalls} draws, ${s.triangles} tris, covers ${s.coverMB.toFixed(1)} MB, pixel ratio ${s.pixelRatio}`;
  console.info(report);
  info.annotations.push({ type: 'perf', description: report });
  expect(s.drawCalls).toBeLessThanOrEqual(250);
  expect(s.triangles).toBeLessThanOrEqual(300_000);
  expect(s.coverMB).toBeLessThanOrEqual(256);
  if (process.env.PERF_STRICT) expect(s.p95).toBeLessThanOrEqual(Number(process.env.PERF_BUDGET_MS ?? 16.6));
});
