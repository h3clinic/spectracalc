#!/usr/bin/env python3
"""Measure how well a dataset sits on the printed ink, without changing it.

This is the grading pass, not a repair pass: it reads a spectra_all.json, puts
every curve back onto the page in pixels, and reports the fraction of points
that land more than 3 px ABOVE the nearest printed stroke.  Above is the
direction that matters -- a curve floating over its own ink is the "dots above
the black line" fault, and it is invisible in any statistic computed from the
numbers alone, because the numbers are self-consistent either way.

The conversion undoes `scaled_by` before converting intensity back to a pixel
row.  Skipping that step is itself a way to manufacture the fault: a curve
normalised to unit peak sits above ink by exactly the normalisation factor if
you forget the curve was normalised at all.

Reuses build_ink / column_runs / _gap_stats from refit_to_ink so the definition
of "ink" is the same one the refit used, and nothing here writes to the dataset.

Usage:
  python3 validate_ink.py                          grade data/spectra_all.json
  python3 validate_ink.py --data other.json        grade another file
  python3 validate_ink.py --compare a.json b.json  grade two, side by side
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image

import refit_to_ink as R

ROOT = os.path.dirname(os.path.abspath(__file__))
KEYS = ("em", "ab", "em2")


def frame_true_factor(c):
    """Multiply a stored intensity by this to get back to the frame scale.

    A curve cannot be put back on the page without knowing every rescaling it
    has been through, and the old corpus records them under three different
    names, from three different passes, that compose:

      peak_scaled_from = P   normalise_peaks divided by P          -> x P
      unity_from_frame_scale = U   recalibrate_peak_to_ink divided by U   -> x U
      scaled_by = S          normalise_to_own_max divided by 1/S    -> x 1/S

    P and U never co-occur: the recalibration pops peak_scaled_from when it
    writes unity_from_frame_scale, having already undone it.  Getting this
    wrong does not fail loudly, it just reports the curve as floating above its
    own ink -- reading `scaled_by` alone puts graph-235's absorption 1/0.778
    too high and grades it 97% above ink when the geometry is fine.

    A redigitized record carries `scaled_by` and nothing else, so this whole
    function collapses to one term.
    """
    f = 1.0
    if c.get("peak_scaled_from"):
        f *= float(c["peak_scaled_from"])
    if c.get("unity_from_frame_scale"):
        f *= float(c["unity_from_frame_scale"])
    if c.get("scaled_by"):
        f /= float(c["scaled_by"])
    return f


def grade_page(args):
    gid, rec, frame = args
    try:
        path = os.path.join(R.SCANS, gid + ".webp")
        if not os.path.exists(path) or not frame or not rec.get("xcal"):
            return gid, []
        img = Image.open(path)
        page_scale = frame["w"] / img.size[0]
        mask, rule, _ = R.build_ink(img, frame, page_scale)
        xcal = rec["xcal"]
        y_top, y_bot = frame["y_top"], frame["y_bottom"]
        height = float(y_bot - y_top)

        out = []
        for key in KEYS:
            c = rec.get(key)
            if not c or not c.get("wl"):
                continue
            wl = np.asarray(c["wl"], float)
            inten = np.asarray(c["inten"], float)
            undo = frame_true_factor(c)
            px = (1e7 / wl - xcal["b"]) / xcal["a"]
            py = y_bot - inten * undo * height
            xs = np.round(px / page_scale).astype(int)
            ys = py / page_scale
            above = R._gap_stats(xs, ys, mask, rule)
            if above is not None:
                out.append({"gid": gid, "key": key, "n": len(wl), "above": above})
        return gid, out
    except Exception as ex:
        return gid, [{"gid": gid, "key": "?", "n": 0, "above": None, "error": str(ex)}]


def grade(path, frames, jobs):
    blob = json.load(open(path))
    spectra = blob["spectra"]
    work = [(g, r, frames.get(g)) for g, r in sorted(spectra.items())]
    rows = []
    with Pool(jobs) as pool:
        for gid, res in pool.imap_unordered(grade_page, work, chunksize=4):
            rows.extend(r for r in res if r.get("above") is not None)
    return spectra, rows


def summarise(label, spectra, rows):
    ab = np.array([r["above"] for r in rows], float)
    curves = sum(1 for r in spectra.values() for k in KEYS if k in r)
    at_one = sum(1 for r in spectra.values() for k in KEYS
                 if k in r and abs(max(r[k]["inten"]) - 1.0) < 5e-4)
    extra = set()
    for r in spectra.values():
        for k in KEYS:
            if k in r:
                extra |= set(r[k]) - {"wl", "inten"}
    print(f"\n{label}")
    print(f"  pages {len(spectra)}   curves {curves}   at unit peak {at_one}/{curves}")
    print(f"  per-curve fields beyond wl/inten: {sorted(extra) or ['(none)']}")
    print(f"  graded curves: {len(rows)}")
    print(f"  points above ink: mean {ab.mean():.2f}%  median {np.median(ab):.2f}%  "
          f"max {ab.max():.2f}%")
    for t in (1, 3, 10):
        print(f"    curves over {t:2d}% above ink: {(ab > t).sum():4d}  "
              f"({100.0 * (ab > t).mean():.1f}%)")
    worst = sorted(rows, key=lambda r: -r["above"])[:8]
    print("  worst:", ", ".join(f"{r['gid']}/{r['key']} {r['above']}%" for r in worst))
    return ab


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.path.join(ROOT, "data", "spectra_all.json"))
    ap.add_argument("--frames", default=os.path.join(ROOT, "data", "frames.json"))
    ap.add_argument("--compare", nargs=2, metavar=("OLD", "NEW"))
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()

    frames = json.load(open(args.frames))
    if args.compare:
        old_s, old_r = grade(args.compare[0], frames, args.jobs)
        a = summarise(f"OLD  {os.path.basename(args.compare[0])}", old_s, old_r)
        new_s, new_r = grade(args.compare[1], frames, args.jobs)
        b = summarise(f"NEW  {os.path.basename(args.compare[1])}", new_s, new_r)
        print(f"\nmean points above ink: {a.mean():.2f}%  ->  {b.mean():.2f}%  "
              f"({'better' if b.mean() < a.mean() else 'worse'})")
    else:
        s, r = grade(args.data, frames, args.jobs)
        summarise(os.path.basename(args.data), s, r)


if __name__ == "__main__":
    main()
