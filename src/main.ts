/**
 * Boot: read the view from the URL, render the UI, load library.json, then start the 3D room (or the
 * fallback grid without WebGL2). Library data is never bundled; it is fetched from /data at runtime.
 */

import '@fontsource-variable/fraunces/wght.css';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/caveat/500.css';
import '@fontsource/caveat/600.css';
import './ui/styles.css';

import { h, render } from 'preact';
import { SoundBoard } from './audio/sounds';
import { LibraryError, normaliseLibrary } from './data/library';
import type { Album, Track } from './data/types';
import { SimulatedAdapter } from './playback/simulated';
import { $config, $library, $load, $reducedMotion, $renderer, $sound, $statsVisible } from './state/store';
import { readInitialView, startUrlSync } from './state/urlSync';
import { initSearchDebounce } from './ui/actions';
import { App } from './ui/App';
import { installKeyboard } from './ui/keyboard';

const params = new URLSearchParams(location.search);
const dataUrl = new URL(import.meta.env.VITE_DATA_URL ?? 'data/', document.baseURI).toString();
const mobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;

// --- per-viewer preferences (browser storage is a convenience, never required) -------------------------

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: fine */
  }
}

$sound.set(readPref('crate-digger:sound') === 'on');
$statsVisible.set(params.has('stats') || (import.meta.env.DEV && readPref('crate-digger:stats') === 'on'));

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const syncMotion = () =>
  $reducedMotion.set(
    params.get('motion') === 'reduced' || (params.get('motion') !== 'full' && motionQuery.matches),
  );
syncMotion();
motionQuery.addEventListener('change', syncMotion);

// --- tracks (inline, or split into per-album files for big libraries) ---------------------------------

const trackCache = new Map<string, Promise<Track[] | null>>();
function loadTracks(album: Album): Promise<Track[] | null> {
  if (album.tracks) return Promise.resolve(album.tracks);
  if (!album.tracksRef) return Promise.resolve(null);
  let p = trackCache.get(album.id);
  if (!p) {
    p = fetch(new URL(album.tracksRef, dataUrl))
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => (Array.isArray(json) ? (json as Track[]) : null))
      .catch(() => null);
    trackCache.set(album.id, p);
  }
  return p;
}

// --- boot ----------------------------------------------------------------------------------------------

const initialFocus = readInitialView();
initSearchDebounce();
installKeyboard();

const uiRoot = document.getElementById('ui')!;
render(h(App, { dataUrl, loadTracks }), uiRoot);

const splash = document.getElementById('splash');
const hideSplash = () => {
  splash?.classList.add('is-done');
  setTimeout(() => splash?.remove(), 700);
};

async function loadLibrary(): Promise<void> {
  try {
    // no-cache: revalidate (ETag) on every visit, so a fresh ingest shows up without a rebuild.
    const libRes = await fetch(new URL('library.json', dataUrl), { cache: 'no-cache' });
    if (!libRes.ok) throw new LibraryError(`Could not load library.json (HTTP ${libRes.status}).`);
    const library = normaliseLibrary(await libRes.json());
    if (library.albums.length === 0) throw new LibraryError('library.json has no albums yet.');
    const crateParam = Number(params.get('crate'));
    const capacity = Number.isInteger(crateParam) && crateParam > 0 ? crateParam : library.crateCapacity;
    if (capacity) $config.set({ crateCapacity: Math.min(120, Math.max(8, capacity)) });
    $library.set(library);
    $load.set({ status: 'ready' });
  } catch (err) {
    const message =
      err instanceof LibraryError ? err.message : `Could not read the library: ${(err as Error).message}`;
    $load.set({ status: 'error', message });
    hideSplash();
    throw err;
  }
}

async function start(): Promise<void> {
  const libraryReady = loadLibrary();
  const { supportsWebGL2, SceneApp } = await import('./scene/sceneApp');
  const useWebGL = params.get('renderer') !== 'fallback' && supportsWebGL2();
  const sounds = new SoundBoard(new URL('./', document.baseURI).toString());
  $sound.subscribe((on) => {
    sounds.setEnabled(on);
    writePref('crate-digger:sound', on ? 'on' : 'off');
  });
  // Audio needs a user gesture before it can start.
  const unlock = () => {
    if ($sound.get()) void sounds.unlock();
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });

  try {
    await libraryReady;
  } catch {
    return;
  }

  if (!useWebGL) {
    $renderer.set('fallback');
    startUrlSync(() => {});
    hideSplash();
    return;
  }

  const library = $library.get()!;
  const byUri = new Map(library.albums.map((a) => [a.uri, a]));
  const adapter = new SimulatedAdapter((uri) => byUri.get(uri)?.durationMs ?? null);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  let app: InstanceType<typeof SceneApp>;
  try {
    app = new SceneApp({
      canvas,
      dataUrl,
      mobile,
      capacity: $config.get().crateCapacity,
      sounds,
      adapter,
      loadTracks,
      debugNoPost: params.has('nopost'),
    });
  } catch (err) {
    console.error('3D view failed to start, falling back to the grid', err);
    $renderer.set('fallback');
    startUrlSync(() => {});
    hideSplash();
    return;
  }
  $renderer.set('webgl');
  app.focusAlbumAfterLayout(initialFocus);
  startUrlSync((focus) => app.focusAlbumAfterLayout(focus));
  app.start();
  void app.firstFrame.then(hideSplash);
  // Fonts used only inside canvases load lazily; ask for them, then redraw generated art.
  void Promise.all(
    [
      '600 40px "Caveat"',
      '500 40px "Caveat"',
      '600 40px "Fraunces Variable"',
      '400 20px "JetBrains Mono Variable"',
      '700 30px "Inter Variable"',
    ].map((f) => document.fonts?.load(f).catch(() => null)),
  ).then(() => app.refreshFonts());

  (window as unknown as { __crateDigger: unknown }).__crateDigger = {
    snapshot: () => app.debugSnapshot(),
    impulse: (v: number) => app.debugImpulse(v),
    ...(params.has('debug') ? { app } : {}),
  };

  if (import.meta.env.DEV || params.has('tune')) {
    const { installTuningPanel } = await import('./scene/devtools');
    installTuningPanel(app);
  }
}

void start();
