/* GET /api/edits            -> index of every edited spectrum
 * GET /api/edits?gid=graph-144 -> the current community version of one */
'use strict';
const L = require('./_lib.js');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const gid = url.searchParams.get('gid');

  if (gid) {
    if (!L.GID_RE.test(gid)) return L.json(res, 400, { error: 'bad gid' });
    const doc = await L.readJson(`edits/${gid}/latest.json`);
    if (!doc || doc.reverted || (!doc.em && !doc.ab))
      return L.json(res, 404, { error: 'no community edit for this spectrum' });
    return L.json(res, 200, doc);
  }

  const idx = await L.readJson('index/edited.json');
  return L.json(res, 200, idx || { updated: 0, edits: {} });
};
