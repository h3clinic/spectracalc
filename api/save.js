/* POST /api/save — store a community edit of one spectrum.
 * Never destroys the published curve: each save appends an immutable version
 * and repoints latest.json at it. */
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

  let em, ab;
  try {
    em = L.validateCurve(body.em, 'emission');
    ab = L.validateCurve(body.ab, 'absorption');
  } catch (e) { return L.json(res, 422, { error: e.message }); }
  if (!em && !ab) return L.json(res, 422, { error: 'nothing to save — send emission and/or absorption' });

  const ts = Date.now();
  const version = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const doc = {
    gid, version, ts,
    author: L.clean(body.author, 60) || 'anonymous',
    note: L.clean(body.note, 200),
    em, ab,
  };

  try {
    await L.writeJson(`edits/${gid}/v/${version}.json`, doc);   // immutable
    await L.writeJson(`edits/${gid}/latest.json`, doc);          // what the site serves
    const idx = await L.rebuildIndex({ [gid]: doc });
    return L.json(res, 200, {
      ok: true, gid, version, ts,
      points: (em ? em.wl.length : 0) + (ab ? ab.wl.length : 0),
      totalEdited: Object.keys(idx).length,
    });
  } catch (e) {
    return L.json(res, 500, { error: 'could not store the edit', detail: String(e.message || e) });
  }
};
