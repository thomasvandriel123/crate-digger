"""Crate Digger ingest: builds a static library.json plus optimised covers.

The viewer never talks to Spotify at runtime. Everything that depends on an external API lives here,
so API changes are isolated to one place and browsing stays fast and offline-capable.
"""

__version__ = "1.0.0"
