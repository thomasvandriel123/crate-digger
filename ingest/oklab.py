"""sRGB <-> OKLab / OKLCH conversions (Björn Ottosson, 2020), vectorised with numpy."""

from __future__ import annotations

import math

import numpy as np

_M1 = np.array(
    [
        [0.4122214708, 0.5363325363, 0.0514459929],
        [0.2119034982, 0.6806995451, 0.1073969566],
        [0.0883024619, 0.2817188376, 0.6299787005],
    ]
)
_M2 = np.array(
    [
        [0.2104542553, 0.7936177850, -0.0040720468],
        [1.9779984951, -2.4285922050, 0.4505937099],
        [0.0259040371, 0.7827717662, -0.8086757660],
    ]
)
_M2_INV = np.linalg.inv(_M2)
_M1_INV = np.linalg.inv(_M1)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """Gamma-encoded sRGB in [0, 1] to linear light."""
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(c, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """rgb: (..., 3) array of gamma-encoded sRGB in [0, 1]. Returns (..., 3) OKLab."""
    lin = srgb_to_linear(rgb)
    lms = lin @ _M1.T
    lms_ = np.cbrt(lms)
    return lms_ @ _M2.T


def oklab_to_srgb(lab: np.ndarray) -> np.ndarray:
    lms_ = np.asarray(lab, dtype=np.float64) @ _M2_INV.T
    lms = lms_**3
    lin = lms @ _M1_INV.T
    return linear_to_srgb(lin)


def lab_to_lch(lab: np.ndarray) -> tuple[float, float, float]:
    """Single OKLab colour to (lightness, chroma, hue in degrees [0, 360))."""
    lightness, a, b = (float(x) for x in lab)
    chroma = math.hypot(a, b)
    hue = math.degrees(math.atan2(b, a)) % 360.0
    return lightness, chroma, hue


def to_hex(rgb: np.ndarray) -> str:
    r, g, b = (round(float(x) * 255) for x in np.clip(rgb, 0, 1))
    return f"#{r:02x}{g:02x}{b:02x}"


def hex_to_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)])
