// The Incognito ("private") window used by "Add account" when the extension
// is allowed in Incognito: the new account signs in there, in its own cookie
// store, while the regular profile stays signed in to the active account.
// No `chrome` access at import time: the APIs are passed in (or read lazily
// from globalThis.chrome when createPrivateWindows() is called).

import { REGULAR_STORE_ID } from './zoho-domains.js';

// A new tab can take a moment to show up in cookies.getAllCookieStores().
export const STORE_LOOKUP_TRIES = 10;
export const STORE_LOOKUP_DELAY_MS = 50;

const NO_STORE_ERROR = 'Could not find the private window’s cookies';
const NOT_PRIVATE_ERROR = 'Could not open a private window';

const errorMessage = (err) => (err instanceof Error ? err.message : String(err));
// Chrome: 'No window with id: 123.'
const isNoWindowError = (err) => /no window/i.test(errorMessage(err));

/** Call `fn` and always get a promise back, even if it throws synchronously. */
const attempt = async (fn) => fn();

export function createPrivateWindows(
  { windows, cookies, extension, tabs, runtime } = globalThis.chrome ?? {},
  {
    storeLookupTries = STORE_LOOKUP_TRIES,
    storeLookupDelayMs = STORE_LOOKUP_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  } = {},
) {
  /** Whether the user turned on "Allow in Incognito" (false if that can't be read). */
  async function isAllowed() {
    try {
      return (await attempt(() => extension.isAllowedIncognitoAccess())) === true;
    } catch {
      return false;
    }
  }

  /** The window if it is an open Incognito window, else null (never one of the user's regular windows). */
  async function privateWindow(windowId) {
    if (!Number.isInteger(windowId)) return null;
    try {
      const win = await windows.get(windowId);
      return win?.incognito === true ? win : null;
    } catch {
      return null;
    }
  }

  async function isOpen(windowId) {
    return (await privateWindow(windowId)) !== null;
  }

  /** Brings the private window to the front. False if it is gone. */
  async function focus(windowId) {
    if (!(await isOpen(windowId))) return false;
    try {
      await windows.update(windowId, { focused: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Closes the private window. False if there was nothing to close: no such
   * window (already closed, maybe in between), or not an Incognito one.
   * Other windows.remove errors propagate.
   */
  async function close(windowId) {
    if (!(await isOpen(windowId))) return false;
    try {
      await windows.remove(windowId);
      return true;
    } catch (err) {
      if (isNoWindowError(err)) return false;
      throw err;
    }
  }

  async function firstTabId(win) {
    const id = win?.tabs?.[0]?.id;
    if (Number.isInteger(id)) return id;
    const found = await tabs.query({ windowId: win.id });
    return found?.[0]?.id;
  }

  /** The id of the cookie store `tabId` uses; falls back to the only non-regular store. */
  async function storeOfTab(tabId) {
    let stores = [];
    for (let i = 0; i < storeLookupTries; i += 1) {
      if (i > 0) await sleep(storeLookupDelayMs);
      stores = (await cookies.getAllCookieStores()) ?? [];
      const store = stores.find((s) => Array.isArray(s.tabIds) && s.tabIds.includes(tabId));
      if (store) return store.id;
    }
    const others = stores.filter((s) => s.id !== REGULAR_STORE_ID);
    return others.length === 1 ? others[0].id : null;
  }

  /**
   * Opens a focused Incognito window at `url` -> { windowId, tabId, storeId }.
   * With `beforeLoad`, the window opens blank, `beforeLoad({windowId, tabId,
   * storeId})` runs, and only then does the tab load `url` (so its store can
   * be prepared before any page sees it). On failure the window is closed.
   */
  async function open(url, { beforeLoad } = {}) {
    const win = await windows.create({ incognito: true, url: beforeLoad ? 'about:blank' : url, focused: true });
    try {
      if (win?.incognito !== true) throw new Error(NOT_PRIVATE_ERROR);
      const tabId = await firstTabId(win);
      const storeId = Number.isInteger(tabId) ? await storeOfTab(tabId) : null;
      if (typeof storeId !== 'string' || storeId === REGULAR_STORE_ID) throw new Error(NO_STORE_ERROR);
      const opened = { windowId: win.id, tabId, storeId };
      if (beforeLoad) {
        await beforeLoad({ ...opened });
        await tabs.update(tabId, { url });
      }
      return opened;
    } catch (err) {
      if (Number.isInteger(win?.id)) {
        // Not via close(): it would refuse a window that came out non-Incognito.
        await attempt(() => windows.remove(win.id)).catch(() => {});
      }
      throw err;
    }
  }

  /** This extension's details page, where "Allow in Incognito" is. */
  async function openSettings() {
    return tabs.create({ url: `chrome://extensions/?id=${runtime.id}` });
  }

  return { isAllowed, open, focus, close, isOpen, openSettings };
}
