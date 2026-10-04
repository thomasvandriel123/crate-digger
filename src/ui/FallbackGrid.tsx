import { useStore } from '@nanostores/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration } from '../data/format';
import type { Album, Track } from '../data/types';
import { $focus, $layout, $library } from '../state/store';
import { openInSpotifyUrl } from './Spotify';

/**
 * Without WebGL2 the library is still browsable: a plain cover grid with the same filters, sort and
 * search (they drive the same derived layout), grouped by the same dividers.
 */
export function FallbackGrid({
  dataUrl,
  loadTracks,
}: {
  dataUrl: string;
  loadTracks: (a: Album) => Promise<Track[] | null>;
}) {
  const layout = useStore($layout);
  const library = useStore($library);
  const focus = useStore($focus);
  const [open, setOpen] = useState<Album | null>(null);
  if (!layout || !library) return null;

  const groups: { label: string; ids: string[] }[] = [];
  for (const crate of layout.crates) {
    const cuts = crate.dividers.length ? crate.dividers : [{ label: crate.label, at: 0 }];
    cuts.forEach((d, i) => {
      const end = cuts[i + 1]?.at ?? crate.records.length;
      const ids = crate.records.slice(d.at, end);
      const last = groups[groups.length - 1];
      if (last && last.label === d.label) last.ids.push(...ids);
      else groups.push({ label: d.label, ids });
    });
  }

  return (
    <main class="fallback" aria-label="Records">
      <p class="fallback-note">
        Your browser can't show the record room (it needs WebGL2), so here are your records as a plain grid.
        Filters, sort and search work the same.
      </p>
      {layout.matched === 0 ? <p class="fallback-note">Nothing here. Try fewer filters.</p> : null}
      {groups.map((g, gi) => (
        <section class="fallback-group" key={`${g.label}-${gi}`} aria-label={g.label}>
          <h2>{g.label}</h2>
          <div class="fallback-grid">
            {g.ids.map((id) => {
              const a = library.byId.get(id);
              if (!a) return null;
              return (
                <button
                  key={id}
                  type="button"
                  class="cover-card"
                  aria-current={focus.albumId === id ? 'true' : undefined}
                  onClick={() => {
                    $focus.set({ ...focus, albumId: id, via: 'pointer' });
                    setOpen(a);
                  }}
                >
                  {a.cover.thumb.startsWith('generated:') ? (
                    <span class="art plain-art" aria-hidden="true">
                      {a.title}
                    </span>
                  ) : (
                    <img
                      class="art"
                      src={new URL(a.cover.thumb, dataUrl).toString()}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{ background: a.palette.dominant }}
                    />
                  )}
                  <span class="t">{a.title}</span>
                  <span class="a">
                    {a.artist}
                    {a.year ? ` · ${a.year}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {open ? (
        <Detail album={open} dataUrl={dataUrl} loadTracks={loadTracks} onClose={() => setOpen(null)} />
      ) : null}
    </main>
  );
}

function Detail({
  album,
  dataUrl,
  loadTracks,
  onClose,
}: {
  album: Album;
  dataUrl: string;
  loadTracks: (a: Album) => Promise<Track[] | null>;
  onClose: () => void;
}) {
  const [tracks, setTracks] = useState<Track[] | null>(album.tracks);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void loadTracks(album).then(setTracks);
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [album]);
  return (
    <div
      class="detail"
      role="dialog"
      aria-modal="true"
      aria-label={`${album.artist}, ${album.title}`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div class="panel">
        {album.cover.web.startsWith('generated:') ? (
          <span class="art plain-art" aria-hidden="true">
            {album.title}
          </span>
        ) : (
          <img src={new URL(album.cover.web, dataUrl).toString()} alt={`Cover of ${album.title}`} />
        )}
        <div>
          <p class="caption" style={{ display: 'block', minHeight: 0 }}>
            <span class="artist" style={{ display: 'block' }}>
              {album.artist}
            </span>
            <span class="title" style={{ display: 'block', whiteSpace: 'normal' }}>
              {album.title}
            </span>
            <span class="meta" style={{ display: 'block' }}>
              {[album.year, album.label].filter(Boolean).join(' · ')}
            </span>
          </p>
          {tracks ? (
            <ol>
              {tracks.map((t) => (
                <li key={t.n}>
                  {t.title}{' '}
                  <span style={{ opacity: 0.6 }}>{t.durationMs ? formatDuration(t.durationMs) : ''}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {$library.get()?.source === 'spotify' || $library.get()?.source === 'export' ? (
            <a class="action" href={openInSpotifyUrl(album.uri)} target="_blank" rel="noopener noreferrer">
              Open in Spotify
            </a>
          ) : null}{' '}
          <button ref={close} type="button" class="action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
