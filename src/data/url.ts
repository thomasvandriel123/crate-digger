import { isColourBin } from './colour';
import { EMPTY_FILTERS } from './filters';
import { DEFAULT_SORT, SORT_MODES, sortInfo } from './sort';
import { ALBUM_TYPES } from './types';
import type { AddedFilter, AlbumType, ColourBin, FilterState, SortMode, SortState } from './types';

/**
 * View state <-> URL query, e.g. `?genre=jazz,soul&year=1965-1979&sort=added-desc`.
 * Defaults are omitted so a plain URL is the default view. Free-text values (labels, micro genres) use
 * repeated keys, so commas inside them survive.
 */

export interface ViewState {
  filters: FilterState;
  sort: SortState;
  /** Album id of the focused record, so a shared link lands on the same record. */
  focus: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function list(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseAdded(value: string | null): AddedFilter | null {
  if (!value) return null;
  if (value === 'month' || value === 'year' || value === 'pre2020') return { preset: value };
  const [from, to] = value.split('..');
  const f = from && DATE.test(from) ? from : null;
  const t = to && DATE.test(to) ? to : null;
  return f || t ? { from: f, to: t } : null;
}

export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search);
  const filters: FilterState = { ...EMPTY_FILTERS };

  filters.genres = [...new Set(list(p, 'genre').map((g) => g.toLowerCase()))];
  filters.styles = [...new Set(p.getAll('style').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const year = p.get('year');
  if (year) {
    const m = /^(\d{4})(?:-(\d{4}))?$/.exec(year);
    if (m) {
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      filters.year = [Math.min(lo, hi), Math.max(lo, hi)];
    }
  }
  filters.colours = [...new Set(list(p, 'colour').filter(isColourBin))] as ColourBin[];
  filters.added = parseAdded(p.get('added'));
  filters.labels = [...new Set(p.getAll('label').map((l) => l.trim()).filter(Boolean))];
  filters.types = [...new Set(list(p, 'type').filter((t): t is AlbumType => ALBUM_TYPES.includes(t as AlbumType)))];
  filters.search = (p.get('q') ?? '').slice(0, 200);

  const sort: SortState = { ...DEFAULT_SORT };
  const sortParam = p.get('sort');
  if (sortParam) {
    const [mode, dir] = sortParam.split('-');
    if (SORT_MODES.some((m) => m.id === mode)) {
      sort.mode = mode as SortMode;
      sort.dir = dir === 'asc' || dir === 'desc' ? dir : sortInfo(sort.mode).defaultDir;
    }
  }
  const seed = Number(p.get('seed'));
  if (Number.isInteger(seed) && seed > 0) sort.seed = seed >>> 0;

  const focus = p.get('r');
  return { filters, sort, focus: focus && /^[A-Za-z0-9]{1,64}$/.test(focus) ? focus : null };
}

export function serialiseViewState(state: ViewState): string {
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.genres.length) p.set('genre', f.genres.join(','));
  f.styles.forEach((s) => p.append('style', s));
  if (f.year) p.set('year', f.year[0] === f.year[1] ? String(f.year[0]) : `${f.year[0]}-${f.year[1]}`);
  if (f.colours.length) p.set('colour', f.colours.join(','));
  if (f.added) {
    p.set('added', 'preset' in f.added ? f.added.preset : `${f.added.from ?? ''}..${f.added.to ?? ''}`);
  }
  f.labels.forEach((l) => p.append('label', l));
  if (f.types.length) p.set('type', f.types.join(','));
  if (f.search.trim()) p.set('q', f.search.trim());

  const s = state.sort;
  const info = sortInfo(s.mode);
  if (s.mode !== DEFAULT_SORT.mode || s.dir !== DEFAULT_SORT.dir) {
    p.set('sort', info.directional && s.dir !== info.defaultDir ? `${s.mode}-${s.dir}` : s.mode);
  }
  if (s.mode === 'random') p.set('seed', String(s.seed));
  if (state.focus) p.set('r', state.focus);

  const out = p.toString().replace(/%2C/g, ',');
  return out ? `?${out}` : '';
}
