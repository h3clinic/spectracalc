#!/usr/bin/env python3
"""Every corpus-level number the paper quotes, computed from the released files.

The paper previously carried figures typed in by hand from a run that no longer
matched the data directory.  This recomputes them, so the text can be checked
against the corpus in one command and cannot drift from it silently.

Usage:  python3 paper/corpus_stats.py
"""
import collections
import csv
import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "spectra_all.json")
REPORT = os.path.join(ROOT, "data", "redigitize_report.csv")
KEYS = ("em", "ab", "em2")

# The digitizer tags a calibration only when it came from the fallback, so an
# absent source means the primary bottom axis was used.
def from_bottom(xc):
    return (xc.get("source") or "bottom") == "bottom"


# Grade thresholds, as defined in the paper.
F1_EXCELLENT = 0.97
F1_POOR = 0.90
RESID_GOOD = 100.0
DUP_R = 0.999
EDGE_PEAK = 0.5      # a curve peaking at its own endpoint above this is cut short


def corr(a, b):
    """Correlation between two curves over the abscissa they share."""
    bi = dict(zip(b["wl"], b["inten"]))
    sh = [(v, bi[w]) for w, v in zip(a["wl"], a["inten"]) if w in bi]
    if len(sh) < 50:
        return 0.0
    x = np.array([p[0] for p in sh])
    y = np.array([p[1] for p in sh])
    if x.std() == 0 or y.std() == 0:
        return 0.0
    return float(abs(np.corrcoef(x, y)[0, 1]))


def truncated(c):
    """Peaks at its own first or last sample, and high there: cut off mid-rise."""
    if len(c["wl"]) < 20:
        return False
    i = int(np.argmax(c["inten"]))
    return (i < 3 or i > len(c["wl"]) - 4) and max(c["inten"]) > EDGE_PEAK


def main():
    spectra = json.load(open(DATA))["spectra"]
    rep = {r["name"]: r for r in csv.DictReader(open(REPORT))}

    f1, resid, slope, span, curves = [], [], [], [], 0
    lo_all, hi_all, fw, fh = [], [], [], []
    src = collections.Counter()
    trunc_pages, dup_pages = set(), set()

    for gid, r in spectra.items():
        xc = r.get("xcal") or {}
        src[xc.get("source") or "bottom"] += 1
        if xc:
            slope.append(xc["a"])
            resid.append(xc["rmse"])
            span.append(abs(xc["hi"] - xc["lo"]))
        row = rep.get(gid)
        if row and row.get("f1"):
            f1.append(float(row["f1"]))
        present = [k for k in KEYS if k in r]
        curves += len(present)
        for k in present:
            lo_all.append(r[k]["wl"][0])
            hi_all.append(r[k]["wl"][-1])
            if truncated(r[k]):
                trunc_pages.add(gid)
        for i in range(len(present)):
            for j in range(i + 1, len(present)):
                if corr(r[present[i]], r[present[j]]) > DUP_R:
                    dup_pages.add(gid)

    f1 = np.array(f1); resid = np.array(resid)
    slope = np.array(slope); span = np.array(span)

    # grades, in order of severity
    grades = {}
    for gid, r in spectra.items():
        row = rep.get(gid, {})
        v = float(row.get("f1") or 0)
        xc = r.get("xcal") or {}
        rr = xc.get("rmse", 999)
        if gid in dup_pages or v < F1_POOR:
            g = "Poor"
        elif gid in trunc_pages:
            g = "Fair"
        elif v < F1_EXCELLENT or rr > RESID_GOOD or not from_bottom(xc):
            g = "Good"
        else:
            g = "Excellent"
        grades.setdefault(g, []).append((gid, v))

    n = len(spectra)
    print(f"CORPUS  {n} plates, {curves} curves\n")
    print("CALIBRATION")
    print(f"  from the bottom axis        {src.get('bottom', 0)}")
    print(f"  from the top-axis fallback  {src.get('top_axis', 0)}")
    print(f"  slope, median               {np.median(slope):.4f} cm-1/px")
    print(f"  slope, range                {slope.min():.4f} to {slope.max():.4f}")
    print(f"  residual, median            {np.median(resid):.2f} cm-1")
    print(f"  residual, maximum           {resid.max():.2f} cm-1")
    print(f"  residual > 100 cm-1         {(resid > 100).sum()} plates")
    print(f"  span, median                {np.median(span):.0f} cm-1")
    print(f"  wavelength coverage         {min(lo_all):.1f} to {max(hi_all):.1f} nm")
    print(f"\nAGREEMENT WITH THE INK")
    print(f"  F1 median  {np.median(f1):.4f}   mean {f1.mean():.4f}   min {f1.min():.4f}")
    for t in (0.97, 0.95, 0.90):
        print(f"  F1 >= {t:.2f}   {(f1 >= t).sum():3d} plates  ({100 * (f1 >= t).mean():.1f}%)")
    print(f"\nGRADES")
    tot = 0
    for g in ("Excellent", "Good", "Fair", "Poor"):
        rows = grades.get(g, [])
        tot += len(rows)
        vals = np.array([v for _, v in rows]) if rows else np.array([0.0])
        print(f"  {g:10s} {len(rows):4d}  ({100 * len(rows) / n:5.1f}%)   "
              f"median F1 {np.median(vals):.3f}  min {vals.min():.3f}")
    print(f"  {'total':10s} {tot:4d}")
    print(f"\n  cut short at an endpoint: {len(trunc_pages)} plates "
          f"({', '.join(sorted(trunc_pages)[:6])}{' ...' if len(trunc_pages) > 6 else ''})")
    print(f"  duplicated traces (r > {DUP_R}): {len(dup_pages)} plates "
          f"({', '.join(sorted(dup_pages)) or 'none'})")


if __name__ == "__main__":
    main()
