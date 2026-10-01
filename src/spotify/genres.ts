/**
 * Raw Spotify artist genres -> macro genres, the TypeScript twin of ingest/genres.py. Both read the same
 * editable ingest/genre-map.json, so a live library files records under the same genre dividers as a
 * built one.
 */

import genreMapJson from '../../ingest/genre-map.json';

interface MacroDef {
  id: string;
  name: string;
  keywords: string[];
}

interface GenreMapJson {
  fallback?: string | null;
  macros: MacroDef[];
  exact?: Record<string, string[]>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keywordRegex(keyword: string): string {
  const kw = keyword.trim().toLowerCase();
  const core = escape(kw.replace(/^\*+|\*+$/g, ''));
  return (kw.startsWith('*') ? '[a-z]*' : '') + core + (kw.endsWith('*') ? '[a-z]*' : '');
}

export class GenreMap {
  private patterns: [string, RegExp][];
  private exact: Map<string, string[]>;
  private order: Map<string, number>;

  constructor(private data: GenreMapJson) {
    this.exact = new Map(Object.entries(data.exact ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.order = new Map(data.macros.map((m, i) => [m.id, i]));
    this.patterns = data.macros.map((m) => {
      const words = m.keywords.map(keywordRegex).sort((a, b) => b.length - a.length);
      // Whole-word match, so "rock" does not claim "rocksteady".
      return [m.id, new RegExp(`(?<![a-z])(?:${words.join('|')})(?![a-z])`)];
    });
  }

  mapOne(raw: string): string[] {
    const key = raw.trim().toLowerCase();
    if (!key) return [];
    const exact = this.exact.get(key);
    if (exact) return [...exact];
    const hits = this.patterns.filter(([, re]) => re.test(key)).map(([id]) => id);
    if (hits.length) return hits;
    return this.data.fallback ? [this.data.fallback] : [];
  }

  mapMany(raws: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const r of raws) this.mapOne(r).forEach((g) => out.add(g));
    return [...out].sort((a, b) => (this.order.get(a) ?? 999) - (this.order.get(b) ?? 999));
  }

  /** Macro genres present in the albums, each with the raw genres that map to it (library.json shape). */
  taxonomy(
    albums: { genres: string[]; genresRaw: string[] }[],
  ): { id: string; name: string; micro: string[] }[] {
    const micro = new Map(this.data.macros.map((m) => [m.id, new Set<string>()]));
    const counts = new Map(this.data.macros.map((m) => [m.id, 0]));
    for (const a of albums) {
      a.genres.forEach((g) => counts.has(g) && counts.set(g, counts.get(g)! + 1));
      for (const raw of a.genresRaw) this.mapOne(raw).forEach((id) => micro.get(id)?.add(raw));
    }
    return this.data.macros
      .filter((m) => (counts.get(m.id) ?? 0) > 0)
      .map((m) => ({ id: m.id, name: m.name, micro: [...micro.get(m.id)!].sort() }));
  }
}

let shared: GenreMap | null = null;
export function genreMap(): GenreMap {
  return (shared ??= new GenreMap(genreMapJson as GenreMapJson));
}
