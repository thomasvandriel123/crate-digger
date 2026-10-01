import { describe, expect, it, vi } from 'vitest';
import { normaliseLibrary } from '../../src/data/library';
import type { SavedAlbumItem, SpotifyApi } from '../../src/spotify/api';
import { GenreMap, genreMap } from '../../src/spotify/genres';
import { GENRES_KEY, LIBRARY_KEY, SpotifyLibraryLoader } from '../../src/spotify/library';
import { mapSavedAlbum, NEUTRAL_PALETTE, pickImage } from '../../src/spotify/mapping';
import { extractPalette, oklabToHex, srgbToOklab } from '../../src/spotify/palette';

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const saved = (id: string, extra: Record<string, unknown> = {}): SavedAlbumItem => ({
  added_at: '2024-05-01T10:00:00Z',
  album: {
    id,
    uri: `spotify:album:${id}`,
    name: `Album ${id}`,
    album_type: 'album',
    release_date: '1977-09-23',
    total_tracks: 2,
    artists: [{ id: `ar-${id}`, name: `Artist ${id}` }],
    images: [
      { url: `https://i.scdn.co/image/${id}-640`, width: 640, height: 640 },
      { url: `https://i.scdn.co/image/${id}-300`, width: 300, height: 300 },
      { url: `https://i.scdn.co/image/${id}-64`, width: 64, height: 64 },
    ],
    tracks: {
      items: [
        { uri: `spotify:track:${id}1`, name: 'One', track_number: 1, duration_ms: 200_000 },
        { uri: `spotify:track:${id}2`, name: 'Two', track_number: 2, duration_ms: 100_000 },
      ],
      next: null,
    },
    ...extra,
  },
});

describe('mapping saved albums', () => {
  it('produces a library.json record the viewer normalises', () => {
    const m = mapSavedAlbum(saved('a'), null)!;
    expect(m.paletteImage).toBe('https://i.scdn.co/image/a-64');
    const lib = normaliseLibrary({ version: 1, source: 'spotify', albums: [m.record] });
    const album = lib.albums[0]!;
    expect(album.uri).toBe('spotify:album:a');
    expect(album.year).toBe(1977);
    expect(album.durationMs).toBe(300_000);
    expect(album.cover.web).toBe('https://i.scdn.co/image/a-640');
    expect(album.cover.thumb).toBe('https://i.scdn.co/image/a-300');
    expect(album.tracks![0]!.uri).toBe('spotify:track:a1');
    expect(album.addedAt).toBe(Date.parse('2024-05-01T10:00:00Z'));
    expect(album.palette.dominant).toBe(NEUTRAL_PALETTE.dominant);
    expect(lib.capabilities.label).toBe(false);
  });

  it('picks the smallest image that is big enough', () => {
    const imgs = [
      { url: 'big', width: 640, height: 640 },
      { url: 'mid', width: 300, height: 300 },
    ];
    expect(pickImage(imgs, 280)).toBe('mid');
    expect(pickImage(imgs, 1000)).toBe('big');
    expect(pickImage([], 10)).toBeNull();
  });

  it('skips items without an album id', () => {
    expect(mapSavedAlbum({ album: undefined }, null)).toBeNull();
  });
});

describe('browser palettes', () => {
  const solid = (r: number, g: number, b: number, n = 64) => {
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) px.set([r, g, b, 255], i * 4);
    return px;
  };

  it('round-trips OKLab', () => {
    expect(oklabToHex(srgbToOklab(0.2, 0.4, 0.6))).toBe('#336699');
  });

  it('finds the colour of a solid cover and flags greys as mono', () => {
    const red = extractPalette(solid(200, 30, 30))!;
    expect(red.dominant).toBe('#c81e1e');
    expect(red.mono).toBe(false);
    expect(red.hue).toBeLessThan(40);
    expect(extractPalette(solid(120, 120, 120))!.mono).toBe(true);
  });

  it('prefers a vivid shape over a large grey field', () => {
    const px = solid(128, 128, 128, 100);
    for (let i = 0; i < 25; i++) px.set([20, 90, 230, 255], i * 4);
    const p = extractPalette(px)!;
    expect(p.hue).toBeGreaterThan(220);
    expect(p.hue).toBeLessThan(290);
    expect(p.swatches).toHaveLength(3);
  });
});

describe('genre map (shared with the ingest)', () => {
  it('maps raw genres by keyword, whole words only', () => {
    const gm = new GenreMap({
      macros: [
        { id: 'rock', name: 'Rock', keywords: ['rock', 'psych*'] },
        { id: 'jazz', name: 'Jazz', keywords: ['jazz', '*bop'] },
        { id: 'reggae', name: 'Reggae', keywords: ['rocksteady'] },
      ],
    });
    expect(gm.mapOne('Indie Rock')).toEqual(['rock']);
    expect(gm.mapOne('psychedelic')).toEqual(['rock']);
    expect(gm.mapOne('hard bop')).toEqual(['jazz']);
    expect(gm.mapOne('rocksteady')).toEqual(['reggae']);
    expect(gm.mapMany(['jazz rock', 'bebop'])).toEqual(['rock', 'jazz']);
  });

  it('loads the real genre-map.json', () => {
    expect(genreMap().mapOne('shoegaze')).toContain('rock');
  });
});

describe('SpotifyLibraryLoader', () => {
  function fakeApi(items: SavedAlbumItem[], genres: Record<string, string[]> = {}) {
    return {
      savedAlbums: vi.fn(async (onPage?: (a: number, b: number) => void) => {
        onPage?.(items.length, items.length);
        return items;
      }),
      remainingTracks: vi.fn(async () => [
        { uri: 'spotify:track:extra', name: 'Extra', track_number: 3, duration_ms: 50_000 },
      ]),
      newestSaved: vi.fn(async () => ({ id: items[0]?.album?.id ?? null, total: items.length })),
      artistGenres: vi.fn(async (id: string) => genres[id] ?? []),
    } as unknown as SpotifyApi & { [k: string]: ReturnType<typeof vi.fn> };
  }

  const loaderFor = (
    api: SpotifyApi,
    storage = memory(),
    palette = vi.fn(async () => ({ ...NEUTRAL_PALETTE, dominant: '#112233' })),
  ) => ({
    loader: new SpotifyLibraryLoader({
      api,
      storage,
      genres: genreMap(),
      palette,
      now: () => 1_700_000_000_000,
    }),
    storage,
    palette,
  });

  it('builds the library from saved albums only, with palettes, long track lists and a cache', async () => {
    const api = fakeApi([
      saved('a'),
      saved('b', {
        tracks: {
          items: saved('b').album!.tracks!.items,
          next: 'https://api.spotify.com/v1/albums/b/tracks?offset=50',
        },
      }),
    ]);
    const { loader, storage, palette } = loaderFor(api);
    const progress: string[] = [];
    const raw = await loader.build((p) => progress.push(p.phase));
    expect(raw.source).toBe('spotify');
    expect(raw.albums.map((a) => a.id)).toEqual(['a', 'b']);
    expect(raw.albums[0]!.palette.dominant).toBe('#112233');
    expect(raw.albums[1]!.tracks).toHaveLength(3);
    expect(raw.albums[1]!.durationMs).toBe(350_000);
    expect(palette).toHaveBeenCalledTimes(2);
    expect(progress).toContain('albums');
    expect(progress).toContain('covers');
    const cached = loader.cached()!;
    expect(cached.newestId).toBe('a');
    expect(cached.total).toBe(2);
    expect(storage.m.has(LIBRARY_KEY)).toBe(true);
    expect(await loader.isStale(cached)).toBe(false);
  });

  it('reuses known palettes on a rebuild and notices new saves', async () => {
    const { loader, palette } = loaderFor(fakeApi([saved('a')]));
    const first = await loader.build();
    const api2 = fakeApi([saved('new'), saved('a')]);
    const second = loaderFor(api2, memory(), palette).loader;
    expect(await second.isStale(loader.cached()!)).toBe(true);
    palette.mockClear();
    const rebuilt = await second.build(undefined, first);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(rebuilt.albums.map((a) => a.id)).toEqual(['new', 'a']);
  });

  it('adds artist genres in the background and caches them', async () => {
    const api = fakeApi([saved('a')], { 'ar-a': ['Shoegaze', 'dream pop'] });
    const { loader, storage } = loaderFor(api);
    const raw = await loader.build();
    expect(raw.albums[0]!.genres).toEqual([]);
    const enriched = (await loader.enrichGenres(raw))!;
    expect(enriched.albums[0]!.genresRaw).toEqual(['dream pop', 'shoegaze']);
    expect(enriched.albums[0]!.genres).toContain('rock');
    expect(enriched.taxonomy.map((t) => t.id)).toContain('rock');
    expect(JSON.parse(storage.m.get(GENRES_KEY)!)['ar-a'].genres).toEqual(['Shoegaze', 'dream pop']);
    // Cached now: no second round of requests.
    expect(await loader.enrichGenres(enriched)).toBeNull();
    expect(normaliseLibrary(enriched).capabilities.genres).toBe(true);
  });

  it('forgets everything on clear', async () => {
    const { loader, storage } = loaderFor(fakeApi([saved('a')]));
    await loader.build();
    loader.clear();
    expect(loader.cached()).toBeNull();
    expect(storage.m.size).toBe(0);
  });
});
