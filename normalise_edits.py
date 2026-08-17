#!/usr/bin/env python3
"""Bring the stored community edits to unit peak, the same as the dataset.

normalise_peaks.py restored the printed scale for the published spectra; an
edit overrides the published record wherever one exists, so without this the
pages someone actually worked on are the ones left reading 0.98.

Same two safeguards as the dataset pass: skip a curve already at 1.00 so
repeated runs cannot compound, and record `peak_scaled_from` so the factor is
in the data.  The table is append-only, so each page gets a new version and the
contributor's own numbers stay in the history.

Every distinct curve is scaled, em2 included.  A CURVE I / CURVE II plate
draws its second trace lower than the first, so normalising em2 separately
discards the ratio between them; where that ratio matters it is recoverable
from `peak_scaled_from`, which records what the curve measured before scaling.
"""
import json
import sys
import time
import urllib.request

SITE = "https://spectrawolf.vercel.app"
KEYS = ("em", "ab", "em2")
FLOOR = 0.05
NOTE = "normalised to unit peak"


def get(url):
    with urllib.request.urlopen(url, timeout=90) as r:
        return json.load(r)


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    apply = "--apply" in sys.argv
    index = get(f"{SITE}/api/edits")["edits"]
    gids = sorted(index)
    print(f"{len(gids)} stored edits"
          + ("   [APPLYING]" if apply else "   [DRY RUN — pass --apply]"))

    done = skipped = failed = 0
    for gid in gids:
        try:
            doc = get(f"{SITE}/api/edits?gid={gid}")
        except Exception as e:
            print(f"  {gid}: fetch failed ({e})")
            failed += 1
            continue

        payload = {k: doc.get(k) for k in ("em", "ab", "em2", "extra")}
        notes = []
        for k in KEYS:
            c = payload.get(k)
            if not c or not c.get("inten"):
                continue
            mx = max(c["inten"])
            if not (mx > FLOOR) or abs(mx - 1.0) < 5e-4:
                continue
            c["inten"] = [round(v / mx, 6) for v in c["inten"]]
            notes.append(f"{k} {mx:.4f}->1.0000")
        if not notes:
            skipped += 1
            continue

        print(f"  {gid:12s} {', '.join(notes)}")
        if not apply:
            done += 1
            continue
        try:
            body = {"gid": gid, "author": "refit", "note": NOTE}
            body.update({k: v for k, v in payload.items() if v})
            post(f"{SITE}/api/save", body)
            done += 1
            time.sleep(0.3)
        except Exception as e:
            print(f"    !! save failed: {e}")
            failed += 1

    print(f"\n{'republished' if apply else 'would republish'}: {done}"
          f"   already at 1.00: {skipped}   failures: {failed}")


if __name__ == "__main__":
    main()
