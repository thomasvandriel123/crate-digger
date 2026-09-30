import { afterEach, describe, expect, it } from 'vitest';
import type { PlaybackState } from '../../src/playback/adapter';
import { SimulatedAdapter } from '../../src/playback/simulated';

describe('SimulatedAdapter', () => {
  let now = 0;
  const adapter = new SimulatedAdapter(
    (uri) => (uri === 'spotify:album:a' ? 10_000 : null),
    () => now,
    1e9,
  );
  afterEach(() => adapter.stop());

  it('plays over the album duration, pauses and resumes without losing position', async () => {
    now = 0;
    const seen: PlaybackState['status'][] = [];
    const off = adapter.subscribe((s) => seen.push(s.status));
    await adapter.play('spotify:album:a');
    now = 4000;
    expect(adapter.getState().positionMs).toBe(4000);
    await adapter.pause();
    now = 9000;
    expect(adapter.getState().positionMs).toBe(4000);
    await adapter.resume();
    now = 10_000;
    expect(adapter.getState().positionMs).toBe(5000);
    now = 20_000;
    expect(adapter.getState().status).toBe('ended');
    off();
    expect(seen).toEqual(['idle', 'playing', 'paused', 'playing', 'ended']);
  });

  it('falls back to a default length when the album has no duration', async () => {
    now = 0;
    await adapter.play('spotify:album:unknown');
    expect(adapter.getState().durationMs).toBe(40 * 60 * 1000);
  });
});
