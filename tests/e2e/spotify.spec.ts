import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, type Route, test } from '@playwright/test';
import { scanA11y, watchErrors } from './helpers';

/**
 * The Spotify connection end to end, against a fake Spotify: the login page, token endpoint, Web API and
 * Web Playback SDK are all served by page.route, so the test runs offline and never touches an account.
 */

const ORIGIN = 'http://127.0.0.1:4173';
const RITUAL_MS = 60_000;

const ALBUMS = [
  { id: 'sp1', name: 'Saved One', artist: 'First Artist', date: '1971-03-01' },
  { id: 'sp2', name: 'Saved Two', artist: 'Second Artist', date: '1985-06-10' },
  { id: 'sp3', name: 'Saved Three', artist: 'Third Artist', date: '2003-11-20' },
];

const coverDir = join(process.cwd(), 'data', 'covers', '256');
const cover = readFileSync(
  join(
    coverDir,
    readdirSync(coverDir).find((f) => f.endsWith('.webp'))!,
  ),
);

function savedAlbums() {
  return {
    total: ALBUMS.length,
    next: null,
    items: ALBUMS.map((a, i) => ({
      added_at: `2024-0${i + 1}-01T00:00:00Z`,
      album: {
        id: a.id,
        uri: `spotify:album:${a.id}`,
        name: a.name,
        album_type: 'album',
        release_date: a.date,
        total_tracks: 2,
        artists: [{ id: `artist-${a.id}`, name: a.artist }],
        images: [
          { url: `https://i.scdn.co/image/${a.id}-640`, width: 640, height: 640 },
          { url: `https://i.scdn.co/image/${a.id}-300`, width: 300, height: 300 },
          { url: `https://i.scdn.co/image/${a.id}-64`, width: 64, height: 64 },
        ],
        tracks: {
          next: null,
          items: [
            { uri: `spotify:track:${a.id}a`, name: 'Side A', track_number: 1, duration_ms: 240_000 },
            { uri: `spotify:track:${a.id}b`, name: 'Side B', track_number: 2, duration_ms: 200_000 },
          ],
        },
      },
    })),
  };
}

/** A stand-in for sdk.scdn.co/spotify-player.js: a player that becomes ready and records what it is asked. */
const FAKE_SDK = `
  window.__sdk = { activated: false };
  window.Spotify = { Player: class {
    constructor(opts) { this.opts = opts; this.l = {}; window.__sdk.player = this; }
    addListener(e, cb) { this.l[e] = cb; return true; }
    connect() { setTimeout(() => this.l.ready && this.l.ready({ device_id: 'e2e-device' }), 50); return Promise.resolve(true); }
    disconnect() {}
    pause() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    activateElement() { window.__sdk.activated = true; return Promise.resolve(); }
  } };
  window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady();
`;

interface FakeSpotify {
  plays: { deviceId: string | null; body: unknown }[];
  authorizeUrls: URL[];
  tokenRequests: URLSearchParams[];
}

async function fakeSpotify(page: Page): Promise<FakeSpotify> {
  const fake: FakeSpotify = { plays: [], authorizeUrls: [], tokenRequests: [] };
  // The site is built without a client id; supply one the way a host can, with a meta tag.
  await page.route(
    (url) => url.origin === ORIGIN && url.pathname === '/',
    async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(
        '<head>',
        '<head><meta name="spotify-client-id" content="e2e-client" />',
      );
      await route.fulfill({ response: res, body: html });
    },
  );
  await page.route('https://accounts.spotify.com/authorize**', async (route) => {
    const url = new URL(route.request().url());
    fake.authorizeUrls.push(url);
    // The user logs in and approves: Spotify redirects back with a code.
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'e2e-code');
    back.searchParams.set('state', url.searchParams.get('state')!);
    // (A page that navigates, rather than a 302, so the return trip goes through page.route again.)
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Spotify</title><script>location.replace(${JSON.stringify(back.toString())})</script>`,
    });
  });
  await page.route('https://accounts.spotify.com/api/token', async (route) => {
    fake.tokenRequests.push(new URLSearchParams(route.request().postData() ?? ''));
    await json(route, {
      access_token: 'e2e-access',
      refresh_token: 'e2e-refresh',
      expires_in: 3600,
      scope: '',
    });
  });
  await page.route('https://api.spotify.com/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.headers().authorization !== 'Bearer e2e-access')
      return json(route, { error: { status: 401 } }, 401);
    if (url.pathname === '/v1/me/albums') return json(route, savedAlbums());
    if (url.pathname === '/v1/me') return json(route, { id: 'digger', display_name: 'Test Digger' });
    if (url.pathname.startsWith('/v1/artists/')) return json(route, { genres: ['shoegaze'] });
    if (url.pathname === '/v1/me/player/play' && req.method() === 'PUT') {
      fake.plays.push({ deviceId: url.searchParams.get('device_id'), body: req.postDataJSON() });
      return route.fulfill({ status: 204 });
    }
    return json(route, { error: { status: 404 } }, 404);
  });
  await page.route('https://i.scdn.co/**', (route) =>
    route.fulfill({
      body: cover,
      contentType: 'image/webp',
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  );
  await page.route('https://sdk.scdn.co/**', (route) =>
    route.fulfill({ body: FAKE_SDK, contentType: 'application/javascript' }),
  );
  return fake;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
}

async function waitForRoom(page: Page) {
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('.caption-plate:not(.is-out) .title')).not.toBeEmpty();
}

test.describe('Spotify connection', () => {
  test('Connect logs in with PKCE and shelves only the saved albums', async ({ page }) => {
    const errors = watchErrors(page);
    const fake = await fakeSpotify(page);
    await page.goto('/?sort=year');
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);

    await page.getByRole('button', { name: 'Bring your records' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bring your records' });
    await expect(dialog).toBeVisible();
    expect(await scanA11y(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Connect Spotify' }).click();
    await expect.poll(() => fake.tokenRequests.length, { timeout: 30_000 }).toBe(1);

    const auth = fake.authorizeUrls[0]!;
    expect(auth.searchParams.get('client_id')).toBe('e2e-client');
    expect(auth.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toContain('user-library-read');
    expect(auth.searchParams.get('scope')).toContain('streaming');
    expect(fake.tokenRequests[0]!.get('code')).toBe('e2e-code');
    expect(fake.tokenRequests[0]!.get('code_verifier')).toBeTruthy();

    await waitForRoom(page);
    // Only the account's saved albums: the 300-record library on disk is not shown.
    await expect(page.locator('.counter')).toHaveText(/3 of 3 records/);
    const options = page.getByRole('listbox', { name: /Records/ }).getByRole('option');
    await expect(options).toHaveCount(3);
    for (const a of ALBUMS) await expect(options.filter({ hasText: a.name })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Test Digger/ })).toBeVisible();
    // The one-time code is gone from the address bar; the view the user left from is back.
    const url = new URL(page.url());
    expect(url.searchParams.get('sort')).toBe('year');
    expect(url.searchParams.has('code')).toBe(false);
    expect(url.searchParams.has('state')).toBe(false);
    errors.assertClean();
  });

  test('a saved album plays on this tab, and Disconnect forgets the account', async ({ page }) => {
    const errors = watchErrors(page);
    const fake = await fakeSpotify(page);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-seeded')) return;
      sessionStorage.setItem('e2e-seeded', '1');
      localStorage.setItem(
        'crate-digger:spotify-token',
        JSON.stringify({
          accessToken: 'e2e-access',
          refreshToken: 'r',
          expiresAt: Date.now() + 3600_000,
          scope: '',
        }),
      );
    });
    await page.goto('/');
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/3 of 3 records/);

    const list = page.getByRole('listbox', { name: /Records/ });
    await list.focus();
    const focused = (await list.locator('[role="option"][aria-selected="true"]').textContent()) ?? '';
    const album = ALBUMS.find((a) => focused.includes(a.name))!;
    await page.keyboard.press('Enter');
    await expect(page.getByRole('toolbar', { name: 'Record in hand' })).toBeVisible({ timeout: RITUAL_MS });
    await page.keyboard.press('Space');

    const deck = page.getByRole('region', { name: 'Turntable' });
    await expect(deck.getByText('Now playing')).toBeVisible({ timeout: RITUAL_MS });
    await expect.poll(() => fake.plays.length).toBe(1);
    expect(fake.plays[0]).toEqual({
      deviceId: 'e2e-device',
      body: { context_uri: `spotify:album:${album.id}` },
    });
    // Real playback: no "no sound" note, and the player was unlocked by the key press.
    await expect(deck.locator('.np-note')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __sdk: { activated: boolean } }).__sdk.activated),
    ).toBe(true);

    await page.getByRole('button', { name: /Test Digger/ }).click();
    await expect(page.getByRole('group', { name: 'Spotify account' })).toContainText('3 albums saved');
    expect(await scanA11y(page)).toEqual([]);
    await page.getByRole('button', { name: 'Disconnect Spotify' }).click();
    await waitForRoom(page);
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);
    await expect(page.getByRole('button', { name: 'Bring your records' })).toBeVisible();
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('crate-digger:spotify')),
    );
    expect(stored).toEqual([]);
    errors.assertClean();
  });

  test('without Premium the record still plays, with a way to open it in Spotify', async ({ page }) => {
    await fakeSpotify(page);
    await page.route('https://sdk.scdn.co/**', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: FAKE_SDK.replace(
          "this.l.ready && this.l.ready({ device_id: 'e2e-device' })",
          "this.l.account_error && this.l.account_error({ message: 'Premium required' })",
        ),
      }),
    );
    await page.addInitScript(() =>
      localStorage.setItem(
        'crate-digger:spotify-token',
        JSON.stringify({
          accessToken: 'e2e-access',
          refreshToken: 'r',
          expiresAt: Date.now() + 3600_000,
          scope: '',
        }),
      ),
    );
    await page.goto('/');
    await waitForRoom(page);
    await page.getByRole('listbox', { name: /Records/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('toolbar', { name: 'Record in hand' })).toBeVisible({ timeout: RITUAL_MS });
    await page.keyboard.press('Space');
    const deck = page.getByRole('region', { name: 'Turntable' });
    await expect(deck.getByText('Now playing')).toBeVisible({ timeout: RITUAL_MS });
    await expect(deck.locator('.np-note')).toContainText('Premium');
    await expect(deck.getByRole('link', { name: 'Open in Spotify' })).toHaveAttribute(
      'href',
      /^https:\/\/open\.spotify\.com\/album\/sp\d$/,
    );
  });

  test('an account the app is not allowed to serve is told why and offered the upload', async ({ page }) => {
    const fake = await fakeSpotify(page);
    // Development-mode apps answer 403 for accounts not added in the Spotify dashboard.
    await page.route('https://api.spotify.com/v1/me/albums**', (route) =>
      json(route, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } }, 403),
    );
    await page.goto('/');
    await waitForRoom(page);
    await page.getByRole('button', { name: 'Bring your records' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect Spotify' }).click();
    await expect.poll(() => fake.tokenRequests.length, { timeout: 30_000 }).toBe(1);
    await waitForRoom(page);
    // Back in the demo crates, with the reason and the upload right there.
    await expect(page.locator('.counter')).toHaveText(/300 of 300 records/);
    const dialog = page.getByRole('dialog', { name: 'Bring your records' });
    await expect(dialog.getByRole('alert')).toContainText('invite-only');
    await expect(dialog.getByText('Choose the zip or YourLibrary.json')).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('crate-digger:spotify-token'));
    expect(stored).toBeNull();
  });

  test('with no library on disk, the welcome panel offers both ways in', async ({ page }) => {
    await fakeSpotify(page);
    await page.route(`${ORIGIN}/data/library.json`, (route) =>
      route.fulfill({ status: 404, body: 'Not found' }),
    );
    await page.goto('/');
    const welcome = page.getByRole('region', { name: 'Welcome' });
    await expect(welcome).toBeVisible({ timeout: 30_000 });
    await expect(welcome.getByRole('button', { name: 'Connect Spotify' })).toBeVisible();
    await expect(welcome.getByText('Choose the zip or YourLibrary.json')).toBeVisible();
    expect(await scanA11y(page)).toEqual([]);
  });
});
