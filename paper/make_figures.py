#!/usr/bin/env python3
"""Regenerate the paper's calibration figures from the pipeline itself.

The original 27 figures were made ad hoc and the script was not kept, so no
figure in the paper could be reproduced or corrected without redoing it by
hand.  This regenerates the calibration sequence, which is the part of the
method a referee is most likely to interrogate, and it does so by calling
berlman.py rather than by re-describing it: every number that appears in these
figures is program output on plate 175B (graph-389, tetracene).

Figures produced:

  f03_otsu.png     replaces the original, which plotted a y-axis to 1e7 while
                   the visible data reached 1e3, left the 0-100 range empty,
                   and showed no two modes for the threshold to separate
  f28_fourpoints   the four anchors a human sets by hand in WebPlotDigitizer,
                   and where the program finds them instead
  f29_ocrband      the tick-label band, every OCR token, and why each was
                   admitted or rejected
  f30_robustfit    Theil-Sen against ordinary least squares, and the
                   wavelength error the misread ticks would have caused
  f31_trim         intercept re-centring and the median-referenced trim

Usage:  python3 paper/make_figures.py [--out DIR]
"""
import argparse
import os
import sys

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
PAGE = os.path.expanduser(
    "~/onepager/berlman_digitization/berlman_run600/pages/graph-389.png")

# Matches the existing figures: Computer Modern, muted, print-safe.
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["CMU Serif", "DejaVu Serif"],
    "font.size": 9,
    "axes.linewidth": 0.8,
    "figure.dpi": 200,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.02,
})
INK = "#2f3640"
RED = "#b03a2e"
BLUE = "#2f6fd0"
GREEN = "#1e8449"
GREY = "#95a5a6"


def load():
    """Everything the figures need, straight out of the digitizer."""
    import berlman as B
    from scipy.stats import theilslopes
    gray, bw = B.load_binary(PAGE)
    B._set_scale(bw.shape[1])
    fr = B.detect_frame(bw)
    xl, xr, yb, yt = fr["x_left"], fr["x_right"], fr["y_bottom"], fr["y_top"]
    h = gray.shape[0]

    band = (xl - B._s(50), yb + 2, xr + B._s(50), yb + int(0.032 * h))
    toks = B._ocr_axis_band(gray, xl, xr, band[1], band[3])

    def admitted(t):
        if len(t) not in (4, 5) or "." in t:
            return False
        try:
            return 8000 <= float(t) <= 55000
        except ValueError:
            return False

    pts = sorted((cx, float(t)) for (t, cx, cy, *_) in toks if admitted(t))
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])

    a0, b0, _, _ = theilslopes(ys, xs)
    med = float(np.median(ys - (a0 * xs + b0)))
    b1 = b0 + med                                  # re-centre on the consensus
    resid = ys - (a0 * xs + b1)
    mad = np.median(np.abs(resid - np.median(resid)))
    tol = max(3.0 * 1.4826 * mad, 0.005 * (abs(ys).max() + 1))
    keep = np.abs(resid) <= tol
    aF, bF = np.polyfit(xs[keep], ys[keep], 1)
    ao, bo = np.polyfit(xs, ys, 1)                 # what OLS would have given

    return dict(gray=gray, frame=fr, band=band, toks=toks, admitted=admitted,
                xs=xs, ys=ys, keep=keep, a0=a0, b0=b0, b1=b1, med=med, tol=tol,
                resid=resid, aF=aF, bF=bF, ao=ao, bo=bo,
                rmse=float(np.sqrt(np.mean((ys[keep] - (aF * xs[keep] + bF)) ** 2))))


def fig_otsu(D, out):
    """Both classes visible, and the criterion on its true scale.

    The original figure ran the ordinate to 1e7 while the drawn data reached
    1e3, left the whole 0-100 range blank, and showed no two modes for the
    threshold to be separating.  It also implied a sharp optimum.  There is
    none: on this plate the between-class variance varies by 1% across the
    entire range 100-254, so the partition is insensitive to where the
    threshold falls, and saying so is a stronger result than drawing a peak
    that is not there.
    """
    gray = D["gray"]
    lum = gray if gray.ndim == 2 else gray[..., 0]
    hist = np.bincount(lum.ravel(), minlength=256).astype(float)
    total = hist.sum()
    lev = np.arange(256, dtype=float)
    w_b = np.cumsum(hist)
    s_b = np.cumsum(lev * hist)
    w_f = total - w_b
    with np.errstate(divide="ignore", invalid="ignore"):
        m_b = s_b / w_b
        m_f = (float((lev * hist).sum()) - s_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
    between[~np.isfinite(between)] = -1
    thr = int(np.argmax(between))
    ink = hist[:thr + 1].sum()

    fig, (ax, ax2) = plt.subplots(
        1, 2, figsize=(6.6, 2.5), gridspec_kw=dict(width_ratios=[1.5, 1.0], wspace=0.30))

    ax.fill_between(lev[:thr + 1], hist[:thr + 1] + 1e-9, step="mid",
                    color=RED, alpha=0.9, lw=0,
                    label=f"ink, {100 * ink / total:.2f}% of pixels")
    ax.fill_between(lev[thr:], hist[thr:] + 1e-9, step="mid",
                    color=GREY, alpha=0.75, lw=0,
                    label=f"paper, {100 * (total - ink) / total:.2f}%")
    ax.set_yscale("log")
    ax.set_ylim(1, hist.max() * 12)
    ax.set_xlim(0, 255)
    ax.set_xlabel("luminance")
    ax.set_ylabel("pixels (log)")
    ax.axvline(thr, color=INK, lw=1.0, ls="--")
    ax.annotate(f"{hist[250:].sum() / 1e6:.1f}M px\nat 250-255", xy=(252, hist.max()),
                xytext=(196, hist.max() * 1.6), fontsize=7, color=INK, ha="center",
                arrowprops=dict(arrowstyle="->", color=INK, lw=0.7))
    ax.annotate(f"threshold {thr}", xy=(thr, 3), xytext=(thr - 96, 40),
                fontsize=7.5, color=INK,
                arrowprops=dict(arrowstyle="->", color=INK, lw=0.7))
    ax.legend(loc="upper left", fontsize=7, frameon=False)

    # the criterion on its own scale, which is the point: it is nearly flat
    v = between / between.max()
    band = np.where(v >= 0.999)[0]
    ax2.axvspan(band.min(), band.max(), color=GREEN, alpha=0.15, lw=0)
    ax2.plot(lev[60:], v[60:], color=BLUE, lw=1.2)
    ax2.plot([thr], [1.0], "o", ms=4, color=INK)
    ax2.set_ylim(0.985, 1.002)
    ax2.set_xlim(60, 255)
    ax2.set_xlabel("threshold")
    ax2.set_ylabel("between-class variance\n(fraction of maximum)", fontsize=7.5)
    ax2.tick_params(labelsize=7)
    ax2.annotate(f"within 0.1% of maximum\nfor any threshold in {band.min()}-{band.max()}",
                 xy=(band.min() + 4, 0.9995), xytext=(0.06, 0.16),
                 textcoords="axes fraction", fontsize=7, color=GREEN)

    fig.savefig(os.path.join(out, "f03_otsu.png"))
    plt.close(fig)
    return thr, 100 * ink / total


def fig_fourpoints(D, out):
    """The four anchors, on the plate, with their pixel positions and values."""
    gray, fr = D["gray"], D["frame"]
    xl, xr, yt, yb = fr["x_left"], fr["x_right"], fr["y_top"], fr["y_bottom"]
    aF, bF = D["aF"], D["bF"]
    pad = 150
    x0, x1 = max(0, xl - 330), min(gray.shape[1], xr + pad)
    y0, y1 = max(0, yt - pad), min(gray.shape[0], yb + pad)
    crop = gray[y0:y1, x0:x1]

    fig, ax = plt.subplots(figsize=(6.4, 4.0))
    ax.imshow(crop, cmap="gray", vmin=0, vmax=255)
    ax.add_patch(Rectangle((xl - x0, yt - y0), xr - xl, yb - yt,
                           fill=False, ec=BLUE, lw=1.0, ls=(0, (5, 4))))

    wn = lambda x: aF * x + bF
    # X1 and X2 sit on the bottom edge; Y1 and Y2 are the same left edge at two
    # rows, so the ordinate is marked as the span between them rather than as
    # two points that would collide with X1.
    for x, tag, txt, ha in ((xl, "X1", f"px {xl}\n{wn(xl):.0f} cm$^{{-1}}$", "left"),
                            (xr, "X2", f"px {xr}\n{wn(xr):.0f} cm$^{{-1}}$", "right")):
        ax.plot(x - x0, yb - y0, "o", ms=7, mfc="white", mec=BLUE, mew=1.6)
        ax.annotate(f"{tag}   {txt}", xy=(x - x0, yb - y0),
                    xytext=(x - x0 + (10 if ha == "left" else -10), yb - y0 + 96),
                    fontsize=7.5, color=BLUE, ha=ha, va="top",
                    bbox=dict(fc="white", ec="none", alpha=0.85, pad=1.2))
    xarm = xl - x0 - 58
    ax.annotate("", xy=(xarm, yt - y0), xytext=(xarm, yb - y0),
                arrowprops=dict(arrowstyle="<->", color=RED, lw=1.2))
    for y, tag, val in ((yb, "Y1", "0"), (yt, "Y2", "1")):
        ax.plot(xl - x0, y - y0, "o", ms=7, mfc="white", mec=RED, mew=1.6)
        ax.annotate(f"{tag}  px {y}  =  {val}", xy=(xarm, y - y0),
                    xytext=(xarm - 8, y - y0), fontsize=7.5, color=RED,
                    ha="right", va="center",
                    bbox=dict(fc="white", ec="none", alpha=0.85, pad=1.2))

    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    fig.savefig(os.path.join(out, "f28_fourpoints.png"))
    plt.close(fig)


def fig_ocrband(D, out):
    """Every token OCR returned from the tick band, and why each was kept.

    The reason matters more than the verdict: four of these are rejected on
    format or range alone, before any fitting, which is the cheap filter that
    stops most misreads.  Two survive it and have to be caught later by the
    residual trim, which is what Figure~\\ref{fig:trim} shows.
    """
    gray = D["gray"]
    bx0, by0, bx1, by1 = D["band"]
    crop = gray[by0:by1, bx0:bx1]

    def why(t):
        if "." in t:
            return "decimal point"
        if len(t) not in (4, 5):
            return f"{len(t)} digit" + ("s" if len(t) != 1 else "")
        try:
            v = float(t)
        except ValueError:
            return "not a number"
        if not (8000 <= v <= 55000):
            return "out of range"
        return None

    fig = plt.figure(figsize=(6.6, 2.6))
    gs = fig.add_gridspec(2, 1, height_ratios=[1.0, 1.5], hspace=0.12)
    ax = fig.add_subplot(gs[0])
    ax.imshow(crop, cmap="gray", vmin=0, vmax=255, aspect="auto")
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_color(GREY)

    axl = fig.add_subplot(gs[1])
    axl.set_xlim(0, crop.shape[1]); axl.set_ylim(0, 1); axl.axis("off")
    n_ok = 0
    for t in sorted(D["toks"], key=lambda z: z[1]):
        txt, cx = t[0], float(t[1]) - bx0
        r = why(txt)
        ok = r is None
        n_ok += ok
        ax.plot([cx], [crop.shape[0] * 0.88], "v", ms=5,
                color=GREEN if ok else RED, clip_on=False)
        axl.text(cx, 0.92, txt, rotation=90, ha="center", va="top", fontsize=6.8,
                 color=GREEN if ok else RED, fontweight="bold" if ok else "normal")
        if not ok:
            axl.text(cx, 0.36, r, rotation=90, ha="center", va="top",
                     fontsize=5.8, color=RED, style="italic")
    axl.text(0.0, -0.30,
             f"{len(D['toks'])} tokens read      "
             f"{n_ok} admitted: 4-5 digits, no decimal point, "
             f"8000-55000 cm$^{{-1}}$      {len(D['toks']) - n_ok} rejected",
             transform=axl.transAxes, fontsize=7.5, color=INK, va="top")
    fig.savefig(os.path.join(out, "f29_ocrband.png"))
    plt.close(fig)
    return len(D["toks"]), n_ok


def fig_robustfit(D, out):
    """What the two surviving misreads would have done to every wavelength."""
    xs, ys, keep = D["xs"], D["ys"], D["keep"]
    aF, bF, ao, bo = D["aF"], D["bF"], D["ao"], D["bo"]
    fr = D["frame"]
    xl, xr = fr["x_left"], fr["x_right"]
    grid = np.linspace(xl, xr, 200)

    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(6.6, 2.6),
                                  gridspec_kw=dict(width_ratios=[1.25, 1.0], wspace=0.32))
    ax.plot(grid, aF * grid + bF, color=GREEN, lw=1.3, label="Theil-Sen, trimmed")
    ax.plot(grid, ao * grid + bo, color=RED, lw=1.3, ls="--", label=f"least squares, all {len(xs)}")
    ax.plot(xs[keep], ys[keep], "o", ms=4.5, mfc="white", mec=INK, mew=1.0,
            label="ticks kept")
    ax.plot(xs[~keep], ys[~keep], "x", ms=7, color=RED, mew=1.6, label="misread, dropped")
    for x, y in zip(xs[~keep], ys[~keep]):
        ax.annotate(f"{int(y)}", xy=(x, y), xytext=(6, -10),
                    textcoords="offset points", fontsize=7, color=RED)
    ax.set_xlabel("pixel column")
    ax.set_ylabel("wavenumber (cm$^{-1}$)")
    ax.legend(fontsize=7, frameon=False, loc="upper left")

    # at full scale the two lines sit on top of each other, so show where they
    # part: the whole disagreement lives at the ends of the span
    inset = ax.inset_axes([0.56, 0.09, 0.42, 0.34])
    zx = np.linspace(xl, xl + 320, 60)
    inset.plot(zx, aF * zx + bF, color=GREEN, lw=1.2)
    inset.plot(zx, ao * zx + bo, color=RED, lw=1.2, ls="--")
    gap = abs((ao * xl + bo) - (aF * xl + bF))
    inset.annotate("", xy=(xl + 18, aF * (xl + 18) + bF),
                   xytext=(xl + 18, ao * (xl + 18) + bo),
                   arrowprops=dict(arrowstyle="<->", color=INK, lw=0.7))
    inset.text(xl + 40, (aF * xl + bF + ao * xl + bo) / 2,
               f"{gap:.0f} cm$^{{-1}}$", fontsize=6.5, color=INK, va="center")
    inset.set_xticks([]); inset.set_yticks([])
    inset.set_title("left edge, magnified", fontsize=6.5, pad=2)
    for sp in inset.spines.values():
        sp.set_color(GREY)

    # the consequence, in the unit the reader cares about
    wl_r = 1e7 / (aF * grid + bF)
    wl_o = 1e7 / (ao * grid + bo)
    ax2.plot(grid, wl_o - wl_r, color=RED, lw=1.3)
    ax2.axhline(0, color=INK, lw=0.7)
    ax2.set_xlabel("pixel column")
    ax2.set_ylabel("wavelength error (nm)")
    worst = float(np.max(np.abs(wl_o - wl_r)))
    i = int(np.argmax(np.abs(wl_o - wl_r)))
    ax2.plot([grid[i]], [(wl_o - wl_r)[i]], "o", ms=4, color=RED)
    ax2.annotate(f"{worst:.1f} nm at the left edge", xy=(grid[i], (wl_o - wl_r)[i]),
                 xytext=(14, 16), textcoords="offset points", fontsize=7.5, color=RED,
                 arrowprops=dict(arrowstyle="->", color=RED, lw=0.7))
    fig.savefig(os.path.join(out, "f30_robustfit.png"))
    plt.close(fig)
    return worst


_WORDS = ("zero one two three four five six seven eight nine ten eleven twelve "
          "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty").split()


def _n(k):
    """Spell a small count out, as the running text does."""
    return _WORDS[k] if 0 <= k < len(_WORDS) else str(k)


def fig_trim(D, out):
    """Re-centring the intercept, then trimming around the median, not zero.

    Drawn at two scales on purpose.  At full scale the two surviving misreads
    are thousands of wavenumbers out and the trim is obviously necessary; at
    that scale the thing the trim actually does -- shifting the intercept by
    the residual median and testing against a band around it -- is invisible,
    squashed onto the zero line.  The right panel is the same twelve points
    over a range two hundred times smaller.
    """
    xs, ys, keep = D["xs"], D["ys"], D["keep"]
    a0, b0, b1, med, tol = D["a0"], D["b0"], D["b1"], D["med"], D["tol"]
    raw = ys - (a0 * xs + b0)
    cen = ys - (a0 * xs + b1)

    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(6.6, 2.5),
                                  gridspec_kw=dict(wspace=0.30))

    ax.axhline(0, color=INK, lw=0.7)
    ax.plot(xs[keep], raw[keep], "o", ms=4.5, mfc="white", mec=INK, mew=1.0)
    ax.plot(xs[~keep], raw[~keep], "x", ms=8, color=RED, mew=1.8)
    for x, r, v in zip(xs[~keep], raw[~keep], ys[~keep]):
        ax.annotate(f"{int(v)} misread", xy=(x, r), xytext=(-6, -14 if r > 0 else 12),
                    textcoords="offset points", fontsize=6.8, color=RED, ha="right")
    ax.set_xlabel("pixel column")
    ax.set_ylabel("residual (cm$^{-1}$)")
    ax.set_title(f"all {_n(len(xs))} admitted ticks", fontsize=8)

    # the same points, at the scale the trim actually operates on
    ax2.axhspan(-tol, tol, color=GREEN, alpha=0.14, lw=0)
    ax2.axhline(0, color=INK, lw=0.7)
    ax2.axhline(med, color=BLUE, lw=1.0, ls="--")
    ax2.plot(xs[keep], raw[keep], "o", ms=4.0, mfc="none", mec=BLUE, mew=0.9,
             label="before re-centring")
    ax2.plot(xs[keep], cen[keep], "o", ms=4.5, mfc="white", mec=INK, mew=1.0,
             label="after")
    ax2.set_ylim(-tol * 1.9, tol * 1.9)
    ax2.set_xlabel("pixel column")
    ax2.set_ylabel("residual (cm$^{-1}$)")
    ax2.set_title(f"the {_n(int(keep.sum()))} kept, magnified", fontsize=8)
    ax2.annotate(f"median {med:+.1f}", xy=(xs.min(), med), xytext=(2, -12),
                 textcoords="offset points", fontsize=7, color=BLUE)
    ax2.annotate(f"trim at $\\pm${tol:.0f}", xy=(xs.max(), tol),
                 xytext=(-2, 4), textcoords="offset points",
                 fontsize=7, color=GREEN, ha="right")
    ax2.legend(fontsize=6.5, frameon=False, loc="lower left")
    fig.savefig(os.path.join(out, "f31_trim.png"))
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "paper", "figs"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    print("reading plate 175B through the digitizer ...")
    D = load()
    thr, pct = fig_otsu(D, args.out)
    print(f"  f03_otsu        threshold {thr}, ink {pct:.2f}% of the page")
    fig_fourpoints(D, args.out)
    fr = D["frame"]
    print(f"  f28_fourpoints  X1 px {fr['x_left']}  X2 px {fr['x_right']}  "
          f"Y1 px {fr['y_bottom']}  Y2 px {fr['y_top']}")
    n, ok = fig_ocrband(D, args.out)
    print(f"  f29_ocrband     {n} tokens, {ok} admitted")
    worst = fig_robustfit(D, args.out)
    print(f"  f30_robustfit   least squares would err by up to {worst:.1f} nm")
    fig_trim(D, args.out)
    print(f"  f31_trim        kept {int(D['keep'].sum())}/{len(D['xs'])}, "
          f"rmse {D['rmse']:.2f} cm-1")
    print(f"\nwrote 5 figures to {args.out}")


if __name__ == "__main__":
    main()
