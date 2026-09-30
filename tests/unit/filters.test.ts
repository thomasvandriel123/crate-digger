import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  addedWindow,
  applyFilters,
  filterChips,
  hasActiveFilters,
  removeChip,
  yearHistogram,
  type FilterContext,
} from '../../src/data/filters';
import type { FilterState } from '../../src/data/types';
import { library } from './fixtures';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ctx: FilterContext = { now: NOW, searchIds: null };
const f = (patch: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTERS, ...patch });

const lib = library([
  {
    id: 'jazz70',
    genres: ['jazz'],
    genresRaw: ['hard bop'],
    year: 1972,
    label: 'Blue Note',
    addedAt: '2026-09-20T00:00:00Z',
  },
  {
    id: 'soul65',
    genres: ['soul'],
    genresRaw: ['northern soul'],
    year: 1965,
    label: 'Motown',
    type: 'single',
    addedAt: '2019-05-01T00:00:00Z',
  },
  {
    id: 'rock99',
    genres: ['rock'],
    genresRaw: ['shoegaze'],
    year: 1999,
    label: null,
    hue: 250,
    type: 'compilation',
    addedAt: '2026-02-01T00:00:00Z',
  },
  { id: 'mono', genres: ['jazz', 'soul'], genresRaw: ['jazz funk'], year: null, mono: true, addedAt: null },
]);
const ids = (state: FilterState, c = ctx) => applyFilters(lib.albums, state, c).map((a) => a.id);

describe('filters', () => {
  it('no filters keeps everything', () => {
    expect(ids(EMPTY_FILTERS)).toHaveLength(4);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('genre: any selected macro OR any selected micro genre', () => {
    expect(ids(f({ genres: ['soul'] }))).toEqual(['soul65', 'mono']);
    expect(ids(f({ genres: ['rock'], styles: ['hard bop'] }))).toEqual(['jazz70', 'rock99']);
  });

  it('year range is inclusive and excludes undated albums', () => {
    expect(ids(f({ year: [1965, 1972] }))).toEqual(['jazz70', 'soul65']);
  });

  it('colour bins include black and white', () => {
    expect(ids(f({ colours: ['mono'] }))).toEqual(['mono']);
    expect(ids(f({ colours: ['blue'] }))).toEqual(['rock99']);
  });

  it('added presets are relative to now', () => {
    expect(ids(f({ added: { preset: 'month' } }))).toEqual(['jazz70']);
    expect(ids(f({ added: { preset: 'year' } }))).toEqual(['jazz70', 'rock99']);
    expect(ids(f({ added: { preset: 'pre2020' } }))).toEqual(['soul65']);
    expect(ids(f({ added: { from: '2026-02-01', to: '2026-02-01' } }))).toEqual(['rock99']);
    const [from, to] = addedWindow({ from: null, to: null }, NOW);
    expect([from, to]).toEqual([-Infinity, Infinity]);
  });

  it('label and type', () => {
    expect(ids(f({ labels: ['Motown', 'Blue Note'] }))).toEqual(['jazz70', 'soul65']);
    expect(ids(f({ types: ['single', 'compilation'] }))).toEqual(['soul65', 'rock99']);
  });

  it('filters AND together, search uses precomputed ids', () => {
    expect(ids(f({ genres: ['jazz'], year: [1900, 2000] }))).toEqual(['jazz70']);
    expect(ids(f({ search: 'x' }), { now: NOW, searchIds: new Set(['rock99', 'mono']) })).toEqual([
      'rock99',
      'mono',
    ]);
  });

  it('year histogram ignores the year filter but honours the others', () => {
    const hist = yearHistogram(
      lib.albums,
      f({ genres: ['jazz', 'soul'], year: [1990, 2000] }),
      ctx,
      [1965, 1972],
    );
    expect(hist[0]).toBe(1);
    expect(hist[7]).toBe(1);
    expect(hist.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('chips describe every active filter with text and can be removed one by one', () => {
    const state = f({
      genres: ['jazz'],
      styles: ['shoegaze'],
      year: [1965, 1979],
      colours: ['red'],
      search: 'miles',
    });
    const chips = filterChips(state, lib);
    expect(chips.map((c) => c.text)).toEqual(['Jazz', 'shoegaze', '1965–1979', 'Red', '“miles”']);
    let s = state;
    for (const chip of chips) s = removeChip(s, chip);
    expect(hasActiveFilters(s)).toBe(false);
  });
});
