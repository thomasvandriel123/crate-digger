# Crate Digger: Spotify Record Collection Viewer (Spec)

Sep 30, 2026 · @Thomas van Driel

Crate Digger turns a Spotify saved-album library into a walk-in record room: LPs standing in wooden crates, flipped through by hand, next to a turntable in a warm, dim room. Beauty and smoothness outrank feature count at every decision point.

## Vision and goals

**Goals**

- Browsing feels physical: flipping records has weight, inertia and small imperfections, not a list animation.
- 60 fps minimum on a mid-range laptop, 120 fps on high-refresh displays, smooth on a recent phone.
- Filter and sort changes never teleport: every record glides to its new place.
- Every frame looks like a still from a film, not a dashboard.
- Self-hosted (Docker on a VPS), reading a static JSON export, so browsing has no runtime dependency on Spotify.

**Non-goals for v1**

- Not a player replacement: no queue, no playlist editing, no library management.
- No accounts or multi-user features.
- No photorealism and no physics engine: a stylised, simplified 3D look, with motion faked by springs and easing.
- No VR or AR.

**Success test:** someone sees it for 30 seconds with no explanation, understands it, and keeps flipping records.

## Scene and art direction

The scene is one lamp-lit room seen from a fixed, slightly elevated camera, as if standing at the crates, with a turntable on a sideboard behind them. The target is stylised realism: low-poly geometry, high-quality textures, baked lighting.

**Layout, front to back**

- **Foreground:** a row of 3 to 4 low wooden record bins at waist height, angled slightly toward the camera. One bin is active; the others are visible, dimmer, and clickable.
- **Midground:** a walnut sideboard carrying the turntable, two small speakers, a warm table lamp and a plant.
- **Background:** a wall with a shelf and two framed prints, a night window with soft bokeh city lights, a rug on a wooden floor.

**Camera**

- Perspective camera, 35 degree vertical FOV (telephoto compression reads as filmic), about 1.6 m above the floor, pitched down 25 degrees.
- Pointer parallax of at most 2 degrees yaw and 1 degree pitch, critically damped. A slow idle drift of about 0.3 degrees, so the frame is never dead.
- No free orbit in v1. The camera makes one dolly move (about 12% closer) when a record is pulled, and eases back on release.

**Palette**

| Element | Colour | Note |
| --- | --- | --- |
| Wall | `#3a2a22` | warm brown, slightly desaturated |
| Wood (crates, sideboard) | `#8a5a36` to `#5e3a22` | visible grain, matte |
| Lamp glow | `#ffb266` | 2700 K feel, the only strong highlight |
| Window rim light | `#6f86a8` | cool, low intensity, for separation |
| Floor and rug | `#2b1f1a`, `#7a3b2e` | rug is the one saturated warm accent |
| Shadows | `#140e0b` | never pure black |

**Lighting and atmosphere**

- Room lighting is baked into lightmaps. Only the records, crates and turntable respond to real-time light, using one warm key light and one cool rim light.
- Contact shadows under records and the tonearm are faked with soft blob textures, not shadow maps.
- Post-processing, in this order: soft bloom on the lamp, 10% vignette, film grain at 2% strength, light colour grade toward warm shadows.
- Up to 60 dust motes drifting in the lamp's light cone. Nothing else moves on its own except the turntable when playing.

**Mood references (search terms for a moodboard):** listening bar, lo-fi study room, record shop at closing time, Japanese hi-fi kissaten.

## The record (LP) object

Each album is a real-scale 12-inch LP: a cover-art sleeve that stands in the crate, and a vinyl disc that only appears when the record is pulled or played. Real proportions matter, because they are what make the scene read as "records" at a glance.

| Part | Dimensions | Material and notes |
| --- | --- | --- |
| Sleeve | 31.5 x 31.5 cm, 0.4 cm thick | Front face carries the cover art. Lightly rounded corners (alpha-masked or bevelled, 1 mm). Clearcoat 0.15, roughness 0.6. |
| Sleeve edge | 0.4 cm | Off-white card `#d9cfbd`, slightly darker toward the corners. |
| Sleeve back | 31.5 x 31.5 cm | Paper texture with a generated layout: artist, title, year and label, plus the track list when available. Serif display face for the title, monospace for metadata. |
| Disc | 30.5 cm diameter, 0.2 cm | Black vinyl, roughness 0.35, concentric-groove normal map, plus a faked anisotropic light streak (below). |
| Label | 10 cm diameter | Procedural: a flat disc in the cover's dominant colour, artist and title set small in a circle, 0.7 cm spindle hole. |

**Cover art treatment**

- Covers use Spotify's 640 px image, mipmapped, with anisotropic filtering at 8x or the device maximum.
- Until the image loads, a record shows a flat tile in its precomputed dominant colour. The real cover fades in over 250 ms, never pops.
- A seeded, per-album ring-wear overlay sits on the cover at a maximum of 8% opacity. Some records look slightly loved, none look dirty.
- A soft diagonal sheen sweeps across the cover with pointer movement and with camera drift. It is a cheap shader term, not a real reflection.

**Vinyl shading**

- The disc is a flat mesh with a normal map for grooves and a separate alpha-blended overlay with two opposing wedge-shaped highlights.
- The overlay rotates with the disc while playing and stays fixed in world space when still, so the light appears to travel across the grooves.

**Back of the sleeve**

- Shown when the pulled record is flipped over (section on crate mechanics). Track list comes from the album tracks endpoint, fetched at build time and stored in the JSON, never at runtime.
- If tracks are missing, the back shows the metadata block alone, centred, with generous margin. No empty boxes.

## Crates and flipping mechanics

Browsing works on a pull-out-and-fan model: one record at a time lifts out of the crate to show most of its cover, the records behind it fan open to show strips of theirs, and the ones already passed sink out of the way. A plain stack viewed from above shows only thin record edges, so this spreading is what makes covers legible.

**Crates**

- A crate holds up to 48 records, configurable. A 600-album library becomes about 13 crates.
- Crates stand in a row: the active crate is front and centre at full brightness, its neighbours sit left and right, turned 12 degrees inward and dimmed 35%.
- Plastic divider cards mark group boundaries (letter, decade or genre, depending on the sort). They stand 3 cm above the records and carry a printed tab label. They take part in the fan like records of zero thickness.

**Focus model.** One float `f` is the focus position, driven by a spring. For record `i`, let `s = i - f`. Every transform below is a smooth function of `s`, never of the integer index, so fast scrolling ripples through the crate instead of stepping.

| Zone | Condition | Transform (starting values, to be tuned) |
| --- | --- | --- |
| Focus | `abs(s) < 1` | Lifts 14 cm above the crate rim, leans 6 degrees toward the camera, about 75% of the cover visible. |
| Ahead | `s > 0` (behind the focus) | Depth spacing opens by up to 2.2 cm near the focus and decays with a half-width of 3 records. Lean-back grows from 10 to 18 degrees, tilting covers toward the camera. Each shows at least 3 cm of its cover. |
| Passed | `s < 0` (in front of the focus) | Sinks 12 cm into the crate and compresses to 0.6 cm spacing. Mostly hidden behind the front wall, like a flipped stack. |
| Rest | far from focus | Upright, 10 degrees lean-back, 1.2 cm spacing on a raked floor rising 1.6 cm per record. Beyond 10 records either way, draw as thin instanced edges. |

**Moving the focus**

- Wheel, trackpad or vertical drag adds velocity to `f`, with inertia. When velocity falls below 0.2 records per second, a spring (stiffness 180, damping 22) settles `f` on the nearest integer.
- Keyboard: Up/Down or W/S move by 1, Shift by 5, PageUp/PageDown by 10, Home/End jump to the ends. Left/Right switch crate.
- Touch: vertical swipe with momentum moves `f`, horizontal swipe switches crate.
- Hovering a record (desktop) lifts it a further 1.5 cm and tilts it 3 degrees. Clicking a non-focus record animates the focus to it.
- A caption plate in the lower third shows artist, title and year for the focused record, or the hovered one. It cross-fades in 180 ms and is set in the serif display face.

**The hold state.** Clicking the focused record, or pressing Enter, pulls it fully out of the crate.

- The record arcs out and up to screen centre, scaling to about 1.6x on screen, and floats with a 2 degree sway that follows the pointer. The cover sheen follows the same tilt.
- **F** or a flip button rotates it 180 degrees about its vertical axis in 600 ms, revealing the back. Flipping back is the same move reversed.
- **Space** or a Play button sends it to the turntable (next section). **Esc**, or a click outside the record, returns it to its slot along the reverse arc.
- The rest of the room dims by 25% and blurs slightly while a record is held, so the record is the subject.

**Tuning.** A dev-only `lil-gui` panel exposes spacing, riser height, lean angles, sink depth, fan half-width, spring constants, camera pitch and FOV, so the feel can be tuned live rather than by editing code.

## Turntable and now playing

The turntable is the room's second hero: a held record can be sent to it, and the ritual of loading and dropping the needle is the emotional payoff of the whole scene. In v1 this is a visual ritual with optional sound; real Spotify playback is a pluggable adapter.

**The deck.** A walnut plinth, matte black platter with a slip mat, an S-shaped tonearm with a visible headshell, a 33/45 dial and a pitch slider, and a hinged dust cover standing open. It is simplified geometry, under 5,000 triangles, with baked ambient occlusion. The label on the platter shows the playing record's artist and title.

**Play sequence**

1. The held record's disc slides out of its sleeve in 400 ms (ease-out).
2. The sleeve arcs to a small easel beside the deck, cover facing the room, in 700 ms. Its crate slot stays open as a soft empty gap, so the scene stays consistent.
3. The disc arcs to the platter and settles with a 2 mm overshoot in 600 ms.
4. The platter spins up to 33 1/3 rpm (200 degrees per second) over 1.2 s, ease-in.
5. The tonearm lifts, swings over the record edge in 700 ms, and lowers in 300 ms. With sound on, a soft thump and a brief crackle mark the needle drop.
6. While playing, the disc turns at constant speed, the light streaks travel across the grooves, and the tonearm drifts slowly inward to match track progress.

**Pause, stop and put away**

- Clicking the tonearm, or pressing Space, toggles pause: the arm lifts and the platter spins down over 2 s. Resuming reverses it.
- Stop and put away lifts the arm, spins the platter down, returns the disc to its sleeve, and returns the sleeve to its crate slot along the reverse path.
- Loading a different record while one is playing does the put-away sequence first, then the play sequence, back to back without a pause between them.
- Browsing the crates stays fully interactive while a record plays.

**Playback adapter.** The UI talks to one interface: `play(albumUri)`, `pause()`, `resume()`, `stop()`, and a `state` stream with position and duration.

- `SimulatedAdapter` is the v1 default. It runs the ritual using the album's total duration from the JSON, with no audio from Spotify.
- `SpotifyAdapter` comes later and needs a Premium account plus an OAuth flow with PKCE. It would control an existing Spotify device through the player API, or run the Web Playback SDK in the page. Preview clips are not an option, because Spotify removed them for new apps.
- Both adapters drive the same animation state, so the visuals never depend on which adapter is active.

## Filtering, sorting and search

Filters live in a slim strip of paper-tag controls at the top of the screen, so the room stays the subject, and every change re-shelves the crates with animation instead of swapping the view. The choreography matters as much as the controls.

**Filters**

| Filter | Control | Source and behaviour |
| --- | --- | --- |
| Genre | Multi-select menu, about 15 macro genres, expandable to micro-genres | Artist genres from the Spotify artists endpoint, mapped at build time to macro genres by an editable `genre-map.json`. An album matches if any of its artists matches. |
| Year | Two-handle range slider with a per-year count histogram above it, plus decade pills (60s, 70s, ...) | Release year. Pills set the range; dragging a handle updates the histogram highlight live. |
| Colour | Row of 10 swatches plus one for black and white | Cover dominant colour binned in OKLCH hue. Swatches toggle. |
| Added | Preset ranges (last month, this year, before 2020) plus custom | Saved-album `added_at` date. |
| Label | Searchable menu | Album label field. |
| Type | Toggle chips: Album, Single/EP, Compilation | Album type field. Default shows all. |
| Search | Field, focus with `/`, clear with Esc | Fuzzy match on artist, title and label, debounced 120 ms. Enter focuses the first result. |

Active filters show as accent-coloured chips with a close button. A quiet counter reads, for example, "143 of 612 records".

**Sorting.** A single sort menu, with direction toggle:

- Artist A to Z (default), title, release year (old to new, new to old), date added.
- **Colour sweep:** records ordered by cover hue, then lightness, which turns a crate into a gradient. Worth building early, because it is the most photogenic mode.
- **Dig at random:** a seeded shuffle with a re-roll button.
- Sort mode decides crate composition and divider labels: letters for artist, decades or years for year, months for date added, hue names for colour sweep.

**Re-shelving choreography.** Changing any filter or sort runs one continuous transition, at most 900 ms:

1. **0 to 240 ms:** outgoing records sink 12 cm into their crate and fade, staggered by 8 ms per record, capped at 240 ms total.
2. **150 to 700 ms:** crates recompose. Crates appear, disappear or resize with a slide and fade. Records that stay but change position glide there on springs.
3. **400 to 900 ms:** incoming records rise into their slots, staggered the same way.
4. The focus keeps its record if it still matches. If not, it moves to the nearest matching neighbour, else to the first record.

Rules that keep it smooth:

- Only records in the active crate and its two neighbours animate individually. All others update instantly and invisibly.
- Transitions are interruptible: a new change retargets all springs from their current state. Nothing restarts or snaps.
- The empty state is one empty crate with a hand-lettered card, "Nothing here. Try fewer filters", and a Clear filters button.

**State in the URL.** Filters, sort and search serialise into the URL query (for example `?genre=jazz,soul&year=1965-1979&sort=added-desc`), so views are linkable and the back button works.

## Motion and interaction design

Physical motion uses springs and choreographed moves use fixed easing curves, and nothing in the scene ever moves linearly or teleports. Springs carry anything the user drives continuously, because they stay smooth when input changes mid-flight.

**Timing reference**

| Motion | Driver | Duration or parameters |
| --- | --- | --- |
| Focus settle | spring | stiffness 180, damping 22 (about 350 ms) |
| Hover lift and tilt | spring | stiffness 300, damping 26 |
| Crate switch (camera truck) | easing | 700 ms, `cubic-bezier(0.65, 0, 0.35, 1)` |
| Pull record to hold | easing on a curved path | 550 ms, `cubic-bezier(0.22, 1, 0.36, 1)` |
| Flip to back | easing | 600 ms, `cubic-bezier(0.45, 0, 0.15, 1)`, 3 degree overshoot |
| Return to crate | easing | 500 ms, ease-in-out |
| Room dim and blur while held | easing | 300 ms |
| Caption cross-fade | easing | 180 ms |
| Cover art fade-in | easing | 250 ms |
| Re-shelve on filter or sort | springs plus stagger | at most 900 ms (see filtering section) |
| Platter spin-up and spin-down | easing | 1.2 s ease-in, 2 s ease-out |
| Tonearm swing | easing | 700 ms ease-in-out |
| UI popover open | easing | 160 ms, fade plus scale 0.98 to 1 |

**Engine rules**

- One `requestAnimationFrame` loop drives the whole scene. Springs integrate with a fixed 1/240 s sub-step, so behaviour is identical at 60, 120 and 144 Hz. Frame delta is clamped to 50 ms to survive tab switches.
- Pointer and wheel input is read once per frame, never inside event handlers that touch the scene.
- Render on demand: when nothing is moving and no ambient effect is visible, drop to a slow idle tick (for example 15 fps for dust and lamp) to save battery.
- With `prefers-reduced-motion`, fan and sink become 120 ms cross-fades, and parallax, camera drift and dust motes are off.

**States.** Desktop cursor is a grab hand over crates, a pointer over clickable records and controls. Keyboard focus on a record shows as a soft warm rim light on its edge. All HTML controls have visible focus rings, and touch targets are at least 44 px.

**Sound (off by default, one speaker toggle).** Web Audio with short OGG samples under 60 KB each, preloaded after the first user gesture:

- A soft card-flick on each focus step, pitch varied by 6% and volume scaled by scroll velocity, rate-limited to 12 per second.
- Paper slide when a record is pulled or returned, a soft thump at needle drop.
- A very quiet low-passed crackle loop while playing (about minus 30 dB).
- Every sample must be CC0 or self-recorded, with licences noted in `CREDITS.md`.

**UI chrome.** Text in translucent dark panels (`rgba(30, 20, 15, 0.6)` with a 12 px backdrop blur), paper-coloured text `#efe3cf`, accent `#ffb266`. Fonts, all open licence and self-hosted: Fraunces for display and captions, Inter for controls, JetBrains Mono for metadata.

## Data model and ingestion

The viewer never talks to Spotify at runtime: a separate Python ingest script builds one static `library.json` plus a folder of optimised covers, and the front end only reads those. This keeps browsing fast and offline-capable, and isolates all API uncertainty in one place.

**Ingest pipeline** (`ingest/`, Python, re-runnable and incremental)

1. **Auth:** OAuth Authorization Code with PKCE, scope `user-library-read`. Token cached locally, never committed.
2. **Saved albums:** page through the saved-albums endpoint, 50 per call, newest first. On re-runs, stop at the first already-known album id.
3. **Artists:** batch-fetch artists (50 per call) for genres, since album-level genres are usually empty.
4. **Enrichment (optional, only for gaps):** fill missing label or genres from MusicBrainz, rate-limited to 1 request per second and cached by album id.
5. **Covers:** download the largest image, then produce a 512 px WebP for the web and a 256 px WebP for thumbnails and mobile. A KTX2 texture-compressed variant is produced from milestone 3 (see performance).
6. **Palette:** downsample to 64 px, cluster in OKLab, and pick the dominant colour by chroma-weighted cluster size. Store three swatches plus hue, chroma, lightness and a `mono` flag for near-greyscale covers.
7. **Genres:** map raw artist genres to macro genres with `genre-map.json`. Keep the raw list too.
8. **Output:** write `library.json` atomically (temp file, then rename), plus a small `library.meta.json` with counts and generation time.

**Schema**

```json
{
  "version": 1,
  "generatedAt": "<ISO timestamp>",
  "albums": [
    {
      "id": "<spotify-album-id>",
      "uri": "spotify:album:<id>",
      "title": "Example Album",
      "artists": [{ "id": "<artist-id>", "name": "Example Artist" }],
      "year": 1973,
      "releaseDate": "1973-03-01",
      "addedAt": "2024-03-02T18:21:00Z",
      "type": "album",
      "label": "Example Records",
      "totalTracks": 9,
      "durationMs": 2520000,
      "genres": ["rock"],
      "genresRaw": ["classic rock", "album rock"],
      "cover": { "web": "covers/512/<id>.webp", "thumb": "covers/256/<id>.webp", "ktx2": null },
      "palette": { "dominant": "#a34c2b", "swatches": ["#a34c2b", "#2b1d18", "#e0c9a6"], "hue": 18, "chroma": 0.11, "lightness": 0.46, "mono": false },
      "tracks": [{ "n": 1, "title": "Example Track", "durationMs": 251000 }]
    }
  ]
}
```

**Known risks to verify first.** Spotify has changed its developer terms and API surface several times, so the ingest script must check current docs and tolerate missing fields.

- Fields such as `label`, `genres` and popularity may be absent or restricted for development-mode apps. If `label` is unavailable, the Label filter is dropped, not faked.
- Development-mode apps may need a Premium account and have a small user allow-list. Check before building the auth flow.
- Fallback input: the Spotify account data download contains a library file with saved albums, which gives album URIs but no metadata. Metadata would then come from batch album lookups, or from MusicBrainz alone.
- Review Spotify's developer terms on caching cover art and metadata. Assume personal, private, non-commercial use.

**Mock data.** Claude Code cannot authenticate to Spotify, so milestone 0 is a generator that writes a realistic `library.json` with 300 fake albums. Covers are procedural (gradients, geometric shapes, typographic art) in varied palettes, with plausible genres, years and labels. The whole viewer must run on this mock with no Spotify credentials.

**Privacy.** The deployed site holds a personal library. Serve it behind basic auth or an equivalent, send `noindex`, and keep `library.json` and covers out of any public repository.

## Technical architecture

A pure data layer feeds a persistent 3D scene through one derived layout, and the scene, not the UI framework, owns the animation loop. That split keeps the render loop free of framework re-renders, which is the most common cause of stutter in this kind of build.

&#91;embedded content: architecture · 9 components, build time and browser\]

The browser reads only static files. The scene alone owns animation, and reports the focused and held record back to the UI through the shared stores.

**Stack**

| Layer | Choice | Why |
| --- | --- | --- |
| Build and language | Vite, TypeScript (strict) | Fast dev loop, static output. |
| 3D | three.js, used directly (no React Three Fiber) | Per-frame control of springs and instancing without a reconciler in the way. |
| Post-processing | `postprocessing` (pmndrs) | Merges bloom, vignette, grain and colour grade into few passes. |
| UI overlay | Preact plus `nanostores` | Tiny footprint for filter bar, caption and controls. Shared state lives in the stores, not in components. |
| Motion | Custom spring module plus a small tween helper | About 100 lines. No animation library needed. |
| Search | `uFuzzy` or `fuse.js` | Fuzzy match over a few thousand short strings. |
| Audio | Web Audio API | Low-latency samples, no library. |
| Ingest | Python 3, `requests`, `Pillow`, `scikit-learn` or `numpy` | Matches the owner's existing tooling. |
| Tests | Vitest for pure logic, Playwright for smoke and screenshots | Spring, filter, sort and crate-packing logic is pure and fully testable. |

**Room assets.** Milestone 1 builds the room procedurally in code (boxes, cylinders, planes) with CC0 textures from a source such as Poly Haven, and the turntable from primitives. The scene module boundary is a function `buildRoom()` returning a group, so a hand-modelled glTF from Blender can replace it later without touching anything else.

**Project layout**

```text
crate-digger/
  ingest/        spotify.py, enrich.py, covers.py, palette.py, genres.py, mock.py, run.py
  data/          library.json, covers/           (gitignored)
  src/
    data/        library.ts, filters.ts, sort.ts, crates.ts, search.ts
    motion/      spring.ts, tween.ts, focus.ts, choreography.ts
    scene/       room.ts, crate.ts, record.ts, turntable.ts, camera.ts, lights.ts, post.ts
    playback/    adapter.ts, simulated.ts, spotify.ts (later)
    audio/       sounds.ts
    ui/          FilterBar, Caption, HoldControls, SoundToggle, styles
    main.ts
  docker/        Dockerfile, compose.yml, Caddyfile
  tests/
  SPEC.md
```

**Key design rules**

- `data/` holds pure functions: library in, filtered and sorted list out, then a packing step that turns the list into crates with dividers. No three.js imports anywhere in it.
- The scene subscribes to that derived layout. Records are persistent objects reused across filter changes, never destroyed and recreated.
- The scene reconciler computes each record's target slot from the layout and hands it to the motion layer, which springs toward it. This is what makes every filter change an animation for free.
- The playback adapter is the only module that knows whether audio comes from Spotify.

**Deployment.** A multi-stage Dockerfile builds the static bundle, and Caddy serves it with automatic HTTPS and basic auth. `library.json` and `covers/` live in a mounted volume, so re-running the ingest (manually, or from host cron) updates the library without rebuilding the image. Long cache lifetimes with content-hashed filenames for code, and revalidation for `library.json`.

## Performance, responsiveness and accessibility

Smoothness is a hard requirement, not a polish pass: the budgets below are acceptance criteria, and the build must measure them from milestone 1 onward. Texture memory and texture upload hitches are the biggest risk, because a library can hold 600 or more 640 px covers.

**Budgets**

| Metric | Target |
| --- | --- |
| Frame time | 16.6 ms at the 95th percentile at 1080p on an integrated GPU (M1-class or Intel Iris Xe). Use the display's refresh rate when higher. |
| Draw calls | 250 or fewer per frame |
| Triangles | 300,000 or fewer |
| GPU texture memory | 256 MB desktop, 128 MB mobile |
| Initial JavaScript | 350 KB gzipped or less, three.js included after tree-shaking |
| First interactive frame | Under 2.5 s on a fast connection, with placeholder covers |
| `library.json` | Under 1 MB gzipped for 1,000 albums. If it exceeds that, move `tracks` into per-album files fetched when a record is held. |

**Texture strategy**

- **Windowed residency:** only records within 12 of the focus in the active crate, and within 4 in neighbouring crates, are full meshes with cover textures. Everything else is one instanced mesh of thin edges tinted with each album's dominant colour.
- **LRU cache:** at most 120 cover textures on desktop and 60 on mobile, loaded at 512 px (256 px on mobile). Evicted textures are disposed explicitly.
- **No hitches:** decode with `createImageBitmap` off the main thread, and upload at most 2 textures per frame. Prefetch in the direction of scroll velocity.
- **From milestone 3:** KTX2 (Basis) compressed covers, cutting GPU memory by roughly 6x. The ingest script produces them, and the loader falls back to WebP.

**Rendering**

- Pixel ratio capped at 2 on desktop and 1.5 on mobile. **Adaptive resolution:** if the 95th percentile frame time stays above 18 ms for 1 s, step the ratio down by 0.25 to a floor of 1.0, and step back up after 5 s of stable frames.
- No real-time shadow maps. Baked room lighting, blob contact shadows.
- Antialiasing through multisampling on desktop and SMAA on mobile.
- Handle WebGL context loss by rebuilding GPU resources and restoring the current view.

**Measuring.** A dev overlay shows frame time, draw calls, triangles and texture memory. A Playwright script scrolls the crate programmatically for 30 s and fails the build if the frame-time budget is missed.

**Responsive layouts**

- **Desktop and tablet landscape:** as described, with three crates visible. The camera's horizontal FOV adapts so the crate row always fits.
- **Phone portrait:** one active crate, pitched steeper at 38 degrees, turntable in the top third. Horizontal swipe switches crate. Filters move to a bottom sheet opened from a single button.
- **Phone landscape:** desktop layout with smaller UI chrome.

**Accessibility**

- A visually hidden, real DOM listbox mirrors the filtered albums and stays synced with the 3D focus. It announces "artist, title, year, position of total" to screen readers.
- Everything is reachable by keyboard, using the shortcuts from the mechanics sections. Filter controls are native elements or correct ARIA widgets.
- UI text meets 4.5:1 contrast on its panels, and panels go opaque under `prefers-contrast: more`.
- Reduced-motion behaviour as in the motion section. Nothing flashes, and the lamp never flickers.
- Active filters are never shown by colour alone: each chip has text and a close button.

**Fallback.** Without WebGL2, the page shows a plain DOM cover grid with the same filters and sort, plus a short note. It is small to build and guarantees the library is always browsable.

## Build plan and open questions

The build runs in seven milestones, each ending in something runnable and reviewable, with the feel of browsing (M2) treated as the make-or-break one. Milestone M5 is independent of the scene work and can run in parallel with M1 to M3.

&#91;embedded content: roadmap · 7 milestones in 2 lanes\]

M6 needs both lanes: the viewer through M4, and the real data pipeline from M5.

| Milestone | Scope | Acceptance criteria |
| --- | --- | --- |
| M0. Foundation and mock data | Vite, TypeScript and three.js scaffold. Mock generator for 300 albums with procedural covers. Pure data layer (filter, sort, crate packing) with unit tests. Dev stats overlay. | `npm run dev` opens an empty scene with the overlay. Unit tests pass. Viewer runs on mock data alone. |
| M1. Room and crates | Procedural room, baked-look lighting, post-processing, 3 to 4 crates with textured records, camera parallax and drift. | The still frame matches the art direction. 60 fps with 300 albums. Draw calls and triangles within budget. |
| M2. Browsing feel | Spring engine, focus model with fan and sink, wheel, keyboard and touch input, hover, caption, hold state with flip, crate switching, dividers, tuning panel. | Fast scroll across 300 records holds the frame budget. Every transition is interruptible. Owner signs off on the feel using the tuning panel. |
| M3. Filters, sort, search | Full filter strip, sort modes including colour sweep, re-shelving choreography, URL state, empty state. KTX2 texture pipeline. | Any change completes in 900 ms or less and can be interrupted. Reloading a URL restores the exact view. Texture memory within budget. |
| M4. Turntable | Deck model, full play sequence, pause, stop and put away, simulated adapter, sound toggle and samples. | The whole ritual runs without pops or overlaps, including loading a second record mid-play. Sample licences recorded. |
| M5. Real data and deploy | Spotify ingest with PKCE, incremental runs, enrichment, palette and covers. Docker, Caddy, basic auth. | The real library renders on the VPS. A re-run adds only new albums. Missing API fields are tolerated. |
| M6. Polish and accessibility | Hidden listbox, reduced motion, phone layouts, fallback grid, adaptive resolution, sound polish, perf test in CI. | Playwright perf test passes. axe-core reports no serious issues. Lighthouse accessibility at 95 or above. |

**Open questions to confirm before building**

- [ ] **Library source:** does the collection live in saved albums or in liked songs? If mostly liked songs, the ingest should group liked tracks by album, with a threshold such as "at least 3 liked tracks, or the whole album".
- [ ] **Library size:** roughly how many albums? It sets crate count, texture strategy tuning and whether `tracks` must be split out.
- [ ] **Playback:** is v1 visual-only (simulated), or is real Spotify playback through Premium required from the start?
- [ ] **Camera:** is the fixed, slightly elevated camera with parallax acceptable, or is a free orbit wanted later?
- [ ] **Access:** should the site be reachable on the public internet behind basic auth, or only over a private network such as a VPN?
- [ ] **Genres:** is a macro taxonomy of about 15 genres, editable in `genre-map.json`, the right grain?
- [ ] **Cover art and licence terms:** confirm Spotify's current developer terms allow the personal caching this design relies on.
