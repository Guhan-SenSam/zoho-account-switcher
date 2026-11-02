// The real cookie jar, account store and switcher wired to the chrome.cookies /
// chrome.storage fakes: end-to-end scenarios for the data-loss guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCookieJar } from '../../extension/lib/cookie-jar.js';
import { createAccountStore } from '../../extension/lib/accounts.js';
import { createSwitcher } from '../../extension/lib/switcher.js';
import { createFakeCookies } from '../helpers/fake-cookies.js';
import { createFakeStorage } from '../helpers/fake-storage.js';

const NOW_MS = 1_800_000_000_000;
const FUTURE = NOW_MS / 1000 + 86_400;
const now = () => NOW_MS;

const IAM = ['_iamadt', '_iambdt'];

/** What a signed-in Zoho user's jar looks like: IAM auth cookies on the bare domain + app cookies. */
async function signIn(fake, user) {
  for (const name of IAM) {
    await fake.set({ url: 'https://accounts.zoho.com/', domain: '.zoho.com', name, value: `${name}-${user}`, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURE });
  }
  await fake.set({ url: 'https://accounts.zoho.com/', name: '__Host-iam', value: `host-${user}`, path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
  await fake.set({ url: 'https://mail.zoho.com/', name: 'zmsess', value: `mail-${user}`, path: '/', secure: true, sameSite: 'lax' });
}

async function signOutLocally(fake) {
  for (const c of fake.dump()) await fake.remove({ url: `https://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name });
}

function world() {
  const fake = createFakeCookies({ now });
  const storage = createFakeStorage();
  const log = [];
  const siteData = {
    async listZohoTabs() { return []; },
    async resetTabs() { log.push('resetTabs'); return 0; },
    async deepClean() { log.push('deepClean'); },
    async openSignIn() { log.push('openSignIn'); },
  };
  const badge = { async show() {} };
  /** A (re)started service worker over the same browser state. */
  function boot(api = fake) {
    const jar = createCookieJar(api, { now });
    const store = createAccountStore(storage, { now });
    return { jar, store, switcher: createSwitcher({ jar, store, siteData, badge, now }) };
  }
  return { fake, storage, log, boot };
}

const liveValues = (fake) => Object.fromEntries(fake.dump().map((c) => [c.name, c.value]));
const savedValues = async (store, id) => Object.fromEntries((await store.get(id)).cookies.map((c) => [c.name, c.value]));
const quietly = async (fn) => {
  const info = console.info;
  console.info = () => {};
  try { return await fn(); } finally { console.info = info; }
};

/** Alice and Bob saved; Alice active and live. */
async function twoAccounts() {
  const w = world();
  const sw = w.boot();
  await signIn(w.fake, 'alice');
  const alice = await sw.switcher.saveCurrentAs('Alice');
  await sw.switcher.beginAdd();
  await signIn(w.fake, 'bob');
  const bob = await sw.switcher.finishAdd('Bob');
  await sw.switcher.switchTo(alice.id);
  assert.equal(liveValues(w.fake)._iamadt, '_iamadt-alice');
  return { ...w, ...sw, alice, bob };
}

// ---------------------------------------------------------------------------
// Sign-out guard
// ---------------------------------------------------------------------------

test('partial restore that dropped the sign-in cookies: sync does not shrink the saved copy', async () => {
  const w = await twoAccounts();
  await w.switcher.switchTo(w.bob.id);
  // The browser refuses the IAM cookies while restoring Alice.
  const flaky = { ...w.fake, set: (d) => (IAM.includes(d.name) ? Promise.reject(new Error('Failed to parse or set cookie')) : w.fake.set(d)) };
  const sw = w.boot(flaky);
  const { warnings } = await sw.switcher.switchTo(w.alice.id);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Could not restore 2 cookies: /);
  assert.match(warnings[0], /_iamadt \(\.zoho\.com\)/);
  assert.match(warnings[0], /_iambdt \(\.zoho\.com\)/);
  assert.equal(liveValues(w.fake)._iamadt, undefined);

  assert.equal(await quietly(() => sw.switcher.syncActive()), false);
  assert.deepEqual(Object.keys(await savedValues(sw.store, w.alice.id)).sort(), ['__Host-iam', '_iamadt', '_iambdt', 'zmsess']);
});

test('external wipe ("Clear browsing data"): the saved copy is kept', async () => {
  const w = await twoAccounts();
  await signOutLocally(w.fake);
  assert.equal(await quietly(() => w.switcher.syncActive()), false);
  assert.equal((await savedValues(w.store, w.alice.id))._iamadt, '_iamadt-alice');
});

test('auth cookies expire client-side, user switches away and back: Alice\'s session survives (E2E E4)', async () => {
  const w = await twoAccounts();
  for (const name of IAM) await w.fake.remove({ url: 'https://zoho.com/', name });
  await quietly(() => w.switcher.switchTo(w.bob.id));
  assert.equal(liveValues(w.fake)._iamadt, '_iamadt-bob');
  await w.switcher.switchTo(w.alice.id);
  assert.equal(liveValues(w.fake)._iamadt, '_iamadt-alice');
  assert.equal((await savedValues(w.store, w.alice.id))._iamadt, '_iamadt-alice');
});

test('normal rotation of the auth cookie is saved', async () => {
  const w = await twoAccounts();
  await w.fake.set({ url: 'https://accounts.zoho.com/', domain: '.zoho.com', name: '_iamadt', value: 'rotated', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURE });
  await w.fake.remove({ url: 'https://mail.zoho.com/', name: 'zmsess' });
  assert.equal(await w.switcher.syncActive(), true);
  const saved = await savedValues(w.store, w.alice.id);
  assert.equal(saved._iamadt, 'rotated');
  assert.equal(saved.zmsess, undefined);
});

// ---------------------------------------------------------------------------
// Interrupted switch (service worker / browser died mid-switch)
// ---------------------------------------------------------------------------

async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 1));
  assert.ok(cond(), 'condition never became true');
}

test('worker dies mid-switch: the restarted worker never saves the target under the outgoing account, and recovery finishes the switch', async () => {
  const w = await twoAccounts(); // Alice active
  // The worker dies while restoring Bob: his IAM cookies made it, the others never land.
  const dying = { ...w.fake, set: (d) => (IAM.includes(d.name) ? w.fake.set(d) : new Promise(() => {})) };
  w.boot(dying).switcher.switchTo(w.bob.id); // never settles
  await until(() => liveValues(w.fake)._iambdt === '_iambdt-bob');

  const sw = w.boot(); // restarted worker, same storage + cookies
  assert.equal(await quietly(() => sw.switcher.syncActive()), false);
  assert.equal(await quietly(() => sw.switcher.restoreActiveOnStartup()), null);
  assert.equal((await savedValues(sw.store, w.alice.id))._iamadt, '_iamadt-alice');

  assert.deepEqual(await sw.switcher.recoverInterruptedSwitch(), { activeId: w.bob.id, warnings: [] });
  assert.deepEqual(liveValues(w.fake), {
    _iamadt: '_iamadt-bob', _iambdt: '_iambdt-bob', '__Host-iam': 'host-bob', zmsess: 'mail-bob',
  });
  assert.equal(await sw.store.getActiveId(), w.bob.id);
  assert.equal(await sw.store.getSwitching(), null);
  assert.ok(w.log.includes('resetTabs'));

  assert.equal(await sw.switcher.syncActive(), true);
  assert.equal((await savedValues(sw.store, w.alice.id))._iamadt, '_iamadt-alice');
  assert.equal((await savedValues(sw.store, w.bob.id))._iamadt, '_iamadt-bob');
});

// ---------------------------------------------------------------------------
// First run: Add account while signed in to an unsaved session
// ---------------------------------------------------------------------------

test('first run: cancelling "Add account" brings the unsaved session back', async () => {
  const w = world();
  const sw = w.boot();
  await signIn(w.fake, 'alice'); // signed in, never saved
  const before = liveValues(w.fake);
  await sw.switcher.beginAdd();
  assert.deepEqual(liveValues(w.fake), {});
  await w.fake.set({ url: 'https://accounts.zoho.com/', name: 'half', value: 'signing-in', path: '/', secure: true });

  await sw.switcher.cancelAdd();
  assert.deepEqual(liveValues(w.fake), before);
  assert.equal(await sw.store.getActiveId(), null);
  assert.equal(await sw.store.getPending(), null);
  const saved = await sw.switcher.saveCurrentAs('Alice');
  assert.equal(saved.cookies.find((c) => c.name === '_iamadt').value, '_iamadt-alice');
});

// ---------------------------------------------------------------------------
// Browser restart
// ---------------------------------------------------------------------------

test('browser restart: dropped session cookies come back, newer persistent ones are kept, tabs reload', async () => {
  const w = await twoAccounts(); // Alice active and saved
  // The auth cookie rotated just before the browser closed (sync never ran)...
  await w.fake.set({ url: 'https://accounts.zoho.com/', domain: '.zoho.com', name: '_iamadt', value: 'rotated', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURE });
  // ...and the restart dropped the session cookies.
  for (const c of w.fake.dump().filter((x) => x.session)) await w.fake.remove({ url: `https://${c.domain}${c.path}`, name: c.name });
  w.log.length = 0;

  const sw = w.boot();
  const res = await sw.switcher.restoreActiveOnStartup();
  assert.deepEqual(res, { restored: 2, skipped: 2, failed: [] });
  assert.deepEqual(liveValues(w.fake), {
    _iamadt: 'rotated', _iambdt: '_iambdt-alice', '__Host-iam': 'host-alice', zmsess: 'mail-alice',
  });
  assert.deepEqual(w.log, ['resetTabs']);
});
