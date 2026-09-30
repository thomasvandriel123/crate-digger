"""Mock library: a realistic library.json with procedural covers, so the viewer runs with no Spotify account.

Deterministic for a given seed. Covers are drawn with Pillow in a dozen styles (gradients, Bauhaus
geometry, op-art stripes, Swiss grids, typographic covers, duotone "photos", bokeh, B&W) using curated
palettes that span the hue wheel, so colour filters and the colour sweep sort have something to show.
The covers go through the real palette extractor, which keeps that code path exercised.
"""

from __future__ import annotations

import math
import random
import string
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .covers import write_cover_variants
from .genres import GenreMap
from .palette import extract_palette
from .schema import cover_paths

COVER_PX = 640

# --- word banks -------------------------------------------------------------------------------------

FIRST = [
    "Mira",
    "Joon",
    "Ada",
    "Tomas",
    "Nia",
    "Ezra",
    "Lena",
    "Kofi",
    "Ines",
    "Ravi",
    "Saoirse",
    "Milo",
    "Yara",
    "Otis",
    "Femi",
    "Hana",
    "Luca",
    "Noor",
    "Bram",
    "Esme",
    "Dario",
    "Anouk",
    "Wren",
    "Idris",
    "Maren",
    "Sol",
    "Teodor",
    "Amara",
    "Cato",
    "June",
    "Rafael",
    "Lotte",
    "Kenji",
    "Zadie",
    "Ilse",
    "Moses",
    "Cleo",
    "Jasper",
]
LAST = [
    "Okafor",
    "Lindqvist",
    "Moreau",
    "de Wit",
    "Halvorsen",
    "Achterberg",
    "Nakamura",
    "Castellano",
    "Brennan",
    "Adeyemi",
    "Kowalczyk",
    "Vermeulen",
    "Santos",
    "Whitlock",
    "Oduya",
    "Marchetti",
    "Ferreira",
    "Holloway",
    "Sørensen",
    "Bakker",
    "Esposito",
    "Tanaka",
    "Quartey",
    "Varga",
    "Ibarra",
    "Lachance",
    "Mbeki",
    "Ruiz",
]
ADJ = [
    "Velvet",
    "Quiet",
    "Amber",
    "Paper",
    "Low",
    "Midnight",
    "Copper",
    "Hollow",
    "Silver",
    "Northern",
    "Slow",
    "Electric",
    "Sunday",
    "Wooden",
    "Glass",
    "Pale",
    "Golden",
    "Distant",
    "Crimson",
    "Blue",
    "Soft",
    "Late",
]
NOUN_PL = [
    "Harbours",
    "Lanterns",
    "Orchards",
    "Pilots",
    "Tides",
    "Satellites",
    "Foxes",
    "Ferries",
    "Engines",
    "Choirs",
    "Moths",
    "Bridges",
    "Signals",
    "Rivers",
    "Cranes",
    "Radios",
    "Gardens",
    "Canals",
    "Comets",
    "Echoes",
]
NOUN = [
    "Harbour",
    "Arithmetic",
    "Weather",
    "Lantern",
    "Orchard",
    "Horizon",
    "Tide",
    "Static",
    "Meridian",
    "Ferry",
    "Parallax",
    "Hourglass",
    "Canal",
    "Signal",
    "Ember",
    "Gravity",
    "Monsoon",
    "Lighthouse",
    "Mirage",
    "Atlas",
    "Velvet",
    "Nocturne",
    "Satellite",
    "Driftwood",
    "Paperweight",
    "Riverbed",
    "Tangerine",
    "Cathedral",
]
PLACES = ["Rotterdam", "the Paradiso", "Montreux", "the Village Vanguard", "Lagos", "Osaka", "the Roundhouse", "Havana"]
ENSEMBLE = ["Trio", "Quartet", "Quintet", "Ensemble", "Orchestra", "Collective", "Sound System", "Arkestra"]
ALIAS = ["Kestrel", "Nightjar", "Lumen", "Halcyon", "Ostinato", "Vektor", "Morrow", "Pallas", "Cirrus", "Tessellate"]

LABELS = [
    "Brass Lantern Records",
    "Northdock",
    "Salt & Ember",
    "Kestrel Sound",
    "Oblique Tapes",
    "Harbour Lights",
    "Maasbank Recordings",
    "Low Orbit",
    "Paper Moon",
    "Copperplate",
    "Stillwater",
    "Tidal Archive",
    "Nightshift Records",
    "Blue Hour",
    "Iron Kettle",
    "Meridian Music",
    "Canal Street",
    "Greyfield",
    "Velvet Cabinet",
    "Sunhouse",
    "Motorway Jazz",
    "Driftwood Editions",
    "Orbital Arts",
    "Lantern & Key",
]

TRACK_WORDS = [
    "Night",
    "Harbour",
    "Blue",
    "Song",
    "Waltz",
    "for",
    "the",
    "Light",
    "Morning",
    "River",
    "Slow",
    "Dance",
    "Rain",
    "Lantern",
    "Home",
    "Train",
    "Summer",
    "Letter",
    "Winter",
    "Garden",
    "Moon",
    "Echo",
    "Coffee",
    "Window",
    "Stairs",
    "Sunday",
    "Lullaby",
    "Interlude",
    "Reprise",
    "Theme",
    "Walk",
    "Dream",
    "Paper",
    "Gold",
]

# Macro genre -> plausible raw (micro) genres. Kept consistent with genre-map.json so mapping is exercised.
MICRO = {
    "rock": ["indie rock", "psychedelic rock", "shoegaze", "krautrock", "post-punk", "classic rock", "art rock"],
    "pop": ["dream pop", "synthpop", "art pop", "nederpop", "chamber pop", "city pop", "sophisti-pop"],
    "jazz": ["hard bop", "cool jazz", "spiritual jazz", "vocal jazz", "jazz funk", "bossa nova", "free jazz"],
    "soul": ["classic soul", "neo soul", "funk", "northern soul", "quiet storm", "disco", "gospel"],
    "hiphop": ["boom bap", "jazz rap", "abstract hip hop", "dutch hip hop", "uk hip hop", "g-funk"],
    "electronic": ["deep house", "idm", "trip hop", "downtempo", "dub techno", "electro", "ambient techno"],
    "folk": ["indie folk", "americana", "alt-country", "british folk", "chamber folk", "bluegrass"],
    "blues": ["delta blues", "chicago blues", "electric blues", "country blues", "blues rock"],
    "classical": ["baroque", "minimalism", "contemporary classical", "string quartet", "early music", "romantic era"],
    "reggae": ["roots reggae", "dub", "rocksteady", "lovers rock", "ska"],
    "latin": ["salsa", "cumbia", "tropicalia", "mpb", "latin jazz", "bolero"],
    "world": ["afrobeat", "highlife", "ethio-jazz", "desert blues", "fado", "anatolian rock"],
    "metal": ["doom metal", "stoner rock", "post-metal", "sludge"],
    "punk": ["post-hardcore", "punk blues", "skate punk", "riot grrrl"],
    "soundtrack": ["soundtrack", "library music", "video game music"],
    "ambient": ["ambient", "drone", "fourth world", "new age", "field recording"],
}
GENRE_WEIGHTS = {
    "rock": 16,
    "jazz": 14,
    "soul": 11,
    "electronic": 12,
    "pop": 10,
    "hiphop": 7,
    "folk": 7,
    "ambient": 5,
    "world": 5,
    "blues": 3,
    "classical": 4,
    "reggae": 3,
    "latin": 4,
    "metal": 2,
    "punk": 2,
    "soundtrack": 2,
}
GENRE_ERA = {  # (earliest start year, latest start year)
    "jazz": (1955, 2018),
    "blues": (1955, 2010),
    "soul": (1960, 2018),
    "rock": (1965, 2020),
    "pop": (1970, 2021),
    "hiphop": (1986, 2021),
    "electronic": (1978, 2022),
    "folk": (1960, 2021),
    "classical": (1960, 2020),
    "reggae": (1965, 2015),
    "latin": (1958, 2020),
    "world": (1965, 2021),
    "metal": (1975, 2020),
    "punk": (1976, 2020),
    "soundtrack": (1965, 2021),
    "ambient": (1975, 2022),
}

# Curated palettes spread around the hue wheel, plus neutrals and B&W.
PALETTES = [
    ["#e4572e", "#f3a712", "#29335c", "#f0e6d2"],
    ["#1b998b", "#ed217c", "#2d3047", "#fffd82"],
    ["#0b3954", "#bfd7ea", "#ff6663", "#e0ff4f"],
    ["#264653", "#2a9d8f", "#e9c46a", "#f4a261"],
    ["#5f0f40", "#9a031e", "#fb8b24", "#e36414"],
    ["#3d348b", "#7678ed", "#f7b801", "#f18701"],
    ["#003049", "#d62828", "#f77f00", "#fcbf49"],
    ["#2b2d42", "#8d99ae", "#edf2f4", "#ef233c"],
    ["#606c38", "#283618", "#fefae0", "#dda15e"],
    ["#22223b", "#4a4e69", "#9a8c98", "#f2e9e4"],
    ["#006d77", "#83c5be", "#edf6f9", "#e29578"],
    ["#ff006e", "#8338ec", "#3a86ff", "#ffbe0b"],
    ["#10002b", "#5a189a", "#c77dff", "#e0aaff"],
    ["#081c15", "#1b4332", "#52b788", "#d8f3dc"],
    ["#7f5539", "#b08968", "#ede0d4", "#9c6644"],
    ["#03045e", "#0077b6", "#00b4d8", "#caf0f8"],
    ["#d00000", "#ffba08", "#3f88c5", "#032b43"],
    ["#f15bb5", "#fee440", "#00bbf9", "#00f5d4"],
    ["#6a040f", "#d00000", "#f48c06", "#ffba08"],
    ["#1d3557", "#457b9d", "#a8dadc", "#f1faee"],
    ["#ffcdb2", "#e5989b", "#b5838d", "#6d6875"],
    ["#386641", "#6a994e", "#a7c957", "#f2e8cf"],
    ["#0d1b2a", "#1b263b", "#e0e1dd", "#778da9"],
    ["#ffb703", "#fb8500", "#023047", "#8ecae6"],
    ["#c1121f", "#fdf0d5", "#003049", "#669bbc"],
    ["#9b5de5", "#f15bb5", "#fee440", "#00f5d4"],
    ["#335c67", "#fff3b0", "#e09f3e", "#9e2a2b"],
    ["#540b0e", "#9e2a2b", "#e09f3e", "#fff3b0"],
]
MONO_PALETTES = [["#111111", "#f2f2f2", "#777777", "#cccccc"], ["#1a1a1a", "#e8e4dc", "#4d4d4d", "#a6a6a6"]]

FONT_CANDIDATES = {
    "sans_bold": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "sans": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    "serif": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "C:/Windows/Fonts/georgiab.ttf",
    ],
    "serif_italic": [
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
        "C:/Windows/Fonts/georgiai.ttf",
    ],
    "mono": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "C:/Windows/Fonts/consola.ttf",
    ],
}
_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    key = (kind, size)
    if key not in _font_cache:
        loaded = None
        for path in FONT_CANDIDATES.get(kind, []):
            if Path(path).exists():
                try:
                    loaded = ImageFont.truetype(path, size)
                    break
                except OSError:
                    continue
        _font_cache[key] = loaded or ImageFont.load_default(size=size)
    return _font_cache[key]


# --- helpers ----------------------------------------------------------------------------------------


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def spotify_like_id(rng: random.Random) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(rng.choice(alphabet) for _ in range(22))


def text_fit(draw: ImageDraw.ImageDraw, text: str, kind: str, max_width: int, start: int, min_size: int = 14):
    size = start
    while size > min_size:
        f = font(kind, size)
        if draw.textlength(text, font=f) <= max_width:
            return f
        size -= 2
    return font(kind, min_size)


# --- cover styles -----------------------------------------------------------------------------------


@dataclass
class CoverSpec:
    artist: str
    title: str
    palette: list[str]
    style: str
    seed: int


def _grain(img: Image.Image, rng: random.Random, amount: int = 10) -> Image.Image:
    noise = Image.effect_noise((COVER_PX, COVER_PX), amount * 3).convert("RGB")
    return Image.blend(img, noise, amount / 255.0)


def _caption(draw: ImageDraw.ImageDraw, spec: CoverSpec, colour, *, position: str = "bottom", kind: str = "sans") -> None:
    pad = 34
    artist_font = text_fit(draw, spec.artist.upper(), kind + ("" if kind != "sans" else "_bold"), COVER_PX - 2 * pad, 30)
    title_font = text_fit(draw, spec.title, "serif_italic", COVER_PX - 2 * pad, 26)
    if position == "top":
        draw.text((pad, pad), spec.artist.upper(), font=artist_font, fill=colour)
        draw.text((pad, pad + 40), spec.title, font=title_font, fill=colour)
    else:
        draw.text((pad, COVER_PX - pad - 72), spec.artist.upper(), font=artist_font, fill=colour)
        draw.text((pad, COVER_PX - pad - 34), spec.title, font=title_font, fill=colour)


def style_gradient(spec: CoverSpec, rng: random.Random) -> Image.Image:
    a = np.array(hex_rgb(spec.palette[0]), dtype=np.float64)
    b = np.array(hex_rgb(spec.palette[1]), dtype=np.float64)
    angle = rng.uniform(0, math.pi)
    yy, xx = np.mgrid[0:COVER_PX, 0:COVER_PX].astype(np.float64)
    t = np.clip(((xx - 320) * math.cos(angle) + (yy - 320) * math.sin(angle)) / 450 + 0.5, 0.0, 1.0)
    t = t * t * (3 - 2 * t)
    img = Image.fromarray((a + (b - a) * t[..., None]).astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(img)
    if rng.random() < 0.6:
        r = rng.randint(90, 180)
        cx, cy = rng.randint(180, 460), rng.randint(160, 380)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=hex_rgb(spec.palette[3]))
    _caption(draw, spec, hex_rgb(spec.palette[3]) if rng.random() < 0.5 else (245, 240, 230))
    return img


def style_bauhaus(spec: CoverSpec, rng: random.Random) -> Image.Image:
    bg = hex_rgb(spec.palette[3])
    img = Image.new("RGB", (COVER_PX, COVER_PX), bg)
    draw = ImageDraw.Draw(img)
    cells = rng.choice([2, 3, 4])
    size = COVER_PX // cells
    for gx in range(cells):
        for gy in range(cells):
            x0, y0 = gx * size, gy * size
            col = hex_rgb(rng.choice(spec.palette[:3]))
            shape = rng.choice(["circle", "half", "quarter", "rect", "none", "tri"])
            if shape == "circle":
                draw.ellipse((x0 + 8, y0 + 8, x0 + size - 8, y0 + size - 8), fill=col)
            elif shape == "half":
                start = rng.choice([0, 90, 180, 270])
                draw.pieslice((x0, y0, x0 + size, y0 + size), start, start + 180, fill=col)
            elif shape == "quarter":
                corner = rng.choice([(x0, y0), (x0 - size, y0), (x0, y0 - size), (x0 - size, y0 - size)])
                draw.pieslice((corner[0], corner[1], corner[0] + 2 * size, corner[1] + 2 * size), 0, 360, fill=col)
            elif shape == "rect":
                draw.rectangle((x0, y0, x0 + size, y0 + size), fill=col)
            elif shape == "tri":
                draw.polygon([(x0, y0 + size), (x0 + size // 2, y0), (x0 + size, y0 + size)], fill=col)
    # Re-clip quarter circles that spilled over into neighbours: acceptable, reads as intentional overlap.
    draw.rectangle((0, COVER_PX - 96, COVER_PX, COVER_PX), fill=bg)
    _caption(draw, spec, hex_rgb(spec.palette[0]))
    return img


def style_stripes(spec: CoverSpec, rng: random.Random) -> Image.Image:
    img = Image.new("RGB", (COVER_PX * 2, COVER_PX * 2), hex_rgb(spec.palette[3]))
    draw = ImageDraw.Draw(img)
    width = rng.choice([18, 28, 40, 64])
    cols = [hex_rgb(c) for c in spec.palette[:3]]
    for i, x in enumerate(range(-COVER_PX * 2, COVER_PX * 4, width)):
        draw.rectangle((x, 0, x + width * rng.choice([0.5, 0.6, 0.8]), COVER_PX * 2), fill=cols[i % len(cols)])
    img = img.rotate(rng.choice([0, 30, 45, 60, 90, -30]), resample=Image.Resampling.BICUBIC)
    img = img.crop((COVER_PX // 2, COVER_PX // 2, COVER_PX // 2 + COVER_PX, COVER_PX // 2 + COVER_PX))
    draw = ImageDraw.Draw(img)
    band_y = rng.randint(380, 480)
    draw.rectangle((0, band_y, COVER_PX, band_y + 110), fill=hex_rgb(spec.palette[3]))
    f1 = text_fit(draw, spec.artist.upper(), "sans_bold", COVER_PX - 60, 40)
    f2 = text_fit(draw, spec.title, "serif_italic", COVER_PX - 60, 30)
    draw.text((30, band_y + 14), spec.artist.upper(), font=f1, fill=hex_rgb(spec.palette[0]))
    draw.text((30, band_y + 62), spec.title, font=f2, fill=hex_rgb(spec.palette[2]))
    return img


def style_swiss(spec: CoverSpec, rng: random.Random) -> Image.Image:
    bg = hex_rgb(spec.palette[3])
    img = Image.new("RGB", (COVER_PX, COVER_PX), bg)
    draw = ImageDraw.Draw(img)
    for _ in range(rng.randint(3, 7)):
        x = rng.randrange(0, COVER_PX, 40)
        y = rng.randrange(0, COVER_PX - 200, 40)
        w = rng.randrange(40, 360, 40)
        h = rng.randrange(20, 240, 20)
        draw.rectangle((x, y, x + w, y + h), fill=hex_rgb(rng.choice(spec.palette[:3])))
    for i in range(rng.randint(4, 9)):
        y = 40 + i * 22
        draw.line((40, y, 40 + rng.randint(80, 520), y), fill=hex_rgb(spec.palette[0]), width=3)
    f1 = font("sans_bold", rng.choice([54, 64, 80]))
    word = spec.title.split()[0].lower()
    draw.text((34, COVER_PX - 190), word, font=f1, fill=hex_rgb(spec.palette[0]))
    f2 = font("mono", 20)
    draw.text((38, COVER_PX - 70), spec.artist.lower(), font=f2, fill=hex_rgb(spec.palette[0]))
    draw.text((38, COVER_PX - 46), spec.title.lower(), font=f2, fill=hex_rgb(spec.palette[1]))
    return img


def style_type(spec: CoverSpec, rng: random.Random) -> Image.Image:
    bg = hex_rgb(spec.palette[rng.choice([0, 2])])
    fg = hex_rgb(spec.palette[3])
    img = Image.new("RGB", (COVER_PX, COVER_PX), bg)
    draw = ImageDraw.Draw(img)
    letters = "".join(w[0] for w in spec.artist.split() if w[0].isalpha())[:2].upper() or spec.artist[:1].upper()
    big = font("serif", 420 if len(letters) == 1 else 300)
    bbox = draw.textbbox((0, 0), letters, font=big)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((COVER_PX - w) / 2 - bbox[0], (COVER_PX - h) / 2 - bbox[1] - 30), letters, font=big, fill=fg)
    accent = hex_rgb(spec.palette[1])
    draw.rectangle((34, COVER_PX - 118, 34 + 90, COVER_PX - 110), fill=accent)
    _caption(draw, spec, fg)
    return img


def style_bokeh(spec: CoverSpec, rng: random.Random) -> Image.Image:
    base = hex_rgb(spec.palette[0])
    img = Image.new("RGB", (COVER_PX, COVER_PX), mix(base, (0, 0, 0), 0.55))
    layer = Image.new("RGBA", (COVER_PX, COVER_PX), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for _ in range(rng.randint(26, 60)):
        r = rng.randint(14, 80)
        x, y = rng.randint(-40, COVER_PX + 40), rng.randint(-40, COVER_PX + 40)
        c = hex_rgb(rng.choice(spec.palette))
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(*c, rng.randint(60, 170)))
    layer = layer.filter(ImageFilter.GaussianBlur(rng.uniform(4, 12)))
    img.paste(layer, (0, 0), layer)
    img = _grain(img, rng, 9)
    draw = ImageDraw.Draw(img)
    _caption(draw, spec, (240, 234, 222), position=rng.choice(["top", "bottom"]))
    return img


def style_duotone(spec: CoverSpec, rng: random.Random) -> Image.Image:
    dark, light = hex_rgb(spec.palette[rng.choice([0, 2])]), hex_rgb(spec.palette[3])
    field = Image.effect_mandelbrot(
        (COVER_PX, COVER_PX),
        (rng.uniform(-2.2, -0.5), rng.uniform(-1.2, -0.3), rng.uniform(0.3, 0.9), rng.uniform(0.4, 1.2)),
        rng.randint(40, 120),
    )
    field = field.filter(ImageFilter.GaussianBlur(rng.uniform(1.5, 6)))
    noise = Image.effect_noise((COVER_PX, COVER_PX), 60).filter(ImageFilter.GaussianBlur(2))
    field = Image.blend(field, noise, 0.25)
    lut_r = [int(dark[0] + (light[0] - dark[0]) * i / 255) for i in range(256)]
    lut_g = [int(dark[1] + (light[1] - dark[1]) * i / 255) for i in range(256)]
    lut_b = [int(dark[2] + (light[2] - dark[2]) * i / 255) for i in range(256)]
    img = Image.merge("RGB", (field.point(lut_r), field.point(lut_g), field.point(lut_b)))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, COVER_PX, 110), fill=hex_rgb(spec.palette[1]))
    f1 = text_fit(draw, spec.artist, "sans_bold", COVER_PX - 60, 44)
    draw.text((30, 18), spec.artist, font=f1, fill=light if spec.palette[1] != spec.palette[3] else dark)
    f2 = text_fit(draw, spec.title.upper(), "sans", COVER_PX - 60, 24)
    draw.text((30, 70), spec.title.upper(), font=f2, fill=dark)
    return img


def style_rings(spec: CoverSpec, rng: random.Random) -> Image.Image:
    bg = hex_rgb(spec.palette[3])
    img = Image.new("RGB", (COVER_PX, COVER_PX), bg)
    draw = ImageDraw.Draw(img)
    cx, cy = rng.randint(220, 420), rng.randint(200, 380)
    cols = [hex_rgb(c) for c in spec.palette[:3]]
    r = rng.randint(260, 420)
    i = 0
    while r > 10:
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=cols[i % len(cols)])
        r -= rng.randint(18, 60)
        i += 1
    draw.rectangle((0, COVER_PX - 100, COVER_PX, COVER_PX), fill=bg)
    _caption(draw, spec, cols[0])
    return img


def style_mono_photo(spec: CoverSpec, rng: random.Random) -> Image.Image:
    field = Image.effect_noise((COVER_PX // 8, COVER_PX // 8), 90).resize((COVER_PX, COVER_PX), Image.Resampling.BICUBIC)
    field = field.filter(ImageFilter.GaussianBlur(rng.uniform(3, 10)))
    grad = Image.linear_gradient("L").resize((COVER_PX, COVER_PX)).rotate(rng.choice([0, 90, 180, 270]))
    field = Image.blend(field, grad, 0.45)
    img = Image.merge("RGB", (field, field, field))
    img = _grain(img, rng, 14)
    draw = ImageDraw.Draw(img)
    if rng.random() < 0.5:
        draw.rectangle((24, 24, COVER_PX - 24, COVER_PX - 24), outline=(236, 236, 236), width=3)
    _caption(draw, spec, (238, 238, 238), position=rng.choice(["top", "bottom"]), kind="serif")
    return img


def style_split(spec: CoverSpec, rng: random.Random) -> Image.Image:
    img = Image.new("RGB", (COVER_PX, COVER_PX), hex_rgb(spec.palette[0]))
    draw = ImageDraw.Draw(img)
    split = rng.randint(220, 420)
    if rng.random() < 0.5:
        draw.rectangle((0, split, COVER_PX, COVER_PX), fill=hex_rgb(spec.palette[1]))
    else:
        draw.polygon([(0, COVER_PX), (COVER_PX, split), (COVER_PX, COVER_PX)], fill=hex_rgb(spec.palette[1]))
    r = rng.randint(50, 110)
    cx, cy = rng.randint(120, 520), split - rng.randint(-40, 60)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=hex_rgb(spec.palette[2]))
    _caption(draw, spec, hex_rgb(spec.palette[3]), position="top")
    return img


def style_label_grid(spec: CoverSpec, rng: random.Random) -> Image.Image:
    """A 'house style' sleeve, like a jazz label with a colour block and big lowercase title."""
    img = Image.new("RGB", (COVER_PX, COVER_PX), (18, 18, 20))
    draw = ImageDraw.Draw(img)
    block = hex_rgb(spec.palette[rng.choice([0, 1, 2])])
    top = rng.randint(140, 300)
    draw.rectangle((0, top, COVER_PX, top + rng.randint(160, 260)), fill=block)
    f = text_fit(draw, spec.title.lower(), "sans_bold", COVER_PX - 60, 96)
    draw.text((30, top - 110), spec.title.lower(), font=f, fill=(240, 236, 226))
    f2 = font("sans", 26)
    draw.text((32, COVER_PX - 70), spec.artist, font=f2, fill=block)
    return img


STYLES = {
    "gradient": style_gradient,
    "bauhaus": style_bauhaus,
    "stripes": style_stripes,
    "swiss": style_swiss,
    "type": style_type,
    "bokeh": style_bokeh,
    "duotone": style_duotone,
    "rings": style_rings,
    "mono": style_mono_photo,
    "split": style_split,
    "label": style_label_grid,
}
GENRE_STYLES = {
    "jazz": ["label", "duotone", "type", "mono", "split"],
    "electronic": ["stripes", "swiss", "gradient", "rings", "bokeh"],
    "classical": ["type", "mono", "gradient", "swiss"],
    "ambient": ["gradient", "bokeh", "rings", "duotone"],
    "hiphop": ["type", "duotone", "bokeh", "split"],
}


def render_cover(spec: CoverSpec) -> Image.Image:
    rng = random.Random(spec.seed)
    return STYLES[spec.style](spec, rng)


# --- library ----------------------------------------------------------------------------------------


def _artist_name(rng: random.Random, genre: str) -> str:
    kind = rng.random()
    if genre in ("jazz", "classical") and kind < 0.45:
        return f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(ENSEMBLE)}"
    if genre in ("electronic", "hiphop", "ambient") and kind < 0.55:
        alias = rng.choice(ALIAS)
        return alias if rng.random() < 0.6 else f"{alias} & {rng.choice(FIRST)}"
    if kind < 0.45:
        return f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    if kind < 0.8:
        return f"The {rng.choice(ADJ)} {rng.choice(NOUN_PL)}"
    return f"{rng.choice(ADJ)} {rng.choice(NOUN)}"


def _album_title(rng: random.Random, genre: str, kind: str) -> str:
    if kind == "compilation":
        return rng.choice(["Greatest Hits", "Anthology", "The Singles", "Collected", "Rarities & B-Sides", "Best Of"])
    r = rng.random()
    if r < 0.12:
        return f"Live at {rng.choice(PLACES)}"
    if r < 0.35:
        return f"{rng.choice(ADJ)} {rng.choice(NOUN)}"
    if r < 0.5:
        return f"Songs for the {rng.choice(['Late', 'Early', 'Long', 'Quiet', 'Lost'])} {rng.choice(['Hours', 'Years', 'Rooms', 'Trains', 'Summers'])}"
    if r < 0.62:
        return rng.choice(NOUN)
    if r < 0.72:
        return f"{rng.choice(NOUN)} {rng.choice(['I', 'II', 'III', 'Vol. 2', '(Reprise)'])}"
    if r < 0.85:
        return f"The {rng.choice(NOUN)} {rng.choice(['Sessions', 'Tapes', 'Suite', 'Recordings'])}"
    return f"{rng.choice(NOUN)} & {rng.choice(NOUN)}"


def _tracks(rng: random.Random, kind: str, genre: str) -> list[dict]:
    count = {"single": rng.randint(1, 4), "compilation": rng.randint(14, 22)}.get(kind, rng.randint(6, 13))
    long_form = genre in ("jazz", "classical", "ambient")
    tracks = []
    for n in range(1, count + 1):
        words = rng.sample(TRACK_WORDS, rng.randint(1, 3))
        title = " ".join(w if i and w in ("for", "the") else w.capitalize() for i, w in enumerate(words))
        dur = rng.randint(330, 720) if long_form else rng.randint(150, 330)
        tracks.append({"n": n, "title": title, "durationMs": dur * 1000 + rng.randint(0, 999)})
    return tracks


def generate(out_dir: Path, count: int = 300, seed: int = 42, *, verbose: bool = True) -> list[dict]:
    rng = random.Random(seed)
    genre_map = GenreMap.load()
    genres = list(GENRE_WEIGHTS)
    weights = [GENRE_WEIGHTS[g] for g in genres]

    # Artists with a few albums each (power-law-ish), which exercises dividers and multi-album grouping.
    artists: list[dict] = []
    albums: list[dict] = []
    used_titles: set[tuple[str, str]] = set()
    now = datetime(2026, 9, 29, 21, 0, tzinfo=UTC)
    earliest_add = datetime(2015, 3, 1, tzinfo=UTC)
    while len(albums) < count:
        genre = rng.choices(genres, weights)[0]
        name = _artist_name(rng, genre)
        if any(a["name"] == name for a in artists):
            continue
        artist = {
            "id": spotify_like_id(rng),
            "name": name,
            "genre": genre,
            "raw": rng.sample(MICRO[genre], k=min(len(MICRO[genre]), rng.randint(1, 3))),
            "label": rng.choice(LABELS),
        }
        if rng.random() < 0.18:  # some artists cross over into a second macro genre
            other = rng.choices(genres, weights)[0]
            artist["raw"].append(rng.choice(MICRO[other]))
        artists.append(artist)
        start_lo, start_hi = GENRE_ERA[genre]
        start = rng.randint(start_lo, start_hi)
        n_albums = min(count - len(albums), rng.choices([1, 2, 3, 4, 5], [40, 25, 16, 11, 8])[0])
        palette_bias = rng.randrange(len(PALETTES))
        for k in range(n_albums):
            kind = rng.choices(["album", "single", "compilation"], [80, 12, 8])[0]
            title = _album_title(rng, genre, kind)
            if (name, title) in used_titles:
                title = f"{title} {rng.choice(['II', 'III', 'Revisited'])}"
            used_titles.add((name, title))
            year = min(2026, start + k * rng.randint(1, 6) + (rng.randint(8, 25) if kind == "compilation" else 0))
            month, day = rng.randint(1, 12), rng.randint(1, 28)
            added = earliest_add + timedelta(seconds=rng.randint(0, int((now - earliest_add).total_seconds())))
            tracks = _tracks(rng, kind, genre)
            album_id = spotify_like_id(rng)
            # Guest appearances make "album matches if any artist matches" meaningful.
            credits = [{"id": artist["id"], "name": name}]
            if len(artists) > 3 and rng.random() < 0.08:
                guest = rng.choice(artists[:-1])
                credits.append({"id": guest["id"], "name": guest["name"]})
            raw = sorted(set(artist["raw"] + [r for c in credits[1:] for r in next(a["raw"] for a in artists if a["id"] == c["id"])]))

            mono = rng.random() < 0.07
            pal = rng.choice(MONO_PALETTES) if mono else PALETTES[(palette_bias + rng.choice([0, 0, 1, 2, 5, 11])) % len(PALETTES)]
            pal = pal[:]
            if not mono:
                rng.shuffle(pal)
            style = "mono" if mono else rng.choice(GENRE_STYLES.get(genre, list(k for k in STYLES if k != "mono")))
            spec = CoverSpec(artist=name, title=title, palette=pal, style=style, seed=rng.randint(0, 2**31))
            img = render_cover(spec)
            write_cover_variants(out_dir, album_id, img)
            palette = extract_palette(img)

            album = {
                "id": album_id,
                "uri": f"spotify:album:{album_id}",
                "title": title,
                "artists": credits,
                "year": year,
                "releaseDate": f"{year:04d}-{month:02d}-{day:02d}",
                "addedAt": added.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                "type": kind,
                "label": None if rng.random() < 0.1 else artist["label"],
                "totalTracks": len(tracks),
                "durationMs": sum(t["durationMs"] for t in tracks),
                "genres": genre_map.map_many(raw),
                "genresRaw": raw,
                "cover": cover_paths(album_id),
                "palette": palette.to_json(),
                "tracks": tracks if rng.random() > 0.08 else None,
            }
            if album["tracks"] is None:
                del album["tracks"]
            albums.append(album)
            if verbose and len(albums) % 50 == 0:
                print(f"  {len(albums)}/{count} albums")
    return albums
