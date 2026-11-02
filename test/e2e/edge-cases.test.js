// Extra end-to-end checks beyond the core scenarios: cookies that only one
// account has (other hosts / paths / data centers / non-Secure), several Zoho
// tabs at once, protocol error paths, and a fast-switch race.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, extensionPresent, addAccount, openMail, readPage, waitForRerender, savedCookies,
  cookieValue, pollUntil, sleep, WHOAMI,
} from './helpers.js';

const skip = extensionPresent() ? false : 'extension/ not built yet';
const T = { timeout: 90_000, skip };

async function env(t) {
  const e = await setup();
  t.after(() => e.close());
  return e;
}

async function aliceAndBob(e) {
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { account: bob } = await addAccount(b, { username: 'bob', name: 'Bob' });
  return { alice, bob };
}

test('E1. switch removes cookies the target never had (other host/path/DC, non-Secure) and brings them back', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);

  // As Bob, pick up extra cookies on crm.zoho.com (path-scoped) and accounts.zoho.in (non-Secure, other DC).
  const extra = await b.context.newPage();
  await extra.goto('https://crm.zoho.com/crm/set-extra?name=CRMCSR&value=bob-crm&path=/crm');
  await extra.goto('https://accounts.zoho.in/set-extra?name=INCSR&value=bob-in&secure=0');
  await extra.close();
  await pollUntil(async () => {
    const saved = await savedCookies(b, bob.id);
    return cookieValue(saved, 'CRMCSR') === 'bob-crm' && cookieValue(saved, 'INCSR') === 'bob-in';
  }, { message: "Bob's extra cookies synced" });

  // Several Zoho tabs on different hosts all follow the switch.
  const { page: mail, state: m0 } = await openMail(b.context);
  const whoami = await b.context.newPage();
  await whoami.goto(WHOAMI);
  assert.equal(await whoami.textContent('#who'), 'bob');

  await b.sendOk({ type: 'switch', id: alice.id });
  assert.equal((await waitForRerender(mail, m0.serial)).who, 'alice', e.diag());
  await pollUntil(async () => (await whoami.textContent('#who').catch(() => null)) === 'alice',
    { message: 'accounts.zoho.com tab reloaded as alice' });

  const com = await b.cookies('zoho.com');
  const inn = await b.cookies('zoho.in');
  assert.equal(cookieValue(com, 'CRMCSR'), null, `CRMCSR (crm.zoho.com, Path=/crm) cleared: ${com.map((c) => c.name)}`);
  assert.equal(cookieValue(inn, 'INCSR'), null, `INCSR (accounts.zoho.in, non-Secure) cleared: ${inn.map((c) => c.name)}`);

  await b.sendOk({ type: 'switch', id: bob.id });
  const com2 = Object.fromEntries((await b.cookies('zoho.com')).map((c) => [c.name, c]));
  const inn2 = Object.fromEntries((await b.cookies('zoho.in')).map((c) => [c.name, c]));
  assert.equal(com2.CRMCSR?.value, 'bob-crm');
  assert.equal(com2.CRMCSR.domain, 'crm.zoho.com');
  assert.equal(com2.CRMCSR.hostOnly, true);
  assert.equal(com2.CRMCSR.path, '/crm');
  assert.equal(inn2.INCSR?.value, 'bob-in');
  assert.equal(inn2.INCSR.secure, false);
  assert.equal(inn2.INCSR.hostOnly, true);
  assert.equal(inn2.INCSR.domain, 'accounts.zoho.in');
});

test('E2. protocol error paths keep state consistent', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });

  let r = await b.send({ type: 'switch', id: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown account/i);
  assert.equal(r.state.activeId, alice.id);

  r = await b.send({ type: 'finishAdd', name: 'X' });
  assert.equal(r.ok, false, 'finishAdd without pending is an error');

  r = await b.send({ type: 'rename', id: alice.id, name: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /1.40 characters/);

  r = await b.send({ type: 'bogus' });
  assert.equal(r.ok, false);

  // While an add is pending, switching is refused and the pending add survives.
  await b.sendOk({ type: 'beginAdd' });
  r = await b.send({ type: 'switch', id: alice.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /finish or cancel/i);
  assert.ok(r.state.pending);
  r = await b.send({ type: 'saveCurrentAs', name: 'X' });
  assert.equal(r.ok, false);
  // finishAdd with a bad name keeps the add pending.
  r = await b.send({ type: 'finishAdd', name: '   ' });
  assert.equal(r.ok, false);
  assert.ok(r.state.pending, 'still pending after a rejected name');
  r = await b.sendOk({ type: 'cancelAdd' });
  assert.equal(r.state.activeId, alice.id);
  const { page } = await openMail(b.context);
  assert.equal((await readPage(page)).who, 'alice', e.diag());
});

// Regression: switchTo() used to resolve as soon as tabs.reload() was *issued*, so a second
// switch could snapshot the outgoing account while a reload that rotates its token was still
// in flight. resetTabs() now waits (bounded) for reloaded Zoho tabs to finish loading.
test('E3. fast switch while a token-rotating Zoho load is still in flight keeps both accounts usable', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);
  const { page: mail, state: m0 } = await openMail(b.context);
  assert.equal(m0.who, 'bob');

  // Zoho is slow: the server rotates Alice's token as soon as the request arrives,
  // but the response (carrying the new token) takes 1.5 s to reach the browser.
  e.server.mailDelayMs = 1500;
  const logLen = e.server.log.length;
  await b.sendOk({ type: 'switch', id: alice.id });
  // The user changes their mind while Zoho Mail is still loading as Alice.
  await pollUntil(() => e.server.log.slice(logLen).some((x) => x.result === 'mail:alice'),
    { message: 'mail request as alice reached the server (token rotated server-side)' });
  await b.sendOk({ type: 'switch', id: bob.id });
  e.server.mailDelayMs = 0;
  await sleep(2500); // let any in-flight response land and the debounced sync run

  const m1 = await readPage(mail);
  await mail.reload();
  const m2 = await waitForRerender(mail, m1.serial);
  assert.equal(m2.who, 'bob', `Bob still signed in after the fast switch (${m2.reason})${e.diag(25)}`);

  const r = await b.sendOk({ type: 'switch', id: alice.id });
  assert.equal(r.state.activeId, alice.id);
  const m3 = await waitForRerender(mail, m2.serial);
  const savedBdt = cookieValue(await savedCookies(b, alice.id), '_iambdt');
  assert.equal(m3.who, 'alice',
    `Alice still usable after the fast switch (${m3.reason}); server token ${e.server.sessionFor('alice').bdt.slice(0, 12)}, ` +
    `saved ${savedBdt?.slice(0, 12)}${e.diag(25)}`);
});

// Targets the reviewed behaviour "syncActive won't overwrite a saved account with an
// empty / signed-out jar": with the pre-review code this fails (the debounced sync
// saves the signed-out jar over Alice's good copy).
test('E4. a signed-out jar is not synced over the active account\'s saved copy', T, async (t) => {
  const e = await env(t);
  const b = e.browser;
  const { alice, bob } = await aliceAndBob(e);
  const { page: mail, state: m0 } = await openMail(b.context);
  await b.sendOk({ type: 'switch', id: alice.id });
  assert.equal((await waitForRerender(mail, m0.serial)).who, 'alice');
  const good = e.server.sessionFor('alice');
  await pollUntil(async () => cookieValue(await savedCookies(b, alice.id), '_iambdt') === good.bdt,
    { message: 'Alice synced' });

  // Something other than the switcher wipes the auth cookies (server session stays valid).
  const p = await b.context.newPage();
  await p.goto('https://accounts.zoho.com/test/expire-auth');
  await p.close();
  const live = (await b.cookies()).map((c) => c.name);
  assert.ok(!live.includes('_iamadt') && !live.includes('_iambdt'), `auth cookies gone from the jar: ${live}`);
  await sleep(3500); // > 1500 ms debounce + margin

  const saved = await savedCookies(b, alice.id);
  assert.equal(cookieValue(saved, '_iamadt'), good.adt, "Alice's saved _iamadt kept");
  assert.equal(cookieValue(saved, '_iambdt'), good.bdt, "Alice's saved _iambdt kept");

  // So Alice can still be switched back to.
  const m1 = await readPage(mail);
  await b.sendOk({ type: 'switch', id: bob.id });
  const m2 = await waitForRerender(mail, m1.serial);
  assert.equal(m2.who, 'bob', e.diag());
  await b.sendOk({ type: 'switch', id: alice.id });
  const m3 = await waitForRerender(mail, m2.serial);
  assert.equal(m3.who, 'alice', `Alice usable after a signed-out jar was seen (${m3.reason})${e.diag()}`);
});
