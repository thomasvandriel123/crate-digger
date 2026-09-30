from PIL import Image, ImageDraw

from ingest.oklab import hex_to_rgb, oklab_to_srgb, srgb_to_oklab, to_hex
from ingest.palette import extract_palette


def test_oklab_round_trip():
    for colour in ("#000000", "#ffffff", "#ff0000", "#3a2a22", "#6f86a8", "#ffb266"):
        rgb = hex_to_rgb(colour)
        assert to_hex(oklab_to_srgb(srgb_to_oklab(rgb))) == colour


def test_solid_colour_is_dominant():
    p = extract_palette(Image.new("RGB", (100, 100), (200, 40, 40)))
    assert p.mono is False
    r, g, b = hex_to_rgb(p.dominant)
    assert r > 0.7 and g < 0.3 and b < 0.3
    assert 0 <= p.hue < 60 or p.hue > 330
    assert len(p.swatches) == 3


def test_greyscale_cover_is_mono():
    img = Image.linear_gradient("L").resize((128, 128)).convert("RGB")
    p = extract_palette(img)
    assert p.mono is True


def test_vivid_shape_beats_grey_field():
    img = Image.new("RGB", (100, 100), (128, 128, 128))
    ImageDraw.Draw(img).rectangle((0, 0, 45, 100), fill=(20, 60, 220))  # ~45% blue
    p = extract_palette(img)
    r, g, b = hex_to_rgb(p.dominant)
    assert b > r and b > g, p


def test_palette_is_deterministic():
    img = Image.effect_mandelbrot((96, 96), (-2, -1.2, 0.6, 1.2), 60).convert("RGB")
    assert extract_palette(img) == extract_palette(img)
