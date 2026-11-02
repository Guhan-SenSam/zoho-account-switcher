// The service worker: wires the lib modules to chrome.* and registers every
// listener. background.js only calls startServiceWorker(chrome); keeping the
// wiring here lets it run against a fake chrome in tests.
//
// The manifest is "incognito": "spanning", so this one worker also sees the
// Incognito profile's cookie changes and tabs. Only the private "Add account"
// flow may act on those; everything else stays on the regular profile
// (cookie changes are routed by storeId, site-data skips Incognito tabs).

import { createCookieJar } from './cookie-jar.js';
import { createAccountStore } from './accounts.js';
import { createSiteData } from './site-data.js';
import { createBadge } from './badge.js';
import { createPrivateWindows } from './private-window.js';
import { createSwitcher } from './switcher.js';
import {
  createRouter, createCookieSyncScheduler, createCookieChangeRouter, CAPTURE_DEBOUNCE_MS,
} from './router.js';

const logError = (what) => (err) => console.error(`Zoho Account Switcher: ${what} failed`, err);

/**
 * Must be called synchronously at the top level of the worker script: MV3
 * only delivers the event that woke the worker to listeners registered in its
 * first turn. `timers` ({ setTimer, clearTimer, now }) and
 * `privateWindowOptions` are for tests. Returns the parts, plus `ready`
 * (start-up work settled).
 */
export function startServiceWorker(chrome = globalThis.chrome, { timers = {}, privateWindowOptions } = {}) {
  const jar = createCookieJar(chrome.cookies);
  const store = createAccountStore(chrome.storage.local);
  const siteData = createSiteData(chrome);
  const badge = createBadge(chrome.action);
  const privateWindows = createPrivateWindows(chrome, privateWindowOptions);
  const switcher = createSwitcher({ jar, store, siteData, badge, privateWindows });
  const router = createRouter({ switcher, store, privateWindows, extensionUrl: chrome.runtime.getURL('') });
  // Regular store: keep the active account's saved snapshot current.
  const cookieSync = createCookieSyncScheduler({ switcher, ...timers });
  // The private add's Incognito store: keep a copy of the new account's cookies.
  const privateCapture = createCookieSyncScheduler({
    switcher,
    run: () => switcher.capturePrivate(),
    label: 'private window capture',
    delay: CAPTURE_DEBOUNCE_MS,
    ...timers,
  });
  const cookieChanges = createCookieChangeRouter({
    sync: cookieSync,
    capture: privateCapture,
    getPending: () => store.getPending(),
  });

  // First thing on the switcher's mutex, so no event handler runs before it: a
  // switch interrupted by a crash left the jar between accounts; finish it.
  const recovered = switcher.recoverInterruptedSwitch().then((r) => {
    if (r?.warnings?.length) console.warn('Zoho Account Switcher: recovered an interrupted switch', r.warnings);
  }, logError('switch recovery'));

  // Browser restart: session cookies are gone; put the active account's back.
  chrome.runtime.onStartup.addListener(() => {
    switcher.restoreActiveOnStartup().catch(logError('startup restore'));
  });

  chrome.runtime.onInstalled.addListener(() => {
    switcher.refreshBadge().catch(logError('badge refresh'));
  });

  chrome.cookies.onChanged.addListener((changeInfo) => {
    cookieChanges.onCookieChanged(changeInfo).catch(logError('cookie change'));
  });

  // The private add's window closing (by the user or by us) keeps the add
  // pending; Save then uses the captured cookies.
  chrome.windows.onRemoved.addListener((windowId) => {
    switcher.privateWindowClosed(windowId).catch(logError('private window close'));
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    router.handle(message, sender).then(sendResponse, (err) => {
      sendResponse({ ok: false, error: err?.message || String(err), state: null });
    });
    return true; // respond asynchronously
  });

  // Service worker (re)start.
  const badgeShown = switcher.refreshBadge().catch(logError('badge refresh'));

  return {
    jar, store, siteData, badge, privateWindows, switcher, router,
    ready: Promise.all([recovered, badgeShown]).then(() => {}),
  };
}
