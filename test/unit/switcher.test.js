import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwitcher } from '../../extension/lib/switcher.js';

// ---------------------------------------------------------------------------
// Fakes. All share one call log so tests can assert cross-module ordering.
// The jar models the browser's live Zoho cookie state.
// ---------------------------------------------------------------------------

// `ck` cookies are httpOnly domain cookies on .zoho.com, i.e. sign-in "anchor" cookies.
const ck = (value, name = 'sid') => [{ name, value, domain: '.zoho.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true }];
const hostCk = (value, name = 'zm') => ({ name, value, domain: 'mail.zoho.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true });

/** Runs fn with console.info captured; returns the logged lines. */
async function captureInfo(fn) {
  const info = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.info = info;
  }
  return lines;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

function makeStore(log, init = {}) {
  const state = {
    accounts: {},
    order: [],
    activeId: null,
    settings: { deepClean: false },
    pending: null,
    switching: null,
    ...init,
  };
  let seq = 0;
  const rec = (...e) => log.push(e);
  const clone = (v) => structuredClone(v);
  return {
    state,
    async getState() { return clone(state); },
    async list() {
      return state.order.map((id) => {
        const a = state.accounts[id];
        return { id, name: a.name, color: a.color, initials: a.name.slice(0, 2).toUpperCase(), createdAt: a.createdAt, savedAt: a.savedAt, cookieCount: a.cookies.length };
      });
    },
    async get(id) { return state.accounts[id] ? clone(state.accounts[id]) : null; },
    async create({ name, cookies }) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (trimmed.length < 1 || trimmed.length > 40) throw new Error('Name must be 1–40 characters');
      const id = `new${++seq}`;
      const acc = { id, name: trimmed, color: '#123456', cookies: clone(cookies), createdAt: 1, savedAt: 1 };
      state.accounts[id] = acc;
      state.order.push(id);
      rec('store.create', trimmed, clone(cookies));
      return clone(acc);
    },
    async updateCookies(id, cookies) {
      rec('store.updateCookies', id, clone(cookies));
      if (state.accounts[id]) state.accounts[id].cookies = clone(cookies);
    },
    async rename(id, name) { rec('store.rename', id, name); state.accounts[id].name = name; },
    async remove(id) {
      rec('store.remove', id);
      delete state.accounts[id];
      state.order = state.order.filter((x) => x !== id);
      if (state.activeId === id) state.activeId = null;
    },
    async getActiveId() { return state.activeId; },
    async setActiveId(id) { rec('store.setActiveId', id); state.activeId = id; },
    async getSettings() { return clone(state.settings); },
    async updateSettings(patch) { Object.assign(state.settings, patch); return clone(state.settings); },
    async getPending() { return clone(state.pending); },
    async setPending(p) { rec('store.setPending', clone(p)); state.pending = clone(p); },
    async getSwitching() { return clone(state.switching); },
    async setSwitching(m) { rec('store.setSwitching', clone(m)); state.switching = clone(m); },
  };
}

function makeJar(log, live = []) {
  const jar = {
    live: structuredClone(live),
    snapshotGate: null, // one-shot: next snapshot() waits on it before reading live cookies
    restoreFailed: [],
    restoreThrows: null,
    async snapshot() {
      log.push(['jar.snapshot']);
      const gate = jar.snapshotGate;
      jar.snapshotGate = null;
      if (gate) await gate;
      return structuredClone(jar.live);
    },
    async clear() {
      log.push(['jar.clear']);
      const n = jar.live.length;
      jar.live = [];
      return n;
    },
    async restore(saved, opts) {
      log.push(opts ? ['jar.restore', structuredClone(saved), opts] : ['jar.restore', structuredClone(saved)]);
      if (jar.restoreThrows) { const e = jar.restoreThrows; jar.restoreThrows = null; throw e; }
      const key = (c) => `${c.name}|${c.domain}|${c.path}`;
      const liveKeys = new Set(jar.live.map(key));
      const toSet = opts?.onlyMissing ? saved.filter((c) => !liveKeys.has(key(c))) : saved;
      jar.live = opts?.onlyMissing ? [...jar.live, ...structuredClone(toSet)] : structuredClone(saved);
      const failed = jar.restoreFailed;
      jar.restoreFailed = [];
      return { restored: toSet.length - failed.length, skipped: saved.length - toSet.length, failed };
    },
  };
  return jar;
}

function makeSiteData(log) {
  return {
    async listZohoTabs() { return []; },
    async resetTabs() { log.push(['siteData.resetTabs']); return 0; },
    async deepClean() { log.push(['siteData.deepClean']); },
    async openSignIn() { log.push(['siteData.openSignIn']); },
  };
}

function makeBadge(log) {
  return {
    shown: [],
    async show(arg) { this.shown.push(arg); log.push(['badge.show', arg.active?.id ?? null, arg.pending]); },
  };
}

function account(id, cookies) {
  return { id, name: `Account ${id}`, color: '#2563eb', cookies, createdAt: 1, savedAt: 1 };
}

// Two saved accounts, A active, live cookies = A's latest.
function setup({ activeId = 'A', pending = null, switching = null, deepClean = false, live } = {}) {
  const log = [];
  const store = makeStore(log, {
    accounts: { A: account('A', ck('a-old')), B: account('B', ck('b')) },
    order: ['A', 'B'],
    activeId,
    pending,
    switching,
    settings: { deepClean },
  });
  const jar = makeJar(log, live ?? ck('a-live'));
  const siteData = makeSiteData(log);
  const badge = makeBadge(log);
  const switcher = createSwitcher({ jar, store, siteData, badge, now: () => 1000 });
  return { log, store, jar, siteData, badge, switcher };
}

const names = (log) => log.map((e) => e[0]);

// ---------------------------------------------------------------------------
// switchTo
// ---------------------------------------------------------------------------

test('switchTo: snapshot → save outgoing → mark switching → clear → restore → set active → unmark → badge → reset tabs', async () => {
  const { log, store, jar, switcher } = setup();
  const res = await switcher.switchTo('B');
  assert.deepEqual(res, { warnings: [] });
  assert.deepEqual(names(log), [
    'jar.snapshot',
    'store.updateCookies',
    'store.setSwitching',
    'jar.clear',
    'jar.restore',
    'store.setActiveId',
    'store.setSwitching',
    'badge.show',
    'siteData.resetTabs',
  ]);
  assert.deepEqual(log[1], ['store.updateCookies', 'A', ck('a-live')]);
  assert.deepEqual(log[2], ['store.setSwitching', { from: 'A', to: 'B', startedAt: 1000 }]);
  assert.deepEqual(log[4], ['jar.restore', ck('b')]);
  assert.deepEqual(log[5], ['store.setActiveId', 'B']);
  assert.deepEqual(log[6], ['store.setSwitching', null]);
  assert.deepEqual(log[7], ['badge.show', 'B', false]);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  assert.deepEqual(jar.live, ck('b'));
  assert.equal(store.state.activeId, 'B');
  assert.equal(store.state.switching, null);
});

test('switchTo: deep clean runs between clear and restore when enabled', async () => {
  const { log, switcher } = setup({ deepClean: true });
  await switcher.switchTo('B');
  assert.deepEqual(names(log), [
    'jar.snapshot',
    'store.updateCookies',
    'store.setSwitching',
    'jar.clear',
    'siteData.deepClean',
    'jar.restore',
    'store.setActiveId',
    'store.setSwitching',
    'badge.show',
    'siteData.resetTabs',
  ]);
});

test('switchTo: a failing deep clean becomes a warning, the switch still completes', async () => {
  const { log, siteData, store, switcher } = setup({ deepClean: true });
  siteData.deepClean = async () => { log.push(['siteData.deepClean']); throw new Error('boom'); };
  const res = await switcher.switchTo('B');
  assert.equal(store.state.activeId, 'B');
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /site data/i);
});

test('switchTo: from no active account skips the outgoing snapshot', async () => {
  const { log, store, switcher } = setup({ activeId: null });
  await switcher.switchTo('B');
  assert.deepEqual(names(log), ['store.setSwitching', 'jar.clear', 'jar.restore', 'store.setActiveId', 'store.setSwitching', 'badge.show', 'siteData.resetTabs']);
  assert.deepEqual(log[0], ['store.setSwitching', { from: null, to: 'B', startedAt: 1000 }]);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
});

test('switchTo: unknown id throws "Unknown account" and changes nothing', async () => {
  const { log, switcher } = setup();
  await assert.rejects(switcher.switchTo('nope'), { message: 'Unknown account' });
  assert.deepEqual(log, []);
});

test('switchTo: while an add is pending throws and changes nothing', async () => {
  const { log, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 } });
  await assert.rejects(switcher.switchTo('B'), { message: 'Finish or cancel adding an account first' });
  assert.deepEqual(log, []);
});

test('switchTo: same id as active is a no-op', async () => {
  const { log, switcher } = setup();
  assert.deepEqual(await switcher.switchTo('A'), { warnings: [] });
  assert.deepEqual(log, []);
});

test('switchTo: restore failures are reported as a warning naming the cookies', async () => {
  const { jar, switcher } = setup();
  jar.restoreFailed = [{ name: 'IAMX', domain: '.zoho.com', error: 'e' }, { name: 'zz', domain: 'mail.zoho.com', error: 'e' }];
  assert.deepEqual(await switcher.switchTo('B'), { warnings: ['Could not restore 2 cookies: IAMX (.zoho.com), zz (mail.zoho.com)'] });
});

test('switchTo: a single restore failure uses the singular', async () => {
  const { jar, switcher } = setup();
  jar.restoreFailed = [{ name: 'x', domain: '.zoho.com', error: 'e' }];
  assert.deepEqual(await switcher.switchTo('B'), { warnings: ['Could not restore 1 cookie: x (.zoho.com)'] });
});

test('switchTo: the warning lists at most 3 cookies', async () => {
  const { jar, switcher } = setup();
  jar.restoreFailed = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, domain: '.zoho.eu', error: 'e' }));
  assert.deepEqual(await switcher.switchTo('B'), {
    warnings: ['Could not restore 5 cookies: a (.zoho.eu), b (.zoho.eu), c (.zoho.eu), …'],
  });
});

test('switchTo: if restore throws, the outgoing account is put back so a later sync cannot corrupt it', async () => {
  const { store, jar, switcher } = setup();
  jar.restoreThrows = new Error('cookies API exploded');
  await assert.rejects(switcher.switchTo('B'), { message: 'cookies API exploded' });
  assert.equal(store.state.activeId, 'A');
  assert.equal(store.state.switching, null, 'marker cleared on the rollback path');
  assert.deepEqual(jar.live, ck('a-live'));
  assert.equal(switcher.isBusy(), false);
  // a sync after the failure writes A's own cookies into A
  assert.equal(await switcher.syncActive(), true);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  assert.deepEqual(store.state.accounts.B.cookies, ck('b'));
});

test('switchTo: if clear fails part-way, the outgoing account is restored in full', async () => {
  const { store, jar, switcher } = setup({ live: [...ck('a1', 'one'), ...ck('a2', 'two')] });
  store.state.accounts.A.cookies = [...ck('a0', 'one'), ...ck('a0', 'two')];
  const origClear = jar.clear;
  let first = true;
  jar.clear = async () => {
    if (first) { first = false; jar.live = jar.live.slice(1); throw new Error('remove failed'); }
    return origClear();
  };
  await assert.rejects(switcher.switchTo('B'), { message: 'remove failed' });
  assert.equal(store.state.activeId, 'A');
  assert.deepEqual(jar.live, [...ck('a1', 'one'), ...ck('a2', 'two')]);
  assert.equal(await switcher.syncActive(), true);
  assert.deepEqual(store.state.accounts.A.cookies, [...ck('a1', 'one'), ...ck('a2', 'two')]);
});

test('switchTo: if the rollback also fails, the active account is cleared rather than left wrong', async () => {
  const { store, jar, switcher } = setup();
  let restoreCalls = 0;
  jar.restore = async () => { restoreCalls++; throw new Error('still broken'); };
  await assert.rejects(switcher.switchTo('B'), { message: 'still broken' });
  assert.equal(restoreCalls, 2);
  assert.equal(store.state.activeId, null);
  assert.equal(store.state.switching, null);
  assert.equal(await switcher.syncActive(), false);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
});

// ---------------------------------------------------------------------------
// Mutex / isBusy
// ---------------------------------------------------------------------------

test('ops are serialized: a second switch starts only after the first finishes', async () => {
  const { log, jar, store, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p1 = switcher.switchTo('B');
  const p2 = switcher.switchTo('A');
  await tick();
  assert.deepEqual(names(log), ['jar.snapshot']);
  gate.resolve();
  await Promise.all([p1, p2]);
  const one = ['jar.snapshot', 'store.updateCookies', 'store.setSwitching', 'jar.clear', 'jar.restore', 'store.setActiveId', 'store.setSwitching', 'badge.show', 'siteData.resetTabs'];
  assert.deepEqual(names(log), [...one, ...one]);
  assert.equal(store.state.activeId, 'A');
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  assert.deepEqual(store.state.accounts.B.cookies, ck('b'));
});

test('a failed op does not jam the mutex', async () => {
  const { store, switcher } = setup();
  await assert.rejects(switcher.switchTo('nope'));
  await switcher.switchTo('B');
  assert.equal(store.state.activeId, 'B');
});

test('isBusy is true while a user op runs or is queued, false afterwards', async () => {
  const { jar, store, switcher } = setup();
  assert.equal(switcher.isBusy(), false);
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const removeGate = deferred();
  const origRemove = store.remove;
  store.remove = async (id) => { await removeGate.promise; return origRemove(id); };
  const p1 = switcher.switchTo('B');
  const p2 = switcher.remove('B');
  assert.equal(switcher.isBusy(), true);
  gate.resolve();
  await p1;
  assert.equal(switcher.isBusy(), true, 'remove still queued/running');
  removeGate.resolve();
  await p2;
  assert.equal(switcher.isBusy(), false);
});

test('isLocked is true while any state-changing op runs or is queued, user or background', async () => {
  const { jar, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 } });
  assert.equal(switcher.isLocked(), false);
  const recovering = switcher.recoverInterruptedSwitch();
  assert.equal(switcher.isLocked(), true);
  assert.equal(switcher.isBusy(), false, 'isBusy stays user-ops-only');
  await recovering;
  assert.equal(switcher.isLocked(), false);

  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const syncing = switcher.syncActive();
  assert.equal(switcher.isLocked(), true);
  assert.equal(switcher.isBusy(), false);
  gate.resolve();
  await syncing;

  const starting = switcher.restoreActiveOnStartup();
  assert.equal(switcher.isLocked(), true);
  await starting;

  const switching = switcher.switchTo('A');
  assert.equal(switcher.isLocked(), true);
  assert.equal(switcher.isBusy(), true);
  await switching;
  assert.equal(switcher.isLocked(), false);
});

test('isLocked ignores a read-only badge refresh (syncActive does not defer to it either)', async () => {
  const { switcher } = setup();
  const p = switcher.refreshBadge();
  assert.equal(switcher.isLocked(), false);
  await p;
});

test('isBusy stays false during syncActive and restoreActiveOnStartup', async () => {
  const { jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.syncActive();
  await tick();
  assert.equal(switcher.isBusy(), false);
  gate.resolve();
  await p;

  const restoreGate = deferred();
  const origRestore = jar.restore;
  jar.restore = async (c) => { await restoreGate.promise; return origRestore(c); };
  const p2 = switcher.restoreActiveOnStartup();
  await tick();
  assert.equal(switcher.isBusy(), false);
  restoreGate.resolve();
  await p2;
});

// ---------------------------------------------------------------------------
// syncActive
// ---------------------------------------------------------------------------

test('syncActive: snapshots live cookies into the active account', async () => {
  const { log, store, switcher } = setup();
  assert.equal(await switcher.syncActive(), true);
  assert.deepEqual(names(log), ['jar.snapshot', 'store.updateCookies']);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
});

test('syncActive: false and no-op when no account is active', async () => {
  const { log, switcher } = setup({ activeId: null });
  assert.equal(await switcher.syncActive(), false);
  assert.deepEqual(log, []);
});

test('syncActive: false and no-op while an add is pending', async () => {
  const { log, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 } });
  assert.equal(await switcher.syncActive(), false);
  assert.deepEqual(log, []);
});

test('syncActive: false and no-op while another op is running or queued', async () => {
  const { log, jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.switchTo('B');
  await tick();
  assert.equal(await switcher.syncActive(), false);
  gate.resolve();
  await p;
  assert.equal(names(log).filter((n) => n === 'jar.snapshot').length, 1);
  assert.equal(names(log).filter((n) => n === 'store.updateCookies').length, 1);
});

test('syncActive: not skipped just because a read-only badge refresh is in flight', async () => {
  const { store, badge, switcher } = setup();
  const gate = deferred();
  badge.show = async () => { await gate.promise; };
  const refreshP = switcher.refreshBadge();
  const syncP = switcher.syncActive();
  gate.resolve();
  await refreshP;
  assert.equal(await syncP, true);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
});

test('syncActive: a second concurrent sync is skipped', async () => {
  const { jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p1 = switcher.syncActive();
  assert.equal(await switcher.syncActive(), false);
  gate.resolve();
  assert.equal(await p1, true);
});

test('race: sync started before a switch never writes the target\'s cookies into the outgoing account', async () => {
  const { store, jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise; // sync's snapshot stalls; it reads live cookies only when released
  const syncP = switcher.syncActive();
  const switchP = switcher.switchTo('B');
  await tick();
  gate.resolve();
  const [synced] = await Promise.all([syncP, switchP]);
  assert.equal(synced, true);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  assert.deepEqual(store.state.accounts.B.cookies, ck('b'));
  assert.equal(store.state.activeId, 'B');
  assert.deepEqual(jar.live, ck('b'));
});

test('race: switch started before a sync — sync is skipped, accounts stay correct', async () => {
  const { store, jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const switchP = switcher.switchTo('B');
  const syncP = switcher.syncActive();
  gate.resolve();
  const [, synced] = await Promise.all([switchP, syncP]);
  assert.equal(synced, false);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  assert.deepEqual(store.state.accounts.B.cookies, ck('b'));
});

test('syncActive: re-checks activeId after the snapshot and drops the write if it changed', async () => {
  const { log, store, jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.syncActive();
  await tick();
  store.state.activeId = 'B'; // changed behind the switcher's back
  jar.live = ck('b-live');
  gate.resolve();
  assert.equal(await p, false);
  assert.equal(names(log).includes('store.updateCookies'), false);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
});

test('syncActive: drops the write if an add became pending during the snapshot', async () => {
  const { log, store, jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.syncActive();
  await tick();
  store.state.pending = { previousId: 'A', startedAt: 1 };
  gate.resolve();
  assert.equal(await p, false);
  assert.equal(names(log).includes('store.updateCookies'), false);
});

// ---------------------------------------------------------------------------
// Switching marker and crash recovery
// ---------------------------------------------------------------------------

test('switchTo: the marker is persisted before cookies are cleared', async () => {
  const { store, jar, switcher } = setup();
  let markerAtClear;
  const origClear = jar.clear;
  jar.clear = async () => { markerAtClear = structuredClone(store.state.switching); return origClear(); };
  await switcher.switchTo('B');
  assert.deepEqual(markerAtClear, { from: 'A', to: 'B', startedAt: 1000 });
});

test('syncActive: false and no-op while a switch marker is set (interrupted switch)', async () => {
  const { log, store, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 } });
  assert.equal(await switcher.syncActive(), false);
  assert.deepEqual(log, []);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
});

test('syncActive: drops the write if a switch marker appeared during the snapshot', async () => {
  const { log, store, jar, switcher } = setup();
  const gate = deferred();
  jar.snapshotGate = gate.promise;
  const p = switcher.syncActive();
  await tick();
  store.state.switching = { from: 'A', to: 'B', startedAt: 1 };
  gate.resolve();
  assert.equal(await p, false);
  assert.equal(names(log).includes('store.updateCookies'), false);
});

test('restoreActiveOnStartup: does nothing to cookies while a switch marker is set', async () => {
  const { log, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 } });
  await switcher.restoreActiveOnStartup();
  assert.deepEqual(names(log).filter((n) => n.startsWith('jar.')), []);
});

test('recoverInterruptedSwitch: no marker → no-op', async () => {
  const { log, switcher } = setup();
  assert.equal(await switcher.recoverInterruptedSwitch(), null);
  assert.deepEqual(log, []);
});

test('recoverInterruptedSwitch: finishes the switch to the target', async () => {
  // crashed after clear(): live jar holds a fragment of B, A is still "active"
  const { log, store, jar, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 }, live: ck('b-fragment') });
  const res = await switcher.recoverInterruptedSwitch();
  assert.deepEqual(res, { activeId: 'B', warnings: [] });
  assert.deepEqual(names(log), ['jar.clear', 'jar.restore', 'store.setActiveId', 'store.setSwitching', 'badge.show', 'siteData.resetTabs']);
  assert.deepEqual(log[1], ['jar.restore', ck('b')]);
  assert.deepEqual(jar.live, ck('b'));
  assert.equal(store.state.activeId, 'B');
  assert.equal(store.state.switching, null);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'), 'nothing written into the outgoing account');
});

test('recoverInterruptedSwitch: deep cleans when enabled', async () => {
  const { log, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 }, deepClean: true });
  await switcher.recoverInterruptedSwitch();
  const n = names(log);
  assert.ok(n.indexOf('siteData.deepClean') > n.indexOf('jar.clear'));
  assert.ok(n.indexOf('siteData.deepClean') < n.indexOf('jar.restore'));
});

test('recoverInterruptedSwitch: target gone → back to the outgoing account', async () => {
  const { store, jar, switcher } = setup({ switching: { from: 'A', to: 'gone', startedAt: 1 }, live: [] });
  assert.deepEqual(await switcher.recoverInterruptedSwitch(), { activeId: 'A', warnings: [] });
  assert.deepEqual(jar.live, ck('a-old'));
  assert.equal(store.state.activeId, 'A');
  assert.equal(store.state.switching, null);
});

test('recoverInterruptedSwitch: both gone → signed out, nothing active', async () => {
  const { store, jar, switcher } = setup({ switching: { from: null, to: 'gone', startedAt: 1 }, live: ck('fragment') });
  assert.deepEqual(await switcher.recoverInterruptedSwitch(), { activeId: null, warnings: [] });
  assert.deepEqual(jar.live, []);
  assert.equal(store.state.activeId, null);
  assert.equal(store.state.switching, null);
});

test('recoverInterruptedSwitch: restore failures become warnings', async () => {
  const { jar, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 } });
  jar.restoreFailed = [{ name: 'x', domain: '.zoho.com', error: 'e' }];
  const { warnings } = await switcher.recoverInterruptedSwitch();
  assert.equal(warnings.length, 1);
});

test('recoverInterruptedSwitch runs under the mutex: an op queued after it sees the recovered state', async () => {
  const { store, switcher } = setup({ switching: { from: 'A', to: 'B', startedAt: 1 } });
  const rec = switcher.recoverInterruptedSwitch();
  const sync = switcher.syncActive();
  await rec;
  assert.equal(await sync, false, 'sync queued during recovery is skipped, not run on the half-switched jar');
  assert.equal(store.state.activeId, 'B');
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
});

// ---------------------------------------------------------------------------
// Sign-out guard: a signed-out-looking live jar never replaces a saved session
// ---------------------------------------------------------------------------

test('syncActive: an external wipe (empty live jar) keeps the saved copy', async () => {
  const { log, store, jar, switcher } = setup();
  jar.live = [];
  const info = await captureInfo(async () => assert.equal(await switcher.syncActive(), false));
  assert.equal(names(log).includes('store.updateCookies'), false);
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
  assert.equal(info.length, 1);
  assert.match(info[0], /Account A/);
});

test('syncActive: a jar that lost every sign-in cookie (partial restore) does not shrink the saved copy', async () => {
  const { store, jar, switcher } = setup();
  const saved = [...ck('a-old'), hostCk('a-zm')];
  store.state.accounts.A.cookies = structuredClone(saved);
  jar.live = [hostCk('a-zm2')];
  await captureInfo(async () => assert.equal(await switcher.syncActive(), false));
  assert.deepEqual(store.state.accounts.A.cookies, saved);
});

test('syncActive: a normal rotation (anchor value changed, other cookies come and go) is saved', async () => {
  const { store, jar, switcher } = setup();
  store.state.accounts.A.cookies = [...ck('a-old'), hostCk('a-zm')];
  jar.live = [...ck('a-rotated'), hostCk('new', 'other')];
  assert.equal(await switcher.syncActive(), true);
  assert.deepEqual(store.state.accounts.A.cookies, jar.live);
});

test('switchTo: the outgoing snapshot keeps a saved session the live jar lost', async () => {
  const { store, jar, switcher } = setup();
  jar.live = [hostCk('stray')]; // e.g. Zoho's auth cookies expired client-side
  await captureInfo(() => switcher.switchTo('B'));
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
  assert.equal(store.state.activeId, 'B');
  assert.deepEqual(jar.live, ck('b'));
  await switcher.switchTo('A');
  assert.deepEqual(jar.live, ck('a-old'), 'switching back brings the intact session back');
});

test('beginAdd: the outgoing snapshot is guarded too', async () => {
  const { store, jar, switcher } = setup();
  jar.live = [];
  await captureInfo(() => switcher.beginAdd());
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-old'));
  assert.deepEqual(store.state.pending, { mode: 'signout', previousId: 'A', startedAt: 1000 });
});

// ---------------------------------------------------------------------------
// beginAdd / finishAdd / cancelAdd
// ---------------------------------------------------------------------------

test('beginAdd: saves active, marks pending, signs out, resets tabs, opens sign-in', async () => {
  const { log, store, jar, switcher } = setup();
  assert.deepEqual(await switcher.beginAdd(), { warnings: [], mode: 'signout' });
  assert.deepEqual(names(log), [
    'jar.snapshot',
    'store.updateCookies',
    'store.setPending',
    'store.setActiveId',
    'badge.show',
    'jar.clear',
    'siteData.resetTabs',
    'siteData.openSignIn',
  ]);
  assert.deepEqual(log[1], ['store.updateCookies', 'A', ck('a-live')]);
  assert.deepEqual(log[2], ['store.setPending', { mode: 'signout', previousId: 'A', startedAt: 1000 }]);
  assert.deepEqual(log[3], ['store.setActiveId', null]);
  assert.deepEqual(log[4], ['badge.show', null, true]);
  assert.deepEqual(jar.live, []);
  assert.equal(store.state.activeId, null);
});

test('beginAdd: deep clean after clearing cookies when enabled', async () => {
  const { log, switcher } = setup({ deepClean: true });
  await switcher.beginAdd();
  const n = names(log);
  assert.ok(n.indexOf('siteData.deepClean') > n.indexOf('jar.clear'));
  assert.ok(n.indexOf('siteData.deepClean') < n.indexOf('siteData.resetTabs'));
});

test('beginAdd: with no active account and nothing live records previousId null only', async () => {
  const { log, store, switcher } = setup({ activeId: null, live: [] });
  await switcher.beginAdd();
  assert.equal(names(log).includes('store.updateCookies'), false);
  assert.deepEqual(store.state.pending, { mode: 'signout', previousId: null, startedAt: 1000 });
});

test('beginAdd: an unsaved signed-in session (no active account) is stashed in pending, not saved', async () => {
  const { log, store, jar, switcher } = setup({ activeId: null, live: ck('unsaved') });
  await switcher.beginAdd();
  assert.deepEqual(store.state.pending, { mode: 'signout', previousId: null, startedAt: 1000, previousCookies: ck('unsaved') });
  assert.equal(names(log).includes('store.updateCookies'), false);
  assert.ok(names(log).indexOf('jar.snapshot') < names(log).indexOf('jar.clear'));
  assert.deepEqual(jar.live, []);
});

test('beginAdd: when already pending only reopens the sign-in tab', async () => {
  const pending = { previousId: 'A', startedAt: 5 };
  const { log, store, switcher } = setup({ activeId: null, pending });
  await switcher.beginAdd();
  assert.deepEqual(names(log), ['siteData.openSignIn']);
  assert.deepEqual(store.state.pending, pending);
});

test('finishAdd: snapshot → create → set active → clear pending → badge → reset tabs', async () => {
  const { log, store, jar, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 }, live: ck('c-live') });
  const acc = await switcher.finishAdd('  Carol  ');
  assert.deepEqual(names(log), ['jar.snapshot', 'store.create', 'store.setActiveId', 'store.setPending', 'badge.show', 'siteData.resetTabs']);
  assert.equal(acc.name, 'Carol');
  assert.deepEqual(acc.cookies, ck('c-live'));
  assert.equal(store.state.activeId, acc.id);
  assert.equal(store.state.pending, null);
  assert.deepEqual(log.at(-2), ['badge.show', acc.id, false]);
  assert.deepEqual(jar.live, ck('c-live'), 'live cookies untouched');
});

test('finishAdd: requires a pending add', async () => {
  const { log, switcher } = setup();
  await assert.rejects(switcher.finishAdd('Carol'), /no account is being added/i);
  assert.deepEqual(log, []);
});

test('finishAdd: a bad name propagates the store error and leaves pending intact', async () => {
  const pending = { previousId: 'A', startedAt: 1 };
  const { store, switcher } = setup({ activeId: null, pending });
  await assert.rejects(switcher.finishAdd('   '), { message: 'Name must be 1–40 characters' });
  assert.deepEqual(store.state.pending, pending);
  assert.equal(store.state.activeId, null);
  assert.deepEqual(store.state.order, ['A', 'B']);
});

test('cancelAdd: clear → restore previous → set it active → clear pending → badge → reset tabs', async () => {
  const { log, store, jar, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 }, live: ck('half-signed-in') });
  const res = await switcher.cancelAdd();
  assert.deepEqual(res, { warnings: [] });
  assert.deepEqual(names(log), ['jar.clear', 'jar.restore', 'store.setActiveId', 'store.setPending', 'badge.show', 'siteData.resetTabs']);
  assert.deepEqual(log[1], ['jar.restore', ck('a-old')]);
  assert.deepEqual(jar.live, ck('a-old'));
  assert.equal(store.state.activeId, 'A');
  assert.equal(store.state.pending, null);
  assert.equal(names(log).includes('store.updateCookies'), false, 'half-finished sign-in is discarded, not saved');
});

test('cancelAdd: deep clean when enabled', async () => {
  const { log, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 }, deepClean: true });
  await switcher.cancelAdd();
  const n = names(log);
  assert.ok(n.includes('siteData.deepClean'));
  assert.ok(n.indexOf('siteData.deepClean') < n.indexOf('siteData.resetTabs'));
});

test('cancelAdd: previous account removed meanwhile → just signs out, nothing active', async () => {
  const { log, store, jar, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 }, live: ck('half') });
  await switcher.remove('A');
  log.length = 0;
  await switcher.cancelAdd();
  assert.equal(names(log).includes('jar.restore'), false);
  assert.equal(store.state.activeId, null);
  assert.equal(store.state.pending, null);
  assert.deepEqual(jar.live, []);
});

test('cancelAdd: previousId null → signs out, nothing active', async () => {
  const { store, jar, switcher } = setup({ activeId: null, pending: { previousId: null, startedAt: 1 }, live: ck('half') });
  await switcher.cancelAdd();
  assert.equal(store.state.activeId, null);
  assert.equal(store.state.pending, null);
  assert.deepEqual(jar.live, []);
});

test('cancelAdd: previousId null → puts the stashed unsaved session back, nothing active', async () => {
  const pending = { previousId: null, startedAt: 1, previousCookies: ck('unsaved') };
  const { log, store, jar, switcher } = setup({ activeId: null, pending, live: ck('half') });
  assert.deepEqual(await switcher.cancelAdd(), { warnings: [] });
  assert.deepEqual(names(log), ['jar.clear', 'jar.restore', 'store.setActiveId', 'store.setPending', 'badge.show', 'siteData.resetTabs']);
  assert.deepEqual(log[1], ['jar.restore', ck('unsaved')]);
  assert.deepEqual(jar.live, ck('unsaved'));
  assert.equal(store.state.activeId, null);
  assert.equal(store.state.pending, null);
});

test('cancelAdd: failures restoring the stashed session become warnings', async () => {
  const pending = { previousId: null, startedAt: 1, previousCookies: ck('unsaved') };
  const { jar, switcher } = setup({ activeId: null, pending });
  jar.restoreFailed = [{ name: 'x', domain: '.zoho.com', error: 'e' }];
  assert.equal((await switcher.cancelAdd()).warnings.length, 1);
});

test('cancelAdd: restore failures become warnings', async () => {
  const { jar, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 } });
  jar.restoreFailed = [{ name: 'x', domain: '.zoho.com', error: 'e' }];
  assert.deepEqual(await switcher.cancelAdd(), { warnings: ['Could not restore 1 cookie: x (.zoho.com)'] });
});

test('cancelAdd: requires a pending add', async () => {
  const { log, switcher } = setup();
  await assert.rejects(switcher.cancelAdd(), /no account is being added/i);
  assert.deepEqual(log, []);
});

test('full add flow: begin → finish keeps both accounts intact', async () => {
  const { store, jar, switcher } = setup();
  await switcher.beginAdd();
  jar.live = ck('c'); // user signs in to the new account
  const acc = await switcher.finishAdd('Carol');
  assert.deepEqual(store.state.accounts.A.cookies, ck('a-live'));
  assert.deepEqual(store.state.accounts[acc.id].cookies, ck('c'));
  await switcher.switchTo('A');
  assert.deepEqual(jar.live, ck('a-live'));
  assert.deepEqual(store.state.accounts[acc.id].cookies, ck('c'));
});

// ---------------------------------------------------------------------------
// saveCurrentAs / remove / startup / badge
// ---------------------------------------------------------------------------

test('saveCurrentAs: snapshot → create → set active → badge', async () => {
  const { log, store, switcher } = setup({ activeId: null, live: ck('existing') });
  const acc = await switcher.saveCurrentAs('Existing');
  assert.deepEqual(names(log), ['jar.snapshot', 'store.create', 'store.setActiveId', 'badge.show']);
  assert.deepEqual(acc.cookies, ck('existing'));
  assert.equal(store.state.activeId, acc.id);
});

test('saveCurrentAs: rejected while pending', async () => {
  const { log, switcher } = setup({ activeId: null, pending: { previousId: null, startedAt: 1 } });
  await assert.rejects(switcher.saveCurrentAs('X'), { message: 'Finish or cancel adding an account first' });
  assert.deepEqual(log, []);
});

test('saveCurrentAs: rejected when an account is already active', async () => {
  const { log, switcher } = setup();
  await assert.rejects(switcher.saveCurrentAs('X'), /already active/i);
  assert.deepEqual(log, []);
});

test('saveCurrentAs: bad name propagates the store error', async () => {
  const { store, switcher } = setup({ activeId: null });
  await assert.rejects(switcher.saveCurrentAs(''), { message: 'Name must be 1–40 characters' });
  assert.equal(store.state.activeId, null);
});

test('remove: only deletes the saved snapshot, never touches live cookies', async () => {
  const { log, store, jar, switcher } = setup();
  await switcher.remove('A');
  assert.deepEqual(names(log), ['store.remove', 'badge.show']);
  assert.deepEqual(log.at(-1), ['badge.show', null, false]);
  assert.deepEqual(jar.live, ck('a-live'));
  assert.equal(store.state.activeId, null);
  assert.equal(store.state.accounts.A, undefined);
});

test('restoreActiveOnStartup: re-applies only missing cookies, without clearing; nothing missing → no reload', async () => {
  const { log, switcher } = setup();
  await switcher.restoreActiveOnStartup();
  assert.deepEqual(names(log), ['jar.restore', 'badge.show']);
  assert.deepEqual(log[0], ['jar.restore', ck('a-old'), { onlyMissing: true }]);
});

test('restoreActiveOnStartup: cookies the restart dropped are put back and Zoho tabs reloaded', async () => {
  const { log, jar, switcher } = setup({ live: [] });
  const res = await switcher.restoreActiveOnStartup();
  assert.equal(res.restored, 1);
  assert.deepEqual(names(log), ['jar.restore', 'badge.show', 'siteData.resetTabs']);
  assert.deepEqual(jar.live, ck('a-old'));
});

test('restoreActiveOnStartup: never overwrites a newer live cookie with the stale saved one', async () => {
  const { store, jar, switcher } = setup({ live: ck('a-newer') });
  store.state.accounts.A.cookies = [...ck('a-old'), hostCk('a-zm')];
  await switcher.restoreActiveOnStartup();
  assert.deepEqual(jar.live, [...ck('a-newer'), hostCk('a-zm')]);
});

test('restoreActiveOnStartup: does nothing to cookies while pending or with no active account', async () => {
  for (const opts of [{ activeId: null }, { activeId: null, pending: { previousId: 'A', startedAt: 1 } }]) {
    const { log, switcher } = setup(opts);
    await switcher.restoreActiveOnStartup();
    assert.deepEqual(names(log).filter((n) => n.startsWith('jar.')), []);
  }
});

test('refreshBadge: shows the active account summary', async () => {
  const { badge, switcher } = setup();
  await switcher.refreshBadge();
  assert.equal(badge.shown.length, 1);
  assert.equal(badge.shown[0].active.id, 'A');
  assert.equal(badge.shown[0].active.name, 'Account A');
  assert.equal(badge.shown[0].pending, false);
});

test('refreshBadge: pending wins', async () => {
  const { badge, switcher } = setup({ activeId: null, pending: { previousId: 'A', startedAt: 1 } });
  await switcher.refreshBadge();
  assert.deepEqual(badge.shown[0], { active: null, pending: true });
});

test('a badge failure never fails an op', async () => {
  const { badge, store, switcher } = setup();
  badge.show = async () => { throw new Error('no action API'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await switcher.switchTo('B');
  } finally {
    console.warn = warn;
  }
  assert.equal(store.state.activeId, 'B');
});
