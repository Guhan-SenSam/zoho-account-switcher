import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPrivateWindows } from '../../extension/lib/private-window.js';
import { SIGN_IN_URL } from '../../extension/lib/zoho-domains.js';
import { createFakeChrome, INCOGNITO_STORE_ID, REGULAR_WINDOW_ID } from '../helpers/fake-chrome.js';

const noSleep = async () => {};

function setup(opts = {}) {
  const fake = createFakeChrome(opts);
  const pw = createPrivateWindows(fake.chrome, { sleep: noSleep });
  return { fake, pw };
}

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

test('isAllowed mirrors extension.isAllowedIncognitoAccess()', async () => {
  const { fake, pw } = setup();
  assert.equal(await pw.isAllowed(), true);
  fake.incognitoAllowed = false;
  assert.equal(await pw.isAllowed(), false);
});

test('isAllowed is false when the API fails or answers something odd', async () => {
  for (const isAllowedIncognitoAccess of [
    async () => { throw new Error('nope'); },
    () => { throw new Error('sync nope'); },
    async () => undefined,
    async () => 'yes',
  ]) {
    const pw = createPrivateWindows({ extension: { isAllowedIncognitoAccess } });
    assert.equal(await pw.isAllowed(), false);
  }
  assert.equal(await createPrivateWindows({}).isAllowed(), false, 'no extension API');
});

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

test('open creates a focused Incognito window at the URL and finds its cookie store', async () => {
  const { fake, pw } = setup();
  const opened = await pw.open(SIGN_IN_URL);
  assert.deepEqual(fake.log.find(([n]) => n === 'windows.create'), ['windows.create', { incognito: true, url: SIGN_IN_URL, focused: true }]);
  const [win] = fake.incognitoWindows();
  assert.deepEqual(opened, { windowId: win.id, tabId: win.tabs[0].id, storeId: INCOGNITO_STORE_ID });
  assert.equal(win.tabs[0].url, SIGN_IN_URL);
});

test('open with beforeLoad: the window starts blank, beforeLoad runs with its store, then the tab goes to the URL', async () => {
  const { fake, pw } = setup();
  const seen = [];
  const opened = await pw.open(SIGN_IN_URL, {
    beforeLoad: async (info) => {
      seen.push(structuredClone(info), fake.incognitoWindows()[0].tabs[0].url);
    },
  });
  assert.deepEqual(fake.log.find(([n]) => n === 'windows.create')[1], { incognito: true, url: 'about:blank', focused: true });
  assert.deepEqual(seen, [opened, 'about:blank']);
  assert.deepEqual(fake.log.find(([n]) => n === 'tabs.update'), ['tabs.update', opened.tabId, { url: SIGN_IN_URL }]);
  assert.equal(fake.incognitoWindows()[0].tabs[0].url, SIGN_IN_URL);
});

test('open: if beforeLoad fails the window is closed and the error propagates', async () => {
  const { fake, pw } = setup();
  await assert.rejects(pw.open(SIGN_IN_URL, { beforeLoad: async () => { throw new Error('clear failed'); } }), /clear failed/);
  assert.deepEqual(fake.incognitoWindows(), []);
});

function stubChrome({ stores, windowFields = {}, tabsInWindow } = {}) {
  const calls = [];
  let lookups = 0;
  return {
    calls,
    get lookups() { return lookups; },
    api: {
      windows: {
        async create(d) { calls.push(['create', d]); return { id: 7, incognito: true, tabs: [{ id: 70 }], ...windowFields }; },
        async get(id) { calls.push(['get', id]); return { id, incognito: windowFields.incognito ?? true }; },
        async remove(id) { calls.push(['remove', id]); },
      },
      tabs: { async query(q) { calls.push(['tabs.query', q]); return tabsInWindow ?? []; } },
      cookies: {
        async getAllCookieStores() {
          lookups += 1;
          return typeof stores === 'function' ? stores(lookups) : stores;
        },
      },
    },
  };
}

test('open retries until the new tab shows up in a cookie store', async () => {
  const s = stubChrome({
    stores: (n) => (n < 3 ? [{ id: '0', tabIds: [1] }] : [{ id: '0', tabIds: [1] }, { id: '1', tabIds: [70] }]),
  });
  const sleeps = [];
  const pw = createPrivateWindows(s.api, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await pw.open(SIGN_IN_URL), { windowId: 7, tabId: 70, storeId: '1' });
  assert.equal(s.lookups, 3);
  assert.equal(sleeps.length, 2);
});

test('open falls back to the only non-regular store if the tab never shows up in one', async () => {
  const s = stubChrome({ stores: [{ id: '0', tabIds: [1] }, { id: '1', tabIds: [] }] });
  const pw = createPrivateWindows(s.api, { sleep: noSleep });
  assert.deepEqual(await pw.open(SIGN_IN_URL), { windowId: 7, tabId: 70, storeId: '1' });
});

test('open: no private cookie store → closes the window and throws', async () => {
  const s = stubChrome({ stores: [{ id: '0', tabIds: [1] }] });
  const pw = createPrivateWindows(s.api, { sleep: noSleep });
  await assert.rejects(pw.open(SIGN_IN_URL), /private window/i);
  assert.deepEqual(s.calls.at(-1), ['remove', 7]);
});

test('open: a tab that lands in the regular store means no private window → closes it and throws', async () => {
  const s = stubChrome({ stores: [{ id: '0', tabIds: [1, 70] }, { id: '1', tabIds: [] }] });
  const pw = createPrivateWindows(s.api, { sleep: noSleep });
  await assert.rejects(pw.open(SIGN_IN_URL), /private window/i);
  assert.ok(s.calls.some(([n, id]) => n === 'remove' && id === 7));
});

test('open: a window Chrome did not make Incognito is closed and rejected', async () => {
  const removed = [];
  const api = {
    windows: {
      async create() { return { id: 9, incognito: false, tabs: [{ id: 90 }] }; },
      async get(id) { return { id, incognito: false }; },
      async remove(id) { removed.push(id); },
    },
    cookies: { async getAllCookieStores() { return [{ id: '0', tabIds: [90] }]; } },
  };
  await assert.rejects(createPrivateWindows(api, { sleep: noSleep }).open(SIGN_IN_URL), /private window/i);
  assert.deepEqual(removed, [9], 'closes the regular window it just opened by mistake');
});

test('open: a window object without tabs is looked up with tabs.query', async () => {
  const s = stubChrome({ windowFields: { tabs: undefined }, tabsInWindow: [{ id: 70 }], stores: [{ id: '0', tabIds: [] }, { id: '1', tabIds: [70] }] });
  const pw = createPrivateWindows(s.api, { sleep: noSleep });
  assert.deepEqual(await pw.open(SIGN_IN_URL), { windowId: 7, tabId: 70, storeId: '1' });
  assert.ok(s.calls.some(([n, q]) => n === 'tabs.query' && q.windowId === 7));
});

test('open: windows.create failing (e.g. Incognito disabled by policy) propagates', async () => {
  const api = { windows: { async create() { throw new Error('Incognito mode is disabled.'); } } };
  await assert.rejects(createPrivateWindows(api, { sleep: noSleep }).open(SIGN_IN_URL), /Incognito mode is disabled/);
});

// ---------------------------------------------------------------------------
// isOpen / focus / close
// ---------------------------------------------------------------------------

test('isOpen: true only for an open Incognito window', async () => {
  const { fake, pw } = setup();
  const { windowId } = await pw.open(SIGN_IN_URL);
  assert.equal(await pw.isOpen(windowId), true);
  assert.equal(await pw.isOpen(REGULAR_WINDOW_ID), false, 'a regular window (e.g. a reused id after restart) is not ours');
  assert.equal(await pw.isOpen(null), false);
  assert.equal(await pw.isOpen(undefined), false);
  fake.closeWindow(windowId);
  assert.equal(await pw.isOpen(windowId), false);
});

test('focus brings the private window to the front; false when it is gone or not Incognito', async () => {
  const { fake, pw } = setup();
  const { windowId } = await pw.open(SIGN_IN_URL);
  await fake.chrome.windows.update(REGULAR_WINDOW_ID, { focused: true });
  assert.equal(await pw.focus(windowId), true);
  assert.equal(fake.incognitoWindows()[0].focused, true);
  assert.equal(await pw.focus(REGULAR_WINDOW_ID), false);
  assert.equal(fake.log.filter(([n, id]) => n === 'windows.update' && id === REGULAR_WINDOW_ID).length, 1, 'only the test\'s own update');
  assert.equal(await pw.focus(null), false);
  fake.closeWindow(windowId);
  assert.equal(await pw.focus(windowId), false);
});

test('focus: an update failure (window closing meanwhile) is false, not an error', async () => {
  const api = {
    windows: {
      async get(id) { return { id, incognito: true }; },
      async update() { throw new Error('No window with id: 4.'); },
    },
  };
  assert.equal(await createPrivateWindows(api).focus(4), false);
});

test('close removes the private window; a window that is already gone is fine', async () => {
  const { fake, pw } = setup();
  const { windowId } = await pw.open(SIGN_IN_URL);
  assert.equal(await pw.close(windowId), true);
  assert.deepEqual(fake.incognitoWindows(), []);
  assert.equal(await pw.close(windowId), false);
  assert.equal(await pw.close(null), false);
});

test('close never closes a regular window', async () => {
  const { fake, pw } = setup();
  assert.equal(await pw.close(REGULAR_WINDOW_ID), false);
  assert.equal(fake.windows().length, 1);
  assert.equal(fake.log.some(([n]) => n === 'windows.remove'), false);
});

test('close ignores "No window" from windows.remove (closed in between) but not other errors', async () => {
  const api = (err) => ({
    windows: {
      async get(id) { return { id, incognito: true }; },
      async remove() { throw err; },
    },
  });
  assert.equal(await createPrivateWindows(api(new Error('No window with id: 4.'))).close(4), false);
  await assert.rejects(createPrivateWindows(api(new Error('boom'))).close(4), /boom/);
});

// ---------------------------------------------------------------------------
// openSettings / laziness
// ---------------------------------------------------------------------------

test('openSettings opens this extension\'s page in chrome://extensions', async () => {
  const { fake, pw } = setup({ extensionId: 'abcdefghijklmnop' });
  await pw.openSettings();
  assert.deepEqual(fake.log.find(([n]) => n === 'tabs.create'), ['tabs.create', 'chrome://extensions/?id=abcdefghijklmnop']);
});

test('defaults to globalThis.chrome lazily (not at import time)', async () => {
  const fake = createFakeChrome();
  const saved = globalThis.chrome;
  const pw = createPrivateWindows(undefined, { sleep: noSleep }); // created before chrome exists
  globalThis.chrome = fake.chrome;
  try {
    assert.equal(await createPrivateWindows().isAllowed(), true);
    assert.equal(await pw.isAllowed(), false, 'an instance made without chrome has nothing to ask');
  } finally {
    if (saved === undefined) delete globalThis.chrome; else globalThis.chrome = saved;
  }
});
