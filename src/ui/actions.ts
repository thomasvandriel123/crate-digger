/** Filter and sort mutations used by the UI. All state lives in the stores; these are small helpers. */

import { atom } from 'nanostores';
import { EMPTY_FILTERS, removeChip, type FilterChip } from '../data/filters';
import { newSeed } from '../data/random';
import { sortInfo } from '../data/sort';
import type { FilterState, SortMode } from '../data/types';
import { commands } from '../state/commands';
import { $filters, $layout, $searchInput, $searchResults, $sort } from '../state/store';

export function patchFilters(patch: Partial<FilterState>): void {
  $filters.set({ ...$filters.get(), ...patch });
}

export function clearFilters(): void {
  $filters.set({ ...EMPTY_FILTERS });
  $searchInput.set('');
}

export function removeFilterChip(chip: FilterChip): void {
  const next = removeChip($filters.get(), chip);
  $filters.set(next);
  if (chip.key === 'search') $searchInput.set('');
}

export function setSortMode(mode: SortMode): void {
  const current = $sort.get();
  if (current.mode === mode) return;
  $sort.set({ mode, dir: sortInfo(mode).defaultDir, seed: mode === 'random' ? newSeed() : current.seed });
}

export function toggleSortDir(): void {
  const s = $sort.get();
  $sort.set({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' });
}

export function reroll(): void {
  $sort.set({ ...$sort.get(), mode: 'random', seed: newSeed() });
}

/** Search is debounced 120 ms from typing into the filter state. */
export function initSearchDebounce(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return $searchInput.listen((value) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if ($filters.get().search !== value) patchFilters({ search: value });
    }, 120);
  });
}

/** Enter in the search field: focus the best match that is on the shelves. */
export function focusFirstResult(): boolean {
  const pending = $searchInput.get();
  if ($filters.get().search !== pending) patchFilters({ search: pending });
  const results = $searchResults.get();
  const layout = $layout.get();
  if (!results || !layout) return false;
  const first = results.find((id) => layout.slots.has(id));
  if (!first) return false;
  commands.focusAlbum(first);
  return true;
}

/** Only one popover is open at a time. */
export const $openPopover = atom<string | null>(null);
