import { useStore } from '@nanostores/preact';
import { useEffect, useRef } from 'preact/hooks';
import { filterChips, isFilterActive } from '../data/filters';
import { sortInfo } from '../data/sort';
import { $filters, $layout, $library, $mobileFiltersOpen, $searchInput, $sort } from '../state/store';
import { $openPopover, clearFilters, focusFirstResult, removeFilterChip } from './actions';
import {
  AddedOptions,
  ColourOptions,
  dirLabel,
  GenreOptions,
  LabelOptions,
  SortOptions,
  TypeOptions,
  YearOptions,
} from './FilterControls';
import { Close, Sliders } from './icons';
import { Popover } from './Popover';

export function SearchField({ id = 'search' }: { id?: string }) {
  const value = useStore($searchInput);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="search">
      <label class="sr-only" for={id}>
        Search artist, title or label
      </label>
      <input
        ref={input}
        id={id}
        type="search"
        autocomplete="off"
        spellcheck={false}
        placeholder="Search the crates"
        value={value}
        onInput={(e) => $searchInput.set(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (value) $searchInput.set('');
            else input.current?.blur();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (focusFirstResult()) document.getElementById('records')?.focus();
          }
        }}
      />
      {value ? null : <kbd aria-hidden="true">/</kbd>}
    </div>
  );
}

export function FilterBar() {
  const library = useStore($library);
  const filters = useStore($filters);
  const sort = useStore($sort);
  const layout = useStore($layout);
  const chips = filterChips(filters, library);
  const caps = library?.capabilities;
  const sortName = sortInfo(sort.mode).name;
  const dir = sortInfo(sort.mode).directional ? ` · ${dirLabel(sort.mode, sort.dir)}` : '';

  return (
    <header class="strip">
      <div class="strip-row">
        <span class="brand" aria-hidden="true">
          Crate <em>Digger</em>
        </span>
        <h1 class="sr-only">Crate Digger: your record collection</h1>
        <nav class="strip-row filters" aria-label="Filters">
          {caps?.genres ? (
            <Popover
              id="pop-genre"
              label="Genre"
              active={isFilterActive(filters, 'genre')}
              count={filters.genres.length + filters.styles.length || null}
            >
              <GenreOptions />
            </Popover>
          ) : null}
          {caps?.year ? (
            <Popover
              id="pop-year"
              label={filters.year ? `${filters.year[0]}–${filters.year[1]}` : 'Year'}
              title="Release year"
              active={!!filters.year}
            >
              <YearOptions />
            </Popover>
          ) : null}
          <Popover
            id="pop-colour"
            label="Colour"
            active={filters.colours.length > 0}
            count={filters.colours.length || null}
          >
            <ColourOptions />
          </Popover>
          {caps?.added ? (
            <Popover id="pop-added" label="Added" title="Date added" active={!!filters.added}>
              <AddedOptions />
            </Popover>
          ) : null}
          {caps?.label ? (
            <Popover
              id="pop-label"
              label="Label"
              active={filters.labels.length > 0}
              count={filters.labels.length || null}
            >
              <LabelOptions />
            </Popover>
          ) : null}
          <Popover
            id="pop-type"
            label="Type"
            title="Release type"
            active={filters.types.length > 0}
            count={filters.types.length || null}
          >
            <TypeOptions />
          </Popover>
        </nav>
        <SearchField />
        <div class="sort-wrap">
          <Popover
            id="pop-sort"
            label={`${sortName}${dir}`}
            title={`Sort: ${sortName}${dir}`}
            active={sort.mode !== 'artist' || sort.dir !== 'asc'}
          >
            <SortOptions />
          </Popover>
        </div>
      </div>
      <div class="strip-row interactive" role="region" aria-label="Active filters">
        <span class="counter" aria-live="polite" aria-atomic="true">
          {layout
            ? `${layout.matched.toLocaleString('en')} of ${layout.total.toLocaleString('en')} records`
            : ''}
        </span>
        {chips.length > 0 ? (
          <div class="chips">
            {chips.map((chip) => (
              <span class="chip" key={`${chip.key}:${chip.value ?? ''}`}>
                {chip.text}
                <button
                  type="button"
                  aria-label={`Remove filter: ${chip.text}`}
                  onClick={() => removeFilterChip(chip)}
                >
                  <Close />
                </button>
              </span>
            ))}
            {chips.length > 1 ? (
              <button type="button" class="link-button" onClick={clearFilters}>
                Clear all
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** Phone portrait: the filter strip folds into one button that opens a bottom sheet. */
export function MobileFilters() {
  const open = useStore($mobileFiltersOpen);
  const filters = useStore($filters);
  const library = useStore($library);
  const chips = filterChips(filters, library);
  const sheet = useRef<HTMLDivElement>(null);
  const caps = library?.capabilities;

  useEffect(() => {
    if (!open) return;
    $openPopover.set(null);
    sheet.current?.querySelector<HTMLElement>('button, input')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        $mobileFiltersOpen.set(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <>
      <div class="mobile-bar">
        <button
          type="button"
          class="action"
          aria-expanded={open}
          aria-controls="filter-sheet"
          onClick={() => $mobileFiltersOpen.set(!open)}
        >
          <Sliders /> Filters{chips.length ? ` (${chips.length})` : ''}
        </button>
      </div>
      {open ? (
        <>
          <div class="sheet-backdrop" onClick={() => $mobileFiltersOpen.set(false)} />
          <div
            class="sheet"
            id="filter-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Filters and sort"
            ref={sheet}
          >
            <div class="sheet-handle" />
            <div class="row" style={{ justifyContent: 'space-between' }}>
              <button type="button" class="link-button" onClick={clearFilters} disabled={chips.length === 0}>
                Clear filters
              </button>
              <button type="button" class="action" onClick={() => $mobileFiltersOpen.set(false)}>
                Done
              </button>
            </div>
            <section>
              <h3>Sort</h3>
              <SortOptions />
            </section>
            {caps?.genres ? (
              <section>
                <h3>Genre</h3>
                <GenreOptions />
              </section>
            ) : null}
            {caps?.year ? (
              <section>
                <h3>Release year</h3>
                <YearOptions />
              </section>
            ) : null}
            <section>
              <h3>Colour</h3>
              <ColourOptions />
            </section>
            {caps?.added ? (
              <section>
                <h3>Date added</h3>
                <AddedOptions />
              </section>
            ) : null}
            {caps?.label ? (
              <section>
                <h3>Label</h3>
                <LabelOptions />
              </section>
            ) : null}
            <section>
              <h3>Type</h3>
              <TypeOptions />
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
