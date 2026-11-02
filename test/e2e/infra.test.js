// Harness self-check: runs the E2E infrastructure against a tiny dummy MV3
// extension (generated into test/e2e/.tmp), independent of the real extension.
// If these fail, E2E failures elsewhere are harness problems, not extension bugs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  TMP, MAIL, SIGN_IN, WHOAMI, setup, launchBrowser, readPage, submitSignIn, waitForRerender, pollUntil,
} from './helpers.js';

const DUMMY = path.join(TMP, 'dummy-ext');

function writeDummyExtension() {
  fs.rmSync(DUMMY, { recursive: true, force: true });
  fs.mkdirSync(path.join(DUMMY, 'popup'), { recursive: true });
  fs.writeFileSync(path.join(DUMMY, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'E2E dummy',
    version: '1.0.0',
    permissions: ['cookies', 'storage', 'scripting'],
    host_permissions: ['*://*.zoho.com/*', '*://*.zoho.in/*'],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup/popup.html' },
  }, null, 2));
  fs.writeFileSync(path.join(DUMMY, 'popup', 'popup.html'),
    '<!doctype html><html><body><p>dummy popup</p></body></html>');
  fs.writeFileSync(path.join(DUMMY, 'background.js'), `
let chain = Promise.resolve();
function record(type, extra = {}) {
  chain = chain.then(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    events.push({ type, at: Date.now(), ...extra });
    await chrome.storage.local.set({ events });
  });
  return chain;
}
chrome.runtime.onStartup.addListener(() => { record('onStartup'); });
chrome.runtime.onInstalled.addListener((d) => { record('onInstalled', { reason: d.reason }); });
record('sw-start');

const handlers = {
  async cookies() { return chrome.cookies.getAll({ domain: 'zoho.com' }); },
  async removeAll() {
    const all = await chrome.cookies.getAll({ domain: 'zoho.com' });
    for (const c of all) {
      const url = 'https://' + c.domain.replace(/^\\./, '') + c.path;
      await chrome.cookies.remove({ url, name: c.name });
    }
    return all.length;
  },
  async set({ details }) { return chrome.cookies.set(details); },
  async resetTabs() {
    const tabs = await chrome.tabs.query({ url: ['*://*.zoho.com/*'] });
    for (const t of tabs) {
      try { await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => sessionStorage.clear() }); } catch {}
      await chrome.tabs.reload(t.id);
    }
    return tabs.length;
  },
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromExt = (sender.url || '').startsWith(chrome.runtime.getURL(''));
  Promise.resolve(handlers[msg.type]?.(msg))
    .then((result) => sendResponse({ ok: true, result, fromExt }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
`);
}

test('infra: headless extension + fake Zoho + host mapping + cookies', { timeout: 90_000 }, async (t) => {
  writeDummyExtension();
  const env = await setup({ extDir: DUMMY });
  const b = env.browser;
  t.after(() => env.close());

  // Extension loaded headless; id from the service worker URL.
  assert.match(b.extensionId, /^[a-p]{32}$/);
  const resp = await b.send({ type: 'cookies' });
  assert.equal(resp.ok, true);
  assert.equal(resp.fromExt, true, 'sender.url of the driver page is an extension URL');

  // https://accounts.zoho.com/signin (no port) reaches the fake server.
  const page = await b.context.newPage();
  await page.goto(SIGN_IN);
  assert.equal(await page.textContent('#signin-title'), 'Sign in to Zoho');
  assert.equal(page.url(), SIGN_IN, 'URL keeps no explicit port');

  // Hermetic: other hosts do not resolve inside the browser.
  const other = await b.context.newPage();
  await assert.rejects(other.goto('https://example.org/', { timeout: 5000 }), /ERR_NAME_NOT_RESOLVED/);
  await other.close();

  // Sign in: Set-Cookie lands in the cookie store; mail sees the user.
  const st = await submitSignIn(page, 'alice');
  assert.equal(st.who, 'alice');
  assert.equal(st.ss, 'absent');

  // The SW sees every cookie, with the right shapes.
  const cookies = await b.cookies();
  const by = Object.fromEntries(cookies.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(by).sort(), ['JSESSIONID', '__Host-zmcsr', '_iamadt', '_iambdt', 'iamcsr']);
  assert.equal(by._iamadt.domain, '.zoho.com');
  assert.equal(by._iamadt.hostOnly, false);
  assert.equal(by._iamadt.session, false);
  assert.equal(by._iamadt.httpOnly, true);
  assert.equal(by._iamadt.sameSite, 'no_restriction');
  assert.equal(by._iambdt.session, true);
  assert.equal(by.iamcsr.domain, 'accounts.zoho.com');
  assert.equal(by.iamcsr.hostOnly, true);
  assert.equal(by.iamcsr.sameSite, 'strict');
  assert.equal(by.JSESSIONID.path, '/accounts');
  assert.equal(by.JSESSIONID.hostOnly, true);
  assert.equal(by['__Host-zmcsr'].domain, 'mail.zoho.com');
  assert.equal(by['__Host-zmcsr'].hostOnly, true);

  // The server rotated _iambdt on the mail load; the browser holds the new one.
  const sess = env.server.sessionFor('alice');
  assert.equal(sess.rotations, 1);
  assert.equal(by._iambdt.value, sess.bdt);

  // Path-scoped + host-only cookies authenticate /accounts/whoami.
  const who = await b.context.newPage();
  await who.goto(WHOAMI);
  assert.equal(await who.textContent('#who'), 'alice');
  await who.close();

  // sessionStorage marker survives a plain reload ...
  const s1 = await readPage(page);
  await page.reload();
  const s2 = await waitForRerender(page, s1.serial);
  assert.equal(s2.ss, 'present');
  assert.equal(s2.ls, 'present');
  assert.equal(s2.who, 'alice');
  // ... but not executeScript(sessionStorage.clear) + tabs.reload (the mechanism the switcher uses).
  const n = await b.send({ type: 'resetTabs' });
  assert.equal(n.result, 1);
  const s3 = await waitForRerender(page, s2.serial);
  assert.equal(s3.ss, 'absent');
  assert.equal(s3.ls, 'present');

  // Snapshot -> remove all -> mail is signed out -> restore via cookies.set -> alice again.
  const snap = await b.cookies();
  assert.equal((await b.send({ type: 'removeAll' })).result, 5);
  assert.deepEqual(await b.cookies(), []);
  await page.reload();
  const s4 = await readPage(page);
  assert.equal(s4.who, 'signed-out');
  for (const c of snap) {
    const details = {
      url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
      name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (!c.session) details.expirationDate = c.expirationDate;
    const r = await b.send({ type: 'set', details });
    assert.ok(r.result, `cookies.set(${c.name}) succeeded`);
  }
  const restored = Object.fromEntries((await b.cookies()).map((c) => [c.name, c]));
  assert.equal(restored['__Host-zmcsr'].hostOnly, true);
  assert.equal(restored.iamcsr.hostOnly, true);
  assert.equal(restored._iamadt.hostOnly, false);
  await page.reload();
  assert.equal((await readPage(page)).who, 'alice');
});

test('infra: browser restart keeps storage + persistent cookies, drops session cookies', { timeout: 90_000 }, async (t) => {
  writeDummyExtension();
  const env = await setup({ extDir: DUMMY });
  t.after(() => env.close());
  const b = env.browser;
  const page = await b.context.newPage();
  await page.goto(SIGN_IN);
  await submitSignIn(page, 'alice');
  const before = (await b.cookies()).map((c) => c.name).sort();
  assert.ok(before.includes('_iambdt'));
  await b.close();

  const b2 = await launchBrowser({ extDir: DUMMY, port: env.server.port, userDataDir: b.userDataDir });
  env.browser = b2;
  assert.equal(b2.extensionId, b.extensionId, 'same unpacked path -> same extension id');
  const names = (await b2.cookies()).map((c) => c.name).sort();
  assert.ok(names.includes('_iamadt'), `persistent _iamadt survived restart: ${names}`);
  assert.ok(!names.includes('_iambdt'), `session _iambdt dropped on restart: ${names}`);
  const { events } = await pollUntil(async () => {
    const s = await b2.storage('events');
    return s.events?.filter((e) => e.type === 'sw-start').length >= 2 ? s : null;
  }, { message: 'second sw-start event' });
  const types = events.map((e) => e.type + (e.reason ? `:${e.reason}` : ''));
  t.diagnostic(`dummy extension events across restart: ${types.join(', ')}`);
  // Known automation limitation: an extension loaded with --load-extension is re-installed
  // on every launch (onInstalled reason "install") and runtime.onStartup is NOT dispatched.
  // The restart scenario therefore dispatches onStartup itself (see emulateOnStartup); check
  // that this reaches the extension's real listener.
  const fired = types.includes('onStartup');
  t.diagnostic(`runtime.onStartup fired by the browser on relaunch: ${fired}`);
  if (!fired) {
    await b2.swEval(() => chrome.runtime.onStartup.dispatch());
    await pollUntil(async () => (await b2.storage('events')).events?.some((e) => e.type === 'onStartup'),
      { message: 'onStartup listener ran after dispatch()' });
  }
});
