/**
 * User intents the UI can issue. The active renderer (3D scene or the fallback grid) registers an
 * implementation; the UI calls these without knowing which one is running.
 */

export interface Commands {
  /** Move the focus by n records within the active crate. */
  step(delta: number): void;
  /** Jump to the first/last record of the active crate. */
  edge(which: 'start' | 'end'): void;
  switchCrate(delta: number): void;
  focusAlbum(albumId: string): void;
  /** Pull the focused record out (hold), or put the held one back. */
  toggleHold(): void;
  release(): void;
  flip(): void;
  /** Space: send the held record to the deck, or pause/resume what is playing. */
  playOrPause(): void;
  stopAndPutAway(): void;
}

const noop = () => {};
let impl: Commands = {
  step: noop,
  edge: noop,
  switchCrate: noop,
  focusAlbum: noop,
  toggleHold: noop,
  release: noop,
  flip: noop,
  playOrPause: noop,
  stopAndPutAway: noop,
};

export function registerCommands(commands: Commands): void {
  impl = commands;
}

export const commands: Commands = {
  step: (d) => impl.step(d),
  edge: (w) => impl.edge(w),
  switchCrate: (d) => impl.switchCrate(d),
  focusAlbum: (id) => impl.focusAlbum(id),
  toggleHold: () => impl.toggleHold(),
  release: () => impl.release(),
  flip: () => impl.flip(),
  playOrPause: () => impl.playOrPause(),
  stopAndPutAway: () => impl.stopAndPutAway(),
};
