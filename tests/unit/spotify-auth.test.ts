import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SpotifyApi, SpotifyApiError } from '../../src/spotify/api';
import { pkcePair, SCOPES, SpotifyAuth, SpotifyAuthError, type AuthDeps } from '../../src/spotify/auth';

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function setup(fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => json({})) {
  const storage = memory();
  const session = memory();
  let now = 1_000_000;
  const navigate = vi.fn<(url: string) => void>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(String(input), init));
  const deps: AuthDeps = {
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:5173/',
    storage,
    session,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => now,
    crypto: webcrypto as unknown as Crypto,
    navigate,
  };
  return {
    auth: new SpotifyAuth(deps),
    storage,
    session,
    navigate,
    fetchMock,
    tick: (ms: number) => (now += ms),
  };
}

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier', async () => {
    const { verifier, challenge } = await pkcePair(webcrypto as unknown as Crypto);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('SpotifyAuth', () => {
  it('sends the user to Spotify with PKCE, state and the needed scopes', async () => {
    const { auth, session, navigate } = setup();
    await auth.beginLogin('?sort=year');
    const url = new URL(navigate.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(SCOPES);
    const pending = JSON.parse(session.m.get('crate-digger:spotify-login')!);
    expect(pending.state).toBe(url.searchParams.get('state'));
    expect(pending.returnTo).toBe('?sort=year');
  });

  it('exchanges the code on the callback and stores the token', async () => {
    const { auth, navigate, fetchMock } = setup(async () =>
      json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'user-library-read' }),
    );
    await auth.beginLogin('?q=1');
    const state = new URL(navigate.mock.calls[0]![0]).searchParams.get('state');
    const result = await auth.completeLogin(`?code=CODE&state=${state}`);
    expect(result).toEqual({ returnTo: '?q=1' });
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(auth.isConnected).toBe(true);
    expect(await auth.accessToken()).toBe('AT');
  });

  it('ignores ordinary page loads and rejects a forged or refused callback', async () => {
    const { auth, navigate } = setup();
    expect(await auth.completeLogin('?sort=year')).toBeNull();
    await auth.beginLogin('');
    await expect(auth.completeLogin('?code=X&state=forged')).rejects.toBeInstanceOf(SpotifyAuthError);
    await auth.beginLogin('');
    const state = new URL(navigate.mock.calls[1]![0]).searchParams.get('state');
    await expect(auth.completeLogin(`?error=access_denied&state=${state}`)).rejects.toThrow(/not granted/);
    expect(auth.isConnected).toBe(false);
  });

  it('refreshes shortly before expiry, keeps the refresh token, and shares one request', async () => {
    let n = 0;
    const { auth, storage, tick, fetchMock } = setup(async () =>
      json({ access_token: `AT${++n}`, expires_in: 3600 }),
    );
    storage.setItem(
      'crate-digger:spotify-token',
      JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1_000_000 + 3600_000, scope: '' }),
    );
    expect(await auth.accessToken()).toBe('OLD');
    tick(3600_000 - 30_000);
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toBe('AT1');
    expect(b).toBe('AT1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.token!.refreshToken).toBe('RT');
  });

  it('signs out when the refresh is refused', async () => {
    const { auth, storage } = setup(async () => json({ error: 'invalid_grant' }, 400));
    storage.setItem(
      'crate-digger:spotify-token',
      JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0, scope: '' }),
    );
    await expect(auth.accessToken()).rejects.toBeInstanceOf(SpotifyAuthError);
    expect(auth.isConnected).toBe(false);
    expect(storage.getItem('crate-digger:spotify-token')).toBeNull();
  });
});

describe('SpotifyApi', () => {
  function connected(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    const s = setup(async (url, init) =>
      url.includes('accounts.spotify.com')
        ? json({ access_token: 'NEW', expires_in: 3600 })
        : fetchImpl(url, init),
    );
    s.storage.setItem(
      'crate-digger:spotify-token',
      JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 1e13, scope: '' }),
    );
    const waits: number[] = [];
    const api = new SpotifyApi(
      s.auth,
      s.fetchMock as unknown as typeof fetch,
      async (ms) => void waits.push(ms),
    );
    return { ...s, api, waits };
  }

  it('refreshes once on 401 and retries with the new token', async () => {
    const seen: string[] = [];
    const { api } = connected(async (_url, init) => {
      const token = (init!.headers as Record<string, string>).Authorization ?? '';
      seen.push(token);
      return token === 'Bearer AT' ? json({}, 401) : json({ id: 'me' });
    });
    expect(await api.me()).toEqual({ id: 'me' });
    expect(seen).toEqual(['Bearer AT', 'Bearer NEW']);
  });

  it('waits out 429s using Retry-After, then gives up with a typed error after repeated failures', async () => {
    let calls = 0;
    const { api, waits } = connected(async () =>
      ++calls < 3 ? json({}, 429, { 'Retry-After': '2' }) : json({ ok: 1 }),
    );
    expect(await api.get('/x')).toEqual({ ok: 1 });
    expect(waits).toEqual([2000, 2000]);

    const failing = connected(async () => json({ error: { message: 'boom' } }, 503));
    await expect(failing.api.get('/x')).rejects.toBeInstanceOf(SpotifyApiError);
    expect(failing.waits).toHaveLength(4);
  });

  it('pages through every saved album, reporting progress', async () => {
    const { api } = connected(async (url) =>
      url.includes('offset=50')
        ? json({ items: [{ album: { id: 'c' } }], next: null, total: 3 })
        : json({
            items: [{ album: { id: 'a' } }, { album: { id: 'b' } }],
            next: 'https://api.spotify.com/v1/me/albums?offset=50&limit=50',
            total: 3,
          }),
    );
    const progress: number[] = [];
    const items = await api.savedAlbums((done) => progress.push(done));
    expect(items.map((i) => i.album!.id)).toEqual(['a', 'b', 'c']);
    expect(progress).toEqual([2, 3]);
  });

  it("starts an album on this tab's device", async () => {
    const calls: [string, RequestInit][] = [];
    const { api } = connected(async (url, init) => {
      calls.push([url, init!]);
      return new Response(null, { status: 204 });
    });
    await api.playAlbum('dev 1', 'spotify:album:a');
    expect(calls[0]![0]).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev%201');
    expect(calls[0]![1].method).toBe('PUT');
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ context_uri: 'spotify:album:a' });
  });
});
