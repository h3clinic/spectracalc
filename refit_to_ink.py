#!/usr/bin/env python3
"""Seat the published dataset on the printed ink.

The digitizer reconstructs each curve from the plate, then several places along
the way rescaled it so its peak read exactly 1.00 — Berlman normalizes to unit
peak, so a max just under 1.0 looked like clipping to be undone.  Plenty of
plates simply print the apex below the rule (mesitylene peaks at 0.990), and a
peak rescale is a *global* one: it displaces every point in proportion to its
intensity, most at the maximum and not at all at the baseline.  The published
curve therefore floated above the printed stroke, worst at the top.  That is
what reached the CSVs, the workbooks, the PhotochemCAD figures and the viewer.

This pass fits the published points back onto the ink they were traced from,
using the same three-pass algorithm the browser editor runs at display time
(SpectraWolf/editor.js, snapToInk):

  1. nearest ink in the dot's own column, ignoring frame and axis rules
  2. propagate outwards from settled dots, one column at a time
  3. bridge a dot stranded in a column with no usable ink onto the chord
     between its settled neighbours

Reading and writing data/spectra_all.json, it changes intensities only; the
wavelength axis is untouched.
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

TOL_PAGE_PX = 26      # pass-one search radius, original page px
NEIGHBOUR_RADIUS = 20  # pass-two band, scan px
SWEEPS = 4
BRIDGE_MAX_COLS = 24
STROKE_MAX = 8         # a taller run is a steep flank, not a stroke crossed square-on
RULE_COVERAGE = 0.6    # ink fraction across the plot interior that marks a ruled row


def build_ink(img, frame, page_scale):
    """Otsu-binarised ink mask plus the set of ruled rows."""
    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    lum = (a[:, :, 0] * 299 + a[:, :, 1] * 587 + a[:, :, 2] * 114) / 1000
    lum = lum.astype(np.uint8)
    hist = np.bincount(lum.ravel(), minlength=256).astype(np.float64)
    total = lum.size
    levels = np.arange(256, dtype=np.float64)
    total_sum = float((levels * hist).sum())
    w_b = np.cumsum(hist)
    sum_b = np.cumsum(levels * hist)
    w_f = total - w_b
    with np.errstate(divide="ignore", invalid="ignore"):
        m_b = sum_b / w_b
        m_f = (total_sum - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
    between[~np.isfinite(between)] = -1
    thr = int(np.argmax(between))
    mask = lum <= thr

    h, w = mask.shape
    fx0 = max(0, int(round((frame["x_left"] + 30) / page_scale)))
    fx1 = min(w - 1, int(round((frame["x_right"] - 30) / page_scale)))
    if fx1 <= fx0:
        fx0, fx1 = 0, w - 1
    strip = mask[:, fx0:fx1 + 1:2]
    rule = strip.mean(axis=1) > RULE_COVERAGE
    return mask, rule, thr


def column_runs(mask, x):
    """Vertical ink runs in one scan column, as (start, end) inclusive."""
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


def nearest_run(runs, rule, y, radius):
    """Where in the nearest non-ruled run this dot belongs, or None.

    Judged by how far the *ink* is, not how far the landing point is: on a tall
    run the landing point sits half a stroke inside it, and charging that inset
    against the tolerance rejects apexes only a few pixels off the stroke.
    """
    best = None
    best_d = float("inf")
    for a, b in runs:
        if rule[a:b + 1].all():
            continue                      # the box border or a 0.5/1.0 rule
        inside = a <= y <= b
        if inside:
            target, d = y, 0.0
        else:
            if b - a <= STROKE_MAX:
                target = (a + b) / 2.0
            else:
                target = a + STROKE_MAX / 2.0 if y < a else b - STROKE_MAX / 2.0
            d = min(abs(y - a), abs(y - b))
        if d < best_d:
            best_d, best = d, target
    return best if best_d <= radius else None


def snap_to_ink(xs, ys, mask, rule, tol_scan):
    """Three passes; returns the fitted ys and how many moved."""
    n = len(xs)
    w = mask.shape[1]
    live = np.zeros(n, bool)
    fixed = np.zeros(n, bool)
    out = np.array(ys, float)
    runs_cache = {}

    def runs_at(x):
        if x not in runs_cache:
            runs_cache[x] = column_runs(mask, x)
        return runs_cache[x]

    for i in range(n):
        x = xs[i]
        if x < 0 or x >= w:
            continue
        live[i] = True
        hit = nearest_run(runs_at(x), rule, out[i], tol_scan)
        if hit is not None:
            out[i] = hit
            fixed[i] = True

    for _ in range(SWEEPS):
        changed = 0
        for reverse in (False, True):
            order = range(n - 1, -1, -1) if reverse else range(n)
            for i in order:
                if not live[i] or fixed[i]:
                    continue
                if i > 0 and fixed[i - 1]:
                    ref = out[i - 1]
                elif i + 1 < n and fixed[i + 1]:
                    ref = out[i + 1]
                else:
                    continue
                hit = nearest_run(runs_at(xs[i]), rule, ref, NEIGHBOUR_RADIUS)
                if hit is None:
                    continue
                out[i] = hit
                fixed[i] = True
                changed += 1
        if not changed:
            break

    for i in range(n):                    # pass three: stranded dots
        if not live[i] or fixed[i]:
            continue
        l = i - 1
        while l >= 0 and not fixed[l]:
            l -= 1
        r = i + 1
        while r < n and not fixed[r]:
            r += 1
        if l < 0 or r >= n:
            continue
        if abs(int(xs[r]) - int(xs[l])) > BRIDGE_MAX_COLS:
            continue
        chord = out[l] + (out[r] - out[l]) * ((i - l) / (r - l))
        if abs(out[i] - chord) <= NEIGHBOUR_RADIUS:
            continue
        out[i] = chord
        fixed[i] = True

    moved = int((live & fixed & (np.abs(out - np.asarray(ys, float)) > 0.5)).sum())
    return out, moved, live, fixed


def refit_page(rec, frame, img):
    """Refit every curve on one page in place; returns per-curve stats."""
    img_w, img_h = img.size
    page_scale = frame["w"] / img_w
    mask, rule, _ = build_ink(img, frame, page_scale)
    xcal = rec.get("xcal")
    if not xcal:
        return []
    y_top, y_bot = frame["y_top"], frame["y_bottom"]
    height = float(y_bot - y_top)
    tol_scan = TOL_PAGE_PX / page_scale
    stats = []

    for key in ("em", "ab", "em2"):
        c = rec.get(key)
        if not c or not c.get("wl"):
            continue
        wl = np.asarray(c["wl"], float)
        inten = np.asarray(c["inten"], float)
        px = (1e7 / wl - xcal["b"]) / xcal["a"]        # page px
        py = y_bot - inten * height                    # page px
        xs = np.round(px / page_scale).astype(int)
        ys = py / page_scale                           # scan px

        before = _gap_stats(xs, ys, mask, rule)
        fitted, moved, _, _ = snap_to_ink(xs, ys, mask, rule, tol_scan)
        after = _gap_stats(xs, fitted, mask, rule)

        new_inten = (y_bot - fitted * page_scale) / height
        c["inten"] = [round(float(v), 6) for v in new_inten]
        stats.append({"key": key, "n": len(wl), "moved": moved,
                      "peak_before": round(float(inten.max()), 4),
                      "peak_after": round(float(new_inten.max()), 4),
                      "above_before": before, "above_after": after})
    return stats


def _gap_stats(xs, ys, mask, rule):
    """Percent of points sitting more than 3 px ABOVE the nearest ink."""
    w = mask.shape[1]
    above = tot = 0
    cache = {}
    for i in range(0, len(xs), 2):
        x = int(xs[i])
        if x < 0 or x >= w:
            continue
        if x not in cache:
            cache[x] = column_runs(mask, x)
        y = ys[i]
        best = None
        for a, b in cache[x]:
            if rule[a:b + 1].all():
                continue
            g = 0.0 if a <= y <= b else (a - y if y < a else -(y - b))
            if best is None or abs(g) < abs(best):
                best = g
        if best is None:
            continue
        tot += 1
        if best > 3:
            above += 1
    return round(100.0 * above / tot, 2) if tot else None


def main():
    only = sys.argv[1:]
    doc = json.load(open(DATA))
    frames = json.load(open(FRAMES))
    spectra = doc["spectra"]
    gids = only or list(spectra.keys())

    tot_moved = 0
    ab_before = []
    ab_after = []
    peaks_changed = 0
    skipped = []

    for n, gid in enumerate(gids, 1):
        rec = spectra.get(gid)
        frame = frames.get(gid)
        scan = os.path.join(SCANS, gid + ".webp")
        if not rec or not frame or not os.path.exists(scan):
            skipped.append(gid)
            continue
        with Image.open(scan) as img:
            img.load()
            stats = refit_page(rec, frame, img)
        for s in stats:
            tot_moved += s["moved"]
            if s["above_before"] is not None:
                ab_before.append(s["above_before"])
                ab_after.append(s["above_after"])
            if abs(s["peak_before"] - s["peak_after"]) > 1e-4:
                peaks_changed += 1
        if n % 25 == 0 or n == len(gids):
            print(f"  {n}/{len(gids)} pages", flush=True)

    if not only:
        tmp = DATA + ".tmp"
        with open(tmp, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        os.replace(tmp, DATA)

    print(f"\npages refitted   : {len(gids) - len(skipped)}")
    print(f"dots moved       : {tot_moved}")
    print(f"curves repeaked  : {peaks_changed}")
    if ab_before:
        print(f"points above ink : {np.mean(ab_before):.2f}%  ->  {np.mean(ab_after):.2f}%")
        print(f"worst page before: {max(ab_before):.1f}%   after: {max(ab_after):.1f}%")
    if skipped:
        print(f"skipped ({len(skipped)}): {', '.join(skipped[:8])}")


if __name__ == "__main__":
    main()
