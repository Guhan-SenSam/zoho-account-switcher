// In-memory fake of the chrome.* surface the service worker uses, for
// background-level tests and smoke scripts. Builds on fake-cookies and
// fake-storage and adds windows, tabs, scripting, browsingData, action,
// extension and runtime, modelling an extension with "incognito": "spanning":
//
// - One regular window (id 1) exists at start. windows.create({incognito: true})
//   opens an Incognito window; its tabs use cookie store '1', which exists only
//   while at least one Incognito window is open (closing the last one drops the
//   store and its cookies, like Chrome destroying the Incognito profile).
// - windows.get/update/remove reject 'No window with id: N.' for unknown ids;
//   remove fires tabs.onRemoved for its tabs, then windows.onRemoved.
// - tabs.query matches `url` match patterns (string or array) and `windowId`,
//   and returns Incognito tabs too (spanning). tabs.create opens in the regular
//   window. tabs.reload/update fire onUpdated 'loading' then 'complete'.
// - extension.isAllowedIncognitoAccess() resolves `incognitoAllowed` (settable).
// - runtime.onMessage: send(message, sender) calls the listeners like Chrome
//   and resolves with the async response.
// - restartWorker() drops every listener, as a service worker restart does.
//
// Everything a test may want to inspect hangs off the returned object: log
// (API calls), badge, cookies (the fake-cookies instance), storage.

import { createFakeCookies } from './fake-cookies.js';
import { createFakeStorage } from './fake-storage.js';

export const INCOGNITO_STORE_ID = '1';
export const REGULAR_WINDOW_ID = 1;

export function createEvent() {
  const listeners = [];
  return {
    addListener: (fn) => { listeners.push(fn); },
    removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener: (fn) => listeners.includes(fn),
    hasListeners: () => listeners.length > 0,
    fire: (...args) => [...listeners].map((fn) => fn(...args)),
    reset: () => { listeners.length = 0; },
    get size() { return listeners.length; },
  };
}

function patternToRegExp(pattern) {
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) throw new Error(`Invalid url pattern '${pattern}'`);
  const [, scheme, host, path] = m;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const schemeRe = scheme === '*' ? 'https?' : esc(scheme);
  let hostRe;
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = `(?:[^/]+\\.)?${esc(host.slice(2))}`;
  else hostRe = esc(host);
  const pathRe = path.split('*').map(esc).join('.*');
  return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`);
}

export function matchesPattern(pattern, url) {
  return typeof url === 'string' && patternToRegExp(pattern).test(url);
}

const noWindow = (id) => new Error(`No window with id: ${id}.`);
const noTab = (id) => new Error(`No tab with id: ${id}.`);

export function createFakeChrome({
  extensionId = 'testextensionid',
  incognitoAllowed = true,
  storage: initialStorage = {},
  now,
  loadMs = 1,
} = {}) {
  const log = [];
  const badge = { text: '', color: null, title: null };
  const windowsById = new Map();
  const tabsById = new Map();
  let nextWindowId = REGULAR_WINDOW_ID;
  let nextTabId = 100;

  const storeOf = (tab) => (tab.incognito ? INCOGNITO_STORE_ID : '0');
  const cookies = createFakeCookies({
    ...(now ? { now } : {}),
    storeTabIds: (storeId) => [...tabsById.values()].filter((t) => storeOf(t) === storeId).map((t) => t.id),
  });
  const storage = createFakeStorage(initialStorage);

  const events = {
    windowsOnRemoved: createEvent(),
    windowsOnCreated: createEvent(),
    tabsOnUpdated: createEvent(),
    tabsOnRemoved: createEvent(),
    tabsOnCreated: createEvent(),
    onStartup: createEvent(),
    onInstalled: createEvent(),
    onMessage: createEvent(),
  };

  const later = (fn) => new Promise((resolve, reject) => {
    setTimeout(() => { try { resolve(fn()); } catch (err) { reject(err); } }, 0);
  });

  const tabView = (t) => ({ id: t.id, windowId: t.windowId, incognito: t.incognito, url: t.url, status: t.status, active: t.active });
  const windowView = (w) => ({
    id: w.id,
    incognito: w.incognito,
    focused: w.focused,
    type: 'normal',
    tabs: [...tabsById.values()].filter((t) => t.windowId === w.id).map(tabView),
  });

  function load(tabId) {
    setTimeout(() => {
      const t = tabsById.get(tabId);
      if (!t) return;
      t.status = 'loading';
      events.tabsOnUpdated.fire(tabId, { status: 'loading' }, tabView(t));
    }, 0);
    setTimeout(() => {
      const t = tabsById.get(tabId);
      if (!t) return;
      t.status = 'complete';
      log.push(['tab.complete', tabId]);
      events.tabsOnUpdated.fire(tabId, { status: 'complete' }, tabView(t));
    }, loadMs);
  }

  function addWindow({ incognito = false, focused = true } = {}) {
    const id = nextWindowId++;
    if (focused) for (const w of windowsById.values()) w.focused = false;
    windowsById.set(id, { id, incognito, focused });
    if (incognito) cookies.addStore(INCOGNITO_STORE_ID);
    return id;
  }

  /**
   * Adds a tab directly (test setup), in an existing window of the right kind
   * (Incognito when `incognito`) or in a new one with `newWindow`. Returns its id.
   */
  function addTab({ url = 'chrome://newtab/', incognito = false, windowId, newWindow = false } = {}) {
    let wid = windowId;
    if (wid === undefined) {
      const existing = newWindow ? undefined : [...windowsById.values()].find((w) => w.incognito === incognito)?.id;
      wid = existing ?? addWindow({ incognito, focused: false });
    }
    const w = windowsById.get(wid);
    if (!w) throw noWindow(wid);
    const id = nextTabId++;
    tabsById.set(id, { id, windowId: wid, incognito: w.incognito, url, status: 'complete', active: true });
    return id;
  }

  function closeWindow(id) {
    const w = windowsById.get(id);
    if (!w) throw noWindow(id);
    for (const t of [...tabsById.values()].filter((x) => x.windowId === id)) {
      tabsById.delete(t.id);
      events.tabsOnRemoved.fire(t.id, { windowId: id, isWindowClosing: true });
    }
    windowsById.delete(id);
    if (w.incognito && ![...windowsById.values()].some((x) => x.incognito)) {
      cookies.removeStore(INCOGNITO_STORE_ID); // the Incognito profile is gone
    }
    events.windowsOnRemoved.fire(id);
  }

  addWindow(); // the regular window

  const chrome = {
    cookies,
    storage: { local: storage },
    windows: {
      WINDOW_ID_NONE: -1,
      onRemoved: events.windowsOnRemoved,
      onCreated: events.windowsOnCreated,
      create(details = {}) {
        log.push(['windows.create', structuredClone(details)]);
        return later(() => {
          const id = addWindow({ incognito: details.incognito === true, focused: details.focused !== false });
          const tabId = addTab({ url: details.url ?? 'chrome://newtab/', windowId: id });
          load(tabId);
          events.windowsOnCreated.fire(windowView(windowsById.get(id)));
          return windowView(windowsById.get(id));
        });
      },
      get(id) {
        log.push(['windows.get', id]);
        return later(() => {
          const w = windowsById.get(id);
          if (!w) throw noWindow(id);
          return windowView(w);
        });
      },
      update(id, props = {}) {
        log.push(['windows.update', id, structuredClone(props)]);
        return later(() => {
          const w = windowsById.get(id);
          if (!w) throw noWindow(id);
          if (props.focused) {
            for (const x of windowsById.values()) x.focused = false;
            w.focused = true;
          }
          return windowView(w);
        });
      },
      remove(id) {
        log.push(['windows.remove', id]);
        return later(() => { closeWindow(id); });
      },
    },
    tabs: {
      onUpdated: events.tabsOnUpdated,
      onRemoved: events.tabsOnRemoved,
      onCreated: events.tabsOnCreated,
      query(q = {}) {
        log.push(['tabs.query', structuredClone(q)]);
        return later(() => {
          const patterns = q.url === undefined ? null : [].concat(q.url);
          return [...tabsById.values()].filter((t) => {
            if (q.windowId !== undefined && t.windowId !== q.windowId) return false;
            if (patterns && !patterns.some((p) => matchesPattern(p, t.url))) return false;
            return true;
          }).map(tabView);
        });
      },
      get(id) {
        return later(() => {
          const t = tabsById.get(id);
          if (!t) throw noTab(id);
          return tabView(t);
        });
      },
      create(props = {}) {
        log.push(['tabs.create', props.url]);
        return later(() => {
          const regular = [...windowsById.values()].find((w) => !w.incognito)?.id ?? addWindow();
          const id = addTab({ url: props.url, windowId: props.windowId ?? regular });
          load(id);
          return tabView(tabsById.get(id));
        });
      },
      update(id, props = {}) {
        log.push(['tabs.update', id, structuredClone(props)]);
        return later(() => {
          const t = tabsById.get(id);
          if (!t) throw noTab(id);
          if (props.url !== undefined) {
            t.url = props.url;
            load(id);
          }
          return tabView(t);
        });
      },
      reload(id) {
        log.push(['tabs.reload', id]);
        return later(() => {
          if (!tabsById.has(id)) throw noTab(id);
          load(id);
        });
      },
    },
    scripting: {
      executeScript(injection) {
        log.push(['scripting.executeScript', injection.target.tabId]);
        return later(() => {
          if (!tabsById.has(injection.target.tabId)) throw noTab(injection.target.tabId);
          return [{ result: undefined }];
        });
      },
    },
    browsingData: {
      remove(options, dataTypes) {
        log.push(['browsingData.remove', structuredClone(options), structuredClone(dataTypes)]);
        return later(() => undefined);
      },
    },
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
      setBadgeTextColor: async () => {},
      setTitle: async ({ title }) => { badge.title = title; },
    },
    extension: {
      isAllowedIncognitoAccess() {
        log.push(['extension.isAllowedIncognitoAccess']);
        return later(() => fake.incognitoAllowed);
      },
    },
    runtime: {
      id: extensionId,
      getURL: (path = '') => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,
      onStartup: events.onStartup,
      onInstalled: events.onInstalled,
      onMessage: events.onMessage,
    },
  };

  const fake = {
    chrome,
    log,
    badge,
    cookies,
    storage,
    incognitoAllowed,
    addTab,
    /** Closes a window as the user would (fires tabs/windows.onRemoved). */
    closeWindow,
    windows: () => [...windowsById.values()].map(windowView),
    tabs: () => [...tabsById.values()].map(tabView),
    incognitoWindows: () => [...windowsById.values()].filter((w) => w.incognito).map(windowView),
    /** Sends a runtime message like the popup does; resolves with the response. */
    send(message, sender = { id: extensionId, url: chrome.runtime.getURL('popup/popup.html') }) {
      return new Promise((resolve, reject) => {
        const results = events.onMessage.fire(message, sender, resolve);
        if (!results.includes(true)) reject(new Error('no listener kept the message channel open'));
      });
    },
    /** A service worker restart: every listener registered so far is dropped. */
    restartWorker() {
      for (const e of Object.values(events)) e.reset();
      cookies.onChanged.reset();
    },
    events,
  };
  return fake;
}
