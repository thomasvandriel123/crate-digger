import { packCrates } from './crates';
import { applyFilters, type FilterContext } from './filters';
import { groupFn, sortAlbums } from './sort';
import type { FilterState, Layout, Library, Slot, SortState } from './types';

/**
 * The single derived view the scene renders: library + filters + sort -> crates with dividers.
 * Pure. The scene reconciles its persistent record objects against this, which is what turns every
 * filter or sort change into an animation instead of a redraw.
 */
export function deriveLayout(
  library: Library,
  filters: FilterState,
  sort: SortState,
  ctx: FilterContext,
  capacity: number,
): Layout {
  const filtered = applyFilters(library.albums, filters, ctx);
  const sorted = sortAlbums(filtered, sort);
  const crates = packCrates(sorted, groupFn(sort.mode, sorted), capacity);
  const order = sorted.map((a) => a.id);
  const slots = new Map<string, Slot>();
  for (const crate of crates) {
    crate.records.forEach((id, index) => slots.set(id, { crate: crate.index, index }));
  }
  return {
    crates,
    order,
    slots,
    matched: order.length,
    total: library.albums.length,
    signature: `${capacity}|${crates.map((c) => `${c.records.join(',')}/${c.dividers.map((d) => `${d.at}:${d.label}`).join(',')}`).join('|')}`,
  };
}

/**
 * Where focus goes after a re-shelve: the same record if it still matches, else the nearest matching
 * neighbour in the previous order (looking forward first, then back), else the first record.
 */
export function resolveFocus(prevFocus: string | null, prevOrder: readonly string[], next: Layout): string | null {
  if (next.order.length === 0) return null;
  if (prevFocus && next.slots.has(prevFocus)) return prevFocus;
  const i = prevFocus ? prevOrder.indexOf(prevFocus) : -1;
  if (i >= 0) {
    for (let d = 1; d < prevOrder.length; d++) {
      const ahead = prevOrder[i + d];
      if (ahead !== undefined && next.slots.has(ahead)) return ahead;
      const behind = prevOrder[i - d];
      if (behind !== undefined && next.slots.has(behind)) return behind;
      if (ahead === undefined && behind === undefined) break;
    }
  }
  return next.order[0]!;
}
