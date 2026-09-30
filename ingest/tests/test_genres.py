import json

import pytest

from ingest.genres import GenreMap


@pytest.fixture(scope="module")
def gm() -> GenreMap:
    return GenreMap.load()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("hard bop", ["jazz"]),
        ("bebop", ["jazz"]),
        ("psychedelic rock", ["rock"]),
        ("rocksteady", ["reggae"]),  # whole-word: 'rock' must not match
        ("dutch hip hop", ["hiphop"]),
        ("deep house", ["electronic"]),
        ("jazz funk", ["jazz", "soul"]),
        ("Indie Folk", ["folk"]),
        ("unclassifiable thing", []),
    ],
)
def test_map_one(gm: GenreMap, raw: str, expected: list[str]):
    assert sorted(gm.map_one(raw)) == sorted(expected)


def test_map_many_is_ordered_and_unique(gm: GenreMap):
    assert gm.map_many(["hard bop", "cool jazz", "classic soul"]) == ["jazz", "soul"]


def test_taxonomy_lists_present_macros_with_micro(gm: GenreMap):
    albums = [{"genres": ["jazz"], "genresRaw": ["hard bop", "cool jazz"]}, {"genres": ["rock"], "genresRaw": ["shoegaze"]}]
    tax = {t["id"]: t for t in gm.taxonomy(albums)}
    assert set(tax) == {"jazz", "rock"}
    assert tax["jazz"]["micro"] == ["cool jazz", "hard bop"]


def test_exact_refs_are_validated(tmp_path):
    path = tmp_path / "map.json"
    path.write_text(json.dumps({"macros": [{"id": "a", "name": "A", "keywords": ["x"]}], "exact": {"y": ["nope"]}}))
    with pytest.raises(ValueError, match="unknown macro"):
        GenreMap.load(path)
