"""Cover images: download the largest source, write 512 px and 256 px WebP, optional KTX2.

KTX2 (Basis Universal) needs the `toktx` CLI from KTX-Software on PATH. When it is missing the
viewer simply keeps using WebP, so the variant is strictly optional.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests
from PIL import Image

from .palette import Palette, extract_palette

SIZES = {"512": 512, "256": 256}
WEBP_QUALITY = {"512": 84, "256": 80}


def ktx2_available() -> bool:
    return shutil.which("toktx") is not None


def cover_exists(data_dir: Path, album_id: str) -> bool:
    return all((data_dir / "covers" / key / f"{album_id}.webp").exists() for key in SIZES)


def write_cover_variants(data_dir: Path, album_id: str, image: Image.Image, *, ktx2: bool = False) -> bool:
    """Writes WebP variants (and KTX2 if requested and possible). Returns True if KTX2 was written."""
    rgb = image.convert("RGB")
    if rgb.width != rgb.height:
        side = min(rgb.size)
        left = (rgb.width - side) // 2
        top = (rgb.height - side) // 2
        rgb = rgb.crop((left, top, left + side, top + side))
    for key, size in SIZES.items():
        out = data_dir / "covers" / key / f"{album_id}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        resized = rgb.resize((size, size), Image.Resampling.LANCZOS)
        tmp = out.with_suffix(".webp.tmp")
        resized.save(tmp, "WEBP", quality=WEBP_QUALITY[key], method=6)
        tmp.replace(out)
    if ktx2 and ktx2_available():
        return _write_ktx2(data_dir, album_id, rgb)
    return False


def _write_ktx2(data_dir: Path, album_id: str, rgb: Image.Image) -> bool:
    out = data_dir / "covers" / "ktx2" / f"{album_id}.ktx2"
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "cover.png"
        rgb.resize((512, 512), Image.Resampling.LANCZOS).save(png)
        cmd = [
            "toktx",
            "--t2",
            "--encode",
            "etc1s",
            "--clevel",
            "2",
            "--qlevel",
            "160",
            "--genmipmap",
            "--assign_oetf",
            "srgb",
            str(out),
            str(png),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        return result.returncode == 0 and out.exists()


def download_image(session: requests.Session, url: str, timeout: float = 30.0) -> Image.Image:
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content))
    img.load()
    return img


def load_cover(data_dir: Path, album_id: str) -> Image.Image | None:
    path = data_dir / "covers" / "512" / f"{album_id}.webp"
    if not path.exists():
        return None
    with Image.open(path) as img:
        img.load()
        return img.copy()


def process_cover(
    session: requests.Session,
    data_dir: Path,
    album_id: str,
    url: str | None,
    *,
    ktx2: bool = False,
    force: bool = False,
) -> tuple[Palette | None, bool]:
    """Ensure cover files exist and return (palette, ktx2_written). Palette is None if no image at all."""
    if not force and cover_exists(data_dir, album_id):
        img = load_cover(data_dir, album_id)
        has_ktx2 = (data_dir / "covers" / "ktx2" / f"{album_id}.ktx2").exists()
        if ktx2 and not has_ktx2 and img is not None:
            has_ktx2 = _write_ktx2(data_dir, album_id, img) if ktx2_available() else False
        return (extract_palette(img) if img else None), has_ktx2
    if not url:
        return None, False
    img = download_image(session, url)
    wrote_ktx2 = write_cover_variants(data_dir, album_id, img, ktx2=ktx2)
    return extract_palette(img), wrote_ktx2
