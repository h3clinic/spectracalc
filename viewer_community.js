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

  // downloads go through the API, which serves the edited file when one exists
  // and redirects to the published file when it doesn't — so both formats
  // always carry whatever the page is showing
  function wireDownloads(gid) {
    var edited = !!index[gid];
    var dc = document.getElementById('dlCsvBtn');
    if (dc) dc.href = edited ? '/api/csv?gid=' + gid : 'downloads/csv/' + gid + '.csv';
    var dx = document.getElementById('dlXlsxBtn');
    if (dx) {
      dx.href = edited ? '/api/xlsx?gid=' + gid : 'downloads/xlsx/' + gid + '.xlsx';
      dx.title = edited ? 'Excel built from the current community edit' : '';
    }
  }

  /* ── round-trip overlay, rendered live ──────────────────────────────────
   * The shipped overlay PNG has the published dots burned into it, so after an
   * edit it showed the OLD trace.  Draw it instead: the clean page scan with
   * the dots that are actually on screen, pushed back through this page's
   * frozen calibration — the same inverse transform the batch overlay used.
   */
  var frames = null, framesReq = null;
  function getFrames() {
    if (frames) return Promise.resolve(frames);
    if (!framesReq) framesReq = fetch('data/frames.json')
      .then(function (r) { return r.json(); })
      .then(function (j) { frames = j; return j; })
      .catch(function () { return null; });
    return framesReq;
  }

  function drawOverlay(gid) {
    var img = document.getElementById('overlayImg');
    if (!img) return;
    var d = SPECTRA[gid];
    if (!d || !d.xcal) return;
    getFrames().then(function (fr) {
      if (!fr || !fr[gid]) return;             // no geometry -> keep the PNG
      var f = fr[gid];
      var scan = new Image();
      scan.onload = function () {
        var cv = document.getElementById('overlayLive');
        if (!cv) {
          cv = document.createElement('canvas');
          cv.id = 'overlayLive';
          cv.style.cssText = 'display:block;width:100%;height:auto;border-radius:4px;';
          img.parentNode.insertBefore(cv, img);
          img.style.display = 'none';
        }
        cv.width = scan.width; cv.height = scan.height;
        var g = cv.getContext('2d');
        g.drawImage(scan, 0, 0);
        var k = scan.width / f.w;               // original page px -> scan px
        var r = Math.max(1.4, 6 * k);           // the batch overlay used r=6 at full size
        [['em', 'rgb(235,60,60)'], ['ab', 'rgb(40,160,40)']].forEach(function (pair) {
          var c = d[pair[0]];
          if (!c || !c.wl) return;
          g.fillStyle = pair[1];
          for (var i = 0; i < c.wl.length; i += 2) {
            var wn = 1e7 / c.wl[i];
            var px = (wn - d.xcal.b) / d.xcal.a;
            var py = f.y_bottom - (c.inten[i]) * (f.y_bottom - f.y_top);
            var x = px * k, y = py * k;
            if (x < -20 || y < -20 || x > cv.width + 20 || y > cv.height + 20) continue;
            g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
          }
        });
        cv.title = (index[gid] ? 'Community edit' : 'Published digitization') +
                   ' replotted on the raw scan';
      };
      scan.onerror = function () { /* no scan -> the shipped PNG stays visible */ };
      scan.src = 'scans/' + gid + '.webp';
    });
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
    drawOverlay(id);
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
