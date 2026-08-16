/* Shared helpers for the community-edit API.
 *
 * Storage layout in the Blob store (append-only by design — a published
 * spectrum is never destroyed, only layered over):
 *
 *   edits/<gid>/latest.json      the version the site currently serves
 *   edits/<gid>/v/<stamp>.json   every version ever saved, immutable
 *   index/edited.json            gid -> {ts, author, note, points}
 *
 * The index is rebuilt from a listing on every save, so a lost or raced
 * write repairs itself on the next save rather than drifting permanently.
 */
'use strict';

const { put, list, get } = require('@vercel/blob');

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

/** Reject anything that isn't a plausible spectrum before it reaches storage. */
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

async function readJson(pathname) {
  try {
    // the store is private, so blob URLs 403 without auth — read through the
    // SDK, which signs the request with the project's token
    const g = await get(pathname, { access: 'private' });
    if (!g) return null;               // absent blob is a normal outcome
    const text = await new Response(g.stream).text();   // g.blob is metadata, not content
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJson(pathname, obj) {
  return put(pathname, JSON.stringify(obj), {
    access: 'private',                 // matches the store's access mode
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/** Rebuild index/edited.json from the actual latest.json blobs. */
async function rebuildIndex(known) {
  const seen = {};
  let cursor;
  do {
    const page = await list({ prefix: 'edits/', cursor, limit: 1000 });
    for (const b of page.blobs) {
      const m = b.pathname.match(/^edits\/(graph-\d+)\/latest\.json$/);
      if (m) seen[m[1]] = b;
    }
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  // the listing can lag a fresh write as well — seed it with what we know
  if (known) for (const g of Object.keys(known)) if (!seen[g]) seen[g] = { pathname: `edits/${g}/latest.json` };
  const idx = {};
  await Promise.all(Object.entries(seen).map(async ([gid, b]) => {
    // prefer a doc the caller just wrote: object storage can miss its own
    // write for a moment, which would drop that page from the index
    const doc = (known && known[gid]) || await readJson(b.pathname);
    if (!doc) return;
    if (doc.reverted || (!doc.em && !doc.ab)) return;   // back to published
    idx[gid] = {
      ts: doc.ts,
      author: doc.author || '',
      note: doc.note || '',
      version: doc.version,
      points: (doc.em ? doc.em.wl.length : 0) + (doc.ab ? doc.ab.wl.length : 0),
      reverted: !!doc.reverted,
    };
  }));
  await writeJson('index/edited.json', { updated: Date.now(), edits: idx });
  return idx;
}

module.exports = {
  GID_RE, json, allowCors, readBody, validateCurve, clean,
  readJson, writeJson, rebuildIndex,
};
