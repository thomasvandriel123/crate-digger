"""Reading and atomically writing library.json and library.meta.json."""

from __future__ import annotations

import gzip
import json
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .schema import SCHEMA_VERSION, utc_now_iso, validate_library

GZIP_BUDGET_BYTES = 1_000_000  # spec: library.json under 1 MB gzipped, else split tracks out


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write to a temp file in the same directory, fsync, then rename over the target.

    Readers (Caddy, the viewer) either see the old file or the new one, never a partial write.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def atomic_write_json(path: Path, data: Any, *, compact: bool = False) -> bytes:
    if compact:
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    else:
        raw = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    atomic_write_bytes(path, raw)
    return raw


def load_library(data_dir: Path) -> dict[str, Any] | None:
    path = data_dir / "library.json"
    if not path.exists():
        return None
    library = json.loads(path.read_text(encoding="utf-8"))
    # Re-inline split tracks so merging works on one representation.
    for album in library.get("albums", []):
        ref = album.pop("tracksRef", None)
        if ref and "tracks" not in album:
            tp = data_dir / ref
            if tp.exists():
                album["tracks"] = json.loads(tp.read_text(encoding="utf-8"))
    return library


def _gzip_size(raw: bytes) -> int:
    return len(gzip.compress(raw, compresslevel=6))


def write_library(
    data_dir: Path,
    albums: list[dict[str, Any]],
    *,
    source: str,
    taxonomy: list[dict[str, Any]] | None = None,
    split_tracks: bool | None = None,
    started_at: float | None = None,
    viewer: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write library.json (+ meta) atomically. Returns the meta dict.

    split_tracks: True/False forces the layout; None splits only when the gzip budget is exceeded.
    viewer: optional viewer settings stored in the file, e.g. {"crateCapacity": 40}.
    """
    albums = sorted(albums, key=lambda a: a.get("addedAt") or "", reverse=True)
    generated_at = utc_now_iso()
    library: dict[str, Any] = {"version": SCHEMA_VERSION, "generatedAt": generated_at, "source": source, "albums": albums}
    if taxonomy is not None:
        library["taxonomy"] = taxonomy
    if viewer:
        library["viewer"] = viewer

    problems = validate_library(library)
    if problems:
        raise ValueError("Refusing to write an invalid library:\n  " + "\n  ".join(problems[:20]))

    raw = json.dumps(library, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    split = split_tracks if split_tracks is not None else _gzip_size(raw) > GZIP_BUDGET_BYTES
    tracks_dir = data_dir / "tracks"
    if split:
        slim = []
        for album in albums:
            album = dict(album)
            tracks = album.pop("tracks", None)
            if tracks:
                ref = f"tracks/{album['id']}.json"
                atomic_write_json(data_dir / ref, tracks, compact=True)
                album["tracksRef"] = ref
            slim.append(album)
        library = {**library, "albums": slim}
        raw = json.dumps(library, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    atomic_write_bytes(data_dir / "library.json", raw)

    meta = {
        "version": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "source": source,
        "counts": _counts(albums),
        "bytes": len(raw),
        "gzipBytes": _gzip_size(raw),
        "tracksLayout": "split" if split else "inline",
    }
    if started_at is not None:
        import time

        meta["durationSec"] = round(time.time() - started_at, 1)
    atomic_write_json(data_dir / "library.meta.json", meta)
    if not split and tracks_dir.exists():
        # Stale split files from an earlier run are harmless but confusing; leave a clean tree.
        for f in tracks_dir.glob("*.json"):
            f.unlink()
    return meta


def _counts(albums: Iterable[dict[str, Any]]) -> dict[str, int]:
    albums = list(albums)
    artists = {a["id"] for album in albums for a in album.get("artists", []) if a.get("id")}
    return {
        "albums": len(albums),
        "artists": len(artists),
        "withLabel": sum(1 for a in albums if a.get("label")),
        "withTracks": sum(1 for a in albums if a.get("tracks")),
        "withGenres": sum(1 for a in albums if a.get("genres")),
        "mono": sum(1 for a in albums if (a.get("palette") or {}).get("mono")),
    }
