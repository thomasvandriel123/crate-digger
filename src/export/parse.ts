/**
 * Spotify's account data download ("Account data" on spotify.com/account/privacy): a zip with
 * `Spotify Account Data/YourLibrary.json`. That file lists saved albums as artist/album/uri triples, and
 * liked songs as artist/album/track/uri, with no dates, covers or other metadata. Parsed entirely in
 * the browser; the file never leaves the visitor's device.
 */

import { hashString } from '../data/random';

export interface ExportAlbum {
  /** Spotify album id when the export has one, else a stable id derived from artist + title. */
  id: string;
  /** spotify:album:… when known, else a spotify:search:… URI for "Open in Spotify". */
  uri: string;
  artist: string;
  title: string;
  /** How the album got into the library. */
  from: 'saved' | 'liked';
}

export class ExportError extends Error {}

/** Albums with at least this many liked songs count as part of the collection when none are saved. */
export const LIKED_THRESHOLD = 3;

type Json = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function parseExport(json: unknown): ExportAlbum[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ExportError('This is not a YourLibrary.json file.');
  }
  const o = json as Json;
  const albumsRaw = Array.isArray(o.albums) ? o.albums : null;
  const tracksRaw = Array.isArray(o.tracks) ? o.tracks : null;
  if (!albumsRaw && !tracksRaw) {
    throw new ExportError('YourLibrary.json has no albums or tracks. Is this the right file?');
  }

  const out: ExportAlbum[] = [];
  const seen = new Set<string>();
  for (const entry of albumsRaw ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Json;
    const uri = text(e.uri);
    const m = /^spotify:album:([A-Za-z0-9]+)$/.exec(uri);
    const artist = text(e.artist);
    const title = text(e.album);
    if (!m || !title || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ id: m[1]!, uri, artist: artist || 'Unknown artist', title, from: 'saved' });
  }

  // Without saved albums, the albums the visitor loves most in Liked Songs make the collection.
  if (out.length === 0 && tracksRaw) {
    const counts = new Map<string, { artist: string; title: string; n: number }>();
    for (const entry of tracksRaw) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Json;
      const artist = text(e.artist);
      const title = text(e.album);
      if (!artist || !title) continue;
      const key = `${artist.toLowerCase()}\u0000${title.toLowerCase()}`;
      const c = counts.get(key) ?? { artist, title, n: 0 };
      c.n++;
      counts.set(key, c);
    }
    for (const [key, c] of counts) {
      if (c.n < LIKED_THRESHOLD) continue;
      out.push({
        id: `liked-${hashString(key).toString(36)}`,
        uri: `spotify:search:${encodeURIComponent(`${c.artist} ${c.title}`)}`,
        artist: c.artist,
        title: c.title,
        from: 'liked',
      });
    }
  }
  if (out.length === 0) {
    throw new ExportError(
      `No saved albums in this export (and no album with ${LIKED_THRESHOLD}+ liked songs). Save some albums in Spotify and request a new export.`,
    );
  }
  return out;
}

const decoder = new TextDecoder();

/** Reads a dropped/chosen file: the export zip as Spotify sends it, or the YourLibrary.json inside. */
export async function readExportFile(file: Blob & { name?: string }): Promise<ExportAlbum[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let jsonText: string;
  if (isZip) {
    const { unzipSync } = await import('fflate');
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => /(^|\/)YourLibrary\.json$/i.test(f.name) });
    } catch {
      throw new ExportError('That zip could not be opened.');
    }
    const entry = Object.values(files)[0];
    if (!entry) {
      throw new ExportError(
        'No YourLibrary.json in that zip. Use the "Account data" export, not the extended streaming history.',
      );
    }
    jsonText = decoder.decode(entry);
  } else {
    jsonText = decoder.decode(bytes);
  }
  let json: unknown;
  try {
    json = JSON.parse(jsonText.replace(/^\uFEFF/, ''));
  } catch {
    throw new ExportError('That file is not valid JSON. Choose YourLibrary.json or the zip Spotify sent.');
  }
  return parseExport(json);
}
