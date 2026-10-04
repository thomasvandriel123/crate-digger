/**
 * Getting your own records into the room: the "Bring your records" dialog (Connect Spotify for invited
 * accounts, a data-export upload for everyone), the corner menu for whichever collection is showing, and
 * the welcome panel when there is nothing to shelve yet.
 */

import { useStore } from '@nanostores/preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { forgetExport, importExport, pauseEnrichment, startEnrichment } from '../export/session';
import { connectSpotify, disconnectSpotify } from '../spotify/session';
import { $bringOpen, $export, $library, $load, $spotify } from '../state/store';

const PRIVACY_URL = 'privacy.html';
const SPOTIFY_PRIVACY = 'https://www.spotify.com/account/privacy/';

/** Link to an album in Spotify's own player (web or app); a search when only artist and title are known. */
export function openInSpotifyUrl(uri: string): string {
  const album = /^spotify:album:([A-Za-z0-9]+)$/.exec(uri);
  if (album) return `https://open.spotify.com/album/${album[1]}`;
  const search = /^spotify:search:(.+)$/.exec(uri);
  return `https://open.spotify.com/search/${search ? search[1] : encodeURIComponent(uri)}`;
}

function ConnectButton({ primary = false }: { primary?: boolean }) {
  const spotify = useStore($spotify);
  const busy = spotify.status === 'connecting';
  return (
    <button
      type="button"
      class={`action spotify-connect${primary ? ' primary' : ''}`}
      onClick={connectSpotify}
      disabled={busy}
      aria-busy={busy}
    >
      <span class="spotify-dot" aria-hidden="true" />
      {busy ? 'Opening Spotify…' : 'Connect Spotify'}
    </button>
  );
}

function minutes(albums: number): string {
  const m = Math.ceil((albums * 1.2) / 60);
  return m <= 1 ? 'about a minute' : `about ${m} minutes`;
}

/** Drop zone / file picker for the export. Reads the file here, then reloads into the new crates. */
function UploadExport() {
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: boolean }>({
    busy: false,
    message: null,
    error: false,
  });
  const [over, setOver] = useState(false);
  const take = async (file: File | undefined) => {
    if (!file) return;
    setState({ busy: true, message: `Reading ${file.name}…`, error: false });
    try {
      const n = await importExport(file);
      setState({ busy: true, message: `Found ${n} albums. Filling your crates…`, error: false });
      location.assign(location.pathname);
    } catch (err) {
      setState({ busy: false, message: (err as Error).message, error: true });
    }
  };
  return (
    <div
      class={`dropzone${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer?.files[0]);
      }}
    >
      <label class="action primary upload-button">
        <input
          type="file"
          accept=".zip,.json,application/zip,application/json"
          class="sr-only"
          disabled={state.busy}
          onChange={(e) => void take((e.currentTarget as HTMLInputElement).files?.[0])}
        />
        {state.busy ? 'Reading…' : 'Choose the zip or YourLibrary.json'}
      </label>
      <span class="dropzone-hint">or drop it here</span>
      {state.message ? (
        <p class={state.error ? 'spotify-error' : 'upload-status'} role={state.error ? 'alert' : 'status'}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** The two ways in, side by side. Used in the dialog and on the welcome panel. */
function BringContent() {
  const spotify = useStore($spotify);
  return (
    <>
      {spotify.message ? (
        <p class="spotify-error" role="alert">
          {spotify.message}
        </p>
      ) : null}
      <div class="bring-options">
        <section class="bring-option" aria-labelledby="bring-upload">
          <h2 id="bring-upload">Upload your Spotify library</h2>
          <ol>
            <li>
              Request your <strong>Account data</strong> on{' '}
              <a href={SPOTIFY_PRIVACY} target="_blank" rel="noopener noreferrer">
                Spotify's privacy page
              </a>
              . Spotify emails it within a few days.
            </li>
            <li>
              Add the zip here. Your saved albums appear at once; covers and years fill in as you browse.
            </li>
          </ol>
          <UploadExport />
        </section>
        {spotify.status !== 'unconfigured' ? (
          <section class="bring-option" aria-labelledby="bring-connect">
            <h2 id="bring-connect">Connect Spotify</h2>
            <p>
              Your live library, and records play in this tab (Premium). Invite-only for now: Spotify lets an
              app like this serve five accounts.
            </p>
            <div class="welcome-actions">
              <ConnectButton />
            </div>
          </section>
        ) : null}
      </div>
      <p class="spotify-hint">
        Your file is read in this browser and never uploaded. Covers and release years are looked up from your
        browser on MusicBrainz and the Cover Art Archive. <a href={PRIVACY_URL}>Privacy</a>
      </p>
    </>
  );
}

/** Modal dialog with both ways in. */
export function BringDialog() {
  const open = useStore($bringOpen);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('h1')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      $bringOpen.set(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="notice bring-backdrop" onClick={(e) => e.target === e.currentTarget && $bringOpen.set(false)}>
      <div
        ref={panel}
        class="panel welcome bring"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bring-title"
      >
        <h1 id="bring-title" tabIndex={-1}>
          Bring your records
        </h1>
        <BringContent />
        <div class="welcome-actions">
          <button type="button" class="action" onClick={() => $bringOpen.set(false)}>
            Keep browsing
          </button>
        </div>
      </div>
    </div>
  );
}

/** A disclosure menu anchored in the corner. */
function CornerMenu({
  label,
  dot,
  title,
  children,
}: {
  label: ComponentChildren;
  dot: string;
  title: string;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div class="spotify-account" ref={root}>
      <button
        ref={button}
        type="button"
        class="action spotify-connect"
        aria-expanded={open}
        aria-controls="corner-menu"
        onClick={() => setOpen(!open)}
      >
        <span class={`spotify-dot ${dot}`} aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <div id="corner-menu" class="spotify-menu panel" role="group" aria-label={title}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ExportProgress() {
  const info = useStore($export);
  if (info.total === 0) return null;
  if (info.status === 'done' || info.remaining === 0) {
    return (
      <p>
        Found {info.found} of {info.total} albums on MusicBrainz. The rest keep plain sleeves.
      </p>
    );
  }
  return (
    <>
      <p role="status">
        {info.status === 'offline'
          ? 'MusicBrainz is not answering right now. '
          : info.status === 'running'
            ? 'Finding covers and years: '
            : 'Covers and years paused: '}
        {info.done} of {info.total} looked up, {minutes(info.remaining)} to go.
      </p>
      <button
        type="button"
        class="action"
        onClick={() => (info.status === 'running' ? pauseEnrichment() : startEnrichment())}
      >
        {info.status === 'running' ? 'Pause' : 'Resume'}
      </button>{' '}
    </>
  );
}

/** Corner control for whichever collection is on the shelves. */
export function SpotifyCorner() {
  const spotify = useStore($spotify);
  const library = useStore($library);
  const load = useStore($load);
  const info = useStore($export);
  // The welcome panel carries its own ways in.
  if (load.status === 'welcome' || !library) return null;

  if (library.source === 'spotify') {
    return (
      <CornerMenu
        title="Spotify account"
        dot={spotify.status === 'error' ? 'is-error' : 'is-on'}
        label={<span class="spotify-name">{spotify.user ?? 'Spotify'}</span>}
      >
        <p>Showing the {library.albums.length} albums saved in your Spotify library.</p>
        {spotify.message ? <p class="spotify-error">{spotify.message}</p> : null}
        {spotify.playbackNote ? <p>{spotify.playbackNote} The turntable keeps time without sound.</p> : null}
        <button type="button" class="action" onClick={disconnectSpotify}>
          Disconnect Spotify
        </button>
      </CornerMenu>
    );
  }

  if (library.source === 'export') {
    return (
      <CornerMenu
        title="Your records"
        dot={info.status === 'running' ? 'is-busy' : 'is-on'}
        label={<span class="spotify-name">Your records</span>}
      >
        <p>{library.albums.length} albums from your Spotify data export.</p>
        <ExportProgress />
        <div class="menu-actions">
          <button type="button" class="action" onClick={() => $bringOpen.set(true)}>
            Upload a newer export
          </button>
          <button type="button" class="action" onClick={forgetExport}>
            Forget my records
          </button>
        </div>
        <p class="spotify-hint">
          Kept only in this browser. Metadata from MusicBrainz, covers from the Cover Art Archive.{' '}
          <a href={PRIVACY_URL}>Privacy</a>
        </p>
      </CornerMenu>
    );
  }

  return (
    <button type="button" class="action spotify-connect" onClick={() => $bringOpen.set(true)}>
      <span class="spotify-dot" aria-hidden="true" />
      Bring your records
    </button>
  );
}

/** Full-screen panel when there is no library yet (fresh site, nothing saved, or signed out). */
export function Welcome() {
  const spotify = useStore($spotify);
  const signedIn = spotify.status === 'connected';
  return (
    <div class="notice" role="region" aria-label="Welcome">
      <div class="panel welcome bring">
        <h1>{signedIn ? 'No saved albums yet' : 'Bring your records'}</h1>
        {signedIn ? (
          <>
            <p>
              Your Spotify library has no saved albums. Save a few albums in Spotify (the + on an album page),
              then come back and they will be waiting in the crates.
            </p>
            <div class="welcome-actions">
              <button type="button" class="action primary" onClick={() => location.reload()}>
                Look again
              </button>
              <button type="button" class="action" onClick={disconnectSpotify}>
                Disconnect Spotify
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Crate Digger turns your Spotify albums into a record room: wooden crates to flip through by
              hand, and a turntable to put them on.
            </p>
            <BringContent />
          </>
        )}
      </div>
    </div>
  );
}
