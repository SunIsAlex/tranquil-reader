#!/usr/bin/env python3
# Create a small shelf thumbnail for a large book cover.
#
# Recommended manifest:
#   "cover": "cover.png",
#   "coverThumb": "cover-thumb.webp"
#
# Usage:
#   python tools/make_cover_thumb.py books/zhongguo2185/cover.png
#   python tools/make_cover_thumb.py books/shanyangrenlei/cover.png --out books/shanyangrenlei/cover-thumb.webp
#
# Termux:
#   pkg install python-pillow
# or:
#   pkg install imagemagick

import argparse
import shutil
import subprocess
from pathlib import Path


def make_with_pillow(src, out, width, height, quality):
    try:
        from PIL import Image
    except Exception:
        return False

    img = Image.open(src).convert("RGB")
    sw, sh = img.size
    tr = width / height
    sr = sw / sh

    if sr > tr:
        nw = int(sh * tr)
        left = (sw - nw) // 2
        img = img.crop((left, 0, left + nw, sh))
    elif sr < tr:
        nh = int(sw / tr)
        top = (sh - nh) // 2
        img = img.crop((0, top, sw, top + nh))

    img = img.resize((width, height), Image.LANCZOS)

    if out.suffix.lower() == ".webp":
        img.save(out, format="WEBP", quality=quality, method=6)
    elif out.suffix.lower() in {".jpg", ".jpeg"}:
        img.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
    else:
        img.save(out, optimize=True)
    return True


def make_with_imagemagick(src, out, width, height, quality):
    exe = shutil.which("magick") or shutil.which("convert")
    if not exe:
        return False

    subprocess.run([
        exe, str(src),
        "-resize", f"{width}x{height}^",
        "-gravity", "center",
        "-extent", f"{width}x{height}",
        "-strip",
        "-quality", str(quality),
        str(out),
    ], check=True)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cover", help="Input full-size cover image")
    parser.add_argument("--out", default="", help="Output thumbnail path")
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--quality", type=int, default=78)
    args = parser.parse_args()

    src = Path(args.cover)
    if not src.exists():
        raise SystemExit(f"Input not found: {src}")

    out = Path(args.out) if args.out else src.with_name("cover-thumb.webp")
    out.parent.mkdir(parents=True, exist_ok=True)

    if make_with_pillow(src, out, args.width, args.height, args.quality):
        print(f"wrote {out}")
        return

    if make_with_imagemagick(src, out, args.width, args.height, args.quality):
        print(f"wrote {out}")
        return

    raise SystemExit(
        "No image backend found. Install one of these in Termux:\n"
        "  pkg install python-pillow\n"
        "or:\n"
        "  pkg install imagemagick"
    )


if __name__ == "__main__":
    main()
