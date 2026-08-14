#!/usr/bin/env python3
"""Build the deployable static site into site/.

The repo's round-trip overlays are full 600-DPI page scans (5400x3600 PNG,
~450 KB each, 150 MB total) — far too heavy to serve.  They are resized to
2400 px wide WebP (~90 KB), which still resolves the individual traced dots
against the printed ink, the whole point of the validation image.

Everything else is copied as-is; the viewer's overlay reference is rewritten
from .png to .webp.  Run from the repo root:  python3 build_site.py
"""
import csv
import glob
import json
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
DST_SCAN = os.path.join(SITE, "scans")
PAGES = os.path.expanduser("~/onepager/berlman_digitization/berlman_run600/pages")

WIDTH = 2400
QUALITY = 88
SCAN_WIDTH = 2000      # clean scan behind the browser editor
SCAN_QUALITY = 82

# injected into the viewer's compound-select handler by the build
DL_WIRE = """  {
    const dc = document.getElementById('dlCsvBtn');
    const dx = document.getElementById('dlXlsxBtn');
    if (dc) dc.href = 'downloads/csv/' + d.graph + '.csv';
    if (dx) dx.href = 'downloads/xlsx/' + d.graph + '.xlsx';
  }"""


def _webp(src, dst, width, quality):
    im = cv2.imread(src)
    if im is None:
        return 0
    h, w = im.shape[:2]
    if w > width:
        im = cv2.resize(im, (width, int(round(h * width / w))),
                        interpolation=cv2.INTER_AREA)
    cv2.imwrite(dst, im, [cv2.IMWRITE_WEBP_QUALITY, quality])
    return os.path.getsize(dst)


def convert(name):
    return (name, _webp(os.path.join(SRC_OVL, name),
                        os.path.join(DST_OVL, name[:-4] + ".webp"), WIDTH, QUALITY))


def convert_scan(gid):
    """Clean page scan for the editor — the overlay has dots burned in, so
    erasing one there would leave it visible."""
    src = os.path.join(PAGES, gid + ".png")
    if not os.path.exists(src):
        return (gid, 0)
    return (gid, _webp(src, os.path.join(DST_SCAN, gid + ".webp"),
                       SCAN_WIDTH, SCAN_QUALITY))


def build_downloads(spectra, order):
    """Per-compound CSV + Excel, plus the master index, under downloads/.
    Named by graph id so the pages can link them without a manifest."""
    csv_dir = os.path.join(SITE, "downloads", "csv")
    xlsx_dir = os.path.join(SITE, "downloads", "xlsx")
    os.makedirs(csv_dir, exist_ok=True)
    os.makedirs(xlsx_dir, exist_ok=True)

    for gid in order:
        s = spectra[gid]
        em, ab = s.get("em", {}), s.get("ab", {})
        ew, ei = em.get("wl", []), em.get("inten", [])
        aw, ai = ab.get("wl", []), ab.get("inten", [])
        with open(os.path.join(csv_dir, gid + ".csv"), "w", newline="") as fp:
            w = csv.writer(fp)
            w.writerow([f"{s.get('name', gid)} — Berlman {gid}"])
            w.writerow(["emission_wavelength_nm", "emission_intensity",
                        "absorption_wavelength_nm", "absorption_intensity"])
            for i in range(max(len(ew), len(aw))):
                w.writerow([
                    f"{ew[i]:.1f}" if i < len(ew) else "",
                    f"{ei[i]:.6f}" if i < len(ei) else "",
                    f"{aw[i]:.1f}" if i < len(aw) else "",
                    f"{ai[i]:.6f}" if i < len(ai) else "",
                ])

    copied = 0
    for gid in order:
        src = glob.glob(os.path.join(ROOT, "data", "spectra", f"*__{gid}.xlsx"))
        if src:
            shutil.copy(src[0], os.path.join(xlsx_dir, gid + ".xlsx"))
            copied += 1
    master = os.path.join(ROOT, "data", "Berlman_Master_Index.xlsx")
    if os.path.exists(master):
        shutil.copy(master, os.path.join(SITE, "downloads", "Berlman_Master_Index.xlsx"))
    print(f"  downloads: {len(order)} CSV, {copied} XLSX, master index")


def build_data(spectra, order):
    """Editor payloads: a small index, per-compound data fetched on demand,
    and the frame geometry that maps intensity back to a pixel row."""
    d = os.path.join(SITE, "data")
    os.makedirs(os.path.join(d, "sp"), exist_ok=True)
    idx = [{"gid": g, "name": spectra[g].get("name", g), "f1": spectra[g].get("f1")}
           for g in order]
    with open(os.path.join(d, "index.json"), "w") as f:
        json.dump(idx, f, separators=(",", ":"))
    for gid in order:
        s = spectra[gid]
        payload = {k: s[k] for k in ("name", "f1", "xcal", "em", "ab") if k in s}
        payload["graph"] = gid
        with open(os.path.join(d, "sp", gid + ".json"), "w") as f:
            json.dump(payload, f, separators=(",", ":"))
    frames_src = os.path.join(ROOT, "data", "frames.json")
    if not os.path.exists(frames_src):
        raise SystemExit("data/frames.json missing — run: python3 build_frames.py")
    shutil.copy(frames_src, os.path.join(d, "frames.json"))
    print(f"  data: index + {len(order)} per-compound payloads + frames")


def main():
    shutil.rmtree(SITE, ignore_errors=True)
    os.makedirs(DST_OVL, exist_ok=True)
    os.makedirs(DST_SCAN, exist_ok=True)

    with open(os.path.join(ROOT, "data", "spectra_all.json")) as f:
        raw = json.load(f)
    spectra, order = raw["spectra"], raw["order"]

    names = sorted(n for n in os.listdir(SRC_OVL) if n.endswith(".png"))
    print(f"converting {len(names)} overlays -> {WIDTH}px WebP q{QUALITY}")
    with Pool(8) as pool:
        results = pool.map(convert, names)
    total = sum(sz for _, sz in results)
    failed = [n for n, sz in results if sz == 0]
    print(f"  {len(results) - len(failed)} written, {total / 1e6:.1f} MB"
          + (f", FAILED: {failed}" if failed else ""))

    print(f"converting {len(order)} clean scans -> {SCAN_WIDTH}px WebP q{SCAN_QUALITY}")
    with Pool(8) as pool:
        sres = pool.map(convert_scan, order)
    stotal = sum(sz for _, sz in sres)
    sfailed = [g for g, sz in sres if sz == 0]
    print(f"  {len(sres) - len(sfailed)} written, {stotal / 1e6:.1f} MB"
          + (f", MISSING: {sfailed}" if sfailed else ""))

    build_data(spectra, order)
    build_downloads(spectra, order)

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

        if page == "index.html":
            # Edit -> the browser editor (the source build points at the local
            # app on :8770 and hides itself off-localhost)
            old_edit = ("  editBtn.href = 'http://localhost:8770/?gid=' + d.graph;\n"
                        "  editBtn.style.display =\n"
                        "    (['localhost', '127.0.0.1'].includes(location.hostname)) "
                        "? 'inline-block' : 'none';")
            new_edit = ("  editBtn.href = 'editor.html?gid=' + d.graph;\n"
                        "  editBtn.removeAttribute('target');\n"
                        "  editBtn.style.display = 'inline-block';")
            if old_edit not in html:
                raise SystemExit("index.html: edit-button block not found — "
                                 "the rewrite needs updating")
            html = html.replace(old_edit, new_edit)

            # Downloads -> real per-compound files
            old_dl = '<span class="pcc-btn pcc-btn-dl">Downloads</span>'
            new_dl = ('<a id="dlCsvBtn" class="pcc-btn pcc-btn-dl" download '
                      'style="text-decoration:none">&#8681; CSV</a>'
                      '<a id="dlXlsxBtn" class="pcc-btn pcc-btn-dl" download '
                      'style="text-decoration:none">&#8681; Excel</a>')
            if old_dl not in html:
                raise SystemExit("index.html: Downloads button not found")
            html = html.replace(old_dl, new_dl)
            html = html.replace(new_edit, new_edit + "\n" + DL_WIRE)

        with open(os.path.join(SITE, page), "w", encoding="utf-8") as f:
            f.write(html)
        print(f"  {page}: {n} overlay refs -> .webp "
              f"({os.path.getsize(os.path.join(SITE, page)) / 1e6:.1f} MB)")

    for extra in ("vercel.json", "editor.html", "editor.js"):
        p = os.path.join(ROOT, extra)
        if os.path.exists(p):
            shutil.copy(p, os.path.join(SITE, extra))

    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(SITE) for f in fs)
    print(f"site/ built: {size / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
