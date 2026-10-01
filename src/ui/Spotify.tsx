/**
 * Spotify connection UI: the Connect button and account menu in the corner, and the welcome panel shown
 * when there is nothing to shelve yet.
 */

import { useStore } from '@nanostores/preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { connectSpotify, disconnectSpotify } from '../spotify/session';
import { $library, $load, $spotify } from '../state/store';

/** Link to an album in Spotify's own player (web or app). */
export function openInSpotifyUrl(albumId: string): string {
  return `https://open.spotify.com/album/${encodeURIComponent(albumId)}`;
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

function SetupHint() {
  return (
    <p class="spotify-hint">
      Spotify is not set up for this site yet: register an app in the Spotify developer dashboard and build
      with <code>VITE_SPOTIFY_CLIENT_ID</code>. See <code>README.md</code> (Connect Spotify).
    </p>
  );
}

/** Corner control: Connect when signed out, the account with a Disconnect menu when signed in. */
export function SpotifyCorner() {
  const spotify = useStore($spotify);
  const library = useStore($library);
  const load = useStore($load);
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

  // The welcome panel carries its own Connect button.
  if (load.status === 'welcome') return null;

  const fromSpotify = library?.source === 'spotify';
  const menu = (children: ComponentChildren) =>
    open ? (
      <div id="spotify-menu" class="spotify-menu panel" role="group" aria-label="Spotify account">
        {children}
      </div>
    ) : null;
  const toggle = (label: ComponentChildren, dot: string) => (
    <button
      ref={button}
      type="button"
      class="action spotify-connect"
      aria-expanded={open}
      aria-controls="spotify-menu"
      onClick={() => setOpen(!open)}
    >
      <span class={`spotify-dot ${dot}`} aria-hidden="true" />
      {label}
    </button>
  );

  if (spotify.status === 'unconfigured') {
    return (
      <div class="spotify-account" ref={root}>
        {toggle('Connect Spotify', '')}
        {menu(<SetupHint />)}
      </div>
    );
  }

  if (!fromSpotify) {
    return (
      <div class="spotify-account" ref={root}>
        <ConnectButton />
        {spotify.message ? (
          <p class="spotify-menu panel spotify-error" role="alert">
            {spotify.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div class="spotify-account" ref={root}>
      {toggle(
        <span class="spotify-name">{spotify.user ?? 'Spotify'}</span>,
        spotify.status === 'error' ? 'is-error' : 'is-on',
      )}
      {menu(
        <>
          <p>Showing the {library?.albums.length ?? 0} albums saved in your Spotify library.</p>
          {spotify.message ? <p class="spotify-error">{spotify.message}</p> : null}
          {spotify.playbackNote ? (
            <p>{spotify.playbackNote} The turntable keeps time without sound.</p>
          ) : null}
          <button type="button" class="action" onClick={disconnectSpotify}>
            Disconnect Spotify
          </button>
        </>,
      )}
    </div>
  );
}

/** Full-screen panel when there is no library yet (fresh install, nothing saved, or signed out). */
export function Welcome() {
  const spotify = useStore($spotify);
  const signedIn = spotify.status === 'connected';
  return (
    <div class="notice" role="region" aria-label="Welcome">
      <div class="panel welcome">
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
              Connect your Spotify account to walk through the albums you saved, filed in wooden crates, and
              play them on the turntable.
            </p>
            {spotify.message ? (
              <p class="spotify-error" role="alert">
                {spotify.message}
              </p>
            ) : null}
            {spotify.status === 'unconfigured' ? (
              <SetupHint />
            ) : (
              <div class="welcome-actions">
                <ConnectButton primary />
              </div>
            )}
            <p class="spotify-hint">
              Read-only access to your saved albums, plus playback in this tab (Spotify Premium). Nothing is
              sent anywhere but Spotify; disconnect at any time.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
