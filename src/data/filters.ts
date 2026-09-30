import { colourInfo } from './colour';
import type { AddedFilter, AddedPreset, Album, AlbumType, ColourBin, FilterState, Library } from './types';

export const EMPTY_FILTERS: FilterState = Object.freeze({
  genres: [],
  styles: [],
  year: null,
  colours: [],
  added: null,
  labels: [],
  types: [],
  search: '',
}) as FilterState;

export type FilterKey = 'genre' | 'year' | 'colour' | 'added' | 'label' | 'type' | 'search';

export interface FilterContext {
  /** "Now" for relative presets; injected so filtering stays pure and testable. */
  now: number;
  /** Album ids matching the search query, or null when there is no query. */
  searchIds: ReadonlySet<string> | null;
}

export const ADDED_PRESETS: { id: AddedPreset; name: string }[] = [
  { id: 'month', name: 'Last month' },
  { id: 'year', name: 'This year' },
  { id: 'pre2020', name: 'Before 2020' },
];

const DAY = 86_400_000;

/** [from, to) epoch-ms window for an Added filter. */
export function addedWindow(filter: AddedFilter, now: number): [number, number] {
  if ('preset' in filter) {
    switch (filter.preset) {
      case 'month':
        return [now - 30 * DAY, Infinity];
      case 'year':
        return [Date.UTC(new Date(now).getUTCFullYear(), 0, 1), Infinity];
      case 'pre2020':
        return [-Infinity, Date.UTC(2020, 0, 1)];
    }
  }
  const from = filter.from ? Date.parse(`${filter.from}T00:00:00Z`) : -Infinity;
  const to = filter.to ? Date.parse(`${filter.to}T00:00:00Z`) + DAY : Infinity; // inclusive end day
  return [Number.isFinite(from) ? from : -Infinity, Number.isFinite(to) ? to : Infinity];
}

export function isFilterActive(state: FilterState, key: FilterKey): boolean {
  switch (key) {
    case 'genre':
      return state.genres.length > 0 || state.styles.length > 0;
    case 'year':
      return state.year !== null;
    case 'colour':
      return state.colours.length > 0;
    case 'added':
      return state.added !== null;
    case 'label':
      return state.labels.length > 0;
    case 'type':
      return state.types.length > 0;
    case 'search':
      return state.search.trim().length > 0;
  }
}

export function hasActiveFilters(state: FilterState): boolean {
  return (['genre', 'year', 'colour', 'added', 'label', 'type', 'search'] as FilterKey[]).some((k) =>
    isFilterActive(state, k),
  );
}

/**
 * Builds one predicate for the whole filter state. Within a filter the options are OR-ed (any selected genre);
 * across filters they are AND-ed. `except` leaves one filter out, which is how facet counts (the year
 * histogram) reflect every other active filter.
 */
export function makePredicate(state: FilterState, ctx: FilterContext, except?: FilterKey): (a: Album) => boolean {
  const tests: ((a: Album) => boolean)[] = [];

  if (except !== 'genre' && isFilterActive(state, 'genre')) {
    const macros = new Set(state.genres);
    const styles = new Set(state.styles.map((s) => s.toLowerCase()));
    tests.push((a) => a.genres.some((g) => macros.has(g)) || a.genresRaw.some((g) => styles.has(g)));
  }
  if (except !== 'year' && state.year) {
    const [lo, hi] = state.year;
    tests.push((a) => a.year !== null && a.year >= lo && a.year <= hi);
  }
  if (except !== 'colour' && state.colours.length > 0) {
    const bins = new Set<ColourBin>(state.colours);
    tests.push((a) => bins.has(a.colour));
  }
  if (except !== 'added' && state.added) {
    const [from, to] = addedWindow(state.added, ctx.now);
    tests.push((a) => a.addedAt !== null && a.addedAt >= from && a.addedAt < to);
  }
  if (except !== 'label' && state.labels.length > 0) {
    const labels = new Set(state.labels);
    tests.push((a) => a.label !== null && labels.has(a.label));
  }
  if (except !== 'type' && state.types.length > 0) {
    const types = new Set<AlbumType>(state.types);
    tests.push((a) => types.has(a.type));
  }
  if (except !== 'search' && ctx.searchIds) {
    const ids = ctx.searchIds;
    tests.push((a) => ids.has(a.id));
  }

  if (tests.length === 0) return () => true;
  return (a) => tests.every((t) => t(a));
}

export function applyFilters(albums: readonly Album[], state: FilterState, ctx: FilterContext): Album[] {
  const pred = makePredicate(state, ctx);
  return albums.filter(pred);
}

/** Albums per release year, counting every active filter except the year range itself. */
export function yearHistogram(
  albums: readonly Album[],
  state: FilterState,
  ctx: FilterContext,
  range: [number, number],
): number[] {
  const pred = makePredicate(state, ctx, 'year');
  const counts = new Array<number>(range[1] - range[0] + 1).fill(0);
  for (const a of albums) {
    if (a.year === null || a.year < range[0] || a.year > range[1] || !pred(a)) continue;
    counts[a.year - range[0]]!++;
  }
  return counts;
}

export interface FilterChip {
  key: FilterKey;
  /** Which value to remove; undefined clears the whole filter. */
  value?: string;
  text: string;
}

const TYPE_NAMES: Record<AlbumType, string> = { album: 'Album', single: 'Single/EP', compilation: 'Compilation' };

export function typeName(t: AlbumType): string {
  return TYPE_NAMES[t];
}

export function describeAdded(filter: AddedFilter): string {
  if ('preset' in filter) return ADDED_PRESETS.find((p) => p.id === filter.preset)?.name ?? filter.preset;
  if (filter.from && filter.to) return `Added ${filter.from} to ${filter.to}`;
  if (filter.from) return `Added since ${filter.from}`;
  if (filter.to) return `Added until ${filter.to}`;
  return 'Added any time';
}

/** Active filters as removable chips. Text is always present, so chips never rely on colour alone. */
export function filterChips(state: FilterState, library: Library | null): FilterChip[] {
  const chips: FilterChip[] = [];
  const genreName = (id: string) => library?.taxonomy.find((g) => g.id === id)?.name ?? id;
  state.genres.forEach((g) => chips.push({ key: 'genre', value: g, text: genreName(g) }));
  state.styles.forEach((s) => chips.push({ key: 'genre', value: `~${s}`, text: s }));
  if (state.year) {
    const [lo, hi] = state.year;
    chips.push({ key: 'year', text: lo === hi ? String(lo) : `${lo}–${hi}` });
  }
  state.colours.forEach((c) => chips.push({ key: 'colour', value: c, text: colourInfo(c).name }));
  if (state.added) chips.push({ key: 'added', text: describeAdded(state.added) });
  state.labels.forEach((l) => chips.push({ key: 'label', value: l, text: l }));
  state.types.forEach((t) => chips.push({ key: 'type', value: t, text: TYPE_NAMES[t] }));
  if (state.search.trim()) chips.push({ key: 'search', text: `“${state.search.trim()}”` });
  return chips;
}

export function removeChip(state: FilterState, chip: FilterChip): FilterState {
  const without = <T>(list: T[], v: T) => list.filter((x) => x !== v);
  switch (chip.key) {
    case 'genre':
      if (chip.value?.startsWith('~')) return { ...state, styles: without(state.styles, chip.value.slice(1)) };
      return chip.value ? { ...state, genres: without(state.genres, chip.value) } : { ...state, genres: [], styles: [] };
    case 'year':
      return { ...state, year: null };
    case 'colour':
      return chip.value ? { ...state, colours: without(state.colours, chip.value as ColourBin) } : { ...state, colours: [] };
    case 'added':
      return { ...state, added: null };
    case 'label':
      return chip.value ? { ...state, labels: without(state.labels, chip.value) } : { ...state, labels: [] };
    case 'type':
      return chip.value ? { ...state, types: without(state.types, chip.value as AlbumType) } : { ...state, types: [] };
    case 'search':
      return { ...state, search: '' };
  }
}

export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}
