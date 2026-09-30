"""Spotify Web API access for the ingest: PKCE auth, a polite HTTP client, and library readers.

API surface notes (verified against Spotify's February 2026 development-mode changes):
- Development-mode apps need a Premium account and an allow-list of at most 5 users.
- Album objects no longer carry `label`, `popularity`, `external_ids` or `available_markets`.
  The Label filter therefore depends on MusicBrainz enrichment (enrich.py) and is dropped when empty.
- The batch endpoints `GET /artists?ids=` and `GET /albums?ids=` were removed. Artists are fetched one by
  one (`GET /artists/{id}`, which still returns `genres`), paced, and cached on disk across runs.
- Redirect URIs must use a loopback IP literal (http://127.0.0.1:PORT/...), not `localhost`.
Everything here tolerates missing fields: a field that disappears degrades a feature, never the run.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import secrets
import threading
import time
import urllib.parse
import webbrowser
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

API = "https://api.spotify.com/v1"
AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
DEFAULT_REDIRECT = "http://127.0.0.1:8888/callback"
SCOPES = "user-library-read"
USER_AGENT = "CrateDigger-Ingest/1.0"


class SpotifyError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


# --- auth ---------------------------------------------------------------------------------------------


@dataclass
class Token:
    access_token: str
    refresh_token: str | None
    expires_at: float
    scope: str = ""

    @property
    def expired(self) -> bool:
        return time.time() > self.expires_at - 60

    def to_json(self) -> dict[str, Any]:
        return {"access_token": self.access_token, "refresh_token": self.refresh_token, "expires_at": self.expires_at, "scope": self.scope}


def _pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode()[:128]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class TokenStore:
    """Token cache on disk with owner-only permissions. Never commit this file (it is gitignored)."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> Token | None:
        if not self.path.exists():
            return None
        try:
            data = json.loads(self.path.read_text())
            return Token(data["access_token"], data.get("refresh_token"), float(data["expires_at"]), data.get("scope", ""))
        except (ValueError, KeyError):
            return None

    def save(self, token: Token) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(token.to_json(), fh)
        os.replace(tmp, self.path)


class PkceAuth:
    """Authorization Code with PKCE. No client secret is needed or stored."""

    def __init__(
        self,
        client_id: str,
        store: TokenStore,
        redirect_uri: str = DEFAULT_REDIRECT,
        *,
        open_browser: bool = True,
        session: requests.Session | None = None,
        input_fn: Callable[[str], str] = input,
    ):
        if not client_id:
            raise SpotifyError("SPOTIFY_CLIENT_ID is not set. Create an app at developer.spotify.com and export its client id.")
        parsed = urllib.parse.urlparse(redirect_uri)
        if parsed.hostname == "localhost":
            raise SpotifyError("Spotify rejects 'localhost' redirect URIs; use a loopback IP such as http://127.0.0.1:8888/callback")
        self.client_id = client_id
        self.store = store
        self.redirect_uri = redirect_uri
        self.open_browser = open_browser
        self.session = session or requests.Session()
        self.input_fn = input_fn
        self._token: Token | None = store.load()

    def access_token(self) -> str:
        if self._token and not self._token.expired:
            return self._token.access_token
        if self._token and self._token.refresh_token:
            try:
                self._token = self._refresh(self._token.refresh_token)
                self.store.save(self._token)
                return self._token.access_token
            except SpotifyError as exc:
                print(f"  token refresh failed ({exc}); starting a new login")
        self._token = self._login()
        self.store.save(self._token)
        return self._token.access_token

    def invalidate(self) -> None:
        if self._token:
            self._token.expires_at = 0

    def _token_request(self, data: dict[str, str]) -> Token:
        resp = self.session.post(TOKEN_URL, data={**data, "client_id": self.client_id}, timeout=30)
        if resp.status_code != 200:
            raise SpotifyError(f"token endpoint returned {resp.status_code}: {resp.text[:200]}")
        body = resp.json()
        return Token(
            access_token=body["access_token"],
            refresh_token=body.get("refresh_token") or data.get("refresh_token"),
            expires_at=time.time() + float(body.get("expires_in", 3600)),
            scope=body.get("scope", ""),
        )

    def _refresh(self, refresh_token: str) -> Token:
        return self._token_request({"grant_type": "refresh_token", "refresh_token": refresh_token})

    def _login(self) -> Token:
        verifier, challenge = _pkce_pair()
        state = secrets.token_urlsafe(16)
        url = (
            AUTH_URL
            + "?"
            + urllib.parse.urlencode(
                {
                    "client_id": self.client_id,
                    "response_type": "code",
                    "redirect_uri": self.redirect_uri,
                    "code_challenge_method": "S256",
                    "code_challenge": challenge,
                    "scope": SCOPES,
                    "state": state,
                }
            )
        )
        if self.open_browser:
            code = self._login_with_callback_server(url, state)
        else:
            print("\nOpen this URL in a browser, approve access, then paste the full URL you are redirected to")
            print("(it will fail to load on a headless server; that is expected, copy it from the address bar):\n")
            print(url + "\n")
            code = self._code_from_redirect(self.input_fn("Redirected URL: ").strip(), state)
        return self._token_request(
            {"grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri, "code_verifier": verifier}
        )

    @staticmethod
    def _code_from_redirect(redirected: str, state: str) -> str:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(redirected).query)
        if query.get("state", [""])[0] != state:
            raise SpotifyError("OAuth state mismatch; aborting (possible CSRF or stale URL)")
        if "error" in query:
            raise SpotifyError(f"authorization denied: {query['error'][0]}")
        code = query.get("code", [""])[0]
        if not code:
            raise SpotifyError("no authorization code in redirect URL")
        return code

    def _login_with_callback_server(self, url: str, state: str) -> str:
        parsed = urllib.parse.urlparse(self.redirect_uri)
        result: dict[str, str] = {}
        done = threading.Event()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if urllib.parse.urlparse(self.path).path != parsed.path:
                    self.send_response(404)
                    self.end_headers()
                    return
                result["url"] = f"{parsed.scheme}://{parsed.netloc}{self.path}"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"<p style='font-family:sans-serif'>Crate Digger is authorised. You can close this tab.</p>")
                done.set()

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer((parsed.hostname or "127.0.0.1", parsed.port or 80), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        print(f"\nOpening Spotify login in your browser. If it does not open, visit:\n{url}\n")
        webbrowser.open(url)
        try:
            if not done.wait(timeout=300):
                raise SpotifyError("timed out waiting for the Spotify redirect (5 minutes)")
        finally:
            server.shutdown()
        return self._code_from_redirect(result["url"], state)


# --- HTTP client --------------------------------------------------------------------------------------


class SpotifyClient:
    """GET-only client with 429 Retry-After handling, bounded retries for 5xx, and pacing."""

    def __init__(
        self,
        token_fn: Callable[[], str],
        *,
        session: requests.Session | None = None,
        min_interval: float = 0.12,
        max_retries: int = 5,
        sleep: Callable[[float], None] = time.sleep,
        on_unauthorized: Callable[[], None] | None = None,
    ):
        self.token_fn = token_fn
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", USER_AGENT)
        self.min_interval = min_interval
        self.max_retries = max_retries
        self.sleep = sleep
        self.on_unauthorized = on_unauthorized
        self._last = 0.0
        self.requests_made = 0

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        url = path if path.startswith("http") else f"{API}{path}"
        attempt = 0
        reauthed = False
        while True:
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                self.sleep(wait)
            self._last = time.monotonic()
            self.requests_made += 1
            resp = self.session.get(url, params=params, headers={"Authorization": f"Bearer {self.token_fn()}"}, timeout=30)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 401 and not reauthed and self.on_unauthorized:
                self.on_unauthorized()
                reauthed = True
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                attempt += 1
                if attempt > self.max_retries:
                    raise SpotifyError(f"GET {url} failed after {self.max_retries} retries ({resp.status_code})")
                retry_after = resp.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else min(30.0, 2.0**attempt)
                print(f"  {resp.status_code} from Spotify, backing off {delay:.0f}s")
                self.sleep(delay)
                continue
            raise SpotifyError(f"GET {url} returned {resp.status_code}: {resp.text[:200]}", resp.status_code)

    def paginate(self, path: str, params: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
        page = self.get(path, params)
        while True:
            yield from page.get("items") or []
            nxt = page.get("next")
            if not nxt:
                return
            page = self.get(nxt)


# --- library readers ----------------------------------------------------------------------------------


def iter_saved_albums(client: SpotifyClient, known_ids: set[str] | None = None) -> Iterator[dict[str, Any]]:
    """Saved albums, newest first. With known_ids, stops at the first album already in the library."""
    for item in client.paginate("/me/albums", {"limit": 50}):
        album = item.get("album") or {}
        if known_ids is not None and album.get("id") in known_ids:
            return
        if album.get("id"):
            yield {"added_at": item.get("added_at"), "album": album}


def iter_liked_track_albums(client: SpotifyClient, threshold: int = 3) -> Iterator[dict[str, Any]]:
    """Albums derived from Liked Songs: at least `threshold` liked tracks, or every track of the album."""
    groups: dict[str, dict[str, Any]] = {}
    for item in client.paginate("/me/tracks", {"limit": 50}):
        track = item.get("track") or {}
        album = track.get("album") or {}
        album_id = album.get("id")
        if not album_id:
            continue
        g = groups.setdefault(album_id, {"album": album, "count": 0, "added_at": item.get("added_at")})
        g["count"] += 1
        # Earliest like marks when the album entered the collection.
        if item.get("added_at") and (not g["added_at"] or item["added_at"] < g["added_at"]):
            g["added_at"] = item["added_at"]
    for g in groups.values():
        total = g["album"].get("total_tracks") or 0
        if g["count"] >= threshold or (total and g["count"] >= total):
            yield {"added_at": g["added_at"], "album": g["album"]}


def fetch_album(client: SpotifyClient, album_id: str) -> dict[str, Any] | None:
    try:
        return client.get(f"/albums/{album_id}")
    except SpotifyError as exc:
        print(f"  album {album_id}: {exc}")
        return None


def fetch_all_tracks(client: SpotifyClient, album: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Full track list. Saved-album payloads embed the first page; follow `next` for long albums."""
    page = album.get("tracks")
    if page is None:
        try:
            page = client.get(f"/albums/{album['id']}/tracks", {"limit": 50})
        except SpotifyError:
            return None
    items = list(page.get("items") or [])
    nxt = page.get("next")
    while nxt:
        try:
            page = client.get(nxt)
        except SpotifyError:
            break
        items.extend(page.get("items") or [])
        nxt = page.get("next")
    return items


class ArtistCache:
    """Artist genres cached across runs. The batch endpoint is gone for dev-mode apps, so we fetch one by
    one, which is slow (hundreds of artists) but only happens once per artist."""

    def __init__(self, path: Path, client: SpotifyClient, *, max_age_days: int = 90):
        self.path = path
        self.client = client
        self.max_age = max_age_days * 86400
        self.data: dict[str, dict[str, Any]] = json.loads(path.read_text()) if path.exists() else {}
        self._batch_supported: bool | None = None

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data))
        tmp.replace(self.path)

    def _fresh(self, artist_id: str) -> bool:
        entry = self.data.get(artist_id)
        return bool(entry) and time.time() - entry.get("fetchedAt", 0) < self.max_age

    def ensure(self, artist_ids: list[str]) -> None:
        missing = [a for a in dict.fromkeys(artist_ids) if a and not self._fresh(a)]
        if not missing:
            return
        print(f"  fetching genres for {len(missing)} artists")
        if self._batch_supported is not False:
            try:
                for i in range(0, len(missing), 50):
                    chunk = missing[i : i + 50]
                    body = self.client.get("/artists", {"ids": ",".join(chunk)})
                    for artist in body.get("artists") or []:
                        if artist:
                            self._store(artist)
                self._batch_supported = True
                self.save()
                return
            except SpotifyError as exc:
                print(f"  batch artists endpoint unavailable ({exc}); falling back to one request per artist")
                self._batch_supported = False
        for n, artist_id in enumerate(missing, 1):
            if self._fresh(artist_id):
                continue
            try:
                self._store(self.client.get(f"/artists/{artist_id}"))
            except SpotifyError as exc:
                print(f"  artist {artist_id}: {exc}")
                self.data[artist_id] = {"genres": [], "fetchedAt": time.time(), "error": True}
            if n % 25 == 0:
                self.save()
                print(f"    {n}/{len(missing)} artists")
        self.save()

    def _store(self, artist: dict[str, Any]) -> None:
        self.data[artist["id"]] = {"name": artist.get("name"), "genres": list(artist.get("genres") or []), "fetchedAt": time.time()}

    def genres(self, artist_id: str) -> list[str]:
        return list((self.data.get(artist_id) or {}).get("genres") or [])


def best_image_url(album: dict[str, Any]) -> str | None:
    images = [img for img in album.get("images") or [] if img.get("url")]
    if not images:
        return None
    return max(images, key=lambda img: (img.get("width") or 0) * (img.get("height") or 0))["url"]
