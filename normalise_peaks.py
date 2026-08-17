#!/usr/bin/env python3
"""Bring each primary curve's maximum to exactly 1.00, and say so in the record.

Berlman prints normalised spectra, so unit peak is the intended scale.  Fitting
the traces back onto the printed ink left the maxima where the plate actually
draws them — a spread about the 1.00 rule, median 1.000 but individual curves
anywhere from about 0.95 to 1.01 — and after hand-editing an apex a curve can
end up further below.  This restores the stated scale.

Two things keep this from becoming the failure it replaced.  It is idempotent:
a curve already at 1.00 is untouched, so it cannot compound over repeated runs
the way the old in-refresh rescale did.  And it records `peak_scaled_from`, so
the factor applied is in the data rather than being silently baked in — anyone
comparing against the plate can undo it exactly.

em2 is deliberately excluded.  On a CURVE I / CURVE II plate the second trace
is drawn lower on purpose and that ratio is the measurement; scaling it to
unity would destroy the very thing the plate exists to show.
"""
import json
import os
import sys

import numpy as np

import refit_to_ink as R

KEYS = ("em", "ab")          # em2 carries a meaningful ratio — leave it be
FLOOR = 0.5                  # below this the curve is a fragment, not a peak


def normalise(doc, keys=KEYS):
    changed = []
    for gid, rec in doc.items():
        for k in keys:
            c = rec.get(k)
            if not c or not c.get("inten"):
                continue
            it = np.asarray(c["inten"], float)
            mx = float(it.max())
            if not (mx > FLOOR) or abs(mx - 1.0) < 5e-4:
                continue
            c["inten"] = [round(float(v), 6) for v in it / mx]
            c["peak_scaled_from"] = round(mx, 6)
            changed.append((gid, k, mx))
    return changed


def main():
    apply = "--apply" in sys.argv
    blob = json.load(open(R.DATA))
    changed = normalise(blob["spectra"])

    lo = [c for c in changed if c[2] < 0.97]
    print(f"{'applying' if apply else 'DRY RUN'} — curves rescaled: {len(changed)}")
    if changed:
        f = np.array([c[2] for c in changed])
        print(f"  factors: min {f.min():.4f}  median {np.median(f):.4f}  max {f.max():.4f}")
        print(f"  more than 3% low: {len(lo)}")
        for gid, k, mx in sorted(changed, key=lambda t: t[2])[:8]:
            print(f"    {gid:12s} {k:3s} {mx:.4f} -> 1.0000")
    if apply:
        tmp = R.DATA + ".tmp"
        with open(tmp, "w") as fp:
            json.dump(blob, fp, separators=(",", ":"))
        os.replace(tmp, R.DATA)
        print("written:", R.DATA)


if __name__ == "__main__":
    main()
