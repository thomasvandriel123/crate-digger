import { describe, expect, it } from 'vitest';
import { packCrates } from '../../src/data/crates';
import { groupFn, sortAlbums } from '../../src/data/sort';
import type { SortState } from '../../src/data/types';
import { library } from './fixtures';

const s = (patch: Partial<SortState>): SortState => ({ mode: 'artist', dir: 'asc', seed: 1, ...patch });

const lib = library([
  {
    id: 'b1',
    artist: 'The Beatles',
    title: 'Revolver',
    year: 1966,
    hue: 20,
    addedAt: '2024-03-01T00:00:00Z',
  },
  {
    id: 'a1',
    artist: 'Alice Coltrane',
    title: 'Journey in Satchidananda',
    year: 1971,
    hue: 250,
    addedAt: '2024-01-01T00:00:00Z',
  },
  { id: 'b0', artist: 'The Beatles', title: 'Abbey Road', year: 1969, hue: 100, addedAt: null },
  {
    id: 'z1',
    artist: 'Zapp',
    title: 'Zapp II',
    year: 1982,
    hue: 140,
    lightness: 0.2,
    addedAt: '2024-02-01T00:00:00Z',
  },
  { id: 'n1', artist: '808 State', title: 'ex:el', year: null, mono: true, addedAt: '2024-04-01T00:00:00Z' },
]);
const ids = (state: SortState) => sortAlbums(lib.albums, state).map((a) => a.id);

describe('sortAlbums', () => {
  it('artist A-Z files "The" under the next word, symbols first', () => {
    expect(ids(s({}))).toEqual(['n1', 'a1', 'b1', 'b0', 'z1']);
  });

  it('artist Z-A reverses artists but keeps each discography chronological', () => {
    expect(ids(s({ dir: 'desc' }))).toEqual(['z1', 'b1', 'b0', 'a1', 'n1']);
  });

  it('year puts undated albums last in both directions', () => {
    expect(ids(s({ mode: 'year' }))).toEqual(['b1', 'b0', 'a1', 'z1', 'n1']);
    expect(ids(s({ mode: 'year', dir: 'desc' }))).toEqual(['z1', 'a1', 'b0', 'b1', 'n1']);
  });

  it('date added, newest first, undated last', () => {
    expect(ids(s({ mode: 'added', dir: 'desc' }))).toEqual(['n1', 'b1', 'z1', 'a1', 'b0']);
  });

  it('colour sweep runs around the hue wheel with greys last', () => {
    expect(ids(s({ mode: 'colour' }))).toEqual(['b1', 'b0', 'z1', 'a1', 'n1']);
  });

  it('random digging is deterministic per seed and differs between seeds', () => {
    expect(ids(s({ mode: 'random', seed: 42 }))).toEqual(ids(s({ mode: 'random', seed: 42 })));
    const seeds = new Set([1, 2, 3, 4, 5, 6].map((seed) => ids(s({ mode: 'random', seed })).join()));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('groups and packing', () => {
  it('uses letters, decades or single years, months and hue names', () => {
    const albums = sortAlbums(lib.albums, s({}));
    expect(albums.map((a) => groupFn('artist', albums)!(a).label)).toEqual(['#', 'A', 'B', 'B', 'Z']);
    expect(groupFn('year', albums)!(albums[1]!).label).toBe('70s');
    const narrow = albums.filter((a) => a.year !== null && a.year < 1972);
    expect(groupFn('year', narrow)!(narrow[0]!).label).toBe(String(narrow[0]!.year));
    expect(groupFn('added', albums)!(albums[0]!).label).toBe('Apr 2024');
    expect(groupFn('colour', albums)!(albums[0]!).label).toBe('Black & white');
    expect(groupFn('random', albums)).toBeNull();
  });

  it('packs to capacity with dividers at boundaries and at each crate front', () => {
    const albums = sortAlbums(lib.albums, s({}));
    const crates = packCrates(albums, groupFn('artist', albums), 2);
    expect(crates.map((c) => c.records)).toEqual([['n1', 'a1'], ['b1', 'b0'], ['z1']]);
    expect(crates[0]!.dividers).toEqual([
      { label: '#', at: 0 },
      { label: 'A', at: 1 },
    ]);
    expect(crates[1]!.dividers).toEqual([{ label: 'B', at: 0 }]);
    expect(crates.map((c) => c.label)).toEqual(['#–A', 'B', 'Z']);
  });

  it('handles empty input and random mode without dividers', () => {
    expect(packCrates([], null, 48)).toEqual([]);
    const crates = packCrates(lib.albums, null, 48);
    expect(crates).toHaveLength(1);
    expect(crates[0]!.dividers).toEqual([]);
    expect(crates[0]!.label).toBe('Crate 1');
  });
});
