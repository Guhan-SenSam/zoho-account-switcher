import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, createCookieSyncScheduler, SYNC_DEBOUNCE_MS, SYNC_MAX_WAIT_MS } from '../../extension/lib/router.js';

const EXT = 'chrome-extension://abcdefghijklmnop/';
const popup = { id: 'abcdefghijklmnop', url: `${EXT}popup/popup.html` };

function setup() {
  const calls = [];
  const state = {
    accounts: { A: { id: 'A', name: 'Alpha' } },
    order: ['A'],
    activeId: 'A',
    settings: { deepClean: false },
    pending: null,
  };
  const store = {
    async getState() { return structuredClone(state); },
    async list() { return state.order.map((id) => ({ id, name: state.accounts[id].name, color: '#000', initials: 'AL', cookieCount: 0 })); },
    async rename(id, name) {
      calls.push(['store.rename', id, name]);
      if (!state.accounts[id]) throw new Error('Unknown account');
      if (!String(name).trim()) throw new Error('Name must be 1–40 characters');
      state.accounts[id].name = name.trim();
    },
    async updateSettings(patch) {
      calls.push(['store.updateSettings', patch]);
      Object.assign(state.settings, patch);
      return structuredClone(state.settings);
    },
  };
  let busy = false;
  const switcher = {
    setBusy(v) { busy = v; },
    isBusy() { return busy; },
    async switchTo(id) {
      calls.push(['switchTo', id]);
      if (id !== 'A' && id !== 'B') throw new Error('Unknown account');
      state.activeId = id;
      return { warnings: ['1 cookie could not be restored'] };
    },
    async beginAdd() { calls.push(['beginAdd']); state.pending = { previousId: 'A', startedAt: 1 }; return { warnings: [] }; },
    async finishAdd(name) { calls.push(['finishAdd', name]); state.pending = null; return { id: 'C', name }; },
    async cancelAdd() { calls.push(['cancelAdd']); state.pending = null; return { warnings: ['x'] }; },
    async saveCurrentAs(name) { calls.push(['saveCurrentAs', name]); return { id: 'C', name }; },
    async remove(id) { calls.push(['remove', id]); },
    async refreshBadge() { calls.push(['refreshBadge']); },
  };
  const router = createRouter({ switcher, store, extensionUrl: EXT });
  return { router, switcher, store, state, calls };
}

test('getState returns the full state shape', async () => {
  const { router } = setup();
  const res = await router.handle({ type: 'getState' }, popup);
  assert.deepEqual(res, {
    ok: true,
    state: {
      accounts: [{ id: 'A', name: 'Alpha', color: '#000', initials: 'AL', cookieCount: 0 }],
      activeId: 'A',
      pending: null,
      settings: { deepClean: false },
      busy: false,
    },
  });
});

test('state.pending never carries the stashed session cookies', async () => {
  const { router, state } = setup();
  state.pending = { previousId: null, startedAt: 5, previousCookies: [{ name: 'IAM', value: 'secret' }] };
  const res = await router.handle({ type: 'getState' }, popup);
  assert.deepEqual(res.state.pending, { previousId: null, startedAt: 5 });
});

test('state.busy mirrors switcher.isBusy()', async () => {
  const { router, switcher } = setup();
  switcher.setBusy(true);
  assert.equal((await router.handle({ type: 'getState' }, popup)).state.busy, true);
});

test('rejects senders outside the extension', async () => {
  const { router, calls } = setup();
  for (const sender of [
    { url: 'https://mail.zoho.com/' },
    { url: 'chrome-extension://someotherextension/popup.html' },
    {},
    undefined,
  ]) {
    const res = await router.handle({ type: 'switch', id: 'B' }, sender);
    assert.equal(res.ok, false);
    assert.match(res.error, /not allowed/i);
    assert.equal(res.state, null, 'no state leaked to foreign senders');
  }
  assert.deepEqual(calls, []);
});

test('switch passes the id and returns warnings', async () => {
  const { router, calls } = setup();
  const res = await router.handle({ type: 'switch', id: 'B' }, popup);
  assert.deepEqual(calls, [['switchTo', 'B']]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, ['1 cookie could not be restored']);
  assert.equal(res.state.activeId, 'B');
});

test('op errors become { ok:false, error, state }', async () => {
  const { router } = setup();
  const res = await router.handle({ type: 'switch', id: 'nope' }, popup);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Unknown account');
  assert.equal(res.state.activeId, 'A');
});

test('beginAdd / cancelAdd pass warnings through', async () => {
  const { router, calls } = setup();
  const r1 = await router.handle({ type: 'beginAdd' }, popup);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.state.pending, { previousId: 'A', startedAt: 1 });
  const r2 = await router.handle({ type: 'cancelAdd' }, popup);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.warnings, ['x']);
  assert.deepEqual(calls, [['beginAdd'], ['cancelAdd']]);
});

test('finishAdd and saveCurrentAs pass the name (non-strings become "")', async () => {
  const { router, calls } = setup();
  assert.equal((await router.handle({ type: 'finishAdd', name: 'Carol' }, popup)).ok, true);
  assert.equal((await router.handle({ type: 'saveCurrentAs', name: 'Dave' }, popup)).ok, true);
  await router.handle({ type: 'finishAdd' }, popup);
  assert.deepEqual(calls, [['finishAdd', 'Carol'], ['saveCurrentAs', 'Dave'], ['finishAdd', '']]);
});

test('rename goes to the store and refreshes the badge', async () => {
  const { router, calls } = setup();
  const res = await router.handle({ type: 'rename', id: 'A', name: 'Ops' }, popup);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['store.rename', 'A', 'Ops'], ['refreshBadge']]);
  assert.equal(res.state.accounts[0].name, 'Ops');
});

test('rename errors propagate', async () => {
  const { router } = setup();
  const res = await router.handle({ type: 'rename', id: 'A', name: '  ' }, popup);
  assert.deepEqual([res.ok, res.error], [false, 'Name must be 1–40 characters']);
});

test('remove goes through the switcher', async () => {
  const { router, calls } = setup();
  assert.equal((await router.handle({ type: 'remove', id: 'A' }, popup)).ok, true);
  assert.deepEqual(calls, [['remove', 'A']]);
});

test('setSettings forwards only known boolean settings', async () => {
  const { router, calls } = setup();
  const res = await router.handle({ type: 'setSettings', patch: { deepClean: true, evil: 1 } }, popup);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['store.updateSettings', { deepClean: true }]]);
  assert.deepEqual(res.state.settings, { deepClean: true });
});

test('setSettings rejects a missing patch', async () => {
  const { router, calls } = setup();
  const res = await router.handle({ type: 'setSettings' }, popup);
  assert.equal(res.ok, false);
  assert.deepEqual(calls, []);
});

test('unknown or malformed requests are rejected', async () => {
  const { router } = setup();
  for (const msg of [{ type: 'explode' }, {}, null, 'switch']) {
    const res = await router.handle(msg, popup);
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown request/i);
  }
});

test('if state cannot be read, errors still respond with state: null', async () => {
  const { router, store } = setup();
  store.getState = async () => { throw new Error('storage gone'); };
  const res = await router.handle({ type: 'getState' }, popup);
  assert.deepEqual(res, { ok: false, error: 'storage gone', state: null });
});

// ---------------------------------------------------------------------------
// Cookie-change debounce
// ---------------------------------------------------------------------------

function fakeTimers() {
  let clock = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => clock,
    set: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: clock + ms }); return id; },
    clear: (id) => { pending.delete(id); },
    get size() { return pending.size; },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        await due[1].fn();
      }
      clock = Math.max(clock, until); // monotonic even when advance() calls overlap
    },
  };
}

// syncs records the (fake) time of each syncActive() call.
function scheduler({ locked = () => false, busy = () => false, syncActive } = {}) {
  const timers = fakeTimers();
  const syncs = [];
  const switcher = {
    isBusy: busy,
    isLocked: locked,
    async syncActive() { syncs.push(timers.now()); return syncActive ? syncActive() : true; },
  };
  const s = createCookieSyncScheduler({ switcher, setTimer: timers.set, clearTimer: timers.clear, now: timers.now });
  return { s, timers, syncs };
}

const change = (domain) => ({ removed: false, cause: 'explicit', cookie: { name: 'x', domain } });

test('debounce is 1500 ms', () => {
  assert.equal(SYNC_DEBOUNCE_MS, 1500);
});

test('a Zoho cookie change syncs once, 1500 ms after the last change', async () => {
  const { s, timers, syncs } = scheduler();
  s.onCookieChanged(change('.zoho.com'));
  await timers.advance(1000);
  s.onCookieChanged(change('mail.zoho.eu'));
  await timers.advance(1499);
  assert.equal(syncs.length, 0);
  await timers.advance(1);
  assert.equal(syncs.length, 1);
  await timers.advance(10_000);
  assert.equal(syncs.length, 1);
});

test('non-Zoho cookie changes are ignored', async () => {
  const { s, timers, syncs } = scheduler();
  for (const d of ['.google.com', 'notzoho.com', '.zoho.com.evil.net', undefined]) s.onCookieChanged(change(d));
  s.onCookieChanged({});
  await timers.advance(5000);
  assert.equal(syncs.length, 0);
  assert.equal(timers.size, 0);
});

test('max wait is 10 s', () => {
  assert.equal(SYNC_MAX_WAIT_MS, 10_000);
});

test('while any switcher op holds the lock the sync is postponed, not dropped', async () => {
  let locked = true;
  // isBusy (user ops only) is false: a background op (sync, startup restore,
  // recovery) still holds the switcher, and syncActive would drop the call.
  const { s, timers, syncs } = scheduler({ locked: () => locked, busy: () => false });
  s.onCookieChanged(change('.zoho.com'));
  await timers.advance(1500);
  assert.equal(syncs.length, 0);
  await timers.advance(1500);
  assert.equal(syncs.length, 0);
  locked = false;
  await timers.advance(1500);
  assert.equal(syncs.length, 1);
});

test('a change during a running sync is postponed until it finishes, then synced', async () => {
  let locked = false;
  let release = null;
  const { s, timers, syncs } = scheduler({
    locked: () => locked,
    // the first sync hangs (holding the lock) until released
    syncActive: () => {
      if (release) return true;
      locked = true;
      return new Promise((r) => { release = () => { locked = false; r(true); }; });
    },
  });
  s.onCookieChanged(change('.zoho.com'));
  const first = timers.advance(1500); // first sync starts and hangs
  await new Promise((r) => setImmediate(r));
  assert.equal(syncs.length, 1);
  s.onCookieChanged(change('.zoho.com')); // rotation while the first sync runs
  await timers.advance(1500); // its timer fires while the first sync still holds the lock
  assert.equal(syncs.length, 1, 'postponed, not handed to syncActive (which would drop it)');
  release();
  await first;
  await timers.advance(1500);
  assert.equal(syncs.length, 2);
});

test('continuous cookie churn: a sync runs no later than 10 s after the first unsynced change', async () => {
  const { s, timers, syncs } = scheduler();
  for (let i = 0; i < 30; i += 1) {
    s.onCookieChanged(change('.zoho.com'));
    await timers.advance(1000);
  }
  assert.deepEqual(syncs, [10_000, 20_000, 30_000]);
});

test('the max wait is still postponed while locked', async () => {
  let locked = true;
  const { s, timers, syncs } = scheduler({ locked: () => locked });
  for (let t = 0; t < 12_000; t += 1000) {
    s.onCookieChanged(change('.zoho.com'));
    await timers.advance(1000);
  }
  assert.deepEqual(syncs, []);
  locked = false;
  await timers.advance(1500);
  assert.equal(syncs.length, 1);
  assert.ok(syncs[0] <= 13_500, `synced at ${syncs[0]}`);
});

test('a failing sync is logged, not thrown', async () => {
  const timers = fakeTimers();
  const switcher = { isBusy: () => false, isLocked: () => false, async syncActive() { throw new Error('nope'); } };
  const s = createCookieSyncScheduler({ switcher, setTimer: timers.set, clearTimer: timers.clear, log: () => {} });
  s.onCookieChanged(change('.zoho.com'));
  await timers.advance(1500);
});
