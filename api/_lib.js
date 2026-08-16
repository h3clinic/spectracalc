/* Shared helpers for the community-edit API, backed by Supabase (Postgres).
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

const GID_RE = /^graph-\d{1,4}$/;
const MAX_POINTS = 20000;
const MAX_BODY = 6 * 1024 * 1024;

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

function configured() { return !!(SB_URL && SB_KEY); }

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
  return { wl: owl, inten: oin };
}

const clean = (s, max) =>
  String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

const COLS = 'gid,version,author,note,em,ab,reverted,points,created_at';

/** The current version of one spectrum, or null when it has none / was reverted. */
async function latest(gid) {
  const rows = await sb(
    `spectra_latest?gid=eq.${encodeURIComponent(gid)}&select=${COLS}&limit=1`);
  const row = rows && rows[0];
  if (!row || row.reverted || (!row.em && !row.ab)) return null;
  return row;
}

/** Every spectrum that currently carries an edit, as gid -> metadata. */
async function index() {
  const rows = await sb(
    'spectra_latest?select=gid,version,author,note,reverted,points,created_at' +
    '&reverted=is.false&order=gid.asc');
  const out = {};
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

async function insertEdit(doc) {
  const rows = await sb('spectra_edits', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: doc,
  });
  return rows && rows[0];
}

/** Every version ever saved for a spectrum, newest first. */
async function history(gid) {
  return sb(`spectra_edits?gid=eq.${encodeURIComponent(gid)}` +
            '&select=version,author,note,reverted,points,created_at' +
            '&order=created_at.desc');
}

module.exports = {
  GID_RE, json, allowCors, readBody, validateCurve, clean,
  configured, sb, latest, index, insertEdit, history,
};
