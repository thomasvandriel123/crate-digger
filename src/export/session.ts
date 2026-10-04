/**
 * Uploaded-export libraries on this page: import a file, show it at once with plain sleeves, then look
 * every album up in the background (about one per second) and refile records as covers and years arrive.
 */

import { normaliseLibrary } from '../data/library';
import type { Album, Library, Track } from '../data/types';
import { genreMap } from '../spotify/genres';
import { paletteFromUrl } from '../spotify/palette';
import { browserStorage } from '../state/storage';
import { $deck, $export, $held, $library } from '../state/store';
import { ExportLibrary } from './library';
import { MusicBrainz } from './musicbrainz';
import { type ExportAlbum, readExportFile } from './parse';

let lib: ExportLibrary | null = null;
let albums: ExportAlbum[] = [];
let job: AbortController | null = null;

function library(): ExportLibrary {
  return (lib ??= new ExportLibrary({
    storage: browserStorage('local'),
    mb: new MusicBrainz(),
    genres: genreMap(),
    palette: (url) => paletteFromUrl(url),
    now: () => Date.now(),
  }));
}

function current(): Library {
  return normaliseLibrary(library().build(albums));
}

/** Refile with the latest facts, but never while a record is in hand or on the deck. */
let pendingApply = false;
function applyWhenIdle(): void {
  const idle = () => $deck.get().phase === 'empty' && $held.get() === null;
  if (idle()) {
    $library.set(current());
    return;
  }
  if (pendingApply) return;
  pendingApply = true;
  const check = () => {
    if (!idle()) return;
    stopDeck();
    stopHeld();
    pendingApply = false;
    $library.set(current());
  };
  const stopDeck = $deck.listen(check);
  const stopHeld = $held.listen(check);
}

/** The uploaded library from an earlier visit, if any. Starts the background lookups. */
export function loadStoredExport(): Library | null {
  const stored = library().stored();
  if (!stored) return null;
  albums = stored.albums;
  $export.set({
    ...$export.get(),
    importedAt: stored.importedAt,
    ...library().progress(albums),
    status: 'paused',
  });
  return current();
}

/** Import an export file; replaces any earlier upload. Throws ExportError with a readable message. */
export async function importExport(file: Blob): Promise<number> {
  const parsed = await readExportFile(file);
  job?.abort();
  const stored = library().save(parsed);
  albums = stored.albums;
  $export.set({
    ...$export.get(),
    importedAt: stored.importedAt,
    ...library().progress(albums),
    status: 'paused',
  });
  return parsed.length;
}

/** Look up covers, years and genres in the background; resumable, and cached per album. */
export function startEnrichment(): void {
  if (albums.length === 0 || $export.get().status === 'running') return;
  job = new AbortController();
  const signal = job.signal;
  $export.set({ ...$export.get(), ...library().progress(albums), status: 'running' });
  void library()
    .enrich(albums, {
      signal,
      onProgress: (p) => $export.set({ ...$export.get(), ...p }),
      onUpdate: applyWhenIdle,
    })
    .then((result) => {
      if (signal.aborted) return;
      $export.set({
        ...$export.get(),
        ...library().progress(albums),
        status: result === 'offline' ? 'offline' : 'done',
      });
    });
}

export function pauseEnrichment(): void {
  job?.abort();
  job = null;
  $export.set({ ...$export.get(), status: 'paused' });
}

/** Forget the uploaded library (and every lookup made for it), then reload into the demo room. */
export function forgetExport(): void {
  job?.abort();
  library().clear();
  location.assign(location.pathname);
}

/** Track list for a held record from an uploaded library (looked up on demand, ahead of the queue). */
export async function exportTracks(album: Album): Promise<Track[] | null> {
  const a = albums.find((x) => x.id === album.id);
  if (!a) return null;
  try {
    const t = await library().tracks(a);
    return t?.tracks.length ? t.tracks : null;
  } catch {
    return null;
  }
}
