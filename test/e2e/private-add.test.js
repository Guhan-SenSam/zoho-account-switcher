// "Add account" in a private (Incognito) window — design spec, "Addendum: add
// accounts in a private window". With Incognito access, beginAdd opens the Zoho
// sign-in in an Incognito window; the regular session stays signed in, active
// and syncing; Save copies the Incognito store's Zoho cookies into a new account
// and closes the window. Without Incognito access the old sign-out flow is used.
//
// Harness notes (see helpers.js):
//   - b.enableIncognito() flips "Allow in Incognito" through chrome.developerPrivate
//     on a chrome://extensions page; that reloads the extension (new SW, new pages).
//   - The Incognito window is driven from the service worker (chrome.tabs /
//     chrome.scripting / chrome.cookies with storeId), never via Playwright pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGN_IN, setup, launchBrowser, extensionPresent, addAccount, openMail, readPage, waitForRerender, waitForPage,
  submitSignIn, savedCookies, cookieValue, pollUntil, sleep,
  REGULAR_STORE_ID, incognitoWindowIds, allWindows, storeCookies, regularJar, storeOfTab,
  openIncognitoWindow, closeWindow, waitForTabInWindow, readTab, signInInWindow,
} from './helpers.js';

const skip = extensionPresent() ? false : 'extension/ not built yet';
const T = { timeout: 90_000, skip };

const SIGN_IN_FIRST = 'Sign in to Zoho in the private window first';
const PUBLIC_PENDING_KEYS = ['captured', 'mode', 'previousId', 'startedAt', 'windowOpen'];
const ZOHO_COOKIE_NAMES = ['JSESSIONID', '__Host-zmcsr', '_iamadt', '_iambdt', 'iamcsr'];

async function env(t) {
  const e = await setup();
  t.after(() => e.close());
  return e;
}

function assertWho(state, user, e, what = 'mail tab') {
  assert.equal(state.who, user, `${what} shows ${user} (got ${state.who}${state.reason ? `: ${state.reason}` : ''})${e.diag()}`);
}

async function getState(b) {
  return (await b.sendOk({ type: 'getState' })).state;
}

/** Wait until an account's saved _iambdt is the server's current token for `user`. */
function waitSynced(e, id, user) {
  return pollUntil(async () => cookieValue(await savedCookies(e.browser, id), '_iambdt') === e.server.sessionFor(user).bdt,
    { message: `${user}'s saved _iambdt to match the server's current token` });
}

/**
 * Alice added with the (default) sign-out flow and active; a regular mail tab
 * shows alice and the sync after its load has settled.
 */
async function aliceWithMail(e) {
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { page: mail, state } = await openMail(b.context);
  assertWho(state, 'alice', e);
  await waitSynced(e, alice.id, 'alice');
  return { alice, mail };
}

/** Every value of a fake-Zoho session (current and rotated-out tokens). */
function sessionValues(s) {
  return new Set([s.adt, s.bdt, s.jsessionid, s.iamcsr, ...s.retiredBdts]);
}

/**
 * beginAdd in private mode. Checks the public state, the stored pending and the
 * opened Incognito window; returns { res, windowId, storeId, tabId }.
 */
async function beginPrivate(e, { activeId, otherIncognito = [] }) {
  const b = e.browser;
  const res = await b.sendOk({ type: 'beginAdd' });
  const p = res.state.pending;
  assert.ok(p, `beginAdd sets pending: ${JSON.stringify(res.state)}`);
  assert.equal(p.mode, 'private', `pending.mode: ${JSON.stringify(p)}`);
  assert.equal(p.windowOpen, true, `pending.windowOpen: ${JSON.stringify(p)}`);
  assert.equal(p.captured, false, `pending.captured: ${JSON.stringify(p)}`);
  assert.deepEqual(Object.keys(p).sort(), PUBLIC_PENDING_KEYS, 'no cookies / storeId / windowId sent to the popup');
  assert.equal(res.state.activeId, activeId, 'activeId unchanged by a private beginAdd');
  assert.equal(res.state.incognitoAllowed, true);

  const { pending: raw } = await b.storage('pending');
  assert.equal(raw?.mode, 'private', `stored pending: ${JSON.stringify(raw)}`);
  assert.equal(typeof raw.windowId, 'number', `stored pending.windowId: ${JSON.stringify(raw)}`);
  const inc = await incognitoWindowIds(b);
  assert.deepEqual(inc.sort(), [...otherIncognito, raw.windowId].sort(), 'exactly one new Incognito window');
  const tab = await waitForTabInWindow(b, raw.windowId, SIGN_IN);
  assert.equal(tab.incognito, true, 'the sign-in tab is an Incognito tab');
  const storeId = await storeOfTab(b, tab.tabId);
  assert.ok(storeId && storeId !== REGULAR_STORE_ID, `Incognito store: ${storeId}`);
  assert.equal(raw.storeId, storeId, 'stored pending.storeId is the private window\'s cookie store');
  return { res, windowId: raw.windowId, storeId, tabId: tab.tabId };
}

/** Assert the regular mail tab was not reloaded within `ms` (its #serial is unchanged). */
async function assertNotReloaded(page, before, what, ms = 1500) {
  await sleep(ms);
  const now = await readPage(page);
  assert.equal(now.serial, before.serial, `${what}: the regular Zoho tab was not reloaded`);
  return now;
}

async function waitNoIncognito(b, message = 'no Incognito window left') {
  return pollUntil(async () => (await incognitoWindowIds(b)).length === 0, { timeout: 5000, message });
}

/** Switch and wait for `page` to re-render; returns its new state. */
async function switchAndWait(e, page, id) {
  const before = await readPage(page);
  const r = await e.browser.sendOk({ type: 'switch', id });
  assert.equal(r.state.activeId, id);
  assert.deepEqual(r.warnings, [], `switch warnings: ${JSON.stringify(r.warnings)}`);
  return waitForRerender(page, before.serial);
}

function assertSavedShapes(saved, user, e) {
  const by = Object.fromEntries(saved.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(by).sort(), ZOHO_COOKIE_NAMES, `saved cookies for ${user}: ${saved.map((c) => c.name)}`);
  assert.ok(saved.every((c) => !('storeId' in c)), 'saved cookies carry no storeId');
  const s = e.server.sessionFor(user);
  assert.equal(by._iamadt.value, s.adt, `${user}'s _iamadt`);
  assert.equal(by._iamadt.hostOnly, false);
  assert.equal(by._iamadt.session, false);
  assert.equal(by._iambdt.session, true);
  assert.equal(by['__Host-zmcsr'].hostOnly, true);
  assert.equal(by.JSESSIONID.path, '/accounts');
}

// ---------------------------------------------------------------------------

test('P1. without Incognito access, Add account uses the sign-out flow', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);

  assert.equal(await b.incognitoAllowed(), false, 'precondition: --load-extension is not allowed in Incognito');
  const s0 = await getState(b);
  assert.equal(s0.incognitoAllowed, false, `state.incognitoAllowed: ${JSON.stringify(s0)}`);

  const m0 = await readPage(mail);
  const before = new Set(b.context.pages());
  const r = await b.sendOk({ type: 'beginAdd' });
  assert.equal(r.state.pending?.mode, 'signout', `public pending: ${JSON.stringify(r.state.pending)}`);
  assert.equal(r.state.activeId, null, 'sign-out flow clears activeId');
  assert.equal((await b.storage('pending')).pending?.mode, 'signout', 'stored pending.mode');
  assert.deepEqual(await incognitoWindowIds(b), [], 'no Incognito window opened');
  assertWho(await waitForRerender(mail, m0.serial), 'signed-out', e, 'regular mail after a sign-out beginAdd');
  const signIn = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN), { exclude: before });

  const c = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(c.state.activeId, alice.id);
  assert.equal(c.state.pending, null);
  await signIn.close();
});

test('P2. private add keeps the current session; Save stores the Incognito sign-in and closes the window', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);

  await b.enableIncognito();
  const s0 = await getState(b);
  assert.equal(s0.incognitoAllowed, true, `state.incognitoAllowed: ${JSON.stringify(s0)}`);
  assert.equal(s0.activeId, alice.id);

  const m0 = await readPage(mail);
  assertWho(m0, 'alice', e);
  const jar0 = await regularJar(b);
  assert.ok(jar0.length > 0, 'precondition: regular jar has Alice\'s cookies');

  const { windowId, storeId } = await beginPrivate(e, { activeId: alice.id });
  await assertNotReloaded(mail, m0, 'after beginAdd');
  assert.deepEqual(await regularJar(b), jar0, 'regular cookie jar unchanged by beginAdd');
  assertWho(await readPage(mail), 'alice', e, 'regular mail tab during the private add');

  // Sign in as carol in the Incognito window.
  const signed = await signInInWindow(b, windowId, 'carol');
  assertWho(signed.mail, 'carol', e, 'Incognito mail tab');
  assert.equal(signed.storeId, storeId);
  assert.deepEqual(await regularJar(b), jar0, 'regular cookie jar unchanged by the Incognito sign-in');
  assert.equal((await getState(b)).activeId, alice.id);

  // Save.
  const mBefore = await readPage(mail);
  const f = await b.sendOk({ type: 'finishAdd', name: 'Carol' });
  assert.equal(typeof f.notice, 'string', `finishAdd returns a notice: ${JSON.stringify(f)}`);
  assert.match(f.notice, /Carol/);
  assert.deepEqual(f.state.accounts.map((a) => a.name), ['Alice', 'Carol']);
  assert.equal(f.state.activeId, alice.id, 'Save does not change the active account');
  assert.equal(f.state.pending, null);
  assert.equal((await b.storage('pending')).pending ?? null, null, 'stored pending cleared');
  await waitNoIncognito(b, 'the private window closed by Save');
  const leftover = await storeCookies(b, storeId);
  assert.ok(leftover === null || leftover.length === 0,
    `Incognito store's Zoho cookies gone: ${JSON.stringify(leftover?.map((c) => c.name))}`);

  const carol = f.state.accounts.find((a) => a.name === 'Carol');
  assertSavedShapes(await savedCookies(b, carol.id), 'carol', e);
  assert.equal(cookieValue(await savedCookies(b, carol.id), '_iambdt'), e.server.sessionFor('carol').bdt,
    'Carol saved with her current (post-rotation) token');
  assert.deepEqual(await regularJar(b), jar0, 'regular cookie jar unchanged by Save');
  const mAfter = await readPage(mail);
  if (mAfter.serial !== mBefore.serial) t.diagnostic('note: private finishAdd reloaded the regular Zoho tab');
  assertWho(mAfter, 'alice', e, 'regular mail after Save');

  // Switch to Carol and back.
  assertWho(await switchAndWait(e, mail, carol.id), 'carol', e, 'regular mail after switching to Carol');
  assertWho(await switchAndWait(e, mail, alice.id), 'alice', e, 'regular mail after switching back to Alice');
});

test('P3. cancelling a private add closes the window and leaves the current session alone', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);
  await b.enableIncognito();
  const m0 = await readPage(mail);
  const jar0 = await regularJar(b);

  const { windowId } = await beginPrivate(e, { activeId: alice.id });
  const r = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(r.state.pending, null);
  assert.equal(r.state.activeId, alice.id);
  assert.deepEqual(r.state.accounts.map((a) => a.name), ['Alice'], 'no new account');
  await waitNoIncognito(b, 'the private window closed by Cancel');
  assert.ok(!(await allWindows(b)).some((w) => w.id === windowId));
  await assertNotReloaded(mail, m0, 'after cancelAdd');
  assert.deepEqual(await regularJar(b), jar0, 'regular cookie jar unchanged by cancelAdd');
  await mail.reload();
  assertWho(await readPage(mail), 'alice', e, 'regular mail after cancel + reload');
});

test('P3b. cancel after an Incognito sign-in clears the shared Incognito store; other Incognito windows survive', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);
  await b.enableIncognito();
  // Another Incognito window shares the same off-the-record store and keeps it alive.
  const other = await openIncognitoWindow(b);
  const m0 = await readPage(mail);

  const { windowId, storeId } = await beginPrivate(e, { activeId: alice.id, otherIncognito: [other.windowId] });
  await signInInWindow(b, windowId, 'erin');
  const erin = e.server.sessionFor('erin');
  assert.equal(cookieValue(await storeCookies(b, storeId), '_iamadt'), erin.adt, 'precondition: erin signed in (Incognito)');

  const r = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(r.state.pending, null);
  assert.deepEqual(r.state.accounts.map((a) => a.name), ['Alice']);
  await pollUntil(async () => !(await incognitoWindowIds(b)).includes(windowId), { message: 'private window closed' });
  assert.deepEqual(await incognitoWindowIds(b), [other.windowId], 'the unrelated Incognito window is left open');
  const left = await storeCookies(b, storeId);
  assert.ok(left !== null, 'precondition: the Incognito store still exists');
  assert.deepEqual(left.map((c) => `${c.name}@${c.domain}`), [], 'cancelAdd cleared the Zoho cookies of the Incognito store');
  await assertNotReloaded(mail, m0, 'after cancelAdd');
  await mail.reload();
  assertWho(await readPage(mail), 'alice', e, 'regular mail after cancel');
});

test('P4. private window closed before Save: the captured sign-in is still saved', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);
  await b.enableIncognito();

  const { windowId } = await beginPrivate(e, { activeId: alice.id });
  assertWho((await signInInWindow(b, windowId, 'dave')).mail, 'dave', e, 'Incognito mail tab');
  await pollUntil(async () => (await getState(b)).pending?.captured === true, { message: 'state.pending.captured === true' });
  // Let the capture settle on the post-rotation token (the mail load rotated _iambdt).
  await pollUntil(async () => cookieValue((await b.storage('pending')).pending?.capturedCookies, '_iambdt') === e.server.sessionFor('dave').bdt,
    { message: 'captured cookies hold dave\'s current _iambdt' });

  assert.equal(await closeWindow(b, windowId), true);
  const p = await pollUntil(async () => {
    const s = await getState(b);
    return s.pending && s.pending.windowOpen === false ? s.pending : null;
  }, { message: 'state.pending.windowOpen === false after closing the window' });
  assert.equal(p.mode, 'private');
  assert.equal(p.captured, true, 'still captured after the window closed');
  assert.deepEqual(Object.keys(p).sort(), PUBLIC_PENDING_KEYS);
  assert.equal((await b.storage('pending')).pending?.windowId ?? null, null, 'stored pending.windowId cleared');

  const f = await b.sendOk({ type: 'finishAdd', name: 'Dave' });
  assert.match(f.notice ?? '', /Dave/, `notice: ${JSON.stringify(f)}`);
  assert.deepEqual(f.state.accounts.map((a) => a.name), ['Alice', 'Dave']);
  assert.equal(f.state.activeId, alice.id);
  assert.equal(f.state.pending, null);
  const dave = f.state.accounts.find((a) => a.name === 'Dave');
  assertSavedShapes(await savedCookies(b, dave.id), 'dave', e);

  assertWho(await switchAndWait(e, mail, dave.id), 'dave', e, 'regular mail after switching to Dave');
  assertWho(await switchAndWait(e, mail, alice.id), 'alice', e, 'regular mail after switching back to Alice');
});

test('P5. nothing captured: Save fails and keeps the add; Add account reopens the private window', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);
  await b.enableIncognito();

  const first = await beginPrivate(e, { activeId: alice.id });
  // While the window is open, Add account again just shows it (no second window).
  const again = await b.sendOk({ type: 'beginAdd' });
  assert.equal(again.state.pending?.windowOpen, true);
  assert.deepEqual(await incognitoWindowIds(b), [first.windowId], 'beginAdd with the window open does not open another');

  assert.equal(await closeWindow(b, first.windowId), true);
  await pollUntil(async () => (await getState(b)).pending?.windowOpen === false, { message: 'windowOpen false' });
  const s1 = await getState(b);
  assert.equal(s1.pending.captured, false);

  const f = await b.send({ type: 'finishAdd', name: 'Nobody' });
  assert.equal(f.ok, false, `finishAdd with nothing captured fails: ${JSON.stringify(f)}`);
  assert.equal(f.error, SIGN_IN_FIRST);
  assert.ok(f.state?.pending, 'pending kept');
  assert.equal(f.state.pending.mode, 'private');
  assert.deepEqual(f.state.accounts.map((a) => a.name), ['Alice']);
  assert.equal(f.state.activeId, alice.id);

  // Reopen.
  const second = await beginPrivate(e, { activeId: alice.id });
  assert.notEqual(second.windowId, first.windowId, 'a new private window');
  // The reopened window works end to end.
  assertWho((await signInInWindow(b, second.windowId, 'frank')).mail, 'frank', e, 'Incognito mail tab');
  const ok = await b.sendOk({ type: 'finishAdd', name: 'Frank' });
  assert.deepEqual(ok.state.accounts.map((a) => a.name), ['Alice', 'Frank']);
  assert.equal(ok.state.activeId, alice.id);
  await waitNoIncognito(b);
  const frank = ok.state.accounts.find((a) => a.name === 'Frank');

  // switchTo is still refused while a private add is pending.
  await beginPrivate(e, { activeId: alice.id });
  const sw = await b.send({ type: 'switch', id: frank.id });
  assert.equal(sw.ok, false, 'switch refused during a private add');
  assert.match(sw.error, /finish or cancel/i);
  assert.equal(sw.state.activeId, alice.id);
  await b.sendOk({ type: 'cancelAdd' });
  await waitNoIncognito(b);
  assertWho(await switchAndWait(e, mail, frank.id), 'frank', e, 'regular mail after switching to Frank');
});

test('P6. isolation: the active account keeps syncing during a private add; nothing leaks from Incognito', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);
  await b.enableIncognito();

  const { windowId, storeId, tabId } = await beginPrivate(e, { activeId: alice.id });
  assertWho((await signInInWindow(b, windowId, 'carol')).mail, 'carol', e, 'Incognito mail tab');
  await pollUntil(async () => (await getState(b)).pending?.captured === true, { message: 'Incognito sign-in captured' });
  const carol = e.server.sessionFor('carol');
  const aliceS = e.server.sessionFor('alice');

  // Incognito cookie changes must not be synced into the active account.
  await sleep(2500); // > the 1500 ms sync debounce
  let saved = await savedCookies(b, alice.id);
  assert.equal(cookieValue(saved, '_iamadt'), aliceS.adt, "Alice's saved _iamadt is still alice's");
  assert.equal(cookieValue(saved, '_iambdt'), aliceS.bdt, "Alice's saved _iambdt is still alice's");

  // The regular session keeps rotating and syncing while the private add is pending.
  const m0 = await readPage(mail);
  await mail.reload();
  assertWho(await waitForRerender(mail, m0.serial), 'alice', e, 'regular mail reload during the private add');
  await waitSynced(e, alice.id, 'alice');

  // Then another Incognito rotation (the last cookie events are Incognito ones again).
  const i0 = await readTab(b, tabId);
  await b.swEval((id) => chrome.tabs.reload(id), tabId);
  await pollUntil(async () => {
    const s = await readTab(b, tabId).catch(() => null);
    return s && s.serial !== i0.serial ? s : null;
  }, { message: 'Incognito mail tab re-rendered' });
  assertWho(await readTab(b, tabId), 'carol', e, 'Incognito mail tab after reload');
  await sleep(2500);

  saved = await savedCookies(b, alice.id);
  assert.equal(cookieValue(saved, '_iamadt'), aliceS.adt, "Alice's saved _iamadt");
  assert.equal(cookieValue(saved, '_iambdt'), e.server.sessionFor('alice').bdt, "Alice's saved _iambdt is her latest token");
  const carolValues = sessionValues(carol);
  const leaked = saved.filter((c) => carolValues.has(c.value)).map((c) => c.name);
  assert.deepEqual(leaked, [], "no Incognito (carol) cookie values in Alice's saved copy");
  const regular = (await storeCookies(b, REGULAR_STORE_ID)) ?? [];
  assert.deepEqual(regular.filter((c) => carolValues.has(c.value)).map((c) => c.name), [], 'no carol cookies in the regular jar');
  // ... and the regular sync did not touch the Incognito store.
  const inc = await storeCookies(b, storeId);
  assert.equal(cookieValue(inc, '_iamadt'), carol.adt, 'Incognito store still holds carol');
  assert.equal(cookieValue(inc, '_iambdt'), carol.bdt);
  // The capture follows the Incognito rotation.
  await pollUntil(async () => cookieValue((await b.storage('pending')).pending?.capturedCookies, '_iambdt') === carol.bdt,
    { message: 'pending.capturedCookies follows carol\'s rotation' });

  const c = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(c.state.activeId, alice.id);
  await waitNoIncognito(b);
  const m1 = await readPage(mail);
  await mail.reload();
  assertWho(await waitForRerender(mail, m1.serial), 'alice', e, 'regular mail after cancelling');
});

test('P8. a leftover Incognito Zoho session is cleared by beginAdd and never saved', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice } = await aliceWithMail(e);
  await b.enableIncognito();

  // Someone is already signed in to Zoho in Incognito (shared off-the-record store),
  // with an extra cookie the new sign-in will not overwrite.
  const other = await openIncognitoWindow(b, SIGN_IN);
  const leftover = await signInInWindow(b, other.windowId, 'mallory');
  await b.swEval((id) => chrome.tabs.update(id, { url: 'https://crm.zoho.com/crm/set-extra?name=CRMCSR&value=mallory-crm&path=/crm' }), leftover.tabId);
  await pollUntil(async () => cookieValue(await storeCookies(b, leftover.storeId), 'CRMCSR') === 'mallory-crm',
    { message: 'leftover CRMCSR cookie in the Incognito store' });

  const { windowId, storeId } = await beginPrivate(e, { activeId: alice.id, otherIncognito: [other.windowId] });
  assert.equal(storeId, leftover.storeId, 'all Incognito windows share one store');
  const after = await storeCookies(b, storeId);
  assert.deepEqual(after.map((c) => `${c.name}@${c.domain}`), [], 'beginAdd cleared the leftover Zoho cookies');

  assertWho((await signInInWindow(b, windowId, 'carol')).mail, 'carol', e, 'Incognito mail tab');
  const f = await b.sendOk({ type: 'finishAdd', name: 'Carol' });
  assert.equal(f.state.activeId, alice.id);
  const carol = f.state.accounts.find((a) => a.name === 'Carol');
  const saved = await savedCookies(b, carol.id);
  assertSavedShapes(saved, 'carol', e);
  const mallory = sessionValues(e.server.sessionFor('mallory'));
  assert.deepEqual(saved.filter((c) => mallory.has(c.value) || c.value === 'mallory-crm').map((c) => c.name), [],
    'nothing from the leftover session was saved');
  await pollUntil(async () => !(await incognitoWindowIds(b)).includes(windowId), { message: 'private window closed' });
  // The other Incognito window keeps the store alive: Save cleared its Zoho cookies.
  assert.deepEqual(await incognitoWindowIds(b), [other.windowId]);
  const left = await storeCookies(b, storeId);
  assert.ok(left !== null, 'precondition: the Incognito store still exists');
  assert.deepEqual(left.map((c) => `${c.name}@${c.domain}`), [], 'finishAdd cleared the Zoho cookies of the Incognito store');
});

test('P9. switching accounts never touches the user\'s own Incognito Zoho tab or store', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { account: bob } = await addAccount(b, { username: 'bob', name: 'Bob' });
  const { page: mail, state: m0 } = await openMail(b.context);
  assertWho(m0, 'bob', e);
  await waitSynced(e, bob.id, 'bob');
  await b.enableIncognito();

  // The user browses Zoho in Incognito on their own (no add in progress).
  const own = await openIncognitoWindow(b, SIGN_IN);
  const signed = await signInInWindow(b, own.windowId, 'mallory');
  assertWho(signed.mail, 'mallory', e, 'own Incognito mail tab');
  const mallory = e.server.sessionFor('mallory');
  const incJar = async () => ((await storeCookies(b, signed.storeId)) ?? []).map((c) => `${c.name}|${c.domain}=${c.value}`).sort();
  const inc0 = await incJar();
  const hasLs = () => b.swEval(async (tabId) => (await chrome.scripting.executeScript({
    target: { tabId }, func: () => localStorage.getItem('fz-marker') !== null,
  }))[0].result, signed.tabId);
  assert.equal(await hasLs(), true, 'precondition: Incognito tab has a localStorage marker');
  await sleep(2500); // > sync debounce: Incognito cookie events must not be synced into Bob

  const noMallory = async (id, who) => {
    const vals = sessionValues(mallory);
    const saved = await savedCookies(b, id);
    assert.deepEqual(saved.filter((c) => vals.has(c.value)).map((c) => c.name), [], `no Incognito cookies in ${who}'s saved copy`);
  };
  await noMallory(bob.id, 'Bob');

  assertWho(await switchAndWait(e, mail, alice.id), 'alice', e, 'regular mail after switching to Alice');
  // Deep clean on for the next switch: it must not wipe Incognito site data either.
  await b.sendOk({ type: 'setSettings', patch: { deepClean: true } });
  assertWho(await switchAndWait(e, mail, bob.id), 'bob', e, 'regular mail after switching to Bob (deep clean)');
  await sleep(2500);

  const after = await readTab(b, signed.tabId);
  assert.equal(after.serial, signed.mail.serial, 'switches did not reload the Incognito Zoho tab');
  assert.deepEqual(await incJar(), inc0, 'switches did not change the Incognito cookie store');
  assert.equal(await hasLs(), true, 'deep clean did not wipe the Incognito tab\'s localStorage');
  await noMallory(alice.id, 'Alice');
  await noMallory(bob.id, 'Bob');
  // The Incognito session still works.
  await b.swEval((id) => chrome.tabs.reload(id), signed.tabId);
  await pollUntil(async () => {
    const st = await readTab(b, signed.tabId).catch(() => null);
    return st && st.serial !== after.serial ? st : null;
  }, { message: 'Incognito tab re-rendered' });
  assertWho(await readTab(b, signed.tabId), 'mallory', e, 'own Incognito mail tab after the switches');
  await closeWindow(b, own.windowId);
});

// Browser restart while a private add is pending. Incognito windows never survive
// a restart. As in restart.test.js, Chromium does not dispatch runtime.onStartup to
// a --load-extension extension, so the test dispatches it when it did not happen.
test('P10. browser restart during a private add: the active account is restored; the captured sign-in can still be saved', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice } = await aliceWithMail(e);
  await b.enableIncognito();
  const { windowId } = await beginPrivate(e, { activeId: alice.id });
  assertWho((await signInInWindow(b, windowId, 'carol')).mail, 'carol', e, 'Incognito mail tab');
  await pollUntil(async () => cookieValue((await b.storage('pending')).pending?.capturedCookies, '_iambdt') === e.server.sessionFor('carol').bdt,
    { message: 'carol captured (current token)' });
  const aliceBdt = e.server.sessionFor('alice').bdt;

  await b.close();
  const b2 = await launchBrowser({ port: e.server.port, userDataDir: b.userDataDir });
  e.browser = b2;
  assert.deepEqual(await incognitoWindowIds(b2), [], 'no Incognito window after the restart');
  t.diagnostic(`Incognito access after relaunch: ${await b2.incognitoAllowed()}`);
  t.diagnostic(`right after relaunch: regular cookies [${(await b2.cookies()).map((c) => c.name)}], stored pending.windowId ${(await b2.storage('pending')).pending?.windowId}`);

  let restored = false;
  for (let i = 0; i < 20 && !restored; i++) {
    restored = cookieValue(await b2.cookies(), '_iambdt') === aliceBdt;
    if (!restored) await sleep(100);
  }
  if (!restored) {
    t.diagnostic('dispatching chrome.runtime.onStartup in the service worker (automation workaround)');
    await b2.swEval(() => chrome.runtime.onStartup.dispatch());
  }
  await pollUntil(async () => cookieValue(await b2.cookies(), '_iambdt') === aliceBdt,
    { message: "startup restored Alice's session cookie despite the pending private add" });
  await pollUntil(async () => (await b2.storage('pending')).pending?.windowId === null,
    { message: 'stored pending.windowId cleared on startup' });

  const s = await getState(b2);
  assert.equal(s.activeId, alice.id);
  assert.equal(s.pending?.mode, 'private');
  assert.equal(s.pending.windowOpen, false);
  assert.equal(s.pending.captured, true);
  const { page: mail, state: m0 } = await openMail(b2.context);
  assertWho(m0, 'alice', e, 'regular mail after the restart');

  const f = await b2.sendOk({ type: 'finishAdd', name: 'Carol' });
  assert.deepEqual(f.state.accounts.map((a) => a.name), ['Alice', 'Carol']);
  assert.equal(f.state.activeId, alice.id);
  assert.equal(f.state.pending, null);
  const carol = f.state.accounts.find((a) => a.name === 'Carol');
  assertWho(await switchAndWait(e, mail, carol.id), 'carol', e, 'regular mail after switching to Carol');
});

// ---------------------------------------------------------------------------
// Popup UI

async function openPopup(b) {
  const ui = await b.context.newPage();
  await ui.setViewportSize({ width: 320, height: 600 });
  await ui.addInitScript(() => { window.close = () => {}; });
  await ui.goto(`${b.extOrigin}popup/popup.html`);
  await idle(ui);
  return ui;
}

function idle(ui) {
  return ui.waitForSelector('body[data-busy="false"]', { timeout: 10_000 });
}

const row = (ui, id) => ui.locator(`[data-testid="account"][data-id="${id}"]`);

test('P7. popup: Incognito hint/button when not allowed; private pending panel when allowed', { timeout: 120_000, skip }, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, mail } = await aliceWithMail(e);

  // --- Not allowed: the normal view offers to turn on Incognito access.
  let ui = await openPopup(b);
  const settingsBtn = ui.locator('[data-testid="incognito-settings"]');
  await settingsBtn.waitFor({ state: 'visible' });
  assert.equal(await ui.locator('[data-testid="pending-panel"]').count(), 0);
  const before = new Set(b.context.pages());
  await settingsBtn.click();
  const settings = await waitForPage(b.context, (u) => u.startsWith(`chrome://extensions/?id=${b.extensionId}`),
    { exclude: before, message: `chrome://extensions/?id=${b.extensionId} tab` });
  await settings.close();
  await ui.close();

  // --- Allowed (reloads the extension, so reopen the popup).
  await b.enableIncognito();
  ui = await openPopup(b);
  await row(ui, alice.id).waitFor();
  assert.equal(await ui.locator('[data-testid="incognito-settings"]').isVisible(), false, 'no Incognito hint once allowed');

  const m0 = await readPage(mail);
  await ui.locator('[data-testid="add-account"]').click();
  const panel = ui.locator('[data-testid="pending-panel"]');
  await panel.waitFor({ state: 'visible' });
  await idle(ui);
  assert.match(await panel.textContent(), /private window/i, 'private-mode instructions');
  assert.match(await panel.textContent(), /stay signed in/i);
  assert.equal((await b.storage('pending')).pending?.mode, 'private');
  const { pending: raw } = await b.storage('pending');
  assert.deepEqual(await incognitoWindowIds(b), [raw.windowId], 'private window opened');
  assert.match(await ui.locator('[data-testid="add-account"]').textContent(), /show private window/i);
  await assertNotReloaded(mail, m0, 'after Add account in the popup');
  assert.equal((await getState(b)).activeId, alice.id);

  // --- Window closed without signing in: the panel says so; the footer reopens it.
  await closeWindow(b, raw.windowId);
  await pollUntil(async () => (await getState(b)).pending?.windowOpen === false, { message: 'windowOpen false' });
  await ui.reload();
  await idle(ui);
  await ui.locator('[data-testid="pending-panel"]').waitFor({ state: 'visible' });
  assert.match(await ui.locator('[data-testid="pending-panel"]').textContent(), /closed/i, 'panel says the private window was closed');
  assert.match(await ui.locator('[data-testid="add-account"]').textContent(), /reopen private window/i);
  await ui.locator('[data-testid="add-account"]').click();
  await idle(ui);
  const reopened = await pollUntil(async () => {
    const { pending } = await b.storage('pending');
    return pending?.windowId && (await incognitoWindowIds(b)).includes(pending.windowId) ? pending.windowId : null;
  }, { message: 'private window reopened from the popup' });
  await pollUntil(async () => /show private window/i.test(await ui.locator('[data-testid="add-account"]').textContent()),
    { message: 'footer button back to "Show private window"' });

  // --- Sign in (Incognito) and Save from the popup: info notice, Alice stays active.
  assertWho((await signInInWindow(b, reopened, 'carol')).mail, 'carol', e, 'Incognito mail tab');
  await ui.bringToFront();
  await ui.locator('[data-testid="new-account-name"]').fill('Carol');
  await ui.locator('[data-testid="finish-add"]').click();
  await ui.locator('[data-testid="pending-panel"]').waitFor({ state: 'detached' });
  await idle(ui);
  const msg = ui.locator('[data-testid="message"]');
  await msg.waitFor({ state: 'visible' });
  assert.match(await msg.textContent(), /Carol/, 'notice names the saved account');
  assert.notEqual(await msg.getAttribute('data-kind'), 'error', 'notice is not shown as an error');
  assert.notEqual(await msg.getAttribute('role'), 'alert', 'notice is not announced as an error');
  const s = await getState(b);
  const carol = s.accounts.find((a) => a.name === 'Carol');
  assert.ok(carol, 'Carol saved');
  assert.equal(s.activeId, alice.id);
  assert.equal(await row(ui, alice.id).getAttribute('data-active'), 'true');
  await row(ui, carol.id).waitFor();
  assert.equal(await row(ui, carol.id).getAttribute('data-active'), 'false');
  await waitNoIncognito(b);
});
