import pytest

from ingest.run import album_from_spotify
from ingest.spotify import ArtistCache, PkceAuth, SpotifyClient, SpotifyError, TokenStore, iter_liked_track_albums, iter_saved_albums

from .conftest import FakeResponse


def page(items, next_url=None):
    return {"items": items, "next": next_url}


def saved(album_id, added="2024-01-01T00:00:00Z"):
    return {"added_at": added, "album": {"id": album_id, "name": album_id}}


def make_client(session, sleep):
    return SpotifyClient(lambda: "token", session=session, min_interval=0, sleep=sleep)


def test_incremental_stops_at_first_known_album(fake_session_factory, no_sleep):
    _, sleep = no_sleep
    pages = {
        "/me/albums?page2": FakeResponse(200, page([saved("c"), saved("d")], "https://api.spotify.com/v1/me/albums?page3")),
        "/me/albums?page3": FakeResponse(200, page([saved("e")])),
        "/me/albums": FakeResponse(200, page([saved("a"), saved("b")], "https://api.spotify.com/v1/me/albums?page2")),
    }

    def respond(resp):
        return lambda url, params: resp

    session = fake_session_factory({k: respond(v) for k, v in pages.items()})
    client = make_client(session, sleep)
    ids = [i["album"]["id"] for i in iter_saved_albums(client, known_ids={"d"})]
    assert ids == ["a", "b", "c"]
    assert not any("page3" in url for url, _ in session.calls), "must not page past the first known album"


def test_retry_after_is_respected(fake_session_factory, no_sleep):
    slept, sleep = no_sleep
    responses = iter([FakeResponse(429, {}, {"Retry-After": "3"}), FakeResponse(200, {"ok": True})])
    session = fake_session_factory({"/me": lambda url, params: next(responses)})
    assert make_client(session, sleep).get("/me") == {"ok": True}
    assert 3.0 in slept


def test_gives_up_after_max_retries(fake_session_factory, no_sleep):
    _, sleep = no_sleep
    session = fake_session_factory({"/me": lambda url, params: FakeResponse(503, {})})
    client = SpotifyClient(lambda: "t", session=session, min_interval=0, sleep=sleep, max_retries=2)
    with pytest.raises(SpotifyError):
        client.get("/me")


def test_artist_cache_falls_back_to_single_requests(fake_session_factory, no_sleep, tmp_path):
    _, sleep = no_sleep

    def artists(url, params):
        if params and "ids" in params:
            return FakeResponse(403, {"error": "removed"})
        artist_id = url.rsplit("/", 1)[-1]
        return FakeResponse(200, {"id": artist_id, "name": artist_id.upper(), "genres": ["hard bop"]})

    session = fake_session_factory({"/artists": artists})
    cache = ArtistCache(tmp_path / "artists.json", make_client(session, sleep))
    cache.ensure(["x", "y", "x"])
    assert cache.genres("x") == ["hard bop"] and cache.genres("y") == ["hard bop"]
    calls = len(session.calls)
    cache.ensure(["x", "y"])  # cached: no new requests
    assert len(session.calls) == calls
    assert ArtistCache(tmp_path / "artists.json", make_client(session, sleep)).genres("y") == ["hard bop"]


def test_liked_tracks_grouping(fake_session_factory, no_sleep):
    _, sleep = no_sleep

    def track(album_id, total, added):
        return {"added_at": added, "track": {"album": {"id": album_id, "total_tracks": total}}}

    items = [
        track("full", 2, "2024-02-01"),
        track("full", 2, "2024-01-01"),
        track("few", 12, "2024-01-01"),
        *[track("many", 10, f"2024-03-0{i}") for i in range(1, 4)],
    ]
    session = fake_session_factory({"/me/tracks": lambda url, params: FakeResponse(200, page(items))})
    albums = {a["album"]["id"]: a for a in iter_liked_track_albums(make_client(session, sleep), threshold=3)}
    assert set(albums) == {"full", "many"}
    assert albums["full"]["added_at"] == "2024-01-01"


def test_album_mapping_tolerates_missing_fields():
    album = album_from_spotify({"id": "abc"}, None, None)
    assert album["title"] == "Untitled"
    assert album["artists"][0]["name"] == "Unknown artist"
    assert album["label"] is None and album["year"] is None and "tracks" not in album
    full = album_from_spotify(
        {
            "id": "abc",
            "name": "Kind",
            "album_type": "single",
            "release_date": "1959-08",
            "artists": [{"id": "m", "name": "Miles"}],
            "images": [{"url": "s", "width": 64, "height": 64}, {"url": "l", "width": 640, "height": 640}],
        },
        "2024-01-01T00:00:00Z",
        [{"track_number": 1, "name": "So What", "duration_ms": 562000}],
    )
    assert full["year"] == 1959 and full["type"] == "single" and full["durationMs"] == 562000
    assert full["_imageUrl"] == "l"


def test_localhost_redirect_is_rejected(tmp_path):
    with pytest.raises(SpotifyError, match="loopback"):
        PkceAuth("client", TokenStore(tmp_path / "t.json"), "http://localhost:8888/callback")


def test_token_store_is_private(tmp_path):
    from ingest.spotify import Token

    store = TokenStore(tmp_path / "token.json")
    store.save(Token("a", "r", 123.0))
    assert (tmp_path / "token.json").stat().st_mode & 0o077 == 0
    assert store.load().refresh_token == "r"
