"""Texture conversion for the web build.

FlightGear textures come as PNG, JPEG, DDS (DXT-compressed) and SGI .rgb
files.  Browsers need PNG/JPEG/WebP, so everything is converted to WebP
(lossy for opaque images, lossless-alpha when the image has transparency)
and optionally downscaled to keep the download small.
"""

import os

from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def _has_alpha(img):
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        alpha = img.convert("RGBA").getchannel("A")
        lo, _hi = alpha.getextrema()
        return lo < 255
    return False


def convert_texture(src, dst, max_size=1024, quality=85):
    """Converts src to a WebP at dst.  Returns True on success."""
    if os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return True
    try:
        img = Image.open(src)
        img.load()
    except Exception as exc:  # unsupported/corrupt image: skip it
        print(f"warning: cannot read texture {src}: {exc}")
        return False
    alpha = _has_alpha(img)
    img = img.convert("RGBA" if alpha else "RGB")
    w, h = img.size
    scale = min(1.0, max_size / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img.save(dst, "WEBP", quality=quality, method=6, exact=alpha)
    return True
