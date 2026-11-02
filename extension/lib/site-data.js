// Per-tab and per-origin site data: reloading Zoho tabs after a switch and the
// optional "deep clean" of Zoho origins' storage. Never touches cookies.

import { ZOHO_HOST_PATTERNS, KNOWN_SUBDOMAINS, ZOHO_DOMAINS, SIGN_IN_URL, isZohoUrl } from './zoho-domains.js';

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

export function createSiteData({ tabs, scripting, browsingData } = globalThis.chrome ?? {}) {
  async function listZohoTabs() {
    return tabs.query({ url: [...ZOHO_HOST_PATTERNS] });
  }

  async function resetTab(tabId) {
    try {
      await scripting.executeScript({ target: { tabId, allFrames: true }, func: clearSessionStorage });
    } catch {
      // discarded/crashed tab, chrome-error:// page, still loading, … — reload anyway
    }
    try {
      await tabs.reload(tabId);
      return true;
    } catch {
      return false;
    }
  }

  async function resetTabs() {
    const ids = (await listZohoTabs()).filter(usableTabId).map((t) => t.id);
    const results = await Promise.all(ids.map(resetTab));
    return results.filter(Boolean).length;
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
