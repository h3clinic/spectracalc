/* GET /api/xlsx?gid=graph-144 — the Excel workbook for a spectrum, carrying the
 * current community edit when one exists.
 *
 * An .xlsx is a ZIP of XML parts, and ZIP's STORED method needs no compressor,
 * so the workbook is written here with no dependency at all.
 */
'use strict';
const zlib = require('node:zlib');
const L = require('./_lib.js');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Minimal ZIP writer.  Parts are DEFLATE-compressed — a 1500-row sheet is
 *  mostly repeated markup, so stored-only would balloon the download. */
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (v) => Buffer.from([v & 255, (v >> 8) & 255]);
  const u32 = (v) => Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);

  for (const [name, text] of files) {
    const nm = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const cr = crc32(raw);
    const hdr = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(cr), u32(comp.length), u32(raw.length), u16(nm.length), u16(0),
    ]);
    chunks.push(hdr, nm, comp);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(cr), u32(comp.length), u32(raw.length),
      u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nm,
    ]));
    offset += hdr.length + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...chunks, cd, eocd]);
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function workbook(gid, doc) {
  const em = doc.em || { wl: [], inten: [] };
  const ab = doc.ab || { wl: [], inten: [] };
  const col = (i) => String.fromCharCode(65 + i);
  const rows = [];
  const head = ['Emission λ (nm)', 'Emission Intensity',
                'Absorption λ (nm)', 'Absorption Intensity'];
  const title = `${gid} — community edit by ${doc.author || 'anonymous'}`;
  rows.push(`<row r="1"><c r="A1" t="inlineStr"><is><t>${esc(title)}</t></is></c></row>`);
  rows.push(`<row r="2"><c r="A2" t="inlineStr"><is><t>${esc(
    (doc.note ? doc.note + ' · ' : '') +
    'Berlman, Handbook of Fluorescence Spectra, 2nd Ed. (1971)')}</t></is></c></row>`);
  rows.push(`<row r="4">` + head.map((h, i) =>
    `<c r="${col(i)}4" t="inlineStr"><is><t>${esc(h)}</t></is></c>`).join('') + `</row>`);
  const n = Math.max(em.wl.length, ab.wl.length);
  for (let i = 0; i < n; i++) {
    const r = i + 5, cells = [];
    if (em.wl[i] !== undefined) {
      cells.push(`<c r="A${r}"><v>${em.wl[i].toFixed(1)}</v></c>`);
      cells.push(`<c r="B${r}"><v>${em.inten[i].toFixed(6)}</v></c>`);
    }
    if (ab.wl[i] !== undefined) {
      cells.push(`<c r="C${r}"><v>${ab.wl[i].toFixed(1)}</v></c>`);
      cells.push(`<c r="D${r}"><v>${ab.inten[i].toFixed(6)}</v></c>`);
    }
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="4" width="21" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData></worksheet>`;

  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Spectrum" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

module.exports = async (req, res) => {
  if (L.allowCors(req, res)) return;
  const gid = new URL(req.url, 'http://x').searchParams.get('gid');
  if (!L.GID_RE.test(gid || '')) return L.json(res, 400, { error: 'bad gid' });

  if (!L.configured()) { res.statusCode = 302;
    res.setHeader('location', `/downloads/xlsx/${gid}.xlsx`); return res.end(); }
  const doc = await L.latest(gid);
  if (!doc) {
    res.statusCode = 302;                       // unedited — the published file
    res.setHeader('location', `/downloads/xlsx/${gid}.xlsx`);
    return res.end();
  }

  const buf = workbook(gid, doc);
  res.statusCode = 200;
  res.setHeader('content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('content-disposition', `attachment; filename="${gid}_edited.xlsx"`);
  res.setHeader('cache-control', 'no-store');
  res.end(buf);
};
