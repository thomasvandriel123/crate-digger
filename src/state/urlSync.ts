/**
 * Filters, sort, search and the focused record live in the URL, so any view is linkable and the back
 * button works. The first change in a burst pushes a history entry; further changes within 400 ms
 * replace it, so a slider drag or a run of typing is one step back. Focus moves only replace.
 */

import { parseViewState, serialiseViewState, type ViewState } from '../data/url';
import { $filters, $focus, $searchInput, $sort } from './store';

let applyingFromUrl = false;
let burstTimer: ReturnType<typeof setTimeout> | null = null;
let replaceTimer: ReturnType<typeof setTimeout> | null = null;

function currentState(): ViewState {
  return { filters: $filters.get(), sort: $sort.get(), focus: $focus.get().albumId };
}

function write(mode: 'push' | 'replace'): void {
  const url = `${location.pathname}${serialiseViewState(currentState())}${location.hash}`;
  if (url === `${location.pathname}${location.search}${location.hash}`) return;
  if (mode === 'push') history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

function applyView(view: ViewState): void {
  applyingFromUrl = true;
  $filters.set(view.filters);
  $sort.set(view.sort);
  $searchInput.set(view.filters.search);
  applyingFromUrl = false;
}

/** Reads the initial view from the URL. Returns the album id to focus first, if any. */
export function readInitialView(): string | null {
  const view = parseViewState(location.search);
  applyView(view);
  return view.focus;
}

/** Called with the album id to focus after a popstate (back/forward). */
export function startUrlSync(onNavigate: (focus: string | null) => void): () => void {
  const onViewChange = () => {
    if (applyingFromUrl) return;
    write(burstTimer ? 'replace' : 'push');
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = setTimeout(() => (burstTimer = null), 400);
  };
  const onFocusChange = () => {
    if (applyingFromUrl || replaceTimer) return;
    replaceTimer = setTimeout(() => {
      replaceTimer = null;
      write('replace');
    }, 300);
  };
  const offFilters = $filters.listen(onViewChange);
  const offSort = $sort.listen(onViewChange);
  const offFocus = $focus.listen(onFocusChange);
  const onPop = () => {
    const view = parseViewState(location.search);
    applyView(view);
    onNavigate(view.focus);
  };
  window.addEventListener('popstate', onPop);
  return () => {
    offFilters();
    offSort();
    offFocus();
    window.removeEventListener('popstate', onPop);
  };
}
