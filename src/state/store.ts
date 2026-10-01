/**
 * Shared state between the scene and the UI. The scene owns animation; stores carry facts both sides need
 * (filters, the derived layout, what is focused/held/playing). Components read stores; they never drive
 * the render loop.
 */

import { atom, computed } from 'nanostores';
import { DEFAULT_CRATE_CAPACITY } from '../data/crates';
import { EMPTY_FILTERS } from '../data/filters';
import { deriveLayout } from '../data/layout';
import { createSearchIndex } from '../data/search';
import { DEFAULT_SORT } from '../data/sort';
import type { Album, FilterState, Layout, Library, SortState } from '../data/types';
import type { PlaybackState } from '../playback/adapter';

export interface ViewerConfig {
  crateCapacity: number;
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  /** No library to show yet: the welcome panel offers to connect Spotify. */
  | { status: 'welcome' }
  | { status: 'error'; message: string };

export const $load = atom<LoadState>({ status: 'loading' });
export const $library = atom<Library | null>(null);
export const $config = atom<ViewerConfig>({ crateCapacity: DEFAULT_CRATE_CAPACITY });
export const $filters = atom<FilterState>(EMPTY_FILTERS);
export const $sort = atom<SortState>(DEFAULT_SORT);
/** What is typed in the search box right now; debounced into $filters.search. */
export const $searchInput = atom<string>('');

const $searchIndex = computed($library, (lib) => (lib ? createSearchIndex(lib.albums) : null));

/** Ranked search results (best first), or null when there is no query. */
export const $searchResults = computed([$searchIndex, $filters], (index, filters) =>
  index ? index.search(filters.search) : null,
);

let lastLayout: Layout | null = null;

export const $layout = computed(
  [$library, $filters, $sort, $searchResults, $config],
  (library, filters, sort, results, config) => {
    if (!library) return null;
    const layout = deriveLayout(
      library,
      filters,
      sort,
      { now: Date.now(), searchIds: results ? new Set(results) : null },
      config.crateCapacity,
    );
    // Keep identity when nothing changed, so subscribers can compare by reference.
    if (lastLayout && lastLayout.signature === layout.signature) return lastLayout;
    lastLayout = layout;
    return layout;
  },
);

export interface FocusInfo {
  albumId: string | null;
  crate: number;
  crateCount: number;
  /** Position of the focused record in the whole filtered order (0-based). */
  position: number;
  /** How the focus last moved, for focus-visible style affordances. */
  via: 'pointer' | 'keyboard' | 'init';
}

export const $focus = atom<FocusInfo>({ albumId: null, crate: 0, crateCount: 0, position: 0, via: 'init' });
export const $hover = atom<string | null>(null);

export type HeldPhase = 'pulling' | 'held' | 'returning';
export const $held = atom<{ albumId: string; phase: HeldPhase; flipped: boolean } | null>(null);

export type DeckPhaseState = 'empty' | 'loading' | 'playing' | 'paused' | 'ended' | 'unloading';
export const $deck = atom<{ phase: DeckPhaseState; albumId: string | null }>({
  phase: 'empty',
  albumId: null,
});
export const $playback = atom<PlaybackState>({
  status: 'idle',
  albumUri: null,
  positionMs: 0,
  durationMs: 0,
});

export const $sound = atom<boolean>(false);
export const $reducedMotion = atom<boolean>(false);
export const $renderer = atom<'webgl' | 'fallback' | 'pending'>('pending');
export const $mobileFiltersOpen = atom<boolean>(false);

export interface FrameStats {
  fps: number;
  frameMs: number;
  p95: number;
  drawCalls: number;
  triangles: number;
  textureMB: number;
  covers: number;
  pixelRatio: number;
  full: number;
  edges: number;
}
export const $stats = atom<FrameStats | null>(null);
export const $statsVisible = atom<boolean>(false);

export function albumById(id: string | null | undefined): Album | null {
  if (!id) return null;
  return $library.get()?.byId.get(id) ?? null;
}

/** Where the shelves come from, and the Spotify connection behind them. */
export type SpotifyStatus =
  'unconfigured' | 'disconnected' | 'connecting' | 'loading' | 'connected' | 'error';
export interface SpotifyInfo {
  status: SpotifyStatus;
  /** Display name of the connected account, once known. */
  user: string | null;
  /** Loading progress for the splash, e.g. "Reading your saved albums: 150 of 412". */
  progress: string | null;
  /** Last error to show (login refused, session expired, ...). */
  message: string | null;
  /** Why real playback is unavailable (no Premium, unsupported browser), or null when it works. */
  playbackNote: string | null;
}
export const $spotify = atom<SpotifyInfo>({
  status: 'disconnected',
  user: null,
  progress: null,
  message: null,
  playbackNote: null,
});

export function patchSpotify(patch: Partial<SpotifyInfo>): void {
  $spotify.set({ ...$spotify.get(), ...patch });
}
