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

  /* Describe how the edit differs from the published curve.  Most real
   * corrections move a handful of points; without this the banner says an
   * edit exists but the chart looks untouched and it reads as "nothing
   * saved". */
  function describeDiff(gid) {
    var d = SPECTRA[gid];
    if (!d || !d._published) return '';
    var bits = [];
    [['em', 'emission'], ['ab', 'absorption']].forEach(function (pair) {
      var P = d._published[pair[0]], E = d[pair[0]];
      if (!P || !E) return;
      var pm = new Map(), removed = [], changed = 0, maxD = 0;
      for (var i = 0; i < P.wl.length; i++) pm.set(P.wl[i].toFixed(1), P.inten[i]);
      var em2 = new Map();
      for (var j = 0; j < E.wl.length; j++) em2.set(E.wl[j].toFixed(1), E.inten[j]);
      pm.forEach(function (v, w) {
        if (!em2.has(w)) removed.push(parseFloat(w));
        else { var dd = Math.abs(em2.get(w) - v); if (dd > 1e-9) { changed++; if (dd > maxD) maxD = dd; } }
      });
      var added = E.wl.length - (P.wl.length - removed.length);
      var part = [];
      if (removed.length) part.push(removed.length + ' removed at ' +
        Math.min.apply(null, removed).toFixed(1) + '–' + Math.max.apply(null, removed).toFixed(1) + ' nm');
      if (added > 0) part.push(added + ' added');
      if (changed) part.push(changed + ' moved, max ' + maxD.toFixed(3));
      if (part.length) bits.push(pair[1] + ': ' + part.join(', '));
    });
    return bits.length ? bits.join(' · ') : 'identical to the published curve';
  }

  function showBanner(gid, meta) {
    var b = banner();
    b.style.display = 'flex';
    b.innerHTML = '';
    var when = meta && meta.ts ? new Date(meta.ts).toLocaleString() : '';
    var who = (meta && meta.author) || 'anonymous';
    var txt = el('span', {});
    txt.style.flex = '1 1 260px';
    txt.appendChild(el('b', {}, 'Community edit by ' + who));
    txt.appendChild(document.createTextNode(
      (when ? ' · ' + when : '') + (meta && meta.note ? ' — ' + meta.note : '')));
    var diff = describeDiff(gid);
    if (diff) {
      var dl = el('div', {}, diff);
      dl.style.cssText = 'font-size:12px;opacity:.85;margin-top:2px;';
      txt.appendChild(dl);
    }
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
    if (dc) {
      dc.href = edited ? '/api/csv?gid=' + gid : 'downloads/csv/' + gid + '.csv';
      dc.textContent = edited ? '⇩ CSV (edited)' : '⇩ CSV';
      dc.title = edited ? 'CSV built from the current community edit' : '';
    }
    var dx = document.getElementById('dlXlsxBtn');
    if (dx) {
      dx.href = edited ? '/api/xlsx?gid=' + gid : 'downloads/xlsx/' + gid + '.xlsx';
      dx.textContent = edited ? '⇩ Excel (edited)' : '⇩ Excel';
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
        function plot(curve, colour, radius) {
          if (!curve || !curve.wl) return;
          g.fillStyle = colour;
          for (var i = 0; i < curve.wl.length; i += 2) {
            var px = (1e7 / curve.wl[i] - d.xcal.b) / d.xcal.a;
            var py = f.y_bottom - curve.inten[i] * (f.y_bottom - f.y_top);
            var x = px * k, y = py * k;
            if (x < -20 || y < -20 || x > cv.width + 20 || y > cv.height + 20) continue;
            g.beginPath(); g.arc(x, y, radius, 0, 6.2832); g.fill();
          }
        }
        // where an edit is showing, lay the published trace underneath in grey:
        // anything the edit removed stays grey, so a small correction is
        // visible instead of looking like nothing happened
        if (d._published && index[gid]) {
          plot(d._published.em, 'rgba(120,120,120,.55)', r * 1.35);
          plot(d._published.ab, 'rgba(120,120,120,.55)', r * 1.35);
        }
        plot(d.em, 'rgb(235,60,60)', r);
        plot(d.ab, 'rgb(40,160,40)', r);
        cv.title = (index[gid] ? 'Community edit (grey = the published trace underneath)'
                                : 'Published digitization') + ' replotted on the raw scan';
        var cap = document.getElementById('overlayCap');
        if (index[gid]) {
          if (!cap) {
            cap = el('div', { id: 'overlayCap' });
            cap.style.cssText = 'font-size:12px;opacity:.8;margin-top:6px;';
            cv.parentNode.insertBefore(cap, cv.nextSibling);
          }
          cap.textContent = 'Grey dots are the published digitization; coloured dots are the community edit.';
          cap.style.display = '';
        } else if (cap) { cap.style.display = 'none'; }
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

  // the sidebar is rebuilt on every search, which wipes the edit markers
  function watchSidebar() {
    var host = document.querySelector('.pcc-compound-list');
    if (!host || host._cwatch) return;
    host._cwatch = true;
    new MutationObserver(function () { markSidebar(); }).observe(host, { childList: true });
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
        watchSidebar();
        if (window._curId) wrapped(window._curId);
      })
      .catch(function () { /* offline or API down — the published site still works */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
