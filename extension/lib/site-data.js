// Per-tab and per-origin site data: reloading Zoho tabs after a switch and the
// optional "deep clean" of Zoho origins' storage. Never touches cookies.

import { ZOHO_HOST_PATTERNS, KNOWN_SUBDOMAINS, ZOHO_DOMAINS, SIGN_IN_URL, isZohoUrl } from './zoho-domains.js';

// Longest resetTabs() waits for reloaded tabs to finish loading.
export const RELOAD_WAIT_MS = 8000;

export const DEEP_CLEAN_DATA_TYPES = Object.freeze({
  localStorage: true,
  indexedDB: true,
  cacheStorage: true,
  serviceWorkers: true,
  fileSystems: true,
});

// Runs inside the page (serialized by chrome.scripting), so it must be self-contained.
function clearSessionStorage() {
  try {
    sessionStorage.clear();
  } catch {
    // sandboxed / opaque-origin documents throw on access; nothing to clear there
  }
}

const usableTabId = (tab) => Number.isInteger(tab?.id) && tab.id >= 0;

export function createSiteData(
  { tabs, scripting, browsingData } = globalThis.chrome ?? {},
  { reloadWaitMs = RELOAD_WAIT_MS } = {},
) {
  async function listZohoTabs() {
    return tabs.query({ url: [...ZOHO_HOST_PATTERNS] });
  }

  // Settles each tab once the load started by our reload reports 'complete',
  // the tab is closed, or its reload failed. `settled` resolves when all have.
  function trackLoads(ids) {
    const waiting = new Set(ids);
    const reloading = new Set(); // 'complete' only counts after we asked for the reload
    let resolveAll;
    const settled = new Promise((resolve) => { resolveAll = resolve; });
    const settle = (tabId) => {
      if (waiting.delete(tabId) && waiting.size === 0) resolveAll();
    };
    const onUpdated = (tabId, info) => {
      if (reloading.has(tabId) && info?.status === 'complete') settle(tabId);
    };
    tabs.onUpdated.addListener(onUpdated);
    tabs.onRemoved.addListener(settle);
    return {
      settled,
      settle,
      reloading: (tabId) => reloading.add(tabId),
      stop() {
        tabs.onUpdated.removeListener(onUpdated);
        tabs.onRemoved.removeListener(settle);
      },
    };
  }

  async function resetTab(tabId, loads) {
    try {
      await scripting.executeScript({ target: { tabId, allFrames: true }, func: clearSessionStorage });
    } catch {
      // discarded/crashed tab, chrome-error:// page, still loading, … — reload anyway
    }
    try {
      loads?.reloading(tabId);
      await tabs.reload(tabId);
      return true;
    } catch {
      loads?.settle(tabId);
      return false;
    }
  }

  /**
   * Clears sessionStorage in every Zoho tab and reloads it, then waits (at most
   * `reloadWaitMs` in all) until the reloads have finished loading: their
   * responses may rotate cookies, and the caller's next op must see that.
   * Returns the number of tabs reloaded.
   */
  async function resetTabs() {
    const ids = (await listZohoTabs()).filter(usableTabId).map((t) => t.id);
    if (ids.length === 0) return 0;
    const loads = tabs.onUpdated && tabs.onRemoved ? trackLoads(ids) : null;
    let timer;
    const cap = new Promise((resolve) => { timer = setTimeout(resolve, reloadWaitMs); });
    let reloaded = 0;
    try {
      const reloads = Promise.all(ids.map(async (id) => {
        if (await resetTab(id, loads)) reloaded += 1;
      }));
      await Promise.race([Promise.all([reloads, loads?.settled]), cap]);
    } finally {
      clearTimeout(timer);
      loads?.stop();
    }
    return reloaded;
  }

  async function deepClean() {
    const origins = new Set();
    for (const d of ZOHO_DOMAINS) {
      for (const sub of KNOWN_SUBDOMAINS) origins.add(`https://${sub}.${d}`);
      origins.add(`https://${d}`);
    }
    for (const tab of await listZohoTabs()) {
      const url = tab.url || tab.pendingUrl;
      if (isZohoUrl(url)) origins.add(new URL(url).origin);
    }
    await browsingData.remove({ origins: [...origins] }, { ...DEEP_CLEAN_DATA_TYPES });
  }

  async function openSignIn() {
    return tabs.create({ url: SIGN_IN_URL, active: true });
  }

  return { listZohoTabs, resetTabs, deepClean, openSignIn };
}
