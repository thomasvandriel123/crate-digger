from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest


class FakeResponse:
    def __init__(self, status: int = 200, body: Any = None, headers: dict[str, str] | None = None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = str(body)
        self.content = b""

    def json(self) -> Any:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeSession:
    """Routes GET urls to handler callables; records every call."""

    def __init__(self, routes: dict[str, Callable[[str, dict | None], FakeResponse]]):
        self.routes = routes
        self.calls: list[tuple[str, dict | None]] = []
        self.headers: dict[str, str] = {}

    def get(self, url: str, params: dict | None = None, headers: dict | None = None, timeout: float | None = None) -> FakeResponse:
        self.calls.append((url, params))
        for prefix, handler in self.routes.items():
            if prefix in url:
                return handler(url, params)
        return FakeResponse(404, {"error": "not found"})


@pytest.fixture
def fake_session_factory():
    return FakeSession


@pytest.fixture
def no_sleep():
    slept: list[float] = []
    return slept, slept.append
