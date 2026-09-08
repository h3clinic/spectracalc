"""f08_ticks: the tick-label strip with each admitted label boxed, green where the
robust fit kept it and orange where the fit trimmed it as a misread. Labels the
admission rule refused get no box. Uses the same band as the digitizer."""
import os, sys
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import berlman as B
from scipy.stats import theilslopes
PAGE = os.path.expanduser("~/onepager/berlman_digitization/berlman_run600/pages/graph-389.png")
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "paper", "figs")

gray, bw = B.load_binary(PAGE); B._set_scale(bw.shape[1])
fr = B.detect_frame(bw)
xl, xr, yb = fr["x_left"], fr["x_right"], fr["y_bottom"]; h = gray.shape[0]
x0, y0, x1, y1 = xl - B._s(50), yb + 2, xr + B._s(50), yb + int(0.032 * h)
toks = B._ocr_axis_band(gray, xl, xr, y0, y1)
def ok(t): return len(t) in (4, 5) and "." not in t and 8000 <= float(t) <= 55000
pts = sorted((cx, float(t), w) for (t, cx, cy, w) in toks if ok(t))
xs = np.array([p[0] for p in pts]); ys = np.array([p[1] for p in pts]); ws = np.array([p[2] for p in pts])
a0, b0, _, _ = theilslopes(ys, xs)
resid = ys - (a0 * xs + b0); resid -= np.median(resid)
mad = np.median(np.abs(resid - np.median(resid)))
tol = max(3.0 * 1.4826 * mad, 0.005 * (abs(ys).max() + 1))
keep = np.abs(resid) <= tol

crop = gray[y0:y1, x0:x1]
fig, ax = plt.subplots(figsize=(18, 18 * crop.shape[0] / crop.shape[1] + 0.05))
ax.imshow(crop, cmap="gray", vmin=0, vmax=255, interpolation="nearest")
pad = 10
for cx, v, w, k in zip(xs, ys, ws, keep):
    ax.add_patch(Rectangle((cx - x0 - w / 2 - pad, 2), w + 2 * pad, crop.shape[0] - 5,
                           fill=False, lw=2.2, ec="#2e8b57" if k else "#e07b1a"))
ax.set_axis_off(); fig.subplots_adjust(0, 0, 1, 1)
fig.savefig(os.path.join(out, "f08_ticks.png"), dpi=150)
print(f"f08_ticks: {len(toks)} tokens, {len(pts)} boxed, {int(keep.sum())} green, {int((~keep).sum())} orange, "
      f"unboxed: {[t for (t,*_) in toks if not ok(t)]}")
