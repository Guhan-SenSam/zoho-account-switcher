// Fake Zoho: a tiny HTTPS server that imitates the parts of Zoho's sign-in and
// session behaviour the account switcher depends on. It never talks to the
// real Zoho; Chromium is pointed at it with --host-resolver-rules.
//
// Cookies issued (shapes modelled on real Zoho):
//   accounts.zoho.com POST /signin
//     _iamadt     Domain=.zoho.com; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=30d  (persistent auth token)
//     _iambdt     Domain=.zoho.com; Path=/; Secure; HttpOnly; SameSite=None               (session cookie, ROTATES)
//     iamcsr      host-only accounts.zoho.com; Path=/; Secure; SameSite=Strict
//     JSESSIONID  host-only accounts.zoho.com; Path=/accounts; Secure; HttpOnly
//   mail.zoho.com GET /   (when authenticated)
//     __Host-zmcsr  host-only; Path=/; Secure; SameSite=Lax
//     _iambdt       rotated: new value issued, old value invalidated server-side
//
// Authentication is by exact token value: mail.zoho.com needs an _iamadt that maps
// to a live session AND that session's *current* _iambdt. A snapshot taken before
// a rotation therefore no longer authenticates.

import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Generate (once per directory) a self-signed cert for zoho.com / *.zoho.com / *.zoho.in. */
export function ensureCert(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-zoho-cert-'))) {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-days', '7', '-subj', '/CN=zoho.com',
      '-addext', 'subjectAltName=DNS:zoho.com,DNS:*.zoho.com,DNS:zoho.in,DNS:*.zoho.in',
      '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'pipe' });
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), dir };
}

const token = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>${body}</body></html>`;
}

// Inline script on mail pages: report whether a marker from a previous load of this
// origin survived in sessionStorage / localStorage, then (re)set the markers.
const STORAGE_PROBE = `<p id="ss">?</p><p id="ls">?</p>
<script>
  document.getElementById('ss').textContent = sessionStorage.getItem('fz-marker') ? 'present' : 'absent';
  document.getElementById('ls').textContent = localStorage.getItem('fz-marker') ? 'present' : 'absent';
  sessionStorage.setItem('fz-marker', String(Date.now()));
  localStorage.setItem('fz-marker', String(Date.now()));
  document.body.dataset.ready = 'true';
</script>`;

/**
 * Start the fake Zoho server on 127.0.0.1:<random port>.
 * Returns { port, close(), sessions, log, signIn(username) }.
 */
export async function startFakeZoho({ certDir } = {}) {
  const { key, cert } = ensureCert(certDir);

  // Server-side session store.
  const sessions = new Map();   // _iamadt value -> { user, adt, bdt, jsessionid, iamcsr, retiredBdts: [] }
  const byJsession = new Map(); // JSESSIONID -> session
  const log = [];
  let serial = 0;

  function createSession(user) {
    const s = {
      user,
      adt: token('adt-'),
      bdt: token('bdt-'),
      jsessionid: token('js-'),
      iamcsr: token('csr-'),
      retiredBdts: [],
      rotations: 0,
    };
    sessions.set(s.adt, s);
    byJsession.set(s.jsessionid, s);
    return s;
  }

  /** Who do these cookies authenticate as on mail? -> { session } | { reason } */
  function authenticate(cookies) {
    if (!cookies._iamadt) return { reason: 'no _iamadt cookie' };
    const s = sessions.get(cookies._iamadt);
    if (!s) return { reason: 'unknown _iamadt' };
    if (!cookies._iambdt) return { reason: `no _iambdt cookie (adt belongs to ${s.user})` };
    if (cookies._iambdt !== s.bdt) {
      const stale = s.retiredBdts.includes(cookies._iambdt);
      return { reason: `${stale ? 'stale (rotated-out)' : 'unknown'} _iambdt for ${s.user}` };
    }
    return { session: s };
  }

  function setCookie(res, c) {
    const prev = res.getHeader('Set-Cookie') ?? [];
    res.setHeader('Set-Cookie', [...prev, c]);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (d) => { data += d; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  function send(res, status, html, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(html);
  }

  async function handle(req, res) {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const url = new URL(req.url, `https://${host}`);
    const cookies = parseCookies(req.headers.cookie);
    const entry = { at: Date.now(), method: req.method, host, path: url.pathname, cookies, result: '' };
    log.push(entry);

    // Test hook on any Zoho host: set one extra host-only cookie, e.g.
    //   https://crm.zoho.com/crm/set-extra?name=CRMCSR&value=x&path=/crm&secure=1
    if (url.pathname.endsWith('/set-extra')) {
      const name = url.searchParams.get('name');
      const value = url.searchParams.get('value') ?? token('x-');
      const p = url.searchParams.get('path') ?? '/';
      const secure = url.searchParams.get('secure') !== '0';
      setCookie(res, `${name}=${value}; Path=${p}${secure ? '; Secure' : ''}`);
      entry.result = `set-extra:${name}`;
      return send(res, 200, page('extra', `<p id="extra">${escapeHtml(name)}=${escapeHtml(value)}</p>`));
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      entry.result = '404';
      return;
    }

    if (host === 'accounts.zoho.com') {
      if (url.pathname === '/signin' && req.method === 'GET') {
        entry.result = 'signin-form';
        return send(res, 200, page('Zoho Accounts - Sign in', `
<h1 id="signin-title">Sign in to Zoho</h1>
<form id="signin-form" method="POST" action="/signin">
  <label>Email or mobile <input id="username" name="username" autocomplete="off"></label>
  <button id="signin-submit" type="submit">Sign in</button>
</form>`));
      }
      if (url.pathname === '/signin' && req.method === 'POST') {
        const body = new URLSearchParams(await readBody(req));
        const user = (body.get('username') ?? '').trim();
        if (!user) {
          entry.result = 'signin-missing-username';
          return send(res, 400, page('Error', '<h1 id="error">username required</h1>'));
        }
        const s = createSession(user);
        setCookie(res, `_iamadt=${s.adt}; Domain=.zoho.com; Path=/; Max-Age=${THIRTY_DAYS}; Secure; HttpOnly; SameSite=None`);
        setCookie(res, `_iambdt=${s.bdt}; Domain=.zoho.com; Path=/; Secure; HttpOnly; SameSite=None`);
        setCookie(res, `iamcsr=${s.iamcsr}; Path=/; Secure; SameSite=Strict`);
        setCookie(res, `JSESSIONID=${s.jsessionid}; Path=/accounts; Secure; HttpOnly`);
        entry.result = `signed-in:${user}`;
        res.writeHead(302, { Location: 'https://mail.zoho.com/', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      // Test hook: the jar goes "signed out" (auth cookies expired) WITHOUT killing the
      // server-side session, e.g. cookies cleared by something other than the switcher.
      if (url.pathname === '/test/expire-auth') {
        setCookie(res, '_iamadt=; Domain=.zoho.com; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None');
        setCookie(res, '_iambdt=; Domain=.zoho.com; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None');
        setCookie(res, 'iamcsr=; Path=/; Max-Age=0; Secure; SameSite=Strict');
        setCookie(res, 'JSESSIONID=; Path=/accounts; Max-Age=0; Secure; HttpOnly');
        entry.result = 'expire-auth';
        return send(res, 200, page('expired', '<h1 id="expired">auth cookies expired</h1>'));
      }
      // Path-scoped, host-only cookie check: JSESSIONID is only sent to /accounts/*.
      if (url.pathname === '/accounts/whoami') {
        const s = byJsession.get(cookies.JSESSIONID);
        const ok = s && cookies.iamcsr === s.iamcsr && sessions.get(cookies._iamadt) === s;
        entry.result = ok ? `whoami:${s.user}` : 'whoami:signed-out';
        return send(res, 200, page('whoami', `<h1 id="who">${escapeHtml(ok ? s.user : 'signed-out')}</h1>`));
      }
      entry.result = '404';
      return send(res, 404, page('Not found', '<h1>not found</h1>'));
    }

    if (host === 'mail.zoho.com') {
      if (url.pathname !== '/') {
        entry.result = '404';
        return send(res, 404, page('Not found', '<h1>not found</h1>'));
      }
      const n = ++serial;
      const auth = authenticate(cookies);
      if (!auth.session) {
        entry.result = `mail:signed-out (${auth.reason})`;
        return send(res, 200, page('Zoho Mail - signed out', `
<h1 id="who">signed-out</h1><p id="reason">${escapeHtml(auth.reason)}</p><p id="serial">${n}</p>
<a href="https://accounts.zoho.com/signin">Sign in</a>${STORAGE_PROBE}`));
      }
      const s = auth.session;
      // Rotate the session token, invalidating the old one.
      s.retiredBdts.push(s.bdt);
      s.bdt = token('bdt-');
      s.rotations++;
      setCookie(res, `_iambdt=${s.bdt}; Domain=.zoho.com; Path=/; Secure; HttpOnly; SameSite=None`);
      setCookie(res, `__Host-zmcsr=${token('zm-')}; Path=/; Secure; SameSite=Lax`);
      entry.result = `mail:${s.user}`;
      // Optional latency between the server-side rotation and the response reaching the browser.
      if (api.mailDelayMs > 0) await new Promise((r) => setTimeout(r, api.mailDelayMs));
      return send(res, 200, page(`Zoho Mail - ${s.user}`, `
<h1 id="who">${escapeHtml(s.user)}</h1><p id="serial">${n}</p>${STORAGE_PROBE}`));
    }

    entry.result = 'unknown-host';
    return send(res, 404, page('Unknown host', `<h1>unknown host ${escapeHtml(host)}</h1>`));
  }

  const server = https.createServer({ key, cert }, (req, res) => {
    handle(req, res).catch((err) => {
      try { send(res, 500, page('Error', `<pre>${escapeHtml(err.stack)}</pre>`)); } catch { /* ignore */ }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const api = {
    port,
    sessions,
    log,
    /** Delay (ms) for authenticated mail responses, applied AFTER the token rotation. */
    mailDelayMs: 0,
    /** Current server-side session for a user (latest sign-in). */
    sessionFor(user) {
      return [...sessions.values()].filter((s) => s.user === user).at(-1) ?? null;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}

// Allow `node test/e2e/fake-zoho/server.js` for manual poking.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fz = await startFakeZoho();
  console.log(`fake zoho on https://127.0.0.1:${fz.port}`);
}
