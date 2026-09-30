import json

from ingest.run import main
from ingest.schema import validate_library


def test_mock_generation_is_valid_and_deterministic(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    assert main(["mock", "--out", str(a), "--count", "24", "--seed", "7"]) == 0
    assert main(["mock", "--out", str(b), "--count", "24", "--seed", "7"]) == 0
    lib_a = json.loads((a / "library.json").read_text())
    lib_b = json.loads((b / "library.json").read_text())
    assert validate_library(lib_a) == []
    assert [x["id"] for x in lib_a["albums"]] == [x["id"] for x in lib_b["albums"]]
    assert len(lib_a["albums"]) == 24
    for album in lib_a["albums"]:
        assert (a / album["cover"]["web"]).exists() and (a / album["cover"]["thumb"]).exists()
    assert lib_a["taxonomy"], "taxonomy lists the macro genres present"


def test_mock_refuses_to_overwrite_real_library(tmp_path):
    (tmp_path / "library.json").write_text(json.dumps({"version": 1, "source": "spotify", "albums": []}))
    assert main(["mock", "--out", str(tmp_path), "--count", "2"]) == 2


def test_crate_size_is_stored_for_the_viewer(tmp_path):
    assert main(["mock", "--out", str(tmp_path), "--count", "3", "--crate-size", "40"]) == 0
    lib = json.loads((tmp_path / "library.json").read_text())
    assert lib["viewer"] == {"crateCapacity": 40}
    # remap keeps it
    assert main(["remap", "--out", str(tmp_path)]) == 0
    assert json.loads((tmp_path / "library.json").read_text())["viewer"] == {"crateCapacity": 40}
