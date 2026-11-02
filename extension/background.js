// Service worker (module). Wires the lib modules to the real chrome.* APIs.
// All listeners are registered synchronously at top level, as MV3 requires.

import { createCookieJar } from './lib/cookie-jar.js';
import { createAccountStore } from './lib/accounts.js';
import { createSiteData } from './lib/site-data.js';
import { createBadge } from './lib/badge.js';
import { createSwitcher } from './lib/switcher.js';
import { createRouter, createCookieSyncScheduler } from './lib/router.js';

const jar = createCookieJar(chrome.cookies);
const store = createAccountStore(chrome.storage.local);
const siteData = createSiteData(chrome);
const badge = createBadge(chrome.action);
const switcher = createSwitcher({ jar, store, siteData, badge });
const router = createRouter({ switcher, store, extensionUrl: chrome.runtime.getURL('') });
const cookieSync = createCookieSyncScheduler({ switcher });

const logError = (what) => (err) => console.error(`Zoho Account Switcher: ${what} failed`, err);

// Browser restart: session cookies are gone; put the active account's back.
chrome.runtime.onStartup.addListener(() => {
  switcher.restoreActiveOnStartup().catch(logError('startup restore'));
});

chrome.runtime.onInstalled.addListener(() => {
  switcher.refreshBadge().catch(logError('badge refresh'));
});

// Keep the active account's saved snapshot current (cookie rotation etc.).
chrome.cookies.onChanged.addListener((changeInfo) => {
  cookieSync.onCookieChanged(changeInfo);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  router.handle(message, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: err?.message || String(err), state: null });
  });
  return true; // respond asynchronously
});

// Service worker (re)start.
switcher.refreshBadge().catch(logError('badge refresh'));
