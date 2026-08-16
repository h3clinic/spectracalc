/* SpectraWolf browser editor — static-site companion to the local app.
 *
 * There is no server here.  Dot positions are reconstructed from the
 * published 0.1 nm data pushed back through the page's frozen calibration
 * (the same inverse transform that draws the round-trip validation image),
 * so the dots land on the printed ink without any digitization step.
 */
'use strict';

const ROLE = {
  em:  { key: 'em',  name: 'emission',     color: '#C0392B' },
  ab:  { key: 'ab',  name: 'absorption',   color: '#1E8F4E' },
  // 18 plates print a second emission trace (CURVE I / CURVE II).  It has
  // always been in the dataset; the editor simply never loaded it, so those
  // pages looked half-digitized.
  em2: { key: 'em2', name: 'emission II',  color: '#E67E22' },
};
// palette offered for a brand-new curve
const NEW_COLORS = ['#3B82F6', '#9B59B6', '#E91E63', '#00BCD4', '#8BC34A', '#FF7043'];
let newCurveSeq = 0;

let SPECTRA = null, ORDER = null, FRAMES = null;
let gid = null, meta = null, frame = null, xcal = null;
let curves = [];          // [{key, name, color, px[], py[]}] in ORIGINAL page px
let activeIdx = 0;
let img = null, imgW = 0, imgH = 0, pageScale = 1;   // scan px -> original px
let zoom = 1, panX = 0, panY = 0;
let mode = 'pan';
let ERASE_R = 26;
let eraseScope = 'active';   // 'active' = only the selected colour | 'all'

/* ── history ─────────────────────────────────────────────────────────────
 * Snapshots rather than inverse-deltas: each entry holds the full dot state,
 * so any point in the session can be restored directly instead of replaying
 * a chain of undos.  ~24 KB per snapshot for a 1500-point curve, capped.
 */
const HIST_MAX = 80;
let history = [];      // [{label, detail, curves:[{px,py}], activeIdx, t}]
let histAt = -1;       // index of the state currently on screen
let isErasing = false, eraseBatch = null, lastErase = null, lastMouse = null;
let isPanning = false, panSX = 0, panSY = 0;

const canvas = document.getElementById('ed');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('wrap');

/* ── data load ───────────────────────────────────────────────────────── */

let INDEX = null;

async function boot() {
  // the per-compound payload is fetched on demand, so opening the editor
  // costs one ~30 KB file instead of the whole 11 MB dataset
  const [idx, fr] = await Promise.all([
    fetch('data/index.json').then(r => r.json()),
    fetch('data/frames.json').then(r => r.json()),
  ]);
  INDEX = idx; FRAMES = fr;
  ORDER = idx.map(e => e.gid);

  const sel = document.getElementById('pick');
  idx.forEach(e => {
    const o = document.createElement('option');
    o.value = e.gid;
    o.textContent = `${e.gid.replace('graph-', 'B')} — ${e.name}`;
    sel.appendChild(o);
  });
  sel.onchange = () => { location.search = '?gid=' + sel.value; };

  const q = new URLSearchParams(location.search).get('gid');
  gid = (q && ORDER.includes(q)) ? q : ORDER[0];
  sel.value = gid;
  document.getElementById('backLink').href = '/?gid=' + gid;
  await loadPage();
}

async function loadPage() {
  document.getElementById('loading').style.display = '';
  document.getElementById('loading').textContent = 'Loading scan…';
  meta = await fetch(`data/sp/${gid}.json`).then(r => r.json());
  frame = FRAMES[gid];
  document.getElementById('dlOrigXlsx').href = `downloads/xlsx/${gid}.xlsx`;
  document.getElementById('dlOrigCsv').href = `downloads/csv/${gid}.csv`;
  xcal = meta.xcal;
  document.getElementById('cmpName').textContent =
    `${meta.name} · ${gid}` + (meta.f1 ? ` · F1 ${meta.f1}` : '');

  if (!frame || !xcal) {
    document.getElementById('loading').textContent =
      'This page has no usable calibration — it cannot be edited on the web.';
    return;
  }

  curves = [];
  newCurveSeq = 0;
  for (const k of ['em', 'ab', 'em2']) {
    if (!meta[k]) continue;
    curves.push({ ...ROLE[k], ...toPixels(meta[k]) });
  }
  activeIdx = 0;

  img = new Image();
  img.onload = () => {
    imgW = img.width; imgH = img.height;
    INK = null; waypoints = [];      // rebuilt lazily for the new page
    pageScale = frame.w / imgW;           // original px per displayed scan px
    document.getElementById('loading').style.display = 'none';
    resize(); fit(); setMode('add'); renderSwatches(); refresh();
    history = []; histAt = -1;
    snapshot('Published data', 'as digitized');
    loadCommunityEdit();
  };
  img.onerror = () => {
    document.getElementById('loading').textContent = 'Could not load the page scan.';
  };
  img.src = 'scans/' + gid + '.webp';
}

/** A published/edited curve (nm, intensity) as page pixels. */
function toPixels(src) {
  const px = [], py = [];
  for (let i = 0; i < src.wl.length; i++) {
    px.push((1e7 / src.wl[i] - xcal.b) / xcal.a);
    py.push(frame.y_bottom - src.inten[i] * (frame.y_bottom - frame.y_top));
  }
  return { px, py };
}

/* ── coordinate helpers (canvas <-> scan <-> original page px) ────────── */

const toScan = (opx, opy) => [opx / pageScale, opy / pageScale];
const scanToScreen = (sx, sy) => [sx * zoom + panX, sy * zoom + panY];
const screenToScan = (x, y) => [(x - panX) / zoom, (y - panY) / zoom];

function screenToOriginal(x, y) {
  const [sx, sy] = screenToScan(x, y);
  return [sx * pageScale, sy * pageScale];
}

/* ── physical conversion — mirrors the server's _curve_physical ───────── */

function physical(c) {
  if (c.px.length < 2) return { wl: [], inten: [] };
  const pairs = [];
  for (let i = 0; i < c.px.length; i++) {
    const wn = xcal.a * c.px[i] + xcal.b;
    if (wn <= 0) continue;
    pairs.push([1e7 / wn,
                (frame.y_bottom - c.py[i]) / (frame.y_bottom - frame.y_top)]);
  }
  if (pairs.length < 2) return { wl: [], inten: [] };

  // apex-local restoration: stretch only the top 2% band so the rest of the
  // curve stays exactly on the printed line
  let mx = -Infinity;
  for (const p of pairs) mx = Math.max(mx, p[1]);
  if (mx >= 0.96 && mx < 1.0) {
    const lo = mx - 0.02, f = (1 - lo) / (mx - lo);
    for (const p of pairs) if (p[1] > lo) p[1] = lo + (p[1] - lo) * f;
  }

  // 0.1 nm dedup-average, apex bin keeps the peak value
  pairs.sort((a, b) => a[0] - b[0]);
  let peakV = -Infinity, peakBin = null;
  const sum = new Map(), cnt = new Map();
  for (const [w, v] of pairs) {
    const b = Math.round(w * 10) / 10;
    sum.set(b, (sum.get(b) || 0) + v);
    cnt.set(b, (cnt.get(b) || 0) + 1);
    if (v > peakV) { peakV = v; peakBin = b; }
  }
  const wl = [...sum.keys()].sort((a, b) => a - b);
  const inten = wl.map(b => (b === peakBin ? peakV : sum.get(b) / cnt.get(b)));

  // bridge print breaks up to 5 nm so the exported curve is continuous
  const ow = [], oi = [];
  for (let i = 0; i < wl.length; i++) {
    ow.push(wl[i]); oi.push(inten[i]);
    if (i + 1 < wl.length) {
      const gap = wl[i + 1] - wl[i];
      if (gap > 0.15 && gap <= 5.0) {
        const n = Math.round(gap / 0.1) - 1;
        for (let k = 1; k <= n; k++) {
          const t = k / (n + 1);
          ow.push(Math.round((wl[i] + gap * t) * 10) / 10);
          oi.push(inten[i] + (inten[i + 1] - inten[i]) * t);
        }
      }
    }
  }
  return { wl: ow, inten: oi };
}

/* ── auto-trace ──────────────────────────────────────────────────────────
 * Deterministic, not AI: you drop a few dots along ink the digitizer missed
 * and the run between them is followed pixel by pixel.  The local app walks
 * the isolated curve mask server-side; here the same walk runs over the
 * shipped page scan, read once into an ink bitmap.
 */
let INK = null;           // {w, h, mask: Uint8Array} in SCAN pixels
let waypoints = [];       // guide dots, ORIGINAL page px

function buildInk() {
  const c = document.createElement('canvas');
  c.width = imgW; c.height = imgH;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, imgW, imgH).data;
  const mask = new Uint8Array(imgW * imgH);
  // Otsu on the luminance histogram — the scans are black ink on paper, but
  // exposure varies from page to page, so don't hard-code a cutoff
  const hist = new Float64Array(256);
  const lum = new Uint8Array(imgW * imgH);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    lum[p] = v; hist[v]++;
  }
  const total = imgW * imgH;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  for (let p = 0; p < lum.length; p++) mask[p] = lum[p] <= thr ? 1 : 0;
  INK = { w: imgW, h: imgH, mask, thr };
}

const isInk = (x, y) =>
  x >= 0 && y >= 0 && x < INK.w && y < INK.h && INK.mask[y * INK.w + x] === 1;

/** vertical ink runs in one scan column */
function columnRuns(x) {
  const runs = [];
  let start = -1;
  for (let y = 0; y < INK.h; y++) {
    if (INK.mask[y * INK.w + x]) {
      if (start < 0) start = y;
    } else if (start >= 0) { runs.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, INK.h - 1]);
  return runs;
}

/** median stroke thickness near a scan point — sets the tolerance band */
function strokeWidth(sx, sy) {
  const widths = [];
  for (let dx = -6; dx <= 6; dx++) {
    for (const [a, b] of columnRuns(Math.round(sx) + dx)) {
      if (sy >= a - 4 && sy <= b + 4) { widths.push(b - a + 1); break; }
    }
  }
  if (!widths.length) return 3;
  widths.sort((p, q) => p - q);
  return Math.max(2, widths[widths.length >> 1]);
}

/**
 * Follow the ink from waypoint A to waypoint B (both ORIGINAL page px).
 * Returns points in ORIGINAL page px.
 */
function traceBetween(A, B) {
  if (!INK) buildInk();
  const ax = A[0] / pageScale, ay = A[1] / pageScale;
  const bx = B[0] / pageScale, by = B[1] / pageScale;
  const x0 = Math.round(Math.min(ax, bx)), x1 = Math.round(Math.max(ax, bx));
  if (x1 - x0 < 2) return [];
  const flip = ax > bx;
  const yStart = flip ? by : ay, yEnd = flip ? ay : by;

  const ws = strokeWidth(ax, ay);
  const out = [];
  let y = yStart;      // where the walk currently sits
  let slope = 0;       // smoothed dy per column — the curve's local steepness

  // Where the OTHER spectra already run, by scan column.  At a crossing the
  // neighbouring curve's ink is often nearer the prediction than our own, and
  // the walk would change tracks and never come back — so its track is
  // penalised rather than forbidden (at a true crossing they coincide).
  const foreign = new Map();
  curves.forEach((c, ci) => {
    if (ci === activeIdx) return;
    for (let i = 0; i < c.px.length; i++) {
      const k = Math.round(c.px[i] / pageScale);
      const v = c.py[i] / pageScale;
      const arr = foreign.get(k);
      if (arr) arr.push(v); else foreign.set(k, [v]);
    }
  });
  const foreignPenalty = (x, cand) => {
    const arr = foreign.get(x);
    if (!arr) return 0;
    let near = Infinity;
    for (const v of arr) near = Math.min(near, Math.abs(v - cand));
    const band = 2.5 * ws;
    return near < band ? 3 * ws * (1 - near / band) : 0;
  };

  // pick the ink run closest to `want`, riding the near edge of tall runs
  // (a steep flank or a crossing shows up as one very tall run)
  const nearestRun = (x, want) => {
    let bestY = null, bestD = Infinity, bestRaw = Infinity, bestRun = null;
    for (const r of columnRuns(x)) {
      const [a, b] = r;
      // inside a tall run the nearest point to the prediction is the
      // prediction itself, clamped — riding it is how a vertical flank walks
      const cand = (b - a + 1) > 3 * ws ? Math.max(a, Math.min(b, want))
                                        : (a + b) / 2;
      const raw = Math.abs(cand - want);
      const score = raw + foreignPenalty(x, cand);
      if (score < bestD) { bestD = score; bestY = cand; bestRaw = raw; bestRun = r; }
    }
    return [bestY, bestRaw, bestRun];
  };

  for (let x = x0; x <= x1; x++) {
    const t = (x - x0) / ((x1 - x0) || 1);
    const base = yStart + (yEnd - yStart) * t;     // straight guide A->B
    // follow the curve's own trajectory, nudged toward the guide so it
    // cannot run away; a straight-line prediction loses steep flanks, which
    // is exactly where the digitizer needs help
    const pred = 0.85 * (y + slope) + 0.15 * base;
    // the tolerance has to grow with steepness: on a near-vertical flank the
    // ink legitimately moves many rows between adjacent columns
    const tol = Math.max(8, 3 * ws + 1.8 * Math.abs(slope));

    let [cand, dist, run] = nearestRun(x, pred);
    if (cand === null || dist > tol) {
      // lost it — try again around the guide before giving up on this column
      const [c2, d2, r2] = nearestRun(x, base);
      if (c2 !== null && d2 <= tol * 2.5) { cand = c2; dist = d2; run = r2; }
      else cand = null;
    }
    const ny = cand !== null ? cand : base;        // blank paper -> bridge

    out.push([x * pageScale, ny * pageScale]);
    slope = 0.55 * slope + 0.45 * (ny - y);
    y = ny;
  }
  return out;
}

async function addWaypoint(ox, oy) {
  waypoints.push([ox, oy]);
  draw();
  if (waypoints.length < 2) { toast('Auto: click the next dot along the ink'); return; }
  const c = curves[activeIdx];
  if (!c) { toast('Pick a colour first'); return; }
  const seg = traceBetween(waypoints[waypoints.length - 2], waypoints[waypoints.length - 1]);
  if (!seg.length) { toast('Those two dots are too close together'); return; }
  for (const [x, y] of seg) { c.px.push(x); c.py.push(y); }
  snapshot('Auto-trace', `${c.name} · +${seg.length}`);
  // short hops track the ink almost perfectly; long ones can drift across a
  // busy stretch, so say so rather than let it fail quietly
  const span = Math.abs(waypoints[waypoints.length - 1][0] - waypoints[waypoints.length - 2][0]);
  toast(`Auto-traced ${seg.length} points along the ink` +
        (span > 250 ? ' — long hop, add closer dots if it drifts' : ''));
  refresh(); draw();
}

/* ── drawing ─────────────────────────────────────────────────────────── */

function resize() {
  // a hidden/unlaid-out container reports 0 — never let that reach zoom,
  // or the view comes back blank when the tab is shown again
  canvas.width = Math.max(1, wrap.clientWidth);
  canvas.height = Math.max(1, wrap.clientHeight);
  draw();
}

function fit() {
  if (!imgW || canvas.width < 2 || canvas.height < 2) return;
  zoom = Math.min(canvas.width / imgW, canvas.height / imgH) * 0.97;
  panX = (canvas.width - imgW * zoom) / 2;
  panY = (canvas.height - imgH * zoom) / 2;
  draw();
}

function draw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const z = document.getElementById('sbZoom');
  if (z) z.textContent = isFinite(zoom) && zoom > 0 ? Math.round(zoom * 100) + '%' : '—';
  if (!img || !img.complete) return;

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);
  ctx.drawImage(img, 0, 0);

  const r = Math.max(1.6, 2.4 / zoom);
  curves.forEach((c, ci) => {
    ctx.globalAlpha = (ci === activeIdx || mode === 'pan') ? 1 : 0.3;
    ctx.fillStyle = c.color;
    for (let i = 0; i < c.px.length; i++) {
      const [sx, sy] = toScan(c.px[i], c.py[i]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, 6.2832);
      ctx.fill();
    }
  });
  // auto-trace guide dots + the chain between them
  if (mode === 'auto' && waypoints.length) {
    const gr = Math.max(3, 5 / zoom);
    ctx.strokeStyle = '#EFC047';
    ctx.lineWidth = Math.max(1, 1.5 / zoom);
    ctx.setLineDash([6 / zoom, 5 / zoom]);
    ctx.beginPath();
    waypoints.forEach(([ox, oy], i) => {
      const [sx, sy] = toScan(ox, oy);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#EFC047';
    for (const [ox, oy] of waypoints) {
      const [sx, sy] = toScan(ox, oy);
      ctx.beginPath(); ctx.arc(sx, sy, gr, 0, 6.2832); ctx.fill();
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();

  if (mode === 'erase' && lastMouse) {
    // the ring wears the colour it will actually take, so the scope is
    // obvious before the drag starts
    const act = curves[activeIdx];
    const tint = (eraseScope === 'active' && act) ? act.color : '#e74c3c';
    ctx.beginPath();
    ctx.arc(lastMouse[0], lastMouse[1], ERASE_R, 0, 6.2832);
    ctx.fillStyle = tint + '30';
    ctx.fill();
    ctx.strokeStyle = tint;
    ctx.lineWidth = 1.5;
    if (eraseScope === 'all') ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = tint;
    ctx.font = '12px system-ui';
    ctx.fillText(`⌫ ${ERASE_R}px · ` +
                 (eraseScope === 'active' ? (act ? act.name : 'none') : 'ALL curves'),
                 lastMouse[0] + ERASE_R + 6, lastMouse[1] + 4);
  }
}

/* ── editing ─────────────────────────────────────────────────────────── */

function setMode(m) {
  mode = m;
  if (m !== 'auto') waypoints = [];
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('on'));
  const btn = { add: 'tAdd', auto: 'tAuto', erase: 'tErase', pan: 'tPan' }[m];
  if (btn) document.getElementById(btn).classList.add('on');
  wrap.style.cursor = m === 'pan' ? 'grab' : m === 'erase' ? 'none' : 'crosshair';
  document.getElementById('sbMode').textContent =
    { add: 'Add dots', auto: 'Auto-trace', erase: 'Eraser', pan: 'Pan' }[m] || m;
  draw();
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function eraseStroke(ox, oy) {
  // capsule sweep in ORIGINAL page px, so a fast swipe leaves no survivors
  const r = (ERASE_R / zoom) * pageScale;
  const [ax, ay] = lastErase || [ox, oy];
  let n = 0;
  curves.forEach((c, ci) => {
    // colour-scoped by default: where the curves cross, the brush must not
    // take the other spectrum's dots with it
    if (eraseScope === 'active' && ci !== activeIdx) return;
    for (let i = c.px.length - 1; i >= 0; i--) {
      if (distToSeg(c.px[i], c.py[i], ax, ay, ox, oy) <= r) {
        eraseBatch.pts.push([ci, c.px[i], c.py[i]]);
        c.px.splice(i, 1); c.py.splice(i, 1); n++;
      }
    }
  });
  lastErase = [ox, oy];
  if (n) refresh();
  draw();
  return n;
}

function snapshot(label, detail) {
  // editing after stepping back discards the abandoned future, the same way
  // every editor behaves — otherwise the list stops matching what you see
  if (histAt < history.length - 1) history = history.slice(0, histAt + 1);
  history.push({
    label, detail: detail || '',
    curves: curves.map(c => ({ px: c.px.slice(), py: c.py.slice() })),
    activeIdx, t: Date.now(),
  });
  if (history.length > HIST_MAX) history.shift();
  histAt = history.length - 1;
  renderHistory();
}

function restore(i) {
  const h = history[i];
  if (!h) return;
  h.curves.forEach((s, ci) => {
    if (!curves[ci]) return;
    curves[ci].px = s.px.slice();
    curves[ci].py = s.py.slice();
  });
  histAt = i;
  activeIdx = Math.min(h.activeIdx, curves.length - 1);
  renderSwatches(); renderHistory(); refresh(); draw();
}

function undo() {
  if (histAt <= 0) { toast('Nothing earlier to go back to'); return; }
  restore(histAt - 1);
  toast(`Back to: ${history[histAt].label}`);
}

function redo() {
  if (histAt >= history.length - 1) { toast('Nothing to redo'); return; }
  restore(histAt + 1);
  toast(`Forward to: ${history[histAt].label}`);
}

function renderHistory() {
  const box = document.getElementById('histList');
  if (!box) return;
  box.innerHTML = '';
  // newest first — that is where the attention is
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const row = document.createElement('button');
    row.className = 'hrow' + (i === histAt ? ' now' : '') + (i > histAt ? ' ahead' : '');
    const total = h.curves.reduce((n, s) => n + s.px.length, 0);
    row.innerHTML =
      `<span class="hlabel">${h.label}</span>` +
      `<span class="hmeta">${h.detail ? h.detail + ' · ' : ''}${total} dots</span>`;
    row.title = (i === histAt ? 'Current state' : 'Restore this state') +
                ` — ${new Date(h.t).toLocaleTimeString()}`;
    row.onclick = () => { restore(i); toast(`Restored: ${h.label}`); };
    box.appendChild(row);
  }
  const pos = document.getElementById('histPos');
  if (pos) pos.textContent = history.length ? `${histAt + 1} / ${history.length}` : '—';
}

/* ── side panel ──────────────────────────────────────────────────────── */

function renderSwatches() {
  const box = document.getElementById('swatches');
  box.innerHTML = '';
  curves.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (i === activeIdx ? ' on' : '');
    b.style.background = c.color;
    b.title = `${c.name} — ${c.px.length} dots`;
    b.innerHTML = `<span class="n">${c.px.length}</span>`;
    b.onclick = () => { activeIdx = i; renderSwatches(); setScope(eraseScope); };
    box.appendChild(b);
  });
  document.getElementById('activeName').textContent =
    curves[activeIdx] ? curves[activeIdx].name : '—';
  const sc = document.getElementById('sbScope');
  if (sc && eraseScope === 'active') {
    sc.textContent = curves[activeIdx] ? curves[activeIdx].name + ' only' : 'selected only';
  }
}

function miniChart(id, wl, inten, color) {
  const cv = document.getElementById(id);
  // back the CSS box with a 2x bitmap so the line stays crisp on retina
  const w = cv.width = Math.max(2, cv.clientWidth) * 2;
  const h = cv.height = Math.max(2, cv.clientHeight) * 2;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  const pad = { l: 34, r: 8, t: 8, b: 26 };
  if (!wl.length) return;
  const lo = Math.min(...wl), hi = Math.max(...wl);
  const X = v => pad.l + (v - lo) / ((hi - lo) || 1) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - v * (h - pad.t - pad.b);
  g.strokeStyle = '#e0e0e0'; g.lineWidth = 1;
  g.fillStyle = '#666'; g.font = '16px system-ui';
  for (let t = 0; t <= 10; t += 2) {
    const y = Y(t / 10);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.fillText((t / 10).toFixed(1), 2, y + 5);
  }
  g.fillText(lo.toFixed(0) + ' nm', pad.l, h - 6);
  g.fillText(hi.toFixed(0) + ' nm', w - pad.r - 60, h - 6);
  g.strokeStyle = color; g.lineWidth = 3; g.beginPath();
  wl.forEach((v, i) => (i ? g.lineTo(X(v), Y(inten[i])) : g.moveTo(X(v), Y(inten[i]))));
  g.stroke();
}

let derived = {};

/** Rebuild the side panel: one titled chart card per curve, plus the control
 *  for starting a new one in a colour of your choosing. */
function renderPanel() {
  const host = document.getElementById('curvePanel');
  if (!host) return;
  host.innerHTML = '';
  curves.forEach((c, i) => {
    const head = document.createElement('div');
    head.className = 'curve-head';
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = c.color;
    head.appendChild(dot);
    head.appendChild(document.createTextNode(c.name));
    if (c.custom) {
      const rm = document.createElement('button');
      rm.className = 'rm'; rm.textContent = '×';
      rm.title = 'Remove this curve';
      rm.onclick = () => {
        if (!confirm(`Remove "${c.name}" and its ${c.px.length} dots?`)) return;
        curves.splice(i, 1);
        activeIdx = Math.max(0, Math.min(activeIdx, curves.length - 1));
        snapshot('Remove curve', c.name);
        refresh(); draw();
      };
      head.appendChild(rm);
    }
    host.appendChild(head);

    const card = document.createElement('div');
    card.className = 'chart-card';
    const cv = document.createElement('canvas');
    cv.id = 'chart_' + c.key;
    card.appendChild(cv);
    host.appendChild(card);

    const p = derived[c.key] || { wl: [], inten: [] };
    const peak = p.wl.length ? p.wl[p.inten.indexOf(Math.max(...p.inten))] : null;
    for (const [label, value] of [
      ['Peak', peak ? peak.toFixed(1) + ' nm' : '—'],
      ['Points', p.wl.length ? `${p.wl.length} @ 0.1 nm` : '—'],
    ]) {
      const row = document.createElement('div');
      row.className = 'stat';
      row.innerHTML = `<span>${label}</span><b>${value}</b>`;
      host.appendChild(row);
    }
  });

  const nc = document.createElement('div');
  nc.className = 'newcurve';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.id = 'newColor';
  picker.value = NEW_COLORS[newCurveSeq % NEW_COLORS.length];
  picker.title = 'Colour for the new curve';
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '＋ New spectrum';
  btn.title = 'Start an extra curve in this colour — for a trace the digitizer missed entirely';
  btn.onclick = () => addCurve(picker.value);
  nc.appendChild(picker); nc.appendChild(btn);
  host.appendChild(nc);

  // charts need the canvases laid out before they can size themselves
  for (const c of curves) {
    const p = derived[c.key] || { wl: [], inten: [] };
    miniChart('chart_' + c.key, p.wl, p.inten, c.color);
  }
}

/** Start a new, empty curve in the chosen colour. */
function addCurve(color) {
  newCurveSeq++;
  const key = 'x' + newCurveSeq;
  const name = prompt('Name for the new spectrum:', 'curve ' + newCurveSeq);
  if (name === null) { newCurveSeq--; return; }
  curves.push({
    key, name: (name || 'curve ' + newCurveSeq).slice(0, 40),
    color, custom: true, px: [], py: [],
  });
  activeIdx = curves.length - 1;
  setMode('add');
  snapshot('New spectrum', name);
  refresh(); draw();
  toast(`"${name}" added — click along the ink to draw it`);
}

function refresh() {
  derived = {};
  for (const c of curves) derived[c.key] = physical(c);
  renderPanel();
  renderSwatches();
  renderPcc();
}

/* ── PhotochemCAD-style figures ───────────────────────────────────────────
 * One publication-style panel per curve, redrawn from the current dots, so a
 * spectrum you add appears here as its own figure rather than being folded
 * silently into the existing ones.
 */
function pccFigure(cv, wl, inten, color, title) {
  const w = cv.width = Math.max(2, cv.clientWidth) * 2;
  const h = cv.height = Math.max(2, cv.clientHeight) * 2;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  const pad = { l: 78, r: 26, t: 34, b: 62 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  if (!wl.length) return;

  const lo = Math.min(...wl), hi = Math.max(...wl);
  const X = v => pad.l + (v - lo) / ((hi - lo) || 1) * pw;
  const Y = v => pad.t + (1 - v) * ph;

  g.font = '20px system-ui'; g.fillStyle = '#222';
  g.textAlign = 'left';
  g.fillText(title, pad.l, 22);

  // 0.1 gridlines, as the printed plates are ruled
  g.strokeStyle = '#e4e4e4'; g.lineWidth = 1;
  g.fillStyle = '#555'; g.font = '17px system-ui';
  for (let t = 0; t <= 10; t++) {
    const y = Y(t / 10);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + pw, y); g.stroke();
    g.textAlign = 'right';
    g.fillText((t / 10).toFixed(1), pad.l - 8, y + 6);
  }
  const step = Math.max(5, Math.round((hi - lo) / 6 / 5) * 5);
  g.textAlign = 'center';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const x = X(v);
    g.strokeStyle = '#efefef';
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke();
    g.fillStyle = '#555';
    g.fillText(String(Math.round(v)), x, pad.t + ph + 26);
  }
  g.strokeStyle = '#333'; g.lineWidth = 2;
  g.strokeRect(pad.l, pad.t, pw, ph);

  g.fillStyle = '#333'; g.font = '18px system-ui';
  g.textAlign = 'center';
  g.fillText('Wavelength (nm)', pad.l + pw / 2, h - 16);
  g.save();
  g.translate(20, pad.t + ph / 2); g.rotate(-Math.PI / 2);
  g.fillText('Normalized intensity', 0, 0);
  g.restore();

  // smoothed trace — two light binomial passes with the peak pinned, the same
  // treatment the published viewer uses
  const sm = inten.slice();
  for (let pass = 0; pass < 2; pass++) {
    const prev = sm.slice();
    for (let i = 1; i < sm.length - 1; i++)
      sm[i] = 0.25 * prev[i - 1] + 0.5 * prev[i] + 0.25 * prev[i + 1];
  }
  const pk = inten.indexOf(Math.max(...inten));
  if (pk >= 0) sm[pk] = inten[pk];

  g.strokeStyle = color; g.lineWidth = 3.2;
  g.beginPath();
  wl.forEach((v, i) => (i ? g.lineTo(X(v), Y(sm[i])) : g.moveTo(X(v), Y(sm[i]))));
  g.stroke();
}

function renderPcc() {
  const grid = document.getElementById('pccGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const live = curves.filter(c => derived[c.key] && derived[c.key].wl.length);
  if (!live.length) {
    grid.innerHTML = '<p class="pcchint">No curves yet — add dots to see figures here.</p>';
    return;
  }
  for (const c of live) {
    const p = derived[c.key];
    const card = document.createElement('div');
    card.className = 'pcccard';
    const cv = document.createElement('canvas');
    card.appendChild(cv);

    const foot = document.createElement('div');
    foot.className = 'pccfoot';
    const csvBtn = document.createElement('button');
    csvBtn.className = 'btn';
    csvBtn.textContent = '⬇ CSV';
    csvBtn.onclick = () => {
      const rows = [['wavelength_nm', 'intensity']];
      for (let i = 0; i < p.wl.length; i++)
        rows.push([p.wl[i].toFixed(1), p.inten[i].toFixed(6)]);
      save(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }),
           `${safe(meta.name)}__${safe(c.name)}.csv`);
    };
    const pngBtn = document.createElement('button');
    pngBtn.className = 'btn';
    pngBtn.textContent = '⬇ Figure';
    pngBtn.onclick = () => cv.toBlob(b => save(b, `${safe(meta.name)}__${safe(c.name)}.png`));
    foot.appendChild(csvBtn); foot.appendChild(pngBtn);
    card.appendChild(foot);
    grid.appendChild(card);

    pccFigure(cv, p.wl, p.inten, c.color, `${meta.name} — ${c.name}`);
  }
}

/* ── downloads ───────────────────────────────────────────────────────── */

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safe = s => (s || 'spectrum').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/** Column pairs for export: one per curve that has data. */
function exportColumns() {
  return curves
    .map(c => ({ c, p: derived[c.key] }))
    .filter(x => x.p && x.p.wl.length)
    .map(x => ({
      label: x.c.name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(),
      name: x.c.name, wl: x.p.wl, inten: x.p.inten,
    }));
}

function csvText() {
  const cols = exportColumns();
  if (!cols.length) return '';
  const head = [];
  for (const c of cols) head.push(`${c.label}_wavelength_nm`, `${c.label}_intensity`);
  const rows = [head];
  const n = Math.max(...cols.map(c => c.wl.length));
  for (let i = 0; i < n; i++) {
    const r = [];
    for (const c of cols) {
      r.push(c.wl[i] !== undefined ? c.wl[i].toFixed(1) : '');
      r.push(c.inten[i] !== undefined ? c.inten[i].toFixed(6) : '');
    }
    rows.push(r);
  }
  return rows.map(r => r.join(',')).join('\n');
}

/* Minimal .xlsx writer — an xlsx is a ZIP of XML.  ZIP's STORED method needs
 * no compressor, so a real workbook is a few hundred lines with no library. */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const u16 = v => [v & 255, (v >> 8) & 255];
  const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const [name, text] of files) {
    const nm = enc.encode(name), data = enc.encode(text), cr = crc32(data);
    const hdr = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(cr), ...u32(data.length), ...u32(data.length),
      ...u16(nm.length), ...u16(0)]);
    chunks.push(hdr, nm, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(cr), ...u32(data.length), ...u32(data.length),
      ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nm]));
    offset += hdr.length + nm.length + data.length;
  }
  let csize = 0;
  for (const c of central) csize += c.length;
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(csize), ...u32(offset), ...u16(0)]);
  return new Blob([...chunks, ...central, eocd],
                  { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function xlsxBlob() {
  const cols = exportColumns();
  const col = i => String.fromCharCode(65 + i);
  const rows = [];
  const head = [];
  for (const c of cols) head.push(`${c.name} λ (nm)`, `${c.name} Intensity`);
  rows.push(`<row r="1">` + [`${meta.name} — SpectraWolf (edited)`].map((v, i) =>
    `<c r="${col(i)}1" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('') + `</row>`);
  rows.push(`<row r="2">` + [`Berlman ${gid} · Handbook of Fluorescence Spectra, 2nd Ed. (1971)`]
    .map((v, i) => `<c r="${col(i)}2" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('') + `</row>`);
  rows.push(`<row r="4">` + head.map((v, i) =>
    `<c r="${col(i)}4" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('') + `</row>`);
  const n = cols.length ? Math.max(...cols.map(c => c.wl.length)) : 0;
  for (let i = 0; i < n; i++) {
    const r = i + 5, cells = [];
    cols.forEach((c, ci) => {
      if (c.wl[i] === undefined) return;
      cells.push(`<c r="${col(ci * 2)}${r}"><v>${c.wl[i].toFixed(1)}</v></c>`);
      cells.push(`<c r="${col(ci * 2 + 1)}${r}"><v>${c.inten[i].toFixed(6)}</v></c>`);
    });
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>
<col min="1" max="16" width="20" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Spectrum" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

/* ── events ──────────────────────────────────────────────────────────── */

canvas.addEventListener('mousedown', e => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (mode === 'pan') {
    isPanning = true; panSX = x - panX; panSY = y - panY;
    wrap.style.cursor = 'grabbing';
    return;
  }
  const [ox, oy] = screenToOriginal(x, y);
  if (mode === 'add') {
    const c = curves[activeIdx];
    if (!c) return;
    c.px.push(ox); c.py.push(oy);
    snapshot('Add dot', c.name);
    refresh(); draw();
  } else if (mode === 'auto') {
    addWaypoint(ox, oy);
  } else if (mode === 'erase') {
    isErasing = true; eraseBatch = { t: 'erase', pts: [] }; lastErase = null;
    eraseStroke(ox, oy);
  }
});

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  lastMouse = [x, y];
  if (img && img.complete && frame && xcal) {
    const [ox, oy] = screenToOriginal(x, y);
    const wn = xcal.a * ox + xcal.b;
    const inten = (frame.y_bottom - oy) / (frame.y_bottom - frame.y_top);
    document.getElementById('sbPos').textContent = wn > 0
      ? `λ ${(1e7 / wn).toFixed(1)} nm · ${Math.round(wn)} cm⁻¹ · I ${inten.toFixed(3)}` : '';
  }
  if (isErasing) { const [ox, oy] = screenToOriginal(x, y); eraseStroke(ox, oy); return; }
  if (mode === 'erase') draw();
  if (isPanning) { panX = x - panSX; panY = y - panSY; draw(); }
});

window.addEventListener('mouseup', () => {
  if (isErasing) {
    isErasing = false; lastErase = null;
    if (eraseBatch && eraseBatch.pts.length) {
      const c = curves[activeIdx];
      snapshot('Erase', `${eraseScope === 'all' ? 'all curves' : (c ? c.name : '')} · -${eraseBatch.pts.length}`);
      toast(`Erased ${eraseBatch.pts.length} dots`);
    }
    eraseBatch = null;
  }
  if (isPanning) { isPanning = false; wrap.style.cursor = mode === 'pan' ? 'grab' : 'crosshair'; }
});

canvas.addEventListener('mouseleave', () => { lastMouse = null; if (mode === 'erase') draw(); });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const [sx, sy] = screenToScan(x, y);
  zoom *= e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoom = Math.max(0.05, Math.min(40, zoom));
  panX = x - sx * zoom; panY = y - sy * zoom;
  draw();
}, { passive: false });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.key === '1') setMode('add');
  else if (e.key === '2') setMode('erase');
  else if (e.key === '3') setMode('pan');
  else if (e.key === '4') setMode('auto');
  else if (e.key === 'Escape' && mode === 'auto' && waypoints.length) { waypoints = []; draw(); toast('Auto chain reset'); }
  else if (e.key === 's' || e.key === 'S') setScope(eraseScope === 'active' ? 'all' : 'active');
  else if (e.key === '[') { ERASE_R = Math.max(8, ERASE_R - 6); syncSizes(); draw(); }
  else if (e.key === ']') { ERASE_R = Math.min(80, ERASE_R + 6); syncSizes(); draw(); }
  else if (e.key === '0') fit();
  else if (e.key === '+' || e.key === '=') { zoom *= 1.2; draw(); }
  else if (e.key === '-') { zoom /= 1.2; draw(); }
  else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); redo(); }
  else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
  else if (e.key === 'y' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); }
});

function syncSizes() {
  let best = null, bd = 1e9;
  document.querySelectorAll('#sizes .size').forEach(b => {
    b.classList.remove('on');
    const d = Math.abs(+b.dataset.r - ERASE_R);
    if (d < bd) { bd = d; best = b; }
  });
  if (best) best.classList.add('on');
}
document.querySelectorAll('#sizes .size').forEach(b => {
  b.onclick = () => { ERASE_R = +b.dataset.r; syncSizes(); setMode('erase'); };
});

function setScope(s) {
  eraseScope = s;
  document.querySelectorAll('#scope .sc').forEach(b =>
    b.classList.toggle('on', b.dataset.scope === s));
  const act = curves[activeIdx];
  document.getElementById('sbScope').textContent =
    s === 'active' ? (act ? act.name + ' only' : 'selected only') : 'all curves';
  draw();
}
document.querySelectorAll('#scope .sc').forEach(b => {
  b.onclick = () => setScope(b.dataset.scope);
});

document.getElementById('tAdd').onclick = () => setMode('add');
document.getElementById('tAuto').onclick = () => setMode('auto');
document.getElementById('tErase').onclick = () => setMode('erase');
document.getElementById('tPan').onclick = () => setMode('pan');
document.getElementById('tUndo').onclick = undo;
document.getElementById('hUndo').onclick = undo;
document.getElementById('hRedo').onclick = redo;
document.getElementById('btnSave').onclick = saveToSite;
document.getElementById('tFit').onclick = fit;
document.getElementById('tIn').onclick = () => { zoom *= 1.2; draw(); };
document.getElementById('tOut').onclick = () => { zoom /= 1.2; draw(); };
document.getElementById('tReset').onclick = () => {
  if (confirm('Discard your edits and reload the published dots?')) loadPage();
};

document.getElementById('dlCsv').onclick = () =>
  save(new Blob([csvText()], { type: 'text/csv' }), `${safe(meta.name)}__${gid}_edited.csv`);
document.getElementById('dlXlsx').onclick = () =>
  save(xlsxBlob(), `${safe(meta.name)}__${gid}_edited.xlsx`);

/* ── save to the site ──────────────────────────────────────────────────
 * Posts the derived 0.1 nm curves — the same numbers the CSV and Excel
 * downloads carry — so the site's charts, peaks and CSV all follow. */
let communityEdit = null;   // the edit already published for this page, if any

async function saveToSite() {
  const btn = document.getElementById('btnSave');
  const msg = document.getElementById('svMsg');
  if (!derived || (!derived.em && !derived.ab)) { toast('Nothing to save yet'); return; }
  btn.disabled = true;
  msg.className = 'svmsg';
  msg.textContent = 'Saving…';
  try {
    const r = await fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gid,
        em:  derived.em  && derived.em.wl.length  ? derived.em  : null,
        ab:  derived.ab  && derived.ab.wl.length  ? derived.ab  : null,
        em2: derived.em2 && derived.em2.wl.length ? derived.em2 : null,
        extra: curves.filter(c => c.custom && derived[c.key] && derived[c.key].wl.length)
                     .map(c => ({ name: c.name, color: c.color,
                                  wl: derived[c.key].wl, inten: derived[c.key].inten })),
        author: document.getElementById('svAuthor').value,
        note: document.getElementById('svNote').value,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    communityEdit = { version: d.version, ts: d.ts };
    msg.className = 'svmsg ok';
    msg.textContent = `Saved · version ${d.version} · ${d.points} points are now live on the site.`;
    toast('Saved — the site now shows your version');
    snapshot('Saved to site', `v${String(d.version).slice(-6)}`);
  } catch (e) {
    msg.className = 'svmsg err';
    msg.textContent = 'Could not save: ' + e.message;
    toast('Save failed');
  } finally {
    btn.disabled = false;
  }
}

/* If this spectrum already carries a community edit, start from it — otherwise
 * a visitor would silently overwrite someone else's work with the published
 * curve the moment they hit Save. */
async function loadCommunityEdit() {
  const msg = document.getElementById('svMsg');
  try {
    const r = await fetch('/api/edits?gid=' + encodeURIComponent(gid) + '&t=' + Date.now());
    if (!r.ok) { communityEdit = null; return; }
    const doc = await r.json();
    if (!doc || (!doc.em && !doc.ab)) return;
    communityEdit = doc;
    for (const k of ['em', 'ab', 'em2']) {
      const src = doc[k];
      if (!src) continue;
      let c = curves.find(x => x.key === k);
      if (!c) { c = { ...ROLE[k], px: [], py: [] }; curves.push(c); }
      Object.assign(c, toPixels(src));
    }
    // curves a contributor drew themselves come back with their own colours
    curves = curves.filter(c => !c.custom);
    (doc.extra || []).forEach((src, i) => {
      newCurveSeq = Math.max(newCurveSeq, i + 1);
      curves.push({ key: 'x' + (i + 1), name: src.name || `curve ${i + 1}`,
                    color: src.color || '#3B82F6', custom: true, ...toPixels(src) });
    });
    activeIdx = Math.min(activeIdx, curves.length - 1);
    renderSwatches(); refresh(); draw();
    snapshot('Community edit', `by ${doc.author || 'anonymous'}`);
    if (msg) {
      msg.className = 'svmsg';
      msg.textContent = `Loaded the current community edit by ${doc.author || 'anonymous'}` +
                        (doc.note ? ` — ${doc.note}` : '') + '. Your save will replace it.';
    }
    toast(`Loaded the community edit by ${doc.author || 'anonymous'}`);
  } catch { /* API unreachable — carry on with the published curve */ }
}

function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 1600);
}

window.addEventListener('resize', resize);
boot();
