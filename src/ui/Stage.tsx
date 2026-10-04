/**
 * Overlay components that sit over the 3D stage: caption plate, hold controls, now playing, sound toggle,
 * the empty-state action and the dev stats overlay.
 */

import { useStore } from '@nanostores/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration } from '../data/format';
import { typeName } from '../data/filters';
import type { Album } from '../data/types';
import { commands } from '../state/commands';
import {
  $deck,
  $focus,
  $held,
  $hover,
  $layout,
  $library,
  $playback,
  $sound,
  $spotify,
  $stats,
  $statsVisible,
  albumById,
} from '../state/store';
import { clearFilters } from './actions';
import { Back, Eject, Flip, Pause, Play, SpeakerOff, SpeakerOn } from './icons';
import { openInSpotifyUrl, SpotifyCorner } from './Spotify';

// --- caption -------------------------------------------------------------------------------------------

interface Plate {
  key: number;
  album: Album;
  out: boolean;
}

/** Artist, title and year of the focused (or hovered, or held) record; cross-fades in 180 ms. */
export function Caption() {
  const focus = useStore($focus);
  const hover = useStore($hover);
  const held = useStore($held);
  const id = held?.albumId ?? hover ?? focus.albumId;
  const album = albumById(id);
  const [plates, setPlates] = useState<Plate[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    const key = ++counter.current;
    // The outgoing plate fades out while the new one mounts faded out, then fades in on the next frame.
    setPlates((prev) => [
      ...prev.map((p) => ({ ...p, out: true })),
      ...(album ? [{ key, album, out: true }] : []),
    ]);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() =>
        setPlates((prev) => prev.map((p) => (p.key === key ? { ...p, out: false } : p))),
      );
    });
    const t = setTimeout(() => setPlates((prev) => prev.filter((p) => p.key === key)), 220);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(t);
    };
  }, [album?.id]);

  return (
    <div class="caption" aria-hidden="true">
      {plates.map((p) => (
        <div key={p.key} class={`caption-plate panel${p.out ? ' is-out' : ''}`}>
          <div class="artist">{p.album.artist}</div>
          <div class="title">{p.album.title}</div>
          <div class="meta">
            {[
              p.album.year,
              held?.albumId === p.album.id ? p.album.label : null,
              held?.albumId === p.album.id && p.album.type !== 'album' ? typeName(p.album.type) : null,
            ]
              .filter(Boolean)
              .join('  ·  ')}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HoldControls() {
  const held = useStore($held);
  if (!held || held.phase === 'returning') return null;
  return (
    <div class="hold-controls interactive" role="toolbar" aria-label="Record in hand">
      <button type="button" class="action" onClick={() => commands.flip()} aria-pressed={held.flipped}>
        <Flip /> {held.flipped ? 'Front' : 'Flip'} <kbd>F</kbd>
      </button>
      <button type="button" class="action primary" onClick={() => commands.playOrPause()}>
        <Play /> Play <kbd>Space</kbd>
      </button>
      <button type="button" class="action" onClick={() => commands.release()}>
        <Back /> Put back <kbd>Esc</kbd>
      </button>
    </div>
  );
}

export function LowerThird() {
  return (
    <div class="lower-third">
      <Caption />
      <HoldControls />
    </div>
  );
}

// --- now playing ---------------------------------------------------------------------------------------

export function NowPlaying() {
  const deck = useStore($deck);
  const playback = useStore($playback);
  const library = useStore($library);
  const spotify = useStore($spotify);
  const album = albumById(deck.albumId);
  if (deck.phase === 'empty' || !album) return null;
  const busy = deck.phase === 'loading' || deck.phase === 'unloading';
  const label =
    deck.phase === 'loading'
      ? 'Cueing up'
      : deck.phase === 'paused'
        ? 'Paused'
        : deck.phase === 'ended'
          ? 'Run-out groove'
          : deck.phase === 'unloading'
            ? 'Putting away'
            : 'Now playing';
  // Real Spotify albums (live or uploaded) can always be opened in Spotify; only a live connection plays here.
  const fromSpotify = library?.source === 'spotify' || library?.source === 'export';
  const realPlayback = library?.source === 'spotify' && !spotify.playbackNote;
  const duration = playback.durationMs || album.durationMs || 0;
  const position = deck.phase === 'ended' ? duration : playback.positionMs;
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <section class="now-playing panel interactive" aria-label="Turntable">
      <div class="label" aria-live="polite">
        {label}
      </div>
      <div class="np-title">{album.title}</div>
      <div class="np-artist">{album.artist}</div>
      <div
        class="progress"
        role="progressbar"
        aria-label="Album progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <div class="np-row">
        <span>{formatDuration(position)}</span>
        <span>{duration ? formatDuration(duration) : '--:--'}</span>
      </div>
      <div class="np-actions">
        {deck.phase === 'playing' || deck.phase === 'paused' || deck.phase === 'ended' ? (
          <button type="button" class="action" onClick={() => commands.playOrPause()} disabled={busy}>
            {deck.phase === 'playing' ? <Pause /> : <Play />}{' '}
            {deck.phase === 'playing' ? 'Pause' : deck.phase === 'ended' ? 'Play again' : 'Resume'}
          </button>
        ) : null}
        <button
          type="button"
          class="action"
          onClick={() => commands.stopAndPutAway()}
          disabled={deck.phase === 'unloading'}
        >
          <Eject /> Put away
        </button>
      </div>
      {realPlayback ? null : (
        <p class={fromSpotify ? 'np-note' : 'sr-only'}>
          {fromSpotify
            ? `${library?.source === 'export' ? 'The turntable keeps time without sound for uploaded libraries.' : (spotify.playbackNote ?? 'No sound in this tab.')} `
            : "Playback is simulated: the turntable runs for the album's length without audio. "}
          {fromSpotify ? (
            <a href={openInSpotifyUrl(album.uri)} target="_blank" rel="noopener noreferrer">
              Open in Spotify
            </a>
          ) : null}
        </p>
      )}
    </section>
  );
}

// --- corner controls -----------------------------------------------------------------------------------

export function Corner() {
  const sound = useStore($sound);
  return (
    <div class="corner">
      <SpotifyCorner />
      <button
        type="button"
        class="icon-button"
        aria-pressed={sound}
        aria-label={sound ? 'Sound on' : 'Sound off'}
        title={sound ? 'Sound on' : 'Sound off'}
        onClick={() => $sound.set(!sound)}
      >
        {sound ? <SpeakerOn /> : <SpeakerOff />}
      </button>
    </div>
  );
}

// --- empty state ---------------------------------------------------------------------------------------

export function EmptyActions() {
  const layout = useStore($layout);
  if (!layout || layout.matched > 0) return null;
  return (
    <div class="empty-actions">
      <p class="sr-only" role="status">
        Nothing here. Try fewer filters.
      </p>
      <button type="button" class="action primary" onClick={clearFilters}>
        Clear filters
      </button>
    </div>
  );
}

// --- dev stats -----------------------------------------------------------------------------------------

export function StatsOverlay() {
  const visible = useStore($statsVisible);
  const s = useStore($stats);
  if (!visible || !s) return null;
  const bad = (cond: boolean) => (cond ? 'bad' : '');
  return (
    <div class="stats panel" aria-hidden="true">
      <span
        class={bad(s.p95 > 16.7)}
      >{`frame   ${s.frameMs.toFixed(1)} ms  p95 ${s.p95.toFixed(1)} ms  ${s.fps.toFixed(0)} fps`}</span>
      {'\n'}
      <span class={bad(s.drawCalls > 250)}>{`draws   ${s.drawCalls}`}</span>
      {'\n'}
      <span class={bad(s.triangles > 300_000)}>{`tris    ${s.triangles.toLocaleString('en')}`}</span>
      {'\n'}
      <span class={bad(s.textureMB > 256)}>{`covers  ${s.covers}  ${s.textureMB.toFixed(1)} MB`}</span>
      {'\n'}
      {`records ${s.full} full  ${s.edges} edges`}
      {'\n'}
      {`pixel   ${s.pixelRatio.toFixed(2)}x`}
    </div>
  );
}
