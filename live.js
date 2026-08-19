/* Live digitization — the needle view.
 *
 * The walkthrough explains the pipeline a stage at a time.  This does the other
 * thing: it puts you at the point of contact.  A stroke is followed column by
 * column, and you watch three views of the same instant — the trace crawling
 * across the plate, an 8× loupe on the pixels actually under the needle, and
 * the spectrum drawing itself as each point comes off.  Nothing is replayed
 * from the dataset; the curve is read off the image here and now.
 */
'use strict';

const RULE_COVERAGE = 0.6, MAX_RUN_H = 60, SEARCH = 15, GAP_MAX = 14, SLOPE_MEM = 0.62;
const COLS = ['#ff5a4d', '#37d17a', '#f0a83a'];

const $ = i => document.getElementById(i);
const P = $('plateCv'), pg = P.getContext('2d');
const L = $('loupe'), lg = L.getContext('2d');
const C = $('chart'), cg = C.getContext('2d');

let page = null;            // {img,W,H,mask,rule,box,thr}
let axis = null;            // {left,right} in nm
let job = null;             // running trace
let raf = 0, speed = 14;

/* ── image → ink, and the plot box from its own rules ──────────────────── */
function analyse(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const W = c.width, H = c.height, d = x.getImageData(0, 0, W, H).data;
  const lum = new Uint8Array(W * H), h = new Float64Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    lum[p] = v; h[v]++;
  }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * h[t];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += h[t]; if (!wB) continue;
    const wF = W * H - wB; if (!wF) break;
    sB += t * h[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < mask.length; p++) mask[p] = lum[p] <= thr ? 1 : 0;

  const rowC = new Float64Array(H), colC = new Float64Array(W);
  for (let y = 0; y < H; y++) { let n = 0;
    for (let X = 0; X < W; X += 2) if (mask[y * W + X]) n++; rowC[y] = n / (W / 2); }
  for (let X = 0; X < W; X++) { let n = 0;
    for (let y = 0; y < H; y += 2) if (mask[y * W + X]) n++; colC[X] = n / (H / 2); }
  const pick = (cov, from, to, dir) => { let bi = -1, bv = 0;
    for (let i = from; dir > 0 ? i < to : i > to; i += dir) if (cov[i] > bv) { bv = cov[i]; bi = i; }
    return bv > 0.45 ? bi : -1; };
  const t_ = pick(rowC, 0, H * .55 | 0, 1), b_ = pick(rowC, H - 1, H * .45 | 0, -1);
  const l_ = pick(colC, 0, W * .55 | 0, 1), r_ = pick(colC, W - 1, W * .45 | 0, -1);
  const box = { left: l_ >= 0 ? l_ : W * .12 | 0, right: r_ >= 0 ? r_ : W * .92 | 0,
                top: t_ >= 0 ? t_ : H * .08 | 0, bottom: b_ >= 0 ? b_ : H * .88 | 0 };
  const rule = new Uint8Array(H);
  for (let y = 0; y < H; y++) { let n = 0, s = 0;
    for (let X = box.left + 20; X <= box.right - 20; X += 2) { s++; if (mask[y * W + X]) n++; }
    if (s && n / s > RULE_COVERAGE) rule[y] = 1; }
  return { img, W, H, mask, rule, thr, box };
}

function runsAt(p, x) {
  const out = []; let s = -1;
  for (let y = 0; y < p.H; y++) {
    if (p.mask[y * p.W + x]) { if (s < 0) s = y; }
    else if (s >= 0) { out.push([s, y - 1]); s = -1; }
  }
  if (s >= 0) out.push([s, p.H - 1]);
  return out.filter(([a, b]) => {
    if (b - a > MAX_RUN_H) return false;
    for (let y = a; y <= b; y++) if (!p.rule[y]) return true;
    return false;
  });
}

/* ── the job: seed, then step one column at a time ─────────────────────── */
function seeds(p) {
  const out = [], mid = (p.box.left + p.box.right) / 2 | 0;
  for (let k = -5; k <= 5; k++) {
    const x = Math.round(mid + k * (p.box.right - p.box.left) / 14);
    if (x <= p.box.left + 2 || x >= p.box.right - 2) continue;
    for (const [a, b] of runsAt(p, x)) out.push([x, (a + b) / 2]);
  }
  return out;
}

/* How far does this seed actually get?  Seeds are taken from every ink run in
 * a column, which includes the caption text and the structure drawing, and
 * those give stubs.  Rather than guess by position, run each candidate as a
 * cheap dry trace and order them by how much of the plot they cover — a real
 * spectrum runs most of the width, a glyph runs a few dozen columns.  The live
 * pass then re-traces the good ones for real, so what you watch is the trace
 * being made, not a recording of it. */
function seedReach(p, sx, sy) {
  let reach = 0;
  for (const dir of [-1, 1]) {
    let y = sy, slope = 0, gap = 0;
    for (let x = sx + dir; x >= p.box.left && x <= p.box.right; x += dir) {
      const pred = y + slope;
      let best = null, bd = SEARCH;
      for (const [a, b] of runsAt(p, x)) {
        const t = (pred >= a && pred <= b) ? pred : (pred < a ? a : b);
        const gp = (pred >= a && pred <= b) ? 0 : Math.min(Math.abs(pred - a), Math.abs(pred - b));
        if (gp < bd) { bd = gp; best = t; }
      }
      if (best === null) { if (++gap > GAP_MAX) break; y = pred; continue; }
      gap = 0; slope = SLOPE_MEM * slope + (1 - SLOPE_MEM) * (best - y); y = best; reach++;
    }
  }
  return reach;
}

function newJob(p) {
  const span = p.box.right - p.box.left;
  const pool = seeds(p)
    .map(([x, y]) => ({ x, y, reach: seedReach(p, x, y) }))
    .filter(s => s.reach > span * 0.12)
    .sort((a, b) => b.reach - a.reach)
    .map(s => [s.x, s.y]);
  return { p, curves: [], cur: null, pool, used: [], runsRead: 0, done: false };
}

function taken(job, x, y) {
  return job.used.some(t => t.some(([qx, qy]) => Math.abs(qx - x) < 3 && Math.abs(qy - y) < 10));
}

/* one unit of work: place at most one point */
function stepJob(job) {
  const p = job.p;
  if (!job.cur) {
    while (job.pool.length) {
      const [x, y] = job.pool.shift();
      if (taken(job, x, y)) continue;
      job.cur = { seed: [x, y], dir: -1, x, y, slope: 0, gap: 0,
                  pts: [[x, y]], colour: COLS[job.curves.length % 3] };
      return { kind: 'seed', x, y };
    }
    job.done = true;
    return { kind: 'done' };
  }
  const c = job.cur;
  const nx = c.x + c.dir;
  if (nx < p.box.left || nx > p.box.right) {
    if (c.dir === -1) {                       // turn around and go the other way
      const s = c.seed;
      c.dir = 1; c.x = s[0]; c.y = s[1]; c.slope = 0; c.gap = 0;
      return { kind: 'turn' };
    }
    return finishCurve(job);
  }
  const pred = c.y + c.slope;
  let best = null, bd = SEARCH;
  for (const [a, b] of runsAt(p, nx)) {
    job.runsRead++;
    const t = (pred >= a && pred <= b) ? pred : (pred < a ? a : b);
    const gp = (pred >= a && pred <= b) ? 0 : Math.min(Math.abs(pred - a), Math.abs(pred - b));
    if (gp < bd) { bd = gp; best = t; }
  }
  c.x = nx;
  if (best === null) {
    if (++c.gap > GAP_MAX) {
      if (c.dir === -1) { const s = c.seed;
        c.dir = 1; c.x = s[0]; c.y = s[1]; c.slope = 0; c.gap = 0; return { kind: 'turn' }; }
      return finishCurve(job);
    }
    c.y = pred;
    return { kind: 'gap', x: nx, y: pred };
  }
  c.gap = 0;
  c.slope = SLOPE_MEM * c.slope + (1 - SLOPE_MEM) * (best - c.y);
  c.y = best;
  c.pts.push([nx, best]);
  return { kind: 'point', x: nx, y: best };
}

function finishCurve(job) {
  const c = job.cur;
  job.cur = null;
  const span = job.p.box.right - job.p.box.left;
  c.pts.sort((a, b) => a[0] - b[0]);
  if (c.pts.length > span * 0.10) { job.curves.push(c); job.used.push(c.pts); }
  if (job.curves.length >= 3) job.done = true;
  return { kind: 'curve', n: c.pts.length };
}

/* ── the three views ───────────────────────────────────────────────────── */
let needle = null;                       // where the algorithm is right now

function fitCanvas(cv) {
  cv.width = cv.clientWidth * devicePixelRatio;
  cv.height = cv.clientHeight * devicePixelRatio;
}

function drawPlate() {
  fitCanvas(P);
  pg.setTransform(1, 0, 0, 1, 0, 0);
  pg.fillStyle = '#07090c'; pg.fillRect(0, 0, P.width, P.height);
  if (!page) return;
  const s = Math.min(P.width / page.W, P.height / page.H);
  const ox = (P.width - page.W * s) / 2, oy = (P.height - page.H * s) / 2;
  page.s = s; page.ox = ox; page.oy = oy;
  const X = x => ox + x * s, Y = y => oy + y * s;
  pg.drawImage(page.img, ox, oy, page.W * s, page.H * s);

  pg.strokeStyle = 'rgba(90,162,255,.55)'; pg.lineWidth = 1.2;
  pg.strokeRect(X(page.box.left), Y(page.box.top),
    (page.box.right - page.box.left) * s, (page.box.bottom - page.box.top) * s);

  if (job) {
    const paint = (pts, col, w) => {
      pg.strokeStyle = col; pg.lineWidth = w; pg.lineJoin = 'round'; pg.beginPath();
      pts.forEach(([x, y], i) => i ? pg.lineTo(X(x), Y(y)) : pg.moveTo(X(x), Y(y)));
      pg.stroke();
    };
    for (const c of job.curves) paint(c.pts, c.colour, 2.4);
    if (job.cur) {
      const done = job.cur.pts.slice().sort((a, b) => a[0] - b[0]);
      paint(done, job.cur.colour, 2.6);
    }
    if (needle) {                        // the needle and its column
      pg.strokeStyle = 'rgba(255,210,74,.30)'; pg.lineWidth = 1;
      pg.beginPath(); pg.moveTo(X(needle.x), oy); pg.lineTo(X(needle.x), oy + page.H * s); pg.stroke();
      pg.strokeStyle = '#ffd24a'; pg.lineWidth = 2;
      pg.beginPath(); pg.arc(X(needle.x), Y(needle.y), 7, 0, 6.283); pg.stroke();
    }
  }
}

function drawLoupe() {
  fitCanvas(L);
  lg.setTransform(1, 0, 0, 1, 0, 0);
  lg.fillStyle = '#07090c'; lg.fillRect(0, 0, L.width, L.height);
  if (!page || !needle) return;
  const Z = 8 * devicePixelRatio;
  const halfW = L.width / (2 * Z), halfH = L.height / (2 * Z);
  lg.imageSmoothingEnabled = false;
  lg.drawImage(page.img,
    needle.x - halfW, needle.y - halfH, halfW * 2, halfH * 2,
    0, 0, L.width, L.height);
  // the ink the tracer sees, over the pixels it saw it in
  const runs = runsAt(page, Math.round(needle.x));
  lg.fillStyle = 'rgba(90,162,255,.30)';
  for (const [a, b] of runs) {
    const y0 = (a - (needle.y - halfH)) * Z, y1 = (b + 1 - (needle.y - halfH)) * Z;
    lg.fillRect(L.width / 2 - Z / 2, y0, Z, y1 - y0);
  }
  lg.strokeStyle = 'rgba(255,210,74,.35)'; lg.lineWidth = 1;
  lg.beginPath(); lg.moveTo(L.width / 2, 0); lg.lineTo(L.width / 2, L.height); lg.stroke();
  lg.strokeStyle = '#ffd24a'; lg.lineWidth = 2;
  lg.beginPath(); lg.arc(L.width / 2, L.height / 2, 9, 0, 6.283); lg.stroke();
}

function drawChart() {
  fitCanvas(C);
  cg.setTransform(1, 0, 0, 1, 0, 0);
  cg.fillStyle = '#12151a'; cg.fillRect(0, 0, C.width, C.height);
  if (!page || !axis) return;
  const m = { l: 52 * devicePixelRatio, r: 16 * devicePixelRatio,
              t: 34 * devicePixelRatio, b: 34 * devicePixelRatio };
  const w = C.width - m.l - m.r, h = C.height - m.t - m.b;
  const lo = Math.min(axis.left, axis.right), hi = Math.max(axis.left, axis.right);
  const X = nm => m.l + ((nm - lo) / (hi - lo)) * w;
  const Y = v => m.t + (1 - v) * h;

  cg.strokeStyle = '#1e232c'; cg.lineWidth = 1;
  for (let v = 0; v <= 1.0001; v += 0.2) {
    cg.beginPath(); cg.moveTo(m.l, Y(v)); cg.lineTo(m.l + w, Y(v)); cg.stroke();
  }
  cg.fillStyle = '#8b94a3'; cg.font = `${11 * devicePixelRatio}px ui-sans-serif,system-ui`;
  cg.textAlign = 'right';
  for (let v = 0; v <= 1.0001; v += 0.2) cg.fillText(v.toFixed(1), m.l - 7 * devicePixelRatio, Y(v) + 4);
  cg.textAlign = 'center';
  for (let k = 0; k <= 4; k++) {
    const nm = lo + (hi - lo) * k / 4;
    cg.fillText(nm.toFixed(0), X(nm), C.height - 12 * devicePixelRatio);
  }
  cg.strokeStyle = '#2a303b';
  cg.strokeRect(m.l, m.t, w, h);

  if (!job) return;
  const px2nm = x => axis.left + ((x - page.box.left) / (page.box.right - page.box.left))
                     * (axis.right - axis.left);
  const px2in = y => (page.box.bottom - y) / (page.box.bottom - page.box.top);
  const plot = (pts, col, live) => {
    if (pts.length < 2) return;
    cg.strokeStyle = col; cg.lineWidth = 2 * devicePixelRatio;
    cg.lineJoin = 'round'; cg.beginPath();
    pts.forEach(([x, y], i) => {
      const px = X(px2nm(x)), py = Y(px2in(y));
      i ? cg.lineTo(px, py) : cg.moveTo(px, py);
    });
    cg.stroke();
    if (live) {
      const [lx, ly] = pts[pts.length - 1];
      cg.fillStyle = '#ffd24a';
      cg.beginPath(); cg.arc(X(px2nm(lx)), Y(px2in(ly)), 4 * devicePixelRatio, 0, 6.283); cg.fill();
    }
  };
  for (const c of job.curves) plot(c.pts, c.colour, false);
  if (job.cur) plot(job.cur.pts.slice().sort((a, b) => a[0] - b[0]), job.cur.colour, true);
}

function redraw() { drawPlate(); drawLoupe(); drawChart(); }

/* ── loop, stats, wiring ───────────────────────────────────────────────── */
const set = (id, v) => { $(id).textContent = v; };

function tick() {
  if (!job || job.done) { stop(); return; }
  const n = Math.max(1, speed);
  let last = null;
  for (let i = 0; i < n && !job.done; i++) {
    const r = stepJob(job);
    if (r.kind === 'point' || r.kind === 'gap' || r.kind === 'seed') last = r;
    if (r.kind === 'curve') set('sst', `curve ${job.curves.length} · ${r.n} pts`);
  }
  if (last) needle = { x: last.x, y: last.y };
  if (needle && axis) {
    const nm = axis.left + ((needle.x - page.box.left) / (page.box.right - page.box.left))
             * (axis.right - axis.left);
    set('sx', Math.round(needle.x));
    set('swl', nm.toFixed(1) + ' nm');
    set('sin', ((page.box.bottom - needle.y) / (page.box.bottom - page.box.top)).toFixed(3));
  }
  const pts = job.curves.reduce((a, c) => a + c.pts.length, 0) + (job.cur ? job.cur.pts.length : 0);
  set('spt', pts.toLocaleString());
  set('srn', job.runsRead.toLocaleString());
  redraw();
  if (job.done) { stop(); return; }
  raf = document.visibilityState === 'visible'
      ? requestAnimationFrame(tick) : setTimeout(tick, 16);
}

function start() {
  if (!page) return;
  job = newJob(page);
  needle = null;
  set('sst', 'tracing'); $('go').textContent = '❚❚ Pause';
  $('msg').style.display = 'none';
  tick();
}
function stop() {
  cancelAnimationFrame(raf); clearTimeout(raf); raf = 0;
  $('go').textContent = job && job.done ? '▶ Again' : '▶ Digitize';
  if (job && job.done) {
    const pts = job.curves.reduce((a, c) => a + c.pts.length, 0);
    set('sst', `done · ${job.curves.length} curve${job.curves.length === 1 ? '' : 's'}`);
    set('spt', pts.toLocaleString());
  }
  redraw();
}

$('go').onclick = () => {
  if (raf) { cancelAnimationFrame(raf); clearTimeout(raf); raf = 0;
             $('go').textContent = '▶ Resume'; set('sst', 'paused'); return; }
  if (job && !job.done) { $('go').textContent = '❚❚ Pause'; set('sst', 'tracing'); tick(); return; }
  start();
};
$('speed').oninput = e => { speed = +e.target.value; };
$('up').onclick = () => $('file').click();
$('file').onchange = e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const im = new Image();
  im.onload = () => {
    stop(); job = null; needle = null;
    page = analyse(im);
    const nm = prompt('Wavelength in nm at the left and right edges of the plot box, '
                    + 'comma separated', '250, 400');
    const parts = (nm || '').split(',').map(v => parseFloat(v.trim()));
    axis = (parts.length === 2 && parts.every(isFinite))
         ? { left: parts[0], right: parts[1] } : { left: 0, right: 100 };
    $('hint').textContent = `${f.name} · box ${page.box.left}–${page.box.right} × ${page.box.top}–${page.box.bottom}`;
    $('msg').style.display = 'none';
    redraw();
    start();
  };
  im.src = URL.createObjectURL(f);
};
$('page').onchange = () => loadPage($('page').value);
addEventListener('resize', redraw);

/* dataset pages come with a frozen box and a fitted axis — use them, and trace
   the ink from scratch anyway, which is the point of the view */
async function loadPage(gid) {
  stop(); job = null; needle = null; page = null;
  $('msg').style.display = ''; $('msg').textContent = 'loading ' + gid + '…';
  redraw();
  const [frames, meta] = await Promise.all([
    fetch('data/frames.json').then(r => r.json()),
    fetch('data/sp/' + gid + '.json').then(r => r.json()),
  ]);
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej;
    i.src = 'scans/' + gid + '.webp';
  });
  page = analyse(img);
  const f = frames[gid];
  if (f) {
    const ps = f.w / page.W;                       // trust the frozen frame
    page.box = { left: Math.round(f.x_left / ps), right: Math.round(f.x_right / ps),
                 top: Math.round(f.y_top / ps), bottom: Math.round(f.y_bottom / ps) };
  }
  const xc = meta.xcal;
  axis = xc
    ? { left: 1e7 / (xc.a * (page.box.left * (f.w / page.W)) + xc.b),
        right: 1e7 / (xc.a * (page.box.right * (f.w / page.W)) + xc.b) }
    : { left: 250, right: 700 };
  $('hint').textContent = `${meta.name} · ${axis.left.toFixed(0)}–${axis.right.toFixed(0)} nm`;
  $('msg').style.display = 'none';
  set('sst', 'ready'); set('spt', '0'); set('srn', '0');
  redraw();
}

(async () => {
  const idx = await fetch('data/index.json').then(r => r.json());
  const want = new URLSearchParams(location.search).get('gid') || 'graph-427';
  $('page').innerHTML = idx.map(e =>
    `<option value="${e.gid}"${e.gid === want ? ' selected' : ''}>${e.gid.replace('graph-', 'B')} — ${e.name}</option>`).join('');
  await loadPage(want);
  if (new URLSearchParams(location.search).has('auto')) start();
})();
