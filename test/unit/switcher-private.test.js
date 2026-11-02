// Switcher: "Add account" in a private (Incognito) window, with fakes that log
// every call so tests can assert ordering and — above all — that the regular
// cookie jar and the active account are never touched by the private flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwitcher } from '../../extension/lib/switcher.js';
import { SIGN_IN_URL } from '../../extension/lib/zoho-domains.js';

const PRIVATE = '1';
const NO_COOKIES_ERROR = 'Sign in to Zoho in the private window first';

// httpOnly domain cookies on .zoho.com = sign-in "anchor" cookies.
const ck = (value, name = 'sid') => [{ name, value, domain: '.zoho.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true }];
const hostCk = (value, name = 'iamcsr') => ({ name, value, domain: 'accounts.zoho.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'strict', session: true });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

function makeStore(log, init) {
  const state = { accounts: {}, order: [], activeId: null, settings: { deepClean: false }, pending: null, switching: null, ...init };
  let seq = 0;
  const rec = (...e) => log.push(e);
  const clone = (v) => structuredClone(v);
  return {
    state,
    async getState() { return clone(state); },
    async list() {
      return state.order.map((id) => {
        const a = state.accounts[id];
        return { id, name: a.name, color: a.color, initials: a.name.slice(0, 2).toUpperCase(), createdAt: 1, savedAt: 1, cookieCount: a.cookies.length };
      });
    },
    async get(id) { return state.accounts[id] ? clone(state.accounts[id]) : null; },
    async create({ name, cookies }) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (trimmed.length < 1 || trimmed.length > 40) throw new Error('Name must be 1–40 characters');
      const id = `new${++seq}`;
      state.accounts[id] = { id, name: trimmed, color: '#123456', cookies: clone(cookies), createdAt: 1, savedAt: 1 };
      state.order.push(id);
      rec('store.create', trimmed, clone(cookies));
      return clone(state.accounts[id]);
    },
    async updateCookies(id, cookies) {
      rec('store.updateCookies', id, clone(cookies));
      if (state.accounts[id]) state.accounts[id].cookies = clone(cookies);
    },
    async remove(id) {
      rec('store.remove', id);
      delete state.accounts[id];
      state.order = state.order.filter((x) => x !== id);
      if (state.activeId === id) state.activeId = null;
    },
    async getActiveId() { return state.activeId; },
    async setActiveId(id) { rec('store.setActiveId', id); state.activeId = id; },
    async getSettings() { return clone(state.settings); },
    async getPending() { return clone(state.pending); },
    async setPending(p) { rec('store.setPending', clone(p)); state.pending = clone(p); },
    async getSwitching() { return clone(state.switching); },
    async setSwitching(m) { rec('store.setSwitching', clone(m)); state.switching = clone(m); },
  };
}

// Regular store in `live`; other stores (the Incognito one) in `stores`.
// Log entries name the store: ['jar.snapshot', '1'] vs ['jar.snapshot'].
function makeJar(log, { live = [], privateStore = [] } = {}) {
  const jar = {
    live: structuredClone(live),
    stores: { [PRIVATE]: structuredClone(privateStore) },
    snapshotGate: null,
    clearThrows: null,
    snapshotThrows: null,
    read(storeId) {
      if (storeId === undefined) return jar.live;
      if (!jar.stores[storeId]) throw new Error(`Invalid cookie store id: "${storeId}".`);
      return jar.stores[storeId];
    },
    async snapshot(opts) {
      log.push(opts?.storeId ? ['jar.snapshot', opts.storeId] : ['jar.snapshot']);
      const gate = jar.snapshotGate;
      jar.snapshotGate = null;
      if (gate) await gate;
      if (jar.snapshotThrows) { const e = jar.snapshotThrows; jar.snapshotThrows = null; throw e; }
      return structuredClone(jar.read(opts?.storeId));
    },
    async clear(opts) {
      log.push(opts?.storeId ? ['jar.clear', opts.storeId] : ['jar.clear']);
      if (jar.clearThrows) { const e = jar.clearThrows; jar.clearThrows = null; throw e; }
      const n = jar.read(opts?.storeId).length;
      if (opts?.storeId) jar.stores[opts.storeId] = []; else jar.live = [];
      return n;
    },
    async restore(saved, opts) {
      log.push(opts ? ['jar.restore', structuredClone(saved), opts] : ['jar.restore', structuredClone(saved)]);
      const key = (c) => `${c.name}|${c.domain}|${c.path}`;
      const liveKeys = new Set(jar.live.map(key));
      const toSet = opts?.onlyMissing ? saved.filter((c) => !liveKeys.has(key(c))) : saved;
      jar.live = opts?.onlyMissing ? [...jar.live, ...structuredClone(toSet)] : structuredClone(saved);
      return { restored: toSet.length, skipped: saved.length - toSet.length, failed: [] };
    },
  };
  return jar;
}

// Windows 50, 51, … ; a window's tab loads its URL only after beforeLoad.
function makePrivateWindows(log, jar, { allowed = true } = {}) {
  const pw = {
    allowed,
    nextId: 50,
    openWindows: new Set(),
    loaded: [], // [windowId, url, Incognito store at load time]
    openThrows: null,
    closeThrows: null,
    async isAllowed() { log.push(['pw.isAllowed']); return pw.allowed; },
    async open(url, { beforeLoad } = {}) {
      log.push(['pw.open', url]);
      if (pw.openThrows) { const e = pw.openThrows; pw.openThrows = null; throw e; }
      const windowId = pw.nextId++;
      pw.openWindows.add(windowId);
      jar.stores[PRIVATE] ??= [];
      const opened = { windowId, tabId: windowId * 10, storeId: PRIVATE };
      if (beforeLoad) await beforeLoad({ ...opened });
      log.push(['pw.load', windowId, url]);
      pw.loaded.push([windowId, url, structuredClone(jar.stores[PRIVATE])]);
      return opened;
    },
    async focus(id) { log.push(['pw.focus', id]); return pw.openWindows.has(id); },
    async isOpen(id) { return pw.openWindows.has(id); },
    async close(id) {
      log.push(['pw.close', id]);
      if (pw.closeThrows) { const e = pw.closeThrows; pw.closeThrows = null; throw e; }
      return pw.openWindows.delete(id);
    },
    /** The user closes the window: if it was the last one, the Incognito store goes too. */
    userCloses(id) {
      pw.openWindows.delete(id);
      if (pw.openWindows.size === 0) delete jar.stores[PRIVATE];
    },
    async openSettings() { log.push(['pw.openSettings']); },
  };
  return pw;
}

function makeSiteData(log) {
  return {
    async resetTabs() { log.push(['siteData.resetTabs']); return 0; },
    async deepClean() { log.push(['siteData.deepClean']); },
    async openSignIn() { log.push(['siteData.openSignIn']); },
  };
}

function makeBadge(log) {
  return { shown: [], async show(arg) { this.shown.push(arg); log.push(['badge.show', arg.active?.id ?? null, arg.pending]); } };
}

const account = (id, cookies) => ({ id, name: `Account ${id}`, color: '#2563eb', cookies, createdAt: 1, savedAt: 1 });

const privatePending = (over = {}) => ({ mode: 'private', previousId: 'A', startedAt: 5, windowId: 50, storeId: PRIVATE, ...over });

// A and B saved, A active and live in the regular store.
function setup({
  activeId = 'A', pending = null, live, privateStore = [], allowed = true, deepClean = false, withPrivateWindows = true, openWindows = [],
} = {}) {
  const log = [];
  const store = makeStore(log, {
    accounts: { A: account('A', ck('a-old')), B: account('B', ck('b')) },
    order: ['A', 'B'],
    activeId,
    pending,
    settings: { deepClean },
  });
  const jar = makeJar(log, { live: live ?? ck('a-live'), privateStore });
  const privateWindows = withPrivateWindows ? makePrivateWindows(log, jar, { allowed }) : undefined;
  for (const id of openWindows) privateWindows.openWindows.add(id);
  const siteData = makeSiteData(log);
  const badge = makeBadge(log);
  const switcher = createSwitcher({ jar, store, siteData, badge, privateWindows, now: () => 1000 });
  return { log, store, jar, privateWindows, siteData, badge, switcher };
}

const names = (log) => log.map((e) => e[0]);
/** Nothing in the log touched the regular cookie jar. */
const regularJarCalls = (log) => log.filter(([n, storeId]) => n.startsWith('jar.') && storeId === undefined || n === 'jar.restore');
const touchesRegularProfile = (log) => [
  ...regularJarCalls(log),
  ...log.filter(([n]) => ['store.setActiveId', 'store.updateCookies', 'siteData.resetTabs', 'siteData.deepClean', 'siteData.openSignIn', 'store.setSwitching'].includes(n)),
];

// ---------------------------------------------------------------------------
// beginAdd
// ---------------------------------------------------------------------------

test('beginAdd (Incognito allowed): opens a private window, clears its store before the sign-in page loads, sets a private pending', async () => {
  const { log, store, jar, switcher } = setup({ deepClean: true });
  const res = await switcher.beginAdd();
  assert.deepEqual(res, { warnings: [], mode: 'private' });
  assert.deepEqual(log, [
    ['pw.isAllowed'],
    ['pw.open', SIGN_IN_URL],
    ['jar.clear', PRIVATE],
    ['pw.load', 50, SIGN_IN_URL],
    ['store.setPending', { mode: 'private', previousId: 'A', startedAt: 1000, windowId: 50, storeId: PRIVATE }],
    ['badge.show', 'A', true], // "+" (pending wins), A still the active account
  ]);
  assert.equal(store.state.activeId, 'A', 'active account unchanged');
  assert.deepEqual(jar.live, ck('a-live'), 'regular jar untouched');
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'), 'no outgoing snapshot');
  assert.deepEqual(touchesRegularProfile(log), []);
});

test('beginAdd (private): a leftover Zoho session in the shared Incognito store is cleared before sign-in loads', async () => {
  const { privateWindows, switcher } = setup({ privateStore: ck('leftover-someone') });
  await switcher.beginAdd();
  assert.deepEqual(privateWindows.loaded, [[50, SIGN_IN_URL, []]]);
});

test('beginAdd (private): with no active account the unsaved regular session is simply left alone', async () => {
  const { log, store, jar, switcher } = setup({ activeId: null, live: ck('unsaved') });
  await switcher.beginAdd();
  assert.deepEqual(store.state.pending, { mode: 'private', previousId: null, startedAt: 1000, windowId: 50, storeId: PRIVATE });
  assert.deepEqual(jar.live, ck('unsaved'));
  assert.equal(store.state.activeId, null);
  assert.deepEqual(touchesRegularProfile(log), []);
});

test('beginAdd (private): if the window cannot be opened, nothing changes', async () => {
  const { log, store, jar, privateWindows, switcher } = setup();
  privateWindows.openThrows = new Error('Incognito mode is disabled.');
  await assert.rejects(switcher.beginAdd(), /Incognito mode is disabled/);
  assert.equal(store.state.pending, null);
  assert.equal(store.state.activeId, 'A');
  assert.deepEqual(jar.live, ck('a-live'));
  assert.deepEqual(touchesRegularProfile(log), []);
});

test('beginAdd (private) again while its window is open just focuses it', async () => {
  const pending = privatePending({ capturedCookies: ck('c') });
  const { log, store, switcher } = setup({ pending, openWindows: [50] });
  assert.deepEqual(await switcher.beginAdd(), { warnings: [], mode: 'private' });
  assert.deepEqual(log, [['pw.focus', 50]]);
  assert.deepEqual(store.state.pending, pending);
});

test('beginAdd (private) again after the window was closed opens a fresh one, keeping captured cookies', async () => {
  const pending = privatePending({ windowId: null, capturedCookies: ck('c') });
  const { log, store, jar, privateWindows, switcher } = setup({ pending });
  delete jar.stores[PRIVATE]; // last Incognito window closed: the store is gone too
  assert.deepEqual(await switcher.beginAdd(), { warnings: [], mode: 'private' });
  assert.deepEqual(store.state.pending, { ...pending, windowId: 50, storeId: PRIVATE });
  assert.deepEqual(names(log), ['pw.isAllowed', 'pw.open', 'jar.clear', 'pw.load', 'store.setPending', 'badge.show']);
  assert.deepEqual(privateWindows.loaded, [[50, SIGN_IN_URL, []]]);
  assert.equal(store.state.activeId, 'A');
});

test('beginAdd (private) again with a stale window id (focus fails) opens a fresh window', async () => {
  const pending = privatePending({ windowId: 42 });
  const { log, store, switcher } = setup({ pending });
  await switcher.beginAdd();
  assert.deepEqual(names(log).slice(0, 3), ['pw.focus', 'pw.isAllowed', 'pw.open']);
  assert.equal(store.state.pending.windowId, 50);
  assert.equal(store.state.pending.startedAt, 5, 'still the same add');
});

test('beginAdd (private) again when Incognito access was turned off meanwhile: error, pending kept', async () => {
  const pending = privatePending({ windowId: null, capturedCookies: ck('c') });
  const { log, store, switcher } = setup({ pending, allowed: false });
  await assert.rejects(switcher.beginAdd(), /Allow in Incognito/);
  assert.deepEqual(store.state.pending, pending);
  assert.equal(names(log).includes('pw.open'), false);
});

test('beginAdd (Incognito not allowed): the sign-out flow, now marked mode "signout"', async () => {
  const { log, store, jar, switcher } = setup({ allowed: false });
  assert.deepEqual(await switcher.beginAdd(), { warnings: [], mode: 'signout' });
  assert.deepEqual(names(log), [
    'pw.isAllowed', 'jar.snapshot', 'store.updateCookies', 'store.setPending', 'store.setActiveId', 'badge.show', 'jar.clear', 'siteData.resetTabs', 'siteData.openSignIn',
  ]);
  assert.deepEqual(store.state.pending, { mode: 'signout', previousId: 'A', startedAt: 1000 });
  assert.equal(store.state.activeId, null);
  assert.deepEqual(jar.live, []);
});

test('beginAdd without a privateWindows helper uses the sign-out flow', async () => {
  const { store, switcher } = setup({ withPrivateWindows: false });
  assert.equal((await switcher.beginAdd()).mode, 'signout');
  assert.equal(store.state.pending.mode, 'signout');
});

test('beginAdd while a sign-out add is pending (old data without mode too) only reopens the sign-in tab', async () => {
  for (const pending of [{ previousId: 'A', startedAt: 5 }, { mode: 'signout', previousId: 'A', startedAt: 5 }]) {
    const { log, store, switcher } = setup({ activeId: null, pending });
    assert.deepEqual(await switcher.beginAdd(), { warnings: [], mode: 'signout' });
    assert.deepEqual(log, [['siteData.openSignIn']]);
    assert.deepEqual(store.state.pending, pending);
  }
});

// ---------------------------------------------------------------------------
// capturePrivate
// ---------------------------------------------------------------------------

test('capturePrivate: saves a non-empty snapshot of the private store into pending.capturedCookies', async () => {
  const { log, store, jar, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  assert.equal(await switcher.capturePrivate(), true);
  assert.deepEqual(store.state.pending, privatePending({ capturedCookies: ck('carol') }));
  assert.deepEqual(log, [['jar.snapshot', PRIVATE], ['store.setPending', privatePending({ capturedCookies: ck('carol') })]]);
  assert.deepEqual(jar.live, ck('a-live'));
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'), 'never written into an account');
});

test('capturePrivate: an empty private store captures nothing (keeps an earlier capture)', async () => {
  const { log, store, switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }), openWindows: [50] });
  assert.equal(await switcher.capturePrivate(), false);
  assert.deepEqual(names(log), ['jar.snapshot']);
  assert.deepEqual(store.state.pending.capturedCookies, ck('carol'));
});

test('capturePrivate: a signed-out-looking store (sign-in page cookies only) never replaces a captured session', async () => {
  const { store, switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }), openWindows: [50], privateStore: [hostCk('csr')] });
  const info = console.info;
  console.info = () => {};
  try {
    assert.equal(await switcher.capturePrivate(), false);
  } finally {
    console.info = info;
  }
  assert.deepEqual(store.state.pending.capturedCookies, ck('carol'));
});

test('capturePrivate: a re-sign-in (new anchor values) replaces the capture', async () => {
  const { store, switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }), openWindows: [50], privateStore: ck('carol2') });
  assert.equal(await switcher.capturePrivate(), true);
  assert.deepEqual(store.state.pending.capturedCookies, ck('carol2'));
});

test('capturePrivate: no-op without a private pending or with its window closed', async () => {
  for (const opts of [
    { pending: null },
    { pending: { previousId: 'A', startedAt: 1 } },
    { activeId: null, pending: { mode: 'signout', previousId: 'A', startedAt: 1 } },
    { pending: privatePending({ windowId: null }) },
    { pending: privatePending() }, // window 50 not open (closed without an event yet)
  ]) {
    const { log, store, switcher } = setup({ ...opts, privateStore: ck('carol') });
    const before = structuredClone(store.state.pending);
    assert.equal(await switcher.capturePrivate(), false, JSON.stringify(opts));
    assert.deepEqual(log, []);
    assert.deepEqual(store.state.pending, before);
  }
});

test('capturePrivate: skipped (false) while another op runs or is queued', async () => {
  const { jar, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const sync = switcher.syncActive();
  await tick();
  assert.equal(await switcher.capturePrivate(), false);
  gate.resolve();
  await sync;
});

test('capturePrivate: a store that vanished mid-snapshot (window closed) is false, not an error', async () => {
  const { store, jar, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  jar.snapshotThrows = new Error('Invalid cookie store id: "1".');
  assert.equal(await switcher.capturePrivate(), false);
  assert.equal(store.state.pending.capturedCookies, undefined);
});

test('capturePrivate: drops the write if the pending add changed during the snapshot', async () => {
  const { log, store, jar, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.capturePrivate();
  await tick();
  store.state.pending = null; // e.g. finished behind the switcher's back
  gate.resolve();
  assert.equal(await p, false);
  assert.equal(names(log).includes('store.setPending'), false);
});

// ---------------------------------------------------------------------------
// privateWindowClosed
// ---------------------------------------------------------------------------

test('privateWindowClosed: the pending window → windowId null, pending (and its capture) kept', async () => {
  const { log, store, switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }) });
  assert.equal(await switcher.privateWindowClosed(50), true);
  assert.deepEqual(store.state.pending, privatePending({ windowId: null, capturedCookies: ck('carol') }));
  assert.deepEqual(touchesRegularProfile(log), []);
});

test('privateWindowClosed: any other window, or no private pending → no-op', async () => {
  for (const [pending, windowId] of [
    [privatePending(), 51],
    [privatePending({ windowId: null }), 50],
    [null, 50],
    [{ mode: 'signout', previousId: 'A', startedAt: 1 }, 50],
  ]) {
    const { log, store, switcher } = setup({ pending });
    assert.equal(await switcher.privateWindowClosed(windowId), false);
    assert.deepEqual(log, []);
    assert.deepEqual(store.state.pending, pending);
  }
});

// ---------------------------------------------------------------------------
// finishAdd
// ---------------------------------------------------------------------------

test('finishAdd (private, window open): saves the private store as a new account; active account and regular jar untouched', async () => {
  const { log, store, jar, privateWindows, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  const acc = await switcher.finishAdd('  Carol ');
  assert.equal(acc.name, 'Carol');
  assert.deepEqual(acc.cookies, ck('carol'));
  assert.deepEqual(log, [
    ['jar.snapshot', PRIVATE],
    ['store.create', 'Carol', ck('carol')],
    ['jar.clear', PRIVATE],
    ['pw.close', 50],
    ['store.setPending', null],
    ['badge.show', 'A', false],
  ]);
  assert.equal(store.state.activeId, 'A');
  assert.deepEqual(jar.live, ck('a-live'));
  assert.deepEqual(jar.stores[PRIVATE], [], 'the new session no longer lives in Incognito');
  assert.equal(privateWindows.openWindows.size, 0);
  assert.deepEqual(touchesRegularProfile(log), []);
});

test('finishAdd (private, window open but store empty): uses the captured cookies', async () => {
  const { store, switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }), openWindows: [50] });
  const acc = await switcher.finishAdd('Carol');
  assert.deepEqual(acc.cookies, ck('carol'));
  assert.equal(store.state.pending, null);
});

test('finishAdd (private, live store looks signed out next to the capture): uses the capture', async () => {
  const { switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }), openWindows: [50], privateStore: [hostCk('csr')] });
  const info = console.info;
  console.info = () => {};
  try {
    assert.deepEqual((await switcher.finishAdd('Carol')).cookies, ck('carol'));
  } finally {
    console.info = info;
  }
});

test('finishAdd (private, window closed): uses the captured cookies, touches no store or window', async () => {
  const { log, store, switcher } = setup({ pending: privatePending({ windowId: null, capturedCookies: ck('carol') }) });
  const acc = await switcher.finishAdd('Carol');
  assert.deepEqual(acc.cookies, ck('carol'));
  assert.deepEqual(names(log), ['store.create', 'store.setPending', 'badge.show']);
  assert.equal(store.state.activeId, 'A');
});

test('finishAdd (private) with nothing captured: "Sign in to Zoho in the private window first", pending kept', async () => {
  for (const opts of [
    { pending: privatePending({ windowId: null }) },
    { pending: privatePending(), openWindows: [50] },
    { pending: privatePending({ windowId: null, capturedCookies: [] }) },
  ]) {
    const { store, privateWindows, switcher } = setup(opts);
    const before = structuredClone(store.state.pending);
    await assert.rejects(switcher.finishAdd('Carol'), { message: NO_COOKIES_ERROR });
    assert.deepEqual(store.state.pending, before);
    assert.deepEqual(store.state.order, ['A', 'B']);
    assert.deepEqual([...privateWindows.openWindows], opts.openWindows ?? []);
  }
});

test('finishAdd (private) with a bad name: name error, pending, window and private session kept', async () => {
  const { store, jar, privateWindows, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  await assert.rejects(switcher.finishAdd('  '), { message: 'Name must be 1–40 characters' });
  assert.deepEqual(store.state.pending, privatePending());
  assert.deepEqual(jar.stores[PRIVATE], ck('carol'));
  assert.deepEqual([...privateWindows.openWindows], [50]);
});

test('finishAdd (private): failing to clear or close the window still finishes (account saved once, pending cleared)', async () => {
  const { store, jar, privateWindows, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  jar.clearThrows = new Error('cookies API hiccup');
  privateWindows.closeThrows = new Error('boom');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await switcher.finishAdd('Carol');
  } finally {
    console.warn = warn;
  }
  assert.equal(store.state.pending, null);
  assert.deepEqual(store.state.order, ['A', 'B', 'new1']);
});

test('finishAdd (private) when the active account was removed meanwhile: still nothing becomes active', async () => {
  const { store, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  await switcher.remove('A');
  await switcher.finishAdd('Carol');
  assert.equal(store.state.activeId, null);
});

// ---------------------------------------------------------------------------
// cancelAdd
// ---------------------------------------------------------------------------

test('cancelAdd (private, window open): clears the private store, closes the window, drops pending; regular profile untouched', async () => {
  const { log, store, jar, privateWindows, switcher } = setup({ pending: privatePending({ capturedCookies: ck('carol') }), openWindows: [50], privateStore: ck('carol'), deepClean: true });
  assert.deepEqual(await switcher.cancelAdd(), { warnings: [] });
  assert.deepEqual(log, [
    ['jar.clear', PRIVATE],
    ['pw.close', 50],
    ['store.setPending', null],
    ['badge.show', 'A', false],
  ]);
  assert.equal(store.state.activeId, 'A');
  assert.deepEqual(jar.live, ck('a-live'));
  assert.deepEqual(jar.stores[PRIVATE], []);
  assert.equal(privateWindows.openWindows.size, 0);
});

test('cancelAdd (private, window closed): no store or window to touch, pending dropped', async () => {
  const { log, store, switcher } = setup({ pending: privatePending({ windowId: null, capturedCookies: ck('carol') }) });
  await switcher.cancelAdd();
  assert.deepEqual(names(log), ['store.setPending', 'badge.show']);
  assert.equal(store.state.pending, null);
});

test('cancelAdd (private): a failing clear or close does not stop the cancel', async () => {
  const { store, jar, privateWindows, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  jar.clearThrows = new Error('hiccup');
  privateWindows.closeThrows = new Error('boom');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await switcher.cancelAdd();
  } finally {
    console.warn = warn;
  }
  assert.equal(store.state.pending, null);
});

// ---------------------------------------------------------------------------
// The rest of the switcher during a private add
// ---------------------------------------------------------------------------

test('syncActive keeps saving the active account during a private add', async () => {
  const { store, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  assert.equal(await switcher.syncActive(), true);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'), 'the regular store, never the private one');
});

test('syncActive still skips during a sign-out add (with or without mode)', async () => {
  for (const pending of [{ previousId: 'A', startedAt: 1 }, { mode: 'signout', previousId: 'A', startedAt: 1 }]) {
    const { log, switcher } = setup({ pending });
    assert.equal(await switcher.syncActive(), false);
    assert.deepEqual(log, []);
  }
});

test('switchTo and saveCurrentAs are refused during a private add', async () => {
  const { log, switcher } = setup({ pending: privatePending(), openWindows: [50] });
  await assert.rejects(switcher.switchTo('B'), { message: 'Finish or cancel adding an account first' });
  const s2 = setup({ activeId: null, pending: privatePending(), openWindows: [50] });
  await assert.rejects(s2.switcher.saveCurrentAs('X'), { message: 'Finish or cancel adding an account first' });
  assert.deepEqual(log, []);
});

test('restoreActiveOnStartup during a private add: restores the active account, and the private window (gone after a restart) is marked closed', async () => {
  const pending = privatePending({ capturedCookies: ck('carol') });
  const { store, jar, switcher } = setup({ pending, live: [] });
  const res = await switcher.restoreActiveOnStartup();
  assert.equal(res.restored, 1);
  assert.deepEqual(jar.live, ck('a-old'));
  assert.deepEqual(store.state.pending, { ...pending, windowId: null });
});

test('refreshBadge: a private add shows "+" like any add', async () => {
  const { badge, switcher } = setup({ pending: privatePending() });
  await switcher.refreshBadge();
  assert.equal(badge.shown[0].pending, true);
});

test('isBusy during beginAdd/finishAdd/cancelAdd; not during capturePrivate / privateWindowClosed', async () => {
  const { jar, switcher } = setup({ pending: privatePending(), openWindows: [50], privateStore: ck('carol') });
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.capturePrivate();
  await tick();
  assert.equal(switcher.isBusy(), false);
  assert.equal(switcher.isLocked(), true);
  gate.resolve();
  await p;
  const closed = switcher.privateWindowClosed(50);
  assert.equal(switcher.isBusy(), false);
  await closed;
});

test('full private flow: begin → sign in → capture → window closed → finish; A stays active and intact throughout', async () => {
  const { store, jar, privateWindows, switcher } = setup();
  await switcher.beginAdd();
  jar.stores[PRIVATE] = ck('carol'); // the user signs in in the private window
  assert.equal(await switcher.syncActive(), true, 'A keeps syncing meanwhile');
  assert.equal(await switcher.capturePrivate(), true);
  privateWindows.userCloses(50);
  await switcher.privateWindowClosed(50);
  const carol = await switcher.finishAdd('Carol');
  assert.deepEqual(store.state.accounts[carol.id].cookies, ck('carol'));
  assert.equal(store.state.activeId, 'A');
  assert.deepEqual(jar.live, ck('a-live'));
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  // Switching to the new account later is the normal switch.
  await switcher.switchTo(carol.id);
  assert.deepEqual(jar.live, ck('carol'));
});
