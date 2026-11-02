// Background-side glue kept out of background.js so it can be unit tested:
// the popup → background message router and the cookie-change sync debounce.

import { isZohoCookieDomain } from './zoho-domains.js';

export const SYNC_DEBOUNCE_MS = 1500;
export const SYNC_MAX_WAIT_MS = 10_000;

const name = (msg) => (typeof msg.name === 'string' ? msg.name : '');

// The popup only needs to know an add is in progress; never ship stashed cookies.
const publicPending = (p) => (p ? { previousId: p.previousId ?? null, startedAt: p.startedAt } : null);

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
export function createRouter({ switcher, store, extensionUrl }) {
  async function getState() {
    const [s, accounts] = await Promise.all([store.getState(), store.list()]);
    return {
      accounts,
      activeId: s.activeId ?? null,
      pending: publicPending(s.pending),
      settings: s.settings,
      busy: switcher.isBusy(),
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
    finishAdd: async (msg) => { await switcher.finishAdd(name(msg)); return {}; },
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
 * Debounces chrome.cookies.onChanged into switcher.syncActive(): 1500 ms after
 * the last change, but no later than 10 s after the first unsynced one (so
 * constant churn can't starve it). While any switcher op holds the lock the
 * sync is postponed rather than handed to syncActive (which would drop it), so
 * cookies rotated during the op are still captured.
 */
export function createCookieSyncScheduler({
  switcher,
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
      await switcher.syncActive();
    } catch (err) {
      log('Zoho Account Switcher: sync failed', err);
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
