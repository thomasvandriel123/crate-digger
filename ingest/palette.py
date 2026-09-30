"""Cover palette extraction.

Downsample to 64 px, cluster in OKLab with a small deterministic k-means, and pick the dominant colour by
chroma-weighted cluster size, so a vivid shape on a grey field wins over the grey field, but a large
calm cover is not overruled by a speck of colour. Also flags near-greyscale covers as ``mono``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from PIL import Image

from .oklab import lab_to_lch, oklab_to_srgb, srgb_to_oklab, to_hex

SAMPLE_SIZE = 64
K = 6
ITERATIONS = 14
MONO_CHROMA = 0.028  # mean OKLCH chroma below which a cover reads as black-and-white
CHROMA_BIAS = 0.03  # keeps greys in the running; without it chroma alone would always win
MIN_SWATCH_DISTANCE = 0.08  # OKLab distance between reported swatches


@dataclass(frozen=True)
class Palette:
    dominant: str
    swatches: list[str]
    hue: float
    chroma: float
    lightness: float
    mono: bool

    def to_json(self) -> dict:
        data = asdict(self)
        data["hue"] = round(self.hue, 1)
        data["chroma"] = round(self.chroma, 4)
        data["lightness"] = round(self.lightness, 4)
        return data


def _kmeans(points: np.ndarray, k: int, iterations: int, seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic k-means++ in OKLab. Returns (centroids, labels)."""
    rng = np.random.default_rng(seed)
    n = len(points)
    k = min(k, n)
    centroids = [points[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min(((points[:, None, :] - np.array(centroids)[None, :, :]) ** 2).sum(-1), axis=1)
        total = d2.sum()
        if total <= 1e-12:
            break
        centroids.append(points[rng.choice(n, p=d2 / total)])
    c = np.array(centroids)
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iterations):
        dist = ((points[:, None, :] - c[None, :, :]) ** 2).sum(-1)
        labels = dist.argmin(axis=1)
        new_c = np.array([points[labels == j].mean(axis=0) if np.any(labels == j) else c[j] for j in range(len(c))])
        if np.allclose(new_c, c, atol=1e-6):
            break
        c = new_c
    return c, labels


def extract_palette(image: Image.Image) -> Palette:
    img = image.convert("RGB").resize((SAMPLE_SIZE, SAMPLE_SIZE), Image.Resampling.BOX)
    rgb = np.asarray(img, dtype=np.float64).reshape(-1, 3) / 255.0
    lab = srgb_to_oklab(rgb)

    pixel_chroma = np.hypot(lab[:, 1], lab[:, 2])
    mono = bool(pixel_chroma.mean() < MONO_CHROMA)

    centroids, labels = _kmeans(lab, K, ITERATIONS)
    sizes = np.bincount(labels, minlength=len(centroids)) / len(labels)
    chroma = np.hypot(centroids[:, 1], centroids[:, 2])
    score = sizes * (chroma + CHROMA_BIAS)
    if mono:
        # For greyscale covers the biggest tone is the honest "dominant" colour.
        score = sizes
    order = np.argsort(-score)

    picked: list[np.ndarray] = []
    for idx in order:
        if sizes[idx] <= 0:
            continue
        candidate = centroids[idx]
        if all(np.linalg.norm(candidate - p) >= MIN_SWATCH_DISTANCE for p in picked):
            picked.append(candidate)
        if len(picked) == 3:
            break
    # Pad with the remaining clusters by size if the cover is very uniform.
    for idx in np.argsort(-sizes):
        if len(picked) == 3:
            break
        if not any(np.allclose(centroids[idx], p) for p in picked):
            picked.append(centroids[idx])
    while len(picked) < 3:
        picked.append(picked[-1])

    dominant = picked[0]
    lightness, chroma_d, hue = lab_to_lch(dominant)
    return Palette(
        dominant=to_hex(oklab_to_srgb(dominant)),
        swatches=[to_hex(oklab_to_srgb(p)) for p in picked],
        hue=hue,
        chroma=chroma_d,
        lightness=lightness,
        mono=mono,
    )
