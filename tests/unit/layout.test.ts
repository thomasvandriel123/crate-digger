import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS } from '../../src/data/filters';
import { deriveLayout, resolveFocus } from '../../src/data/layout';
import { createSearchIndex } from '../../src/data/search';
import { DEFAULT_SORT } from '../../src/data/sort';
import { parseViewState, serialiseViewState } from '../../src/data/url';
import { library } from './fixtures';

const ctx = { now: Date.parse('2026-09-30T00:00:00Z'), searchIds: null };
const lib = library(
  Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`,
    artist: `Artist ${String.fromCharCode(65 + i)}`,
    genres: [i % 2 ? 'jazz' : 'rock'],
    label: i < 3 ? 'Blue Note' : 'Other',
  })),
);

describe('deriveLayout', () => {
  it('builds crates, slots and counts', () => {
    const layout = deriveLayout(lib, EMPTY_FILTERS, DEFAULT_SORT, ctx, 4);
    expect(layout.crates.map((c) => c.records.length)).toEqual([4, 4, 2]);
    expect(layout.slots.get('r5')).toEqual({ crate: 1, index: 1 });
    expect(layout.matched).toBe(10);
    expect(layout.total).toBe(10);
  });

  it('signature changes with the arrangement only', () => {
    const a = deriveLayout(lib, EMPTY_FILTERS, DEFAULT_SORT, ctx, 4);
    const b = deriveLayout(lib, EMPTY_FILTERS, DEFAULT_SORT, ctx, 4);
    const c = deriveLayout(lib, { ...EMPTY_FILTERS, genres: ['jazz'] }, DEFAULT_SORT, ctx, 4);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });
});

describe('resolveFocus', () => {
  const all = deriveLayout(lib, EMPTY_FILTERS, DEFAULT_SORT, ctx, 48);
  const jazz = deriveLayout(lib, { ...EMPTY_FILTERS, genres: ['jazz'] }, DEFAULT_SORT, ctx, 48);
  const none = deriveLayout(lib, { ...EMPTY_FILTERS, genres: ['metal'] }, DEFAULT_SORT, ctx, 48);

  it('keeps the focused record when it still matches', () => {
    expect(resolveFocus('r3', all.order, jazz)).toBe('r3');
  });
  it('moves to the nearest matching neighbour, looking ahead first', () => {
    expect(resolveFocus('r4', all.order, jazz)).toBe('r5');
    expect(resolveFocus('r0', all.order, jazz)).toBe('r1');
  });
  it('falls back to the first record, or null when empty', () => {
    expect(resolveFocus(null, all.order, jazz)).toBe('r1');
    expect(resolveFocus('r1', all.order, none)).toBeNull();
  });
});

describe('search', () => {
  const index = createSearchIndex(
    library([
      { id: 'kob', artist: 'Miles Davis', title: 'Kind of Blue', label: 'Columbia' },
      { id: 'ms', artist: 'Mira Okafor', title: 'Night Harbour', label: 'Salt & Ember' },
      { id: 'ld', artist: 'Low', title: 'Double Negative', label: 'Sub Pop' },
    ]).albums,
  );
  it('matches artist, title and label fuzzily', () => {
    expect(index.search('miles')).toEqual(['kob']);
    expect(index.search('harbor')).toEqual(['ms']);
    expect(index.search('sub pop')).toEqual(['ld']);
    expect(index.search('harbour okafor')).toEqual(['ms']);
  });
  it('returns null for an empty query and [] for no match', () => {
    expect(index.search('   ')).toBeNull();
    expect(index.search('zzzzqqq')).toEqual([]);
  });
});

describe('URL state', () => {
  it('round-trips every filter, sort and focus', () => {
    const state = {
      filters: {
        genres: ['jazz', 'soul'],
        styles: ['hard bop'],
        year: [1965, 1979] as [number, number],
        colours: ['red' as const, 'mono' as const],
        added: { from: '2024-01-01', to: null },
        labels: ['Salt, Pepper & Co'],
        types: ['album' as const],
        search: 'miles davis',
      },
      sort: { mode: 'added' as const, dir: 'asc' as const, seed: 1 },
      focus: 'abc123',
    };
    const qs = serialiseViewState(state);
    expect(qs).toContain('genre=jazz,soul');
    expect(qs).toContain('year=1965-1979');
    expect(qs).toContain('sort=added-asc');
    expect(parseViewState(qs)).toEqual(state);
  });

  it('omits defaults and ignores junk', () => {
    expect(serialiseViewState(parseViewState(''))).toBe('');
    const parsed = parseViewState('?genre=&year=abc&colour=plaid&type=lp&sort=nope&r=../../etc&added=soon');
    expect(serialiseViewState(parsed)).toBe('');
  });

  it('keeps the random seed only for random digging', () => {
    expect(serialiseViewState({ ...parseViewState('?sort=random&seed=77') })).toBe('?sort=random&seed=77');
    expect(parseViewState('?sort=added').sort.dir).toBe('desc');
  });
});
