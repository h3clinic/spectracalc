#!/usr/bin/env python3
"""Build the deployable static site into site/.

The repo's round-trip overlays are full 600-DPI page scans (5400x3600 PNG,
~450 KB each, 150 MB total) — far too heavy to serve.  They are resized to
2400 px wide WebP (~90 KB), which still resolves the individual traced dots
against the printed ink, the whole point of the validation image.

Everything else is copied as-is; the viewer's overlay reference is rewritten
from .png to .webp.  Run from the repo root:  python3 build_site.py
"""
import os
import re
import shutil
import sys
from multiprocessing import Pool

import cv2

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site")
SRC_OVL = os.path.join(ROOT, "overlays")
DST_OVL = os.path.join(SITE, "overlays")

WIDTH = 2400
QUALITY = 88


def convert(name):
    src = os.path.join(SRC_OVL, name)
    dst = os.path.join(DST_OVL, name[:-4] + ".webp")
    im = cv2.imread(src)
    if im is None:
        return (name, 0)
    h, w = im.shape[:2]
    if w > WIDTH:
        im = cv2.resize(im, (WIDTH, int(round(h * WIDTH / w))),
                        interpolation=cv2.INTER_AREA)
    cv2.imwrite(dst, im, [cv2.IMWRITE_WEBP_QUALITY, QUALITY])
    return (name, os.path.getsize(dst))


def main():
    shutil.rmtree(SITE, ignore_errors=True)
    os.makedirs(DST_OVL, exist_ok=True)

    names = sorted(n for n in os.listdir(SRC_OVL) if n.endswith(".png"))
    print(f"converting {len(names)} overlays -> {WIDTH}px WebP q{QUALITY}")
    with Pool(8) as pool:
        results = pool.map(convert, names)
    total = sum(sz for _, sz in results)
    failed = [n for n, sz in results if sz == 0]
    print(f"  {len(results) - len(failed)} written, {total / 1e6:.1f} MB"
          + (f", FAILED: {failed}" if failed else ""))

    # pages — point them at the built WebP.  Every .png in either page is an
    # overlay reference (the viewer's candidate list, the gallery's filename
    # table and its two .replace('.png','') label calls), so a blanket swap
    # is exactly right — asserted below so a future .png can't slip through.
    for page in ("index.html", "gallery.html"):
        with open(os.path.join(ROOT, page), encoding="utf-8") as f:
            html = f.read()
        n = html.count(".png")
        # every legitimate hit is one of: an overlays/ path, a graph-NNN.png
        # filename in the gallery table, or a .replace('.png','') that strips
        # the extension off one of those filenames for a label
        stray = []
        for m in re.finditer(r"\.png", html):
            before = html[max(0, m.start() - 120):m.start()]
            if ("overlay" in before.lower()
                    or "graph-" in html[max(0, m.start() - 40):m.start()]
                    or before.endswith("replace('") or before.endswith('replace("')):
                continue
            stray.append(m.start())
        if stray:
            raise SystemExit(f"{page}: {len(stray)} non-overlay .png reference(s) "
                             f"— blanket rewrite would corrupt them")
        html = html.replace(".png", ".webp")
        with open(os.path.join(SITE, page), "w", encoding="utf-8") as f:
            f.write(html)
        print(f"  {page}: {n} overlay refs -> .webp "
              f"({os.path.getsize(os.path.join(SITE, page)) / 1e6:.1f} MB)")

    for extra in ("vercel.json", "README.md"):
        p = os.path.join(ROOT, extra)
        if os.path.exists(p):
            shutil.copy(p, os.path.join(SITE, extra))

    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(SITE) for f in fs)
    print(f"site/ built: {size / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
