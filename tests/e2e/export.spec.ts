import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, type Route, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { scanA11y, watchErrors } from './helpers';

/**
 * Bring your own records without a Spotify login: upload the data export, see the albums at once, and
 * watch covers and years arrive from (a fake) MusicBrainz and Cover Art Archive.
 */

const RITUAL_MS = 60_000;

const EXPORT = {
  tracks: [],
  albums: [
    { artist: 'Radiohead', album: 'OK Computer', uri: 'spotify:album:okc0000000000000000000' },
    {
      artist: 'Nina Simone',
      album: 'Pastel Blues (Remastered)',
      uri: 'spotify:album:pastel00000000000000000',
    },
    { artist: 'Nobody Knows', album: 'Unfindable', uri: 'spotify:album:nothing0000000000000000' },
  ],
};

const MATCHES: Record<string, { id: string; date: string; tags: string[] }> = {
  'OK Computer': { id: 'rg-okc', date: '1997-05-21', tags: ['art rock'] },
  'Pastel Blues': { id: 'rg-pastel', date: '1965-10-01', tags: ['jazz', 'soul'] },
};

const coverDir = join(process.cwd(), 'data', 'covers', '256');
const cover = readFileSync(
  join(
    coverDir,
    readdirSync(coverDir).find((f) => f.endsWith('.webp'))!,
  ),
);

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
}

async function fakeMusicBrainz(page: Page) {
  const seen = { searches: [] as string[], releases: 0, covers: 0 };
  await page.route('https://musicbrainz.org/ws/2/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ws/2/release-group/') {
      const query = url.searchParams.get('query') ?? '';
      seen.searches.push(query);
      const title = /releasegroup:"([^"]+)"/.exec(query)?.[1] ?? '';
      const m = MATCHES[title];
      return json(route, {
        'release-groups': m
          ? [
              {
                id: m.id,
                score: 100,
                title,
                'first-release-date': m.date,
                'primary-type': 'Album',
                'artist-credit': [{ name: /artist:"([^"]+)"/.exec(query)?.[1] }],
                tags: m.tags.map((name) => ({ name, count: 3 })),
              },
            ]
          : [],
      });
    }
    if (url.pathname === '/ws/2/release') {
      seen.releases++;
      return json(route, {
        releases: [
          {
            status: 'Official',
            date: '1997-05-21',
            'label-info': [{ label: { name: 'Parlophone' } }],
            media: [
              {
                tracks: [
                  { position: 1, title: 'Airbag', length: 284_000 },
                  { position: 2, title: 'Paranoid Android', length: 383_000 },
                ],
              },
            ],
          },
        ],
      });
    }
    return json(route, {}, 404);
  });
  await page.route('https://coverartarchive.org/**', (route) => {
    seen.covers++;
    return route.fulfill({
      body: cover,
      contentType: 'image/webp',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
  return seen;
}

async function waitForRoom(page: Page) {
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('.caption-plate:not(.is-out) .title')).not.toBeEmpty();
}

const exportZip = () =>
  Buffer.from(
    zipSync({
      'Spotify Account Data/Read Me First.pdf': new Uint8Array([37, 80, 68, 70]),
      'Spotify Account Data/YourLibrary.json': strToU8(JSON.stringify(EXPORT)),
    }),
  );

test.describe('uploaded Spotify export', () => {
  test('upload, browse at once, and covers and years fill in from MusicBrainz', async ({ page }) => {
    const errors = watchErrors(page);
    const mb = await fakeMusicBrainz(page);
    await page.goto('/');
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);

    await page.getByRole('button', { name: 'Bring your records' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bring your records' });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'my_spotify_data.zip',
      mimeType: 'application/zip',
      buffer: exportZip(),
    });

    // Only the uploaded albums are on the shelves.
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/3 of 3 records/);
    const options = page.getByRole('listbox', { name: /Records/ }).getByRole('option');
    await expect(options).toHaveCount(3);

    // About one lookup per second; years arrive and the records are refiled.
    await expect.poll(() => mb.searches.length, { timeout: 20_000 }).toBe(3);
    expect(mb.searches[1]).toBe('releasegroup:"Pastel Blues" AND artist:"Nina Simone"');
    await expect(options.filter({ hasText: '1997' })).toHaveCount(1, { timeout: 20_000 });
    await expect(options.filter({ hasText: '1965' })).toHaveCount(1);
    expect(mb.covers).toBeGreaterThanOrEqual(2);

    const menuButton = page.getByRole('button', { name: 'Your records' });
    await menuButton.click();
    const menu = page.getByRole('group', { name: 'Your records' });
    await expect(menu).toContainText('Found 2 of 3 albums');
    expect(await scanA11y(page)).toEqual([]);
    await page.keyboard.press('Escape');

    // A held record gets its track list on demand; playing it offers Spotify.
    const list = page.getByRole('listbox', { name: /Records/ });
    await list.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('toolbar', { name: 'Record in hand' })).toBeVisible({ timeout: RITUAL_MS });
    await expect.poll(() => mb.releases, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await page.keyboard.press('Space');
    const deck = page.getByRole('region', { name: 'Turntable' });
    await expect(deck.getByText('Now playing')).toBeVisible({ timeout: RITUAL_MS });
    await expect(deck.locator('.np-note')).toContainText('without sound');
    await expect(deck.getByRole('link', { name: 'Open in Spotify' })).toHaveAttribute(
      'href',
      /^https:\/\/open\.spotify\.com\/album\/[a-z0-9]+$/,
    );
    errors.assertClean();
  });

  test('a returning visitor gets their crates back without new lookups, and can forget them', async ({
    page,
  }) => {
    const mb = await fakeMusicBrainz(page);
    await page.goto('/');
    await waitForRoom(page);
    await page.getByRole('button', { name: 'Bring your records' }).click();
    await page
      .getByRole('dialog')
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'YourLibrary.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(EXPORT)),
      });
    await waitForRoom(page);
    await expect.poll(() => mb.searches.length, { timeout: 20_000 }).toBe(3);
    await page.waitForTimeout(1500);

    await page.reload();
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/3 of 3 records/);
    await page.waitForTimeout(3000);
    expect(mb.searches).toHaveLength(3);

    await page.getByRole('button', { name: 'Your records' }).click();
    await page.getByRole('button', { name: 'Forget my records' }).click();
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /export|mb-/.test(k)));
    expect(keys).toEqual([]);
  });

  test('the wrong file gets a clear explanation', async ({ page }) => {
    await page.goto('/');
    await waitForRoom(page);
    await page.getByRole('button', { name: 'Bring your records' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'StreamingHistory.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({ 'MyData/StreamingHistory0.json': strToU8('[]') })),
    });
    await expect(dialog.getByRole('alert')).toContainText('No YourLibrary.json');
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);
  });
});
