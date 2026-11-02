// Background-side glue kept out of background.js so it can be unit tested:
// the popup → background message router and the cookie-change sync debounce.

import { isZohoCookieDomain } from './zoho-domains.js';

export const SYNC_DEBOUNCE_MS = 1500;

const name = (msg) => (typeof msg.name === 'string' ? msg.name : '');

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
      pending: s.pending ?? null,
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
 * Debounces chrome.cookies.onChanged into switcher.syncActive(). If a
 * user-initiated op is still running when the timer fires, the sync is
 * postponed (not dropped) so cookies rotated during the op are still captured.
 */
export function createCookieSyncScheduler({
  switcher,
  delay = SYNC_DEBOUNCE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = (...args) => console.warn(...args),
}) {
  let timer = null;

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, delay);
  }

  async function fire() {
    timer = null;
    if (switcher.isBusy()) {
      schedule();
      return;
    }
    try {
      await switcher.syncActive();
    } catch (err) {
      log('Zoho Account Switcher: sync failed', err);
    }
  }

  return {
    onCookieChanged(changeInfo) {
      if (!isZohoCookieDomain(changeInfo?.cookie?.domain)) return;
      schedule();
    },
  };
}
