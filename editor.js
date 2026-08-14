/* SpectraWolf browser editor — static-site companion to the local app.
 *
 * There is no server here.  Dot positions are reconstructed from the
 * published 0.1 nm data pushed back through the page's frozen calibration
 * (the same inverse transform that draws the round-trip validation image),
 * so the dots land on the printed ink without any digitization step.
 */
'use strict';

const ROLE = {
  em: { key: 'em', name: 'emission', color: '#C0392B' },
  ab: { key: 'ab', name: 'absorption', color: '#1E8F4E' },
};

let SPECTRA = null, ORDER = null, FRAMES = null;
let gid = null, meta = null, frame = null, xcal = null;
let curves = [];          // [{key, name, color, px[], py[]}] in ORIGINAL page px
let activeIdx = 0;
let img = null, imgW = 0, imgH = 0, pageScale = 1;   // scan px -> original px
let zoom = 1, panX = 0, panY = 0;
let mode = 'pan';
let undoStack = [];
let ERASE_R = 26;
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
  for (const k of ['em', 'ab']) {
    if (!meta[k]) continue;
    const wl = meta[k].wl, v = meta[k].inten;
    const px = [], py = [];
    for (let i = 0; i < wl.length; i++) {
      px.push((1e7 / wl[i] - xcal.b) / xcal.a);
      py.push(frame.y_bottom - v[i] * (frame.y_bottom - frame.y_top));
    }
    curves.push({ ...ROLE[k], px, py });
  }
  activeIdx = 0;
  undoStack = [];

  img = new Image();
  img.onload = () => {
    imgW = img.width; imgH = img.height;
    pageScale = frame.w / imgW;           // original px per displayed scan px
    document.getElementById('loading').style.display = 'none';
    resize(); fit(); setMode('add'); renderSwatches(); refresh();
  };
  img.onerror = () => {
    document.getElementById('loading').textContent = 'Could not load the page scan.';
  };
  img.src = 'scans/' + gid + '.webp';
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

/* ── drawing ─────────────────────────────────────────────────────────── */

function resize() {
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}

function fit() {
  if (!imgW) return;
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
  ctx.globalAlpha = 1;
  ctx.restore();

  if (mode === 'erase' && lastMouse) {
    ctx.beginPath();
    ctx.arc(lastMouse[0], lastMouse[1], ERASE_R, 0, 6.2832);
    ctx.fillStyle = 'rgba(231,76,60,0.18)';
    ctx.fill();
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#e74c3c';
    ctx.font = '12px system-ui';
    ctx.fillText('⌫ ' + ERASE_R + 'px', lastMouse[0] + ERASE_R + 6, lastMouse[1] + 4);
  }
}

/* ── editing ─────────────────────────────────────────────────────────── */

function setMode(m) {
  mode = m;
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('on'));
  ({ add: 'tAdd', erase: 'tErase', pan: 'tPan' })[m] &&
    document.getElementById({ add: 'tAdd', erase: 'tErase', pan: 'tPan' }[m]).classList.add('on');
  wrap.style.cursor = m === 'pan' ? 'grab' : m === 'erase' ? 'none' : 'crosshair';
  document.getElementById('sbMode').textContent =
    { add: 'Add dots', erase: 'Eraser', pan: 'Pan' }[m] || m;
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

function undo() {
  const a = undoStack.pop();
  if (!a) return;
  if (a.t === 'add') {
    const c = curves[a.ci];
    c.px.splice(a.i, 1); c.py.splice(a.i, 1);
    toast('Undid add');
  } else if (a.t === 'erase') {
    for (const [ci, x, y] of a.pts) { curves[ci].px.push(x); curves[ci].py.push(y); }
    toast(`Restored ${a.pts.length} dots`);
  }
  refresh(); draw();
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
    b.onclick = () => { activeIdx = i; renderSwatches(); draw(); };
    box.appendChild(b);
  });
  document.getElementById('activeName').textContent =
    curves[activeIdx] ? curves[activeIdx].name : '—';
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
function refresh() {
  derived = {};
  for (const c of curves) {
    const p = physical(c);
    derived[c.key] = p;
    const peak = p.wl.length ? p.wl[p.inten.indexOf(Math.max(...p.inten))] : null;
    const pk = document.getElementById(c.key + 'Peak');
    const n = document.getElementById(c.key + 'N');
    if (pk) pk.textContent = peak ? peak.toFixed(1) + ' nm' : '—';
    if (n) n.textContent = p.wl.length ? `${p.wl.length} @ 0.1 nm` : '—';
    miniChart(c.key + 'Chart', p.wl, p.inten, c.color);
  }
  renderSwatches();
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

function csvText() {
  const em = derived.em || { wl: [], inten: [] }, ab = derived.ab || { wl: [], inten: [] };
  const rows = [['emission_wavelength_nm', 'emission_intensity',
                 'absorption_wavelength_nm', 'absorption_intensity']];
  for (let i = 0; i < Math.max(em.wl.length, ab.wl.length); i++) {
    rows.push([
      em.wl[i] !== undefined ? em.wl[i].toFixed(1) : '',
      em.inten[i] !== undefined ? em.inten[i].toFixed(6) : '',
      ab.wl[i] !== undefined ? ab.wl[i].toFixed(1) : '',
      ab.inten[i] !== undefined ? ab.inten[i].toFixed(6) : '',
    ]);
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
  const em = derived.em || { wl: [], inten: [] }, ab = derived.ab || { wl: [], inten: [] };
  const col = i => String.fromCharCode(65 + i);
  const rows = [];
  const head = ['Emission λ (nm)', 'Emission Intensity', 'Absorption λ (nm)', 'Absorption Intensity'];
  rows.push(`<row r="1">` + [`${meta.name} — SpectraWolf (edited)`].map((v, i) =>
    `<c r="${col(i)}1" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('') + `</row>`);
  rows.push(`<row r="2">` + [`Berlman ${gid} · Handbook of Fluorescence Spectra, 2nd Ed. (1971)`]
    .map((v, i) => `<c r="${col(i)}2" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('') + `</row>`);
  rows.push(`<row r="4">` + head.map((v, i) =>
    `<c r="${col(i)}4" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('') + `</row>`);
  const n = Math.max(em.wl.length, ab.wl.length);
  for (let i = 0; i < n; i++) {
    const r = i + 5, cells = [];
    if (em.wl[i] !== undefined) {
      cells.push(`<c r="A${r}"><v>${em.wl[i].toFixed(1)}</v></c>`);
      cells.push(`<c r="B${r}"><v>${em.inten[i].toFixed(6)}</v></c>`);
    }
    if (ab.wl[i] !== undefined) {
      cells.push(`<c r="C${r}"><v>${ab.wl[i].toFixed(1)}</v></c>`);
      cells.push(`<c r="D${r}"><v>${ab.inten[i].toFixed(6)}</v></c>`);
    }
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>
<col min="1" max="4" width="20" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
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
    undoStack.push({ t: 'add', ci: activeIdx, i: c.px.length - 1 });
    refresh(); draw();
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
      undoStack.push(eraseBatch);
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
  else if (e.key === '[') { ERASE_R = Math.max(8, ERASE_R - 6); syncSizes(); draw(); }
  else if (e.key === ']') { ERASE_R = Math.min(80, ERASE_R + 6); syncSizes(); draw(); }
  else if (e.key === '0') fit();
  else if (e.key === '+' || e.key === '=') { zoom *= 1.2; draw(); }
  else if (e.key === '-') { zoom /= 1.2; draw(); }
  else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
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

document.getElementById('tAdd').onclick = () => setMode('add');
document.getElementById('tErase').onclick = () => setMode('erase');
document.getElementById('tPan').onclick = () => setMode('pan');
document.getElementById('tUndo').onclick = undo;
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

function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 1600);
}

window.addEventListener('resize', resize);
boot();
