import { colourInfo, sweepKey } from './colour';
import { mulberry32 } from './random';
import { compareText, filingLetter } from './text';
import type { Album, SortDir, SortMode, SortState } from './types';

export interface SortModeInfo {
  id: SortMode;
  name: string;
  defaultDir: SortDir;
  /** Whether the direction toggle means anything for this mode. */
  directional: boolean;
}

export const SORT_MODES: readonly SortModeInfo[] = [
  { id: 'artist', name: 'Artist', defaultDir: 'asc', directional: true },
  { id: 'title', name: 'Title', defaultDir: 'asc', directional: true },
  { id: 'year', name: 'Release year', defaultDir: 'asc', directional: true },
  { id: 'added', name: 'Date added', defaultDir: 'desc', directional: true },
  { id: 'colour', name: 'Colour sweep', defaultDir: 'asc', directional: true },
  { id: 'random', name: 'Dig at random', defaultDir: 'asc', directional: false },
];

export const DEFAULT_SORT: SortState = Object.freeze({ mode: 'artist', dir: 'asc', seed: 1 }) as SortState;

export function sortInfo(mode: SortMode): SortModeInfo {
  return SORT_MODES.find((m) => m.id === mode) ?? SORT_MODES[0]!;
}

type Cmp = (a: Album, b: Album) => number;

const nullsLast = (a: number | null, b: number | null, sign: number) => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * sign;
};

const byArtist: Cmp = (a, b) => compareText(a.sortArtist, b.sortArtist);
const byTitle: Cmp = (a, b) => compareText(a.sortTitle, b.sortTitle);
const byYearAsc: Cmp = (a, b) => nullsLast(a.year, b.year, 1);
const byIndex: Cmp = (a, b) => a.index - b.index;

function chain(...cmps: Cmp[]): Cmp {
  return (a, b) => {
    for (const c of cmps) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
}

function comparator(mode: SortMode, dir: SortDir): Cmp {
  const s = dir === 'desc' ? -1 : 1;
  switch (mode) {
    case 'artist':
      // Within an artist, oldest release first: how a shop files a discography.
      return chain((a, b) => s * byArtist(a, b), byYearAsc, byTitle, byIndex);
    case 'title':
      return chain((a, b) => s * byTitle(a, b), byArtist, byIndex);
    case 'year':
      return chain((a, b) => nullsLast(a.year, b.year, s), byArtist, byTitle, byIndex);
    case 'added':
      return chain((a, b) => nullsLast(a.addedAt, b.addedAt, s), byIndex);
    case 'colour':
      return chain(
        (a, b) => {
          const [ha, la] = sweepKey(a.palette);
          const [hb, lb] = sweepKey(b.palette);
          // Coarse hue steps first, then lightness inside a step, so each crate reads as a smooth gradient.
          const qa = Math.floor(ha / 6);
          const qb = Math.floor(hb / 6);
          return s * (qa !== qb ? qa - qb : lb - la);
        },
        byIndex,
      );
    case 'random':
      return byIndex;
  }
}

export function sortAlbums(albums: readonly Album[], sort: SortState): Album[] {
  const sorted = [...albums].sort(comparator(sort.mode, sort.dir));
  if (sort.mode !== 'random') return sorted;
  // Seeded Fisher-Yates over a canonical order: the same seed always digs the same crate.
  const rand = mulberry32(sort.seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  return sorted;
}

export interface Group {
  key: string;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Divider grouping for a sort mode: letters for artist and title, decades (or single years when the view
 * spans at most 12 years) for release year, months for date added, hue names for the colour sweep.
 * Random digging has no dividers.
 */
export function groupFn(mode: SortMode, albums: readonly Album[]): ((a: Album) => Group) | null {
  switch (mode) {
    case 'artist':
      return (a) => {
        const l = filingLetter(a.sortArtist);
        return { key: l, label: l };
      };
    case 'title':
      return (a) => {
        const l = filingLetter(a.sortTitle);
        return { key: l, label: l };
      };
    case 'year': {
      const years = new Set(albums.map((a) => a.year).filter((y): y is number => y !== null));
      const perYear = years.size > 0 && Math.max(...years) - Math.min(...years) <= 12;
      return (a) => {
        if (a.year === null) return { key: 'unknown', label: 'Undated' };
        if (perYear) return { key: String(a.year), label: String(a.year) };
        const decade = Math.floor(a.year / 10) * 10;
        return { key: String(decade), label: decade >= 1900 && decade < 2000 ? `${String(decade).slice(2)}s` : `${decade}s` };
      };
    }
    case 'added':
      return (a) => {
        if (a.addedAt === null) return { key: 'unknown', label: 'Undated' };
        const d = new Date(a.addedAt);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        return { key, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
      };
    case 'colour':
      return (a) => ({ key: a.colour, label: colourInfo(a.colour).name });
    case 'random':
      return null;
  }
}
