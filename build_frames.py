#!/usr/bin/env python3
"""Compute the plot-frame geometry for every Berlman page and cache it.

spectra_all.json freezes each page's x calibration but not its frame, and the
frame is what turns a normalized intensity back into a pixel row — needed to
place dots on the scan in the browser editor.  Detection is the same routine
the digitizer uses, run once here and cached to data/frames.json so the site
build stays fast.

Usage:  python3 build_frames.py [--force]
"""
import json
import os
import sys
from multiprocessing import Pool

REPO = os.path.dirname(os.path.abspath(__file__))
PAGES = os.path.expanduser("~/onepager/berlman_digitization/berlman_run600/pages")
OUT = os.path.join(REPO, "data", "frames.json")

sys.path.insert(0, os.path.expanduser("~/onepager/berlman_digitization"))


def frame_of(gid):
    import berlman as B
    path = os.path.join(PAGES, gid + ".png")
    try:
        gray, bw = B.load_binary(path)
        B._set_scale(bw.shape[1])
        fr = B.detect_frame(bw)
        if not fr:
            return gid, None
        return gid, {"x_left": int(fr["x_left"]), "x_right": int(fr["x_right"]),
                     "y_top": int(fr["y_top"]), "y_bottom": int(fr["y_bottom"]),
                     "w": int(bw.shape[1]), "h": int(bw.shape[0])}
    except Exception:
        return gid, None


def main():
    with open(os.path.join(REPO, "data", "spectra_all.json")) as f:
        order = json.load(f)["order"]
    if os.path.exists(OUT) and "--force" not in sys.argv:
        with open(OUT) as f:
            have = json.load(f)
        missing = [g for g in order if g not in have]
        if not missing:
            print(f"frames.json already covers all {len(order)} pages")
            return
        print(f"filling {len(missing)} missing frames")
        todo = missing
    else:
        have, todo = {}, order

    with Pool(8) as pool:
        for gid, fr in pool.imap_unordered(frame_of, todo, chunksize=4):
            if fr:
                have[gid] = fr

    failed = [g for g in order if g not in have]
    with open(OUT, "w") as f:
        json.dump(have, f, separators=(",", ":"), sort_keys=True)
    print(f"frames.json: {len(have)}/{len(order)} pages"
          + (f", FAILED: {failed}" if failed else ""))


if __name__ == "__main__":
    main()
