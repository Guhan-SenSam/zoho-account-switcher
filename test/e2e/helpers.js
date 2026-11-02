// Shared E2E harness: launches Playwright's *bundled* Chromium (never the user's
// Google Chrome / profile) with a fresh temp user-data-dir, the extension loaded,
// and *.zoho.com resolved to the local fake Zoho server.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeZoho } from './fake-zoho/server.js';

export const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// E2E_EXT_DIR lets the suite run against a copy (e.g. mutation checks in .tmp).
export const EXT_DIR = process.env.E2E_EXT_DIR ? path.resolve(process.env.E2E_EXT_DIR) : path.join(REPO, 'extension');
export const TMP = path.join(REPO, 'test', 'e2e', '.tmp');
export const MAIL = 'https://mail.zoho.com/';
export const SIGN_IN = 'https://accounts.zoho.com/signin';
export const WHOAMI = 'https://accounts.zoho.com/accounts/whoami';

const HEADED = !!process.env.E2E_HEADED;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn() until it returns a truthy value; returns that value. */
export async function pollUntil(fn, { timeout = 10_000, interval = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${message}` +
    (lastErr ? ` (last error: ${lastErr.message})` : '') +
    (last !== undefined ? ` (last value: ${JSON.stringify(last)})` : ''));
}

export function makeUserDataDir(label = 'profile') {
  fs.mkdirSync(TMP, { recursive: true });
  return fs.mkdtempSync(path.join(TMP, `${label}-`));
}

function assertSafeLaunch(userDataDir) {
  const exe = chromium.executablePath();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  assert.ok(exe.startsWith(cache), `refusing to launch non-Playwright browser: ${exe}`);
  assert.ok(!/google-chrome/.test(exe), `refusing to launch Google Chrome: ${exe}`);
  const resolved = path.resolve(userDataDir);
  assert.ok(resolved.startsWith(TMP + path.sep) || resolved.startsWith(os.tmpdir() + path.sep),
    `refusing to use user-data-dir outside the scratch dir: ${resolved}`);
  assert.ok(!resolved.includes('.config/google-chrome'), 'refusing to touch the real Chrome profile');
}

/**
 * Launch Chromium with the extension. Returns a harness object:
 *   { context, extensionId, userDataDir, port, driver(), send(msg), swEval(fn,arg), close() }
 */
export async function launchBrowser({ extDir = EXT_DIR, port, userDataDir = makeUserDataDir() } = {}) {
  assertSafeLaunch(userDataDir);
  const target = `127.0.0.1:${port}`;
  const resolverRules = [
    `MAP *.zoho.com ${target}`,
    `MAP zoho.com ${target}`,
    `MAP *.zoho.in ${target}`,
    `MAP zoho.in ${target}`,
    // Everything else (other Zoho DCs, Google services, ...) fails to resolve: hermetic.
    'MAP * ~NOTFOUND',
  ].join(',');

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // full Chromium in new headless mode: supports extensions
    headless: !HEADED,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      `--host-resolver-rules=${resolverRules}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;
  const extOrigin = `chrome-extension://${extensionId}/`;

  let driverPage = null;
  const h = {
    context,
    extensionId,
    extOrigin,
    userDataDir,
    port,

    /** An extension page (popup.html opened as a tab) used to drive the message protocol. */
    async driver() {
      if (driverPage && !driverPage.isClosed()) return driverPage;
      driverPage = await context.newPage();
      // popup.js may call window.close() after actions; keep the driver tab alive.
      await driverPage.addInitScript(() => { window.close = () => {}; });
      await driverPage.goto(`${extOrigin}popup/popup.html`);
      return driverPage;
    },

    /** chrome.runtime.sendMessage(msg) from an extension page; returns the response. */
    async send(msg) {
      const p = await h.driver();
      return p.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    },

    /** Like send() but asserts ok:true and returns the response. */
    async sendOk(msg) {
      const r = await h.send(msg);
      assert.ok(r && r.ok === true, `${msg.type} failed: ${JSON.stringify(r)}`);
      return r;
    },

    /** The extension's current service worker (it may have been restarted). */
    async serviceWorker() {
      const live = context.serviceWorkers().find((w) => w.url().startsWith(extOrigin));
      if (live) return live;
      // Wake it by talking to it from an extension page.
      const wait = context.waitForEvent('serviceworker', { timeout: 10_000 });
      await h.send({ type: 'getState' }).catch(() => {});
      return wait;
    },

    /** Evaluate in the extension service worker (falls back to an extension page). */
    async swEval(fn, arg) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const w = await h.serviceWorker();
          return await w.evaluate(fn, arg);
        } catch (err) {
          if (attempt === 2) {
            const p = await h.driver();
            return p.evaluate(fn, arg);
          }
          await sleep(200);
        }
      }
      throw new Error('unreachable');
    },

    storage(keys = null) {
      return h.swEval((k) => chrome.storage.local.get(k), keys);
    },

    /** All cookies the extension can see for zoho.com (host-only and domain cookies). */
    cookies(domain = 'zoho.com') {
      return h.swEval((d) => chrome.cookies.getAll({ domain: d }), domain);
    },

    /** Drop the cached driver page (e.g. after the extension was reloaded). */
    async resetDriver() {
      if (driverPage && !driverPage.isClosed()) await driverPage.close().catch(() => {});
      driverPage = null;
    },

    /** chrome.extension.isAllowedIncognitoAccess() as seen by the extension. */
    incognitoAllowed() {
      return h.swEval(() => chrome.extension.isAllowedIncognitoAccess());
    },

    /**
     * Turn on "Allow in Incognito" for the extension, like the user would on
     * chrome://extensions. An extension loaded with --load-extension is not allowed
     * in Incognito by default and there is no command-line switch for it, so this
     * calls chrome.developerPrivate (the API behind chrome://extensions) from a
     * chrome://extensions page in this same browser.
     *
     * Toggling Incognito access reloads the extension. Chromium disables a reloaded
     * unpacked extension as "unsupportedDeveloperExtension" unless developer mode is
     * on, so developer mode is switched on first. After the reload the service
     * worker and every extension page are new: the cached driver page is dropped
     * and the call waits until the new service worker reports Incognito access.
     */
    async enableIncognito() {
      const page = await context.newPage();
      try {
        await page.goto('chrome://extensions/');
        await page.evaluate(async (id) => {
          await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
          await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true });
        }, extensionId);
        const info = await pollUntil(async () => {
          const i = await page.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), extensionId);
          return i.state === 'ENABLED' && i.incognitoAccess?.isActive ? i : null;
        }, { message: 'extension re-enabled with Incognito access (chrome://extensions)' });
        assert.equal(info.incognitoAccess.isEnabled, true, 'Incognito access can be enabled (manifest "incognito" is not "not_allowed")');
      } finally {
        await page.close().catch(() => {});
      }
      await h.resetDriver();
      await pollUntil(() => h.incognitoAllowed().catch(() => false),
        { message: 'service worker reports isAllowedIncognitoAccess() === true' });
      await h.driver();
    },

    async close() {
      await context.close().catch(() => {});
    },
  };
  return h;
}

/** Fresh fake server + fresh browser profile. Caller must call env.close(). */
export async function setup({ extDir = EXT_DIR } = {}) {
  const server = await startFakeZoho({ certDir: path.join(TMP, 'cert') });
  let browser;
  try {
    browser = await launchBrowser({ extDir, port: server.port });
  } catch (err) {
    await server.close();
    throw err;
  }
  const env = {
    server,
    browser,
    async close({ keepProfile = false } = {}) {
      // env.browser may have been replaced by a relaunch (restart tests).
      await env.browser.close();
      await server.close();
      if (!keepProfile) fs.rmSync(env.browser.userDataDir, { recursive: true, force: true });
    },
    /** Recent server log lines for assertion messages. */
    diag(n = 15) {
      return '\n--- fake zoho log (latest last) ---\n' + server.log.slice(-n).map((e) =>
        `${e.method} ${e.host}${e.path} -> ${e.result}  cookies=[${Object.keys(e.cookies).join(',')}]` +
        (e.cookies._iambdt ? ` bdt=${e.cookies._iambdt.slice(0, 12)}` : '')).join('\n');
    },
  };
  return env;
}

/** Find (or wait for) a page whose URL satisfies pred (optionally ignoring pages in `exclude`). */
export async function waitForPage(context, pred, { timeout = 10_000, message = 'page', exclude = null } = {}) {
  return pollUntil(() => context.pages().find((p) =>
    !p.isClosed() && !(exclude && exclude.has(p)) && pred(p.url())), { timeout, message });
}

/** Read #who / #serial / #ss / #ls from a fake Zoho page once its inline script ran. */
export async function readPage(page) {
  await page.waitForSelector('body[data-ready="true"], #who', { timeout: 10_000 });
  return page.evaluate(() => ({
    who: document.getElementById('who')?.textContent ?? null,
    serial: document.getElementById('serial')?.textContent ?? null,
    ss: document.getElementById('ss')?.textContent ?? null,
    ls: document.getElementById('ls')?.textContent ?? null,
    reason: document.getElementById('reason')?.textContent ?? null,
    url: location.href,
  }));
}

/** Who a page currently shows. */
export async function who(page) {
  return (await readPage(page)).who;
}

/** Wait until a fake Zoho page has been re-rendered (its #serial changed) and return its new state. */
export async function waitForRerender(page, prevSerial, { timeout = 10_000 } = {}) {
  return pollUntil(async () => {
    const s = await readPage(page).catch(() => null);
    return s && s.serial !== null && s.serial !== prevSerial && s.who !== null ? s : null;
  }, { timeout, message: `page ${page.url()} to re-render (serial != ${prevSerial})` });
}

/** Open a new tab at https://mail.zoho.com/ and return { page, state }. */
export async function openMail(context) {
  const page = await context.newPage();
  await page.goto(MAIL);
  return { page, state: await readPage(page) };
}

/** Submit the fake sign-in form on a page at accounts.zoho.com/signin; returns the mail page state. */
export async function submitSignIn(page, username) {
  await page.waitForSelector('#username');
  await page.fill('#username', username);
  await Promise.all([
    page.waitForURL(MAIL, { timeout: 10_000 }),
    page.click('#signin-submit'),
  ]);
  return readPage(page);
}

/**
 * Full "add account" flow over the protocol: beginAdd -> sign in on the opened tab -> finishAdd.
 * Returns { state, account, signInPage }. The sign-in tab (now on mail) is closed unless keepTab.
 */
export async function addAccount(b, { username, name, keepTab = false }) {
  const before = new Set(b.context.pages());
  const begin = await b.sendOk({ type: 'beginAdd' });
  assert.ok(begin.state.pending, `beginAdd sets pending: ${JSON.stringify(begin.state)}`);
  assert.equal(begin.state.activeId, null, 'beginAdd clears activeId');
  const signInPage = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN),
    { message: `new sign-in tab at ${SIGN_IN}`, exclude: before });
  const mailState = await submitSignIn(signInPage, username);
  assert.equal(mailState.who, username, `sign-in as ${username} landed on mail`);
  const r = await b.sendOk({ type: 'finishAdd', name });
  const account = r.state.accounts.find((a) => a.name === name);
  assert.ok(account, `finishAdd returned state containing ${name}: ${JSON.stringify(r.state)}`);
  assert.equal(r.state.activeId, account.id, `${name} is active after finishAdd`);
  assert.equal(r.state.pending, null, 'pending cleared after finishAdd');
  if (!keepTab) await signInPage.close();
  return { state: r.state, account, signInPage };
}

/** Saved cookies for an account from chrome.storage.local. */
export async function savedCookies(b, id) {
  const { accounts } = await b.storage('accounts');
  return accounts?.[id]?.cookies ?? null;
}

export function cookieValue(list, name) {
  return list?.find((c) => c.name === name)?.value ?? null;
}

/** Wait until no op is running in the extension (state.busy false). */
export async function waitIdle(b, timeout = 10_000) {
  return pollUntil(async () => {
    const r = await b.send({ type: 'getState' });
    return r?.state && !r.state.busy ? r.state : null;
  }, { timeout, message: 'extension idle' });
}

/** True if the real extension looks complete enough to run against. */
export function extensionPresent(dir = EXT_DIR) {
  const need = ['manifest.json', 'background.js', 'popup/popup.html'];
  return need.every((f) => fs.existsSync(path.join(dir, f)));
}

// ---------------------------------------------------------------------------
// Incognito ("private window") helpers.
//
// Incognito tabs live in Chromium's off-the-record profile; tests do not rely on
// Playwright exposing them. Everything below goes through the extension's own
// service worker (chrome.windows / chrome.tabs / chrome.scripting / chrome.cookies
// with an explicit storeId), which works once the extension is allowed in
// Incognito (b.enableIncognito()).

export const REGULAR_STORE_ID = '0';
export const ZOHO_TEST_DOMAINS = ['zoho.com', 'zoho.in'];

/** chrome.windows.getAll() summarised: [{ id, incognito, type }]. */
export function allWindows(b) {
  return b.swEval(async () => (await chrome.windows.getAll({ populate: false }))
    .map((w) => ({ id: w.id, incognito: w.incognito, type: w.type })));
}

/** Ids of the open Incognito windows. */
export async function incognitoWindowIds(b) {
  return (await allWindows(b)).filter((w) => w.incognito).map((w) => w.id);
}

/** chrome.cookies.getAllCookieStores(): [{ id, tabIds }]. */
export function cookieStores(b) {
  return b.swEval(() => chrome.cookies.getAllCookieStores());
}

/**
 * Zoho cookies (zoho.com + zoho.in) in a cookie store, or null if that store no
 * longer exists (an off-the-record store disappears with the last Incognito window).
 */
export function storeCookies(b, storeId, domains = ZOHO_TEST_DOMAINS) {
  return b.swEval(async ({ storeId, domains }) => {
    const stores = await chrome.cookies.getAllCookieStores();
    if (!stores.some((s) => s.id === storeId)) return null;
    const out = [];
    for (const domain of domains) out.push(...await chrome.cookies.getAll({ domain, storeId }));
    return out;
  }, { storeId, domains });
}

/** Stable fingerprint of the regular store's Zoho cookies (name/domain/path=value). */
export async function regularJar(b) {
  const list = (await storeCookies(b, REGULAR_STORE_ID)) ?? [];
  return list.map((c) => `${c.name}|${c.domain}|${c.path}=${c.value}`).sort();
}

/** The cookie store that holds a tab (by tabId). */
export async function storeOfTab(b, tabId) {
  const stores = await cookieStores(b);
  return stores.find((s) => s.tabIds.includes(tabId))?.id ?? null;
}

/** Open an Incognito window from the service worker (as the test, not the extension). */
export function openIncognitoWindow(b, url) {
  return b.swEval(async (u) => {
    const w = await chrome.windows.create({ incognito: true, focused: false, ...(u ? { url: u } : {}) });
    return { windowId: w.id, tabId: w.tabs?.[0]?.id ?? null };
  }, url);
}

/** Close a window from the service worker; true if it existed. */
export function closeWindow(b, windowId) {
  return b.swEval(async (id) => {
    try { await chrome.windows.remove(id); return true; } catch { return false; }
  }, windowId);
}

/** The first tab of a window once it has finished loading a URL starting with `prefix`. */
export function waitForTabInWindow(b, windowId, prefix, { timeout = 10_000 } = {}) {
  return pollUntil(() => b.swEval(async ({ windowId, prefix }) => {
    const tabs = await chrome.tabs.query({ windowId });
    const t = tabs.find((x) => (x.url ?? '').startsWith(prefix));
    return t && t.status === 'complete'
      ? { tabId: t.id, url: t.url, incognito: t.incognito, windowId: t.windowId }
      : null;
  }, { windowId, prefix }), { timeout, message: `tab at ${prefix} in window ${windowId}` });
}

/** Like readPage(), but for any tab (incl. Incognito) via chrome.scripting from the SW. */
export function readTab(b, tabId) {
  return pollUntil(() => b.swEval(async (id) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => (document.body?.dataset.ready === 'true' || document.getElementById('who')
        ? {
          who: document.getElementById('who')?.textContent ?? null,
          serial: document.getElementById('serial')?.textContent ?? null,
          ss: document.getElementById('ss')?.textContent ?? null,
          ls: document.getElementById('ls')?.textContent ?? null,
          reason: document.getElementById('reason')?.textContent ?? null,
          url: location.href,
        }
        : null),
    });
    return r?.result ?? null;
  }, tabId), { message: `fake Zoho page rendered in tab ${tabId}` });
}

/**
 * Sign in on the fake Zoho form in a tab of `windowId` (typically the extension's
 * private window), driven from the service worker. Returns
 * { tabId, storeId, incognito, mail } where mail is the landing page's readTab().
 */
export async function signInInWindow(b, windowId, username) {
  const tab = await waitForTabInWindow(b, windowId, SIGN_IN);
  const title = await b.swEval(async ({ tabId, username }) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [username],
      func: (u) => {
        const t = document.getElementById('signin-title')?.textContent ?? null;
        if (!t) return null;
        document.getElementById('username').value = u;
        document.getElementById('signin-form').submit();
        return t;
      },
    });
    return r?.result ?? null;
  }, { tabId: tab.tabId, username });
  assert.equal(title, 'Sign in to Zoho', `sign-in form shown in window ${windowId}`);
  await pollUntil(() => b.swEval(async ({ id, mail }) => {
    const t = await chrome.tabs.get(id);
    return t.status === 'complete' && (t.url ?? '').startsWith(mail);
  }, { id: tab.tabId, mail: MAIL }), { message: `tab ${tab.tabId} in window ${windowId} to land on ${MAIL} after signing in as ${username}` });
  const mail = await readTab(b, tab.tabId);
  return { tabId: tab.tabId, incognito: tab.incognito, storeId: await storeOfTab(b, tab.tabId), mail };
}
