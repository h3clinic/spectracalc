#!/usr/bin/env python3
"""Anchor unit intensity on each curve's own printed ink maximum.

The ordinate has until now been anchored on the plot frame: the lower rule is 0
and the upper rule is 1.  Berlman does not draw every apex on the upper rule.
Some fall short of it and some overshoot, so a curve whose printed peak sits 19
px below the rule publishes a maximum of 0.991, and its reconstructed apex then
floats above the ink by exactly that gap.  That is the dots-above-peak fault,
and it is a calibration fault rather than a tracing one.

Unity is therefore redefined per curve, at the highest PRINTED INK belonging to
that curve.  Not at the highest extracted point: the extracted points carry
whatever error the tracing has, and anchoring on them would fold that error into
the scale, which cannot then disagree with itself.  The points are used only to
identify which ink is this curve's, by taking the ink run nearest each point
with the frame and grid rules excluded, and keeping the topmost row reached.

The factor applied is recorded as `unity_from_frame_scale`, so the previous
frame-anchored scale is exactly recoverable and the ratio between two traces on
a CURVE I / II plate is not lost.

Does not modify berlman.py.  Operates on data/spectra_all.json and the scans.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
SCANS = os.path.join(ROOT, "site", "scans")
DATA = os.path.join(ROOT, "data", "spectra_all.json")
FRAMES = os.path.join(ROOT, "data", "frames.json")
TOL_PAGE_PX = 26
RULE_COVERAGE = 0.6


def build_ink(img, frame, page_scale):
    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    lum = ((a[:, :, 0] * 299 + a[:, :, 1] * 587 + a[:, :, 2] * 114) / 1000).astype(np.uint8)
    hist = np.bincount(lum.ravel(), minlength=256).astype(np.float64)
    total = lum.size
    lv = np.arange(256, dtype=np.float64)
    tsum = float((lv * hist).sum())
    wb = np.cumsum(hist); sb = np.cumsum(lv * hist); wf = total - wb
    with np.errstate(divide="ignore", invalid="ignore"):
        between = wb * wf * (sb / wb - (tsum - sb) / wf) ** 2
    between[~np.isfinite(between)] = -1
    mask = lum <= int(np.argmax(between))
    h, w = mask.shape
    fx0 = max(0, int(round((frame["x_left"] + 30) / page_scale)))
    fx1 = min(w - 1, int(round((frame["x_right"] - 30) / page_scale)))
    if fx1 <= fx0:
        fx0, fx1 = 0, w - 1
    rule = mask[:, fx0:fx1 + 1:2].mean(axis=1) > RULE_COVERAGE
    return mask, rule


def column_runs(mask, x):
    col = mask[:, x]
    if not col.any():
        return []
    d = np.diff(col.astype(np.int8))
    starts = list(np.flatnonzero(d == 1) + 1)
    ends = list(np.flatnonzero(d == -1))
    if col[0]:
        starts.insert(0, 0)
    if col[-1]:
        ends.append(len(col) - 1)
    return list(zip(starts, ends))


def ink_peak_row(px, py, mask, rule, page_scale, tol_scan):
    """Topmost printed-ink row belonging to this curve, in scan px."""
    top = None
    w = mask.shape[1]
    cache = {}
    for i in range(len(px)):
        x = int(round(px[i] / page_scale))
        if x < 0 or x >= w:
            continue
        y = py[i] / page_scale
        if x not in cache:
            cache[x] = [(a, b) for a, b in column_runs(mask, x) if not rule[a:b + 1].all()]
        best, bd = None, np.inf
        for a, b in cache[x]:
            d = 0.0 if a <= y <= b else min(abs(y - a), abs(y - b))
            if d < bd:
                bd, best = d, a
        if best is not None and bd <= tol_scan and (top is None or best < top):
            top = best
    return top


def main():
    only = sys.argv[1:]
    apply = "--apply" in only
    only = [g for g in only if g != "--apply"]
    doc = json.load(open(DATA))
    frames = json.load(open(FRAMES))
    spectra = doc["spectra"]
    gids = only or list(spectra.keys())

    changed, skipped, factors = 0, 0, []
    for n, gid in enumerate(gids, 1):
        rec = spectra.get(gid)
        fr = frames.get(gid)
        scan = os.path.join(SCANS, gid + ".webp")
        if not (rec and fr and os.path.exists(scan) and rec.get("xcal")):
            skipped += 1
            continue
        with Image.open(scan) as im:
            im.load()
            ps = fr["w"] / im.size[0]
            mask, rule = build_ink(im, fr, ps)
        yb, yt = fr["y_bottom"], fr["y_top"]
        H = float(yb - yt)
        for k in ("em", "ab", "em2"):
            c = rec.get(k)
            if not (c and c.get("wl")):
                continue
            wl = np.asarray(c["wl"], float)
            it = np.asarray(c["inten"], float)
            # A previous pass rescaled each curve to unit peak, which detached
            # the stored intensities from the frame.  Undo that first, or the
            # apex converts back onto the frame rule by construction and the
            # ink correction compounds on a scale that is no longer frame-true.
            prior = float(c.get("peak_scaled_from", 1.0))
            frame_it = it * prior
            px = (1e7 / wl - rec["xcal"]["b"]) / rec["xcal"]["a"]
            py = yb - frame_it * H
            top = ink_peak_row(px, py, mask, rule, ps, TOL_PAGE_PX / ps)
            if top is None:
                continue
            unity = (yb - top * ps) / H          # intensity the ink apex sits at
            if not (0.5 < unity < 1.5) or abs(unity - 1.0) < 5e-4:
                continue
            # rescale the FRAME-true intensities so the ink apex reads 1.000
            c["inten"] = [round(float(v), 6) for v in frame_it / unity]
            c["unity_from_frame_scale"] = round(unity, 6)
            c.pop("peak_scaled_from", None)   # superseded by the ink anchor
            changed += 1
            factors.append(unity)
        if n % 25 == 0 or n == len(gids):
            print(f"  {n}/{len(gids)}", flush=True)

    if apply and not only:
        tmp = DATA + ".tmp"
        json.dump(doc, open(tmp, "w"), separators=(",", ":"))
        os.replace(tmp, DATA)
        print("written:", DATA)
    f = np.array(factors) if factors else np.array([1.0])
    print(f"\ncurves recalibrated : {changed}")
    print(f"factor applied      : median {np.median(f):.4f}  min {f.min():.4f}  max {f.max():.4f}")
    print(f"  curves needing >1% : {(np.abs(f - 1) > 0.01).sum()}")
    print(f"  plates skipped     : {skipped}")


if __name__ == "__main__":
    main()
