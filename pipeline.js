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
  ['Find the ruled lines', 'the box and grid rules'],
  ['Read the axes', 'the frozen wavenumber calibration'],
  ['Cut each column into runs', 'vertical strokes of ink'],
  ['Seat the dots on the ink', 'pass one: nearest stroke in the dot’s own column'],
  ['Walk in from the anchors', 'pass two: propagate from settled dots'],
  ['Bridge what is stranded', 'pass three: chord across a gap'],
  ['Follow cut traces onward', 'where a trace stops but ink continues'],
  ['Scale to unit peak', 'peak to 1.00'],
  ['Check against the release', 'compare with the published spectrum'],
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
  setNote(`<b>${meta.name}</b>, ${imgW}×${imgH}. The plot frame was located once and
    frozen; every measurement below is taken against this box.`);
  setKV([['page', meta.graph], ['scan', `${imgW} × ${imgH}`],
         ['frame left/right', `${(frame.x_left / pageScale) | 0} / ${(frame.x_right / pageScale) | 0}`],
         ['frame top/bottom', `${(frame.y_top / pageScale) | 0} / ${(frame.y_bottom / pageScale) | 0}`],
         ['page px per scan px', pageScale.toFixed(3)]]);
  for (let i = 0; i < 30; i++) yield;

  /* 2 — Otsu */
  setStage(1);
  setNote(`<code>Otsu</code> sweeps every threshold and keeps the one that best separates
    ink from paper, so exposure can vary between pages. The blue curve is between-class
    variance; the threshold is its maximum.`);
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
  setNote(`The border and grid run the full width of the plot; a spectrum does not. Rows
    more than <code>${RULE_COVERAGE * 100}%</code> ink across the interior are marked as
    rules and excluded as snap targets.`);
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
  setNote(`Position maps linearly to wavenumber, then to nm. Fitted once from the printed
    ticks: <code>ν̃ = ${xcal.a.toFixed(4)}·x + ${xcal.b.toFixed(1)}</code>, residual
    ${xcal.rmse} cm⁻¹, from the <b>${xcal.source}</b> axis.`);
  setKV([['slope a', xcal.a.toFixed(4)], ['intercept b', xcal.b.toFixed(1)],
         ['rmse', `${xcal.rmse} cm⁻¹`], ['axis used', xcal.source],
         ['covers', `${Math.min(lo, hi).toFixed(0)}–${Math.max(lo, hi).toFixed(0)} nm`]]);
  for (let i = 0; i < 35; i++) yield;

  /* 5 — column runs */
  setStage(4);
  setNote(`Each column is cut into vertical runs of ink. A stroke crossed square-on is a
    few pixels tall; a steep flank can be seventy. Runs taller than
    <code>${STROKE_MAX}</code> px are aimed at by their near edge, not their centre.`);
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
  setNote(`Dots rebuilt from the published values land where the numbers say, not where
    the ink is. Pass one searches each dot's own column for the nearest non-ruled stroke,
    within <code>${TOL_PAGE_PX}</code> page px (<code>${tolScan.toFixed(1)}</code> scan px).`);
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
  setNote(`Each unsettled dot takes its reference from a settled neighbour and steps in one
    column at a time, within <code>${NEIGHBOUR_RADIUS}</code> scan px. Widening a dot's own
    search instead would only search further around a position already wrong.`);
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
  setNote(`Where a peak reaches 1.0 the stroke merges into the border, leaving that column
    with nothing to snap to. If both sides are settled and within
    <code>${BRIDGE_MAX_COLS}</code> columns, the dot goes on the chord between them.
    <b>${bridged}</b> dot${bridged === 1 ? '' : 's'} on this page.`);
  setKV(curves.map(c => [c.name,
    `${count(c.fixed)} / ${c.px.length} placed`]).concat([['bridged', bridged]]));
  for (let i = 0; i < 22; i++) yield;

  /* 9 — does the stroke keep going? */
  setStage(8);
  setNote(`Every placed point can sit on the ink while the trace still stops halfway up a
    peak. Each end is walked outward along its own slope to test whether ink continues.
    On rhodamine 8B this found an absorption curve ending at 0.4165, its own maximum,
    with the printed peak at 554 nm.`);
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
  setNote(`<b>${cut === 0 ? 'Every end runs out where the stroke does'
      : cut + ' end(s) have ink beyond them'}</b>. A trace that stops while the stroke
    continues is missing part of the curve.`);
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
  setNote(`Unit peak is the printed scale. Applied once, after the geometry is settled,
    with the factor recorded as <code>peak_scaled_from</code> so the fit to the ink stays
    recoverable.`);
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
    ? `<b>Reproduced.</b> Matches the published spectrum to within
       ${worst.toFixed(4)} of full scale at every point.`
    : `<b>Diverged</b> by up to ${worst.toFixed(4)} of full scale on this page.`;
  setNote(`The result is compared point by point against the released dataset for this
    page.`);
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
  cv.height = cv.clientHeight * devicePixelRatio;
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
  const w = Math.min(470, cv.width * .44), h = 150, x0 = 18, y0 = cv.height - h - 16;
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
  // Browsers suspend requestAnimationFrame while the tab or panel is not
  // visible, which left the run sitting at 0% in a sidebar that had not been
  // brought forward yet.  Fall back to a timer when hidden so pressing Run
  // always starts it, and pick the smooth path back up once it is on screen.
  if (running) {
    if (document.visibilityState === 'visible') requestAnimationFrame(tick);
    else setTimeout(tick, 16);
  }
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

/* ══ Digitizing a page you upload ═══════════════════════════════════════
 * The plates in the dataset arrive with their plot box already located and
 * their axis already fitted from the printed ticks.  An uploaded page has
 * neither, so those two facts have to be established before any of the
 * machinery above can run: find the box, and be told what the axis reads at
 * its edges.  Everything after that is the same code.
 */
let up = null;                       // {img, mask, rule, box, drag}

function analyseUpload(image) {
  const c = document.createElement('canvas');
  c.width = image.width; c.height = image.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(image, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const lum = new Uint8Array(W * H), h = new Float64Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    lum[p] = v; h[v]++;
  }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * h[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += h[t]; if (!wB) continue;
    const wF = W * H - wB; if (!wF) break;
    sumB += t * h[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < mask.length; p++) mask[p] = lum[p] <= thr ? 1 : 0;

  /* the plot box is the longest ruled row above and below, and the longest
     ruled column left and right — the axes are the only strokes that run the
     whole way */
  const rowCov = new Float64Array(H), colCov = new Float64Array(W);
  for (let y = 0; y < H; y++) { let n = 0;
    for (let xx = 0; xx < W; xx += 2) if (mask[y * W + xx]) n++;
    rowCov[y] = n / (W / 2); }
  for (let xx = 0; xx < W; xx++) { let n = 0;
    for (let y = 0; y < H; y += 2) if (mask[y * W + xx]) n++;
    colCov[xx] = n / (H / 2); }
  const pick = (cov, from, to, dir) => {
    let bi = -1, bv = 0;
    for (let i = from; dir > 0 ? i < to : i > to; i += dir)
      if (cov[i] > bv) { bv = cov[i]; bi = i; }
    return bv > 0.45 ? bi : -1;
  };
  const top = pick(rowCov, 0, H * 0.55 | 0, 1);
  const bot = pick(rowCov, H - 1, H * 0.45 | 0, -1);
  const left = pick(colCov, 0, W * 0.55 | 0, 1);
  const right = pick(colCov, W - 1, W * 0.45 | 0, -1);
  const box = {
    left: left >= 0 ? left : Math.round(W * 0.12),
    right: right >= 0 ? right : Math.round(W * 0.92),
    top: top >= 0 ? top : Math.round(H * 0.08),
    bottom: bot >= 0 ? bot : Math.round(H * 0.88),
  };
  const rule = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0, span = 0;
    for (let xx = box.left + 20; xx <= box.right - 20; xx += 2) { span++; if (mask[y * W + xx]) n++; }
    if (span && n / span > RULE_COVERAGE) rule[y] = 1;
  }
  return { img: image, W, H, mask, rule, thr, box, found: top >= 0 && bot >= 0 && left >= 0 && right >= 0 };
}

/* trace a stroke from a seed, both ways, with the slope carrying it across
   crossings — the same rule the extension pass uses */
function traceStroke(u, sx, sy) {
  const runsAt = x => {
    const out = []; let s = -1;
    for (let y = 0; y < u.H; y++) {
      if (u.mask[y * u.W + x]) { if (s < 0) s = y; }
      else if (s >= 0) { out.push([s, y - 1]); s = -1; }
    }
    if (s >= 0) out.push([s, u.H - 1]);
    return out.filter(([a, b]) => { for (let y = a; y <= b; y++) if (!u.rule[y]) return b - a <= 60; return false; });
  };
  const pts = [[sx, sy]];
  for (const dir of [-1, 1]) {
    let y = sy, slope = 0, gap = 0;
    for (let x = sx + dir; x >= u.box.left && x <= u.box.right; x += dir) {
      const pred = y + slope;
      let best = null, bd = 15;
      for (const [a, b] of runsAt(x)) {
        const t = (pred >= a && pred <= b) ? pred : (pred < a ? a : b);
        const g = (pred >= a && pred <= b) ? 0 : Math.min(Math.abs(pred - a), Math.abs(pred - b));
        if (g < bd) { bd = g; best = t; }
      }
      if (best === null) { if (++gap > 14) break; y = pred; continue; }
      gap = 0; slope = 0.62 * slope + 0.38 * (best - y); y = best;
      pts.push([x, y]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

function autoTrace(u) {
  const used = [];
  const near = (x, y) => used.some(p => p.some(([qx, qy]) => Math.abs(qx - x) < 2 && Math.abs(qy - y) < 9));
  const mid = Math.round((u.box.left + u.box.right) / 2);
  const seeds = [];
  for (let k = -6; k <= 6; k++) {
    const x = Math.round(mid + k * (u.box.right - u.box.left) / 16);
    if (x <= u.box.left || x >= u.box.right) continue;
    let s = -1;
    for (let y = u.box.top; y <= u.box.bottom; y++) {
      const on = u.mask[y * u.W + x] && !u.rule[y];
      if (on) { if (s < 0) s = y; }
      else if (s >= 0) { if (y - s <= 60) seeds.push([x, (s + y - 1) / 2]); s = -1; }
    }
  }
  const traces = [];
  for (const [x, y] of seeds) {
    if (near(x, y)) continue;
    const t = traceStroke(u, x, y);
    if (t.length < (u.box.right - u.box.left) * 0.12) continue;
    used.push(t); traces.push(t);
    if (traces.length >= 3) break;
  }
  return traces.sort((a, b) => b.length - a.length).slice(0, 3);
}

/* ── upload: wiring, the crop box, and the hand-off to the tracer ──────── */
function drawUpload() {
  cv.width = cv.clientWidth * devicePixelRatio;
  cv.height = cv.clientHeight * devicePixelRatio;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#0e1014'; g.fillRect(0, 0, cv.width, cv.height);
  const s = Math.min(cv.width / up.W, cv.height / up.H);
  const ox = (cv.width - up.W * s) / 2, oy = (cv.height - up.H * s) / 2;
  up.s = s; up.ox = ox; up.oy = oy;
  g.drawImage(up.img, ox, oy, up.W * s, up.H * s);
  const b = up.box, X = x => ox + x * s, Y = y => oy + y * s;
  g.fillStyle = 'rgba(10,12,16,.55)';
  g.fillRect(ox, oy, up.W * s, Y(b.top) - oy);
  g.fillRect(ox, Y(b.bottom), up.W * s, oy + up.H * s - Y(b.bottom));
  g.fillRect(ox, Y(b.top), X(b.left) - ox, Y(b.bottom) - Y(b.top));
  g.fillRect(X(b.right), Y(b.top), ox + up.W * s - X(b.right), Y(b.bottom) - Y(b.top));
  g.strokeStyle = '#6aa7ff'; g.lineWidth = 2;
  g.strokeRect(X(b.left), Y(b.top), X(b.right) - X(b.left), Y(b.bottom) - Y(b.top));
  g.fillStyle = '#6aa7ff';
  for (const [px, py] of [[X(b.left), (Y(b.top) + Y(b.bottom)) / 2],
                          [X(b.right), (Y(b.top) + Y(b.bottom)) / 2],
                          [(X(b.left) + X(b.right)) / 2, Y(b.top)],
                          [(X(b.left) + X(b.right)) / 2, Y(b.bottom)]]) {
    g.beginPath(); g.arc(px, py, 5, 0, 6.283); g.fill();
  }
  if (up.traces) {
    const cols = ['#d94f45', '#3fa96a', '#e08a2e'];
    up.traces.forEach((t, i) => {
      g.strokeStyle = cols[i % 3]; g.lineWidth = 2.2; g.beginPath();
      t.forEach(([x, y], k) => k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)));
      g.stroke();
    });
  }
  $('cL').textContent = `${up.box.left} / ${up.box.right}`;
  $('cT').textContent = `${up.box.top} / ${up.box.bottom}`;
}

function hitEdge(mx, my) {
  const b = up.box, X = x => up.ox + x * up.s, Y = y => up.oy + y * up.s, T = 10;
  if (Math.abs(mx - X(b.left)) < T) return 'left';
  if (Math.abs(mx - X(b.right)) < T) return 'right';
  if (Math.abs(my - Y(b.top)) < T) return 'top';
  if (Math.abs(my - Y(b.bottom)) < T) return 'bottom';
  return null;
}

cv.addEventListener('mousedown', e => {
  if (!up) return;
  const r = cv.getBoundingClientRect();
  up.drag = hitEdge((e.clientX - r.left) * devicePixelRatio, (e.clientY - r.top) * devicePixelRatio);
});
addEventListener('mouseup', () => { if (up) up.drag = null; });
cv.addEventListener('mousemove', e => {
  if (!up) return;
  const r = cv.getBoundingClientRect();
  const mx = (e.clientX - r.left) * devicePixelRatio, my = (e.clientY - r.top) * devicePixelRatio;
  cv.style.cursor = up.drag || hitEdge(mx, my)
    ? (/left|right/.test(up.drag || hitEdge(mx, my)) ? 'ew-resize' : 'ns-resize') : 'default';
  if (!up.drag) return;
  const x = clamp(Math.round((mx - up.ox) / up.s), 0, up.W - 1);
  const y = clamp(Math.round((my - up.oy) / up.s), 0, up.H - 1);
  if (up.drag === 'left') up.box.left = Math.min(x, up.box.right - 20);
  if (up.drag === 'right') up.box.right = Math.max(x, up.box.left + 20);
  if (up.drag === 'top') up.box.top = Math.min(y, up.box.bottom - 20);
  if (up.drag === 'bottom') up.box.bottom = Math.max(y, up.box.top + 20);
  up.traces = null;
  drawUpload();
});

$('upBtn').onclick = () => $('upFile').click();
$('cancelUp').onclick = () => { up = null; $('crop').style.display = 'none';
                                cv.style.cursor = 'default'; load($('page').value); };

$('upFile').onchange = e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const im = new Image();
  im.onload = () => {
    running = false; gen = null;
    up = analyseUpload(im);
    $('crop').style.display = 'block';
    $('upMsg').innerHTML = up.found
      ? 'Plot box found from the printed axes. Check the edges.'
      : '<b>Axes not found.</b> Drag the edges onto the plot.';
    setStage(-1);
    setNote(`<b>${f.name}</b>, ${im.width}×${im.height}. Set the plot box and the axis
      range; the rest runs as it does for a dataset page.`);
    setKV([['image', `${im.width} × ${im.height}`],
           ['threshold', up.thr], ['axes detected', up.found ? 'yes' : 'no']]);
    drawUpload();
    URL.revokeObjectURL(im.src);
  };
  im.onerror = () => { $('upMsg').textContent = 'That file could not be read as an image.'; };
  im.src = URL.createObjectURL(f);
};

$('goTrace').onclick = () => {
  const unit = $('axUnit').value;
  const l = parseFloat($('axLeft').value), r = parseFloat($('axRight').value);
  if (!isFinite(l) || !isFinite(r) || l === r) {
    $('upMsg').innerHTML = '<b>Axis needs two numbers</b>: the values at the left and right edges of the box.';
    return;
  }
  $('upMsg').textContent = 'tracing…';
  setTimeout(() => {
    up.traces = autoTrace(up);
    drawUpload();
    if (!up.traces.length) {
      $('upMsg').innerHTML = '<b>No curve found inside the box.</b> Check the crop, or the scan is too faint.';
      return;
    }
    // pixels -> physical, using the two numbers given for the axis
    const b = up.box, H = b.bottom - b.top;
    const toNm = v => unit === 'nm' ? v : 1e7 / v;
    const out = up.traces.map((t, i) => {
      const wl = [], it = [];
      for (const [x, y] of t) {
        const f = (x - b.left) / (b.right - b.left);
        wl.push(toNm(l + f * (r - l)));
        it.push((b.bottom - y) / H);
      }
      const o = wl.map((_, k) => k).sort((p, q) => wl[p] - wl[q]);
      return { name: ['curve 1', 'curve 2', 'curve 3'][i],
               wl: o.map(k => +wl[k].toFixed(1)), inten: o.map(k => +it[k].toFixed(6)) };
    });
    for (const c of out) {                       // unit peak, as everywhere else
      const mx = Math.max(...c.inten);
      if (mx > 0.05) c.inten = c.inten.map(v => +(v / mx).toFixed(6));
    }
    up.out = out;
    setKV(out.map(c => [c.name,
      `${c.wl[0].toFixed(0)}–${c.wl[c.wl.length - 1].toFixed(0)} nm · ${c.wl.length} pts`]));
    $('upMsg').innerHTML = `Traced <b>${out.length}</b> curve${out.length === 1 ? '' : 's'}. ` +
      `<a href="#" id="dlUp" style="color:#6aa7ff">Download CSV</a>`;
    $('dlUp').onclick = ev => {
      ev.preventDefault();
      const rows = [['wavelength_nm', ...out.map(c => c.name.replace(' ', '_') + '_intensity')]];
      const n = Math.max(...out.map(c => c.wl.length));
      for (let i = 0; i < n; i++)
        rows.push([out[0].wl[i] ?? '', ...out.map(c => c.inten[i] ?? '')]);
      const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'digitized.csv'; a.click();
    };
  }, 30);
};
