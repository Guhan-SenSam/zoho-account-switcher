// Popup UI flow: proves popup.html/popup.js are wired to the message protocol.
// Clicks the real controls (by data-testid) in popup.html opened as a tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXT_DIR, setup, extensionPresent, addAccount, openMail, readPage, waitForRerender, waitForPage,
  submitSignIn, pollUntil, SIGN_IN,
} from './helpers.js';

const skip = extensionPresent() ? false : 'extension/ not built yet';

async function openPopup(b) {
  const ui = await b.context.newPage();
  await ui.setViewportSize({ width: 320, height: 600 });
  await ui.addInitScript(() => { window.close = () => {}; });
  await ui.goto(`${b.extOrigin}popup/popup.html`);
  await idle(ui);
  return ui;
}

/** Wait until the popup is not busy (no request in flight, background idle). */
function idle(ui) {
  return ui.waitForSelector('body[data-busy="false"]', { timeout: 10_000 });
}

const row = (ui, id) => ui.locator(`[data-testid="account"][data-id="${id}"]`);

async function rowsSummary(ui) {
  return ui.$$eval('[data-testid="account"]', (lis) => lis.map((li) => ({
    id: li.dataset.id,
    active: li.dataset.active,
    text: li.querySelector('[data-testid="switch"]')?.textContent ?? '',
  })));
}

async function waitActive(ui, id) {
  await pollUntil(async () => (await row(ui, id).getAttribute('data-active')) === 'true',
    { message: `row ${id} to be data-active=true` });
  await idle(ui);
}

test('9. popup UI: switch, rename, remove, deep clean, add (finish/cancel), save current', { timeout: 120_000, skip }, async (t) => {
  const e = await setup();
  t.after(() => e.close());
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { account: bob } = await addAccount(b, { username: 'bob', name: 'Bob' });
  const { page: mail, state: m0 } = await openMail(b.context);
  assert.equal(m0.who, 'bob');

  const ui = await openPopup(b);
  let rows = await rowsSummary(ui);
  assert.deepEqual(rows.map((r) => [r.id, r.active]), [[alice.id, 'false'], [bob.id, 'true']]);
  assert.match(rows[1].text, /Bob/);
  assert.match(rows[1].text, /Active/);
  assert.equal(await ui.locator('[data-testid="pending-panel"]').count(), 0);
  assert.equal(await ui.locator('[data-testid="save-current-panel"]').count(), 0);

  // --- Switch by clicking Alice's row.
  await row(ui, alice.id).locator('[data-testid="switch"]').click();
  await waitActive(ui, alice.id);
  assert.equal(await row(ui, bob.id).getAttribute('data-active'), 'false');
  assert.equal((await waitForRerender(mail, m0.serial)).who, 'alice', `mail after UI switch${e.diag()}`);
  assert.equal((await b.storage('activeId')).activeId, alice.id);

  // --- Rename via ⋯ menu; Enter saves.
  await row(ui, alice.id).locator('[data-testid="menu"]').click();
  await row(ui, alice.id).locator('[data-testid="rename"]').click();
  const input = row(ui, alice.id).locator('[data-testid="rename-input"]');
  assert.equal(await input.inputValue(), 'Alice');
  await input.fill('Alice Work');
  await input.press('Enter');
  await pollUntil(async () => /Alice Work/.test(await row(ui, alice.id).locator('[data-testid="switch"]').textContent()),
    { message: 'renamed row' });
  await idle(ui);
  assert.equal((await b.storage('accounts')).accounts[alice.id].name, 'Alice Work');

  // Esc cancels a rename.
  await row(ui, alice.id).locator('[data-testid="menu"]').click();
  await row(ui, alice.id).locator('[data-testid="rename"]').click();
  await row(ui, alice.id).locator('[data-testid="rename-input"]').fill('Nope');
  await row(ui, alice.id).locator('[data-testid="rename-input"]').press('Escape');
  await row(ui, alice.id).locator('[data-testid="switch"]').waitFor();
  assert.equal((await b.storage('accounts')).accounts[alice.id].name, 'Alice Work');

  // Invalid name -> inline message, nothing saved.
  await row(ui, alice.id).locator('[data-testid="menu"]').click();
  await row(ui, alice.id).locator('[data-testid="rename"]').click();
  await row(ui, alice.id).locator('[data-testid="rename-input"]').fill('   ');
  await row(ui, alice.id).locator('[data-testid="rename-input"]').press('Enter');
  await ui.locator('[data-testid="message"]').waitFor({ state: 'visible' });
  assert.match(await ui.locator('[data-testid="message"]').textContent(), /1.40 characters/);
  await row(ui, alice.id).locator('[data-testid="rename-input"]').press('Escape');
  assert.equal((await b.storage('accounts')).accounts[alice.id].name, 'Alice Work');

  // --- Remove Bob via ⋯ -> Remove -> Confirm.
  await row(ui, bob.id).locator('[data-testid="menu"]').click();
  await row(ui, bob.id).locator('[data-testid="remove"]').click();
  await row(ui, bob.id).locator('[data-testid="confirm-remove"]').click();
  await row(ui, bob.id).waitFor({ state: 'detached' });
  await idle(ui);
  rows = await rowsSummary(ui);
  assert.deepEqual(rows.map((r) => r.id), [alice.id]);
  assert.equal((await b.storage('accounts')).accounts[bob.id], undefined);

  // --- Deep clean checkbox.
  const deep = ui.locator('[data-testid="deep-clean"]');
  assert.equal(await deep.isChecked(), false);
  await deep.click();
  await idle(ui);
  await pollUntil(async () => (await b.storage('settings')).settings?.deepClean === true, { message: 'deepClean on' });
  assert.equal(await deep.isChecked(), true);
  await deep.click();
  await idle(ui);
  await pollUntil(async () => (await b.storage('settings')).settings?.deepClean === false, { message: 'deepClean off' });

  // --- Add account through the pending panel, then finish.
  let before = new Set(b.context.pages());
  const m1 = await readPage(mail);
  await ui.locator('[data-testid="add-account"]').click();
  await ui.locator('[data-testid="pending-panel"]').waitFor({ state: 'visible' });
  await idle(ui);
  assert.equal((await waitForRerender(mail, m1.serial)).who, 'signed-out');
  const signIn = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN), { exclude: before });
  assert.equal((await submitSignIn(signIn, 'carol')).who, 'carol');
  await ui.bringToFront();
  await ui.locator('[data-testid="new-account-name"]').fill('Carol');
  await ui.locator('[data-testid="finish-add"]').click();
  await ui.locator('[data-testid="pending-panel"]').waitFor({ state: 'detached' });
  await idle(ui);
  const state = (await b.send({ type: 'getState' })).state;
  const carol = state.accounts.find((a) => a.name === 'Carol');
  assert.ok(carol, 'Carol saved');
  assert.equal(state.activeId, carol.id);
  await waitActive(ui, carol.id);
  await signIn.close();

  // --- Add, then Cancel: back to Carol.
  before = new Set(b.context.pages());
  const m2 = await readPage(mail);
  await ui.locator('[data-testid="add-account"]').click();
  await ui.locator('[data-testid="pending-panel"]').waitFor({ state: 'visible' });
  await idle(ui);
  const m3 = await waitForRerender(mail, m2.serial);
  assert.equal(m3.who, 'signed-out');
  const signIn2 = await waitForPage(b.context, (u) => u.startsWith(SIGN_IN), { exclude: before });
  await ui.bringToFront();
  await ui.locator('[data-testid="cancel-add"]').click();
  await ui.locator('[data-testid="pending-panel"]').waitFor({ state: 'detached' });
  await waitActive(ui, carol.id);
  assert.equal((await waitForRerender(mail, m3.serial)).who, 'carol', `mail after UI cancel${e.diag()}`);
  await signIn2.close();

  // --- Remove the active account -> "save this session" panel -> save it.
  await row(ui, carol.id).locator('[data-testid="menu"]').click();
  await row(ui, carol.id).locator('[data-testid="remove"]').click();
  await row(ui, carol.id).locator('[data-testid="confirm-remove"]').click();
  await ui.locator('[data-testid="save-current-panel"]').waitFor({ state: 'visible' });
  await idle(ui);
  assert.equal((await b.storage('activeId')).activeId, null);
  await ui.locator('[data-testid="save-current-name"]').fill('Carol saved');
  await ui.locator('[data-testid="save-current"]').click();
  await ui.locator('[data-testid="save-current-panel"]').waitFor({ state: 'detached' });
  await idle(ui);
  const s2 = (await b.send({ type: 'getState' })).state;
  const saved = s2.accounts.find((a) => a.name === 'Carol saved');
  assert.ok(saved);
  assert.equal(s2.activeId, saved.id);
  await waitActive(ui, saved.id);

  // Final cross-check through the UI: switch back to Alice Work.
  const m4 = await readPage(mail);
  await row(ui, alice.id).locator('[data-testid="switch"]').click();
  await waitActive(ui, alice.id);
  assert.equal((await waitForRerender(mail, m4.serial)).who, 'alice', `mail after final UI switch${e.diag()}`);
});

// Reviewed behaviour: with no active account (live session unsaved), clicking another
// account asks for confirmation first, since switching discards the unsaved session.
const popupSrc = (() => { try { return fs.readFileSync(path.join(EXT_DIR, 'popup', 'popup.js'), 'utf8'); } catch { return ''; } })();
const confirmSkip = skip || (popupSrc.includes('confirm-switch') ? false : 'popup has no confirm-switch yet');

test('9b. popup UI: switching with no active account asks to confirm (cancel / confirm)', { timeout: 90_000, skip: confirmSkip }, async (t) => {
  const e = await setup();
  t.after(() => e.close());
  const b = e.browser;
  const { account: alice } = await addAccount(b, { username: 'alice', name: 'Alice' });
  const { account: bob } = await addAccount(b, { username: 'bob', name: 'Bob' });
  const { page: mail, state: m0 } = await openMail(b.context);
  assert.equal(m0.who, 'bob');
  // Remove the active account: still signed in as bob, but nothing is active.
  assert.equal((await b.sendOk({ type: 'remove', id: bob.id })).state.activeId, null);

  const ui = await openPopup(b);
  await ui.locator('[data-testid="save-current-panel"]').waitFor({ state: 'visible' });
  await row(ui, alice.id).locator('[data-testid="switch"]').click();
  await ui.locator('[data-testid="confirm-switch"]').waitFor({ state: 'visible' });
  await ui.locator('[data-testid="cancel-switch"]').click();
  await ui.locator('[data-testid="confirm-switch"]').waitFor({ state: 'detached' });
  await idle(ui);
  assert.equal((await b.storage('activeId')).activeId, null, 'cancel kept nothing active');
  assert.equal((await readPage(mail)).serial, m0.serial, 'cancel did not reload Zoho tabs');

  await row(ui, alice.id).locator('[data-testid="switch"]').click();
  await ui.locator('[data-testid="confirm-switch"]').click();
  await waitActive(ui, alice.id);
  assert.equal((await waitForRerender(mail, m0.serial)).who, 'alice', `mail after confirmed switch${e.diag()}`);
});
