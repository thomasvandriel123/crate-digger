import type { Group } from './sort';
import type { Album, Crate, Divider } from './types';

export const DEFAULT_CRATE_CAPACITY = 48;

/**
 * Packs a sorted list into crates of at most `capacity` records, with a divider card at every group
 * boundary and at the front of every crate (so each crate starts with a readable tab).
 *
 * Dividers take no capacity: they are zero-thickness cards in the fan.
 */
export function packCrates(
  sorted: readonly Album[],
  group: ((a: Album) => Group) | null,
  capacity: number = DEFAULT_CRATE_CAPACITY,
): Crate[] {
  const cap = Math.max(1, Math.floor(capacity));
  const crates: Crate[] = [];
  let records: string[] = [];
  let dividers: Divider[] = [];
  let groups: string[] = [];
  let prevKey: string | null = null;

  const flush = () => {
    if (records.length === 0) return;
    crates.push({ key: records[0]!, index: crates.length, records, dividers, label: crateLabel(groups, crates.length) });
    records = [];
    dividers = [];
    groups = [];
  };

  for (const album of sorted) {
    if (records.length >= cap) flush();
    const g = group ? group(album) : null;
    if (g && (g.key !== prevKey || records.length === 0)) {
      dividers.push({ label: g.label, at: records.length });
      if (groups[groups.length - 1] !== g.label) groups.push(g.label);
    }
    records.push(album.id);
    prevKey = g ? g.key : null;
  }
  flush();
  return crates;
}

function crateLabel(groups: string[], index: number): string {
  if (groups.length === 0) return `Crate ${index + 1}`;
  const first = groups[0]!;
  const last = groups[groups.length - 1]!;
  return first === last ? first : `${first}–${last}`;
}
