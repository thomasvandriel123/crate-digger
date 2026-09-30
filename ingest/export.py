"""Fallback input: Spotify's account data download ("YourLibrary.json").

The export lists saved albums as artist/album/uri triples with no dates or metadata. Metadata then comes
from per-album Spotify lookups (when a token is available) or from MusicBrainz alone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_export(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    albums = data.get("albums") if isinstance(data, dict) else None
    if albums is None:
        raise ValueError(f"{path} has no 'albums' list; expected Spotify's YourLibrary.json")
    out = []
    seen: set[str] = set()
    for entry in albums:
        uri = entry.get("uri") or ""
        album_id = uri.rsplit(":", 1)[-1] if uri.startswith("spotify:album:") else None
        if not album_id or album_id in seen:
            continue
        seen.add(album_id)
        out.append({"id": album_id, "uri": uri, "artist": entry.get("artist") or "", "title": entry.get("album") or ""})
    return out
