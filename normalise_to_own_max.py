#!/usr/bin/env python3
"""Scale every digitized curve so its own maximum reads exactly 1.000.

For each curve: x = max(intensity), then multiply every point by 1/x.

This is applied to the digitized curve as published, so the result is exact by
construction rather than approached through an anchor.  Earlier passes tried to
define unity from the plot frame, and then from the printed ink apex; both leave
the stored maximum slightly off unity, because the row they anchor on is not the
row the highest stored point occupies.  Whatever the anchor, the number a reader
sees is the maximum of the stored series, so that is what is set to 1.

The factor is recorded as `scaled_by` so the previous scale is recoverable, and
the pass is idempotent: a curve already at 1.000 is left alone, so it cannot
compound across runs.
"""
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "spectra_all.json")
FLOOR = 0.05


def main():
    apply = "--apply" in sys.argv
    doc = json.load(open(DATA))
    spectra = doc["spectra"]
    n, factors, already = 0, [], 0

    for gid, rec in spectra.items():
        for k in ("em", "ab", "em2"):
            c = rec.get(k)
            if not (c and c.get("inten")):
                continue
            it = np.asarray(c["inten"], float)
            x = float(it.max())
            if not (x > FLOOR):
                continue
            if abs(x - 1.0) < 5e-4:
                already += 1
                continue
            c["inten"] = [round(float(v), 6) for v in it * (1.0 / x)]
            c["scaled_by"] = round(float(c.get("scaled_by", 1.0)) / x, 6)
            n += 1
            factors.append(x)

    if apply:
        tmp = DATA + ".tmp"
        json.dump(doc, open(tmp, "w"), separators=(",", ":"))
        os.replace(tmp, DATA)
        print("written:", DATA)

    f = np.array(factors) if factors else np.array([1.0])
    print(f"curves scaled     : {n}")
    print(f"already at 1.000  : {already}")
    print(f"max before scaling: median {np.median(f):.4f}  min {f.min():.4f}  max {f.max():.4f}")
    print(f"  more than 1% off: {int((np.abs(f - 1) > 0.01).sum())}")


if __name__ == "__main__":
    main()
