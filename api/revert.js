/* POST /api/revert {gid} — drop back to the published digitization.
 * Recorded as a new version rather than a deletion, so the edit history stays
 * intact and a revert is itself reversible. */
'use strict';
const L = require('./_lib.js');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  if (req.method !== 'POST') return L.json(res, 405, { error: 'POST only' });
  let body;
  try { body = await L.readBody(req); }
  catch (e) { return L.json(res, 413, { error: e.message }); }

  const gid = String(body.gid || '');
  if (!L.GID_RE.test(gid)) return L.json(res, 400, { error: 'bad gid' });
  const cur = await L.readJson(`edits/${gid}/latest.json`);
  if (!cur) return L.json(res, 404, { error: 'nothing to revert — this spectrum is unedited' });

  const ts = Date.now();
  const version = `${ts}-revert`;
  const doc = {
    gid, version, ts, reverted: true,
    author: L.clean(body.author, 60) || 'anonymous',
    note: L.clean(body.note, 200) || 'reverted to the published digitization',
    em: null, ab: null,
  };
  await L.writeJson(`edits/${gid}/v/${version}.json`, doc);
  await L.writeJson(`edits/${gid}/latest.json`, doc);
  await L.rebuildIndex({ [gid]: doc });
  return L.json(res, 200, { ok: true, gid, version, reverted: true });
};
