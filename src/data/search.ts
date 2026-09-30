import uFuzzy from '@leeoniya/ufuzzy';
import { searchText } from './library';
import { fold } from './text';
import type { Album } from './types';

export interface SearchIndex {
  /** Ranked album ids (best first) for a query; empty query returns null ("no search"). */
  search(query: string): string[] | null;
}

/**
 * Fuzzy match over artist, title and label. uFuzzy handles typos and out-of-order terms cheaply for a few
 * thousand short strings; results are ranked so Enter can focus the best match.
 */
export function createSearchIndex(albums: readonly Album[]): SearchIndex {
  const haystack = albums.map(searchText);
  const ids = albums.map((a) => a.id);
  const uf = new uFuzzy({ intraMode: 1, intraIns: 1 });
  return {
    search(query: string) {
      const needle = fold(query).replace(/\s+/g, ' ').trim();
      if (!needle) return null;
      const [idxs, info, order] = uf.search(haystack, needle, 3, 1e4);
      if (!idxs || idxs.length === 0) return [];
      if (info && order) return order.map((o) => ids[info.idx[o]!]!);
      return idxs.map((i) => ids[i]!);
    },
  };
}
