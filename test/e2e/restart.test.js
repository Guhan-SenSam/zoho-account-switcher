// Browser restart: the session cookie _iambdt is dropped by the browser; the
// extension's runtime.onStartup handler re-applies the active account's saved
// cookies so Zoho still shows the active user.
//
// Automation caveat (verified in infra.test.js with a dummy extension): an
// extension loaded with --load-extension is re-installed on every launch
// (onInstalled reason "install") and Chromium does NOT dispatch runtime.onStartup
// to it. When that happens this test dispatches the event itself via
// chrome.runtime.onStartup.dispatch() inside the service worker, which runs the
// extension's real listener. Everything else (the restart, cookie loss, storage
// persistence) is real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, launchBrowser, extensionPresent, addAccount, openMail, readPage, waitForRerender,
  savedCookies, cookieValue, pollUntil, sleep, MAIL,
} from './helpers.js';

const skip = extensionPresent() ? false : 'extension/ not built yet';

test('10. browser restart: onStartup restores the active account (session cookie came back)', { timeout: 90_000, skip }, async (t) => {
  const e = await setup();
  t.after(() => e.close());
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { account: bob } = await addAccount(b, { username: 'bob', name: 'Bob' });
  const { page: mail, state: m0 } = await openMail(b.context);
  assert.equal(m0.who, 'bob');
  await b.sendOk({ type: 'switch', id: alice.id });
  assert.equal((await waitForRerender(mail, m0.serial)).who, 'alice');
  // Wait until the debounced sync captured the rotation from that reload.
  const rotated = e.server.sessionFor('alice').bdt;
  await pollUntil(async () => cookieValue(await savedCookies(b, alice.id), '_iambdt') === rotated,
    { message: "Alice's rotated _iambdt synced before restart" });

  await b.close();
  const b2 = await launchBrowser({ port: e.server.port, userDataDir: b.userDataDir });
  e.browser = b2;
  assert.equal(b2.extensionId, b.extensionId);

  const st = await b2.storage(['activeId', 'accounts']);
  assert.equal(st.activeId, alice.id, 'activeId persisted across restart');
  assert.equal(cookieValue(st.accounts[alice.id].cookies, '_iambdt'), rotated);
  assert.ok(st.accounts[bob.id], 'Bob persisted');

  // Did the browser itself run onStartup (and restore _iambdt)? Give it a moment.
  let restoredNaturally = false;
  for (let i = 0; i < 20 && !restoredNaturally; i++) {
    restoredNaturally = (await b2.cookies()).some((c) => c.name === '_iambdt');
    if (!restoredNaturally) await sleep(100);
  }
  t.diagnostic(`runtime.onStartup restored cookies on its own: ${restoredNaturally}`);
  if (!restoredNaturally) {
    const names = (await b2.cookies()).map((c) => c.name).sort();
    assert.ok(names.includes('_iamadt'), `persistent _iamadt survived the restart: ${names}`);
    assert.ok(!names.includes('_iambdt'), `session _iambdt was dropped by the restart: ${names}`);
    // Without the restore, mail would be signed out — check that first (proves the test bites).
    const probe = await b2.context.newPage();
    await probe.goto(MAIL);
    const p0 = await readPage(probe);
    assert.equal(p0.who, 'signed-out', `without restore, mail is signed out (${p0.reason})`);
    await probe.close();
    t.diagnostic('dispatching chrome.runtime.onStartup in the service worker (automation workaround)');
    await b2.swEval(() => chrome.runtime.onStartup.dispatch());
  }

  await pollUntil(async () => cookieValue(await b2.cookies(), '_iambdt') === rotated,
    { message: 'onStartup restored the saved _iambdt' });
  const live = Object.fromEntries((await b2.cookies()).map((c) => [c.name, c]));
  assert.equal(live['__Host-zmcsr']?.hostOnly, true);
  assert.equal(live.JSESSIONID?.path, '/accounts');

  const { state } = await openMail(b2.context);
  assert.equal(state.who, 'alice', `mail after restart shows the active user (${state.reason})${e.diag()}`);
  const r = await b2.sendOk({ type: 'getState' });
  assert.equal(r.state.activeId, alice.id);
});
