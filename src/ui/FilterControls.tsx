/**
 * The body of each filter. Used inside the desktop popovers and stacked in the mobile bottom sheet, so
 * both layouts share one implementation. Native inputs throughout (checkboxes, ranges, date inputs).
 */

import { useStore } from '@nanostores/preact';
import { useMemo, useState } from 'preact/hooks';
import { COLOUR_BINS } from '../data/colour';
import { ADDED_PRESETS, makePredicate, toggle, typeName, yearHistogram } from '../data/filters';
import { SORT_MODES, sortInfo } from '../data/sort';
import { ALBUM_TYPES } from '../data/types';
import type { AddedFilter, ColourBin } from '../data/types';
import { $filters, $library, $searchResults, $sort } from '../state/store';
import { patchFilters, reroll, setSortMode, toggleSortDir } from './actions';
import { ArrowUpDown, Chevron, Dice } from './icons';

function useFilterContext() {
  const results = useStore($searchResults);
  return useMemo(() => ({ now: Date.now(), searchIds: results ? new Set(results) : null }), [results]);
}

// --- genre ---------------------------------------------------------------------------------------------

export function GenreOptions() {
  const library = useStore($library);
  const filters = useStore($filters);
  const ctx = useFilterContext();
  const [open, setOpen] = useState<string | null>(null);
  const counts = useMemo(() => {
    const macro = new Map<string, number>();
    const micro = new Map<string, number>();
    if (!library) return { macro, micro };
    const pred = makePredicate(filters, ctx, 'genre');
    for (const a of library.albums) {
      if (!pred(a)) continue;
      a.genres.forEach((g) => macro.set(g, (macro.get(g) ?? 0) + 1));
      a.genresRaw.forEach((g) => micro.set(g, (micro.get(g) ?? 0) + 1));
    }
    return { macro, micro };
  }, [library, filters, ctx]);
  if (!library) return null;
  if (library.taxonomy.length === 0) return <p class="hint">No genre data in this library.</p>;

  return (
    <ul class="option-list" aria-label="Genres">
      {library.taxonomy.map((g) => {
        const n = counts.macro.get(g.id) ?? 0;
        const expanded = open === g.id;
        const microId = `micro-${g.id}`;
        return (
          <li key={g.id}>
            <div class="row" style={{ flexWrap: 'nowrap', gap: '2px' }}>
              {g.micro.length > 0 ? (
                <button
                  type="button"
                  class="disclosure"
                  aria-expanded={expanded}
                  aria-controls={microId}
                  aria-label={`${expanded ? 'Hide' : 'Show'} styles in ${g.name}`}
                  onClick={() => setOpen(expanded ? null : g.id)}
                >
                  <Chevron />
                </button>
              ) : (
                <span style={{ width: '26px', flex: 'none' }} />
              )}
              <label class={`option${n === 0 ? ' is-empty' : ''}`} style={{ flex: 1 }}>
                <input
                  type="checkbox"
                  checked={filters.genres.includes(g.id)}
                  onChange={() => patchFilters({ genres: toggle(filters.genres, g.id) })}
                />
                {g.name}
                <span class="muted">{n}</span>
              </label>
            </div>
            {expanded ? (
              <ul class="micro" id={microId} aria-label={`${g.name} styles`}>
                {g.micro.map((m) => (
                  <li key={m}>
                    <label class={`option${(counts.micro.get(m) ?? 0) === 0 ? ' is-empty' : ''}`}>
                      <input
                        type="checkbox"
                        checked={filters.styles.includes(m)}
                        onChange={() => patchFilters({ styles: toggle(filters.styles, m) })}
                      />
                      {m}
                      <span class="muted">{counts.micro.get(m) ?? 0}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// --- year ----------------------------------------------------------------------------------------------

export function YearOptions() {
  const library = useStore($library);
  const filters = useStore($filters);
  const ctx = useFilterContext();
  const range = library?.yearRange ?? null;
  const committed = filters.year ?? range;
  // Local state while dragging: the histogram highlight follows live, the shelves re-sort on release.
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const hist = useMemo(
    () => (library && range ? yearHistogram(library.albums, filters, ctx, range) : []),
    [library, filters, ctx, range],
  );
  if (!library || !range || !committed) return <p class="hint">No release years in this library.</p>;
  const [lo, hi] = draft ?? committed;
  const max = Math.max(1, ...hist);
  const span = Math.max(1, range[1] - range[0]);
  const commit = (next: [number, number]) => {
    setDraft(null);
    const full = next[0] <= range[0] && next[1] >= range[1];
    patchFilters({ year: full ? null : next });
  };
  const decades: number[] = [];
  for (let d = Math.floor(range[0] / 10) * 10; d <= range[1]; d += 10) decades.push(d);
  const decadeLabel = (d: number) => (d >= 1900 && d < 2000 ? `${String(d).slice(2)}s` : `${d}s`);

  return (
    <div>
      <div class="histogram" aria-hidden="true">
        {hist.map((n, i) => (
          <span
            key={i}
            class={range[0] + i >= lo && range[0] + i <= hi ? 'in' : ''}
            style={{ height: `${Math.max(2, (n / max) * 100)}%` }}
          />
        ))}
      </div>
      <div class="dual-range">
        <div class="track" />
        <div
          class="fill"
          style={{
            left: `${((lo - range[0]) / span) * 100}%`,
            right: `${100 - ((hi - range[0]) / span) * 100}%`,
          }}
        />
        <input
          type="range"
          aria-label="Earliest release year"
          min={range[0]}
          max={range[1]}
          value={lo}
          onInput={(e) => setDraft([Math.min(Number(e.currentTarget.value), hi), hi])}
          onChange={(e) => commit([Math.min(Number(e.currentTarget.value), hi), hi])}
        />
        <input
          type="range"
          aria-label="Latest release year"
          min={range[0]}
          max={range[1]}
          value={hi}
          onInput={(e) => setDraft([lo, Math.max(Number(e.currentTarget.value), lo)])}
          onChange={(e) => commit([lo, Math.max(Number(e.currentTarget.value), lo)])}
        />
      </div>
      <div class="years">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
      <div class="row" role="group" aria-label="Decades">
        {decades.map((d) => {
          const pressed =
            filters.year?.[0] === Math.max(d, range[0]) && filters.year?.[1] === Math.min(d + 9, range[1]);
          return (
            <button
              key={d}
              type="button"
              class="pill"
              aria-pressed={pressed}
              onClick={() =>
                pressed
                  ? patchFilters({ year: null })
                  : commit([Math.max(d, range[0]), Math.min(d + 9, range[1])])
              }
            >
              {decadeLabel(d)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- colour --------------------------------------------------------------------------------------------

export function ColourOptions() {
  const filters = useStore($filters);
  return (
    <div class="swatches" role="group" aria-label="Cover colours">
      {COLOUR_BINS.map((bin) => (
        <button
          key={bin.id}
          type="button"
          class={`swatch${bin.id === 'mono' ? ' mono' : ''}`}
          style={bin.id === 'mono' ? undefined : { background: bin.swatch }}
          aria-pressed={filters.colours.includes(bin.id)}
          aria-label={bin.name}
          title={bin.name}
          onClick={() => patchFilters({ colours: toggle(filters.colours, bin.id as ColourBin) })}
        />
      ))}
    </div>
  );
}

// --- added ---------------------------------------------------------------------------------------------

export function AddedOptions() {
  const filters = useStore($filters);
  const added = filters.added;
  const custom = added && !('preset' in added) ? added : null;
  const setCustom = (patch: Partial<{ from: string | null; to: string | null }>) => {
    const next: AddedFilter = { from: custom?.from ?? null, to: custom?.to ?? null, ...patch };
    patchFilters({ added: next.from || next.to ? next : null });
  };
  return (
    <div>
      <div class="row" role="group" aria-label="Added presets" style={{ marginBottom: '12px' }}>
        {ADDED_PRESETS.map((p) => {
          const pressed = !!added && 'preset' in added && added.preset === p.id;
          return (
            <button
              key={p.id}
              type="button"
              class="pill"
              aria-pressed={pressed}
              onClick={() => patchFilters({ added: pressed ? null : { preset: p.id } })}
            >
              {p.name}
            </button>
          );
        })}
      </div>
      <label class="hint" for="added-from">
        From
      </label>
      <input
        id="added-from"
        type="date"
        value={custom?.from ?? ''}
        onChange={(e) => setCustom({ from: e.currentTarget.value || null })}
      />
      <label class="hint" for="added-to">
        To
      </label>
      <input
        id="added-to"
        type="date"
        value={custom?.to ?? ''}
        onChange={(e) => setCustom({ to: e.currentTarget.value || null })}
      />
    </div>
  );
}

// --- label ---------------------------------------------------------------------------------------------

export function LabelOptions() {
  const library = useStore($library);
  const filters = useStore($filters);
  const [q, setQ] = useState('');
  const labels = useMemo(() => {
    const all = library?.labels ?? [];
    const needle = q.trim().toLowerCase();
    const matching = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all;
    // Selected labels stay visible at the top.
    return [
      ...filters.labels.filter((l) => matching.includes(l)),
      ...matching.filter((l) => !filters.labels.includes(l)),
    ].slice(0, 200);
  }, [library, filters.labels, q]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    library?.albums.forEach((a) => a.label && m.set(a.label, (m.get(a.label) ?? 0) + 1));
    return m;
  }, [library]);
  return (
    <div>
      <input
        type="text"
        placeholder="Find a label"
        aria-label="Find a label"
        value={q}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <ul class="option-list" aria-label="Labels">
        {labels.map((l) => (
          <li key={l}>
            <label class="option">
              <input
                type="checkbox"
                checked={filters.labels.includes(l)}
                onChange={() => patchFilters({ labels: toggle(filters.labels, l) })}
              />
              {l}
              <span class="muted">{counts.get(l) ?? 0}</span>
            </label>
          </li>
        ))}
        {labels.length === 0 ? <li class="hint">No label matches “{q}”.</li> : null}
      </ul>
    </div>
  );
}

// --- type ----------------------------------------------------------------------------------------------

export function TypeOptions() {
  const filters = useStore($filters);
  return (
    <div class="row" role="group" aria-label="Release type">
      {ALBUM_TYPES.map((t) => (
        <button
          key={t}
          type="button"
          class="pill"
          aria-pressed={filters.types.includes(t)}
          onClick={() => patchFilters({ types: toggle(filters.types, t) })}
        >
          {typeName(t)}
        </button>
      ))}
    </div>
  );
}

// --- sort ----------------------------------------------------------------------------------------------

export function SortOptions() {
  const sort = useStore($sort);
  const info = sortInfo(sort.mode);
  return (
    <div>
      <ul class="option-list" role="radiogroup" aria-label="Sort by">
        {SORT_MODES.map((m) => (
          <li key={m.id}>
            <label class="option">
              <input
                type="radio"
                name="sort-mode"
                checked={sort.mode === m.id}
                onChange={() => setSortMode(m.id)}
              />
              {m.name}
            </label>
          </li>
        ))}
      </ul>
      <div class="row" style={{ marginTop: '8px' }}>
        {info.directional ? (
          <button
            type="button"
            class="pill"
            onClick={toggleSortDir}
            aria-label={`Direction: ${dirLabel(sort.mode, sort.dir)}. Reverse`}
          >
            <ArrowUpDown dir={sort.dir} /> {dirLabel(sort.mode, sort.dir)}
          </button>
        ) : (
          <button type="button" class="pill" onClick={reroll}>
            <Dice /> Dig again
          </button>
        )}
      </div>
    </div>
  );
}

export function dirLabel(mode: string, dir: 'asc' | 'desc'): string {
  switch (mode) {
    case 'artist':
    case 'title':
      return dir === 'asc' ? 'A to Z' : 'Z to A';
    case 'year':
      return dir === 'asc' ? 'Old to new' : 'New to old';
    case 'added':
      return dir === 'asc' ? 'Oldest first' : 'Newest first';
    case 'colour':
      return dir === 'asc' ? 'Red to violet' : 'Violet to red';
    default:
      return '';
  }
}
