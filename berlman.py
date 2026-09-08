#!/usr/bin/env python3
"""
berlman.py — one program that digitizes every spectra plate in Berlman's
"Handbook of Fluorescence Spectra of Aromatic Molecules" (2nd Ed., 1971) and
self-evaluates the result.

It is self-contained and adaptive: the same code handles every graph (it tries
four extraction strategies per page and keeps the best-scoring one), so you run
it once — you do not edit it per plate.

Pipeline (all in one run):
  render PDF pages -> detect frame -> OCR-calibrate axes -> isolate curves ->
  trace (skeleton / columnar / parallel) -> self-evaluate (reconstruct & score)
  -> write CSV data + overlays + report -> [validate vs PhotoChemCAD] ->
  [export PhotoChemCAD-format] -> [dashboard.html]

Usage:
  python3 berlman.py "Handbook ... Berlman.pdf"                 # do everything
  python3 berlman.py book.pdf --out ./out --pages 124-431       # options
  python3 berlman.py book.pdf --no-validate --no-export         # skip steps
  python3 berlman.py --digitize-only page.png                   # one image

Dependencies: numpy, scipy, opencv-python, scikit-image, sknw, pytesseract
(+ tesseract), matplotlib, Pillow; poppler (pdftoppm) for rendering.
"""
import os, re, sys, csv, json, glob, time, argparse, subprocess, shutil
from multiprocessing import Pool
import numpy as np
import cv2

# ---- resolution scaling -------------------------------------------------
# All pixel-space constants below were tuned at 300 DPI (2700 px wide, ~3 px
# printed line). _SCALE adapts them to whatever DPI the pages were rendered
# at, so 600 DPI behaves identically (only finer-sampled).
_SCALE = 1.0

def _set_scale(width_px):
    global _SCALE
    _SCALE = max(0.5, float(width_px) / 2700.0)

def _s(v, minimum=1):
    """Scale a 300-DPI pixel constant to the current resolution."""
    return max(minimum, int(round(v * _SCALE)))

def _odd(v, minimum=3):
    n = _s(v, minimum)
    return n if n % 2 == 1 else n + 1

# ─────────────────────────────────────────────────────────────────────────────
# 1. FRAME DETECTION & AXIS CALIBRATION
# ─────────────────────────────────────────────────────────────────────────────

def load_binary(path):
    """Return (gray, binary) where binary is uint8 {0,255}, 255 = ink (dark)."""
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(path)
    _, bw = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    return img, bw


def detect_frame(bw):
    """Detect the rectangular plot frame via morphological line extraction.
    The borders are the only long straight lines; curves aren't straight and
    text is short. Region-based selection tolerates a border partly broken by a
    crossing curve."""
    h, w = bw.shape
    ink = (bw > 0).astype(np.uint8)
    hlines = cv2.morphologyEx(ink, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (_s(7), 1)))
    hlines = cv2.morphologyEx(hlines, cv2.MORPH_OPEN,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w // 12), 1)))
    vlines = cv2.morphologyEx(ink, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (1, _s(7))))
    vlines = cv2.morphologyEx(vlines, cv2.MORPH_OPEN,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h // 12))))
    hrow = hlines.sum(axis=1).astype(float)
    vcol = vlines.sum(axis=0).astype(float)

    def pick_two(cov, near, far):
        m = cov.max()
        if m <= 0:
            return None
        a = near[0] + int(np.argmax(cov[near[0]:near[1]]))
        b = far[0] + int(np.argmax(cov[far[0]:far[1]]))
        if cov[a] < 0.2 * m or cov[b] < 0.2 * m:
            return None
        return sorted((a, b))

    H, Wd = bw.shape
    hb = pick_two(hrow, (0, int(0.5 * H)), (int(0.5 * H), H))
    vb = pick_two(vcol, (0, int(0.5 * Wd)), (int(0.5 * Wd), Wd))
    if hb is None or vb is None or hb[1] - hb[0] < 0.3 * H or vb[1] - vb[0] < 0.3 * Wd:
        raise RuntimeError(f"frame detection failed hb={hb} vb={vb}")
    return dict(x_left=int(vb[0]), x_right=int(vb[1]),
                y_top=int(hb[0]), y_bottom=int(hb[1]))


def _ocr_numbers(gray, x0, y0, x1, y1, psms=(6, 11), scale=3):
    """OCR a strip; return [(value_str, cx, cy, bbox_w)] for numeric tokens."""
    import pytesseract
    crop = gray[max(0, y0):y1, max(0, x0):x1]
    if crop.size == 0:
        return []
    crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    best = []
    for psm in psms:
        cfg = f"--psm {psm} -c tessedit_char_whitelist=0123456789.-"
        data = pytesseract.image_to_data(crop, config=cfg,
                                         output_type=pytesseract.Output.DICT)
        out = []
        for i, txt in enumerate(data["text"]):
            t = txt.strip()
            if not t or not re.fullmatch(r"-?\d+(\.\d+)?", t):
                continue
            cx = x0 + (data["left"][i] + data["width"][i] / 2) / scale
            cy = y0 + (data["top"][i] + data["height"][i] / 2) / scale
            bw = data["width"][i] / scale
            out.append((t, cx, cy, bw))
        if len(out) > len(best):
            best = out
    return best


def _ocr_axis_band(gray, xl, xr, y0, y1):
    """OCR an axis-label strip at two horizontal margins and union the tokens.

    Labels at the box edges are centred on xl/xr and extend ~70 px past them
    at 600 dpi, so a narrow margin slices the outer digit off and OCR reads
    15000 as 5000.  A wide margin fixes that, but Tesseract's layout analysis
    is not monotonic in crop size: on some plates the wider crop drops labels
    the narrow one read cleanly (graph-288 goes 7 -> 0 tokens).  Running both
    and taking the union never loses a token, and captures both edge labels
    on 259 of 308 plates against 71 for the narrow margin alone.
    """
    toks = []
    for m in (_s(25), _s(50)):
        toks += _ocr_numbers(gray, xl - m, y0, xr + m, y1)
    toks = _split_merged_toks(toks)
    out = []
    for t in sorted(toks, key=lambda z: z[1]):
        if not any(o[0] == t[0] and abs(o[1] - t[1]) <= _s(15) for o in out):
            out.append(t)
    return out


def _robust_linfit(px, vals):
    """Theil-Sen (median-slope) fit, tolerant of OCR misreads. -> (a,b,rmse,n).

    Two hard-won details: scipy anchors the intercept on median(y) -
    slope*median(x), which a single misread tick sitting at the median
    position can corrupt — so the intercept is re-centred on the residual
    MEDIAN.  And the outlier trim must test residuals around that median,
    not around zero, or an offset line trims the GOOD ticks and keeps the
    misread one.
    """
    from scipy.stats import theilslopes
    px = np.asarray(px, float); vals = np.asarray(vals, float)
    if len(px) < 3:
        if len(px) < 2:
            return None
        a, b = np.polyfit(px, vals, 1)
        return a, b, 0.0, 2
    a, b, _, _ = theilslopes(vals, px)
    resid = vals - (a * px + b)
    med = float(np.median(resid))
    b += med                     # re-centre on the consensus of ticks
    resid = resid - med
    mad = np.median(np.abs(resid - np.median(resid)))
    tol = max(3.0 * 1.4826 * mad, 0.005 * (abs(vals).max() + 1))
    keep = np.abs(resid) <= tol
    if keep.sum() >= 3:
        a, b = np.polyfit(px[keep], vals[keep], 1)
        resid = vals[keep] - (a * px[keep] + b)
    else:
        keep = np.ones(len(px), bool)
    return a, b, float(np.sqrt(np.mean(resid ** 2))), int(keep.sum())


def _split_merged_toks(toks):
    """Split OCR tokens where adjacent tick labels were merged into one string.
    E.g. '3220033200' -> two tokens for 32200 and 33200.
    Uses bounding box width to estimate individual token positions."""
    out = []
    for tok in toks:
        t, cx, cy = tok[0], tok[1], tok[2]
        bw = tok[3] if len(tok) > 3 else 0
        if len(t) <= 5 or "." in t:
            out.append(tok)
            continue
        split_done = False
        for w in (5, 4):
            if len(t) % w != 0 or len(t) // w < 2:
                continue
            parts = [t[i:i+w] for i in range(0, len(t), w)]
            if all(p.isdigit() and 8000 <= int(p) <= 55000 for p in parts):
                n_parts = len(parts)
                half = bw / 2.0 if bw > 0 else len(t) * 3.0
                for j, p in enumerate(parts):
                    frac = (j + 0.5) / n_parts
                    est_cx = cx - half + frac * 2 * half
                    out.append((p, est_cx, cy, bw / n_parts))
                split_done = True
                break
        if not split_done:
            out.append(tok)
    return out


def _consensus_linfit(px, wn, tol=400.0, min_inliers=3):
    """Largest set of tick labels that agree on one straight line.

    A trimmed robust fit copes with a single misread tick, but OCR on a worn
    plate can garble two of five (graph-175 reads 3500 as 3300 *and* 2500 as
    2900), and the trim is then outvoted.  Printed ticks are exactly collinear,
    so instead of trimming outliers we search for the largest consensus: every
    pair of labels proposes a line, and the line the most labels sit on wins.
    Three agreeing ticks pin the axis; the misreads simply never join a set.
    """
    n = len(px)
    if n < min_inliers:
        return None
    best = None
    for i in range(n):
        for j in range(i + 1, n):
            dx = px[j] - px[i]
            if abs(dx) < 1e-6:
                continue
            a = (wn[j] - wn[i]) / dx
            b = wn[i] - a * px[i]
            keep = [k for k in range(n) if abs(wn[k] - (a * px[k] + b)) <= tol]
            if len(keep) < min_inliers:
                continue
            xs = np.array([px[k] for k in keep], float)
            ys = np.array([wn[k] for k in keep], float)
            aa, bb = np.polyfit(xs, ys, 1)
            rms = float(np.sqrt(np.mean((ys - (aa * xs + bb)) ** 2)))
            score = (len(keep), -rms)
            if best is None or score > best[0]:
                best = (score, aa, bb, rms, len(keep))
    if best is None:
        return None
    _, a, b, rms, k = best
    return float(a), float(b), rms, k


def _top_axis_xcal(gray, frame):
    """The top wavelength axis as a wavenumber calibration, or None.

    Used whenever the bottom axis cannot be read.  The two axes are printed
    independently, so a page whose wave-number labels are smudged or cropped is
    often perfectly legible along the top in angstroms.
    """
    xl, xr = frame["x_left"], frame["x_right"]
    top = _calibrate_x_from_top(gray, frame)
    if top is None:
        return None
    # four agreeing ticks is the comfortable case; three is accepted only when
    # they are essentially exactly collinear, which printed ticks are and a
    # coincidence of misreads is not
    if top["n"] < 3 or (top["n"] == 3 and top["rmse"] > 60.0):
        return None
    ta, tb = top["a"], top["b"]
    lo, hi = sorted([ta * xl + tb, ta * xr + tb])
    if lo < 5000 or hi > 65000 or hi - lo < 5000:
        return None
    if top["rmse"] > max(150.0, 0.008 * (hi - lo)):
        return None
    return dict(a=ta, b=tb, rmse=top["rmse"], n=top["n"],
                lo=ta * xl + tb, hi=ta * xr + tb, source="top_axis")


def calibrate_x(gray, frame):
    """Bottom wave-number axis: pixel_x -> wavenumber (cm^-1).

    Every route out of here that cannot produce a trustworthy bottom fit tries
    the top wavelength axis before giving up.  Previously only the *poor fit*
    branch did, so a page whose bottom labels were unreadable at all was
    withheld even when its top axis was pristine.
    """
    xl, xr, yb = frame["x_left"], frame["x_right"], frame["y_bottom"]
    h = gray.shape[0]
    toks = _ocr_axis_band(gray, xl, xr, yb + 2, yb + int(0.032 * h))
    pts = sorted((cx, float(t)) for (t, cx, cy, *_) in toks
                 if len(t) in (4, 5) and "." not in t and 8000 <= float(t) <= 55000)
    if len(pts) < 2:
        return _top_axis_xcal(gray, frame)
    fit = _robust_linfit([p[0] for p in pts], [p[1] for p in pts])
    if fit is None:
        return _top_axis_xcal(gray, frame)
    a, b, rmse, n = fit
    lo, hi = a * xl + b, a * xr + b
    if lo > hi:
        lo, hi = hi, lo
    if lo < 5000 or hi > 65000 or hi - lo < 5000:
        return _top_axis_xcal(gray, frame)
    # quality gate: a healthy tick fit lands within tens of cm-1; hundreds
    # means misread ticks won the fit and every exported wavelength is wrong.
    # When the bottom axis is unreadable, fall back to the independent top
    # wavelength axis rather than exporting corrupt wavelengths.
    if rmse > max(150.0, 0.008 * (hi - lo)):
        return _top_axis_xcal(gray, frame)
    result = dict(a=a, b=b, rmse=rmse, n=n, lo=a * xl + b, hi=a * xr + b)
    # cross-check against the TOP wavelength axis (Å): an independent OCR of
    # a different set of printed numbers must agree with the bottom fit
    top = _calibrate_x_from_top(gray, frame)
    if top is not None:
        span = hi - lo
        d1 = abs((a * xl + b) - (top["a"] * xl + top["b"]))
        d2 = abs((a * xr + b) - (top["a"] * xr + top["b"]))
        result["top_axis_disagreement"] = round(max(d1, d2) / span, 4)
    return result


def _calibrate_x_from_top(gray, frame):
    """Independent pixel->wavenumber fit from the TOP wavelength axis (Å).

    Wavelength tick values converted by wn = 1e8 / Å are collinear in pixel
    space, so the same robust fit applies.  Used only to cross-check the
    bottom-axis calibration.
    """
    xl, xr, yt = frame["x_left"], frame["x_right"], frame["y_top"]
    h = gray.shape[0]
    y0 = max(0, yt - int(0.045 * h))
    toks = _ocr_axis_band(gray, xl, xr, y0, yt - 4)
    pts = sorted((cx, 1e8 / float(t)) for (t, cx, cy, *_) in toks
                 if len(t) == 4 and "." not in t and 2000 <= float(t) <= 7000)
    if len(pts) < 3:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]

    def _usable(fit):
        if fit is None:
            return None
        a, b, rmse, n = fit
        lo, hi = sorted([a * xl + b, a * xr + b])
        if lo < 5000 or hi > 65000 or hi - lo < 5000 or rmse > 300:
            return None
        return dict(a=a, b=b, rmse=rmse, n=n)

    out = _usable(_robust_linfit(xs, ys))
    if out is not None:
        return out
    # the trimmed fit lost to multiple misread ticks — fall back to the
    # largest set of labels that agree on one line
    return _usable(_consensus_linfit(xs, ys))


def calibrate_right_y(gray, frame):
    """Right molar-extinction axis (anchored 0 at bottom): pixel_y -> extinction."""
    xr, yt, yb = frame["x_right"], frame["y_top"], frame["y_bottom"]
    w = gray.shape[1]
    toks = _ocr_numbers(gray, xr + int(0.004 * w), yt - 25, xr + int(0.06 * w), yb + 25)
    slopes, used = [], []
    for (t, cx, cy, *_) in toks:
        v = float(t)
        if v <= 0 or "." in t or (yb - cy) <= 20:
            continue
        slopes.append(v / (yb - cy)); used.append((cy, v))
    if len(slopes) < 3:
        return None
    slopes = np.array(slopes); med = np.median(slopes)
    keep = np.abs(slopes - med) <= 0.08 * med + 1e-9
    if keep.sum() < 3:
        return None
    slope = float(np.median(slopes[keep]))
    a, b = -slope, slope * yb
    used = np.array(used)
    resid = used[:, 1] - (a * used[:, 0] + b)
    rmse = float(np.sqrt(np.mean(resid[np.abs(resid) < 0.15 * used[:, 1].max()] ** 2)))
    return dict(a=a, b=b, rmse=rmse, n=int(keep.sum()), top=a * yt + b, bottom=a * yb + b)


def px_to_intensity(y_px, frame):
    yt, yb = frame["y_top"], frame["y_bottom"]
    return (yb - y_px) / (yb - yt)


# ─────────────────────────────────────────────────────────────────────────────
# 2. CURVE ISOLATION
# ─────────────────────────────────────────────────────────────────────────────

def isolate_curves(bw, frame, width_frac=0.28):
    """Binary image with only curve pixels: strip borders/ticks/text/structure.
    Keep components wide (> width_frac of plot) and thin (low bbox fill).
    Reject chemical-structure diagrams (compact blobs in the upper plot area)."""
    xl, xr, yt, yb = frame["x_left"], frame["x_right"], frame["y_top"], frame["y_bottom"]
    plotW = xr - xl
    plotH = yb - yt
    mask = np.zeros_like(bw)
    mask[yt:yb + 1, xl:xr + 1] = bw[yt:yb + 1, xl:xr + 1]
    bwid = _s(4)
    mask[yt - bwid:yt + bwid + 1, :] = 0
    mask[yb - bwid:yb + bwid + 1, :] = 0
    mask[:, xl - bwid:xl + bwid + 1] = 0
    mask[:, xr - bwid:xr + bwid + 1] = 0
    # Blank chemical structure diagrams in the upper-right of the plot.
    # Structures are compact blobs (roughly square, moderate fill) that sit
    # above the spectral curves. Only blank isolated blobs — never blank
    # pixels that are vertically connected to curve pixels below, which would
    # clip curves that pass through the structure region.
    struct_x0 = xl + int(0.60 * plotW)
    struct_y1 = yt + int(0.30 * plotH)
    struct_region = mask[yt:struct_y1, struct_x0:xr + 1].copy()
    if struct_region.any():
        sn, slab, sstats, _ = cv2.connectedComponentsWithStats(struct_region, 8)
        for si in range(1, sn):
            sx, sy, sw, sh, sa = sstats[si]
            sfill = sa / float(sw * sh + 1)
            aspect = float(min(sw, sh)) / max(sw, sh, 1)
            # Only blank if it looks like a structure (square-ish, filled)
            # AND does not extend into the lower part of the plot (curves do)
            bottom_edge = yt + sy + sh
            if (aspect > 0.4 and sfill > 0.04 and sw < 0.30 * plotW
                    and sh < 0.25 * plotH and bottom_edge < yt + int(0.28 * plotH)):
                mask[yt + sy:yt + sy + sh, struct_x0 + sx:struct_x0 + sx + sw] = 0
    b = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_RECT, (_s(17), 1)))
    b = cv2.morphologyEx(b, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_RECT, (1, _s(11))))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(b, connectivity=8)
    keep = np.zeros_like(mask)
    comps = []
    for i in range(1, n):
        x, y, ww, hh, area = stats[i]
        fill = area / float(ww * hh + 1)
        if ww >= width_frac * plotW and fill < 0.07:
            keep[lab == i] = 255
            comps.append(dict(w=int(ww), h=int(hh), area=int(area)))
    result = cv2.bitwise_and(keep, mask)
    n2, lab2, stats2, _ = cv2.connectedComponentsWithStats(result, 8)
    for i in range(1, n2):
        _, _, ww2, _, _ = stats2[i]
        if ww2 < 0.05 * plotW:
            result[lab2 == i] = 0
    return result, comps


def column_runs(col, yt, yb, merge_gap=None):
    merge_gap = _s(4) if merge_gap is None else merge_gap
    """Ink runs (lo,hi) in one column, within the plot band."""
    ys = np.where(col > 0)[0]
    ys = ys[(ys >= yt - 3) & (ys <= yb + 3)]
    if len(ys) == 0:
        return []
    runs = []
    start = prev = ys[0]
    for y in ys[1:]:
        if y - prev <= merge_gap:
            prev = y
        else:
            runs.append((start, prev)); start = prev = y
    runs.append((start, prev))
    return runs


# ─────────────────────────────────────────────────────────────────────────────
# 3. SKELETON-NETWORK TRACER
# ─────────────────────────────────────────────────────────────────────────────

def _edge_dir(pts, node_o, k=18):
    pts = np.asarray(pts, float)
    if np.hypot(*(pts[0] - node_o)) <= np.hypot(*(pts[-1] - node_o)):
        v = pts[:min(k, len(pts))][-1] - pts[0]
    else:
        v = pts[-min(k, len(pts)):][0] - pts[-1]
    n = np.hypot(*v)
    return v / n if n else np.zeros(2)


def skel_trace(curve_mask, frame, spur_len=None, min_span_frac=0.13, pair_dot=-0.1):
    spur_len = _s(22) if spur_len is None else spur_len
    """Trace curves via skeleton graph; junctions resolved by straightest
    continuation so the emission/absorption crossing splits correctly."""
    import sknw
    from skimage.morphology import skeletonize
    xl, xr = frame["x_left"], frame["x_right"]
    plotW = xr - xl
    G = sknw.build_sknw(skeletonize(curve_mask > 0), multi=True)
    if G.number_of_edges() == 0:
        return []

    node_merge = _s(20)
    nlist = list(G.nodes())
    ocoord = {n: np.asarray(G.nodes[n]["o"], float) for n in nlist}
    parent = {n: n for n in nlist}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a

    for i in range(len(nlist)):
        for j in range(i + 1, len(nlist)):
            if np.hypot(*(ocoord[nlist[i]] - ocoord[nlist[j]])) <= node_merge:
                parent[find(nlist[i])] = find(nlist[j])
    clusters = {}
    for n in nlist:
        clusters.setdefault(find(n), []).append(n)
    cnode_o = {r: np.mean([ocoord[n] for n in mem], axis=0) for r, mem in clusters.items()}

    edges = []
    for u, v, key, data in G.edges(keys=True, data=True):
        ru, rv = find(u), find(v)
        pts = np.asarray(data["pts"], float)
        if ru == rv and len(pts) < node_merge * 2:
            continue
        edges.append(dict(u=ru, v=rv, pts=pts))

    deg = {n: 0 for n in cnode_o}
    for e in edges:
        deg[e["u"]] += 1; deg[e["v"]] += 1
    alive = [True] * len(edges)
    for i, e in enumerate(edges):
        if len(e["pts"]) < spur_len and (deg[e["u"]] == 1 or deg[e["v"]] == 1):
            alive[i] = False; deg[e["u"]] -= 1; deg[e["v"]] -= 1

    inc = {n: [] for n in cnode_o}
    for i, e in enumerate(edges):
        if alive[i]:
            inc[e["u"]].append(i); inc[e["v"]].append(i)
    cur_deg = {n: 0 for n in cnode_o}
    for i, e in enumerate(edges):
        if alive[i]:
            cur_deg[e["u"]] += 1; cur_deg[e["v"]] += 1

    def far(i, n):
        e = edges[i]
        return e["v"] if e["u"] == n else e["u"]

    pair = {}
    for n, members in inc.items():
        members = [i for i in members if alive[i]]
        if len(members) < 2:
            continue
        through = [i for i in members
                   if not (cur_deg[far(i, n)] == 1 and len(edges[i]["pts"]) < _s(70))]
        if len(through) < 2:
            through = members
        if len(through) == 2:
            ia, ib = through
            pair[(ia, n)] = ib; pair[(ib, n)] = ia
            continue
        members = through
        dirs = {i: _edge_dir(edges[i]["pts"], cnode_o[n]) for i in members}
        cand = sorted((float(np.dot(dirs[members[a]], dirs[members[b]])), members[a], members[b])
                      for a in range(len(members)) for b in range(a + 1, len(members)))
        used = set()
        for dot, ia, ib in cand:
            if ia in used or ib in used or dot > pair_dot:
                continue
            used.add(ia); used.add(ib)
            pair[(ia, n)] = ib; pair[(ib, n)] = ia

    visited = set()
    curves = []
    for start in range(len(edges)):
        if not alive[start] or start in visited:
            continue
        seq = [start]; visited.add(start)
        for anchor in (edges[start]["v"], edges[start]["u"]):
            cur, node = start, anchor
            while (cur, node) in pair:
                nxt = pair[(cur, node)]
                if nxt in visited:
                    break
                visited.add(nxt)
                e = edges[nxt]
                node = e["v"] if e["u"] == node else e["u"]
                seq.insert(0, nxt) if anchor == edges[start]["u"] else seq.append(nxt)
                cur = nxt
        pts = _skel_concat(seq, edges)
        if len(pts) < 5:
            continue
        if pts[:, 1].max() - pts[:, 1].min() >= min_span_frac * plotW:
            curves.append(pts)
    return curves


def _skel_concat(seq, edges):
    chain = None
    for eid in seq:
        p = edges[eid]["pts"].copy()
        if chain is None:
            chain = p; continue
        ds = [np.hypot(*(chain[-1] - p[0])), np.hypot(*(chain[-1] - p[-1])),
              np.hypot(*(chain[0] - p[0])), np.hypot(*(chain[0] - p[-1]))]
        k = int(np.argmin(ds))
        if k == 0:
            chain = np.vstack([chain, p])
        elif k == 1:
            chain = np.vstack([chain, p[::-1]])
        elif k == 2:
            chain = np.vstack([p[::-1], chain])
        else:
            chain = np.vstack([p, chain])
    return chain


def skel_to_single_valued(pts_yx):
    x = np.round(pts_yx[:, 1]).astype(int); y = pts_yx[:, 0]
    o = np.argsort(x); x, y = x[o], y[o]
    xs, ys, i, n = [], [], 0, len(x)
    while i < n:
        j = i
        while j < n and x[j] == x[i]:
            j += 1
        xs.append(int(x[i])); ys.append(float(np.median(y[i:j]))); i = j
    return np.array(xs), np.array(ys)


# ─────────────────────────────────────────────────────────────────────────────
# 4. SELF-EVALUATION
# ─────────────────────────────────────────────────────────────────────────────

def evaluate(cmask, recon, frame, tol=None):
    tol = _s(4) if tol is None else tol
    """Compare reconstructed curves to the isolated ink (distance-transform)."""
    true = cmask > 0; pred = recon > 0
    if true.sum() == 0:
        return dict(recall=0, precision=0, f1=0, col_cov=0, n_true=0)
    dt_pred = cv2.distanceTransform((~pred).astype(np.uint8), cv2.DIST_L2, 3)
    dt_true = cv2.distanceTransform((~true).astype(np.uint8), cv2.DIST_L2, 3)
    recall = float((dt_pred[true] <= tol).mean())
    precision = float((dt_true[pred] <= tol).mean()) if pred.sum() else 0.0
    f1 = 2 * precision * recall / (precision + recall + 1e-9)
    xl, xr, yt, yb = frame["x_left"], frame["x_right"], frame["y_top"], frame["y_bottom"]
    bt = true[yt:yb + 1, xl:xr + 1]; bdp = dt_pred[yt:yb + 1, xl:xr + 1]
    cols = np.where(bt.any(axis=0))[0]
    if len(cols):
        ok = sum(1 for x in cols if (bdp[np.where(bt[:, x])[0], x] <= tol).all())
        col_cov = ok / len(cols)
    else:
        col_cov = 0.0
    return dict(recall=round(recall, 4), precision=round(precision, 4),
                f1=round(f1, 4), col_cov=round(col_cov, 4), n_true=int(true.sum()))


# ─────────────────────────────────────────────────────────────────────────────
# 5. DIGITIZE (per page): four strategies, keep the best
# ─────────────────────────────────────────────────────────────────────────────

def _despike(xs, ys, win=None, tol=None):
    win = _odd(11) if win is None else win
    tol = _s(16) if tol is None else tol
    from scipy.signal import medfilt
    if len(ys) < win:
        return xs, ys
    med = medfilt(ys.astype(float), win if win % 2 else win + 1)
    ys2 = ys.astype(float).copy()
    ys2[np.abs(ys - med) > tol] = med[np.abs(ys - med) > tol]
    return xs, ys2


def _col_runs(cmask, x, yt, yb, merge_gap=None):
    merge_gap = _s(4) if merge_gap is None else merge_gap
    return column_runs(cmask[:, x], yt, yb, merge_gap)


def _slope(xs, ys, side, k=25):
    xs, ys = (xs[-k:], ys[-k:]) if side == "r" else (xs[:k], ys[:k])
    if len(xs) < 2 or xs[-1] == xs[0]:
        return 0.0
    return float(np.polyfit(xs, ys, 1)[0])


def _mergeable(a, b, x_gap=None, y_tol=None, slope_tol=0.7):
    x_gap = _s(40) if x_gap is None else x_gap
    y_tol = _s(20) if y_tol is None else y_tol
    xa, ya = skel_to_single_valued(a); xb, yb = skel_to_single_valued(b)
    lo = max(xa.min(), xb.min()); hi = min(xa.max(), xb.max())
    if hi - lo >= 8:
        common = np.intersect1d(xa[(xa >= lo) & (xa <= hi)], xb[(xb >= lo) & (xb <= hi)])
        if len(common) >= 3:
            mya = {int(x): y for x, y in zip(xa, ya)}; myb = {int(x): y for x, y in zip(xb, yb)}
            if np.median([abs(mya[int(x)] - myb[int(x)]) for x in common]) <= y_tol:
                return True
    if xa.min() > xb.min():
        xa, ya, xb, yb = xb, yb, xa, ya
    gap = xb.min() - xa.max()
    if -6 <= gap <= x_gap and abs(yb[0] - ya[-1]) <= y_tol:
        sa = _slope(xa, ya, "r"); sb = _slope(xb, yb, "l")
        if abs(sa - sb) <= max(1.5, slope_tol * (abs(sa) + abs(sb) + 1)):
            return True
    return False


def _merge_fragments(curve_list):
    frags = [c.copy() for c in curve_list]
    changed = True
    while changed and len(frags) > 1:
        changed = False
        for i in range(len(frags)):
            for j in range(i + 1, len(frags)):
                if _mergeable(frags[i], frags[j]):
                    frags[i] = np.vstack([frags[i], frags[j]]); frags.pop(j)
                    changed = True; break
            if changed:
                break
    if len(frags) > 2:
        changed = True
        while changed and len(frags) > 1:
            changed = False
            for i in range(len(frags)):
                for j in range(i + 1, len(frags)):
                    if _mergeable(frags[i], frags[j],
                                  x_gap=_s(80), y_tol=_s(50)):
                        frags[i] = np.vstack([frags[i], frags[j]]); frags.pop(j)
                        changed = True; break
                if changed:
                    break
    return frags


def _classify(curves):
    """Assign emission / absorption roles.

    Berlman's layout: emission on the LEFT (low wavenumber = long wavelength),
    absorption on the RIGHT (high wavenumber = short wavelength).  The two
    curves overlap in the middle but their PEAKS are always on opposite sides.

    For multi-curve pages (two concentrations, excimer + monomer, etc.) all
    left-side curves are emission variants and the rightmost is absorption —
    provided it is clearly separated.  When all curves sit on the same side
    the page has no absorption panel.
    """
    for c in curves:
        c["role"] = None
    if not curves:
        return curves
    curves.sort(key=lambda c: c["cx"])

    if len(curves) == 1:
        curves[0]["role"] = "emission"
        return curves

    # Check whether the rightmost curve is truly separate (absorption panel)
    # by looking at peak positions: absorption peak should be well to the
    # right of the emission peak.
    px_arrays = [np.asarray(c["px"]) for c in curves]
    py_arrays = [np.asarray(c["py"]) for c in curves]
    peaks = []
    for px, py in zip(px_arrays, py_arrays):
        peak_idx = int(np.argmin(py))  # lowest y = highest intensity
        peaks.append(float(px[peak_idx]))

    total_span = max(p.max() for p in px_arrays) - min(p.min() for p in px_arrays)
    last_peak = peaks[-1]
    other_peaks = peaks[:-1]
    mean_other = np.mean(other_peaks)

    # Check wavelength-range overlap between leftmost and rightmost curves.
    # Real emission/absorption pairs in Berlman NEVER overlap >50% — they
    # occupy opposite sides of the spectrum.  High overlap means the tracer
    # split one set of curves or found two concentration variants.
    first_lo, first_hi = float(px_arrays[0].min()), float(px_arrays[0].max())
    last_lo, last_hi = float(px_arrays[-1].min()), float(px_arrays[-1].max())
    overlap = max(0, min(first_hi, last_hi) - max(first_lo, last_lo))
    shorter_span = min(first_hi - first_lo, last_hi - last_lo)
    overlap_frac = overlap / shorter_span if shorter_span > 0 else 0

    # Rightmost curve is absorption only if:
    # 1. Its peak is substantially to the right (> 15% of total span)
    # 2. The curves don't overlap too much in x-range (< 50%)
    # OR: curve centers clearly occupy opposite sides of the plot
    all_min = min(float(p.min()) for p in px_arrays)
    all_max = max(float(p.max()) for p in px_arrays)
    mid_x = 0.5 * (all_min + all_max)
    centers_opposite = (curves[0]["cx"] < mid_x and curves[-1]["cx"] > mid_x)
    is_absorption = (
        (last_peak - mean_other > 0.15 * total_span or centers_opposite)
        and overlap_frac < 0.50
    )

    if is_absorption:
        curves[-1]["role"] = "absorption"
        curves[0]["role"] = "emission"
        for c in curves[1:-1]:
            c["role"] = "extra"
    else:
        curves[0]["role"] = "emission"
        for c in curves[1:]:
            c["role"] = "extra"

    em = curves[0]
    ab_peak_x = peaks[-1] if is_absorption else float("inf")
    extras = [c for c in curves if c.get("role") == "extra"]
    for ex in extras:
        ex_px = np.asarray(ex["px"])
        em_px = np.asarray(em["px"])
        if float(ex_px.mean()) >= ab_peak_x:
            continue
        # Merging is for FRAGMENTS of one curve split at an x-gap.  Curves
        # that overlap in x are distinct curves (concentration variants,
        # excimer/monomer pairs) — concatenating them makes a double-valued
        # zigzag that wrecks the reconstruction.
        ov = min(float(ex_px.max()), float(em_px.max())) - \
             max(float(ex_px.min()), float(em_px.min()))
        shorter = min(float(ex_px.max()) - float(ex_px.min()),
                      float(em_px.max()) - float(em_px.min()))
        if shorter > 0 and ov / shorter > 0.10:
            continue
        gap = max(0, ex_px.min() - em_px.max(), em_px.min() - ex_px.max())
        if gap <= _s(100):
            em["px"] = np.concatenate([em_px, ex_px])
            em["py"] = np.concatenate([np.asarray(em["py"]), np.asarray(ex["py"])])
            o = np.argsort(em["px"])
            em["px"], em["py"] = em["px"][o], em["py"][o]
            em["cx"] = float(em["px"].mean())
            ex["role"] = "merged"
    curves = [c for c in curves if c.get("role") != "merged"]

    return curves


def _curves_from_merged(merged):
    curves = []
    for pts in merged:
        xs, ys = skel_to_single_valued(pts)
        if len(xs) < 5:
            continue
        xs, ys = _despike(xs, ys)
        curves.append(dict(px=xs, py=ys, cx=float(xs.mean())))
    return _classify(curves)


def _overlap_band(cmask, frame):
    yt, yb, xl, xr = frame["y_top"], frame["y_bottom"], frame["x_left"], frame["x_right"]
    multi = np.array([len(_col_runs(cmask, x, yt, yb)) >= 2 for x in range(xl, xr + 1)])
    best = (0, 0, 0); i = 0
    while i < len(multi):
        if multi[i]:
            j = i
            while j < len(multi) and multi[j]:
                j += 1
            if j - i > best[0]:
                best = (j - i, xl + i, xl + j - 1)
            i = j
        else:
            i += 1
    return best[1], best[2], best[0]


def _follow(cmask, x0, y0, step, frame, x_stop, seq0=None,
            base_gate=None, kv=2.0, max_gap=None, vel_win=8):
    base_gate = 9.0 * _SCALE if base_gate is None else base_gate
    max_gap = _s(16) if max_gap is None else max_gap
    yt, yb = frame["y_top"], frame["y_bottom"]
    pts = list(seq0) if seq0 else [(x0, y0)]
    if seq0:
        x, y = seq0[-1]
        xw, yw = seq0[-min(vel_win, len(seq0))]
        vel = (y - yw) / (x - xw) if x != xw else 0.0
    else:
        x, y, vel = x0, y0, 0.0
    misses, produced = 0, []
    while (step > 0 and x < x_stop) or (step < 0 and x > x_stop):
        x += step
        pred = y + vel * step
        gate = base_gate + kv * abs(vel)
        best, bestd = None, None
        for lo, hi in _col_runs(cmask, x, yt, yb):
            c = 0.5 * (lo + hi)
            d = 0.0 if lo - gate <= pred <= hi + gate else min(abs(lo - pred), abs(hi - pred))
            if d <= gate and (bestd is None or d < bestd):
                yy = (hi if vel * step > 0 else lo) if (hi - lo) > 3 * base_gate else c
                best, bestd = yy, d
        if best is None:
            misses += 1
            if misses > max_gap:
                break
            y = pred; continue
        misses = 0
        pts.append((x, best)); produced.append((x, best))
        xw, yw = pts[-min(vel_win, len(pts))]
        vel = (best - yw) / (x - xw) if x != xw else vel
        y = best
    return pts, produced


def extract_columnar(cmask, frame):
    yt, yb, xl, xr = frame["y_top"], frame["y_bottom"], frame["x_left"], frame["x_right"]
    ink = [x for x in range(xl, xr + 1) if _col_runs(cmask, x, yt, yb)]
    if len(ink) < 10:
        return []
    ov0, ov1, blen = _overlap_band(cmask, frame)
    has = blen >= 8
    r0 = _col_runs(cmask, ink[0], yt, yb); r1 = _col_runs(cmask, ink[-1], yt, yb)
    em, _ = _follow(cmask, ink[0], 0.5 * (r0[0][0] + r0[0][1]), +1, frame, ov1 if has else xr)
    ab, _ = _follow(cmask, ink[-1], 0.5 * (r1[-1][0] + r1[-1][1]), -1, frame, ov0 if has else xl)
    out = []
    for pts in (em, ab):
        px = np.array([p[0] for p in pts]); py = np.array([p[1] for p in pts])
        o = np.argsort(px); px, py = _despike(px[o], py[o])
        if len(px) >= 5 and px.max() - px.min() >= 0.1 * (xr - xl):
            out.append(dict(px=px, py=py, cx=float(px.mean())))
    if len(out) == 2 and abs(out[0]["cx"] - out[1]["cx"]) < 0.05 * (xr - xl):
        out = [out[0]]
    return _classify(out)


def extract_parallel(cmask, frame):
    yt, yb, xl, xr = frame["y_top"], frame["y_bottom"], frame["x_left"], frame["x_right"]
    U, L, uy, ly = [], [], None, None
    for x in range(xl, xr + 1):
        runs = _col_runs(cmask, x, yt, yb)
        if not runs:
            continue
        cents = sorted(0.5 * (lo + hi) for lo, hi in runs)
        if len(cents) >= 2:
            uy, ly = cents[0], cents[-1]
            U.append((x, cents[0])); L.append((x, cents[-1]))
        else:
            c = cents[0]
            if uy is None:
                uy = ly = c; U.append((x, c)); L.append((x, c)); continue
            if abs(c - uy) <= abs(c - ly):
                U.append((x, c)); uy = c; L.append((x, c))
            else:
                L.append((x, c)); ly = c; U.append((x, c))
    out = []
    for pts, role in ((U, "emission"), (L, "emission")):
        if len(pts) < 10:
            continue
        px = np.array([p[0] for p in pts]); py = np.array([p[1] for p in pts])
        px, py = _despike(px, py)
        out.append(dict(px=px, py=py, cx=float(px.mean()), role=role))
    if len(out) == 2:
        m = min(len(out[0]["py"]), len(out[1]["py"]))
        if np.median(np.abs(out[0]["py"][:m] - out[1]["py"][:m])) < 6:
            out = [out[0]]
    return out


def _resolve_overlap(cmask, curves, frame):
    em = next((c for c in curves if c["role"] == "emission"), None)
    ab = next((c for c in curves if c["role"] == "absorption"), None)
    if em is None or ab is None:
        return curves
    ov0, ov1, blen = _overlap_band(cmask, frame)
    if blen < 8:
        return curves
    em_xy = [(int(x), float(y)) for x, y in zip(em["px"], em["py"]) if x < ov0]
    ab_xy = [(int(x), float(y)) for x, y in zip(ab["px"], ab["py"]) if x > ov1]
    if len(em_xy) < 3 or len(ab_xy) < 3:
        return curves
    _, em_ext = _follow(cmask, 0, 0, +1, frame, ov1 + 1, seq0=em_xy)
    _, ab_ext = _follow(cmask, 0, 0, -1, frame, ov0 - 1, seq0=sorted(ab_xy))
    new_em = dict(em); new_ab = dict(ab)
    ex = np.array([p[0] for p in em_xy + em_ext]); ey = np.array([p[1] for p in em_xy + em_ext])
    o = np.argsort(ex); new_em["px"], new_em["py"] = ex[o], ey[o]
    axs = np.array([p[0] for p in ab_ext + ab_xy]); ays = np.array([p[1] for p in ab_ext + ab_xy])
    o = np.argsort(axs); new_ab["px"], new_ab["py"] = axs[o], ays[o]
    return [new_em if c is em else new_ab if c is ab else c for c in curves]


def _recover_absorption(cmask, fr, curves):
    """When no absorption was found, try to recover it from multi-run columns.

    At columns where the cmask has 2+ vertical runs, one run matches the
    emission trace and the other is likely absorption.  Collect those
    absorption seed points, then extend rightward with _follow on the
    original cmask (where only absorption ink exists past the overlap zone).
    Extend leftward on a masked cmask (emission subtracted) so the tracer
    doesn't latch onto emission ink.
    """
    em = next((c for c in curves if c.get("role") == "emission"), None)
    if em is None:
        return
    em_px = np.asarray(em["px"]).astype(int)
    em_py = np.round(np.asarray(em["py"])).astype(int)
    yt, yb, xl, xr = fr["y_top"], fr["y_bottom"], fr["x_left"], fr["x_right"]
    plotW = xr - xl
    em_span = (em_px.max() - em_px.min()) / plotW if plotW > 0 else 0

    em_lookup = {}
    for x, y in zip(em_px, em_py):
        em_lookup[int(x)] = float(y)

    ab_seeds = []
    for x in range(xl, xr + 1):
        runs = _col_runs(cmask, x, yt, yb)
        if len(runs) < 2:
            continue
        emy = em_lookup.get(x)
        if emy is None:
            continue
        best_run, best_dist = None, 0
        for lo, hi in runs:
            mid = 0.5 * (lo + hi)
            dist = abs(mid - emy)
            if dist > _s(15) and dist > best_dist:
                best_run = mid
                best_dist = dist
        if best_run is not None:
            ab_seeds.append((x, best_run))

    if len(ab_seeds) < 10:
        return
    ab_seeds.sort(key=lambda p: p[0])

    right_ext, _ = _follow(cmask, 0, 0, +1, fr, xr, seq0=ab_seeds)
    masked = cmask.copy()
    radius = _s(12)
    for x, y in zip(em_px, em_py):
        y_lo = max(yt, int(y) - radius)
        y_hi = min(yb, int(y) + radius)
        masked[y_lo:y_hi + 1, x] = 0
    left_seeds = list(reversed(ab_seeds))
    left_ext, _ = _follow(masked, 0, 0, -1, fr, xl, seq0=left_seeds)

    seen = set()
    unique = []
    for x, y in left_ext + right_ext:
        xi = int(x)
        if xi not in seen:
            seen.add(xi)
            unique.append((x, y))

    # Fallback: if seed-based extension is too short, try extract_columnar
    # which traces independently from left and right edges.
    seed_span = (max(p[0] for p in unique) - min(p[0] for p in unique)) if unique else 0
    if seed_span < 0.15 * plotW:
        try:
            col_curves = extract_columnar(cmask, fr)
            if len(col_curves) >= 2:
                col_curves.sort(key=lambda c: c["cx"])
                right_c = col_curves[-1]
                rpx = np.asarray(right_c["px"])
                rspan = (rpx.max() - rpx.min()) / plotW if len(rpx) > 0 else 0
                if rspan > 0.15 and float(rpx.max()) >= xl + 0.5 * plotW:
                    seen = set()
                    unique = []
                    for xv, yv in zip(right_c["px"], right_c["py"]):
                        xi = int(xv)
                        if xi not in seen:
                            seen.add(xi)
                            unique.append((float(xv), float(yv)))
        except Exception:
            pass

    if len(unique) < 10:
        return

    px = np.array([p[0] for p in unique])
    py = np.array([p[1] for p in unique])
    o = np.argsort(px)
    px, py = _despike(px[o], py[o])
    if len(px) < 5 or px.max() - px.min() < 0.1 * plotW:
        return

    if float(px.max()) < xl + 0.5 * plotW:
        return

    ab = dict(px=px, py=py, cx=float(px.mean()), role="absorption")

    m_before = evaluate(cmask, reconstruct_mask(cmask.shape, curves), fr)
    score_before = m_before["f1"] + 0.3 * m_before["col_cov"]

    saved_em_px = np.array(em["px"], copy=True)
    saved_em_py = np.array(em["py"], copy=True)
    saved_em_cx = em["cx"]

    best_trial, best_score_after = None, score_before
    for trim in (True, False):
        em["px"] = np.array(saved_em_px, copy=True)
        em["py"] = np.array(saved_em_py, copy=True)
        em["cx"] = saved_em_cx
        if trim and em_span > 0.70:
            ab_left = float(px.min())
            keep = np.asarray(em["px"]).astype(int) <= ab_left + _s(80)
            if keep.sum() < 5:
                continue
            em["px"] = np.asarray(saved_em_px)[keep].astype(float)
            em["py"] = np.asarray(saved_em_py)[keep]
            em["cx"] = float(em["px"].mean())
        trial = list(curves) + [ab]
        m_after = evaluate(cmask, reconstruct_mask(cmask.shape, trial), fr)
        s = m_after["f1"] + 0.3 * m_after["col_cov"]
        if s > best_score_after:
            best_score_after = s
            best_trial = (trim, np.array(em["px"], copy=True),
                          np.array(em["py"], copy=True), float(em["cx"]))

    if best_trial is not None:
        _, t_px, t_py, t_cx = best_trial
        em["px"], em["py"], em["cx"] = t_px, t_py, t_cx
        curves.append(ab)
    else:
        em["px"] = saved_em_px
        em["py"] = saved_em_py
        em["cx"] = saved_em_cx


def _page_has_absorption(gray, rycal):
    """Decide whether the page contains an absorption panel.

    Standard Berlman pages print the word ABSORPTION on the plot and carry a
    right-hand molar-extinction axis.  Emission-only comparison pages
    (CURVE I / CURVE II concentration or solvent studies) have neither.
    Either signal counts as evidence, so a single OCR miss cannot drop a
    real absorption curve.
    """
    if rycal is not None:
        return True
    try:
        import pytesseract
        small = cv2.resize(gray, None, fx=0.5, fy=0.5,
                           interpolation=cv2.INTER_AREA)
        txt = pytesseract.image_to_string(small, config="--psm 11").upper()
        return "ABSORPT" in txt
    except Exception:
        return True  # fail open: keep legacy behaviour if OCR breaks


def _stroke_width(cmask, fr, curves):
    """Median ink-run thickness sampled along the traced curves."""
    yt, yb = fr["y_top"], fr["y_bottom"]
    lens = []
    for c in curves:
        px = np.round(np.asarray(c["px"])).astype(int)
        py = np.asarray(c["py"], float)
        for x, y in list(zip(px, py))[::7]:
            for lo, hi in _col_runs(cmask, int(x), yt, yb):
                if lo - 2 <= y <= hi + 2:
                    lens.append(hi - lo + 1)
                    break
    return float(np.median(lens)) if lens else float(_s(4))


def _walk_runs(cmask, fr, em_lookup, start_x, start_run, direction, stop_x, ws,
               bw_raw=None):
    """Chain-walk ink runs column by column from start_x toward stop_x.

    Accepts a run when its y-interval overlaps the previously accepted run
    (generous gap), skipping runs claimed by the emission trace.  Records the
    run TOP for tall runs (near-vertical vibronic spikes) and the run centre
    for normal-stroke runs, so needle peaks keep their true height.

    When the curve mask has no candidate run, falls back to the raw binary
    (bw_raw) — isolate_curves drops narrow curve components below its width
    threshold, and those gaps must still be bridged.  Raw evidence only
    counts if the walk later re-meets curve-mask ink: a trailing raw-only
    streak is trimmed, so the walk cannot wander off into stray text.
    """
    yt, yb, xl, xr = fr["y_top"], fr["y_bottom"], fr["x_left"], fr["x_right"]
    bwid = _s(4)
    gap = _s(25)
    max_miss = _s(12)
    # keep clear of the vertical frame lines when reading the raw binary
    lo_x = xl + bwid + 2
    hi_x = xr - bwid - 2
    pts = []          # (x, y, from_cmask)
    prev_lo, prev_hi = start_run
    misses = 0
    blocked = 0       # columns where ink exists but is claimed by the
                      # other curve (a crossing) — not counted as misses
    hit_boundary = True   # False if the walk dies from misses
    x = start_x + direction
    while (direction < 0 and x >= stop_x) or (direction > 0 and x <= stop_x):
        # the uncertainty cone widens while walking blind through a crossing
        gap_dyn = gap + 2 * blocked
        cands = []
        saw_claimed = False
        for lo, hi in _col_runs(cmask, x, yt, yb):
            if lo > prev_hi + gap_dyn or hi < prev_lo - gap_dyn:
                continue
            emy = em_lookup.get(x)
            if emy is not None and lo - 2 <= emy <= hi + 2:
                saw_claimed = True
                continue
            cands.append((lo, hi, True))
        if not cands and bw_raw is not None and lo_x <= x <= hi_x:
            # raw fallback, clipped inside the frame-line bands
            for lo, hi in column_runs(bw_raw[:, x],
                                      yt + bwid + 1, yb - bwid - 1):
                if lo > prev_hi + gap_dyn or hi < prev_lo - gap_dyn:
                    continue
                emy = em_lookup.get(x)
                if emy is not None and lo - 2 <= emy <= hi + 2:
                    saw_claimed = True
                    continue
                cands.append((lo, hi, False))
        if not cands:
            if saw_claimed and blocked <= _s(70):
                # crossing zone: the ink is there, just owned by the other
                # curve — keep walking without burning the miss budget
                blocked += 1
                x += direction
                continue
            misses += 1
            if misses > max_miss:
                # dying within a stone's throw of the frame edge still
                # counts as reaching it — faint tails fade slightly early
                hit_boundary = abs(x - stop_x) <= _s(30)
                break
            x += direction
            continue
        misses = 0
        blocked = 0
        lo, hi, from_cm = min(
            cands, key=lambda r: abs(0.5 * (r[0] + r[1])
                                     - 0.5 * (prev_lo + prev_hi)))
        y = lo + ws / 2.0 if (hi - lo + 1) > 2.5 * ws else 0.5 * (lo + hi)
        pts.append((x, y, from_cm))
        prev_lo, prev_hi = lo, hi
        x += direction
    # A trailing raw-only streak that ends near the baseline (a dotted/faint
    # tail — Berlman dots the emission tail where it overlaps absorption) or
    # that runs all the way to the plot boundary (a curve cut off by the
    # frame) is legitimate.  One that dies high mid-plot never re-met curve
    # ink — more likely text or noise — so it is trimmed.
    if pts and not pts[-1][2] and not hit_boundary:
        tail_inten = (yb - pts[-1][1]) / float(yb - yt or 1)
        if tail_inten >= 0.08:
            while pts and not pts[-1][2]:
                pts.pop()
    return [(x, y) for x, y, _ in pts]


def _trace_dotted_tail(bw_raw, cmask, fr, curves):
    """Follow dotted/dashed overlap tails by slope projection.

    Berlman draws a curve dotted where it overlaps the other curve
    (emission's short-wavelength tail, absorption's onset edge).  The dots
    are tiny components that isolate_curves drops, and the chain walk dies
    inside the crossing zone where every run is claimed by the other curve.
    Projecting the endpoint slope forward and collecting raw-ink dots near
    the projection crosses the other stroke without needing contiguity.
    """
    yt, yb, xl, xr = fr["y_top"], fr["y_bottom"], fr["x_left"], fr["x_right"]
    h = float(yb - yt) or 1.0
    bwid = _s(4)
    active = [c for c in curves
              if c.get("role") in ("emission", "absorption", "emission2")]
    if not active:
        return
    ws = _stroke_width(cmask, fr, active)

    for role, side in (("emission", "right"), ("absorption", "left"),
                       ("absorption", "right")):
        cur = next((c for c in curves if c.get("role") == role), None)
        if cur is None:
            continue
        px = np.asarray(cur["px"], float)
        py = np.asarray(cur["py"], float)
        o = np.argsort(px)
        px, py = px[o], py[o]
        if len(px) < 20:
            continue
        if side == "right":
            ex, ey = float(px[-1]), float(py[-1])
            seg_x, seg_y = px[-40:], py[-40:]
            direction = 1
        else:
            ex, ey = float(px[0]), float(py[0])
            seg_x, seg_y = px[:40], py[:40]
            direction = -1
        if (yb - ey) / h < 0.06:
            continue  # tail already reaches the baseline
        if seg_x.max() - seg_x.min() < 3:
            continue
        slope = float(np.polyfit(seg_x, seg_y, 1)[0])
        # A trace ending on a rising flank means the dotted tail starts just
        # past an apex.  Peaks are roughly symmetric, so project the MIRROR
        # of the ascent — a flat projection diverges from the tail before
        # any dot can be collected (the crossing zone hides the first ones).
        if direction * slope <= 0:
            slope = -slope

        # runs claimed by other curves, with a small column neighborhood
        others = {}
        for c2 in active:
            if c2 is cur:
                continue
            for xo, yo in zip(np.round(np.asarray(c2["px"])).astype(int),
                              np.asarray(c2["py"], float)):
                for dx in range(-_s(3), _s(3) + 1):
                    others.setdefault(int(xo) + dx, []).append(float(yo))

        have = set(np.round(px).astype(int).tolist())
        pts = []
        anchor_x, anchor_y = ex, ey
        miss = 0
        x = int(round(ex)) + direction
        lo_x, hi_x = xl + bwid + 2, xr - bwid - 2
        while lo_x <= x <= hi_x:
            y_pred = anchor_y + slope * (x - anchor_x)
            if not (yt < y_pred < yb - 2):
                break
            cands = []
            for lo, hi in column_runs(bw_raw[:, x], yt + bwid + 1,
                                      yb - bwid - 1):
                if (hi - lo + 1) > 4 * ws:
                    continue  # merged/tall run — the other curve's stroke
                mid = 0.5 * (lo + hi)
                # loose window until the projection locks onto real dots
                tol = _s(20) if len(pts) < 3 else _s(14)
                if abs(mid - y_pred) > tol:
                    continue
                if any(lo - 2 <= yo <= hi + 2 for yo in others.get(x, [])):
                    continue
                cands.append(mid)
            if cands:
                y_here = min(cands, key=lambda m: abs(m - y_pred))
                pts.append((x, y_here))
                if len(pts) >= 5:
                    rx = np.array([p[0] for p in pts[-14:]])
                    ry = np.array([p[1] for p in pts[-14:]])
                    if rx.max() - rx.min() >= 3:
                        slope = float(np.polyfit(rx, ry, 1)[0])
                anchor_x, anchor_y = float(x), float(y_here)
                miss = 0
                if (yb - y_here) / h < 0.015:
                    break  # reached the baseline
            else:
                miss += 1
                if miss > _s(30):
                    break
            x += direction
        # a genuine overlap tail always descends to the baseline; a chain
        # that ends high latched onto text or stray ink — discard it
        if len(pts) < 5 or (yb - pts[-1][1]) / h >= 0.10:
            continue
        add = [(p, q) for p, q in pts if int(p) not in have]
        if add:
            ax = np.array([p[0] for p in add], float)
            ay = np.array([p[1] for p in add], float)
            npx = np.concatenate([px, ax])
            npy = np.concatenate([py, ay])
            oo = np.argsort(npx)
            cur["px"], cur["py"] = npx[oo], npy[oo]
            cur["cx"] = float(cur["px"].mean())


def _role_hygiene(fr, curves):
    """Remove cross-contaminated points where red and green mix.

    In crossing zones the walks and tail trackers occasionally pick up a few
    of the OTHER curve's pixels.  Bin-averaging then pulls the exported
    curve off the ink near every crossing.  Test: a point that sits far from
    its own curve's local median but close to the other curve's local track
    belongs to the other curve — drop it (the other curve already has its
    own trace there).
    """
    em = next((c for c in curves if c.get("role") == "emission"), None)
    ab = next((c for c in curves if c.get("role") == "absorption"), None)
    if em is None or ab is None:
        return

    def local_median_model(c, win):
        px = np.asarray(c["px"], float)
        py = np.asarray(c["py"], float)
        o = np.argsort(px)
        px, py = px[o], py[o]

        def at(x):
            i = np.searchsorted(px, x)
            lo = max(0, i - win)
            hi = min(len(px), i + win)
            if hi <= lo:
                return None
            return float(np.median(py[lo:hi]))
        return px, py, at

    far = _s(10)
    # two passes with a wide window: a contaminated cluster larger than a
    # small window dominates its own local median and hides — the wide
    # window outvotes it, and the second pass cleans what the first exposed
    for win in (30, 30):
      for cur, other in ((em, ab), (ab, em)):
        cpx = np.asarray(cur["px"], float)
        cpy = np.asarray(cur["py"], float)
        opx, _, other_at = local_median_model(other, win)
        _, _, own_at = local_median_model(cur, win)
        if len(opx) < 20 or len(cpx) < 20:
            continue
        keep = np.ones(len(cpx), bool)
        o_lo, o_hi = opx.min(), opx.max()
        apex_y = float(cpy.min())      # smallest py = the curve's peak
        for i, (x, y) in enumerate(zip(cpx, cpy)):
            if not (o_lo <= x <= o_hi):
                continue  # outside the other curve's span — cannot contaminate
            if y <= apex_y + _s(14):
                continue  # never cull a curve's own apex zone
            own = own_at(x)
            oth = other_at(x)
            if own is None or oth is None:
                continue
            d_own = abs(y - own)
            d_oth = abs(y - oth)
            if d_own > far and d_oth < 0.5 * d_own:
                keep[i] = False
        if not keep.all():
            cur["px"] = cpx[keep]
            cur["py"] = cpy[keep]
            cur["cx"] = float(cur["px"].mean()) if len(cur["px"]) else 0.0


def _label_positions(gray, fr):
    """Full-scale x-positions of EMISSION / ABSORPTION labels inside the plot."""
    import pytesseract
    small = cv2.resize(gray, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    d = pytesseract.image_to_data(small, config="--psm 11",
                                  output_type=pytesseract.Output.DICT)
    xl, xr, yt, yb = fr["x_left"], fr["x_right"], fr["y_top"], fr["y_bottom"]
    em_xs, ab_xs = [], []
    for i, t in enumerate(d["text"]):
        t = (t or "").strip().upper()
        if not t:
            continue
        cx = (d["left"][i] + d["width"][i] / 2.0) * 2
        cy = (d["top"][i] + d["height"][i] / 2.0) * 2
        if not (xl < cx < xr and yt < cy < yb):
            continue
        if "EMISSION" in t or "EMISSTON" in t:
            em_xs.append(cx)
        elif "ABSORPT" in t:
            ab_xs.append(cx)
    return em_xs, ab_xs


def _label_guided_fix(fr, curves, em_xs, ab_xs):
    """Catch gross role errors using printed label positions.

    Berlman places EMISSION / ABSORPTION labels beside their curves.  When
    the curve exported as emission peaks much closer to an ABSORPTION label
    than to the EMISSION label (azulene-style pages with magnified insets),
    demote it and carve the true emission out of the absorption trace as the
    segment peaking nearest the EMISSION label.
    """
    if not em_xs or not ab_xs:
        return
    yt, yb = fr["y_top"], fr["y_bottom"]
    h = float(yb - yt) or 1.0
    plotW = fr["x_right"] - fr["x_left"]
    em = next((c for c in curves if c.get("role") == "emission"), None)
    ab = next((c for c in curves if c.get("role") == "absorption"), None)
    if em is None or ab is None:
        return
    epx = np.asarray(em["px"], float); epy = np.asarray(em["py"], float)
    em_peak_inten = float(((yb - epy) / h).max())
    if em_peak_inten >= 0.90:
        # a full-height emission is trusted regardless of label geometry —
        # carbazole-type spectra peak at their right edge, far from where
        # the label sits
        return
    peak_x = float(epx[int(np.argmin(epy))])
    d_em = min(abs(peak_x - x) for x in em_xs)
    d_ab = min(abs(peak_x - x) for x in ab_xs)
    if not (d_ab * 1.2 < d_em):
        return  # roles look sane

    # carve the true emission out of the absorption trace: local peak of the
    # absorption intensity within a window around the EMISSION label.  Only
    # commit (demote the impostor) if the carve actually succeeds.
    label_x = min(em_xs, key=lambda x: abs(x - peak_x + 1))
    apx = np.asarray(ab["px"], float); apy = np.asarray(ab["py"], float)
    o = np.argsort(apx); apx, apy = apx[o], apy[o]
    inten = (yb - apy) / h
    win = (apx > label_x - 0.25 * plotW) & (apx < label_x + 0.25 * plotW)
    if not win.any():
        return
    idxs = np.where(win)[0]
    pk = idxs[int(np.argmax(inten[idxs]))]
    if inten[pk] < 0.9:
        return
    # expand from the peak to the bounding deep minima
    lo_i = pk
    while lo_i > 0 and not (inten[lo_i] < 0.18 and inten[lo_i] <= inten[lo_i - 1]):
        lo_i -= 1
    hi_i = pk
    n = len(apx)
    while hi_i < n - 1 and not (inten[hi_i] < 0.18 and inten[hi_i] <= inten[hi_i + 1]):
        hi_i += 1
    if hi_i - lo_i < 30:
        return
    em["role"] = "extra"   # magnified inset / second absorption band
    seg = np.zeros(n, bool)
    seg[lo_i:hi_i + 1] = True
    curves.append(dict(px=apx[seg], py=apy[seg], cx=float(apx[seg].mean()),
                       role="emission"))
    ab["px"], ab["py"] = apx[~seg], apy[~seg]
    if len(ab["px"]):
        ab["cx"] = float(np.mean(ab["px"]))


def _split_swallowed(fr, curves, has_abs):
    """Split a trace that swallowed the other curve.

    On mirror-image pages (anthracene, tetracene, chrysene) emission and
    absorption both drop to the baseline at a deep valley; the tracer can run
    straight through it and claim both curves as one.  Detect a sustained
    near-zero valley with substantial (>0.5 intensity) mass on BOTH sides and
    reassign the far side to the other role.
    """
    if not has_abs:
        return
    yt, yb = fr["y_top"], fr["y_bottom"]
    h = float(yb - yt)
    if h <= 0:
        return

    def valleys(px, py):
        inten = (yb - py) / h
        # emission/absorption crossings sit as high as ~0.08; genuine
        # emission vibronic dips stay above ~0.2
        low = inten < 0.09
        runs, i, n = [], 0, len(px)
        while i < n:
            if low[i]:
                j = i
                while j < n and low[j]:
                    j += 1
                # narrow mirror-image valleys (anthracene) are ~30-50 px wide
                if px[j - 1] - px[i] >= _s(12):
                    runs.append((i, j))
                i = j
            else:
                i += 1
        return inten, runs

    for _ in range(3):
        changed = False
        em = next((c for c in curves if c.get("role") == "emission"), None)
        ab = next((c for c in curves if c.get("role") == "absorption"), None)

        if em is not None:
            px = np.asarray(em["px"], float); py = np.asarray(em["py"], float)
            o = np.argsort(px); px, py = px[o], py[o]
            inten, runs = valleys(px, py)
            # take the rightmost valley with real mass on BOTH sides — the
            # curve's own leading/trailing zero-tails are valleys too, but
            # they fail the mass test
            hit = next(((i0, j0) for i0, j0 in reversed(runs)
                        if i0 > 10 and j0 < len(px) - 10
                        and inten[:i0].max() > 0.5
                        and inten[j0:].max() > 0.5), None)
            if hit:
                i0, j0 = hit
                if True:
                    mid = (i0 + j0) // 2
                    em["px"], em["py"] = px[:mid], py[:mid]
                    em["cx"] = float(em["px"].mean())
                    mx, my = px[mid:], py[mid:]
                    if ab is None:
                        curves.append(dict(px=mx, py=my, cx=float(mx.mean()),
                                           role="absorption"))
                    else:
                        have = set(np.round(np.asarray(ab["px"])).astype(int).tolist())
                        keep = np.array([int(round(v)) not in have for v in mx])
                        mx, my = mx[keep], my[keep]
                        apx = np.concatenate([np.asarray(ab["px"], float), mx])
                        apy = np.concatenate([np.asarray(ab["py"], float), my])
                        oo = np.argsort(apx)
                        ab["px"], ab["py"] = apx[oo], apy[oo]
                        ab["cx"] = float(ab["px"].mean())
                    changed = True

        if not changed and ab is not None:
            px = np.asarray(ab["px"], float); py = np.asarray(ab["py"], float)
            o = np.argsort(px); px, py = px[o], py[o]
            inten, runs = valleys(px, py)
            hit = next(((i0, j0) for i0, j0 in runs
                        if i0 > 10 and j0 < len(px) - 10
                        and inten[:i0].max() > 0.5
                        and inten[j0:].max() > 0.5), None)
            if hit:
                i0, j0 = hit
                if True:
                    mid = (i0 + j0) // 2
                    ab["px"], ab["py"] = px[mid:], py[mid:]
                    ab["cx"] = float(ab["px"].mean())
                    mx, my = px[:mid], py[:mid]
                    if em is None:
                        curves.append(dict(px=mx, py=my, cx=float(mx.mean()),
                                           role="emission"))
                    else:
                        have = set(np.round(np.asarray(em["px"])).astype(int).tolist())
                        keep = np.array([int(round(v)) not in have for v in mx])
                        mx, my = mx[keep], my[keep]
                        epx = np.concatenate([np.asarray(em["px"], float), mx])
                        epy = np.concatenate([np.asarray(em["py"], float), my])
                        oo = np.argsort(epx)
                        em["px"], em["py"] = epx[oo], epy[oo]
                        em["cx"] = float(em["px"].mean())
                    changed = True

        if not changed:
            break


def _refine_curves(cmask, bw_raw, fr, curves):
    """Post-trace refinement: recover spike tops and missed span.

    1. Spike lift — where a traced point sits inside an abnormally tall ink
       run (a near-vertical vibronic spike that single-valued tracing collapsed
       to its midpoint), move the point to the run top.
    2. Frame-top touch — runs reaching the blanked border band are checked
       against the raw binary; genuine contact snaps the point to y_top
       (intensity exactly 1.0).
    3. Absorption extension — walk the ink-run chain outward from both
       endpoints and across interior x-gaps, so spike regions the tracer
       skipped are recovered from the mask.
    """
    yt, yb, xl, xr = fr["y_top"], fr["y_bottom"], fr["x_left"], fr["x_right"]
    bwid = _s(4)
    active = [c for c in curves
              if c.get("role") in ("emission", "absorption", "emission2")]
    if not active:
        return
    ws = _stroke_width(cmask, fr, active)

    em = next((c for c in curves if c.get("role") == "emission"), None)
    em_lookup = {}
    if em is not None:
        em_lookup = {int(x): float(y)
                     for x, y in zip(np.round(np.asarray(em["px"])).astype(int),
                                     np.asarray(em["py"], float))}

    # ── 3. span extension for both primary roles (before lift, so the new
    #       points get lifted too).  Emission needs it as much as absorption:
    #       vibronic needle regions get skipped by the velocity-gated tracer
    #       on either curve.
    for role in ("emission", "absorption"):
        cur = next((c for c in curves if c.get("role") == role), None)
        if cur is None:
            continue
        # runs claimed by any OTHER active curve are off limits
        other_lookup = {}
        for c2 in active:
            if c2 is cur:
                continue
            for x, y in zip(np.round(np.asarray(c2["px"])).astype(int),
                            np.asarray(c2["py"], float)):
                other_lookup.setdefault(int(x), float(y))

        px = np.asarray(cur["px"], float)
        py = np.asarray(cur["py"], float)
        o = np.argsort(px)
        px, py = px[o], py[o]
        have = set(np.round(px).astype(int).tolist())

        def run_at(x, y):
            for lo, hi in _col_runs(cmask, int(round(x)), yt, yb):
                if lo - 3 <= y <= hi + 3:
                    return (lo, hi)
            return (int(round(y)) - int(ws / 2), int(round(y)) + int(ws / 2))

        new_pts = []
        # outward from both endpoints
        new_pts += _walk_runs(cmask, fr, other_lookup, int(round(px[0])),
                              run_at(px[0], py[0]), -1, xl + 1, ws,
                              bw_raw=bw_raw)
        new_pts += _walk_runs(cmask, fr, other_lookup, int(round(px[-1])),
                              run_at(px[-1], py[-1]), +1, xr - 1, ws,
                              bw_raw=bw_raw)
        # across interior gaps, from both sides (a one-sided walk can die at
        # a claimed/empty stretch that the other side crosses easily)
        ipx = np.round(px).astype(int)
        for i in range(len(ipx) - 1):
            if ipx[i + 1] - ipx[i] > _s(10):
                fwd = _walk_runs(cmask, fr, other_lookup, ipx[i],
                                 run_at(px[i], py[i]), +1,
                                 ipx[i + 1] - 1, ws, bw_raw=bw_raw)
                got = {int(p[0]) for p in fwd}
                bwd = _walk_runs(cmask, fr, other_lookup, ipx[i + 1],
                                 run_at(px[i + 1], py[i + 1]), -1,
                                 ipx[i] + 1, ws, bw_raw=bw_raw)
                new_pts += fwd + [p for p in bwd if int(p[0]) not in got]
        add = [(x, y) for x, y in new_pts if int(x) not in have]
        if add:
            ax = np.array([p[0] for p in add], float)
            ay = np.array([p[1] for p in add], float)
            px = np.concatenate([px, ax])
            py = np.concatenate([py, ay])
            o = np.argsort(px)
            cur["px"], cur["py"] = px[o], py[o]
            cur["cx"] = float(px.mean())

    # ── 1 + 2. spike lift and frame-top touch, all active curves ──
    claims = {}
    for ci, c in enumerate(active):
        for x, y in zip(np.round(np.asarray(c["px"])).astype(int),
                        np.asarray(c["py"], float)):
            claims.setdefault(int(x), []).append((ci, float(y)))

    for ci, c in enumerate(active):
        px = np.round(np.asarray(c["px"])).astype(int)
        py = np.asarray(c["py"], float)
        newy = py.copy()
        for i, (x, y) in enumerate(zip(px, py)):
            run = None
            for lo, hi in _col_runs(cmask, int(x), yt, yb):
                if lo - 2 <= y <= hi + 2:
                    run = (lo, hi)
                    break
            if run is None:
                continue
            lo, hi = run
            # crossing check over a small x-neighborhood: at a crossing the
            # two ink strokes merge into one tall run, and the other trace
            # may miss this exact column while still being right next door
            shared = False
            for dx in range(-_s(4), _s(4) + 1):
                if any(cj != ci and lo - 2 <= yj <= hi + 2
                       for cj, yj in claims.get(int(x) + dx, [])):
                    shared = True
                    break
            if shared:
                continue
            # probe the raw binary above the mask run: needle tips form tiny
            # components that isolate_curves drops, truncating the run
            raw_top = int(lo)
            g_miss = 0
            yy = int(lo) - 1
            floor = yt + bwid
            while yy > floor and g_miss <= _s(3):
                if bw_raw[yy, int(x)] > 0:
                    raw_top = yy
                    g_miss = 0
                else:
                    g_miss += 1
                yy -= 1
            eff_lo = min(int(lo), raw_top)
            if (hi - eff_lo + 1) > 2.5 * ws:
                target = eff_lo + ws / 2.0
                if target < newy[i]:
                    newy[i] = target
            if eff_lo <= yt + bwid + 3:
                col = bw_raw[yt:min(int(eff_lo) + 2, yb) + 1, int(x)]
                if col.size and (col > 0).mean() > 0.6:
                    newy[i] = yt
        c["py"] = newy

    # ── 4. prune tiny detached near-baseline clusters — stray seed points
    #       far from the curve body make the overlay polyline (and any
    #       consumer sorting by x) cut a fabricated diagonal across the plot
    h = float(yb - yt) or 1.0
    for c in curves:
        if c.get("role") not in ("emission", "absorption"):
            continue
        px = np.asarray(c["px"], float)
        py = np.asarray(c["py"], float)
        o = np.argsort(px)
        px, py = px[o], py[o]
        if len(px) < 10:
            continue
        splits = np.where(np.diff(px) > _s(50))[0]
        if len(splits) == 0:
            continue
        bounds = [0] + (splits + 1).tolist() + [len(px)]
        clusters = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
        biggest = max(clusters, key=lambda t: t[1] - t[0])
        keep = np.ones(len(px), bool)
        for a, b in clusters:
            if (a, b) == biggest:
                continue
            n_pts = b - a
            inten_max = float(((yb - py[a:b]) / h).max())
            if n_pts < 8 and inten_max < 0.08:
                keep[a:b] = False
        if not keep.all():
            c["px"], c["py"] = px[keep], py[keep]
            c["cx"] = float(c["px"].mean())


def _extend_tail_to_zero(curves, fr):
    """Extend curve tails smoothly to zero when they end above ~3% intensity."""
    yt, yb = fr["y_top"], fr["y_bottom"]
    xl, xr = fr["x_left"], fr["x_right"]
    frame_h = float(yb - yt)
    if frame_h <= 0:
        return
    for c in curves:
        if c.get("role") not in ("emission", "absorption"):
            continue
        px = np.asarray(c["px"], float)
        py = np.asarray(c["py"], float)
        if len(px) < 20:
            continue
        o = np.argsort(px)
        px, py = px[o], py[o]
        tail_inten_right = (yb - py[-1]) / frame_h
        tail_inten_left = (yb - py[0]) / frame_h
        for side, inten, idx_slice in [("right", tail_inten_right, slice(-50, None)),
                                        ("left", tail_inten_left, slice(None, 50))]:
            if inten < 0.03:
                continue
            # A tail ending high means the TRACE is incomplete, not the
            # curve — a synthetic ramp from 0.7 intensity across half the
            # plot would fabricate data.  Only finish off near-zero tails.
            if inten > 0.12:
                continue
            tail_px = px[idx_slice]
            tail_py = py[idx_slice]
            if len(tail_px) < 10:
                continue
            if side == "right":
                slope = np.polyfit(tail_px[-20:], tail_py[-20:], 1)[0]
                if slope <= 0:
                    continue
                x_end = px[-1]
                y_end = py[-1]
                steps = max(5, int(abs(yb - y_end) / max(0.1, abs(slope))))
                steps = min(steps, int((xr - x_end)), _s(120))
                if steps < 3:
                    continue
                ext_x = np.arange(1, steps + 1) + x_end
                ext_x = ext_x[ext_x <= xr]
                ext_y = y_end + slope * np.arange(1, len(ext_x) + 1).astype(float)
                ext_y = np.clip(ext_y, yt, yb)
            else:
                slope = np.polyfit(tail_px[:20], tail_py[:20], 1)[0]
                if slope >= 0:
                    continue
                x_start = px[0]
                y_start = py[0]
                steps = max(5, int(abs(yb - y_start) / max(0.1, abs(slope))))
                steps = min(steps, int((x_start - xl)), _s(120))
                if steps < 3:
                    continue
                ext_x = x_start - np.arange(1, steps + 1).astype(float)
                ext_x = ext_x[ext_x >= xl]
                ext_y = y_start - slope * np.arange(1, len(ext_x) + 1).astype(float)
                ext_y = np.clip(ext_y, yt, yb)
            if len(ext_x) > 0:
                new_px = np.concatenate([px, ext_x])
                new_py = np.concatenate([py, ext_y])
                o2 = np.argsort(new_px)
                c["px"], c["py"] = new_px[o2], new_py[o2]
                c["cx"] = float(c["px"].mean())


def _physical(curves, fr, xcal, rycal):
    _extend_tail_to_zero(curves, fr)
    for c in curves:
        c["px"] = np.asarray(c["px"]); c["py"] = np.asarray(c["py"])
        if xcal:
            c["wavenumber"] = xcal["a"] * c["px"] + xcal["b"]
        inten = px_to_intensity(c["py"], fr)
        # No peak restoration.  Berlman normalizes to unit peak, so a raw max
        # just under 1.0 was read as border-blanking clip and the top 2% band
        # was stretched back up to 1.0.  But plenty of plates simply *print*
        # the apex below the rule — mesitylene peaks at 0.990 — and stretching
        # those lifts the top of the curve off the printed stroke, which is
        # exactly the "dots above the black line" the editor then has to fight.
        # Whatever the plate prints is the measurement.  Record the peak so a
        # consumer can normalize on purpose; do not do it for them.
        raw_max = float(inten.max()) if len(inten) else 0.0
        c["raw_max_intensity"] = raw_max
        c["intensity"] = inten
        if rycal and c["role"] == "absorption":
            c["extinction"] = rycal["a"] * c["py"] + rycal["b"]
    return curves


def reconstruct_mask(shape, curves, thickness=None):
    thickness = _s(3) if thickness is None else thickness
    m = np.zeros(shape, np.uint8)
    for c in curves:
        pts = np.stack([c["px"], np.round(c["py"]).astype(int)], 1).astype(np.int32)
        cv2.polylines(m, [pts], False, 255, thickness)
    return m


def _dedup_curves(curves, frame):
    """Drop curves that are near-duplicates of a longer curve (same shape over
    ~all of the shorter one's span). Fixes single-curve (emission-only) plots
    where a strategy copied the one curve and mislabelled the copy."""
    if len(curves) < 2:
        return curves
    yt, yb = frame["y_top"], frame["y_bottom"]
    h = float(yb - yt) or 1.0

    def inten(py):
        return (yb - np.asarray(py, float)) / h
    order = sorted(range(len(curves)),
                   key=lambda i: np.ptp(curves[i]["px"]), reverse=True)
    keep = []
    for i in order:
        cx = np.asarray(curves[i]["px"], float); cy = inten(curves[i]["py"])
        span = np.ptp(cx)
        dup = False
        for k in keep:
            kx = np.asarray(k["px"], float); ky = inten(k["py"])
            lo = max(cx.min(), kx.min()); hi = min(cx.max(), kx.max())
            if span <= 0 or hi - lo < 0.80 * span:
                continue
            g = np.linspace(lo, hi, 40)
            if np.median(np.abs(np.interp(g, cx, cy) - np.interp(g, kx, ky))) < 0.03:
                dup = True
                break
        if not dup:
            keep.append(curves[i])
    return keep


def _try_strategies(cmask, fr):
    """Run all extraction strategies on a curve mask, return (tag, curves, score)
    for the best one."""
    candidates = []
    try:
        merged = _merge_fragments(skel_trace(cmask, fr))
        base = _curves_from_merged(merged)
        if base:
            candidates.append(("base", base))
    except Exception:
        base = []

    try:
        if base:
            resolved = _resolve_overlap(cmask, [dict(c) for c in base], fr)
            for c in resolved:
                c["px"], c["py"] = _despike(np.asarray(c["px"]), np.asarray(c["py"]))
            _classify(resolved)
            if resolved:
                candidates.append(("resolved", resolved))
    except Exception:
        pass

    try:
        columnar = extract_columnar(cmask, fr)
        if columnar:
            candidates.append(("columnar", columnar))
    except Exception:
        pass

    try:
        _, _, blen = _overlap_band(cmask, fr)
        band_frac = blen / float(fr["x_right"] - fr["x_left"])
        if band_frac >= 0.25:
            parallel = extract_parallel(cmask, fr)
            if parallel:
                candidates.append(("parallel", parallel))
    except Exception:
        pass

    best, best_score, best_tag = [], -1.0, "none"
    for tag, cand in candidates:
        if not cand:
            continue
        cand = _dedup_curves(cand, fr)
        _classify(cand)
        m = evaluate(cmask, reconstruct_mask(cmask.shape, cand), fr)
        score = m["f1"] + 0.3 * m["col_cov"]
        if score > best_score:
            best, best_score, best_tag = cand, score, tag
    return best_tag, best, best_score


def digitize(path):
    """Digitize one graph image: try four strategies across multiple
    binarizations, keep the best-scoring result."""
    gray, bw = load_binary(path)
    _set_scale(bw.shape[1])
    fr = detect_frame(bw)
    xcal = calibrate_x(gray, fr)
    rycal = calibrate_right_y(gray, fr)

    # Primary pass: OTSU binarization
    cmask, comps = isolate_curves(bw, fr)
    best_tag, best, best_score = _try_strategies(cmask, fr)
    best_cmask = cmask

    # If primary pass scores poorly, try adaptive binarizations.
    # Always evaluate against the OTSU mask (ground truth) to avoid
    # self-referential scoring where a bad trace matches its own bad mask.
    eval_cmask = cmask
    if best_score < 1.2:
        for block in [51, 91]:
            for C in [10, 20]:
                try:
                    ab = cv2.adaptiveThreshold(
                        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                        cv2.THRESH_BINARY_INV, block, C)
                    cm2, _ = isolate_curves(ab, fr)
                    if cm2.sum() == 0:
                        continue
                    _, cand2, _ = _try_strategies(cm2, fr)
                    if not cand2:
                        continue
                    cand2 = _dedup_curves(cand2, fr)
                    _classify(cand2)
                    m2 = evaluate(eval_cmask, reconstruct_mask(eval_cmask.shape, cand2), fr)
                    score2 = m2["f1"] + 0.3 * m2["col_cov"]
                    if score2 > best_score:
                        best, best_score, best_tag = cand2, score2, "adapt"
                        best_cmask = cm2
                except Exception:
                    continue
        for thr in [120, 150]:
            try:
                _, fb = cv2.threshold(gray, thr, 255, cv2.THRESH_BINARY_INV)
                cm3, _ = isolate_curves(fb, fr)
                if cm3.sum() == 0:
                    continue
                _, cand3, _ = _try_strategies(cm3, fr)
                if not cand3:
                    continue
                cand3 = _dedup_curves(cand3, fr)
                _classify(cand3)
                m3 = evaluate(eval_cmask, reconstruct_mask(eval_cmask.shape, cand3), fr)
                score3 = m3["f1"] + 0.3 * m3["col_cov"]
                if score3 > best_score:
                    best, best_score, best_tag = cand3, score3, "fixed"
                    best_cmask = cm3
            except Exception:
                continue

    has_abs = _page_has_absorption(gray, rycal)

    # Recovery finds the second curve regardless of page type — on standard
    # pages it is the absorption panel, on emission-only comparison pages it
    # is CURVE II (relabelled below).
    if not any(c.get("role") == "absorption" for c in best):
        _recover_absorption(best_cmask, fr, best)

    if not has_abs:
        # Emission-only comparison page (CURVE I / II): every curve is an
        # emission variant.  The tallest becomes the primary emission.
        cands = [c for c in best
                 if c.get("role") in ("emission", "absorption", "extra")]
        if cands:
            def peak_y(c):
                return float(np.min(np.asarray(c["py"], float)))
            tallest = min(cands, key=peak_y)  # lowest y = highest intensity
            for c in cands:
                c["role"] = "emission" if c is tallest else "emission2"

    _split_swallowed(fr, best, has_abs)
    _refine_curves(best_cmask, bw, fr, best)
    # The extension walk itself can run through a deep valley and swallow
    # the other curve — split again, then let a second refine pass finish
    # the reshaped curves (walks are gap-driven, so this is near-idempotent).
    _split_swallowed(fr, best, has_abs)
    _refine_curves(best_cmask, bw, fr, best)

    # Dotted overlap tails (drawn where the curves cross) need slope
    # projection — the chain walk cannot cross the other curve's stroke.
    _trace_dotted_tail(bw, best_cmask, fr, best)

    # Red and green must never mix: drop cross-contaminated points that
    # sit on the other curve's ink in crossing zones.
    _role_hygiene(fr, best)

    # Printed EMISSION/ABSORPTION labels are the ground truth for roles —
    # catch pages where geometry fooled the classifier (magnified insets,
    # multi-band absorption).
    if has_abs:
        try:
            em_xs, ab_xs = _label_positions(gray, fr)
            _label_guided_fix(fr, best, em_xs, ab_xs)
        except Exception:
            pass

    # Trace big unclaimed ink (dashed variants, magnified insets, scattered-
    # light lines) as extras so the overlay and F1 reflect the whole page.
    # Extras are never exported as spectra.
    try:
        claimed = [c for c in best if c.get("role") in
                   ("emission", "absorption", "emission2", "extra")]
        recon = reconstruct_mask(best_cmask.shape, claimed, thickness=_s(5))
        resid = cv2.bitwise_and(
            best_cmask, cv2.bitwise_not(
                cv2.dilate(recon, np.ones((_s(7), _s(7)), np.uint8))))
        bridged = cv2.morphologyEx(
            resid, cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_RECT, (_s(60), 1)))
        nres, labres, statres, _ = cv2.connectedComponentsWithStats(bridged, 8)
        plotW = fr["x_right"] - fr["x_left"]
        added = 0
        for i in range(1, nres):
            rx, ry, rw, rh, rarea = statres[i]
            if rw < 0.07 * plotW or added >= 6:
                continue
            comp = (labres == i) & (resid > 0)
            cols = np.where(comp.any(axis=0))[0]
            if len(cols) < 30:
                continue
            pxs, pys = [], []
            for xc in cols:
                ys = np.where(comp[:, xc])[0]
                pxs.append(float(xc))
                pys.append(float(np.median(ys)))
            best.append(dict(px=np.array(pxs), py=np.array(pys),
                             cx=float(np.mean(pxs)), role="extra"))
            added += 1
    except Exception:
        pass

    curves = _physical(best, fr, xcal, rycal)
    return dict(path=path, frame=fr, xcal=xcal, rycal=rycal,
                cmask=best_cmask, comps=comps, curves=curves,
                strategy=best_tag, has_absorption=has_abs)


# ─────────────────────────────────────────────────────────────────────────────
# 6. BATCH RUNNER
# ─────────────────────────────────────────────────────────────────────────────

ROLE_COL = {"emission": (0, 0, 255), "absorption": (0, 150, 0),
            "emission2": (0, 140, 255), "extra": (200, 0, 200),
            None: (120, 120, 0)}


def draw_overlay(gray, curves, faint_mask=None, step=None, radius=None,
                 alpha=0.45):
    """Overlay digitized curves on the scan as semi-transparent lines + dots.
    The original spectra stay fully visible underneath."""
    step = _s(8) if step is None else step
    radius = _s(4) if radius is None else radius
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    if faint_mask is not None:
        vis[faint_mask > 0] = (225, 225, 225)
    overlay = vis.copy()
    for c in curves:
        col = ROLE_COL.get(c["role"], (0, 0, 0))
        xs = np.asarray(c["px"]); ys = np.round(np.asarray(c["py"])).astype(int)
        order = np.argsort(xs)
        xs, ys = xs[order], ys[order]
        # break the polyline at data gaps so a missing stretch renders as a
        # gap instead of a fabricated straight chord
        brk = np.where(np.diff(xs) > _s(20))[0]
        segs = np.split(np.arange(len(xs)), brk + 1)
        for seg in segs:
            if len(seg) < 2:
                continue
            pts = np.stack([xs[seg].astype(int), ys[seg]],
                           axis=1).reshape(-1, 1, 2)
            cv2.polylines(overlay, [pts], False, col, thickness=_s(2))
        for k in range(0, len(xs), step):
            cv2.circle(overlay, (int(xs[k]), int(ys[k])), radius, col, -1)
    cv2.addWeighted(overlay, alpha, vis, 1 - alpha, 0, vis)
    return vis


def _ocr_name(gray, fr):
    import pytesseract
    xl, xr, yt, yb = fr["x_left"], fr["x_right"], fr["y_top"], fr["y_bottom"]
    w, h = xr - xl, yb - yt
    crop = gray[yt + int(0.02 * h):yt + int(0.16 * h), xl + int(0.02 * w):xl + int(0.5 * w)]
    if crop.size == 0:
        return ""
    crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    for line in pytesseract.image_to_string(crop, config="--psm 6").splitlines():
        s = line.strip()
        if len(s) >= 2:
            return re.sub(r"\s+", " ", s)
    return ""


def _process(args):
    path, data_dir, ovl_dir, good_f1, good_col = args
    name = os.path.splitext(os.path.basename(path))[0]
    try:
        r = digitize(path)
        fr = r["frame"]
        gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        m = evaluate(r["cmask"], reconstruct_mask(r["cmask"].shape, r["curves"]), fr)
        mol = _ocr_name(gray, fr)

        rows, seen = [], {}
        for c in r["curves"]:
            role0 = c["role"] or "curve"
            seen[role0] = seen.get(role0, 0) + 1
            label = role0 if seen[role0] == 1 else f"{role0}_{seen[role0]}"
            wn = c.get("wavenumber")
            for i in range(len(c["px"])):
                w_cm = float(wn[i]) if wn is not None else ""
                wl = (1e8 / w_cm) if isinstance(w_cm, float) and w_cm > 0 else ""
                ext = float(c["extinction"][i]) if "extinction" in c else ""
                rows.append([label, w_cm, wl, round(float(c["intensity"][i]), 4), ext])
        rows.sort(key=lambda z: (z[0], z[1] if isinstance(z[1], float) else 0))
        with open(os.path.join(data_dir, name + ".csv"), "w", newline="") as fp:
            wc = csv.writer(fp)
            wc.writerow(["curve", "wavenumber_cm-1", "wavelength_A", "intensity_norm", "molar_extinction"])
            wc.writerows(rows)

        flagged = (m["f1"] < good_f1) or (m["col_cov"] < good_col)
        if flagged:
            cv2.imwrite(os.path.join(ovl_dir, name + ".png"),
                        draw_overlay(gray, r["curves"], faint_mask=r["cmask"]))

        return dict(name=name, molecule=mol, ok=not flagged, strategy=r.get("strategy"),
                    n_curves=len(r["curves"]),
                    xlo=(round(r["xcal"]["lo"]) if r["xcal"] else None),
                    xhi=(round(r["xcal"]["hi"]) if r["xcal"] else None),
                    xcal_rmse=(round(r["xcal"]["rmse"], 2) if r["xcal"] else None),
                    ry_top=(round(r["rycal"]["top"]) if r["rycal"] else None), **m)
    except Exception as ex:
        return dict(name=name, molecule="", ok=False, error=str(ex),
                    f1=0, recall=0, precision=0, col_cov=0, n_curves=0)


def run_batch(page_glob, out, jobs, good_f1=0.95, good_col=0.90):
    data_dir = os.path.join(out, "data"); ovl_dir = os.path.join(out, "overlays")
    os.makedirs(data_dir, exist_ok=True); os.makedirs(ovl_dir, exist_ok=True)
    paths = sorted(glob.glob(page_glob))
    if not paths:
        raise SystemExit(f"no page images match {page_glob}")
    tasks = [(p, data_dir, ovl_dir, good_f1, good_col) for p in paths]
    print(f"digitizing {len(paths)} pages on {jobs} workers…")
    t0 = time.time()
    with Pool(jobs) as pool:
        results = pool.map(_process, tasks)
    results.sort(key=lambda d: d["name"])
    json.dump(results, open(os.path.join(out, "report.json"), "w"), indent=1)
    keys = ["name", "molecule", "ok", "f1", "recall", "precision", "col_cov",
            "n_curves", "strategy", "xlo", "xhi", "xcal_rmse", "ry_top", "n_true"]
    with open(os.path.join(out, "report.csv"), "w", newline="") as fp:
        wc = csv.writer(fp); wc.writerow(keys)
        for d in results:
            wc.writerow([d.get(k, "") for k in keys])
    f1 = np.array([d["f1"] for d in results]); col = np.array([d["col_cov"] for d in results])
    nerr = sum(1 for d in results if d.get("error"))
    print(f"  done in {time.time()-t0:.0f}s — errors {nerr}  "
          f"mean F1 {f1.mean():.3f}  median {np.median(f1):.3f}  "
          f">=0.95 {(f1>=0.95).sum()}  >=0.90 {(f1>=0.90).sum()}")
    return results


# ─────────────────────────────────────────────────────────────────────────────
# 7. RENDER PDF PAGES
# ─────────────────────────────────────────────────────────────────────────────

def render_pages(pdf, out, lo, hi, dpi, force):
    pages_dir = os.path.join(out, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    existing = glob.glob(os.path.join(pages_dir, "graph-*.png"))
    if existing and not force:
        print(f"reusing {len(existing)} rendered pages in {pages_dir} (use --force to re-render)")
        return pages_dir
    if not shutil.which("pdftoppm"):
        raise SystemExit("pdftoppm not found — install poppler (brew install poppler)")
    print(f"rendering pages {lo}-{hi} at {dpi} dpi…")
    subprocess.run(["pdftoppm", "-f", str(lo), "-l", str(hi), "-r", str(dpi),
                    "-png", pdf, os.path.join(pages_dir, "graph")], check=True)
    # normalize names to graph-<pagenum>.png (strip zero padding)
    for f in glob.glob(os.path.join(pages_dir, "graph-*.png")):
        mnum = re.search(r"graph-0*(\d+)\.png$", f)
        if mnum:
            tgt = os.path.join(pages_dir, f"graph-{int(mnum.group(1))}.png")
            if tgt != f:
                os.replace(f, tgt)
    return pages_dir


# ─────────────────────────────────────────────────────────────────────────────
# 8. PHOTOCHEMCAD: download + cross-validation + export
# ─────────────────────────────────────────────────────────────────────────────

# Berlman graph (PDF page) -> (PhotoChemCAD id, compound) for compounds present
# in both collections. Page numbering is fixed for this book.
PCC_MAP = {
    "graph-124": ("042", "Benzene"), "graph-346": ("001", "Naphthalene"),
    "graph-372": ("022", "Anthracene"), "graph-380": ("021", "9,10-Diphenylanthracene"),
    "graph-308": ("020", "PPO (2,5-diphenyloxazole)"), "graph-315": ("077", "POPOP"),
    "graph-415": ("023", "Perylene"), "graph-338": ("024", "1,6-Diphenylhexatriene"),
    "graph-193": ("043", "Biphenyl"), "graph-401": ("079", "Pyrene"),
    "graph-254": ("082", "p-Quaterphenyl"), "graph-131": ("090", "Toluene"),
}
PCC_BASE = "https://omlc.org/spectra/PhotochemCAD/data"


def download_photochemcad(out):
    import urllib.request
    ddir = os.path.join(out, "photochemcad", "data")
    os.makedirs(ddir, exist_ok=True)
    ids = sorted(set(pid for pid, _ in PCC_MAP.values()))
    n = 0
    for pid in ids:
        for kind in ("abs", "ems"):
            dst = os.path.join(ddir, f"{pid}-{kind}.txt")
            if os.path.exists(dst) and os.path.getsize(dst) > 0:
                n += 1; continue
            try:
                urllib.request.urlretrieve(f"{PCC_BASE}/{pid}-{kind}.txt", dst)
                n += 1
            except Exception as e:
                print(f"  ! could not fetch {pid}-{kind}: {e}")
    print(f"photochemcad reference: {n} files in {ddir}")
    return ddir


def _load_pcc(ddir, pid, kind):
    f = os.path.join(ddir, f"{pid}-{kind}.txt")
    if not os.path.exists(f):
        return None
    arr = np.loadtxt(f, comments="#", delimiter="\t")
    if arr.ndim != 2 or len(arr) < 3:
        return None
    nm, val = arr[:, 0], arr[:, 1]
    keep = nm > 0; nm, val = nm[keep], val[keep]
    wn = 1e7 / nm; o = np.argsort(wn)
    return wn[o], val[o]


def _load_berlman(data_dir, graph, role):
    f = os.path.join(data_dir, graph + ".csv")
    if not os.path.exists(f):
        return None
    col = "intensity_norm" if role == "emission" else "molar_extinction"
    wn, v = [], []
    for row in csv.DictReader(open(f)):
        if row["curve"] != role:
            continue
        try:
            w = float(row["wavenumber_cm-1"]); y = float(row[col])
        except (ValueError, KeyError):
            continue
        wn.append(w); v.append(y)
    if len(wn) < 3:
        return None
    wn = np.array(wn); v = np.array(v); o = np.argsort(wn)
    return wn[o], v[o]


def _norm(y):
    y = y - np.nanmin(y); m = np.nanmax(y)
    return y / m if m > 0 else y


def cross_validate(out):
    """Compare digitized curves against PhotoChemCAD; write csv + plot."""
    ddir = download_photochemcad(out)
    data_dir = os.path.join(out, "data")
    rows = []
    items = sorted(PCC_MAP.items(), key=lambda kv: kv[1][1])
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(len(items), 2, figsize=(13, 2.5 * len(items)))
    for i, (graph, (pid, name)) in enumerate(items):
        for j, role in enumerate(("emission", "absorption")):
            ax = axes[i, j]
            bern = _load_berlman(data_dir, graph, role)
            pcc = _load_pcc(ddir, pid, "ems" if role == "emission" else "abs")
            if pcc is not None:
                ax.plot(pcc[0], _norm(pcc[1]), color="#0e8f7f", lw=1.1,
                        alpha=0.8, label="PhotoChemCAD (ref.)", zorder=1)
            if bern is not None:
                bx, by = bern[0][::5], _norm(bern[1])[::5]  # subsample so dots read as dots
                ax.plot(bx, by, "o", color="#c8483a", ms=2.2, mew=0,
                        label="Berlman (ours)", zorder=2)
            title = role
            if bern is not None and pcc is not None:
                lo = max(bern[0].min(), pcc[0].min()); hi = min(bern[0].max(), pcc[0].max())
                if hi - lo > 500:
                    g = np.linspace(lo, hi, 400)
                    fa = _norm(np.interp(g, bern[0], bern[1])); fb = _norm(np.interp(g, pcc[0], pcc[1]))
                    r = float(np.corrcoef(fa, fb)[0, 1])
                    dpk = g[np.argmax(fa)] - g[np.argmax(fb)]
                    title = f"{role}  r={r:.3f}  Δpeak={dpk:+.0f} cm⁻¹"
                    rows.append(dict(compound=name, role=role, pearson_r=round(r, 4),
                                     peak_mine_cm=round(g[np.argmax(fa)]),
                                     peak_pcc_cm=round(g[np.argmax(fb)]), dpeak_cm=round(dpk)))
            if j == 0:
                ax.set_ylabel(name, fontsize=9, rotation=0, ha="right", va="center")
            ax.set_title(title, fontsize=8); ax.tick_params(labelsize=7)
            if i == 0 and j == 0:
                ax.legend(fontsize=7)
    for ax in axes[-1]:
        ax.set_xlabel("wave number (cm⁻¹)", fontsize=8)
    fig.suptitle("Berlman digitization vs. PhotoChemCAD (independent measurement) — normalized", y=1.002)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "pcc_comparison.png"), dpi=130, bbox_inches="tight")
    with open(os.path.join(out, "pcc_comparison.csv"), "w", newline="") as fp:
        wc = csv.DictWriter(fp, fieldnames=["compound", "role", "pearson_r",
                                            "peak_mine_cm", "peak_pcc_cm", "dpeak_cm"])
        wc.writeheader(); wc.writerows(rows)
    em = [x["pearson_r"] for x in rows if x["role"] == "emission"]
    ab = [x["pearson_r"] for x in rows if x["role"] == "absorption"]
    print(f"cross-validation: emission mean r={np.mean(em):.3f} (n={len(em)}), "
          f"absorption mean r={np.mean(ab):.3f} (n={len(ab)})  -> pcc_comparison.png/csv")
    return rows


PCC_HEADER = (
    "# {kind} spectrum of {mol} (Berlman {gid})\n#\n"
    "# Digitized automatically from I. B. Berlman, \"Handbook of Fluorescence\n"
    "#   Spectra of Aromatic Molecules,\" 2nd Ed., Academic Press, 1971.\n"
    "# Wave number converted to wavelength: nm = 1e7 / cm^-1.\n"
    "# Format mirrors PhotoChemCAD (omlc.org/spectra/PhotochemCAD).\n#\n"
    "##Wavelength (nm)\t{col}\n"
)


def export_pcc_format(out):
    data_dir = os.path.join(out, "data")
    edir = os.path.join(out, "export_pcc_format")
    os.makedirs(edir, exist_ok=True)
    names = {}
    rc = os.path.join(out, "report.csv")
    if os.path.exists(rc):
        names = {r["name"]: r["molecule"] for r in csv.DictReader(open(rc))}
    n = 0
    for f in sorted(glob.glob(os.path.join(data_dir, "graph-*.csv"))):
        gid = os.path.basename(f).replace(".csv", "")
        curves = {}
        for row in csv.DictReader(open(f)):
            try:
                wn = float(row["wavenumber_cm-1"])
            except (ValueError, KeyError):
                continue
            if wn <= 0:
                continue
            curves.setdefault(row["curve"], []).append(
                (1e7 / wn, float(row["intensity_norm"]), row["molar_extinction"]))
        for label, pts in curves.items():
            pts.sort()
            is_abs = label.startswith("absorption")
            suffix = ("abs" if is_abs else "ems")
            if label not in ("emission", "absorption"):
                suffix += "-" + label.split("_")[-1]
            with open(os.path.join(edir, f"{gid}-{suffix}.txt"), "w") as fp:
                fp.write(PCC_HEADER.format(
                    kind="Optical absorption" if is_abs else "Emission",
                    mol=names.get(gid, "?") or "?", gid=gid,
                    col="Molar Extinction (cm-1/M)" if is_abs else "Emission (normalized)"))
                for nm, inten, ext in pts:
                    fp.write(f"{nm:.2f}\t{ext if (is_abs and ext) else f'{inten:.4f}'}\n")
            n += 1
    print(f"exported {n} PhotoChemCAD-format files -> {edir}")


# ─────────────────────────────────────────────────────────────────────────────
# 9. DASHBOARD
# ─────────────────────────────────────────────────────────────────────────────

def make_dashboard(out):
    import html
    r = json.load(open(os.path.join(out, "report.json")))
    r.sort(key=lambda d: int(d["name"].split("-")[1]))
    f1 = np.array([d["f1"] for d in r]); col = np.array([d["col_cov"] for d in r])
    edges = [0, .5, .6, .7, .8, .85, .9, .95, 1.0001]
    labs = ["<.50", ".50", ".60", ".70", ".80", ".85", ".90", ".95+"]
    hist = np.histogram(f1, edges)[0]; hmax = max(hist) or 1
    npts = sum(sum(1 for _ in open(f)) - 1 for f in glob.glob(os.path.join(out, "data", "*.csv")))
    pcc = os.path.join(out, "pcc_comparison.csv")
    pcc_html = ""
    if os.path.exists(pcc):
        pr = list(csv.DictReader(open(pcc)))
        em = [float(x["pearson_r"]) for x in pr if x["role"] == "emission"]
        ab = [float(x["pearson_r"]) for x in pr if x["role"] == "absorption"]
        prows = "".join(f"<tr><td>{html.escape(x['compound'])}</td><td>{x['role']}</td>"
                        f"<td class=n>{float(x['pearson_r']):.3f}</td>"
                        f"<td class=n>{int(x['dpeak_cm']):+d}</td></tr>" for x in pr)
        pcc_html = (f"<h2>External validation vs. PhotoChemCAD</h2>"
                    f"<p class=sub>Independent instrument measurements of the same fluorophores. "
                    f"Emission mean r={np.mean(em):.3f}, absorption mean r={np.mean(ab):.3f}.</p>"
                    f"<table><thead><tr><th>compound</th><th>curve</th><th class=n>Pearson r</th>"
                    f"<th class=n>Δpeak cm⁻¹</th></tr></thead><tbody>{prows}</tbody></table>")
    bars = "".join(f"<div class=bar><div class=hn>{h}</div>"
                   f"<div class=ht><div class=hf style='height:{h/hmax*100:.0f}%'></div></div>"
                   f"<div class=hl>{l}</div></div>" for h, l in zip(hist, labs))
    rows = "".join(
        f"<tr><td class=mono>{d['name'].split('-')[1]}</td><td>{html.escape((d.get('molecule') or '')[:30])}</td>"
        f"<td class=n><b class='{'g' if d['f1']>=.95 else 'w' if d['f1']>=.85 else 'b'}'>{d['f1']:.3f}</b></td>"
        f"<td class='n mono'>{d['col_cov']:.3f}</td><td class='n mono'>{d['n_curves']}</td>"
        f"<td>{d.get('strategy') or ''}</td></tr>" for d in r)
    doc = f"""<title>Berlman Spectra Digitization</title>
<h1>Berlman fluorescence spectra — digitized &amp; self-scored</h1>
<p class=sub>All {len(r)} plates (GRAPH 1C–209A) processed by one program; each curve rebuilt and scored against the original ink.</p>
<div class=cards>
<div class=card><b>{len(r)}</b>pages</div><div class=card><b>{npts:,}</b>data points</div>
<div class=card><b>{np.median(f1):.3f}</b>median F1</div><div class=card><b>{(f1>=.95).sum()}</b>F1≥0.95</div>
<div class=card><b>{(f1>=.90).sum()}</b>F1≥0.90</div></div>
<h2>F1 distribution</h2><div class=hist>{bars}</div>
{pcc_html}
<h2>Per-page results</h2>
<input id=q placeholder="filter…" oninput="for(const t of document.querySelectorAll('#t tbody tr'))t.style.display=t.innerText.toLowerCase().includes(this.value.toLowerCase())?'':'none'">
<table id=t><thead><tr><th>graph</th><th>molecule</th><th class=n>F1</th><th class=n>col-cov</th><th class=n>curves</th><th>strategy</th></tr></thead><tbody>{rows}</tbody></table>
<style>
:root{{color-scheme:light dark;--bg:#f6f7f9;--fg:#12161c;--mut:#5a6573;--line:#e2e6ec;--pan:#fff;--ac:#0e9f8f;--g:#1f9d63;--w:#c07a12;--b:#c8483a}}
@media(prefers-color-scheme:dark){{:root{{--bg:#0d1117;--fg:#e8edf3;--mut:#93a1b3;--line:#232c37;--pan:#151b23;--ac:#2dd4bf;--g:#3fd07f;--w:#e0a94d;--b:#e56a5c}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:40px 24px;max-width:1000px;margin:auto}}
h1{{font-size:30px;letter-spacing:-.02em;margin:0 0 8px}}h2{{font-size:15px;margin:34px 0 12px}}
.sub{{color:var(--mut);max-width:65ch}}
.cards{{display:flex;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:20px 0}}
.card{{background:var(--pan);padding:16px 20px;flex:1;font-size:12px;color:var(--mut)}}.card b{{display:block;font-size:26px;color:var(--ac);font-variant-numeric:tabular-nums}}
.hist{{display:flex;gap:6px;align-items:flex-end;height:170px;max-width:560px}}
.bar{{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;gap:4px}}
.ht{{width:100%;height:100%;display:flex;align-items:flex-end}}.hf{{width:100%;background:var(--ac);border-radius:3px 3px 0 0;min-height:2px}}
.hn{{font:11px ui-monospace,monospace;color:var(--mut)}}.hl{{font:10px ui-monospace,monospace;color:var(--mut)}}
table{{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}}
th,td{{padding:5px 9px;border-bottom:1px solid var(--line);text-align:left}}th{{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}}
.n{{text-align:right}}.mono,td.n{{font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums}}
b.g{{color:var(--g)}}b.w{{color:var(--w)}}b.b{{color:var(--b)}}
#q{{padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--pan);color:var(--fg);width:260px;margin:4px 0}}
</style>"""
    p = os.path.join(out, "dashboard.html")
    open(p, "w").write(doc)
    print(f"dashboard -> {p}")


# ─────────────────────────────────────────────────────────────────────────────
# 10. CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Digitize every spectra plate in Berlman's Handbook (one program, run once).")
    ap.add_argument("input", help="PDF of the handbook (or a single page image with --digitize-only)")
    ap.add_argument("--out", default="berlman_output", help="output directory (default: ./berlman_output)")
    ap.add_argument("--pages", default="124-431", help="PDF page range of the graphs (default 124-431)")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--jobs", type=int, default=os.cpu_count())
    ap.add_argument("--force", action="store_true", help="re-render pages even if present")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--no-validate", action="store_true", help="skip PhotoChemCAD download + cross-check")
    ap.add_argument("--no-export", action="store_true", help="skip PhotoChemCAD-format export")
    ap.add_argument("--no-dashboard", action="store_true")
    ap.add_argument("--digitize-only", action="store_true", help="INPUT is one page image; print curves")
    args = ap.parse_args()

    if args.digitize_only:
        r = digitize(args.input)
        print(f"{args.input}: strategy={r['strategy']} curves=" +
              ", ".join(f"{c['role']}[{int(c['px'].min())}..{int(c['px'].max())}]" for c in r["curves"]))
        return

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    lo, hi = (int(x) for x in args.pages.split("-"))

    if not args.no_render:
        pages_dir = render_pages(args.input, out, lo, hi, args.dpi, args.force)
    else:
        pages_dir = os.path.join(out, "pages")

    run_batch(os.path.join(pages_dir, "graph-*.png"), out, args.jobs)

    if not args.no_validate:
        try:
            cross_validate(out)
        except Exception as e:
            print(f"validation skipped ({e})")
    if not args.no_export:
        export_pcc_format(out)
    if not args.no_dashboard:
        make_dashboard(out)

    print(f"\nAll outputs in {out}/  (data/, overlays/, report.csv, dashboard.html)")


if __name__ == "__main__":
    main()
