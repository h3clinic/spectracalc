/* Shared helpers for the community-edit API.
 *
 * Two interchangeable backends behind one interface: Supabase (Postgres) when
 * SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set, otherwise Vercel Blob.
 * The routes never learn which one is answering.
 *
 * One append-only table, public.spectra_edits, plus a view, public.spectra_latest,
 * that picks the newest row per spectrum.  The view *derives* the index rather
 * than storing one, so it cannot drift from the data — the earlier object-storage
 * version maintained an index file by hand and silently dropped a page whenever a
 * read missed its own write.
 *
 * Row-level security makes the table append-only for the public key: select and
 * insert are allowed, update and delete affect nothing.  A revert is therefore a
 * new row flagged `reverted`, never a deletion, and no visitor can rewrite
 * someone else's history.
 *
 * The key used here is Supabase's *publishable* key, which is designed to ship in
 * client code.  Nothing secret is required or present.
 */
'use strict';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';

/* Object storage is the fallback backend, used when no Postgres is wired up.
 *
 * The earlier object-storage attempt kept mutable keys: one global index file
 * listing every edited page, and a `latest.json` per page, both rewritten on
 * each save.  Blob URLs are CDN-cached, so a read could answer with the body a
 * key held before the last write, and a page would look unedited seconds after
 * someone saved it.
 *
 * Nothing here is ever rewritten.  A save is one new immutable key,
 * `edits/<gid>/v/<version>.json`, and both the current version and the set of
 * edited pages are *derived* by listing that prefix and taking the newest.  A
 * URL's body can never be out of date, because it never changes. */
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BLOB_API = 'https://blob.vercel-storage.com';

const GID_RE = /^graph-\d{1,4}$/;
const MAX_POINTS = 20000;
const MAX_BODY = 6 * 1024 * 1024;
const MAX_HOLES = 400;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function allowCors(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}

/* Postgres wins when it is wired up; object storage is the fallback. */
const BACKEND = (SB_URL && SB_KEY) ? 'supabase' : (BLOB_TOKEN ? 'blob' : null);

function configured() { return BACKEND !== null; }

async function sb(path, opts) {
  opts = opts || {};
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: Object.assign({
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const e = new Error((data && (data.message || data.error)) || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Reject anything that isn't a plausible spectrum before it reaches the table. */
function validateCurve(c, label) {
  if (c == null) return null;
  if (typeof c !== 'object') throw new Error(`${label}: not an object`);
  const wl = c.wl, inten = c.inten;
  if (!Array.isArray(wl) || !Array.isArray(inten))
    throw new Error(`${label}: wl and inten must be arrays`);
  if (wl.length !== inten.length)
    throw new Error(`${label}: wl and inten differ in length`);
  if (wl.length < 2) throw new Error(`${label}: needs at least 2 points`);
  if (wl.length > MAX_POINTS)
    throw new Error(`${label}: ${wl.length} points exceeds the ${MAX_POINTS} cap`);
  let prev = -Infinity;
  const owl = [], oin = [];
  for (let i = 0; i < wl.length; i++) {
    const w = Number(wl[i]), v = Number(inten[i]);
    if (!Number.isFinite(w) || !Number.isFinite(v))
      throw new Error(`${label}: non-finite value at index ${i}`);
    if (w < 100 || w > 1200)
      throw new Error(`${label}: wavelength ${w} nm outside 100-1200`);
    if (v < -0.5 || v > 1.5)
      throw new Error(`${label}: intensity ${v} outside -0.5..1.5`);
    if (w < prev) throw new Error(`${label}: wavelengths must ascend (index ${i})`);
    prev = w;
    owl.push(Math.round(w * 10) / 10);
    oin.push(Math.round(v * 1e6) / 1e6);
  }
  /* `scaled_by` is the factor that took this curve to unit peak, and it is the
   * only way back to the pixel row the dot was traced from.  Dropping it here
   * meant the editor reloaded its own save with every dot lifted off the ink by
   * exactly that factor: the record round-tripped as numbers but not as a
   * picture.  It is data about the curve, so it travels with it. */
  const s = Number(c.scaled_by);
  const out = { wl: owl, inten: oin };
  if (Number.isFinite(s) && s > 0 && s < 1e4) out.scaled_by = Math.round(s * 1e6) / 1e6;

  /* Spans the contributor cleared on purpose.  Without them a reload cannot
   * tell an erased stretch from a break in the printed ink, and fills the
   * erased one back in: the edit saves 2017 points and loads 2057. */
  if (Array.isArray(c.holes)) {
    const holes = [];
    for (const h of c.holes.slice(0, MAX_HOLES)) {
      if (!Array.isArray(h) || h.length !== 2) continue;
      const lo = Number(h[0]), hi = Number(h[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
      if (lo < 100 || hi > 1200) continue;
      holes.push([Math.round(lo * 100) / 100, Math.round(hi * 100) / 100]);
    }
    if (holes.length) out.holes = holes;
  }
  return out;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_EXTRA = 8;

/** Validate contributor-drawn curves: [{name, color, wl, inten}, ...] */
function validateExtra(list) {
  if (list == null) return null;
  if (!Array.isArray(list)) throw new Error('extra: must be a list of curves');
  if (!list.length) return null;
  if (list.length > MAX_EXTRA)
    throw new Error(`extra: ${list.length} curves exceeds the ${MAX_EXTRA} cap`);
  return list.map((c, i) => {
    const curve = validateCurve(c, `extra[${i}]`);
    if (!curve) throw new Error(`extra[${i}]: empty curve`);
    const color = String(c.color || '');
    if (!HEX.test(color)) throw new Error(`extra[${i}]: colour must be #rrggbb`);
    const out = {
      name: clean(c.name, 40) || `curve ${i + 1}`,
      color: color.toLowerCase(),
      wl: curve.wl, inten: curve.inten,
    };
    if (curve.scaled_by != null) out.scaled_by = curve.scaled_by;
    if (curve.holes != null) out.holes = curve.holes;
    return out;
  });
}

const clean = (s, max) =>
  String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

const COLS = 'gid,version,author,note,em,ab,em2,extra,reverted,points,created_at';

/* ── object-storage backend ───────────────────────────────────────────── */

/* Every key is written once and never rewritten.
 *
 * Blob URLs are CDN-cached, so a mutable "latest" pointer can answer a read
 * with the body it held before the last write — the page that looks unedited
 * seconds after someone saved it.  Nothing here is ever overwritten: a save is
 * a new `edits/<gid>/v/<version>.json`, and the current version is *found*, by
 * listing that prefix and taking the newest.  Immutable bodies make the cache
 * harmless, because a URL's content can never be out of date.
 */
const blobAuth = () => ({ authorization: `Bearer ${BLOB_TOKEN}` });
const versionKey = (gid, version) => `edits/${gid}/v/${version}.json`;
const VERSION_PATH = /^edits\/(graph-\d{1,4})\/v\/(\d+)[^/]*\.json$/;

/** Newest-first by the millisecond stamp every version string starts with. */
function newestFirst(blobs) {
  return blobs
    .map(b => ({ b, m: VERSION_PATH.exec(b.pathname) }))
    .filter(x => x.m)
    .sort((p, q) => Number(q.m[2]) - Number(p.m[2]))
    .map(x => ({ blob: x.b, gid: x.m[1], stamp: Number(x.m[2]) }));
}

async function blobPut(pathname, doc) {
  const r = await fetch(`${BLOB_API}/${pathname}`, {
    method: 'PUT',
    headers: Object.assign(blobAuth(), {
      'x-content-type': 'application/json',
      'x-vercel-blob-access': 'private',   // nothing here is world-readable
      'x-add-random-suffix': '0',          // the pathname IS the key
      'x-allow-overwrite': '1',
    }),
    body: JSON.stringify(doc),
  });
  if (!r.ok) {
    const e = new Error(`blob put ${pathname}: HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function blobList(prefix) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ prefix, limit: '1000' });
    if (cursor) q.set('cursor', cursor);
    const r = await fetch(`${BLOB_API}?${q.toString()}`, { headers: blobAuth() });
    if (!r.ok) {
      const e = new Error(`blob list ${prefix}: HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    for (const b of j.blobs || []) out.push(b);
    if (!j.hasMore) return out;
    cursor = j.cursor;
  }
  return out;
}

async function blobRead(url) {
  const r = await fetch(url, { headers: blobAuth() });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`blob read: HTTP ${r.status}`);
  return r.json();
}

async function blobLatest(gid) {
  const newest = newestFirst(await blobList(`edits/${gid}/v/`))[0];
  return newest ? blobRead(newest.blob.url) : null;
}

/** The current version of one spectrum, or null when it has none / was reverted. */
async function latest(gid) {
  let row;
  if (BACKEND === 'supabase') {
    const rows = await sb(
      `spectra_latest?gid=eq.${encodeURIComponent(gid)}&select=${COLS}&limit=1`);
    row = rows && rows[0];
  } else {
    row = await blobLatest(gid);
  }
  if (!row || row.reverted) return null;
  if (!row.em && !row.ab && !row.em2 && !(row.extra && row.extra.length)) return null;
  return row;
}

/** Every spectrum that currently carries an edit, as gid -> metadata. */
async function index() {
  const out = {};
  if (BACKEND === 'supabase') {
    const rows = await sb(
      'spectra_latest?select=gid,version,author,note,reverted,points,created_at' +
      '&reverted=is.false&order=gid.asc');
    for (const r of rows || []) {
      out[r.gid] = {
        ts: Date.parse(r.created_at),
        author: r.author || '',
        note: r.note || '',
        version: r.version,
        points: r.points,
        reverted: false,
      };
    }
    return out;
  }
  // Derived, never stored.  A page is in this index because its record is in
  // the bucket, so the two cannot disagree; the newest version of each page
  // wins, and a page whose newest version is a revert drops out below.
  const newestPerGid = new Map();
  for (const v of newestFirst(await blobList('edits/'))) {
    if (!newestPerGid.has(v.gid)) newestPerGid.set(v.gid, v.blob);
  }
  const rows = await Promise.all(
    [...newestPerGid.values()].map(b => blobRead(b.url).catch(() => null)));
  for (const r of rows) {
    if (!r || r.reverted || !r.gid) continue;
    if (!r.em && !r.ab && !r.em2 && !(r.extra && r.extra.length)) continue;
    out[r.gid] = {
      ts: Date.parse(r.created_at) || r.ts || 0,
      author: r.author || '',
      note: r.note || '',
      version: r.version,
      points: r.points,
      reverted: false,
    };
  }
  return Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
}

async function insertEdit(doc) {
  const row = Object.assign({ created_at: new Date().toISOString() }, doc);
  if (BACKEND === 'supabase') {
    const rows = await sb('spectra_edits', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: doc,
    });
    return rows && rows[0];
  }
  await blobPut(versionKey(row.gid, row.version), row);
  return row;
}

/** Every version ever saved for a spectrum, newest first. */
async function history(gid) {
  if (BACKEND === 'supabase') {
    return sb(`spectra_edits?gid=eq.${encodeURIComponent(gid)}` +
              '&select=version,author,note,reverted,points,created_at' +
              '&order=created_at.desc');
  }
  const versions = newestFirst(await blobList(`edits/${gid}/v/`));
  const rows = (await Promise.all(versions.map(v => blobRead(v.blob.url).catch(() => null))))
    .filter(Boolean);
  return rows.map(r => ({
    version: r.version, author: r.author, note: r.note,
    reverted: !!r.reverted, points: r.points, created_at: r.created_at,
  }));
}

/** Export columns for a stored record: the standard curves plus any the
 *  contributor drew themselves, in a stable order. */
/**
 * Export what was stored, unscaled.
 *
 * This used to divide each curve by its own apex so the peak read exactly
 * 1.00.  That is a global scaling: it displaces every point in proportion to
 * its intensity, most at the maximum and not at all at the baseline.  A
 * contributor who drags the apex down onto the printed stroke and saves would
 * get it lifted straight back off the ink by the very next download — the
 * correction survived in the database and was undone on the way out.  The
 * stored curve is the measurement; ship it.
 */
function curveColumns(doc) {
  const out = [];
  for (const [key, name] of [['em', 'Emission'], ['ab', 'Absorption'], ['em2', 'Emission II']]) {
    const c = doc[key];
    if (c && c.wl && c.wl.length)
      out.push({ label: key === 'em2' ? 'emission_ii' : name.toLowerCase(), name, wl: c.wl, inten: c.inten });
  }
  for (const raw of doc.extra || []) {
    const c = raw;
    if (!c || !c.wl || !c.wl.length) continue;
    out.push({
      label: String(raw.name || 'curve').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(),
      name: raw.name || 'curve', wl: c.wl, inten: c.inten,
    });
  }
  return out;
}

module.exports = {
  GID_RE, json, allowCors, readBody, validateCurve, validateExtra, clean,
  configured, sb, latest, index, insertEdit, history, curveColumns,
};
