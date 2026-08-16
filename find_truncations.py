#!/usr/bin/env python3
"""Find curves whose trace stops while the printed stroke keeps going.

Rhodamine 8B is the clear case: its published absorption spectrum rises to
0.4165 at 531.5 nm and simply ends — that endpoint is also its maximum — while
the plate goes on to an absorption peak at 554 nm.  The tracer stopped at the
crossing with the emission curve, so the released "absorption spectrum of
rhodamine B" omits the absorption maximum.  That is a scientific error, not a
cosmetic one, and it cannot be found by any metric that only asks whether the
points it *did* place sit on the ink.

The test here is direct: walk outward from each endpoint, follow the local
slope, and ask whether there is still ink there.  Ink that continues past the
end of a trace means the trace was cut short.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

import refit_to_ink as R

PROBE_COLS = 45        # how far past the endpoint to look, scan px
MIN_HITS = 0.55        # fraction of probed columns that must carry ink
SLOPE_WIN = 25         # points used to estimate the outgoing slope
SEARCH = 22            # scan px band around the extrapolated position
MIN_HEIGHT = 0.15      # below this the curve has reached its baseline
EDGE_INSET = 0.02      # this close to the frame the plate has run out


def _endpoint_probe(xs, ys, mask, rule, at_start):
    """Follow the stroke outward from one end; how far does ink continue?"""
    h, w = mask.shape
    if at_start:
        x0, y0 = xs[0], ys[0]
        nb = slice(0, min(SLOPE_WIN, len(xs)))
    else:
        x0, y0 = xs[-1], ys[-1]
        nb = slice(max(0, len(xs) - SLOPE_WIN), len(xs))

    xw, yw = np.asarray(xs[nb], float), np.asarray(ys[nb], float)
    if len(set(xw.tolist())) < 2:
        return 0, 0.0
    slope = np.polyfit(xw, yw, 1)[0]
    # outward = away from the body of the curve
    body = np.mean(xs)
    step = -1 if x0 < body else 1

    hits = probed = 0
    y = float(y0)
    last = float(y0)
    for d in range(3, PROBE_COLS):
        x = int(x0 + step * d)
        if x < 0 or x >= w:
            break
        probed += 1
        y = last + slope * step
        found = None
        best = SEARCH + 1
        for a, b in R.column_runs(mask, x):
            if rule[a:b + 1].all():
                continue
            if b - a > 60:                     # a merged blob, not a stroke
                continue
            t = y if a <= y <= b else (a if y < a else b)
            g = 0.0 if a <= y <= b else min(abs(y - a), abs(y - b))
            if g < best:
                best, found = g, t
        if found is None:
            last = y
            continue
        hits += 1
        last = found                            # track the stroke, don't drift
    return probed, (hits / probed if probed else 0.0)


def main():
    doc = json.load(open(R.DATA))["spectra"]
    frames = json.load(open(R.FRAMES))
    only = set(sys.argv[1:])

    rows = []
    checked = 0
    gids = [g for g in doc if not only or g in only]
    for n, gid in enumerate(gids, 1):
        rec, fr = doc[gid], frames.get(gid)
        scan = os.path.join(R.SCANS, gid + ".webp")
        if not fr or not rec.get("xcal") or not os.path.exists(scan):
            continue
        with Image.open(scan) as im:
            im.load()
            ps = fr["w"] / im.size[0]
            mask, rule, _ = R.build_ink(im, fr, ps)
        yb, yt = fr["y_bottom"], fr["y_top"]
        H = float(yb - yt)
        xc = rec["xcal"]
        for k in ("em", "ab", "em2"):
            c = rec.get(k)
            if not c or len(c.get("inten") or []) < 8:
                continue
            checked += 1
            wl = np.asarray(c["wl"], float)
            it = np.asarray(c["inten"], float)
            xs = np.round(((1e7 / wl - xc["b"]) / xc["a"]) / ps).astype(int)
            ys = (yb - it * H) / ps
            for at_start in (True, False):
                i = 0 if at_start else -1
                # A curve that has come down to the baseline is finished, and
                # ink beyond it is the axis or the neighbouring trace.  A curve
                # that reaches the frame edge is finished too — the plate has
                # simply run out.  Only a trace that stops partway UP is cut.
                if it[i] <= MIN_HEIGHT:
                    continue
                xe = (1e7 / wl[i] - xc["b"]) / xc["a"]
                edge = min(abs(xe - fr["x_left"]), abs(xe - fr["x_right"]))
                if edge / (fr["x_right"] - fr["x_left"]) <= EDGE_INSET:
                    continue
                probed, frac = _endpoint_probe(xs, ys, mask, rule, at_start)
                if probed >= 10 and frac >= MIN_HITS:
                    rows.append({
                        "gid": gid, "name": rec.get("name"), "curve": k,
                        "end": "start" if at_start else "end",
                        "nm": round(float(wl[i]), 1),
                        "inten": round(float(it[i]), 3),
                        "peak": round(float(it.max()), 3),
                        "ink_continues_frac": round(frac, 2),
                        "cols_probed": probed,
                    })
        if n % 40 == 0:
            print(f"  {n}/{len(gids)}", flush=True)

    rows.sort(key=lambda r: -r["ink_continues_frac"])
    out = os.path.join(R.ROOT, "data", "truncations.json")
    with open(out, "w") as f:
        json.dump(rows, f, indent=1)

    print(f"\ncurves checked      : {checked}")
    print(f"truncated endpoints : {len(rows)}  "
          f"on {len(set(r['gid'] for r in rows))} pages")
    print(f"written             : {out}\n")
    print(f"{'gid':12s} {'compound':24s} {'c':4s} {'end':6s} {'I@end':>6s} "
          f"{'peak':>6s} {'ink':>5s}")
    for r in rows[:25]:
        print(f"{r['gid']:12s} {str(r['name'])[:24]:24s} {r['curve']:4s} "
              f"{r['end']:6s} {r['inten']:6.3f} {r['peak']:6.3f} "
              f"{r['ink_continues_frac']:5.2f}")


if __name__ == "__main__":
    main()
