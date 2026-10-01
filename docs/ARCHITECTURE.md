# Architecture

A pure data layer feeds a persistent 3D scene through one derived layout. The scene, not the UI framework,
owns the animation loop, so the render loop never waits on a component re-render.

```text
 build time (Python, ingest/)                     browser (TypeScript, src/)
 ────────────────────────────                     ──────────────────────────────────────────────────────
 Spotify Web API ─┐                               data/library.json ─► data/library.ts (normalise, tolerant)
 MusicBrainz ─────┼─► ingest.run ─► library.json            │
 Data export ─────┘      │          covers/512, 256         ▼
                         │          (+ ktx2, tracks/)    stores (nanostores): $library, $filters, $sort, $search
 mock.py (no account) ───┘                                  │
                                                            ▼
                                            data/layout.ts deriveLayout(): filter ► sort ► pack crates
                                                            │                 (+ dividers, slots)
                         ┌──────────────────────────────────┼───────────────────────────────┐
                         ▼                                  ▼                               ▼
               ui/ (Preact): filter strip,       scene/ (three.js): one rAF loop     state/urlSync.ts
               caption, hold controls,           records reconcile to the layout    URL <-> view state
               now playing, a11y listbox         and report focus/hold/deck back
                                                  through the stores
```

## Layers and rules

| Layer     | Folder          | Rule                                                                                                                |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Pure data | `src/data/`     | No three.js, no DOM. Library in, filtered/sorted/packed layout out. Unit-tested. ESLint forbids scene imports here. |
| Motion    | `src/motion/`   | Springs (fixed 1/240 s step), bezier easing, tweens, the focus controller, re-shelve timing. Unit-tested.           |
| State     | `src/state/`    | Stores shared by scene and UI; command registry (UI intents); URL sync.                                             |
| Scene     | `src/scene/`    | Owns rendering and animation. Subscribes to the layout; writes focus/hold/deck back to stores.                      |
| UI        | `src/ui/`       | Preact components read stores and call commands. They never touch the scene graph.                                  |
| Spotify   | `src/spotify/`  | PKCE login, Web API client, saved albums -> library records, palettes and genres in the browser. No DOM rendering.  |
| Playback  | `src/playback/` | `PlaybackAdapter` interface; `SpotifyAdapter` (Web Playback SDK) when connected, else `SimulatedAdapter`.           |
| Audio     | `src/audio/`    | Web Audio, samples synthesised in code, off by default.                                                             |

## Data flow

1. `main.ts` finishes a Spotify login if the page is the OAuth callback, reads the view from the URL, renders
   the UI, and loads the library (the connected account's saved albums via `src/spotify/session.ts`, else
   `data/library.json`) while lazily importing the scene chunk (three.js) in parallel.
2. `normaliseLibrary` turns the JSON into `Album`s with filing keys (`The Beatles` files under B), colour bins
   (ten OKLCH hue sectors plus black and white), epoch dates, and capability flags (e.g. no labels → no Label
   filter).
3. `$layout` is a computed store: `applyFilters` → `sortAlbums` → `packCrates` (48 per crate by default, a
   divider at each group boundary and at the front of each crate). Its `signature` keeps identity stable when a
   change does not alter the arrangement.
4. The scene's `applyLayout` resolves where focus goes (same record, else the nearest match in the old order,
   else the first), then reconciles bins and records.

## The scene

`SceneApp` (`src/scene/sceneApp.ts`) is the composition root and owns the single `requestAnimationFrame` loop:

```text
frame(now)
  skip unless something moves, input is pending, or 1/15 s has passed (idle tick for dust, grain, drift)
  dt = min(now - last, 50 ms)
  input.consume()                    pointer/wheel/drag read once per frame; handlers only accumulate
  fixed step at 1/240 s:             focus springs, FLIP springs, hover springs, camera parallax, hold sway
  tweens by dt:                      crate row, presence/cover fades, hold arc/flip/dim, deck ritual, camera
  records.place()                    fan pose per record, residency (full mesh vs instanced edge), textures
  dividers.update(); covers.endFrame()  <= 2 GPU uploads per frame
  post.setHold(); composer.render()
  stats (frame times, adaptive pixel ratio)
```

### Records

- **Persistent entities.** Every album gets one `RecordEntity` for the page's lifetime. Filters never destroy
  or recreate them; they only change slots.
- **The fan** (`fan.ts`) is a pure function of `s = i - f`: lift and forward lean at the focus, sink and
  compression in front of it, opening spacing, lean-back and a raked floor behind it. Continuity in `f` is
  unit-tested, so scrolling ripples instead of stepping.
- **Residency.** In the active crate, records within 10 of the focus are full meshes (one draw each, shared
  program); in neighbour crates within 4. Everything else in visible crates is a single instanced draw of thin
  sleeves tinted with each album's dominant colour. Near the boundary the full mesh already fades its cover
  toward that tint, so the switch is invisible.
- **Covers** (`textureCache.ts`): LRU of 120 (60 on mobile) textures at 512 px (256 px on mobile),
  `createImageBitmap` decode off the main thread, at most two uploads per frame, prefetch biased by scroll
  velocity, explicit disposal on eviction. Covers fade in over 250 ms from the dominant-colour tile.
- **Re-shelving** is FLIP on springs: on a layout change, a record's last drawn transform becomes an offset
  that a spring decays to zero after the 150 ms move delay. Records leaving the view sink 12 cm and fade on the
  0–240 ms stagger; records arriving rise on the 400–900 ms stagger. Only the active crate and its neighbours
  animate this way; everything else updates instantly. A new change mid-flight captures the current transform
  as the next offset, so nothing restarts or snaps.

### Hold and deck

```text
hold:  idle ─Enter/click─► pulling (550 ms arc) ─► held ─Esc/click outside─► returning (500 ms) ─► idle
                                                  │  F: flip 600 ms (+3° overshoot)
                                                  └─ Space: hand-off to the deck
deck:  empty ─► loading (slide out 400, sleeve to easel 700, disc to platter 600, spin-up 1.2 s, needle 1 s)
         ─► playing ◄─► paused (arm lift, 2 s spin-down) ─► ended (auto-return) ─► unloading ─► empty
```

The deck serialises commands on a promise queue, so a second record queued while one plays runs the full
put-away first, then the play sequence. Poses are overrides on the record entity: the record system still
draws the sleeve (one code path for textures, dimming and picking) while the controller decides where it is.

### Look

- Room: procedural geometry and textures; lighting baked at startup into half-float lightmaps
  (`bake.ts`: shaded lamp, cool window, analytic contact occlusion).
- Real-time lit (records, crates, deck): one shared GLSL lighting model: warm key, cool rim, warm ambient.
- Post (`post.ts`): depth-masked hold dim + Kawase blur, bloom (only the lamp is HDR), vignette, grain, AgX
  tone mapping, warm grade that never lets shadows go pure black; MSAA on desktop, SMAA on mobile; a 120 ms
  cross-fade pass for reduced motion.

## Accessibility model

The canvas is `aria-hidden`. A real DOM listbox (`ui/A11yList.tsx`) mirrors the filtered order with
`aria-activedescendant` tracking the 3D focus and a polite live region announcing "artist, title, year,
position of total". Every control is a native element or an ARIA pattern (dialog popovers, radio groups,
pressed toggles); chips always carry text. Without WebGL2, `FallbackGrid` renders the same layout as a grid.

## Testing

| Level         | Tool       | Covers                                                                                                                                                                                                                   |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit          | Vitest     | filters, sort, packing, search, URL, focus resolution, fan continuity, springs (frame-rate independence), easing, focus controller, choreography budget, playback adapter, colour bins, adaptive resolution              |
| Ingest        | pytest     | palette, genre map, atomic writes and track splitting, Spotify paging/incremental stop/429/fallbacks, mock determinism                                                                                                   |
| End-to-end    | Playwright | keyboard, pointer, hold/flip, the full play ritual incl. a second record, filters + URL + reload, sort + back button, search + empty state, portrait sheet, reduced motion, fallback grid, context loss, missing library |
| Accessibility | axe-core   | no serious/critical violations in the room, popovers and hold state                                                                                                                                                      |
| Performance   | Playwright | 30 s programmatic scroll; draw calls, triangles and texture memory asserted; p95 frame time enforced with `PERF_STRICT=1` on real GPUs                                                                                   |
| Budget        | script     | initial JS gzipped (`npm run size`)                                                                                                                                                                                      |
