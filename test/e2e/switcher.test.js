// End-to-end scenarios for the real extension, driven over the message protocol
// against the fake Zoho server. Each test gets a fresh server + browser profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL, WHOAMI, setup, extensionPresent, addAccount, openMail, readPage, waitForRerender,
  savedCookies, cookieValue, pollUntil, submitSignIn, waitForPage, SIGN_IN,
} from './helpers.js';

const skip = extensionPresent() ? false : 'extension/ not built yet';
const T = { timeout: 90_000, skip };

/** Fresh env with a cleanup hook. */
async function env(t) {
  const e = await setup();
  t.after(() => e.close());
  return e;
}

/** Add Alice then Bob (Bob ends active). */
async function aliceAndBob(e) {
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { account: bob } = await addAccount(b, { username: 'bob', name: 'Bob' });
  return { alice, bob };
}

/** Switch and wait for the given mail tab to re-render; returns the new page state. */
async function switchAndWait(e, page, id) {
  const before = await readPage(page);
  const r = await e.browser.sendOk({ type: 'switch', id });
  assert.equal(r.state.activeId, id, 'switch made the target active');
  assert.deepEqual(r.warnings, [], `switch warnings: ${JSON.stringify(r.warnings)}`);
  return waitForRerender(page, before.serial);
}

function assertWho(state, user, e, what = 'mail tab') {
  assert.equal(state.who, user, `${what} shows ${user} (got ${state.who}${state.reason ? `: ${state.reason}` : ''})${e.diag()}`);
}

test('1. add account Alice via beginAdd -> sign in -> finishAdd', T, async (t) => {
  const e = await env(t);
  const b = e.browser;

  const s0 = (await b.sendOk({ type: 'getState' })).state;
  assert.deepEqual(s0.accounts, []);
  assert.equal(s0.activeId, null);
  assert.equal(s0.pending, null);
  assert.equal(s0.settings.deepClean, false, 'deep clean defaults to off');

  const { state, account } = await addAccount(b, { username: 'alice', name: 'Alice' });
  assert.equal(state.accounts.length, 1);
  assert.equal(state.activeId, account.id);
  assert.equal(account.initials, 'AL');
  assert.equal(state.busy, false);

  // The saved snapshot contains every cookie the fake Zoho issued, shapes intact.
  const saved = await savedCookies(b, account.id);
  const by = Object.fromEntries(saved.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(by).sort(), ['JSESSIONID', '__Host-zmcsr', '_iamadt', '_iambdt', 'iamcsr']);
  assert.equal(by._iamadt.hostOnly, false);
  assert.equal(by._iamadt.session, false);
  assert.ok(by._iamadt.expirationDate > Date.now() / 1000 + 29 * 86400, '_iamadt keeps its 30-day expiry');
  assert.equal(by._iambdt.session, true);
  assert.equal(by._iambdt.expirationDate, undefined, 'session cookie saved without expirationDate');
  assert.equal(by['__Host-zmcsr'].hostOnly, true);
  assert.equal(by.iamcsr.hostOnly, true);
  assert.equal(by.JSESSIONID.path, '/accounts');
  // finishAdd reloads Zoho tabs, which rotates _iambdt again; the debounced sync catches up.
  await pollUntil(async () => cookieValue(await savedCookies(b, account.id), '_iambdt') === e.server.sessionFor('alice').bdt,
    { message: 'saved the post-rotation _iambdt' });
});

test('2. add Bob; an already-open mail tab ends up showing bob', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });

  const { page: mail, state: m0 } = await openMail(b.context);
  assertWho(m0, 'alice', e);

  // beginAdd: snapshot Alice, clear cookies, reload Zoho tabs, open sign-in.
  const before = new Set(b.context.pages());
  await b.sendOk({ type: 'beginAdd' });
  const m1 = await waitForRerender(mail, m0.serial);
  assertWho(m1, 'signed-out', e, 'open mail tab after beginAdd');
  assert.equal(m1.ss, 'absent', 'beginAdd cleared sessionStorage of open Zoho tabs');
  // Alice's saved copy has her latest (rotated) token.
  assert.equal(cookieValue(await savedCookies(b, alice.id), '_iambdt'), e.server.sessionFor('alice').bdt);

  const signIn = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN), { exclude: before });
  assertWho(await submitSignIn(signIn, 'bob'), 'bob', e, 'sign-in tab');
  const r = await b.sendOk({ type: 'finishAdd', name: 'Bob' });
  const bob = r.state.accounts.find((a) => a.name === 'Bob');
  assert.equal(r.state.activeId, bob.id);
  assert.deepEqual(r.state.accounts.map((a) => a.name), ['Alice', 'Bob'], 'display order = creation order');
  assert.notEqual(bob.color, r.state.accounts[0].color, 'distinct colors');

  // finishAdd does not reload tabs (per spec); a reload of the old tab shows bob.
  await mail.reload();
  assertWho(await readPage(mail), 'bob', e, 'previously open mail tab after reload');
});

test('3. switch to Alice: open mail tab reloads as alice; host-only cookies restored host-only', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);
  const { page: mail, state: m0 } = await openMail(b.context);
  assertWho(m0, 'bob', e);

  const m1 = await switchAndWait(e, mail, alice.id);
  assertWho(m1, 'alice', e);

  const live = await b.cookies();
  const by = Object.fromEntries(live.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(by).sort(), ['JSESSIONID', '__Host-zmcsr', '_iamadt', '_iambdt', 'iamcsr'],
    `live cookies after switch: ${live.map((c) => `${c.name}@${c.domain}`)}`);
  assert.equal(by['__Host-zmcsr'].hostOnly, true, '__Host-zmcsr host-only');
  assert.equal(by['__Host-zmcsr'].domain, 'mail.zoho.com');
  assert.equal(by['__Host-zmcsr'].path, '/');
  assert.equal(by['__Host-zmcsr'].secure, true);
  assert.equal(by.iamcsr.hostOnly, true, 'iamcsr host-only');
  assert.equal(by.iamcsr.domain, 'accounts.zoho.com');
  assert.equal(by.iamcsr.sameSite, 'strict');
  assert.equal(by.JSESSIONID.hostOnly, true);
  assert.equal(by.JSESSIONID.domain, 'accounts.zoho.com');
  assert.equal(by.JSESSIONID.path, '/accounts');
  assert.equal(by.JSESSIONID.httpOnly, true);
  assert.equal(by._iamadt.hostOnly, false);
  assert.equal(by._iamadt.domain, '.zoho.com');
  assert.equal(by._iamadt.session, false);
  assert.equal(by._iamadt.sameSite, 'no_restriction');
  assert.equal(by._iambdt.session, true);
  assert.equal(by._iambdt.httpOnly, true);

  // Host-only + path-scoped cookies authenticate accounts.zoho.com/accounts/* as alice.
  const whoami = await b.context.newPage();
  await whoami.goto(WHOAMI);
  assert.equal(await whoami.textContent('#who'), 'alice', `whoami after switch${e.diag()}`);
  await whoami.close();

  // And back to Bob.
  assertWho(await switchAndWait(e, mail, bob.id), 'bob', e);
  // Switching to the already-active account is a no-op (no reload).
  const r = await b.sendOk({ type: 'switch', id: bob.id });
  assert.equal(r.state.activeId, bob.id);
});

test('4. rotation captured by the debounced sync survives switching away and back', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);
  const { page: mail } = await openMail(b.context);

  // Switch to Alice: the reload rotates her _iambdt server-side.
  assertWho(await switchAndWait(e, mail, alice.id), 'alice', e);
  const rotated = e.server.sessionFor('alice').bdt;
  const savedAtSwitch = cookieValue(await savedCookies(b, alice.id), '_iambdt');
  assert.notEqual(savedAtSwitch, rotated, 'precondition: the rotation happened after Alice was restored');

  // The cookies.onChanged -> 1.5 s debounce -> syncActive writes the new token into storage.
  await pollUntil(async () => cookieValue(await savedCookies(b, alice.id), '_iambdt') === rotated,
    { timeout: 10_000, interval: 250, message: "Alice's saved _iambdt to match the rotated server token" });

  // Rotate once more, then switch away and back: still alice.
  await mail.reload();
  const again = await readPage(mail);
  assertWho(again, 'alice', e);
  const rotated2 = e.server.sessionFor('alice').bdt;
  await pollUntil(async () => cookieValue(await savedCookies(b, alice.id), '_iambdt') === rotated2,
    { timeout: 10_000, interval: 250, message: 'second rotation synced' });

  assertWho(await switchAndWait(e, mail, bob.id), 'bob', e);
  assertWho(await switchAndWait(e, mail, alice.id), 'alice', e, 'mail tab after Bob -> Alice');
});

test('5. sessionStorage survives a plain reload but is cleared by a switch', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice } = await aliceAndBob(e);
  const { page: mail, state: m0 } = await openMail(b.context);
  assert.equal(m0.ss, 'absent', 'fresh tab has no marker');

  await mail.reload();
  const m1 = await waitForRerender(mail, m0.serial);
  assert.equal(m1.ss, 'present', 'plain reload keeps sessionStorage (proves the probe works)');

  const m2 = await switchAndWait(e, mail, alice.id);
  assertWho(m2, 'alice', e);
  assert.equal(m2.ss, 'absent', 'switch cleared sessionStorage before reloading');
  assert.equal(m2.ls, 'present', 'localStorage untouched with deep clean off');
});

test('6. deep clean wipes localStorage on switch; off leaves it', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);
  // (mail.zoho.com was already loaded during sign-in, so its localStorage marker is set.)
  const { page: mail, state: m0 } = await openMail(b.context);
  assert.equal(m0.ls, 'present', 'precondition: localStorage marker set by earlier mail loads');

  // Off (default): localStorage survives a switch.
  const m1 = await switchAndWait(e, mail, alice.id);
  assertWho(m1, 'alice', e);
  assert.equal(m1.ls, 'present', 'deep clean off: localStorage survives');

  // On: wiped.
  const r = await b.sendOk({ type: 'setSettings', patch: { deepClean: true } });
  assert.equal(r.state.settings.deepClean, true);
  assert.deepEqual((await b.storage('settings')).settings, { deepClean: true });
  const m2 = await switchAndWait(e, mail, bob.id);
  assertWho(m2, 'bob', e);
  assert.equal(m2.ls, 'absent', 'deep clean on: localStorage wiped');
  assert.equal(m2.ss, 'absent');

  // Off again: survives.
  const r2 = await b.sendOk({ type: 'setSettings', patch: { deepClean: false } });
  assert.equal(r2.state.settings.deepClean, false);
  const m3 = await switchAndWait(e, mail, alice.id);
  assertWho(m3, 'alice', e);
  assert.equal(m3.ls, 'present', 'deep clean off again: localStorage survives');
});

test('7. cancelAdd restores the previous account (even after signing in as someone else)', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { page: mail, state: m0 } = await openMail(b.context);
  assertWho(m0, 'alice', e);

  // Begin, then cancel straight away.
  const before = new Set(b.context.pages());
  await b.sendOk({ type: 'beginAdd' });
  const m1 = await waitForRerender(mail, m0.serial);
  assertWho(m1, 'signed-out', e, 'mail during pending add');
  const signIn = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN), { exclude: before });
  let r = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(r.state.activeId, alice.id);
  assert.equal(r.state.pending, null);
  assertWho(await waitForRerender(mail, m1.serial), 'alice', e, 'mail after cancelAdd');

  // Begin again, actually sign in as carol in the sign-in tab, then cancel: back to alice.
  const m2 = await readPage(mail);
  const before2 = new Set(b.context.pages());
  await b.sendOk({ type: 'beginAdd' });
  const m3 = await waitForRerender(mail, m2.serial);
  const signIn2 = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN), { exclude: before2 });
  assertWho(await submitSignIn(signIn2, 'carol'), 'carol', e, 'sign-in tab');
  r = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(r.state.activeId, alice.id);
  assert.deepEqual(r.state.accounts.map((a) => a.name), ['Alice'], 'carol was not saved');
  assertWho(await waitForRerender(mail, m3.serial), 'alice', e, 'mail after cancelling a carol sign-in');

  // finishAdd/cancelAdd without a pending add are errors.
  const bad = await b.send({ type: 'cancelAdd' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error, 'error message present');
  assert.equal(bad.state.activeId, alice.id);
  await signIn.close();
});

test('8. remove: non-active removal leaves the session; active removal leaves you signed in', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);
  const { page: mail, state: m0 } = await openMail(b.context);
  assertWho(m0, 'bob', e);
  // Let the rotation from opening mail settle (sync) so the cookie comparison is stable.
  await pollUntil(async () => cookieValue(await savedCookies(b, bob.id), '_iambdt') === e.server.sessionFor('bob').bdt,
    { message: 'bob sync' });

  const cookiesBefore = (await b.cookies()).map((c) => `${c.name}=${c.value}`).sort();
  const r = await b.sendOk({ type: 'remove', id: alice.id });
  assert.deepEqual(r.state.accounts.map((a) => a.name), ['Bob']);
  assert.equal(r.state.activeId, bob.id);
  const { accounts, order } = await b.storage(['accounts', 'order']);
  assert.equal(accounts[alice.id], undefined, 'Alice deleted from storage');
  assert.deepEqual(order, [bob.id]);
  assert.deepEqual((await b.cookies()).map((c) => `${c.name}=${c.value}`).sort(), cookiesBefore,
    'live cookies untouched');
  assert.equal((await readPage(mail)).serial, m0.serial, 'Zoho tabs were not reloaded');
  await mail.reload();
  assertWho(await readPage(mail), 'bob', e, 'mail after removing Alice');

  // Removing the active account: activeId null, still signed in as bob.
  const r2 = await b.sendOk({ type: 'remove', id: bob.id });
  assert.deepEqual(r2.state.accounts, []);
  assert.equal(r2.state.activeId, null);
  const m1 = await readPage(mail);
  await mail.reload();
  assertWho(await waitForRerender(mail, m1.serial), 'bob', e, 'mail after removing the active account');

  // ... and that live session can be saved again with saveCurrentAs.
  const r3 = await b.sendOk({ type: 'saveCurrentAs', name: 'Bob again' });
  const again = r3.state.accounts.find((a) => a.name === 'Bob again');
  assert.equal(r3.state.activeId, again.id);
  assert.equal(cookieValue(await savedCookies(b, again.id), '_iambdt'), e.server.sessionFor('bob').bdt);
});
