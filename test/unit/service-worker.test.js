// The whole service worker (lib/service-worker.js, what background.js runs)
// against the fake chrome: real jar, store, switcher, router and schedulers;
// fake timers for the debounces. Focus: the regular profile stays isolated
// from the Incognito store and tabs now that the manifest is "spanning".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServiceWorker } from '../../extension/lib/service-worker.js';
import { SIGN_IN_URL } from '../../extension/lib/zoho-domains.js';
import { createFakeChrome, INCOGNITO_STORE_ID } from '../helpers/fake-chrome.js';

const FUTURE = Date.now() / 1000 + 86_400;

function fakeTimers() {
  let clock = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    get size() { return pending.size; },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        await settle();
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        await due[1].fn();
      }
      clock = Math.max(clock, until);
      await settle();
    },
  };
}

// Lets fake-API callbacks (setTimeout 0) and listener promise chains run.
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 2));
}

/** What a signed-in Zoho user's cookies look like, in one cookie store. */
async function signIn(cookies, user, storeId = '0') {
  const at = (d) => ({ ...d, ...(storeId === '0' ? {} : { storeId }) });
  for (const name of ['_iamadt', '_iambdt']) {
    await cookies.set(at({ url: 'https://accounts.zoho.com/', domain: '.zoho.com', name, value: `${name}-${user}`, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURE }));
  }
  await cookies.set(at({ url: 'https://accounts.zoho.com/', name: 'iamcsr', value: `csr-${user}`, path: '/', secure: true, sameSite: 'strict' }));
  await cookies.set(at({ url: 'https://mail.zoho.com/', name: 'zmsess', value: `mail-${user}`, path: '/', secure: true, sameSite: 'lax' }));
}

const values = (list) => Object.fromEntries(list.map((c) => [c.name, c.value]));
const stored = (fake) => fake.storage.dump();
const savedValues = (fake, id) => values(stored(fake).accounts[id].cookies);

async function boot({ incognitoAllowed = true } = {}) {
  const fake = createFakeChrome({ incognitoAllowed });
  fake.addTab({ url: 'https://mail.zoho.com/zm/' });
  const timers = fakeTimers();
  const sw = startServiceWorker(fake.chrome, { timers, privateWindowOptions: { sleep: async () => {} } });
  await sw.ready;
  return { fake, timers, sw };
}

/** Alice saved and active (signed in in the regular profile). */
async function aliceActive(opts) {
  const w = await boot(opts);
  await signIn(w.fake.cookies, 'alice');
  const r = await w.fake.send({ type: 'saveCurrentAs', name: 'Alice' });
  assert.equal(r.ok, true, r.error);
  await w.timers.advance(2000); // drain the sync the sign-in scheduled
  return { ...w, aliceId: r.state.activeId };
}

test('registers every listener synchronously, cookies.onChanged and windows.onRemoved included', () => {
  const fake = createFakeChrome();
  startServiceWorker(fake.chrome, { timers: fakeTimers() });
  assert.equal(fake.cookies.onChanged.size, 1);
  for (const e of ['onStartup', 'onInstalled', 'onMessage', 'windowsOnRemoved']) assert.equal(fake.events[e].size, 1, e);
});

test('getState reports incognitoAllowed', async () => {
  const { fake } = await boot();
  assert.equal((await fake.send({ type: 'getState' })).state.incognitoAllowed, true);
  fake.incognitoAllowed = false;
  assert.equal((await fake.send({ type: 'getState' })).state.incognitoAllowed, false);
});

test('private add end to end: Alice stays active and signed in; Carol\'s Incognito session becomes a new account', async () => {
  const { fake, timers, aliceId } = await aliceActive();
  const aliceSaved = savedValues(fake, aliceId);
  const regularBefore = fake.cookies.dump();

  let r = await fake.send({ type: 'beginAdd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.activeId, aliceId);
  assert.deepEqual(r.state.pending, { previousId: aliceId, startedAt: r.state.pending.startedAt, mode: 'private', windowOpen: true, captured: false });
  const [win] = fake.incognitoWindows();
  assert.equal(win.tabs[0].url, SIGN_IN_URL);
  assert.equal(fake.badge.text, '+');
  assert.equal(fake.log.some(([n]) => n === 'tabs.reload'), false, 'no regular tab was reloaded');

  // Carol signs in in the private window.
  await signIn(fake.cookies, 'carol', INCOGNITO_STORE_ID);
  await timers.advance(500);
  r = await fake.send({ type: 'getState' });
  assert.equal(r.state.pending.captured, true);
  assert.doesNotMatch(JSON.stringify(r), /carol/);
  await timers.advance(15_000);
  assert.deepEqual(savedValues(fake, aliceId), aliceSaved, 'Incognito changes never synced into Alice');
  assert.deepEqual(Object.keys(stored(fake).accounts), [aliceId], 'no account holds Carol before Save');
  assert.deepEqual(fake.cookies.dump(), regularBefore, 'regular jar untouched');

  r = await fake.send({ type: 'finishAdd', name: 'Carol' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.notice, 'Saved “Carol”. Click it to switch.');
  assert.equal(r.state.activeId, aliceId);
  assert.equal(r.state.pending, null);
  const carol = r.state.accounts.find((a) => a.name === 'Carol');
  assert.equal(savedValues(fake, carol.id)._iamadt, '_iamadt-carol');
  assert.deepEqual(fake.incognitoWindows(), [], 'private window closed');
  assert.deepEqual(fake.cookies.dump(), regularBefore);
  assert.equal(fake.badge.title, 'Zoho: Alice');

  // Switching to Carol later is the ordinary switch.
  r = await fake.send({ type: 'switch', id: carol.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(values(fake.cookies.dump())._iamadt, '_iamadt-carol');
  assert.equal(savedValues(fake, aliceId)._iamadt, '_iamadt-alice');
});

test('Alice keeps syncing during a private add (regular-store rotation is saved)', async () => {
  const { fake, timers, aliceId } = await aliceActive();
  await fake.send({ type: 'beginAdd' });
  await fake.cookies.set({ url: 'https://accounts.zoho.com/', domain: '.zoho.com', name: '_iambdt', value: 'rotated', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURE });
  await timers.advance(1500);
  assert.equal(savedValues(fake, aliceId)._iambdt, 'rotated');
});

test('Incognito cookie changes never call syncActive (with or without a private add); regular ones do', async () => {
  const { fake, timers, sw } = await aliceActive();
  let syncs = 0;
  let captures = 0;
  const { syncActive, capturePrivate } = sw.switcher;
  sw.switcher.syncActive = (...a) => { syncs += 1; return syncActive(...a); };
  sw.switcher.capturePrivate = (...a) => { captures += 1; return capturePrivate(...a); };

  fake.addTab({ url: 'https://mail.zoho.com/', incognito: true });
  await signIn(fake.cookies, 'mallory', INCOGNITO_STORE_ID); // no add pending
  await timers.advance(15_000);
  assert.deepEqual([syncs, captures], [0, 0]);

  await fake.send({ type: 'beginAdd' });
  await signIn(fake.cookies, 'carol', INCOGNITO_STORE_ID); // the private add's store
  await timers.advance(15_000);
  assert.deepEqual([syncs, captures], [0, 1]);

  await fake.cookies.set({ url: 'https://mail.zoho.com/', name: 'zmsess', value: 'mail-alice-2', path: '/', secure: true, sameSite: 'lax' });
  await timers.advance(15_000);
  assert.deepEqual([syncs, captures], [1, 1]);
});

test('an Incognito cookie change with no private add pending is ignored entirely', async () => {
  const { fake, timers, aliceId } = await aliceActive();
  const before = stored(fake);
  fake.addTab({ url: 'https://mail.zoho.com/', incognito: true }); // the user's own Incognito browsing
  await signIn(fake.cookies, 'mallory', INCOGNITO_STORE_ID);
  await timers.advance(15_000);
  assert.deepEqual(stored(fake), before);
  assert.equal(savedValues(fake, aliceId)._iamadt, '_iamadt-alice');
});

test('a switch never reloads Incognito tabs or touches the Incognito store', async () => {
  const { fake, aliceId } = await aliceActive();
  await fake.send({ type: 'beginAdd' });
  await signIn(fake.cookies, 'bob', INCOGNITO_STORE_ID);
  const bob = (await fake.send({ type: 'finishAdd', name: 'Bob' })).state.accounts.find((a) => a.name === 'Bob');
  const incognitoTab = fake.addTab({ url: 'https://mail.zoho.com/', incognito: true });
  await signIn(fake.cookies, 'mallory', INCOGNITO_STORE_ID);
  const incognitoBefore = fake.cookies.dump(INCOGNITO_STORE_ID);
  fake.log.length = 0;
  let r = await fake.send({ type: 'switch', id: bob.id });
  assert.equal(r.ok, true, r.error);
  r = await fake.send({ type: 'switch', id: aliceId });
  assert.equal(r.ok, true, r.error);
  assert.equal(fake.log.some(([n, id]) => (n === 'tabs.reload' || n === 'scripting.executeScript') && id === incognitoTab), false);
  assert.ok(fake.log.some(([n]) => n === 'tabs.reload'), 'the regular Zoho tab was reloaded');
  assert.deepEqual(fake.cookies.dump(INCOGNITO_STORE_ID), incognitoBefore);
});

test('closing the private window keeps the add pending; Save uses what was captured', async () => {
  const { fake, timers, aliceId } = await aliceActive();
  await fake.send({ type: 'beginAdd' });
  await signIn(fake.cookies, 'carol', INCOGNITO_STORE_ID);
  await timers.advance(500);
  fake.closeWindow(fake.incognitoWindows()[0].id); // the user closes it; its cookies are gone
  await settle();
  let r = await fake.send({ type: 'getState' });
  assert.deepEqual([r.state.pending.windowOpen, r.state.pending.captured], [false, true]);
  assert.equal(stored(fake).pending.windowId, null);
  r = await fake.send({ type: 'finishAdd', name: 'Carol' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.activeId, aliceId);
  assert.equal(savedValues(fake, r.state.accounts.find((a) => a.name === 'Carol').id)._iamadt, '_iamadt-carol');
});

test('closed before signing in: Save is refused and the add stays pending; Add reopens the window', async () => {
  const { fake } = await aliceActive();
  await fake.send({ type: 'beginAdd' });
  fake.closeWindow(fake.incognitoWindows()[0].id);
  await settle();
  let r = await fake.send({ type: 'finishAdd', name: 'Carol' });
  assert.deepEqual([r.ok, r.error], [false, 'Sign in to Zoho in the private window first']);
  assert.equal(r.state.pending.mode, 'private');
  r = await fake.send({ type: 'beginAdd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.pending.windowOpen, true);
  assert.equal(fake.incognitoWindows().length, 1);
});

test('Add while the private window is open focuses it instead of opening another', async () => {
  const { fake } = await aliceActive();
  await fake.send({ type: 'beginAdd' });
  await fake.chrome.windows.update(1, { focused: true });
  await fake.send({ type: 'beginAdd' });
  assert.equal(fake.incognitoWindows().length, 1);
  assert.equal(fake.incognitoWindows()[0].focused, true);
});

test('cancel closes the private window and clears its Zoho cookies; Alice untouched', async () => {
  const { fake, aliceId } = await aliceActive();
  const regularBefore = fake.cookies.dump();
  await fake.send({ type: 'beginAdd' });
  fake.addTab({ url: 'https://example.com/', incognito: true, newWindow: true }); // another Incognito window keeps the store alive
  await signIn(fake.cookies, 'carol', INCOGNITO_STORE_ID);
  const r = await fake.send({ type: 'cancelAdd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.activeId, aliceId);
  assert.equal(r.state.pending, null);
  assert.deepEqual(fake.cookies.dump(INCOGNITO_STORE_ID), []);
  assert.equal(fake.incognitoWindows().length, 1, 'only the user\'s own Incognito window is left');
  assert.deepEqual(fake.cookies.dump(), regularBefore);
});

test('Incognito not allowed: the sign-out flow, and the settings shortcut', async () => {
  const { fake, aliceId } = await aliceActive({ incognitoAllowed: false });
  let r = await fake.send({ type: 'beginAdd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.activeId, null);
  assert.equal(r.state.pending.mode, 'signout');
  assert.deepEqual(fake.incognitoWindows(), []);
  assert.deepEqual(fake.cookies.dump(), []);
  r = await fake.send({ type: 'cancelAdd' });
  assert.equal(r.state.activeId, aliceId);
  r = await fake.send({ type: 'openIncognitoSettings' });
  assert.equal(r.ok, true, r.error);
  assert.ok(fake.log.some(([n, url]) => n === 'tabs.create' && url === 'chrome://extensions/?id=testextensionid'));
});

test('old stored pending without mode keeps working as a sign-out add after the update', async () => {
  const fake = createFakeChrome({ storage: { pending: { previousId: null, startedAt: 1 } } });
  const timers = fakeTimers();
  const sw = startServiceWorker(fake.chrome, { timers });
  await sw.ready;
  let r = await fake.send({ type: 'getState' });
  assert.deepEqual(r.state.pending, { previousId: null, startedAt: 1, mode: 'signout', windowOpen: false, captured: false });
  await signIn(fake.cookies, 'dave');
  r = await fake.send({ type: 'finishAdd', name: 'Dave' });
  assert.equal(r.ok, true, r.error);
  assert.equal('notice' in r, false);
  assert.equal(r.state.activeId, r.state.accounts[0].id, 'the sign-out flow activates the new account');
});

test('browser restart during a private add: Alice\'s session comes back, the private window counts as closed', async () => {
  const { fake, timers, aliceId } = await aliceActive();
  await fake.send({ type: 'beginAdd' });
  await signIn(fake.cookies, 'carol', INCOGNITO_STORE_ID);
  await timers.advance(500);
  // Restart: Incognito windows and session cookies are gone, listeners re-register.
  fake.restartWorker();
  fake.closeWindow(fake.incognitoWindows()[0].id);
  for (const c of fake.cookies.dump().filter((x) => x.session)) await fake.cookies.remove({ url: `https://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name });
  const sw2 = startServiceWorker(fake.chrome, { timers: fakeTimers() });
  await sw2.ready;
  fake.events.onStartup.fire();
  await settle(10);
  const r = await fake.send({ type: 'getState' });
  assert.deepEqual([r.state.activeId, r.state.pending.windowOpen, r.state.pending.captured], [aliceId, false, true]);
  assert.equal(values(fake.cookies.dump()).zmsess, 'mail-alice', 'session cookie restored');
});
