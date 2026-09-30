/**
 * Re-shelving choreography for filter and sort changes (at most 900 ms, fully interruptible):
 *   0-240 ms    outgoing records sink 12 cm and fade, 8 ms stagger, whole phase capped at 240 ms
 *   150-700 ms  staying records glide to new slots on springs; crates recompose
 *   400-900 ms  incoming records rise into their slots with the same stagger
 * Everything is expressed as per-record delays and durations, consumed by springs/tweens that retarget
 * from their current state, so a new change mid-flight never restarts or snaps anything.
 */

export const RESHELVE = {
  totalMs: 900,
  outStartMs: 0,
  outEndMs: 240,
  outDurationMs: 160,
  moveStartMs: 150,
  moveEndMs: 700,
  inStartMs: 400,
  inEndMs: 900,
  inDurationMs: 300,
  staggerMs: 8,
  sinkMeters: 0.12,
} as const;

/**
 * Delays for `count` items staggered by `staggerMs`, compressed so the last one still finishes by
 * `windowMs` given each takes `durationMs`.
 */
export function staggerDelays(
  count: number,
  staggerMs: number,
  windowMs: number,
  durationMs: number,
): number[] {
  if (count <= 0) return [];
  const room = Math.max(0, windowMs - durationMs);
  const step = count > 1 ? Math.min(staggerMs, room / (count - 1)) : 0;
  return Array.from({ length: count }, (_, i) => i * step);
}

export interface ReshelvePlan {
  /** album id -> delay (ms) before it starts to sink out. */
  outgoing: Map<string, number>;
  /** album id -> delay (ms) before it starts rising in. */
  incoming: Map<string, number>;
  /** Delay before staying records start gliding. */
  moveDelayMs: number;
}

/**
 * Only records near the focus in the active crate and its neighbours animate individually; callers pass
 * those, ordered by visual priority (closest to the focus first) so the ripple starts where the eye is.
 */
export function planReshelve(outgoing: readonly string[], incoming: readonly string[]): ReshelvePlan {
  const outDelays = staggerDelays(
    outgoing.length,
    RESHELVE.staggerMs,
    RESHELVE.outEndMs - RESHELVE.outStartMs,
    RESHELVE.outDurationMs,
  );
  const inDelays = staggerDelays(
    incoming.length,
    RESHELVE.staggerMs,
    RESHELVE.inEndMs - RESHELVE.inStartMs,
    RESHELVE.inDurationMs,
  );
  return {
    outgoing: new Map(outgoing.map((id, i) => [id, RESHELVE.outStartMs + outDelays[i]!])),
    incoming: new Map(incoming.map((id, i) => [id, RESHELVE.inStartMs + inDelays[i]!])),
    moveDelayMs: RESHELVE.moveStartMs,
  };
}
