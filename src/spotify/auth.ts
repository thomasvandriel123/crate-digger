/**
 * Spotify login in the browser: Authorization Code with PKCE. No client secret and no backend, so the
 * site stays a static bundle. Tokens live in localStorage (this is a private, single-user site behind
 * basic auth and a strict CSP) and refresh automatically.
 */

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** Library read access plus what the Web Playback SDK needs to play in this tab. */
export const SCOPES = [
  'user-library-read',
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
];

const TOKEN_KEY = 'crate-digger:spotify-token';
const PENDING_KEY = 'crate-digger:spotify-login';

export interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

export class SpotifyAuthError extends Error {}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AuthDeps {
  clientId: string;
  redirectUri: string;
  storage: KV;
  session: KV;
  fetch: typeof fetch;
  now: () => number;
  crypto: Crypto;
  navigate: (url: string) => void;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair(crypto: Crypto): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function safeGet(kv: KV, key: string): string | null {
  try {
    return kv.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(kv: KV, key: string, value: string | null): void {
  try {
    if (value === null) kv.removeItem(key);
    else kv.setItem(key, value);
  } catch {
    /* storage blocked: login lasts for this page only */
  }
}

export class SpotifyAuth {
  private memoryToken: StoredToken | null = null;
  private refreshing: Promise<StoredToken> | null = null;

  constructor(private deps: AuthDeps) {}

  get token(): StoredToken | null {
    if (this.memoryToken) return this.memoryToken;
    const raw = safeGet(this.deps.storage, TOKEN_KEY);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as StoredToken;
      if (typeof t.accessToken !== 'string') return null;
      this.memoryToken = t;
      return t;
    } catch {
      return null;
    }
  }

  get isConnected(): boolean {
    return this.token !== null;
  }

  private save(token: StoredToken | null): void {
    this.memoryToken = token;
    safeSet(this.deps.storage, TOKEN_KEY, token ? JSON.stringify(token) : null);
  }

  /** Redirect to Spotify's login and consent page. `returnTo` is restored after the callback. */
  async beginLogin(returnTo: string): Promise<void> {
    const { verifier, challenge } = await pkcePair(this.deps.crypto);
    const state = base64url(this.deps.crypto.getRandomValues(new Uint8Array(16)));
    safeSet(this.deps.session, PENDING_KEY, JSON.stringify({ verifier, state, returnTo }));
    const params = new URLSearchParams({
      client_id: this.deps.clientId,
      response_type: 'code',
      redirect_uri: this.deps.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES.join(' '),
      state,
    });
    this.deps.navigate(`${AUTHORIZE_URL}?${params}`);
  }

  /**
   * Handles the redirect back from Spotify if `search` carries `code`/`error` and `state`. Returns the view
   * query to restore (without the OAuth parameters), or null when this is not a callback.
   */
  async completeLogin(search: string): Promise<{ returnTo: string } | null> {
    const params = new URLSearchParams(search);
    const code = params.get('code');
    const error = params.get('error');
    const state = params.get('state');
    if ((!code && !error) || !state) return null;
    const pendingRaw = safeGet(this.deps.session, PENDING_KEY);
    safeSet(this.deps.session, PENDING_KEY, null);
    const pending = pendingRaw
      ? (JSON.parse(pendingRaw) as { verifier: string; state: string; returnTo: string })
      : null;
    if (!pending || pending.state !== state) {
      throw new SpotifyAuthError(
        'The Spotify login could not be verified (state mismatch). Please try again.',
      );
    }
    if (error) {
      throw new SpotifyAuthError(
        error === 'access_denied' ? 'Spotify access was not granted.' : `Spotify login failed: ${error}`,
      );
    }
    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: this.deps.redirectUri,
      code_verifier: pending.verifier,
    });
    this.save(token);
    return { returnTo: pending.returnTo };
  }

  private async tokenRequest(
    body: Record<string, string>,
    previousRefresh: string | null = null,
  ): Promise<StoredToken> {
    const res = await this.deps.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, client_id: this.deps.clientId }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error_description?: string; error?: string };
        detail = j.error_description ?? j.error ?? detail;
      } catch {
        /* keep status */
      }
      throw new SpotifyAuthError(`Spotify token request failed: ${detail}`);
    }
    const j = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: j.access_token,
      // Spotify may rotate the refresh token; keep the old one if it does not send a new one.
      refreshToken: j.refresh_token ?? previousRefresh,
      expiresAt: this.deps.now() + (j.expires_in ?? 3600) * 1000,
      scope: j.scope ?? '',
    };
  }

  /** A valid access token, refreshing it first when it is about to expire. */
  async accessToken(): Promise<string> {
    const t = this.token;
    if (!t) throw new SpotifyAuthError('Not connected to Spotify.');
    if (t.expiresAt - this.deps.now() > 60_000) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Force a refresh (after a 401). Concurrent callers share one request. */
  async refresh(): Promise<StoredToken> {
    if (this.refreshing) return this.refreshing;
    const t = this.token;
    if (!t?.refreshToken) {
      this.save(null);
      throw new SpotifyAuthError('Your Spotify session expired. Please connect again.');
    }
    this.refreshing = this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: t.refreshToken },
      t.refreshToken,
    )
      .then((nt) => {
        this.save(nt);
        return nt;
      })
      .catch((err) => {
        this.save(null);
        throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  logout(): void {
    this.save(null);
  }
}

/** Configured client id: build-time env, or a `<meta name="spotify-client-id">` set by the host. */
export function configuredClientId(): string | null {
  const fromEnv = (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="spotify-client-id"]')?.content.trim();
  return meta || null;
}

/** The redirect URI must match one registered on the Spotify app exactly: this page without query. */
export function currentRedirectUri(): string {
  return `${location.origin}${location.pathname}`;
}
