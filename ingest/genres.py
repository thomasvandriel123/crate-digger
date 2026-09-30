"""Map raw Spotify artist genres onto a small, editable macro taxonomy (genre-map.json)."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MAP = Path(__file__).with_name("genre-map.json")


def _keyword_regex(keyword: str) -> str:
    kw = keyword.strip().lower()
    prefix = kw.startswith("*")
    suffix = kw.endswith("*")
    core = re.escape(kw.strip("*"))
    return ("[a-z]*" if prefix else "") + core + ("[a-z]*" if suffix else "")


@dataclass
class GenreMap:
    macros: list[dict]
    exact: dict[str, list[str]]
    fallback: str | None = None
    _patterns: list[tuple[str, re.Pattern[str]]] = field(default_factory=list, repr=False)

    @classmethod
    def load(cls, path: Path | str = DEFAULT_MAP) -> GenreMap:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        gm = cls(macros=data["macros"], exact={k.lower(): v for k, v in data.get("exact", {}).items()}, fallback=data.get("fallback"))
        known = {m["id"] for m in gm.macros}
        for raw, targets in gm.exact.items():
            unknown = set(targets) - known
            if unknown:
                raise ValueError(f"genre-map.json: exact[{raw!r}] refers to unknown macro(s) {sorted(unknown)}")
        for macro in gm.macros:
            words = sorted((_keyword_regex(k) for k in macro["keywords"]), key=len, reverse=True)
            # Whole-word match, so "rock" does not claim "rocksteady"; '*' opts into prefix/suffix matching.
            gm._patterns.append((macro["id"], re.compile(r"(?<![a-z])(?:" + "|".join(words) + r")(?![a-z])")))
        return gm

    def names(self) -> dict[str, str]:
        return {m["id"]: m["name"] for m in self.macros}

    def map_one(self, raw: str) -> list[str]:
        key = raw.strip().lower()
        if not key:
            return []
        if key in self.exact:
            return list(self.exact[key])
        hits = [macro_id for macro_id, pattern in self._patterns if pattern.search(key)]
        if hits:
            return hits
        return [self.fallback] if self.fallback else []

    def map_many(self, raws: Iterable[str]) -> list[str]:
        order = {m["id"]: i for i, m in enumerate(self.macros)}
        out: set[str] = set()
        for raw in raws:
            out.update(self.map_one(raw))
        return sorted(out, key=lambda g: order.get(g, 999))

    def taxonomy(self, albums: Iterable[dict]) -> list[dict]:
        """Macro genres present in the library, each with the micro (raw) genres that map to it."""
        micro: dict[str, set[str]] = {m["id"]: set() for m in self.macros}
        counts: dict[str, int] = {m["id"]: 0 for m in self.macros}
        for album in albums:
            for g in album.get("genres", []):
                if g in counts:
                    counts[g] += 1
            for raw in album.get("genresRaw", []):
                for macro_id in self.map_one(raw):
                    if macro_id in micro:
                        micro[macro_id].add(raw)
        return [{"id": m["id"], "name": m["name"], "micro": sorted(micro[m["id"]])} for m in self.macros if counts[m["id"]] > 0]
