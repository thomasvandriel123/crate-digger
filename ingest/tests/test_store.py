import json

import pytest

from ingest.store import atomic_write_json, load_library, write_library


def album(i: int, **extra):
    base = {
        "id": f"id{i:03d}",
        "uri": f"spotify:album:id{i:03d}",
        "title": f"Album {i}",
        "artists": [{"id": "a1", "name": "Artist"}],
        "year": 1970 + i,
        "releaseDate": f"{1970 + i}-01-01",
        "addedAt": f"2024-01-{i + 1:02d}T00:00:00Z",
        "type": "album",
        "label": None,
        "totalTracks": 2,
        "durationMs": 1000,
        "genres": [],
        "genresRaw": [],
        "cover": {"web": f"covers/512/id{i:03d}.webp", "thumb": f"covers/256/id{i:03d}.webp", "ktx2": None},
        "palette": {"dominant": "#112233", "swatches": ["#112233"] * 3, "hue": 250.0, "chroma": 0.05, "lightness": 0.3, "mono": False},
        "tracks": [{"n": 1, "title": "A", "durationMs": 500}, {"n": 2, "title": "B", "durationMs": 500}],
    }
    base.update(extra)
    return base


def test_atomic_write_leaves_no_temp_files(tmp_path):
    atomic_write_json(tmp_path / "x.json", {"a": 1})
    assert json.loads((tmp_path / "x.json").read_text()) == {"a": 1}
    assert [p.name for p in tmp_path.iterdir()] == ["x.json"]


def test_write_library_sorts_newest_first_and_writes_meta(tmp_path):
    meta = write_library(tmp_path, [album(1), album(5), album(3)], source="test")
    lib = json.loads((tmp_path / "library.json").read_text())
    assert [a["id"] for a in lib["albums"]] == ["id005", "id003", "id001"]
    assert lib["version"] == 1
    assert meta["counts"]["albums"] == 3
    assert json.loads((tmp_path / "library.meta.json").read_text())["tracksLayout"] == "inline"


def test_split_tracks_round_trip(tmp_path):
    write_library(tmp_path, [album(1), album(2)], source="test", split_tracks=True)
    lib = json.loads((tmp_path / "library.json").read_text())
    assert all("tracks" not in a and a["tracksRef"].startswith("tracks/") for a in lib["albums"])
    reloaded = load_library(tmp_path)
    assert reloaded is not None
    assert all(len(a["tracks"]) == 2 for a in reloaded["albums"])


def test_invalid_library_is_not_written(tmp_path):
    bad = album(1)
    bad["palette"] = {"dominant": "red"}
    with pytest.raises(ValueError):
        write_library(tmp_path, [bad], source="test")
    assert not (tmp_path / "library.json").exists()
