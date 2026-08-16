#!/usr/bin/env python3
"""Continue traces that were cut short, following the stroke they were on.

Where two curves cross, the tracer can stop dead: on rhodamine 8B it followed
the absorption curve up to the crossing at 531.5 nm and quit, so the released
absorption spectrum ends at 0.4165 — its own maximum — and never reaches the
real 554 nm absorption peak.

Extending is the mirror of that failure, so it is done the way a person reads a
crossing: keep going in the direction the stroke was already heading.  The
walker carries a slope, predicts the next column from it, and accepts the ink
run nearest that prediction.  At a crossing both curves offer a run and the
prediction picks the one that continues the line rather than the one that turns
the corner.  Print breaks are bridged; the walk stops when the ink genuinely
runs out, when it leaves the plot, or when it doubles back on itself.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

import refit_to_ink as R
import find_truncations as FT

SEARCH = 14         # scan px: how far off the prediction a run may sit
GAP_MAX = 12        # columns of blank paper to bridge before giving up
SLOPE_MEMORY = 0.62  # how strongly the previous slope steers the prediction
SLOPE_WIN = 25      # points used to seed the outgoing slope
MAX_RUN_H = 60      # taller than this is a merged blob, not a stroke
MARGIN = 6          # scan px allowed outside the frame before stopping
BASELINE_PX = 9     # this close to the axis the spectrum has bottomed out
BASELINE_RUN = 20   # columns to sit there before calling the walk finished


def follow(mask, rule, xs, ys, at_start, frame_scan):
    """Walk outward from one end of a trace; returns the new (x, y) points."""
    h, w = mask.shape
    yt, yb, xl, xr = frame_scan
    if at_start:
        x0, y0 = int(xs[0]), float(ys[0])
        nb = slice(0, min(SLOPE_WIN, len(xs)))
    else:
        x0, y0 = int(xs[-1]), float(ys[-1])
        nb = slice(max(0, len(xs) - SLOPE_WIN), len(xs))

    xw, yw = np.asarray(xs[nb], float), np.asarray(ys[nb], float)
    if len(set(xw.tolist())) < 2:
        return []
    slope = float(np.polyfit(xw, yw, 1)[0])
    step = -1 if x0 < float(np.mean(xs)) else 1
    slope *= step                        # per-column change in the walk's own direction

    out = []
    y = y0
    gap = flat = 0
    x = x0
    while True:
        x += step
        if x < xl - MARGIN or x > xr + MARGIN or x < 0 or x >= w:
            break
        pred = y + slope
        best = None
        best_d = SEARCH + 1
        for a, b in R.column_runs(mask, x):
            if rule[a:b + 1].all() or b - a > MAX_RUN_H:
                continue
            t = pred if a <= pred <= b else (a if pred < a else b)
            d = 0.0 if a <= pred <= b else min(abs(pred - a), abs(pred - b))
            if d < best_d:
                best_d, best = d, t
        if best is None:
            gap += 1
            if gap > GAP_MAX:
                break
            y = pred                     # coast across the break
            out.append((x, y))
            continue
        gap = 0
        new_slope = best - y
        slope = SLOPE_MEMORY * slope + (1 - SLOPE_MEMORY) * new_slope
        y = best
        out.append((x, y))
        if y < yt - MARGIN or y > yb + MARGIN:
            break
        # A spectrum that has come down to the baseline is over.  Without this
        # the walk runs on along the axis, where every curve on the plate lies
        # on top of every other one.
        if y >= yb - BASELINE_PX:
            flat += 1
            if flat > BASELINE_RUN:
                break
        else:
            flat = 0

    while out and (out[-1][1] < yt - MARGIN or out[-1][1] > yb + MARGIN):
        out.pop()
    # drop a trailing coast that never found ink again
    tail = 0
    for xx, yy in reversed(out):
        hit = any(not rule[a:b + 1].all() and b - a <= MAX_RUN_H and a - 2 <= yy <= b + 2
                  for a, b in R.column_runs(mask, int(xx)))
        if hit:
            break
        tail += 1
    if tail:
        out = out[:-tail]
    return out


DUP_PX = 12          # two traces this close are the same printed stroke
DUP_RUN = 12        # consecutive coincident points that prove a mis-split
DUP_MISS = 25       # coincidence may lapse this long across a print break


def _lookup(xs, ys):
    """A trace as (sorted x, y), interpolable.

    Testing one trace against another by exact pixel column is too brittle:
    after the 0.1 nm dedup a curve carries no point in some columns, and a
    single missing column would end a coincidence run that plainly continues.
    Interpolate along the other trace instead, and report nothing outside its
    own span rather than extrapolating a comparison that has no basis.
    """
    o = np.argsort(np.asarray(xs, float))
    return np.asarray(xs, float)[o], np.asarray(ys, float)[o]


def _on_other(x, y, others):
    """Is (x, y) sitting on one of the other traces?"""
    for ox, oy in others:
        if len(ox) < 2 or x < ox[0] or x > ox[-1]:
            continue
        if abs(float(np.interp(x, ox, oy)) - y) <= DUP_PX:
            return True
    return False


def _duplicates(pts, others):
    """Fraction of pts that land on some other curve's existing stroke."""
    if not pts:
        return 0.0
    return sum(1 for x, y in pts if _on_other(x, y, others)) / len(pts)


def _cut_at_duplicate(pts, others):
    """Keep a walk only up to the point where it joins another trace.

    All-or-nothing rejection throws away good work: a walk down the emission
    edge is right until it reaches the baseline, where every curve on the plate
    lies on top of every other one.  Cut it where it merges instead.
    """
    if not pts:
        return pts
    # A walk that is mostly on another trace took the wrong branch outright —
    # that is the failure being repaired, not a continuation of this curve.
    if _duplicates(pts, others) > 0.5:
        return []
    # Otherwise the opening points may legitimately sit on the other stroke:
    # the walk starts at the crossing.  Only cut where the walk has already
    # separated and then merges back for good.
    run = sep = 0
    for i, (x, y) in enumerate(pts):
        if _on_other(x, y, others):
            run += 1
            if sep >= DUP_RUN and run >= DUP_RUN:
                return pts[:i - run + 1]
        else:
            run = 0
            sep += 1
    return pts


def _trim_duplicated_tail(xs, ys, others):
    """Indices to drop from each end where this trace re-walks another one.

    Where the tracer split one path in two at a crossing, the piece it handed
    to the wrong curve sits exactly on the other curve's stroke.  Once that
    other curve has been extended through the crossing, the stolen piece is a
    literal duplicate, and the honest repair is to give it back.
    """
    n = len(xs)

    def run_from(idxs):
        run = last_on = 0
        miss = 0
        for pos, i in enumerate(idxs):
            if _on_other(float(xs[i]), float(ys[i]), others):
                miss = 0
                last_on = pos + 1
            else:
                miss += 1
                if miss > DUP_MISS:      # a real departure, not a print break
                    break
        run = last_on
        return run if run >= DUP_RUN else 0

    return run_from(range(n)), run_from(range(n - 1, -1, -1))


def extend_page(gid, rec, fr, img, targets):
    """Extend the flagged endpoints of one page; returns a per-curve report."""
    img_w, _ = img.size
    ps = fr["w"] / img_w
    mask, rule, _ = R.build_ink(img, fr, ps)
    yb, yt = fr["y_bottom"], fr["y_top"]
    H = float(yb - yt)
    xc = rec["xcal"]
    frame_scan = (yt / ps, yb / ps, fr["x_left"] / ps, fr["x_right"] / ps)
    report = []

    # every curve's existing stroke, so an extension can be tested against the
    # others before it is believed
    geom = {}
    for key in ("em", "ab", "em2"):
        c = rec.get(key)
        if not c or not c.get("wl"):
            continue
        wl = np.asarray(c["wl"], float)
        it = np.asarray(c["inten"], float)
        geom[key] = (np.round(((1e7 / wl - xc["b"]) / xc["a"]) / ps).astype(int),
                     (yb - it * H) / ps)
    tables = {k: _lookup(*v) for k, v in geom.items()}

    for key in ("em", "ab", "em2"):
        ends = [t["end"] for t in targets if t["curve"] == key]
        c = rec.get(key)
        if not ends or not c:
            continue
        wl = np.asarray(c["wl"], float)
        it = np.asarray(c["inten"], float)
        xs, ys = geom[key]
        others = [t for k, t in tables.items() if k != key]
        added = []
        rejected = 0
        for end in ends:
            pts = follow(mask, rule, xs, ys, end == "start", frame_scan)
            # A walk that lands on another curve's stroke is not this curve
            # continuing — it is the walker taking the wrong branch at the
            # crossing, which is how the trace got cut here in the first place.
            kept = _cut_at_duplicate(pts, others)
            rejected += len(pts) - len(kept)
            added.extend(kept)
        if not added:
            report.append({"curve": key, "added": 0, "rejected": rejected})
            continue

        ax = np.array([p[0] for p in added], float) * ps       # back to page px
        ay = np.array([p[1] for p in added], float) * ps
        awn = xc["a"] * ax + xc["b"]
        keep = awn > 0
        awl = 1e7 / awn[keep]
        ain = (yb - ay[keep]) / H

        allwl = np.concatenate([wl, awl])
        allin = np.concatenate([it, ain])
        order = np.argsort(allwl)
        allwl, allin = allwl[order], allin[order]
        # 0.1 nm dedup, keeping the higher value where points collide
        binned = np.round(allwl * 10).astype(np.int64)
        uniq, idx = np.unique(binned, return_index=True)
        best = np.full(len(uniq), -np.inf)
        for b, v in zip(binned, allin):
            j = np.searchsorted(uniq, b)
            if v > best[j]:
                best[j] = v
        c["wl"] = [round(float(u) / 10, 1) for u in uniq]
        c["inten"] = [round(float(v), 6) for v in best]
        report.append({"curve": key, "added": int(keep.sum()), "rejected": rejected,
                       "peak": [round(float(it.max()), 3), round(float(best.max()), 3)],
                       "span": [round(float(wl[0]), 1), round(float(wl[-1]), 1),
                                round(float(uniq[0]) / 10, 1), round(float(uniq[-1]) / 10, 1)]})
        tables[key] = _lookup(np.round(((1e7 / np.asarray(c["wl"], float) - xc["b"])
                                        / xc["a"]) / ps).astype(int),
                              (yb - np.asarray(c["inten"], float) * H) / ps)

    # Second pass: hand back any stretch one curve is re-walking on another's
    # stroke.  On a mis-split this is the piece the tracer gave to the wrong
    # curve, and it only becomes a provable duplicate once the rightful owner
    # has been extended through the crossing above.
    for key in ("em", "ab", "em2"):
        c = rec.get(key)
        if not c or len(c.get("wl") or []) < 40:
            continue
        wl = np.asarray(c["wl"], float)
        it = np.asarray(c["inten"], float)
        xs = np.round(((1e7 / wl - xc["b"]) / xc["a"]) / ps).astype(int)
        ys = (yb - it * H) / ps
        others = [t for k, t in tables.items() if k != key]
        head, tail = _trim_duplicated_tail(xs, ys, others)
        if not head and not tail:
            continue
        lo, hi = head, len(wl) - tail
        if hi - lo < 40:
            continue
        kwl, kit = wl[lo:hi], it[lo:hi]
        # A trimmed end is incomplete by construction — the piece that was
        # removed was standing in for the real continuation, and the detector
        # cannot flag it because the true edge lies below the baseline gate.
        # Walk it now, while we still know this end was just cut.
        kxs = np.round(((1e7 / kwl - xc["b"]) / xc["a"]) / ps).astype(int)
        kys = (yb - kit * H) / ps
        regrown = 0
        for at_start, was_cut in ((True, head), (False, tail)):
            if not was_cut:
                continue
            pts = _cut_at_duplicate(
                follow(mask, rule, kxs, kys, at_start, frame_scan), others)
            if not pts:
                continue
            px_ = np.array([p[0] for p in pts], float) * ps
            py_ = np.array([p[1] for p in pts], float) * ps
            wn = xc["a"] * px_ + xc["b"]
            ok = wn > 0
            kwl = np.concatenate([kwl, 1e7 / wn[ok]])
            kit = np.concatenate([kit, (yb - py_[ok]) / H])
            regrown += int(ok.sum())
        if regrown:
            o = np.argsort(kwl)
            kwl, kit = kwl[o], kit[o]
            b10 = np.round(kwl * 10).astype(np.int64)
            uniq = np.unique(b10)
            best = np.full(len(uniq), -np.inf)
            for b, v in zip(b10, kit):
                j = np.searchsorted(uniq, b)
                if v > best[j]:
                    best[j] = v
            kwl = uniq / 10.0
            kit = best

        c["wl"] = [round(float(v), 1) for v in kwl]
        c["inten"] = [round(float(v), 6) for v in kit]
        report.append({"curve": key, "added": regrown, "rejected": 0,
                       "trimmed": head + tail,
                       "peak": [round(float(it.max()), 3), round(float(kit.max()), 3)],
                       "span": [round(float(wl[0]), 1), round(float(wl[-1]), 1),
                                round(float(kwl[0]), 1), round(float(kwl[-1]), 1)]})
    return report


def main():
    only = set(a for a in sys.argv[1:] if a.startswith("graph-"))
    apply = "--apply" in sys.argv
    doc = json.load(open(R.DATA))
    spectra = doc["spectra"]
    frames = json.load(open(R.FRAMES))
    trunc = json.load(open(os.path.join(R.ROOT, "data", "truncations.json")))

    by_gid = {}
    for t in trunc:
        by_gid.setdefault(t["gid"], []).append(t)
    gids = [g for g in by_gid if not only or g in only]
    print(f"{len(gids)} pages with cut traces"
          + ("   [APPLYING]" if apply else "   [DRY RUN — pass --apply]"))

    total = 0
    for n, gid in enumerate(sorted(gids), 1):
        fr = frames.get(gid)
        scan = os.path.join(R.SCANS, gid + ".webp")
        if not fr or not os.path.exists(scan):
            continue
        with Image.open(scan) as img:
            img.load()
            rep = extend_page(gid, spectra[gid], fr, img, by_gid[gid])
        for r in rep:
            s = r["span"] if "span" in r else None
            if r.get("trimmed"):
                print(f"  {gid:12s} {str(spectra[gid].get('name'))[:22]:22s} {r['curve']:4s} "
                      f"-{r['trimmed']:5d} pts (duplicate of another curve)  "
                      f"{s[0]:.0f}-{s[1]:.0f} -> {s[2]:.0f}-{s[3]:.0f} nm")
                continue
            if not r["added"]:
                if r.get("rejected"):
                    print(f"  {gid:12s} {str(spectra[gid].get('name'))[:22]:22s} {r['curve']:4s} "
                          f"  rejected {r['rejected']} pts (wrong branch at a crossing)")
                continue
            total += r["added"]
            print(f"  {gid:12s} {str(spectra[gid].get('name'))[:22]:22s} {r['curve']:4s} "
                  f"+{r['added']:5d} pts  peak {r['peak'][0]:.3f}->{r['peak'][1]:.3f}  "
                  f"{s[0]:.0f}-{s[1]:.0f} -> {s[2]:.0f}-{s[3]:.0f} nm")
        if n % 25 == 0:
            print(f"  ... {n}/{len(gids)}", flush=True)

    print(f"\npoints added: {total}")
    if apply:
        tmp = R.DATA + ".tmp"
        with open(tmp, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        os.replace(tmp, R.DATA)
        print("written:", R.DATA)


if __name__ == "__main__":
    main()
