"""library.json schema (version 1): builders and a tolerant validator shared by all sources."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

SCHEMA_VERSION = 1
ALBUM_TYPES = {"album", "single", "compilation"}
_YEAR = re.compile(r"^(\d{4})")


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def year_from_release_date(release_date: str | None) -> int | None:
    if not release_date:
        return None
    m = _YEAR.match(release_date)
    if not m:
        return None
    year = int(m.group(1))
    # Spotify uses 0000 for unknown dates on some catalogue entries.
    return year if 1000 < year < 3000 else None


def normalise_album_type(value: str | None, total_tracks: int | None = None) -> str:
    v = (value or "album").lower()
    if v == "ep":
        return "single"
    if v not in ALBUM_TYPES:
        return "album"
    return v


def cover_paths(album_id: str, ktx2: bool = False) -> dict[str, str | None]:
    return {
        "web": f"covers/512/{album_id}.webp",
        "thumb": f"covers/256/{album_id}.webp",
        "ktx2": f"covers/ktx2/{album_id}.ktx2" if ktx2 else None,
    }


def validate_album(album: dict[str, Any]) -> list[str]:
    """Returns human-readable problems. Empty list means the album is usable by the viewer."""
    problems: list[str] = []
    for key in ("id", "uri", "title", "artists", "cover", "palette"):
        if key not in album or album[key] in (None, "", []):
            problems.append(f"missing {key}")
    if album.get("type") not in ALBUM_TYPES:
        problems.append(f"bad type {album.get('type')!r}")
    palette = album.get("palette") or {}
    if not re.fullmatch(r"#[0-9a-f]{6}", str(palette.get("dominant", ""))):
        problems.append("palette.dominant is not a #rrggbb colour")
    tracks = album.get("tracks")
    if tracks is not None and not isinstance(tracks, list):
        problems.append("tracks must be a list when present")
    return problems


def validate_library(library: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if library.get("version") != SCHEMA_VERSION:
        problems.append(f"version must be {SCHEMA_VERSION}")
    ids: set[str] = set()
    for i, album in enumerate(library.get("albums", [])):
        for p in validate_album(album):
            problems.append(f"albums[{i}] ({album.get('id', '?')}): {p}")
        if album.get("id") in ids:
            problems.append(f"albums[{i}]: duplicate id {album.get('id')}")
        ids.add(album.get("id"))
    return problems
