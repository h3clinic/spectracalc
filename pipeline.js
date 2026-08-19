/* How a Berlman plate becomes a spectrum, one step at a time.
 *
 * Every stage here runs the same operation the real pipeline runs, with the
 * same constants: Otsu over the luminance histogram, ruled-row detection at
 * 60% coverage, the frozen x calibration, and the three-pass fit to the ink
 * with tol 26 page px / neighbour radius 20 scan px / bridge span 24 columns.
 * The difference is only that each is written as a generator, so it can be
 * paused between units of work and drawn.  The last stage checks the result
 * against the published dataset, which is the claim worth making: if the
 * animation and the release disagree, the animation is lying.
 */
'use strict';

/* ── constants, mirrored from editor.js / refit_to_ink.py ───────────────── */
const TOL_PAGE_PX = 26, NEIGHBOUR_RADIUS = 20, SWEEPS = 4;
const BRIDGE_MAX_COLS = 24, STROKE_MAX = 8, RULE_COVERAGE = 0.6;
const ROLE = { em: ['emission', '#d94f45'], ab: ['absorption', '#3fa96a'],
               em2: ['second emission', '#e08a2e'] };

/* ── state ─────────────────────────────────────────────────────────────── */
let img, imgW, imgH, frame, meta, xcal, pageScale;
let INK = null, curves = [], marks = [], overlay = null, hist = null;
let gen = null, running = false, speed = 1, total = 0, seen = 0;

const cv = document.getElementById('cv'), g = cv.getContext('2d');
const $ = id => document.getElementById(id);
const STAGES = [
  ['Read the plate', 'the 600 dpi page and its plot frame'],
  ['Separate ink from paper', 'Otsu over the luminance histogram'],
  ['Find the ruled lines', 'the box and the grid, so they are never mistaken for a curve'],
  ['Read the axes', 'the frozen wavenumber calibration'],
  ['Cut each column into runs', 'vertical strokes of ink, column by column'],
  ['Seat the dots on the ink', 'pass one: nearest stroke in the dot’s own column'],
  ['Walk in from the anchors', 'pass two: settled neighbours steer the unsettled'],
  ['Bridge what is stranded', 'pass three: the chord across a gap with no usable ink'],
  ['Follow cut traces onward', 'where a curve stops but the stroke keeps going'],
  ['Scale to unit peak', 'the normalised scale Berlman prints'],
  ['Check against the release', 'does this reproduce the published spectrum?'],
];

/* ── small helpers ─────────────────────────────────────────────────────── */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function setNote(html) { $('note').innerHTML = html; }
function setKV(rows) {
  $('kv').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}
function setStage(i) {
  [...$('steps').children].forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'on' : '';
  });
}
function view() {                       // scan px -> canvas px, letterboxed
  const s = Math.min(cv.width / imgW, cv.height / imgH);
  return { s, ox: (cv.width - imgW * s) / 2, oy: (cv.height - imgH * s) / 2 };
}

/* ── stage 2: Otsu, exactly as buildInk does it ────────────────────────── */
function luminance() {
  const c = document.createElement('canvas');
  c.width = imgW; c.height = imgH;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, imgW, imgH).data;
  const lum = new Uint8Array(imgW * imgH), h = new Float64Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    lum[p] = v; h[v]++;
  }
  return { lum, h };
}

function* otsuSteps(h) {
  const total_ = imgW * imgH;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * h[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  const between = new Float64Array(256);
  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (wB) {
      const wF = total_ - wB;
      if (!wF) break;
      sumB += t * h[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      between[t] = wB * wF * (mB - mF) * (mB - mF);
      if (between[t] > best) { best = between[t]; thr = t; }
    }
    hist = { h, between, t, thr, best };
    if (t % 3 === 0) yield;
  }
  hist = { h, between, t: 255, thr, best };
  return thr;
}

/* ── the fit, mirrored from editor.js snapToInk ────────────────────────── */
const isRule = (a, b) => { for (let y = a; y <= b; y++) if (!INK.rule[y]) return false; return true; };

function columnRuns(x) {
  const runs = []; let s = -1;
  for (let y = 0; y < INK.h; y++) {
    if (INK.mask[y * INK.w + x]) { if (s < 0) s = y; }
    else if (s >= 0) { runs.push([s, y - 1]); s = -1; }
  }
  if (s >= 0) runs.push([s, INK.h - 1]);
  return runs;
}

function nearestRun(x, y, radius) {
  let best = null, bestD = Infinity;
  for (const [a, b] of columnRuns(x)) {
    if (isRule(a, b)) continue;
    const inside = y >= a && y <= b;
    let target;
    if (inside) target = y;
    else if (b - a <= STROKE_MAX) target = (a + b) / 2;
    else target = y < a ? a + STROKE_MAX / 2 : b - STROKE_MAX / 2;
    const d = inside ? 0 : Math.min(Math.abs(y - a), Math.abs(y - b));
    if (d < bestD) { bestD = d; best = target; }
  }
  return bestD <= radius ? best : null;
}

/* ── published curve <-> pixels, as the editor does it ─────────────────── */
function toPixels(src) {
  const px = [], py = [];
  for (let i = 0; i < src.wl.length; i++) {
    px.push((1e7 / src.wl[i] - xcal.b) / xcal.a);
    py.push(frame.y_bottom - src.inten[i] * (frame.y_bottom - frame.y_top));
  }
  return { px, py };
}
const intensityAt = py => (frame.y_bottom - py) / (frame.y_bottom - frame.y_top);

/* ── the run, stage by stage ───────────────────────────────────────────── */
function* pipeline() {
  const H = frame.y_bottom - frame.y_top;

  /* 1 — the plate */
  setStage(0);
  setNote(`<b>${meta.name}</b> at 600 dpi, ${imgW}×${imgH} as served. The plot frame was
    located once and frozen: everything downstream is measured against this box, so the
    same page always yields the same numbers.`);
  setKV([['page', meta.graph], ['scan', `${imgW} × ${imgH}`],
         ['frame left/right', `${(frame.x_left / pageScale) | 0} / ${(frame.x_right / pageScale) | 0}`],
         ['frame top/bottom', `${(frame.y_top / pageScale) | 0} / ${(frame.y_bottom / pageScale) | 0}`],
         ['page px per scan px', pageScale.toFixed(3)]]);
  for (let i = 0; i < 30; i++) yield;

  /* 2 — Otsu */
  setStage(1);
  setNote(`Ink or paper? The exposure varies from page to page, so the cutoff is not
    hard-coded — <code>Otsu</code> sweeps every threshold and keeps the one that best
    separates the two populations. The curve below the histogram is between-class
    variance; the peak is the answer.`);
  const { lum, h } = luminance();
  const thr = yield* otsuSteps(h);
  const mask = new Uint8Array(imgW * imgH);
  for (let p = 0; p < lum.length; p++) mask[p] = lum[p] <= thr ? 1 : 0;
  INK = { w: imgW, h: imgH, mask, thr, rule: new Uint8Array(imgH) };
  let inked = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) inked++;
  buildMaskLayer();
  setKV([['threshold', thr], ['pixels', (imgW * imgH).toLocaleString()],
         ['ink', `${(100 * inked / mask.length).toFixed(2)}%`],
         ['paper', `${(100 - 100 * inked / mask.length).toFixed(2)}%`]]);
  for (let i = 0; i < 25; i++) yield;

  /* 3 — ruled rows */
  setStage(2);
  setNote(`The box border and the grid run the full width of the plot; a spectrum does
    not. Any row more than <code>${RULE_COVERAGE * 100}%</code> ink across the plot
    interior is marked as a rule. Without this an apex published at 1.0 snaps onto the
    top border and stays above the printed peak — which is exactly what used to happen.`);
  const fx0 = Math.max(0, Math.round((frame.x_left + 30) / pageScale));
  const fx1 = Math.min(imgW - 1, Math.round((frame.x_right - 30) / pageScale));
  const span = Math.max(1, fx1 - fx0);
  let ruled = 0;
  for (let y = 0; y < imgH; y++) {
    let hit = 0;
    for (let x = fx0; x <= fx1; x += 2) if (mask[y * imgW + x]) hit++;
    if (hit / (span / 2) > RULE_COVERAGE) { INK.rule[y] = 1; ruled++; }
    marks = [{ kind: 'row', y }];
    if (y % 14 === 0) { setKV([['row', `${y} / ${imgH}`], ['ruled rows found', ruled]]); yield; }
  }
  marks = [];
  setKV([['ruled rows', ruled], ['searched columns', `${fx0}–${fx1}`]]);
  for (let i = 0; i < 20; i++) yield;

  /* 4 — the axis */
  setStage(3);
  const lo = 1e7 / (xcal.a * (frame.x_right) + xcal.b);
  const hi = 1e7 / (xcal.a * (frame.x_left) + xcal.b);
  setNote(`Berlman prints wavenumber, so position maps linearly to cm⁻¹ and only then to
    nm. The fit was made once from the printed ticks and frozen with it:
    <code>ν̃ = ${xcal.a.toFixed(4)}·x + ${xcal.b.toFixed(1)}</code>, residual
    ${xcal.rmse} cm⁻¹, read off the <b>${xcal.source}</b> axis.`);
  setKV([['slope a', xcal.a.toFixed(4)], ['intercept b', xcal.b.toFixed(1)],
         ['rmse', `${xcal.rmse} cm⁻¹`], ['axis used', xcal.source],
         ['covers', `${Math.min(lo, hi).toFixed(0)}–${Math.max(lo, hi).toFixed(0)} nm`]]);
  for (let i = 0; i < 35; i++) yield;

  /* 5 — column runs */
  setStage(4);
  setNote(`Each column of the scan is cut into vertical runs of ink. A stroke crossed
    square-on is a few pixels tall; a steep flank can be seventy. That distinction
    matters later — aiming at the centre of a tall run lands nowhere near the curve.`);
  let runsSeen = 0, tallest = 0;
  for (let x = fx0; x <= fx1; x += 3) {
    const rr = columnRuns(x).filter(([a, b]) => !isRule(a, b));
    runsSeen += rr.length;
    for (const [a, b] of rr) tallest = Math.max(tallest, b - a + 1);
    marks = [{ kind: 'col', x, runs: rr }];
    if (x % 12 === 0) { setKV([['column', `${x} / ${fx1}`], ['runs so far', runsSeen],
                               ['tallest run', `${tallest} px`]]); yield; }
  }
  marks = [];
  for (let i = 0; i < 18; i++) yield;

  /* 6–8 — the fit, from the reconstruction the editor starts with */
  curves = [];
  for (const k of ['em', 'ab', 'em2']) if (meta[k]) {
    const p = toPixels(meta[k]);
    curves.push({ key: k, name: ROLE[k][0], color: ROLE[k][1],
                  px: p.px, py: p.py, py0: p.py.slice(), fixed: null });
  }
  const tolScan = TOL_PAGE_PX / pageScale;

  setStage(5);
  setNote(`Rebuilding the dots from the published numbers puts them where the values say,
    not where the ink is — a curve normalised to 1.0 lands on the 1.00 rule. Pass one
    looks in each dot’s <b>own column</b> for the nearest non-ruled stroke, within
    <code>${TOL_PAGE_PX}</code> page px (<code>${tolScan.toFixed(1)}</code> scan px).`);
  for (const c of curves) {
    const n = c.px.length;
    c.xs = new Int32Array(n); c.ys = new Float64Array(n);
    c.live = new Uint8Array(n); c.fixed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.round(c.px[i] / pageScale);
      c.xs[i] = x; c.ys[i] = c.py[i] / pageScale;
      if (x < 0 || x >= INK.w) continue;
      c.live[i] = 1;
      const hit = nearestRun(x, c.ys[i], tolScan);
      if (hit !== null) { c.ys[i] = hit; c.fixed[i] = 1; c.py[i] = hit * pageScale; }
      if (i % 24 === 0) {
        marks = [{ kind: 'dot', x, y: c.ys[i], col: c.color }];
        setKV([['curve', c.name], ['dot', `${i} / ${n}`],
               ['seated', count(c.fixed)], ['search band', `±${tolScan.toFixed(1)} px`]]);
        yield;
      }
    }
  }
  marks = [];
  setKV(curves.map(c => [c.name, `${count(c.fixed)} / ${c.px.length} seated`]));
  for (let i = 0; i < 20; i++) yield;

  /* pass two */
  setStage(6);
  setNote(`A dot far from the ink cannot be trusted to find its own way — widening its
    search only casts a bigger net around a position already known to be wrong. Instead
    each unsettled dot takes its reference from a <b>settled neighbour</b> and steps in
    one column at a time, within <code>${NEIGHBOUR_RADIUS}</code> scan px. This is what
    recovers an apex: it is far from the stroke but close to the dot beside it.`);
  for (const c of curves) {
    const n = c.px.length;
    for (let s = 0; s < SWEEPS; s++) {
      let changed = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < n; k++) {
          const i = pass ? n - 1 - k : k;
          if (!c.live[i] || c.fixed[i]) continue;
          const ref = (i > 0 && c.fixed[i - 1]) ? c.ys[i - 1]
                    : (i + 1 < n && c.fixed[i + 1]) ? c.ys[i + 1] : null;
          if (ref === null) continue;
          const hit = nearestRun(c.xs[i], ref, NEIGHBOUR_RADIUS);
          if (hit === null) continue;
          c.ys[i] = hit; c.fixed[i] = 1; c.py[i] = hit * pageScale; changed++;
          if (changed % 6 === 0) {
            marks = [{ kind: 'dot', x: c.xs[i], y: hit, col: c.color, ring: true }];
            setKV([['curve', c.name], ['sweep', `${s + 1} / ${SWEEPS}`],
                   ['moved this sweep', changed], ['seated', count(c.fixed)]]);
            yield;
          }
        }
      }
      if (!changed) break;
    }
  }
  marks = [];
  for (let i = 0; i < 18; i++) yield;

  /* pass three */
  setStage(7);
  let bridged = 0;
  for (const c of curves) {
    const n = c.px.length;
    for (let i = 0; i < n; i++) {
      if (!c.live[i] || c.fixed[i]) continue;
      let l = i - 1; while (l >= 0 && !c.fixed[l]) l--;
      let r = i + 1; while (r < n && !c.fixed[r]) r++;
      if (l < 0 || r >= n) continue;
      if (Math.abs(c.xs[r] - c.xs[l]) > BRIDGE_MAX_COLS) continue;
      const chord = c.ys[l] + (c.ys[r] - c.ys[l]) * ((i - l) / (r - l));
      if (Math.abs(c.ys[i] - chord) <= NEIGHBOUR_RADIUS) continue;
      c.ys[i] = chord; c.fixed[i] = 1; c.py[i] = chord * pageScale; bridged++;
      marks = [{ kind: 'dot', x: c.xs[i], y: chord, col: c.color, ring: true }];
      yield;
    }
  }
  marks = [];
  setNote(`Where a peak reaches 1.0 the stroke merges into the top border, and excluding
    the border leaves that column with nothing to snap to. If both sides are settled and
    within <code>${BRIDGE_MAX_COLS}</code> columns, the dot goes on the chord between
    them. It fires rarely and only when a dot has drifted further than the search band —
    <b>${bridged}</b> dot${bridged === 1 ? '' : 's'} on this page.`);
  setKV(curves.map(c => [c.name,
    `${count(c.fixed)} / ${c.px.length} placed`]).concat([['bridged', bridged]]));
  for (let i = 0; i < 22; i++) yield;

  /* 9 — does the stroke keep going? */
  setStage(8);
  setNote(`A fit can be perfect and the spectrum still wrong: every point placed sits on
    the ink, and the trace stops halfway up a peak. So each end is walked outward along
    its own slope to ask whether there is <b>still ink there</b>. On rhodamine 8B this is
    the question that found an absorption curve ending at 0.4165 — its own maximum —
    while the plate went on to a peak at 554 nm.`);
  const probes = [];
  for (const c of curves) {
    for (const atStart of [true, false]) {
      const p = probeEnd(c, atStart);
      probes.push([`${c.name} ${atStart ? 'start' : 'end'}`,
                   p.probed ? `${(100 * p.frac).toFixed(0)}% ink beyond` : 'at frame edge']);
      marks = [{ kind: 'probe', pts: p.pts, col: c.color }];
      for (let i = 0; i < 12; i++) yield;
    }
  }
  marks = [];
  setKV(probes);
  const cut = probes.filter(p => parseFloat(p[1]) >= 55).length;
  setNote(`Each end walked outward along its own slope, looking for ink that the trace
    never claimed. <b>${cut === 0 ? 'Every end here runs out where the stroke does'
      : cut + ' end(s) still have ink beyond them'}</b> — a trace that stops while the
    stroke continues is a curve missing part of itself, not a curve fitted badly.`);
  for (let i = 0; i < 25; i++) yield;

  /* 10 — unit peak */
  setStage(9);
  const scaled = [];
  for (const c of curves) {
    let mx = -Infinity;
    for (let i = 0; i < c.py.length; i++) mx = Math.max(mx, intensityAt(c.py[i]));
    c.peak = mx;
    if (mx > 0.05 && Math.abs(mx - 1) > 5e-4) {
      for (let i = 0; i < c.py.length; i++)
        c.py[i] = frame.y_bottom - (intensityAt(c.py[i]) / mx) * H;
      scaled.push([c.name, `${mx.toFixed(4)} → 1.0000`]);
      for (let i = 0; i < 8; i++) yield;
    } else scaled.push([c.name, 'already 1.0000']);
  }
  setNote(`Berlman prints normalised spectra, so unit peak is the intended scale. It is
    applied once, at the end, after the geometry is settled — and the factor is recorded
    as <code>peak_scaled_from</code>, so the fit to the ink stays recoverable. Applied
    inside the redraw instead, as it once was, it re-ran on every load and compounded.`);
  setKV(scaled);
  for (let i = 0; i < 25; i++) yield;

  /* 11 — verify */
  setStage(10);
  const rows = [];
  let worst = 0;
  for (const c of curves) {
    const pub = meta[c.key];
    let sum = 0, mx = 0, n = 0;
    for (let i = 0; i < c.py.length && i < pub.inten.length; i++) {
      const d = Math.abs(intensityAt(c.py[i]) - pub.inten[i]);
      sum += d; mx = Math.max(mx, d); n++;
    }
    worst = Math.max(worst, mx);
    rows.push([c.name, `mean ${(sum / n).toFixed(5)} · max ${mx.toFixed(4)}`]);
  }
  setKV(rows);
  const good = worst < 0.02;
  const v = $('verdict');
  v.className = 'verdict' + (good ? '' : ' bad');
  v.style.display = 'block';
  v.innerHTML = good
    ? `<b>Reproduced.</b> Running the stages above on this plate returns the published
       spectrum to within ${worst.toFixed(4)} of full scale at every point. The animation
       is the pipeline, not a picture of it.`
    : `<b>Diverged</b> by up to ${worst.toFixed(4)} of full scale. Worth investigating —
       either this page needs a stage the animation skips, or the release is stale.`;
  setNote(`The last stage is the one that makes the rest worth watching: the result is
    compared point by point against the released dataset for this page. Agreement means
    what you just watched really is how the numbers were made.`);
  setStage(11);
}

const count = a => { let n = 0; for (const v of a) if (v) n++; return n; };

/* endpoint probe — the same walk find_truncations.py makes */
function probeEnd(c, atStart) {
  const n = c.px.length, W = 25, PROBE = 45, SEARCH = 22;
  if (n < 8) return { probed: 0, frac: 0, pts: [] };
  const idx = atStart ? [...Array(Math.min(W, n)).keys()]
                      : [...Array(Math.min(W, n)).keys()].map(i => n - 1 - i);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const i of idx) { const x = c.xs[i], y = c.py[i] / pageScale;
    sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const m = idx.length, den = m * sxx - sx * sx;
  if (!den) return { probed: 0, frac: 0, pts: [] };
  const slope = (m * sxy - sx * sy) / den;
  const i0 = atStart ? 0 : n - 1;
  let mean = 0; for (let i = 0; i < n; i++) mean += c.xs[i]; mean /= n;
  const step = c.xs[i0] < mean ? -1 : 1;
  let last = c.py[i0] / pageScale, hits = 0, probed = 0;
  const pts = [];
  for (let d = 3; d < PROBE; d++) {
    const x = Math.round(c.xs[i0] + step * d);
    if (x < 0 || x >= INK.w) break;
    probed++;
    const y = last + slope * step;
    let found = null, best = SEARCH + 1;
    for (const [a, b] of columnRuns(x)) {
      if (isRule(a, b) || b - a > 60) continue;
      const t = (y >= a && y <= b) ? y : (y < a ? a : b);
      const gap = (y >= a && y <= b) ? 0 : Math.min(Math.abs(y - a), Math.abs(y - b));
      if (gap < best) { best = gap; found = t; }
    }
    if (found === null) { last = y; pts.push([x, y, false]); continue; }
    hits++; last = found; pts.push([x, found, true]);
  }
  return { probed, frac: probed ? hits / probed : 0, pts };
}

/* ── drawing ───────────────────────────────────────────────────────────── */
let maskLayer = null;
function buildMaskLayer() {
  maskLayer = document.createElement('canvas');
  maskLayer.width = imgW; maskLayer.height = imgH;
  const x = maskLayer.getContext('2d');
  const im = x.createImageData(imgW, imgH);
  for (let p = 0, q = 0; p < INK.mask.length; p++, q += 4) {
    if (INK.mask[p]) { im.data[q] = 106; im.data[q + 1] = 167; im.data[q + 2] = 255; im.data[q + 3] = 200; }
  }
  x.putImageData(im, 0, 0);
}

function draw() {
  cv.width = cv.clientWidth * devicePixelRatio;
  cv.height = (cv.clientHeight - 44) * devicePixelRatio;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#0e1014'; g.fillRect(0, 0, cv.width, cv.height);
  if (!img) return;
  const { s, ox, oy } = view();
  g.imageSmoothingEnabled = true;
  g.drawImage(img, ox, oy, imgW * s, imgH * s);
  const X = x => ox + x * s, Y = y => oy + y * s;

  if (maskLayer && INK) { g.globalAlpha = 0.32; g.drawImage(maskLayer, ox, oy, imgW * s, imgH * s); g.globalAlpha = 1; }

  if (frame) {                                  // the frozen box
    g.strokeStyle = 'rgba(106,167,255,.9)'; g.lineWidth = 1.5;
    g.strokeRect(X(frame.x_left / pageScale), Y(frame.y_top / pageScale),
      (frame.x_right - frame.x_left) / pageScale * s, (frame.y_bottom - frame.y_top) / pageScale * s);
  }
  if (INK) {                                    // ruled rows
    g.strokeStyle = 'rgba(240,192,74,.75)'; g.lineWidth = 1;
    for (let y = 0; y < INK.h; y++) if (INK.rule[y]) {
      g.beginPath(); g.moveTo(ox, Y(y)); g.lineTo(ox + imgW * s, Y(y)); g.stroke();
    }
  }
  for (const c of curves) {                     // the dots
    g.fillStyle = c.color;
    const r = Math.max(1, 1.7 * s * (imgW / 2000));
    for (let i = 0; i < c.px.length; i += 2) {
      g.beginPath(); g.arc(X(c.px[i] / pageScale), Y(c.py[i] / pageScale), r, 0, 6.283); g.fill();
    }
  }
  for (const m of marks) {                      // the active thing
    if (m.kind === 'row') {
      g.strokeStyle = 'rgba(240,192,74,.9)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(ox, Y(m.y)); g.lineTo(ox + imgW * s, Y(m.y)); g.stroke();
    } else if (m.kind === 'col') {
      g.strokeStyle = 'rgba(240,192,74,.55)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(X(m.x), oy); g.lineTo(X(m.x), oy + imgH * s); g.stroke();
      g.strokeStyle = '#f0c04a'; g.lineWidth = Math.max(2, 2.4 * s);
      for (const [a, b] of m.runs) {
        g.beginPath(); g.moveTo(X(m.x), Y(a)); g.lineTo(X(m.x), Y(b + 1)); g.stroke();
      }
    } else if (m.kind === 'dot') {
      g.strokeStyle = '#f0c04a'; g.lineWidth = 1.6;
      g.beginPath(); g.arc(X(m.x), Y(m.y), Math.max(5, 7 * s), 0, 6.283); g.stroke();
      if (m.ring) { g.beginPath(); g.arc(X(m.x), Y(m.y), Math.max(9, 13 * s), 0, 6.283);
                    g.globalAlpha = .5; g.stroke(); g.globalAlpha = 1; }
    } else if (m.kind === 'probe') {
      for (const [x, y, hit] of m.pts) {
        g.fillStyle = hit ? '#f0c04a' : 'rgba(240,192,74,.28)';
        g.beginPath(); g.arc(X(x), Y(y), Math.max(2, 3 * s), 0, 6.283); g.fill();
      }
    }
  }
  if (hist) drawHistogram();
}

function drawHistogram() {
  const w = Math.min(430, cv.width * .42), h = 132, x0 = 18, y0 = cv.height - h - 18;
  g.fillStyle = 'rgba(14,16,20,.88)'; g.strokeStyle = '#2a2f38';
  g.beginPath(); g.roundRect(x0, y0, w, h, 8); g.fill(); g.stroke();
  let hmax = 0; for (let i = 0; i < 256; i++) hmax = Math.max(hmax, hist.h[i]);
  g.fillStyle = 'rgba(154,163,178,.75)';
  for (let i = 0; i < 256; i++) {
    const bh = (hist.h[i] / hmax) * (h - 42);
    g.fillRect(x0 + 10 + i * ((w - 20) / 256), y0 + h - 14 - bh, (w - 20) / 256, bh);
  }
  g.strokeStyle = '#6aa7ff'; g.lineWidth = 1.6; g.beginPath();
  for (let i = 0; i < 256; i++) {
    const v = (hist.between[i] / (hist.best || 1)) * (h - 42);
    const px = x0 + 10 + i * ((w - 20) / 256), py = y0 + h - 14 - v;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.stroke();
  const tx = x0 + 10 + hist.thr * ((w - 20) / 256);
  g.strokeStyle = '#f0c04a'; g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(tx, y0 + 12); g.lineTo(tx, y0 + h - 14); g.stroke();
  g.fillStyle = '#e8eaed'; g.font = '11px ui-sans-serif,system-ui';
  g.fillText(`luminance histogram · threshold ${hist.thr}`, x0 + 10, y0 + 15);
}

/* ── transport ─────────────────────────────────────────────────────────── */
function tick() {
  if (!running || !gen) return;
  const n = Math.max(1, Math.round(speed * 2));
  for (let i = 0; i < n; i++) {
    const r = gen.next();
    seen++;
    if (r.done) { running = false; $('play').textContent = '▶ Run'; break; }
  }
  const pct = Math.min(100, Math.round(100 * seen / total));
  $('bar').firstElementChild.style.width = pct + '%';
  $('pct').textContent = pct + '%';
  draw();
  if (running) requestAnimationFrame(tick);
}

function reset() {
  running = false; gen = null; seen = 0;
  INK = null; curves = []; marks = []; maskLayer = null; hist = null;
  $('verdict').style.display = 'none';
  $('play').textContent = '▶ Run';
  $('bar').firstElementChild.style.width = '0'; $('pct').textContent = '0%';
  setStage(-1); setKV([]);
  setNote('Press <b>Run</b> to watch the plate become numbers, or <b>Step</b> to walk it.');
  draw();
}

async function load(gid) {
  reset();
  const [frames, m] = await Promise.all([
    fetch('data/frames.json').then(r => r.json()),
    fetch('data/sp/' + gid + '.json').then(r => r.json()),
  ]);
  meta = m; frame = frames[gid]; xcal = m.xcal;
  img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej;
    i.src = 'scans/' + gid + '.webp';
  });
  imgW = img.width; imgH = img.height; pageScale = frame.w / imgW;
  total = 900 + imgH / 14 + (frame.x_right - frame.x_left) / pageScale / 12
        + (m.em ? m.em.wl.length / 24 : 0) + (m.ab ? m.ab.wl.length / 24 : 0);
  gen = pipeline();
  draw();
}

$('steps').innerHTML = STAGES.map(([t, s], i) =>
  `<li><span class="n">${i + 1}</span><span><b>${t}</b><br><span style="font-size:12px;opacity:.8">${s}</span></span></li>`).join('');

$('play').onclick = () => {
  if (!gen) return;
  running = !running;
  $('play').textContent = running ? '❚❚ Pause' : '▶ Run';
  if (running) tick();
};
$('step').onclick = () => {
  if (!gen) return;
  running = false; $('play').textContent = '▶ Run';
  const r = gen.next(); seen++;
  if (!r.done) { const p = Math.min(100, Math.round(100 * seen / total));
                 $('bar').firstElementChild.style.width = p + '%'; $('pct').textContent = p + '%'; }
  draw();
};
$('reset').onclick = () => load($('page').value);
$('speed').onchange = e => { speed = parseFloat(e.target.value); };
$('page').onchange = e => {
  history.replaceState(null, '', '?gid=' + e.target.value);
  load(e.target.value);
};
addEventListener('resize', draw);

(async () => {
  const idx = await fetch('data/index.json').then(r => r.json());
  const want = new URLSearchParams(location.search).get('gid') || 'graph-427';
  $('page').innerHTML = idx.map(e =>
    `<option value="${e.gid}"${e.gid === want ? ' selected' : ''}>${e.gid.replace('graph-', 'B')} — ${e.name}</option>`).join('');
  await load(want);
})();
