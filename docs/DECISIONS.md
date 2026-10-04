# Decisions and deviations

Where the spec left room for interpretation, or where building it revealed a better option, the choice is
recorded here with its reason. Spec values marked "starting values, to be tuned" live in
`src/scene/tuning.ts` and are editable live in the dev tuning panel.

## Answers to the spec's open questions (defaults chosen for v1)

| Question                                     | v1 default                                                                        | How to change                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Library source: saved albums or liked songs? | Saved albums.                                                                     | `ingest.run spotify --liked-tracks` also derives albums from Liked Songs (at least 3 liked tracks, or the whole album; `--liked-threshold`). |
| Library size                                 | Tuned and tested on 300 mock albums; budgets hold for ~1,000.                     | `library.json` automatically splits `tracks` into per-album files past 1 MB gzipped.                                                         |
| Playback                                     | Real audio via the Web Playback SDK when connected; `SimulatedAdapter` otherwise. | `src/playback/spotify.ts`; both implement `PlaybackAdapter`, the scene does not change.                                                      |
| Camera                                       | Fixed, elevated, with parallax and drift. No orbit.                               | `src/scene/camera.ts`.                                                                                                                       |
| Access                                       | Public internet behind basic auth, `noindex` everywhere.                          | Set `SITE_ADDRESS=:80` and serve over a VPN (e.g. Tailscale) instead.                                                                        |
| Genres                                       | 16 macro genres in `ingest/genre-map.json`, expandable to the raw micro genres.   | Edit the map, then `python -m ingest.run remap` (no API calls).                                                                              |
| Cover caching terms                          | Assumed personal, private, non-commercial use; data never committed.              | Re-check Spotify's developer terms before sharing the site with anyone.                                                                      |

## Spotify API, as of September 2026

Spotify's February 2026 development-mode changes (applied to existing apps on 9 March 2026) shape the ingest:

- **`label` is gone from album objects** in development mode. The Label filter therefore only appears when
  MusicBrainz enrichment (`--enrich`) found labels; it is hidden, not faked, otherwise.
- **Batch endpoints were removed** (`GET /artists?ids=`, `GET /albums?ids=`). Artist genres come from one
  `GET /artists/{id}` per artist, paced and cached on disk for 90 days, so only the first run is slow.
- Development-mode apps need the owner to have Premium and allow at most 5 users.
- Redirect URIs must use a loopback IP (`http://127.0.0.1:8888/callback`), not `localhost`.
- Every field access in the ingest tolerates absence; a missing field degrades a feature, never the run.

## Connect Spotify (live library)

1. **Browser-only PKCE, no backend.** The site stays static files; there is no client secret to protect. The
   token lives in `localStorage` (refreshed automatically, single-flight). That is acceptable for a private
   site behind basic auth with a CSP that only allows this origin's and Spotify's SDK scripts; a backend
   holding the refresh token in an httpOnly cookie would be the step up for a shared site.
2. **Exactly one collection on the shelves.** Connected: the account's saved albums and nothing else (the
   library on disk is not merged in). Not connected: `library.json`. Neither: a welcome panel. Logging in
   clears any library cached from a previous account.
3. **Same schema, same viewer.** Saved albums are mapped to `library.json` records (`src/spotify/mapping.ts`)
   and go through the same `normaliseLibrary`, so filters, sort, crates and the scene need no Spotify code.
   Cover palettes are computed in the browser with the ingest's method (OKLab k-means, chroma-weighted) from
   Spotify's 64 px image; genres use the ingest's `genre-map.json` through a TypeScript port of the mapper.
4. **Cache first, then check.** The built library is cached in `localStorage`. A visit shows it at once and
   asks Spotify for the newest saved album and the total (one request); only if either changed does it rebuild
   in the background, reusing known palettes. A rebuilt library is applied only when nothing is in hand or on
   the deck, so a record never vanishes mid-play. If the cache exceeds the storage quota, track lists are
   dropped and fetched per album when needed.
5. **Playback in the tab.** The SDK makes the tab a Connect device; `PUT /me/player/play` with the album's
   `context_uri` starts it. Progress is album-level (durations of earlier tracks + position in the current
   one, matched by track URI, including relinked tracks), so the tonearm crosses the whole side. The end of
   the album is detected as the SDK's pause at position 0 after the last track. Pauses from other devices
   lift the arm in the room; another context starting elsewhere ends the record. Audio is unlocked with
   `activateElement()` on the first gesture, which also satisfies autoplay policies.
6. **Degrade, don't fail.** No Premium (`account_error`, or a 403 on play), no EME/Widevine
   (`initialization_error`) or a blocked SDK all fall back to the simulated clock with a note in Now
   Playing and an **Open in Spotify** link. Genres failing never blocks the room.
7. **Loopback host.** Spotify rejects `localhost` redirect URIs, so dev and preview servers listen on
   `127.0.0.1`, and Connect on a `localhost` page explains where to go instead of failing at Spotify.

## Public site: bring your own records

Spotify development-mode apps serve at most five allowlisted accounts, and since May 2025 extended access is
only granted to registered businesses with 250k+ monthly active users. So "anyone connects their Spotify" is
not available to a site like this one. The public site therefore offers:

1. **Upload of Spotify's data export for everyone.** `YourLibrary.json` (inside the "Account data" zip) lists
   saved albums as artist/title/URI with nothing else. It is parsed in the browser (`src/export/`, zip via
   `fflate`, loaded on demand), stored in local storage, and never sent to the server. Without saved albums,
   albums with 3+ liked songs make the collection, as in the Python ingest.
2. **Enrichment from the browser, not the server.** MusicBrainz allows ~1 request/s per IP. Running the
   lookups in each visitor's browser gives every visitor their own budget, needs no server, queue or API key,
   and keeps the library private. One search request per album (release group, first release date, type,
   tags); covers are Cover Art Archive URLs, sampled once for the palette (which also tells whether a cover
   exists). Track lists and labels are looked up only for the record in hand, ahead of the queue. Results are
   cached per album; misses are retried after 30 days. Browsers cannot set a `User-Agent`, so requests
   identify as the browser; the pacing (1.1 s, longer back-off on 503) keeps them polite.
3. **The room is usable at once.** Unmatched albums get a generated "private press" sleeve (title and artist
   on a muted board colour); records refile as years and genres arrive, never while one is in hand or on the
   deck. Covers that fail to load anywhere now fall back to the same sleeve.
4. **Connect Spotify stays, invite-only.** A non-allowlisted account gets a 403 from the API after logging
   in; the site signs it out, says why, and opens the upload instead.
5. **Uploaded libraries play silently** (the simulated clock) with "Open in Spotify": playback needs a
   Spotify login.
6. **`ACCESS=public|private`** switches Caddy between an open, indexable site and the basic-auth one. The
   `noindex` meta tag moved out of `index.html` into the private-mode headers.

Not verified from the build environment (its network blocks these hosts): live CORS behaviour of the Cover
Art Archive's redirect to archive.org. If covers do not load in production, records keep plain sleeves; the
fix would be a small caching image proxy on the server.

## Scene and motion

1. **The crate row slides; the room stays put.** The spec calls the crate switch a "camera truck", but a
   600-album library fills about 13 crates: truly trucking the camera past them would carry the turntable out of
   frame after two switches. The bins slide along the row on the specified 700 ms curve instead, and the camera
   adds a small truck in the direction of travel that eases back, so it still reads as a camera move.
2. **Fan interpretation.** "Lifts 14 cm above the crate rim" is implemented as a 14 cm lift of the focus record;
   the raked floor (1.6 cm per record behind the focus) saturates after about six records so a 48-record crate
   does not climb 77 cm. Neighbour crates show the same fan at 35% strength, so the active crate is unmistakable.
3. **Every crate starts with a divider** (plus one at every group boundary), so a crate you switch to always
   shows where you are in the alphabet, decade or colour sweep.
4. **Re-shelving is FLIP on springs.** A record's previous on-screen transform becomes an offset that a spring
   decays to zero. This makes every filter/sort change interruptible by construction: a new change simply
   captures the current transform as the next offset.
5. **Fades use an ordered dither** in the opaque pass rather than alpha blending, which avoids sorting artefacts
   between hundreds of overlapping sleeves. Film grain hides the pattern.
6. **Room dim and blur while holding** are one post effect masked by depth: everything behind the held record
   dims 25% and takes a half-resolution Kawase blur. The record itself stays sharp without a second render pass.
7. **Reduced motion is a real cross-fade.** With `prefers-reduced-motion`, focus moves, crate switches and
   re-shelves jump instantly while the last frame fades out over 120 ms. Parallax, drift and dust are off.
8. **Clicking the held record flips it**; clicking anywhere else puts it back. Tonearm clicks toggle pause.
9. **End of an album:** the arm auto-returns and the platter spins down, like an automatic deck. The record stays
   on the platter ("run-out groove") until you play it again or put it away.
10. **Key direction:** Down/S and wheel-down or swipe-up move deeper into the crate (the next record), the list
    convention that screen-reader users also expect from the mirrored listbox.

## Assets

11. **No downloaded textures.** The spec suggests CC0 textures (e.g. Poly Haven); v1 draws every surface
    procedurally instead, so the repo carries no binary assets and no attribution obligations. `buildRoom()` is
    the seam where a Blender glTF with real baked lightmaps can replace it.
12. **Lightmaps are baked at startup** on the CPU into small half-float textures (one warm lamp with a shade,
    a cool window, soft analytic occlusion). It takes a few tens of milliseconds and stays tunable.
13. **Sounds are synthesised**, not recorded: zero bytes to download and nothing to license. Dropping CC0 or
    self-recorded OGGs into `public/sounds/` overrides them.

## Engineering

14. **three.js loads lazily** after the UI and the library fetch have started, so the filter strip is interactive
    while the scene compiles. The bundle budget counts the scene chunk as initial JavaScript anyway.
15. **The URL also carries the focused record** (`r=`), so reloading a link restores the exact view.
16. **Frame-time budgets are enforced on real hardware only.** CI runners render through SwiftShader, so the
    Playwright perf test records numbers there and fails only with `PERF_STRICT=1`. Draw-call, triangle and
    texture-memory budgets are asserted everywhere.
17. **KTX2 covers are optional.** The ingest writes them when `toktx` (KTX-Software) is installed; the viewer
    currently always uses WebP, which the 120-texture LRU keeps within the 256 MB budget
    (120 x 512² x 4 bytes x 4/3 ≈ 168 MB). Wiring `KTX2Loader` is the next step for mobile memory headroom.
