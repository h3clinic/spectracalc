/* POST /api/revert {gid} — go back to the published digitization.
 * Recorded as a new row rather than a deletion, so the history stays intact
 * and the revert is itself reversible. */
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

  try {
    const cur = await L.latest(gid);
    if (!cur) return L.json(res, 404, { error: 'nothing to revert — this spectrum is unedited' });
    const version = `${Date.now()}-revert`;
    await L.insertEdit({
      gid, version, em: null, ab: null, reverted: true, points: 0,
      author: L.clean(body.author, 60) || 'anonymous',
      note: L.clean(body.note, 200) || 'reverted to the published digitization',
    });
    return L.json(res, 200, { ok: true, gid, version, reverted: true });
  } catch (e) {
    return L.json(res, 500, { error: String(e.message || e) });
  }
};
