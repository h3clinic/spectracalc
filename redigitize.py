#!/usr/bin/env python3
"""Rebuild the whole corpus from the digitizer, in one pass, by one rule.

The dataset this replaces was not the output of a single run.  It was one run
followed by a sequence of repair passes -- a refit onto the printed ink, a peak
normalisation, an ink-apex recalibration, then a second normalisation -- each
applied when a different fault came to light, and each to a different subset.
The evidence is in the records themselves: of 614 curves, 574 carried
`unity_from_frame_scale`, 560 carried `scaled_by`, 19 carried
`peak_scaled_from` and 17 carried `peak_below_unity_reason`.  Every curve
reached unit peak, but they did not all get there the same way, so no single
description of the method was true of the whole corpus.

This script is that single description.  For every page:

  1. digitize(page)                 the digitizer, unmodified
  2. bin to a 0.1 nm grid           the same binning the browser editor applies
  3. snap the dots onto the ink     refit_to_ink's three-pass fit, every page
  4. extend traces cut at crossings find_truncations' probe, then extend_page,
                                    which also trims a tail that has wandered
                                    onto a neighbouring curve
  5. divide by the curve's own max  the one normalisation, recorded as scaled_by

Nothing else touches the numbers.  berlman.py is not modified and not consulted
for anything but its own output, and steps 2 to 5 are applied to all 614 curves
without exception, so `scaled_by` is the only provenance field a curve carries.

Step 4 is here for the same reason as step 3: leaving it out measurably loses
data.  The fresh digitization covers 835 nm less curve than the corpus it
replaces, across 63 curves -- graph-416's emission stops 94 nm early, graph-427's
absorption 74 nm -- because the tracer halts where two curves cross and only
this pass carries it through.  The same pass trims the opposite failure, a trace
that crossed over and kept following its neighbour: without it graph-216 and
graph-217 publish an emission curve whose first 584 points are the absorption
curve, agreeing with it to a mean of 0.0018.  It is detection-driven, not a
hand-picked list: every endpoint the probe flags, on every page, is extended.

Step 3 is here on the evidence rather than by inheritance.  Leaving it out and
grading the result put 1.92% of points more than 3 px above their own printed
stroke against 0.30% for the corpus it replaces -- 124 curves over 3% against
10.  The fit was never the problem; applying it to some pages and not others
was.  Run over everything, once, it is part of the constant algorithm rather
than a repair pass layered on top of one.

Step 2 matters more than it looks.  The editor derives its curves from the
pixel dots with the same 0.1 nm binning and the same 5 nm print-break bridge;
matching it here means opening a page in the editor and saving it straight back
is a no-op, rather than a silent change of grid.

Writes data/spectra_all.json, data/frames.json (from the same frame detection,
so the two cannot disagree) and data/redigitize_report.csv.  The existing
dataset is copied aside first.

Usage:
  python3 redigitize.py --limit 6      smoke test on the first few pages
  python3 redigitize.py                the whole corpus
  python3 redigitize.py --out /tmp/x   write elsewhere, leaving data/ alone
"""
import argparse
import csv
import json
import os
import shutil
import sys
import time
from multiprocessing import Pool

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES = os.path.expanduser("~/onepager/berlman_digitization/berlman_run600/pages")
sys.path.insert(0, ROOT)

GRID = 0.1          # nm, the export grid
BRIDGE_MAX = 5.0    # nm, widest print break to interpolate across
BRIDGE_MIN = 0.15   # nm, below this there is no gap to fill
FLOOR = 0.05        # a curve peaking under this is a fragment, not a spectrum


def to_grid(wl_nm, inten):
    """0.1 nm bins, apex bin keeps the peak, print breaks bridged to 5 nm.

    Character for character the editor's physical(): a page that goes through
    here and a page traced in the browser land on the same abscissa, so the two
    halves of the program describe the same curve.
    """
    pairs = sorted(zip(wl_nm, inten))
    if len(pairs) < 2:
        return [], []
    peak_v, peak_bin = -np.inf, None
    total, count = {}, {}
    for w, v in pairs:
        b = round(w / GRID) * GRID
        b = round(b, 1)
        total[b] = total.get(b, 0.0) + v
        count[b] = count.get(b, 0) + 1
        if v > peak_v:
            peak_v, peak_bin = v, b
    wl = sorted(total)
    it = [peak_v if b == peak_bin else total[b] / count[b] for b in wl]

    ow, oi = [], []
    for i, w in enumerate(wl):
        ow.append(w)
        oi.append(it[i])
        if i + 1 < len(wl):
            gap = wl[i + 1] - w
            if BRIDGE_MIN < gap <= BRIDGE_MAX:
                n = int(round(gap / GRID)) - 1
                for k in range(1, n + 1):
                    t = k / (n + 1)
                    ow.append(round(w + gap * t, 1))
                    oi.append(it[i] + (it[i + 1] - it[i]) * t)
    return ow, oi


def unit_peak(wl, inten):
    """The one normalisation: each curve against its own maximum.

    Berlman prints normalised spectra, so unit peak is the intended scale, but
    the plates draw the apex where they draw it -- some a shade under the rule.
    The digitizer deliberately leaves that alone and records the raw maximum;
    dividing by it here is a decision made once, in one place, for every curve,
    and `scaled_by` is what undoes it exactly.
    """
    mx = max(inten) if inten else 0.0
    if mx <= FLOOR:
        return {"wl": [round(w, 1) for w in wl],
                "inten": [round(v, 6) for v in inten]}
    return {"wl": [round(w, 1) for w in wl],
            "inten": [round(v / mx, 6) for v in inten],
            "scaled_by": round(1.0 / mx, 6)}


DUP_TOL = 0.02       # intensity difference below which two traces are one trace
DUP_OVERLAP = 0.90   # ...measured over at least this much shared abscissa


def near_duplicate(a, b):
    """True when two gridded curves are the same trace read twice.

    The parallel strategy fits an upper and a lower edge to a single thick
    stroke and labels the second one emission2, so a plate with one emission
    curve can come back with two.  They agree to within the stroke width, which
    is what this measures.
    """
    if not a or not b:
        return False
    bi = dict(zip(b["wl"], b["inten"]))
    shared = [(v, bi[w]) for w, v in zip(a["wl"], a["inten"]) if w in bi]
    if len(shared) < DUP_OVERLAP * min(len(a["wl"]), len(b["wl"])):
        return False
    return max(abs(x - y) for x, y in shared) < DUP_TOL


def pick_em2(em, candidates):
    """The second emission trace: the longest one that is not a copy of the first.

    Selecting the *last* emission2 reproduces the previous dataset on 17 of its
    18 plates, but only by accident -- it happened to skip the duplicate, which
    the parallel strategy emits first.  On the plates where the duplicate is not
    first it kept a fragment and discarded the real curve: graph-233 published
    160 points and dropped 1040, and graph-181, graph-350 and graph-166 lost
    their longer trace the same way.  Rejecting duplicates on the evidence and
    then taking the longest keeps the curve on every one of them.
    """
    real = [c for c in candidates if not near_duplicate(em, c)]
    if not real:
        return None, len(candidates)
    best = max(real, key=lambda c: len(c["wl"]))
    return best, len(candidates) - 1


def fit_to_ink(rec, frame):
    """Snap every gridded curve onto the printed stroke, in place.

    Same three passes refit_to_ink uses, against the same scan, so "on the ink"
    means here what it meant when that pass was validated.  It runs before the
    normalisation, on frame-true intensities: snapping a curve that has already
    been divided by its own maximum would fit it to the ink at the wrong scale.
    """
    import refit_to_ink as R
    from PIL import Image
    scan = os.path.join(R.SCANS, rec["graph"] + ".webp")
    if not os.path.exists(scan) or not rec.get("xcal"):
        return 0
    with Image.open(scan) as im:
        im.load()
        page_scale = frame["w"] / im.size[0]
        mask, rule, _ = R.build_ink(im, frame, page_scale)
    xcal = rec["xcal"]
    y_bot = frame["y_bottom"]
    height = float(frame["y_bottom"] - frame["y_top"])
    tol_scan = R.TOL_PAGE_PX / page_scale
    moved_total = 0
    for key in ("em", "ab", "em2"):
        c = rec.get(key)
        if not c or not c.get("wl"):
            continue
        wl = np.asarray(c["wl"], float)
        inten = np.asarray(c["inten"], float)
        px = (1e7 / wl - xcal["b"]) / xcal["a"]
        xs = np.round(px / page_scale).astype(int)
        ys = (y_bot - inten * height) / page_scale
        fitted, moved, _, _ = R.snap_to_ink(xs, ys, mask, rule, tol_scan)
        c["inten"] = ((y_bot - fitted * page_scale) / height).tolist()
        moved_total += moved
    return moved_total


def extend_cut_traces(rec, frame):
    """Carry on any trace the tracer abandoned at a crossing, and trim any that
    crossed over and kept following its neighbour.

    The endpoints are found, not listed: find_truncations' probe asks, at each
    end of each curve, whether the ink carries on past where the trace stopped,
    and every endpoint it flags is extended.  extend_truncations does the
    walking, and the same call trims a tail that duplicates another curve, which
    is the mirror failure and the one that would otherwise publish graph-216's
    absorption curve as the first half of its emission spectrum.
    """
    import find_truncations as F
    import extend_truncations as E
    import refit_to_ink as R
    from PIL import Image
    gid = rec["graph"]
    scan = os.path.join(R.SCANS, gid + ".webp")
    if not os.path.exists(scan) or not rec.get("xcal"):
        return 0, 0
    xc = rec["xcal"]
    with Image.open(scan) as im:
        im.load()
        ps = frame["w"] / im.size[0]
        mask, rule, _ = R.build_ink(im, frame, ps)
        yb, yt = frame["y_bottom"], frame["y_top"]
        H = float(yb - yt)

        targets = []
        for k in ("em", "ab", "em2"):
            c = rec.get(k)
            if not c or len(c.get("inten") or []) < 8:
                continue
            wl = np.asarray(c["wl"], float)
            it = np.asarray(c["inten"], float)
            xs = np.round(((1e7 / wl - xc["b"]) / xc["a"]) / ps).astype(int)
            ys = (yb - it * H) / ps
            for at_start in (True, False):
                i = 0 if at_start else -1
                if it[i] <= F.MIN_HEIGHT:
                    continue
                xe = (1e7 / wl[i] - xc["b"]) / xc["a"]
                edge = min(abs(xe - frame["x_left"]), abs(xe - frame["x_right"]))
                if edge / (frame["x_right"] - frame["x_left"]) <= F.EDGE_INSET:
                    continue
                probed, frac = F._endpoint_probe(xs, ys, mask, rule, at_start)
                if probed >= 10 and frac >= F.MIN_HITS:
                    targets.append({"gid": gid, "curve": k,
                                    "end": "start" if at_start else "end"})
        report = E.extend_page(gid, rec, frame, im, targets) if targets else []

    added = sum(r.get("added") or 0 for r in report)
    trimmed = sum(r.get("trimmed") or 0 for r in report)
    return added, trimmed


def one_page(gid):
    import berlman as B
    path = os.path.join(PAGES, gid + ".png")
    try:
        gray, bw = B.load_binary(path)
        B._set_scale(bw.shape[1])
        r = B.digitize(path)
        fr, xcal = r["frame"], r["xcal"]
        if not fr:
            return gid, None, None, {"name": gid, "error": "no frame"}

        m = B.evaluate(r["cmask"],
                       B.reconstruct_mask(r["cmask"].shape, r["curves"]), fr)
        try:
            molecule = B._ocr_name(gray, fr)
        except Exception:
            molecule = ""

        # emission -> em, a second emission -> em2, absorption -> ab
        rec = {"name": molecule, "graph": gid,
               "has_absorption": bool(r.get("has_absorption")),
               "f1": m["f1"]}
        em2_candidates = []
        for c in r["curves"]:
            wn = c.get("wavenumber")
            if wn is None:
                continue
            wn = np.asarray(wn, float)
            it = np.asarray(c["intensity"], float)
            keep = wn > 0
            if keep.sum() < 2:
                continue
            wl_nm = 1e7 / wn[keep]
            ow, oi = to_grid(wl_nm.tolist(), it[keep].tolist())
            if len(ow) < 2:
                continue
            # frame-true for now: the fit needs real pixel rows, and the
            # normalisation comes after it
            curve = {"wl": [round(w, 1) for w in ow],
                     "inten": [float(v) for v in oi]}
            role = c.get("role")
            if role == "emission" and "em" not in rec:
                rec["em"] = curve
            elif role == "absorption" and "ab" not in rec:
                rec["ab"] = curve
            elif role in ("emission", "emission2"):
                em2_candidates.append(curve)

        em2, dropped = pick_em2(rec.get("em"), em2_candidates)
        if em2:
            rec["em2"] = em2

        if xcal:
            rec["xcal"] = {"a": round(float(xcal["a"]), 6),
                           "b": round(float(xcal["b"]), 2),
                           "rmse": round(float(xcal["rmse"]), 1),
                           "source": xcal.get("source"),
                           "lo": round(float(xcal["lo"])),
                           "hi": round(float(xcal["hi"]))}

        frame = {"x_left": int(fr["x_left"]), "x_right": int(fr["x_right"]),
                 "y_top": int(fr["y_top"]), "y_bottom": int(fr["y_bottom"]),
                 "w": int(bw.shape[1]), "h": int(bw.shape[0])}

        # digitize() holds several 5400x3600 arrays and the image-space passes
        # below open a second image; the scoring is done with them, so let them
        # go rather than carry them through steps 3 and 4.  (This was first
        # written to explain a seven-hour projection that turned out to be an
        # unrelated runaway process on the machine, not memory pressure here.
        # It is a small honest saving, not a fix for that.)
        r["cmask"] = r["comps"] = None
        del gray, bw
        moved = fit_to_ink(rec, frame)
        added, trimmed = extend_cut_traces(rec, frame)
        for key in ("em", "ab", "em2"):
            if key in rec:
                rec[key] = unit_peak(rec[key]["wl"], rec[key]["inten"])

        for key, lam in (("em", "lam_em"), ("ab", "lam_abs")):
            c = rec.get(key)
            if c and c["inten"]:
                rec[lam] = int(round(c["wl"][int(np.argmax(c["inten"]))]))
            else:
                rec[lam] = None

        row = {"name": gid, "molecule": molecule, "strategy": r.get("strategy"),
               "n_curves": len(r["curves"]),
               "curves_kept": sum(1 for k in ("em", "ab", "em2") if k in rec),
               "em2_candidates": len(em2_candidates), "em2_dropped": dropped,
               "dots_moved": moved, "pts_added": added, "pts_trimmed": trimmed,
               "xcal_rmse": rec.get("xcal", {}).get("rmse"),
               **{k: m[k] for k in ("f1", "recall", "precision", "col_cov")}}
        return gid, rec, frame, row
    except Exception as ex:            # one bad page must not lose the run
        return gid, None, None, {"name": gid, "error": str(ex)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, help="only the first N pages, for a smoke test")
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    args = ap.parse_args()

    gids = sorted((f[:-4] for f in os.listdir(PAGES) if f.endswith(".png")),
                  key=lambda g: int(g.split("-")[1]))
    if args.limit:
        gids = gids[:args.limit]
    os.makedirs(args.out, exist_ok=True)
    print(f"redigitizing {len(gids)} pages on {args.jobs} workers")

    t0 = time.time()
    spectra, frames, rows, failed = {}, {}, [], []
    done = 0
    with Pool(args.jobs) as pool:
        for gid, rec, frame, row in pool.imap_unordered(one_page, gids, chunksize=2):
            done += 1
            if rec is None:
                failed.append(gid)
            else:
                spectra[gid] = rec
                frames[gid] = frame
            rows.append(row)
            if done % 20 == 0 or done == len(gids):
                el = time.time() - t0
                print(f"  {done}/{len(gids)}  {el:5.0f}s elapsed, "
                      f"{el / done * (len(gids) - done):5.0f}s left", flush=True)

    order = [g for g in gids if g in spectra]
    blob = {"spectra": spectra, "order": order}

    dest = os.path.join(args.out, "spectra_all.json")
    if os.path.exists(dest):
        bak = dest + ".prerun.bak"
        shutil.copy(dest, bak)
        print(f"previous dataset copied to {os.path.basename(bak)}")
    tmp = dest + ".tmp"
    with open(tmp, "w") as f:
        json.dump(blob, f, separators=(",", ":"))
    os.replace(tmp, dest)

    fdest = os.path.join(args.out, "frames.json")
    tmp = fdest + ".tmp"
    with open(tmp, "w") as f:
        json.dump(frames, f, separators=(",", ":"))
    os.replace(tmp, fdest)

    rdest = os.path.join(args.out, "redigitize_report.csv")
    keys = ["name", "molecule", "strategy", "n_curves", "curves_kept",
            "em2_candidates", "em2_dropped", "dots_moved", "pts_added", "pts_trimmed",
            "f1", "recall", "precision", "col_cov", "xcal_rmse", "error"]
    with open(rdest, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda z: z["name"]):
            w.writerow(r)

    curves = sum(1 for r in spectra.values() for k in ("em", "ab", "em2") if k in r)
    at_one = sum(1 for r in spectra.values() for k in ("em", "ab", "em2")
                 if k in r and abs(max(r[k]["inten"]) - 1.0) < 5e-4)
    f1 = np.array([r["f1"] for r in rows if r.get("f1") is not None])
    print(f"\npages: {len(spectra)}/{len(gids)}   curves: {curves}   "
          f"at unit peak: {at_one}/{curves}")
    if len(f1):
        print(f"F1: median {np.median(f1):.4f}  mean {f1.mean():.4f}  "
              f"min {f1.min():.4f}   >=0.95: {(f1 >= 0.95).sum()}/{len(f1)}")
    if failed:
        print(f"failed: {len(failed)} -> {', '.join(failed[:10])}")
    print(f"wrote {dest}\n      {fdest}\n      {rdest}")
    print(f"took {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
