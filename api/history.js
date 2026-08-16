/* GET /api/history?gid=graph-144 — every version ever saved, newest first. */
'use strict';
const L = require('./_lib.js');
const { list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  const gid = new URL(req.url, 'http://x').searchParams.get('gid');
  if (!L.GID_RE.test(gid || '')) return L.json(res, 400, { error: 'bad gid' });

  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: `edits/${gid}/v/`, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const m = b.pathname.match(/\/v\/(.+)\.json$/);
      if (m) out.push({ version: m[1], size: b.size, uploadedAt: b.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  out.sort((a, b) => (a.version < b.version ? 1 : -1));
  return L.json(res, 200, { gid, versions: out });
};
