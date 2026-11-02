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

// ---------------------------------------------------------------------------
// Optional "pretty" rendering (scripts/record-demo.mjs). Off by default: the E2E
// suite always gets the bare markup above. Pretty pages are a neutral, generic
// webmail mock (not Zoho's design) and keep the same hooks the helpers read:
// #who, #serial, #reason, the storage probe and body[data-ready].

const PRETTY_COLORS = ['#1565c0', '#c62828', '#2e7d32', '#6a1b9a', '#bf360c', '#00695c'];
const GENERIC_INBOX = [
  { from: 'Team updates', subject: 'Weekly summary', snippet: 'Three things shipped, one in review', time: '9:12 AM', unread: true },
  { from: 'Calendar', subject: 'Reminder: planning at 2 pm', snippet: 'Room 4 · 30 minutes', time: '8:30 AM' },
  { from: 'Support', subject: 'Your ticket was resolved', snippet: 'Let us know if anything else comes up', time: 'Mon' },
];

function prettyProfile(user, users = {}) {
  const given = users[user] ?? {};
  const name = given.name ?? user;
  let hash = 0;
  for (const ch of user) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const color = /^#[0-9a-f]{3,8}$/i.test(given.color ?? '') ? given.color : PRETTY_COLORS[hash % PRETTY_COLORS.length];
  const initials = given.initials
    ?? (name.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');
  return { name, email: given.email ?? user, org: given.org ?? '', color, initials, inbox: given.inbox ?? GENERIC_INBOX };
}

const PRETTY_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#f6f7f9;color:#1f2933;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.bar{position:fixed;top:0;left:0;z-index:5;height:3px;width:0;background:#3b6fd8;opacity:0}
body.is-leaving .bar{opacity:1;animation:bar 1.4s cubic-bezier(.2,.7,.3,1) forwards}
@keyframes bar{from{width:0}to{width:88%}}
.top{display:flex;align-items:center;gap:14px;height:52px;padding:0 16px 0 18px;background:#fff;border-bottom:1px solid #e4e7ec}
.brand{display:flex;align-items:center;gap:8px;width:146px;font-weight:650;font-size:15px;color:#334155}
.brand svg{flex:none}
.search{flex:1;display:flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:8px;background:#f1f3f6;color:#8a94a3}
.chip{display:flex;align-items:center;gap:8px;color:#475467;font-size:12px}
.avatar{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;background:var(--c);color:#fff;font-weight:650;font-size:11.5px;letter-spacing:.02em}
.avatar.lg{width:40px;height:40px;font-size:14px}
.wrap{display:flex;height:calc(100% - 52px)}
.side{width:164px;flex:none;padding:14px 10px;border-right:1px solid #e4e7ec;background:#fbfbfc}
.compose{display:flex;align-items:center;justify-content:center;gap:6px;height:34px;margin:0 2px 12px;border-radius:9px;background:#334155;color:#fff;font-weight:600}
.folder{display:flex;justify-content:space-between;padding:6px 10px;border-radius:7px;color:#475467}
.folder.on{background:#e8ecf3;color:#1f2933;font-weight:600}
.count{color:#3b6fd8;font-weight:650}
.main{flex:1;min-width:0;padding:14px 16px 0}
.who{display:flex;align-items:center;gap:12px;padding:10px 12px;margin-bottom:12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff}
.who-label{color:#667085;font-size:11.5px}
.who-email{font-size:15px;font-weight:650;color:#111827}
.who-org{margin-left:auto;padding:3px 9px;border-radius:999px;background:#f1f3f6;color:#475467;font-size:11.5px;font-weight:600}
.list{margin:0;padding:0;list-style:none;border:1px solid #e4e7ec;border-radius:10px;background:#fff;overflow:hidden}
.row{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;border-top:1px solid #eef0f3}
.row:first-child{border-top:0}
.dot{flex:none;width:7px;height:7px;border-radius:50%}
.row.unread .dot{background:#3b6fd8}
.from{flex:none;width:118px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#344054}
.row.unread .from,.row.unread .subj{font-weight:650;color:#111827}
.text{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.snip{color:#8a94a3}
.time{flex:none;color:#8a94a3;font-size:12px}
.row.unread .time{color:#344054;font-weight:600}
.empty{display:grid;place-items:center;height:260px;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;text-align:center;color:#667085}
.empty h2{margin:0 0 6px;color:#1f2933;font-size:16px}
.empty a{color:#3b6fd8;font-weight:600}
.in{animation:in .32s ease-out both}
@keyframes in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
body.is-leaving .main,body.is-leaving .chip{opacity:.5;transition:opacity .15s}
@media (prefers-reduced-motion:reduce){.in{animation:none}}
`;

const ENVELOPE = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="4" width="16" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 5.5l7 5 7-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const MAGNIFIER = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/** Webmail mock. `hooks` = hidden test markers; `profile` null = signed out. */
function prettyMail({ title, hooks, profile }) {
  const esc = escapeHtml;
  const avatar = (cls = '') => `<span class="avatar ${cls}" style="--c:${profile.color}">${esc(profile.initials)}</span>`;
  const unread = profile ? profile.inbox.filter((m) => m.unread).length : 0;
  const folders = [['Inbox', unread || ''], ['Starred', ''], ['Sent', ''], ['Drafts', ''], ['Archive', '']]
    .map(([f, n], i) => `<div class="folder${i === 0 ? ' on' : ''}"><span>${f}</span><span class="count">${n}</span></div>`).join('');
  const main = profile
    ? `<div class="who in">${avatar('lg')}<div><div class="who-label">Signed in as</div>
<div class="who-email">${esc(profile.email)}</div></div>${profile.org ? `<span class="who-org">${esc(profile.org)}</span>` : ''}</div>
<ul class="list">${profile.inbox.map((m, i) => `<li class="row in${m.unread ? ' unread' : ''}" style="animation-delay:${60 + i * 45}ms">
<span class="dot"></span><span class="from">${esc(m.from)}</span>
<span class="text"><span class="subj">${esc(m.subject)}</span><span class="snip"> — ${esc(m.snippet)}</span></span>
<span class="time">${esc(m.time)}</span></li>`).join('')}</ul>`
    : `<div class="empty in"><div><h2>You're signed out</h2><p>Sign in to see your mail.</p>
<a href="https://accounts.zoho.com/signin">Sign in</a></div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${PRETTY_CSS}</style></head><body>
<div class="bar"></div>
<header class="top"><div class="brand">${ENVELOPE}<span>Mail</span></div>
<div class="search">${MAGNIFIER}<span>Search mail</span></div>
<div class="chip">${profile ? `<span>${esc(profile.name)}</span>${avatar()}` : '<span>Not signed in</span>'}</div></header>
<div class="wrap"><nav class="side"><div class="compose">+ Compose</div>${folders}</nav><main class="main">${main}</main></div>
<div hidden>${hooks}${STORAGE_PROBE}</div>
<script>addEventListener('beforeunload', () => document.body.classList.add('is-leaving'));</script>
</body></html>`;
}

/**
 * Start the fake Zoho server on 127.0.0.1:<random port>.
 * Returns { port, close(), sessions, log, signIn(username) }.
 *
 * `pretty` (off by default) renders mail.zoho.com as a styled webmail mock for
 * the README demo: true, or { users: { [username]: { name, email, org, color,
 * initials, inbox: [{ from, subject, snippet, time, unread }] } } }.
 */
export async function startFakeZoho({ certDir, pretty = null } = {}) {
  const { key, cert } = ensureCert(certDir);
  const prettyUsers = (pretty && typeof pretty === 'object' && pretty.users) || {};

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
        if (pretty) {
          return send(res, 200, prettyMail({
            title: 'Mail - signed out',
            hooks: `<h1 id="who">signed-out</h1><p id="reason">${escapeHtml(auth.reason)}</p><p id="serial">${n}</p>`,
            profile: null,
          }));
        }
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
      if (pretty) {
        const profile = prettyProfile(s.user, prettyUsers);
        return send(res, 200, prettyMail({
          title: `Inbox - ${profile.email}`,
          hooks: `<h1 id="who">${escapeHtml(s.user)}</h1><p id="serial">${n}</p>`,
          profile,
        }));
      }
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
