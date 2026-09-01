/* Passcode gate for the whole deployment.
 *
 * The plates are scans of a copyrighted 1971 handbook, so the site is not for
 * open indexing: every request, pages and scans and overlays and downloads and
 * the API alike, passes through here first, and without the cookie nothing
 * downstream is reachable.  The check runs at the edge before the filesystem is
 * consulted, so a direct link to a .webp is gated the same as the viewer that
 * shows it.
 *
 * build_api.py copies this into .vercel/output/functions/_middleware.func/ on
 * every build.  It lived only in that output directory once, and the next build
 * deleted it and shipped an ungated site.
 */
const COOKIE = 'sw_gate';
const MAX_AGE = 60 * 60 * 24 * 30;   // a month, then ask again
const PASSCODE = (globalThis.process && process.env && process.env.SITE_PASSCODE) || '98300';

// The cookie holds a digest, not the passcode, so a copied cookie does not
// hand over the code itself.
async function token() {
  const bytes = new TextEncoder().encode('spectrawolf ' + PASSCODE);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function cookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// only ever redirect back into this site
function safePath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

function gatePage(to, wrong) {
  const esc = String(to).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="robots" content="noindex,nofollow">' +
'<title>SpectraWolf</title>' +
'<style>' +
':root { color-scheme: dark; }' +
'* { box-sizing: border-box; }' +
'body { margin:0; min-height:100vh; display:grid; place-items:center;' +
' background:#000; color:#fff;' +
' font:15px/1.5 ui-sans-serif,-apple-system,Helvetica,Arial,sans-serif; }' +
'main { width:min(92vw,380px); }' +
'h1 { font-size:19px; font-weight:600; letter-spacing:.14em;' +
' text-transform:uppercase; margin:0 0 6px; }' +
'p { margin:0 0 22px; color:#9aa0a6; font-size:13px; }' +
'form { display:flex; gap:8px; }' +
'input[name=code] { flex:1; padding:11px 13px; border:1px solid #3a3a3a;' +
' border-radius:6px; background:#111; color:#fff; font:inherit; letter-spacing:.28em; }' +
'input[name=code]:focus { outline:none; border-color:#fff; }' +
'button { padding:11px 18px; border:1px solid #fff; border-radius:6px;' +
' background:#fff; color:#000; font:inherit; font-weight:600; cursor:pointer; }' +
'button:hover { background:#ddd; }' +
'.err { margin:14px 0 0; color:#ff6b6b; font-size:13px; }' +
'.note { margin:26px 0 0; color:#6b7075; font-size:11.5px; line-height:1.6; }' +
'</style></head><body><main>' +
'<h1>SpectraWolf</h1>' +
'<p>Enter the passcode to continue.</p>' +
'<form method="POST" action="' + esc + '">' +
'<input name="code" type="password" inputmode="numeric" autocomplete="off" autofocus aria-label="Passcode">' +
'<input name="to" type="hidden" value="' + esc + '">' +
'<button type="submit">Enter</button>' +
'</form>' +
(wrong ? '<p class="err">Not that one. Try again.</p>' : '') +
'<p class="note">Digitized from Berlman, Handbook of Fluorescence Spectra of ' +
'Aromatic Molecules, 2nd ed. (Academic Press, 1971). Page images are reproduced ' +
'for verification only and are not licensed for redistribution.</p>' +
'</main></body></html>';
  return new Response(html, {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const want = await token();

  if (cookieValue(request.headers.get('cookie'), COOKIE) === want) {
    return new Response(null, { headers: { 'x-middleware-next': '1' } });
  }

  if (request.method === 'POST') {
    let code = '';
    let to = url.pathname + url.search;
    try {
      const form = await request.formData();
      code = String(form.get('code') || '').trim();
      to = safePath(String(form.get('to') || to));
    } catch (err) { /* not a form post, fall through to the gate */ }
    if (code && code === PASSCODE) {
      return new Response(null, {
        status: 303,
        headers: {
          location: to,
          'cache-control': 'no-store',
          'set-cookie': COOKIE + '=' + want + '; Path=/; Max-Age=' + MAX_AGE +
                        '; HttpOnly; Secure; SameSite=Lax',
        },
      });
    }
    return gatePage(to, Boolean(code));
  }

  return gatePage(safePath(url.pathname + url.search), false);
}

export const config = { matcher: '/:path*' };
