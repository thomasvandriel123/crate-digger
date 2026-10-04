import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { normaliseLibrary } from '../../src/data/library';
import { ExportLibrary, GENERATED_COVER } from '../../src/export/library';
import {
  cleanTitle,
  luceneQuote,
  type MbMatch,
  MusicBrainz,
  pickMatch,
  PoliteQueue,
} from '../../src/export/musicbrainz';
import { ExportError, parseExport, readExportFile } from '../../src/export/parse';
import { genreMap } from '../../src/spotify/genres';
import { NEUTRAL_PALETTE } from '../../src/spotify/mapping';

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const EXPORT = {
  tracks: [],
  albums: [
    { artist: 'Radiohead', album: 'OK Computer', uri: 'spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE' },
    { artist: 'Nina Simone', album: 'Pastel Blues', uri: 'spotify:album:1x9a0K2Tzi9g4RbXqf7Pyf' },
    { artist: 'Dup', album: 'Dup', uri: 'spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE' },
    { artist: 'No uri', album: 'Skip me', uri: '' },
  ],
  shows: [],
};

describe('parsing the Spotify export', () => {
  it('reads saved albums, skipping duplicates and entries without an album URI', () => {
    const albums = parseExport(EXPORT);
    expect(albums.map((a) => a.title)).toEqual(['OK Computer', 'Pastel Blues']);
    expect(albums[0]).toMatchObject({ id: '6dVIqQ8qmQ5GBnJ9shOYGE', artist: 'Radiohead', from: 'saved' });
  });

  it('falls back to albums with 3+ liked songs when nothing is saved', () => {
    const t = (album: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        artist: 'A',
        album,
        track: `T${i}`,
        uri: `spotify:track:${album}${i}`,
      }));
    const albums = parseExport({ albums: [], tracks: [...t('Loved', 3), ...t('Once', 1)] });
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({ title: 'Loved', from: 'liked' });
    expect(albums[0]!.uri).toBe(`spotify:search:${encodeURIComponent('A Loved')}`);
  });

  it('explains what is wrong with the wrong file', () => {
    expect(() => parseExport([])).toThrow(ExportError);
    expect(() => parseExport({ shows: [] })).toThrow(/no albums or tracks/);
    expect(() => parseExport({ albums: [] })).toThrow(/No saved albums/);
  });

  it('opens the zip Spotify sends, as well as the bare JSON', async () => {
    const zip = zipSync({
      'Spotify Account Data/Read Me First.pdf': new Uint8Array([1, 2, 3]),
      'Spotify Account Data/YourLibrary.json': strToU8(JSON.stringify(EXPORT)),
    });
    expect(await readExportFile(new Blob([zip as BlobPart]))).toHaveLength(2);
    expect(await readExportFile(new Blob(['﻿' + JSON.stringify(EXPORT)]))).toHaveLength(2);
    const wrongZip = zipSync({ 'MyData/StreamingHistory0.json': strToU8('[]') });
    await expect(readExportFile(new Blob([wrongZip as BlobPart]))).rejects.toThrow(/No YourLibrary.json/);
    await expect(readExportFile(new Blob(['not json']))).rejects.toThrow(/not valid JSON/);
  });
});

describe('MusicBrainz matching', () => {
  it('strips the suffixes Spotify adds to titles', () => {
    expect(cleanTitle('Abbey Road (Remastered 2009)')).toBe('Abbey Road');
    expect(cleanTitle('Rumours - 2004 Remaster')).toBe('Rumours');
    expect(cleanTitle('Blue Train [Deluxe Edition]')).toBe('Blue Train');
    expect(cleanTitle('(What’s the Story) Morning Glory?')).toBe('(What’s the Story) Morning Glory?');
    expect(luceneQuote('Say "hi"')).toBe('"Say \\"hi\\""');
  });

  const rg = (over: Record<string, unknown>) => ({
    id: 'rg-1',
    score: 100,
    title: 'OK Computer',
    'first-release-date': '1997-05-21',
    'primary-type': 'Album',
    'artist-credit': [{ name: 'Radiohead' }],
    tags: [
      { name: 'Alternative Rock', count: 12 },
      { name: 'art rock', count: 5 },
      { name: 'spam', count: 0 },
    ],
    ...over,
  });

  it('prefers the exact title by the right artist and reads year, type and tags', () => {
    const m = pickMatch('Radiohead', 'OK Computer (Remastered)', [
      rg({ id: 'single', title: 'Paranoid Android', 'primary-type': 'Single', score: 100 }),
      rg({ id: 'album', score: 92 }),
    ])!;
    expect(m.rg).toBe('album');
    expect(m.date).toBe('1997-05-21');
    expect(m.type).toBe('album');
    expect(m.tags).toEqual(['alternative rock', 'art rock']);
  });

  it('rejects a match by another artist or with a low score', () => {
    expect(
      pickMatch('Radiohead', 'OK Computer', [rg({ 'artist-credit': [{ name: 'Someone Else' }] })]),
    ).toBeNull();
    expect(pickMatch('Radiohead', 'Kid A', [rg({ title: 'Kid A Mnesia', score: 70 })])).toBeNull();
    expect(pickMatch('X', 'Y', [])).toBeNull();
    expect(
      pickMatch('VA', 'Hits', [
        rg({ title: 'Hits', 'artist-credit': [{ name: 'VA' }], 'secondary-types': ['Compilation'] }),
      ])!.type,
    ).toBe('compilation');
  });
});

describe('PoliteQueue', () => {
  it('spaces requests at least one interval apart and runs urgent ones first', async () => {
    let now = 0;
    const waits: number[] = [];
    const q = new PoliteQueue(
      1000,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    const order: string[] = [];
    const job = (name: string) => async () => void order.push(`${name}@${now}`);
    const all = [q.add(job('a'), 10), q.add(job('b'), 10), q.add(job('urgent'), 0)];
    await Promise.all(all);
    expect(order).toEqual(['a@0', 'urgent@1000', 'b@2000']);
  });

  it('backs off after a 503 and retries', async () => {
    let now = 0;
    const q = new PoliteQueue(
      1000,
      () => now,
      async (ms) => void (now += ms),
    );
    const responses = [
      new Response('', { status: 503 }),
      new Response(JSON.stringify({ 'release-groups': [] })),
    ];
    const fetchFn = vi.fn(async () => responses.shift()!);
    const mb = new MusicBrainz(q, fetchFn as unknown as typeof fetch);
    expect(await mb.findAlbum('A', 'B')).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(now).toBeGreaterThanOrEqual(2000);
    const url = new URL(String((fetchFn.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('query')).toBe('releasegroup:"B" AND artist:"A"');
  });
});

describe('ExportLibrary', () => {
  const match: MbMatch = {
    rg: 'rg-ok',
    title: 'OK Computer',
    date: '1997-05-21',
    type: 'album',
    tags: ['art rock'],
    score: 100,
  };

  function setup(
    opts: { find?: (artist: string) => MbMatch | null; palette?: string | null; fail?: boolean } = {},
  ) {
    let now = 1_700_000_000_000;
    const mb = {
      findAlbum: vi.fn(async (artist: string) => {
        if (opts.fail) throw new Error('offline');
        return opts.find ? opts.find(artist) : artist === 'Radiohead' ? match : null;
      }),
      tracks: vi.fn(async () => ({
        tracks: [{ n: 1, title: 'Airbag', durationMs: 284_000 }],
        label: 'Parlophone',
      })),
    } as unknown as MusicBrainz & { findAlbum: ReturnType<typeof vi.fn>; tracks: ReturnType<typeof vi.fn> };
    const palette = vi.fn(async () =>
      opts.palette === null ? null : { ...NEUTRAL_PALETTE, dominant: opts.palette ?? '#335577' },
    );
    const storage = memory();
    const make = () => new ExportLibrary({ storage, mb, genres: genreMap(), palette, now: () => now });
    return { lib: make(), make, mb, palette, storage, tick: (ms: number) => (now += ms) };
  }

  it('shows every album at once with plain sleeves, then fills in what MusicBrainz knows', async () => {
    const { lib, palette } = setup();
    const albums = lib.save(parseExport(EXPORT)).albums;
    const before = normaliseLibrary(lib.build(albums));
    expect(before.source).toBe('export');
    expect(before.albums.map((a) => a.cover.web)).toEqual([GENERATED_COVER, GENERATED_COVER]);
    expect(before.capabilities.year).toBe(false);

    const updates = vi.fn();
    const progress: number[] = [];
    expect(await lib.enrich(albums, { onUpdate: updates, onProgress: (p) => progress.push(p.done) })).toBe(
      'done',
    );
    expect(progress).toEqual([0, 1, 2]);
    expect(updates).toHaveBeenCalled();
    expect(palette).toHaveBeenCalledWith('https://coverartarchive.org/release-group/rg-ok/front-250');

    const after = normaliseLibrary(lib.build(albums));
    const ok = after.byId.get('6dVIqQ8qmQ5GBnJ9shOYGE')!;
    expect(ok.year).toBe(1997);
    expect(ok.cover.web).toBe('https://coverartarchive.org/release-group/rg-ok/front-500');
    expect(ok.palette.dominant).toBe('#335577');
    expect(ok.genres).toContain('rock');
    expect(ok.uri).toBe('spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE');
    // No match: keeps its plain sleeve and Spotify title.
    expect(after.byId.get('1x9a0K2Tzi9g4RbXqf7Pyf')!.cover.web).toBe(GENERATED_COVER);
    expect(lib.progress(albums)).toMatchObject({ done: 2, total: 2, found: 1, remaining: 0 });
  });

  it('caches lookups across visits and retries misses after a month', async () => {
    const { lib, make, mb, tick } = setup();
    const albums = lib.save(parseExport(EXPORT)).albums;
    await lib.enrich(albums);
    expect(mb.findAlbum).toHaveBeenCalledTimes(2);
    const again = make();
    expect(again.stored()!.albums).toHaveLength(2);
    expect(again.todo(albums)).toHaveLength(0);
    tick(31 * 24 * 3600 * 1000);
    expect(again.todo(albums).map((a) => a.title)).toEqual(['Pastel Blues']);
  });

  it('keeps a plain sleeve when the archive has no cover', async () => {
    const { lib } = setup({ palette: null });
    const albums = lib.save(parseExport(EXPORT)).albums;
    await lib.enrich(albums);
    const ok = normaliseLibrary(lib.build(albums)).byId.get('6dVIqQ8qmQ5GBnJ9shOYGE')!;
    expect(ok.year).toBe(1997);
    expect(ok.cover.web).toBe(GENERATED_COVER);
  });

  it('pauses after repeated network failures and can be stopped', async () => {
    const { lib } = setup({ fail: true });
    const many = Array.from({ length: 8 }, (_, i) => ({
      artist: 'A',
      album: `T${i}`,
      uri: `spotify:album:id${i}`,
    }));
    const albums = lib.save(parseExport({ albums: many })).albums;
    expect(await lib.enrich(albums)).toBe('offline');

    const ok = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await ok.lib.enrich(albums, { signal: controller.signal })).toBe('aborted');
    expect(ok.mb.findAlbum).not.toHaveBeenCalled();
  });

  it("fetches a held record's track list on demand, ahead of the queue, and caches it", async () => {
    const { lib, mb } = setup();
    const albums = lib.save(parseExport(EXPORT)).albums;
    const t = await lib.tracks(albums[0]!);
    expect(t?.tracks[0]!.title).toBe('Airbag');
    expect(mb.findAlbum).toHaveBeenCalledWith('Radiohead', 'OK Computer', 0, undefined);
    await lib.tracks(albums[0]!);
    expect(mb.tracks).toHaveBeenCalledTimes(1);
    const built = normaliseLibrary(lib.build(albums)).byId.get('6dVIqQ8qmQ5GBnJ9shOYGE')!;
    expect(built.label).toBe('Parlophone');
    expect(built.durationMs).toBe(284_000);
  });

  it('forgets everything', async () => {
    const { lib, storage } = setup();
    const albums = lib.save(parseExport(EXPORT)).albums;
    await lib.enrich(albums);
    lib.clear();
    expect(lib.stored()).toBeNull();
    expect(storage.m.size).toBe(0);
  });
});
