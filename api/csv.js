/* GET /api/csv?gid=graph-144 — the CSV for a spectrum, reflecting the current
 * community edit when one exists.  This is the download the site links to, so
 * an edit changes the CSV people receive. */
'use strict';
const L = require('./_lib.js');

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const gid = url.searchParams.get('gid');
  if (!L.GID_RE.test(gid || '')) return L.json(res, 400, { error: 'bad gid' });

  if (!L.configured()) { res.statusCode = 302;
    res.setHeader('location', `/downloads/csv/${gid}.csv`); return res.end(); }
  const doc = await L.latest(gid);
  // a reverted page is back to the published digitization, so serve that file
  if (!doc) {
    // no community edit — hand back the published file
    res.statusCode = 302;
    res.setHeader('location', `/downloads/csv/${gid}.csv`);
    return res.end();
  }

  const cols = L.curveColumns(doc);
  const head = [];
  for (const c of cols) head.push(`${c.label}_wavelength_nm`, `${c.label}_intensity`);
  const rows = [
    `${gid} — community edit ${doc.version} by ${doc.author}${doc.note ? ' — ' + doc.note : ''}`,
    head.join(','),
  ];
  const n = cols.length ? Math.max(...cols.map(c => c.wl.length)) : 0;
  for (let i = 0; i < n; i++) {
    const r = [];
    for (const c of cols) {
      r.push(c.wl[i] !== undefined ? c.wl[i].toFixed(1) : '');
      r.push(c.inten[i] !== undefined ? c.inten[i].toFixed(6) : '');
    }
    rows.push(r.join(','));
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${gid}_edited.csv"`);
  res.setHeader('cache-control', 'no-store');
  res.end(rows.join('\n'));
};
