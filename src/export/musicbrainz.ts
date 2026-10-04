/**
 * MusicBrainz and the Cover Art Archive, from the browser. MusicBrainz allows about one request per second
 * per IP; requests run from the visitor's own browser, so each visitor gets their own budget and the site
 * needs no server or API key. A single queue paces every request (with a little margin), backs off on 503,
 * and lets on-demand lookups (the record in your hand) jump ahead of the background job.
 *
 * Metadata from MusicBrainz is CC0; cover images belong to their rights holders and are hot-linked from the
 * Cover Art Archive, never stored on the site's server.
 */

import { fold } from '../data/text';

export const MB_API = 'https://musicbrainz.org/ws/2';
export const CAA = 'https://coverartarchive.org';

export interface MbMatch {
  /** MusicBrainz release-group id. */
  rg: string;
  title: string;
  date: string | null;
  type: 'album' | 'single' | 'compilation';
  /** Folksonomy tags, best first (MusicBrainz genres are a curated subset of tags). */
  tags: string[];
  score: number;
}

export interface MbTracks {
  tracks: { n: number; title: string; durationMs: number }[];
  label: string | null;
}

interface Job<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  priority: number;
  signal?: AbortSignal | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MbAbort extends Error {}

/** One request at a time, at most one per `intervalMs`, highest priority (lowest number) first. */
export class PoliteQueue {
  private jobs: Job<unknown>[] = [];
  private running = false;
  private last = -Infinity;

  constructor(
    private intervalMs = 1100,
    private now: () => number = () => Date.now(),
    private wait: (ms: number) => Promise<unknown> = sleep,
  ) {}

  get pending(): number {
    return this.jobs.length;
  }

  /** Push the next request out, e.g. after a 503 from the server. */
  backoff(ms: number): void {
    this.last = Math.max(this.last, this.now() + ms - this.intervalMs);
  }

  add<T>(run: () => Promise<T>, priority = 10, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ run, resolve, reject, priority, signal } as Job<unknown>);
      this.jobs.sort((a, b) => a.priority - b.priority);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift()!;
        if (job.signal?.aborted) {
          job.reject(new MbAbort('aborted'));
          continue;
        }
        const gap = this.last + this.intervalMs - this.now();
        if (gap > 0) await this.wait(gap);
        this.last = this.now();
        try {
          job.resolve(await job.run());
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Remastered/deluxe/live suffixes Spotify adds to titles, which MusicBrainz files separately or not at all. */
export function cleanTitle(title: string): string {
  return title
    .replace(
      /\s*[([][^)\]]*\b(remaster(ed)?|deluxe|expanded|anniversary|edition|version|bonus|mono|stereo|reissue)\b[^)\]]*[)\]]/gi,
      '',
    )
    .replace(/\s+-\s+.*\b(remaster(ed)?|deluxe|expanded|anniversary|edition|version|reissue)\b.*$/i, '')
    .trim();
}

const comparable = (s: string) =>
  fold(s)
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Lucene-escape a phrase for a MusicBrainz search query. */
export function luceneQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

interface SearchRG {
  id: string;
  score?: number;
  title?: string;
  'first-release-date'?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'artist-credit'?: { name?: string; artist?: { name?: string } }[];
  tags?: { name?: string; count?: number }[];
}

/** The best release group for an artist + title among search results, or null when none is convincing. */
export function pickMatch(artist: string, title: string, groups: SearchRG[]): MbMatch | null {
  const wantTitle = comparable(cleanTitle(title));
  const wantArtist = comparable(artist);
  const ranked = groups
    .filter((g) => g?.id)
    .map((g) => {
      const t = comparable(g.title ?? '');
      const credit = comparable(
        (g['artist-credit'] ?? []).map((c) => c.name ?? c.artist?.name ?? '').join(' '),
      );
      const titleOk = t === wantTitle;
      const artistOk = !wantArtist || credit.includes(wantArtist) || wantArtist.includes(credit);
      // Exact title + artist beats raw search score; an album beats a single of the same name.
      const bonus = (titleOk ? 100 : 0) + (artistOk ? 50 : 0) + (g['primary-type'] === 'Album' ? 5 : 0);
      return { g, rank: (g.score ?? 0) + bonus, titleOk, artistOk };
    })
    .sort((a, b) => b.rank - a.rank);
  const best = ranked[0];
  if (!best || !best.artistOk || (!best.titleOk && (best.g.score ?? 0) < 90)) return null;
  const g = best.g;
  const secondary = (g['secondary-types'] ?? []).map((s) => s.toLowerCase());
  const primary = (g['primary-type'] ?? '').toLowerCase();
  return {
    rg: g.id,
    title: g.title ?? title,
    date: g['first-release-date'] || null,
    type: secondary.includes('compilation')
      ? 'compilation'
      : primary === 'single' || primary === 'ep'
        ? 'single'
        : 'album',
    tags: (g.tags ?? [])
      .filter((t) => t.name && (t.count ?? 0) > 0)
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, 8)
      .map((t) => t.name!.toLowerCase()),
    score: g.score ?? 0,
  };
}

export class MusicBrainz {
  constructor(
    private queue = new PoliteQueue(),
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  get pending(): number {
    return this.queue.pending;
  }

  private async get<T>(path: string, priority: number, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.queue.add(
        () => this.fetchFn(`${MB_API}${path}`, { headers: { Accept: 'application/json' }, signal }),
        priority,
        signal,
      );
      if (res.ok) return (await res.json()) as T;
      // 503 is MusicBrainz's "slow down": wait longer each time, then try again.
      if ((res.status === 503 || res.status >= 500) && attempt < 4) {
        this.queue.backoff(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`MusicBrainz HTTP ${res.status}`);
    }
  }

  /** One search request per album: release group, first release date, type and tags. */
  async findAlbum(
    artist: string,
    title: string,
    priority = 10,
    signal?: AbortSignal,
  ): Promise<MbMatch | null> {
    const t = cleanTitle(title) || title;
    const query = artist
      ? `releasegroup:${luceneQuote(t)} AND artist:${luceneQuote(artist)}`
      : `releasegroup:${luceneQuote(t)}`;
    const json = await this.get<{ 'release-groups'?: SearchRG[] }>(
      `/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
      priority,
      signal,
    );
    return pickMatch(artist, title, json['release-groups'] ?? []);
  }

  /** Track list and label of a release group's earliest official release (one request). */
  async tracks(rg: string, priority = 0): Promise<MbTracks | null> {
    type Rel = {
      date?: string;
      status?: string;
      'label-info'?: { label?: { name?: string } }[];
      media?: { tracks?: { position?: number; title?: string; length?: number | null }[] }[];
    };
    const json = await this.get<{ releases?: Rel[] }>(
      `/release?release-group=${encodeURIComponent(rg)}&inc=recordings+labels&fmt=json&limit=25`,
      priority,
    );
    const releases = (json.releases ?? []).filter((r) => r.media?.some((m) => m.tracks?.length));
    if (releases.length === 0) return null;
    const rel =
      releases
        .filter((r) => r.status === 'Official')
        .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0] ?? releases[0]!;
    let n = 0;
    const tracks = (rel.media ?? []).flatMap((m) =>
      (m.tracks ?? []).map((t) => ({ n: ++n, title: t.title ?? 'Untitled', durationMs: t.length ?? 0 })),
    );
    const label = rel['label-info']?.map((l) => l.label?.name).find((x) => x && x !== '[no label]') ?? null;
    return { tracks, label };
  }
}

/** Cover Art Archive front-cover URLs for a release group (redirect to the image; 404 when none). */
export function coverUrls(rg: string): { web: string; thumb: string } {
  return {
    web: `${CAA}/release-group/${rg}/front-500`,
    thumb: `${CAA}/release-group/${rg}/front-250`,
  };
}
