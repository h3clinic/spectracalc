/* Community edits layer for the viewer.
 *
 * The site ships the published digitization inlined in `SPECTRA`.  When
 * someone saves an edit through the browser editor, this layer splices that
 * version into `SPECTRA[gid]` *before* showCompound() runs — so the charts,
 * the smoothed PhotochemCAD curve, the peak readouts and the downloads all
 * follow from the edited numbers with no changes to the viewer itself.
 *
 * The published curve is kept on the entry as `_published`, so reverting is a
 * local operation and the original is never lost in the browser either.
 */
(function () {
  'use strict';

  var index = {};          // gid -> {ts, author, note, version}
  var loaded = {};         // gid -> true once its edit has been spliced in
  var inflight = {};

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function banner() {
    var b = document.getElementById('communityBanner');
    if (b) return b;
    b = el('div', { id: 'communityBanner' });
    b.style.cssText =
      'display:none;margin:0 0 14px;padding:10px 14px;border-radius:6px;' +
      'border:1px solid var(--pcc-gold,#EFC047);background:rgba(239,192,71,.13);' +
      'font-size:13.5px;line-height:1.5;display:flex;gap:12px;align-items:center;' +
      'flex-wrap:wrap;';
    var host = document.getElementById('metaSection');
    if (host && host.parentNode) host.parentNode.insertBefore(b, host);
    return b;
  }

  function showBanner(gid, meta) {
    var b = banner();
    b.style.display = 'flex';
    b.innerHTML = '';
    var when = meta && meta.ts ? new Date(meta.ts).toLocaleString() : '';
    var who = (meta && meta.author) || 'anonymous';
    var txt = el('span', {},
      'Showing a community edit by ' + who + (when ? ' · ' + when : '') +
      (meta && meta.note ? ' — ' + meta.note : ''));
    txt.style.flex = '1 1 260px';
    b.appendChild(txt);

    var seeOrig = el('button', { type: 'button' }, 'Show published');
    seeOrig.style.cssText = 'cursor:pointer;font-size:12.5px;padding:4px 10px;border-radius:5px;' +
      'border:1px solid var(--pcc-border,#ccc);background:transparent;color:inherit;';
    seeOrig.onclick = function () {
      var d = SPECTRA[gid];
      if (d && d._published) { d.em = d._published.em; d.ab = d._published.ab; }
      loaded[gid] = 'published';
      b.style.display = 'none';
      window.showCompound(gid);
    };
    b.appendChild(seeOrig);

    var revert = el('button', { type: 'button' }, 'Revert for everyone');
    revert.style.cssText = seeOrig.style.cssText;
    revert.onclick = function () {
      if (!confirm('Restore the published digitization for ' + gid +
                   ' for all visitors? The edit stays in the history.')) return;
      revert.disabled = true;
      fetch('/api/revert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid: gid }),
      }).then(function (r) { return r.json(); }).then(function () {
        delete index[gid];
        var d = SPECTRA[gid];
        if (d && d._published) { d.em = d._published.em; d.ab = d._published.ab; }
        loaded[gid] = 'published';
        b.style.display = 'none';
        window.showCompound(gid);
      }).catch(function () { revert.disabled = false; });
    };
    b.appendChild(revert);
    return b;
  }

  function applyEdit(gid, doc) {
    var d = SPECTRA[gid];
    if (!d) return;
    if (!d._published) d._published = { em: d.em, ab: d.ab };
    d.em = doc.em || null;
    d.ab = doc.ab || null;
    if (doc.em && doc.em.inten && doc.em.inten.length) {
      var pe = doc.em.wl[doc.em.inten.indexOf(Math.max.apply(null, doc.em.inten))];
      if (pe != null) d.lam_em = String(Math.round(pe));
    }
    if (doc.ab && doc.ab.inten && doc.ab.inten.length) {
      var pa = doc.ab.wl[doc.ab.inten.indexOf(Math.max.apply(null, doc.ab.inten))];
      if (pa != null) d.lam_abs = String(Math.round(pa));
    }
    loaded[gid] = true;
  }

  // point the CSV download at the API, which serves the edited file when one
  // exists and redirects to the published file when it doesn't
  function wireDownloads(gid) {
    var dc = document.getElementById('dlCsvBtn');
    if (dc) dc.href = index[gid] ? '/api/csv?gid=' + gid : 'downloads/csv/' + gid + '.csv';
    var dx = document.getElementById('dlXlsxBtn');
    if (dx && index[gid]) dx.title = 'Excel reflects the published digitization; ' +
      'the CSV button carries the community edit';
  }

  var orig = window.showCompound;
  function wrapped(id) {
    if (index[id] && loaded[id] !== true && loaded[id] !== 'published' && !inflight[id]) {
      inflight[id] = true;
      fetch('/api/edits?gid=' + encodeURIComponent(id) + '&t=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (doc) {
          inflight[id] = false;
          if (doc && (doc.em || doc.ab)) {
            applyEdit(id, doc);
            if (window._curId === id) { wrapped(id); }
          }
        })
        .catch(function () { inflight[id] = false; });
    }
    orig.call(window, id);
    if (index[id] && loaded[id] === true) showBanner(id, index[id]);
    else { var b = document.getElementById('communityBanner'); if (b) b.style.display = 'none'; }
    wireDownloads(id);
  }

  function markSidebar() {
    document.querySelectorAll('.pcc-compound-list li').forEach(function (li) {
      var on = !!index[li.dataset.id];
      li.style.borderLeft = on ? '3px solid var(--pcc-gold,#EFC047)' : '';
      if (on && !li.querySelector('.cedit')) {
        var s = el('span', { class: 'cedit' }, '✎');
        s.style.cssText = 'float:right;opacity:.75;font-size:11px;';
        s.title = 'Community edited';
        li.appendChild(s);
      }
    });
  }

  function boot() {
    // SPECTRA is a top-level `const` in the viewer, so it is a lexical
    // global — it never appears on `window`.  Probe the binding itself.
    if (typeof window.showCompound !== 'function' || typeof SPECTRA === 'undefined') {
      return setTimeout(boot, 60);
    }
    orig = window.showCompound;
    window.showCompound = wrapped;
    fetch('/api/edits?t=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        index = (j && j.edits) || {};
        markSidebar();
        if (window._curId) wrapped(window._curId);
      })
      .catch(function () { /* offline or API down — the published site still works */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
