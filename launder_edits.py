#!/usr/bin/env python3
"""Re-seat already-published community edits on the printed ink.

Every stored edit was saved from the editor's `derived` copy, which used to be
rescaled so each curve's peak read exactly 1.00.  That is a global scaling, so
the stored intensities sit above the printed stroke in proportion to their own
height — most at the apex, not at all at the baseline.  A stored edit overrides
the base dataset on both the viewer and the editor, so refitting the dataset
alone leaves precisely the pages someone cared enough to edit still wrong.

The table is append-only, so this publishes a NEW version per page rather than
rewriting anything: the original stays in the history and can be reverted to.
"""
import json
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

import refit_to_ink as R

SITE = os.environ.get("SPECTRAWOLF_SITE", "https://spectrawolf.vercel.app")
AUTHOR = "refit"
NOTE = "re-seated on the printed ink (removed the peak-to-1.00 rescale)"


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def post(url, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def refit_curves(doc, frame, img, xcal):
    """Refit em/ab/em2/extra of a stored edit; returns (changed, stats)."""
    img_w, _ = img.size
    page_scale = frame["w"] / img_w
    mask, rule, _ = R.build_ink(img, frame, page_scale)
    y_top, y_bot = frame["y_top"], frame["y_bottom"]
    height = float(y_bot - y_top)
    tol_scan = R.TOL_PAGE_PX / page_scale
    stats = []

    def do(c, label):
        wl = np.asarray(c["wl"], float)
        inten = np.asarray(c["inten"], float)
        px = (1e7 / wl - xcal["b"]) / xcal["a"]
        py = y_bot - inten * height
        xs = np.round(px / page_scale).astype(int)
        ys = py / page_scale
        before = R._gap_stats(xs, ys, mask, rule)
        fitted, moved, _, _ = R.snap_to_ink(xs, ys, mask, rule, tol_scan)
        after = R._gap_stats(xs, fitted, mask, rule)
        new = (y_bot - fitted * page_scale) / height
        # the API rejects anything outside -0.5..1.5; clamp defensively
        new = np.clip(new, -0.5, 1.5)
        c["inten"] = [round(float(v), 6) for v in new]
        stats.append({"curve": label, "moved": moved,
                      "peak": [round(float(inten.max()), 4), round(float(new.max()), 4)],
                      "above": [before, after]})
        return moved

    changed = 0
    for key in ("em", "ab", "em2"):
        if doc.get(key) and doc[key].get("wl"):
            changed += do(doc[key], key)
    for i, ex in enumerate(doc.get("extra") or []):
        if ex.get("wl"):
            changed += do(ex, f"extra[{i}]")
    return changed, stats


def main():
    dry = "--apply" not in sys.argv
    frames = json.load(open(R.FRAMES))
    base = json.load(open(R.DATA))["spectra"]

    index = get(f"{SITE}/api/edits")["edits"]
    gids = sorted(index)
    print(f"{len(gids)} stored edits at {SITE}"
          + ("   [DRY RUN — pass --apply to publish]" if dry else "   [APPLYING]"))

    done = fails = 0
    for gid in gids:
        frame = frames.get(gid)
        scan = os.path.join(R.SCANS, gid + ".webp")
        xcal = (base.get(gid) or {}).get("xcal")
        if not (frame and xcal and os.path.exists(scan)):
            print(f"  {gid}: SKIP (no frame/xcal/scan)")
            fails += 1
            continue
        try:
            doc = get(f"{SITE}/api/edits?gid={gid}")
        except Exception as e:
            print(f"  {gid}: SKIP (fetch failed: {e})")
            fails += 1
            continue

        payload = {k: doc.get(k) for k in ("em", "ab", "em2", "extra")}
        with Image.open(scan) as img:
            img.load()
            moved, stats = refit_curves(payload, frame, img, xcal)

        desc = "  ".join(
            f"{s['curve']}: {s['above'][0]}%->{s['above'][1]}% above, "
            f"peak {s['peak'][0]}->{s['peak'][1]}" for s in stats)
        print(f"  {gid}: {moved:5d} dots   {desc}")

        if dry:
            continue
        try:
            body = {"gid": gid, "author": AUTHOR, "note": NOTE}
            body.update({k: v for k, v in payload.items() if v})
            post(f"{SITE}/api/save", body)
            done += 1
            time.sleep(0.3)
        except Exception as e:
            print(f"    !! save failed: {e}")
            fails += 1

    print(f"\n{'would republish' if dry else 'republished'}: "
          f"{len(gids) - fails if dry else done}   failures: {fails}")


if __name__ == "__main__":
    main()
