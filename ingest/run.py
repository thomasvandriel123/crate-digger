"""Crate Digger ingest CLI.

    python -m ingest.run mock    [--out data] [--count 300] [--seed 42]
    python -m ingest.run spotify [--out data] [--full] [--enrich] [--liked-tracks] [--no-browser] [--ktx2]
    python -m ingest.run export  --file YourLibrary.json [--out data] [--spotify] [--enrich]
    python -m ingest.run remap   [--out data]      # re-apply genre-map.json without any network calls
    python -m ingest.run validate [--out data]

Re-runnable and incremental: `spotify` stops paging at the first album already in library.json, so a
nightly cron run costs a handful of requests. `--full` rescans everything and prunes unsaved albums.
"""

from __future__ import annotations

import argparse
import os
import random
import shutil
import sys
import time
from pathlib import Path
from typing import Any

import requests

from . import mock
from .covers import ktx2_available, process_cover, write_cover_variants
from .enrich import MusicBrainz, enrich_album
from .export import read_export
from .genres import GenreMap
from .palette import extract_palette
from .schema import cover_paths, normalise_album_type, validate_library, year_from_release_date
from .spotify import (
    DEFAULT_REDIRECT,
    ArtistCache,
    PkceAuth,
    SpotifyClient,
    SpotifyError,
    TokenStore,
    best_image_url,
    fetch_album,
    fetch_all_tracks,
    iter_liked_track_albums,
    iter_saved_albums,
)
from .store import load_library, write_library

CACHE_DIR = Path(os.environ.get("CRATE_CACHE_DIR", Path(__file__).parent / ".cache"))


# --- album assembly -----------------------------------------------------------------------------------


def album_from_spotify(album: dict[str, Any], added_at: str | None, tracks: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Map a Spotify album object onto our schema. Every field access tolerates absence."""
    album_id = album["id"]
    release_date = album.get("release_date")
    track_list = None
    if tracks:
        track_list = [
            {"n": t.get("track_number") or i + 1, "title": t.get("name") or "Untitled", "durationMs": int(t.get("duration_ms") or 0)}
            for i, t in enumerate(tracks)
            if t
        ]
    out: dict[str, Any] = {
        "id": album_id,
        "uri": album.get("uri") or f"spotify:album:{album_id}",
        "title": album.get("name") or "Untitled",
        "artists": [{"id": a.get("id") or "", "name": a.get("name") or "Unknown artist"} for a in album.get("artists") or []]
        or [{"id": "", "name": "Unknown artist"}],
        "year": year_from_release_date(release_date),
        "releaseDate": release_date,
        "addedAt": added_at,
        "type": normalise_album_type(album.get("album_type")),
        "label": (album.get("label") or "").strip() or None,  # removed for dev-mode apps; kept if present
        "totalTracks": album.get("total_tracks") or (len(track_list) if track_list else None),
        "durationMs": sum(t["durationMs"] for t in track_list) if track_list else None,
        "genres": [],
        "genresRaw": sorted({g.lower() for g in album.get("genres") or []}),
        "cover": cover_paths(album_id),
        "palette": None,
    }
    if track_list:
        out["tracks"] = track_list
    out["_imageUrl"] = best_image_url(album)
    return out


def placeholder_cover(album: dict[str, Any]):
    """Typographic stand-in for albums with no artwork anywhere, so every record still has a face."""
    rng = random.Random(album["id"])
    spec = mock.CoverSpec(
        artist=album["artists"][0]["name"],
        title=album["title"],
        palette=rng.choice(mock.PALETTES),
        style="type",
        seed=rng.randint(0, 2**31),
    )
    return mock.render_cover(spec)


def finish_albums(albums: list[dict[str, Any]], data_dir: Path, session: requests.Session, *, ktx2: bool) -> None:
    """Covers + palette for new albums. Failures fall back to a placeholder cover, never abort the run."""
    for n, album in enumerate(albums, 1):
        url = album.pop("_imageUrl", None)
        palette = None
        wrote_ktx2 = False
        try:
            palette, wrote_ktx2 = process_cover(session, data_dir, album["id"], url, ktx2=ktx2)
        except (requests.RequestException, OSError) as exc:
            print(f"  cover for {album['title']!r} failed: {exc}")
        if palette is None:
            img = placeholder_cover(album)
            write_cover_variants(data_dir, album["id"], img)
            palette = extract_palette(img)
        album["palette"] = palette.to_json()
        album["cover"] = cover_paths(album["id"], ktx2=wrote_ktx2)
        if n % 25 == 0:
            print(f"  covers {n}/{len(albums)}")


def apply_genres(albums: list[dict[str, Any]], genre_map: GenreMap) -> None:
    for album in albums:
        album["genres"] = genre_map.map_many(album.get("genresRaw") or [])


def viewer_settings(args: argparse.Namespace, existing: dict[str, Any] | None) -> dict[str, Any] | None:
    """Viewer settings stored in library.json; --crate-size overrides, otherwise keep what was there."""
    viewer = dict((existing or {}).get("viewer") or {})
    if getattr(args, "crate_size", None):
        viewer["crateCapacity"] = args.crate_size
    return viewer or None


def strip_nulls(album: dict[str, Any]) -> dict[str, Any]:
    """Keep required keys even when null; drop optional ones that carry no information."""
    optional = {"tracks", "tracksRef"}
    return {k: v for k, v in album.items() if not (k in optional and not v)}


# --- commands -----------------------------------------------------------------------------------------


def cmd_mock(args: argparse.Namespace) -> int:
    out: Path = args.out
    existing = load_library(out)
    if existing and existing.get("source") != "mock" and not args.force:
        print(f"{out}/library.json holds a real library (source={existing.get('source')!r}); refusing to overwrite without --force")
        return 2
    for sub in ("covers", "tracks"):
        if (out / sub).exists():
            shutil.rmtree(out / sub)
    started = time.time()
    print(f"Generating {args.count} mock albums (seed {args.seed}) into {out}/")
    albums = mock.generate(out, count=args.count, seed=args.seed)
    genre_map = GenreMap.load(args.genre_map)
    meta = write_library(
        out, albums, source="mock", taxonomy=genre_map.taxonomy(albums), started_at=started, viewer=viewer_settings(args, None)
    )
    print(f"Wrote {meta['counts']['albums']} albums, library.json {meta['gzipBytes'] / 1024:.0f} KB gzipped")
    return 0


def _spotify_client(args: argparse.Namespace) -> tuple[SpotifyClient, requests.Session]:
    session = requests.Session()
    auth = PkceAuth(
        os.environ.get("SPOTIFY_CLIENT_ID", ""),
        TokenStore(CACHE_DIR / "token.json"),
        os.environ.get("SPOTIFY_REDIRECT_URI", DEFAULT_REDIRECT),
        open_browser=not args.no_browser,
        session=session,
    )
    return SpotifyClient(auth.access_token, session=session, on_unauthorized=auth.invalidate), session


def cmd_spotify(args: argparse.Namespace) -> int:
    started = time.time()
    out: Path = args.out
    genre_map = GenreMap.load(args.genre_map)
    existing = load_library(out) or {"albums": []}
    if existing.get("source") == "mock":
        existing = {"albums": []}  # never merge mock data into a real library
    known = {a["id"] for a in existing["albums"]}
    client, session = _spotify_client(args)

    print("Reading saved albums" + (" (full rescan)" if args.full else f" (incremental, {len(known)} known)"))
    items = list(iter_saved_albums(client, None if args.full else known))
    if args.liked_tracks:
        print(f"Reading liked songs (albums with >= {args.liked_threshold} liked tracks)")
        seen = {i["album"]["id"] for i in items} | (set() if args.full else known)
        items += [i for i in iter_liked_track_albums(client, args.liked_threshold) if i["album"]["id"] not in seen]

    current_ids = {i["album"]["id"] for i in items}
    new_items = [i for i in items if args.full or i["album"]["id"] not in known]
    existing_by_id = {a["id"]: a for a in existing["albums"]}
    print(f"{len(new_items)} albums to process")

    new_albums = []
    for item in new_items:
        album_id = item["album"]["id"]
        if album_id in existing_by_id and not args.refresh:
            new_albums.append(existing_by_id[album_id])  # full rescan: keep processed data, refresh addedAt
            existing_by_id[album_id]["addedAt"] = item.get("added_at") or existing_by_id[album_id].get("addedAt")
            continue
        album = item["album"]
        if "tracks" not in album or "images" not in album:
            album = fetch_album(client, album_id) or album
        tracks = fetch_all_tracks(client, album)
        new_albums.append(album_from_spotify(album, item.get("added_at"), tracks))

    fresh = [a for a in new_albums if "_imageUrl" in a]
    artists = ArtistCache(CACHE_DIR / "artists.json", client)
    try:
        artists.ensure([ar["id"] for a in fresh for ar in a["artists"] if ar["id"]])
    except SpotifyError as exc:
        print(f"  artist genres unavailable ({exc}); continuing without them")
    for album in fresh:
        raw = set(album["genresRaw"])
        for ar in album["artists"]:
            raw.update(g.lower() for g in artists.genres(ar["id"]))
        album["genresRaw"] = sorted(raw)

    if args.enrich:
        _enrich(fresh)
    finish_albums(fresh, out, session, ktx2=args.ktx2)

    if args.full:
        merged = new_albums
        pruned = len(existing["albums"]) - len([a for a in existing["albums"] if a["id"] in current_ids])
        if pruned:
            print(f"Pruned {pruned} albums no longer in the library")
    else:
        merged = new_albums + existing["albums"]
    apply_genres(merged, genre_map)
    meta = write_library(
        out,
        [strip_nulls(a) for a in merged],
        source="spotify",
        taxonomy=genre_map.taxonomy(merged),
        started_at=started,
        viewer=viewer_settings(args, existing),
    )
    _report(meta, client.requests_made)
    return 0


def _enrich(albums: list[dict[str, Any]]) -> None:
    gaps = [a for a in albums if not a.get("label") or not a.get("genresRaw")]
    if not gaps:
        return
    print(f"Enriching {len(gaps)} albums from MusicBrainz (1 request/second, cached)")
    mb = MusicBrainz(CACHE_DIR / "musicbrainz.json")
    try:
        for n, album in enumerate(gaps, 1):
            enrich_album(mb, album)
            if n % 20 == 0:
                mb.save()
                print(f"  {n}/{len(gaps)}")
    finally:
        mb.save()


def cmd_export(args: argparse.Namespace) -> int:
    started = time.time()
    out: Path = args.out
    genre_map = GenreMap.load(args.genre_map)
    entries = read_export(args.file)
    existing = load_library(out) or {"albums": []}
    if existing.get("source") == "mock":
        existing = {"albums": []}
    known = {a["id"] for a in existing["albums"]}
    todo = [e for e in entries if e["id"] not in known]
    print(f"{len(entries)} albums in export, {len(todo)} new")
    session = requests.Session()
    albums: list[dict[str, Any]] = []
    if args.spotify:
        client, session = _spotify_client(args)
        for e in todo:
            album = fetch_album(client, e["id"])
            if album:
                albums.append(album_from_spotify(album, None, fetch_all_tracks(client, album)))
    else:
        mb = MusicBrainz(CACHE_DIR / "musicbrainz.json")
        for n, e in enumerate(todo, 1):
            info = mb.lookup(e["id"], e["artist"], e["title"])
            albums.append(
                {
                    "id": e["id"],
                    "uri": e["uri"],
                    "title": e["title"] or "Untitled",
                    "artists": [{"id": "", "name": e["artist"] or "Unknown artist"}],
                    "year": info.get("year"),
                    "releaseDate": str(info["year"]) if info.get("year") else None,
                    "addedAt": None,
                    "type": "album",
                    "label": info.get("label"),
                    "totalTracks": None,
                    "durationMs": None,
                    "genres": [],
                    "genresRaw": sorted({g.lower() for g in info.get("genres") or []}),
                    "cover": cover_paths(e["id"]),
                    "palette": None,
                    "_imageUrl": MusicBrainz.cover_url(info["mbid"]) if info.get("mbid") else None,
                }
            )
            if n % 20 == 0:
                mb.save()
                print(f"  {n}/{len(todo)}")
        mb.save()
    if args.enrich:
        _enrich(albums)
    finish_albums(albums, out, session, ktx2=args.ktx2)
    merged = albums + existing["albums"]
    apply_genres(merged, genre_map)
    meta = write_library(
        out,
        [strip_nulls(a) for a in merged],
        source="export",
        taxonomy=genre_map.taxonomy(merged),
        started_at=started,
        viewer=viewer_settings(args, existing),
    )
    _report(meta, None)
    return 0


def cmd_remap(args: argparse.Namespace) -> int:
    library = load_library(args.out)
    if not library:
        print(f"No library.json in {args.out}")
        return 1
    genre_map = GenreMap.load(args.genre_map)
    albums = library["albums"]
    apply_genres(albums, genre_map)
    meta = write_library(
        args.out,
        albums,
        source=library.get("source", "unknown"),
        taxonomy=genre_map.taxonomy(albums),
        viewer=viewer_settings(args, library),
    )
    _report(meta, 0)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    library = load_library(args.out)
    if not library:
        print(f"No library.json in {args.out}")
        return 1
    problems = validate_library(library)
    missing = [a["id"] for a in library["albums"] if not (args.out / a["cover"]["web"]).exists()]
    for p in problems[:50]:
        print("  " + p)
    if missing:
        print(f"  {len(missing)} albums have no cover file (the viewer shows their colour tile)")
    print("OK" if not problems else f"{len(problems)} problems")
    return 0 if not problems else 1


def _report(meta: dict[str, Any], requests_made: int | None) -> None:
    c = meta["counts"]
    print(
        f"Wrote {c['albums']} albums ({c['artists']} artists; {c['withLabel']} with label, {c['withTracks']} with tracks, "
        f"{c['withGenres']} with genres). library.json {meta['gzipBytes'] / 1024:.0f} KB gzipped, tracks {meta['tracksLayout']}."
    )
    if c["withLabel"] == 0:
        print("  note: no labels available, so the viewer hides the Label filter (try --enrich)")
    if requests_made is not None:
        print(f"  {requests_made} Spotify API requests")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ingest.run", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--out", type=Path, default=Path("data"), help="data directory served at /data (default: data)")
    common.add_argument("--genre-map", type=Path, default=Path(__file__).with_name("genre-map.json"))
    common.add_argument(
        "--crate-size", type=int, choices=range(8, 121), metavar="8-120", help="records per crate in the viewer (default 48)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("mock", parents=[common], help="generate a mock library with procedural covers")
    p.add_argument("--count", type=int, default=300)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--force", action="store_true", help="overwrite a non-mock library")
    p.set_defaults(func=cmd_mock)

    for name, func in (("spotify", cmd_spotify), ("export", cmd_export)):
        p = sub.add_parser(name, parents=[common])
        p.add_argument("--enrich", action="store_true", help="fill missing label/genres from MusicBrainz")
        p.add_argument("--ktx2", action="store_true", help=f"also write KTX2 covers (toktx {'found' if ktx2_available() else 'not found'})")
        p.add_argument("--no-browser", action="store_true", help="headless login: paste the redirect URL instead")
        p.set_defaults(func=func)
        if name == "spotify":
            p.add_argument("--full", action="store_true", help="rescan everything and prune albums no longer saved")
            p.add_argument("--refresh", action="store_true", help="with --full, re-fetch metadata for known albums too")
            p.add_argument("--liked-tracks", action="store_true", help="also derive albums from Liked Songs")
            p.add_argument("--liked-threshold", type=int, default=3)
        else:
            p.add_argument("--file", type=Path, required=True, help="YourLibrary.json from Spotify's data download")
            p.add_argument("--spotify", action="store_true", help="look albums up on Spotify (needs login)")

    sub.add_parser("remap", parents=[common], help="re-apply genre-map.json to library.json").set_defaults(func=cmd_remap)
    sub.add_parser("validate", parents=[common], help="check library.json against the schema").set_defaults(func=cmd_validate)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SpotifyError as exc:
        print(f"Spotify error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted; nothing was written (library.json is only replaced atomically at the end).", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
