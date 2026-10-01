import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../../src/data/types';
import type { PlaybackState } from '../../src/playback/adapter';
import { albumPosition, type SdkPlayer, type SdkState, SpotifyAdapter } from '../../src/playback/spotify';

const ALBUM = 'spotify:album:a';
const TRACKS: Track[] = [
  { n: 1, title: 'One', durationMs: 100_000, uri: 'spotify:track:1' },
  { n: 2, title: 'Two', durationMs: 50_000, uri: 'spotify:track:2' },
];

function sdkState(track: number, position: number, paused = false, context = ALBUM): SdkState {
  return {
    paused,
    position,
    duration: TRACKS[track - 1]!.durationMs,
    context: { uri: context },
    track_window: { current_track: { uri: `spotify:track:${track}` }, next_tracks: track < 2 ? [{}] : [] },
  };
}

function fakePlayer(event: 'ready' | 'account_error' = 'ready') {
  const listeners = new Map<string, (p: unknown) => void>();
  const player: SdkPlayer & { emit(e: string, p: unknown): void } = {
    connect: vi.fn(async () => {
      queueMicrotask(() =>
        event === 'ready'
          ? listeners.get('ready')?.({ device_id: 'dev1' })
          : listeners.get('account_error')?.({ message: 'Premium required' }),
      );
      return true;
    }),
    disconnect: vi.fn(),
    addListener: (e: string, cb: (p: never) => void) => {
      listeners.set(e, cb as (p: unknown) => void);
      return true;
    },
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    activateElement: vi.fn(async () => {}),
    emit: (e, p) => listeners.get(e)?.(p),
  };
  return player;
}

function setup(event: 'ready' | 'account_error' = 'ready', playAlbum = vi.fn(async () => {})) {
  let now = 0;
  const player = fakePlayer(event);
  const notes: (string | null)[] = [];
  const adapter = new SpotifyAdapter({
    api: { playAlbum },
    token: async () => 'AT',
    tracksOf: async () => TRACKS,
    durationOf: () => 150_000,
    createPlayer: async () => player,
    onNote: (n) => notes.push(n),
    now: () => now,
  });
  const seen: PlaybackState['status'][] = [];
  adapter.subscribe((s) => {
    if (seen[seen.length - 1] !== s.status) seen.push(s.status);
  });
  return { adapter, player, playAlbum, notes, seen, tick: (ms: number) => (now += ms) };
}

describe('albumPosition', () => {
  it('adds the tracks before the current one', () => {
    expect(albumPosition(TRACKS, sdkState(2, 10_000))).toEqual({ positionMs: 110_000, index: 1 });
    expect(albumPosition(TRACKS, sdkState(1, 0, false, ALBUM))).toEqual({ positionMs: 0, index: 0 });
    const relinked: SdkState = {
      ...sdkState(1, 5),
      track_window: { current_track: { uri: 'x', linked_from: { uri: 'spotify:track:2' } } },
    };
    expect(albumPosition(TRACKS, relinked)!.index).toBe(1);
    expect(
      albumPosition(TRACKS, { ...sdkState(1, 0), track_window: { current_track: { uri: 'other' } } }),
    ).toBeNull();
  });
});

describe('SpotifyAdapter', () => {
  it('plays the album on this tab and reports album-level progress', async () => {
    const { adapter, player, playAlbum, seen, tick, notes } = setup();
    expect(await adapter.whenReady()).toBe('dev1');
    expect(notes).toEqual([null]);
    await adapter.play(ALBUM);
    expect(playAlbum).toHaveBeenCalledWith('dev1', ALBUM);
    expect(adapter.getState()).toMatchObject({ status: 'playing', durationMs: 150_000 });

    // A stale event from what played before must not end the new record.
    adapter.onSdkState(sdkState(1, 90_000, true, 'spotify:album:previous'));
    expect(adapter.getState().status).toBe('playing');

    adapter.onSdkState(sdkState(2, 10_000));
    expect(adapter.getState().positionMs).toBe(110_000);
    tick(5000);
    expect(adapter.getState().positionMs).toBe(115_000);

    await adapter.pause();
    expect(player.pause).toHaveBeenCalled();
    tick(5000);
    expect(adapter.getState()).toMatchObject({ status: 'paused', positionMs: 115_000 });
    await adapter.resume();
    expect(player.resume).toHaveBeenCalled();

    // End of the album: the SDK pauses back at position 0.
    adapter.onSdkState(sdkState(2, 49_500));
    adapter.onSdkState(sdkState(1, 0, true));
    expect(adapter.getState()).toMatchObject({ status: 'ended', positionMs: 150_000 });
    expect(seen).toEqual(['idle', 'playing', 'paused', 'playing', 'ended']);
  });

  it('follows pauses made in another Spotify app and playback moving away', async () => {
    const { adapter } = setup();
    await adapter.whenReady();
    await adapter.play(ALBUM);
    adapter.onSdkState(sdkState(1, 20_000));
    adapter.onSdkState(sdkState(1, 25_000, true));
    expect(adapter.getState()).toMatchObject({ status: 'paused', positionMs: 25_000 });
    adapter.onSdkState(sdkState(1, 25_000, false));
    expect(adapter.getState().status).toBe('playing');
    adapter.onSdkState(null);
    expect(adapter.getState().status).toBe('paused');
    adapter.onSdkState(sdkState(1, 0, false, 'spotify:playlist:x'));
    expect(adapter.getState().status).toBe('ended');
  });

  it('falls back to the simulated clock without Premium, and says why', async () => {
    const { adapter, playAlbum, notes } = setup('account_error');
    expect(await adapter.whenReady()).toBeNull();
    expect(notes[0]).toMatch(/Premium/);
    await adapter.play(ALBUM);
    expect(playAlbum).not.toHaveBeenCalled();
    expect(adapter.getState()).toMatchObject({ status: 'playing', durationMs: 150_000 });
    adapter.dispose();
  });

  it('falls back when Spotify refuses to start playback', async () => {
    const refuse = vi.fn(async () => {
      throw Object.assign(new Error('Premium required'), { status: 403 });
    });
    const { adapter, notes } = setup('ready', refuse);
    await adapter.whenReady();
    await adapter.play(ALBUM);
    expect(adapter.mode).toBe('fallback');
    expect(notes[notes.length - 1]).toMatch(/Premium/);
    expect(adapter.getState().status).toBe('playing');
    adapter.dispose();
  });

  it('activates the player element once, from a gesture', async () => {
    const { adapter, player } = setup();
    await adapter.whenReady();
    adapter.activate();
    adapter.activate();
    expect(player.activateElement).toHaveBeenCalledTimes(1);
  });
});
