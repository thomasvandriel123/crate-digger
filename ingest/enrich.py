"""Optional enrichment from MusicBrainz for gaps Spotify leaves (label, genres).

MusicBrainz asks for at most 1 request per second and a descriptive User-Agent with contact info.
Results (including misses) are cached per album id, so re-runs cost nothing.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

MB_API = "https://musicbrainz.org/ws/2"
CAA = "https://coverartarchive.org"
MIN_SCORE = 90


def _user_agent() -> str:
    contact = os.environ.get("MUSICBRAINZ_CONTACT", "https://github.com/thomasvandriel123/crate-digger")
    return f"CrateDigger/1.0 ( {contact} )"


def _lucene_escape(text: str) -> str:
    return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", text)


class MusicBrainz:
    def __init__(
        self,
        cache_path: Path,
        *,
        session: requests.Session | None = None,
        min_interval: float = 1.05,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.cache_path = cache_path
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = _user_agent()
        self.session.headers["Accept"] = "application/json"
        self.min_interval = min_interval
        self.sleep = sleep
        self._last = 0.0
        self.cache: dict[str, Any] = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    def save(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.cache))
        tmp.replace(self.cache_path)

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any] | None:
        for attempt in range(4):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                self.sleep(wait)
            self._last = time.monotonic()
            try:
                resp = self.session.get(f"{MB_API}{path}", params={**params, "fmt": "json"}, timeout=30)
            except requests.RequestException:
                self.sleep(2.0 * (attempt + 1))
                continue
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code in (429, 503):
                self.sleep(2.0 * (attempt + 1))
                continue
            return None
        return None

    def lookup(self, key: str, artist: str, title: str, year: int | None = None) -> dict[str, Any]:
        """Returns {"mbid", "label", "genres", "year"} (values may be None/empty). Cached by `key`."""
        if key in self.cache:
            return self.cache[key]
        query = f'release:"{_lucene_escape(title)}" AND artist:"{_lucene_escape(artist)}"'
        if year:
            query += f" AND date:{year}*"
        found: dict[str, Any] = {"mbid": None, "label": None, "genres": [], "year": None}
        body = self._get("/release/", {"query": query, "limit": 5})
        releases = [r for r in (body or {}).get("releases", []) if int(r.get("score", 0)) >= MIN_SCORE]
        if not releases and year:
            body = self._get("/release/", {"query": query.rsplit(" AND date:", 1)[0], "limit": 5})
            releases = [r for r in (body or {}).get("releases", []) if int(r.get("score", 0)) >= MIN_SCORE]
        if releases:
            best = releases[0]
            found["mbid"] = best.get("id")
            labels = [li.get("label", {}).get("name") for li in best.get("label-info") or [] if li.get("label")]
            found["label"] = next((name for name in labels if name and name.lower() != "[no label]"), None)
            date = best.get("date") or ""
            found["year"] = int(date[:4]) if date[:4].isdigit() else None
            rg = (best.get("release-group") or {}).get("id")
            if rg:
                detail = self._get(f"/release-group/{rg}", {"inc": "genres+tags"})
                genres = [g["name"] for g in (detail or {}).get("genres") or [] if g.get("count", 0) > 0]
                if not genres:
                    genres = [t["name"] for t in sorted((detail or {}).get("tags") or [], key=lambda t: -t.get("count", 0))[:4]]
                found["genres"] = genres
        self.cache[key] = found
        return found

    @staticmethod
    def cover_url(mbid: str) -> str:
        return f"{CAA}/release/{mbid}/front-500"


def enrich_album(mb: MusicBrainz, album: dict[str, Any]) -> bool:
    """Fill missing label / genresRaw in place. Returns True if anything changed."""
    if album.get("label") and album.get("genresRaw"):
        return False
    artist = album["artists"][0]["name"] if album.get("artists") else ""
    info = mb.lookup(album["id"], artist, album["title"], album.get("year"))
    changed = False
    if not album.get("label") and info.get("label"):
        album["label"] = info["label"]
        changed = True
    if not album.get("genresRaw") and info.get("genres"):
        album["genresRaw"] = sorted({g.lower() for g in info["genres"]})
        changed = True
    return changed
