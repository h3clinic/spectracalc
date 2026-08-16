/* GET /api/edits                 -> index of every edited spectrum
 * GET /api/edits?gid=graph-144   -> the current community version of one */
'use strict';
const L = require('./_lib.js');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  if (!L.configured()) return L.json(res, 200, { updated: 0, edits: {} });

  const gid = new URL(req.url, 'http://x').searchParams.get('gid');
  try {
    if (gid) {
      if (!L.GID_RE.test(gid)) return L.json(res, 400, { error: 'bad gid' });
      const row = await L.latest(gid);
      if (!row) return L.json(res, 404, { error: 'no community edit for this spectrum' });
      return L.json(res, 200, {
        gid: row.gid, version: row.version, author: row.author, note: row.note,
        ts: Date.parse(row.created_at),
        em: row.em, ab: row.ab, em2: row.em2, extra: row.extra,
      });
    }
    const edits = await L.index();
    return L.json(res, 200, { updated: Date.now(), edits });
  } catch (e) {
    return L.json(res, 500, { error: String(e.message || e) });
  }
};
