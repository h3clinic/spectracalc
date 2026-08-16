/* POST /api/save — store a community edit of one spectrum.
 * Appends a row; the published curve and every earlier version stay intact. */
'use strict';
const L = require('./_lib.js');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  if (req.method !== 'POST') return L.json(res, 405, { error: 'POST only' });
  if (!L.configured()) return L.json(res, 503, { error: 'edit storage is not configured' });

  let body;
  try { body = await L.readBody(req); }
  catch (e) { return L.json(res, 413, { error: e.message }); }

  const gid = String(body.gid || '');
  if (!L.GID_RE.test(gid)) return L.json(res, 400, { error: 'bad gid' });

  let em, ab, em2, extra;
  try {
    em = L.validateCurve(body.em, 'emission');
    ab = L.validateCurve(body.ab, 'absorption');
    em2 = L.validateCurve(body.em2, 'emission II');
    extra = L.validateExtra(body.extra);
  } catch (e) { return L.json(res, 422, { error: e.message }); }
  if (!em && !ab && !em2 && !extra)
    return L.json(res, 422, { error: 'nothing to save — send at least one curve' });

  const version = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const points = (em ? em.wl.length : 0) + (ab ? ab.wl.length : 0) +
                 (em2 ? em2.wl.length : 0) +
                 (extra ? extra.reduce((n, c) => n + c.wl.length, 0) : 0);

  try {
    const row = await L.insertEdit({
      gid, version, em, ab, em2, extra, points,
      author: L.clean(body.author, 60) || 'anonymous',
      note: L.clean(body.note, 200),
    });
    return L.json(res, 200, {
      ok: true, gid, version, points,
      ts: row ? Date.parse(row.created_at) : Date.now(),
    });
  } catch (e) {
    return L.json(res, e.status === 400 ? 422 : 500,
      { error: 'could not store the edit', detail: String(e.message || e) });
  }
};
