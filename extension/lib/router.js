// Background-side glue kept out of background.js so it can be unit tested:
// the popup → background message router, the cookie-change debounces and the
// routing of cookie changes by cookie store.

import { isZohoCookieDomain, REGULAR_STORE_ID } from './zoho-domains.js';
import { isAnchorCookie } from './session-guard.js';

export const SYNC_DEBOUNCE_MS = 1500;
export const SYNC_MAX_WAIT_MS = 10_000;
export const CAPTURE_DEBOUNCE_MS = 500;

const name = (msg) => (typeof msg.name === 'string' ? msg.name : '');

const isPrivate = (p) => p?.mode === 'private';
const privateNotice = (accountName) => `Saved “${accountName}”. Click it to switch.`;

async function allowed(privateWindows) {
  if (!privateWindows) return false;
  try {
    return (await privateWindows.isAllowed()) === true;
  } catch {
    return false;
  }
}

async function windowOpen(privateWindows, windowId) {
  if (windowId === null || windowId === undefined) return false;
  if (!privateWindows) return true;
  try {
    return (await privateWindows.isOpen(windowId)) === true;
  } catch {
    return true; // can't tell: trust the stored state (windowId is nulled on close)
  }
}

// What the popup needs to know about an add in progress. Never ships cookies
// (stashed, captured) or the private store id.
async function publicPending(p, privateWindows) {
  if (!p) return null;
  const priv = isPrivate(p);
  return {
    previousId: p.previousId ?? null,
    startedAt: p.startedAt,
    mode: priv ? 'private' : 'signout',
    windowOpen: priv ? await windowOpen(privateWindows, p.windowId) : false,
    // Only a real sign-in counts: the sign-in page sets cookies of its own.
    captured: priv && Array.isArray(p.capturedCookies) && p.capturedCookies.some(isAnchorCookie),
  };
}

function settingsPatch(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Invalid settings');
  const clean = {};
  if ('deepClean' in patch) clean.deepClean = Boolean(patch.deepClean);
  return clean;
}

/**
 * Handles the message protocol from the design spec.
 * `extensionUrl` is chrome.runtime.getURL('') — only senders whose URL starts
 * with it (our own popup / pages) are served.
 */
export function createRouter({ switcher, store, extensionUrl, privateWindows = null }) {
  async function getState() {
    const [s, accounts, incognitoAllowed] = await Promise.all([store.getState(), store.list(), allowed(privateWindows)]);
    return {
      accounts,
      activeId: s.activeId ?? null,
      pending: await publicPending(s.pending, privateWindows),
      settings: s.settings,
      busy: switcher.isBusy(),
      incognitoAllowed,
    };
  }

  const handlers = {
    getState: async () => ({}),
    switch: async (msg) => {
      const { warnings = [] } = (await switcher.switchTo(msg.id)) ?? {};
      return { warnings };
    },
    beginAdd: async () => {
      const { warnings = [] } = (await switcher.beginAdd()) ?? {};
      return { warnings };
    },
    finishAdd: async (msg) => {
      // A private add leaves the active account as it is: tell the user how
      // to get to the new one.
      const wasPrivate = isPrivate(await store.getPending());
      const account = await switcher.finishAdd(name(msg));
      return wasPrivate ? { notice: privateNotice(account?.name ?? name(msg).trim()) } : {};
    },
    cancelAdd: async () => {
      const { warnings = [] } = (await switcher.cancelAdd()) ?? {};
      return { warnings };
    },
    saveCurrentAs: async (msg) => { await switcher.saveCurrentAs(name(msg)); return {}; },
    rename: async (msg) => {
      await store.rename(msg.id, name(msg));
      await switcher.refreshBadge();
      return {};
    },
    remove: async (msg) => { await switcher.remove(msg.id); return {}; },
    setSettings: async (msg) => { await store.updateSettings(settingsPatch(msg.patch)); return {}; },
    openIncognitoSettings: async () => {
      if (!privateWindows) throw new Error('Not available');
      await privateWindows.openSettings();
      return {};
    },
  };

  async function handle(message, sender) {
    if (typeof sender?.url !== 'string' || !extensionUrl || !sender.url.startsWith(extensionUrl)) {
      return { ok: false, error: 'Sender not allowed', state: null };
    }
    try {
      const handler = message && typeof message === 'object' && Object.hasOwn(handlers, message.type)
        ? handlers[message.type]
        : null;
      if (!handler) throw new Error('Unknown request');
      const extra = await handler(message);
      return { ok: true, state: await getState(), ...extra };
    } catch (err) {
      let state = null;
      try { state = await getState(); } catch { /* report the original error */ }
      return { ok: false, error: err?.message || String(err), state };
    }
  }

  return { handle, getState };
}

/**
 * Debounces chrome.cookies.onChanged into switcher.syncActive() (or `run`, e.g.
 * capturePrivate with CAPTURE_DEBOUNCE_MS): 1500 ms after the last change, but
 * no later than 10 s after the first unsynced one (so constant churn can't
 * starve it). While any switcher op holds the lock the sync is postponed
 * rather than handed to syncActive (which would drop it), so cookies rotated
 * during the op are still captured. Store filtering is the caller's job
 * (createCookieChangeRouter); this only filters on Zoho cookie domains.
 */
export function createCookieSyncScheduler({
  switcher,
  run = () => switcher.syncActive(),
  label = 'sync',
  delay = SYNC_DEBOUNCE_MS,
  maxWait = SYNC_MAX_WAIT_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = (...args) => console.warn(...args),
}) {
  let timer = null;
  let firstChangeAt = null; // first change not yet captured by a sync

  function arm(ms) {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, ms);
  }

  async function fire() {
    timer = null;
    if (switcher.isLocked()) {
      arm(delay);
      return;
    }
    firstChangeAt = null;
    try {
      await run();
    } catch (err) {
      log(`Zoho Account Switcher: ${label} failed`, err);
    }
  }

  return {
    onCookieChanged(changeInfo) {
      if (!isZohoCookieDomain(changeInfo?.cookie?.domain)) return;
      const t = now();
      if (firstChangeAt === null) firstChangeAt = t;
      arm(Math.max(0, Math.min(delay, firstChangeAt + maxWait - t)));
    },
  };
}

/**
 * With "incognito": "spanning" chrome.cookies.onChanged reports every cookie
 * store. Zoho changes in the regular store go to `sync` (the active account's
 * debounced syncActive); changes in the store of a pending private add go to
 * `capture` (debounced capturePrivate); every other store is ignored, so an
 * Incognito cookie can never be synced into the active account.
 */
export function createCookieChangeRouter({ sync, capture, getPending }) {
  return {
    async onCookieChanged(changeInfo) {
      const cookie = changeInfo?.cookie;
      if (!isZohoCookieDomain(cookie?.domain) || typeof cookie.storeId !== 'string') return;
      if (cookie.storeId === REGULAR_STORE_ID) {
        sync.onCookieChanged(changeInfo);
        return;
      }
      let pending;
      try {
        pending = await getPending();
      } catch {
        return;
      }
      if (isPrivate(pending) && pending.storeId === cookie.storeId) capture.onCookieChanged(changeInfo);
    },
  };
}
