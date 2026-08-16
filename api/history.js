/* GET /api/history?gid=graph-144 — every version ever saved, newest first. */
'use strict';
const L = require('./_lib.js');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  if (!L.configured()) return L.json(res, 200, { gid: null, versions: [] });
  const gid = new URL(req.url, 'http://x').searchParams.get('gid');
  if (!L.GID_RE.test(gid || '')) return L.json(res, 400, { error: 'bad gid' });
  try {
    const rows = await L.history(gid);
    return L.json(res, 200, {
      gid,
      versions: (rows || []).map(r => ({
        version: r.version, author: r.author, note: r.note,
        reverted: r.reverted, points: r.points, ts: Date.parse(r.created_at),
      })),
    });
  } catch (e) {
    return L.json(res, 500, { error: String(e.message || e) });
  }
};
