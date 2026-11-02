// Dev-only: drives the real popup against stub.js and checks the data-testid
// contract and the main flows. Injected by serve.mjs when ?selftest is present.
// Runs the suite named after the page's ?scenario= (see SUITES at the bottom).
// Results are written to <pre id="selftest"> (read with `--dump-dom`) and to
// the console. Run it via: node test/popup-harness/selftest.mjs
(() => {
  const results = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const tid = (t, id) => $(`${id ? `[data-id="${id}"] ` : ''}[data-testid="${t}"]`);

  async function until(fn, what, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (fn()) return;
      await wait(10);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  const idle = () => until(() => document.body.dataset.busy === 'false', 'body[data-busy=false]');
  const check = (cond, what) => { if (!cond) throw new Error(what); };
  const type = (el, text) => {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const activeId = () => $('[data-testid="account"][data-active="true"]')?.dataset.id ?? null;
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0;
  /** Requests the popup has sent to the stub so far (see stub.js). */
  const sent = () => window.__stub.sent;
  const sentSince = (n) => sent().slice(n).map((m) => JSON.stringify(m)).join(' ') || 'nothing';

  async function step(name, fn) {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (err) {
      results.push(`FAIL ${name}: ${err.message}`);
    }
  }

  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const addLabel = () => text(tid('add-account').querySelector('.btn-label'));
  const PRIVATE_INTRO = 'Sign in to the new Zoho account in the private window. You stay signed in here.';
  const SIGNOUT_INTRO = 'Sign in to Zoho in the tab that just opened, then name this account.';
  const INCOGNITO_HINT = 'Turn on Allow in Incognito to add accounts without signing out.';
  /** Checks the message area shows `want` (string or RegExp) styled as `kind`. */
  const checkMessage = (kind, want) => {
    const msg = tid('message');
    check(visible(msg), `message visible (${kind})`);
    const got = text(msg);
    check(want instanceof RegExp ? want.test(got) : got === want, `message text "${got}"`);
    const box = $('#message-box');
    check(box.classList.contains(`message-${kind}`), `#message-box has message-${kind}, got "${box.className}"`);
    for (const other of ['error', 'warning', 'info'].filter((k) => k !== kind)) {
      check(!box.classList.contains(`message-${other}`), `#message-box must not have message-${other}`);
    }
    check(msg.dataset.kind === kind, `data-kind=${kind}, got ${msg.dataset.kind}`);
    check(msg.getAttribute('role') === (kind === 'error' ? 'alert' : 'status'), `role for ${kind}`);
  };
  /** The private-mode pending panel, common to every private scenario. */
  const checkPrivatePanel = ({ windowOpen, captured }) => {
    const panel = tid('pending-panel');
    check(panel, 'pending-panel');
    check(panel.dataset.mode === 'private', `data-mode=private, got ${panel.dataset.mode}`);
    check(tid('new-account-name') && tid('finish-add') && tid('cancel-add'), 'name input, Save and Cancel');
    check(text(panel.querySelector('.panel-title')) === 'Adding an account', 'heading');
    check(text(panel.querySelector('.panel-text')) === PRIVATE_INTRO, `intro, got "${text(panel.querySelector('.panel-text'))}"`);
    check(!/tab that just opened/.test(text(panel)), 'no sign-out copy');
    check(!/signs you back in/.test(text(panel)), 'no "signs you back in" in private mode');
    check(!$('[data-testid="account"]'), 'list hidden while pending');
    check(!visible(tid('incognito-hint')), 'no incognito hint while pending');
    const closed = tid('private-window-closed');
    const note = text(panel.querySelector('.panel-note'));
    if (windowOpen) {
      check(!closed, 'no "window closed" notice while the window is open');
      check(addLabel() === 'Show private window', `add-account label, got "${addLabel()}"`);
      check(note === 'Cancel closes the private window.', `cancel note, got "${note}"`);
    } else {
      check(visible(closed), 'private-window-closed shown');
      const want = `The private window was closed. ${captured
        ? 'Your sign-in was saved — name it and click Save.'
        : 'Reopen it to sign in.'}`;
      check(text(closed) === want, `closed notice, got "${text(closed)}"`);
      check(addLabel() === 'Reopen private window', `add-account label, got "${addLabel()}"`);
      check(!/closes the private window/.test(note), `cancel note must not claim to close a closed window, got "${note}"`);
    }
    // Closed with nothing captured: reopening is the primary action, not Save.
    const reopenFirst = !windowOpen && !captured;
    check(tid('add-account').classList.contains('btn-primary') === reopenFirst, `add-account primary=${reopenFirst}`);
    check(tid('finish-add').classList.contains('btn-primary') === !reopenFirst, `finish-add primary=${!reopenFirst}`);
  };
  /**
   * Types a name, clicks Save, and expects the private-mode result: a new
   * inactive row, `active` still active, and the notice.
   */
  async function savePrivate(name, active) {
    const before = sent().length;
    type(tid('new-account-name'), name);
    tid('finish-add').click();
    const s = sent().slice(before);
    check(s.length === 1 && s[0].type === 'finishAdd' && s[0].name === name, `sent finishAdd, got ${sentSince(before)}`);
    await idle();
    check(!tid('pending-panel'), 'pending view gone');
    const row = $$('li[data-testid="account"]').find((li) => text(li.querySelector('.name')) === name);
    check(row, `new row "${name}" listed`);
    check(row.dataset.active === 'false', 'new account is not made active');
    check(activeId() === active, `active stays ${active}, got ${activeId()}`);
    checkMessage('info', `Saved “${name}”. Click it to switch.`);
    check(document.activeElement === row.querySelector('[data-testid="switch"]'), 'focus on the new row');
    return row;
  }

  async function listSuite() {
    await step('initial load renders list and clears busy', async () => {
      await idle();
      const rows = $$('li[data-testid="account"]');
      check(rows.length === 4, `expected 4 rows, got ${rows.length}`);
      check(rows.every((r) => r.dataset.id && /^(true|false)$/.test(r.dataset.active)), 'data-id/data-active on rows');
      check(activeId() === 'a1', `active should be a1, got ${activeId()}`);
      for (const r of rows) {
        check(r.querySelector('[data-testid="switch"]') instanceof HTMLButtonElement, 'switch is a button');
        check(r.querySelector('[data-testid="menu"]') instanceof HTMLButtonElement, 'menu is a button');
      }
      check(tid('add-account') instanceof HTMLButtonElement, 'add-account');
      check(tid('deep-clean')?.type === 'checkbox', 'deep-clean checkbox');
      check(tid('message'), 'message element exists');
      check(!visible(tid('message')), 'message hidden when empty');
      check(!tid('save-current-panel'), 'no save-current panel when an account is active');
      check(!tid('pending-panel'), 'no pending panel');
      check(tid('incognito-hint') && !visible(tid('incognito-hint')), 'incognito hint hidden when incognitoAllowed is undefined');
      check(!visible(tid('incognito-settings')), 'incognito-settings hidden');
    });

    await step('switch marks busy, disables controls, then moves Active', async () => {
      tid('switch', 'a2').click();
      check(document.body.dataset.busy === 'true', 'busy during request');
      check(tid('switch', 'a3').disabled && tid('add-account').disabled && tid('deep-clean').disabled, 'controls disabled');
      await idle();
      check(activeId() === 'a2', `active should be a2, got ${activeId()}`);
      check(!tid('switch', 'a3').disabled, 'controls re-enabled');
      check(document.activeElement === tid('switch', 'a2'), 'focus kept on the switched row');
    });

    await step('clicking the active row is a no-op', async () => {
      tid('switch', 'a2').click();
      check(document.body.dataset.busy === 'false', 'no request for active row');
    });

    await step('menu shows rename/remove; Escape closes it', async () => {
      tid('menu', 'a3').click();
      check(tid('rename', 'a3') && tid('remove', 'a3'), 'rename/remove visible');
      check(tid('menu', 'a3').getAttribute('aria-expanded') === 'true', 'aria-expanded');
      key(document.body, 'Escape');
      check(!tid('rename', 'a3'), 'menu closed by Escape');
      check(document.activeElement === tid('menu', 'a3'), 'focus returns to menu button');
    });

    await step('outside click closes the menu', async () => {
      tid('menu', 'a3').click();
      check(tid('rename', 'a3'), 'menu open');
      $('.header').click();
      check(!tid('rename', 'a3'), 'menu closed');
    });

    await step('rename: Esc cancels', async () => {
      tid('menu', 'a3').click();
      tid('rename', 'a3').click();
      const input = tid('rename-input', 'a3');
      check(input && document.activeElement === input, 'rename-input focused');
      check(input.value === 'Acme Corp — Admin', `prefilled, got "${input.value}"`);
      type(input, 'Nope');
      key(input, 'Escape');
      check(!tid('rename-input', 'a3'), 'rename closed');
      check($('[data-id="a3"] .name').textContent === 'Acme Corp — Admin', 'name unchanged');
    });

    await step('rename: Enter (form submit) saves', async () => {
      tid('menu', 'a3').click();
      tid('rename', 'a3').click();
      const input = tid('rename-input', 'a3');
      type(input, '  Acme <b>Admin</b>  ');
      input.form.requestSubmit();
      await idle();
      check(!tid('rename-input', 'a3'), 'rename closed after save');
      const name = $('[data-id="a3"] .name');
      check(name.textContent === 'Acme <b>Admin</b>', `text inserted literally, got "${name.textContent}"`);
      check(!name.querySelector('b'), 'no HTML injection');
    });

    await step('rename: empty name shows error without a request', async () => {
      tid('menu', 'a3').click();
      tid('rename', 'a3').click();
      const input = tid('rename-input', 'a3');
      type(input, '   ');
      input.form.requestSubmit();
      check(visible(tid('message')) && /Name must be 1–40 characters/.test(tid('message').textContent), 'error shown');
      check(tid('rename-input', 'a3') === document.activeElement, 'input refocused');
      key(tid('rename-input', 'a3'), 'Escape');
    });

    await step('name length counts code points like the store; maxlength 80', async () => {
      tid('menu', 'a3').click();
      tid('rename', 'a3').click();
      let input = tid('rename-input', 'a3');
      check(input.maxLength === 80, `rename-input maxlength should be 80, got ${input.maxLength}`);
      const before = sent().length;
      for (const tooLong of ['a'.repeat(41), '😀'.repeat(41)]) {
        input = tid('rename-input', 'a3');
        type(input, tooLong);
        input.form.requestSubmit();
        check(/Name must be 1–40 characters/.test(tid('message').textContent), `${[...tooLong].length} code points rejected`);
        check(sent().length === before, `no request for a too-long name, sent ${sentSince(before)}`);
      }
      // 40 code points = 80 UTF-16 units: the store accepts it, so the popup must too.
      const emoji = '😀'.repeat(40);
      input = tid('rename-input', 'a3');
      type(input, `  ${emoji}  `);
      input.form.requestSubmit();
      check(document.body.dataset.busy === 'true', '40 emoji accepted (request started)');
      const last = sent().at(-1);
      check(last?.type === 'rename' && last.name === emoji, `sent trimmed name, got ${sentSince(before)}`);
      await idle();
      check($('[data-id="a3"] .name').textContent === emoji, 'saved');
      check(!visible(tid('message')), 'no error');
    });

    await step('remove: confirm step then removal', async () => {
      tid('menu', 'a4').click();
      tid('remove', 'a4').click();
      check(tid('confirm-remove', 'a4'), 'confirm-remove shown');
      check(!tid('remove', 'a4'), 'remove replaced by confirmation');
      tid('confirm-remove', 'a4').click();
      await idle();
      check(!$('[data-id="a4"]'), 'row gone');
      check(!visible(tid('message')), 'message cleared on new request');
    });

    await step('removing the active account shows save-current banner', async () => {
      tid('menu', 'a2').click();
      tid('remove', 'a2').click();
      tid('confirm-remove', 'a2').click();
      await idle();
      check(activeId() === null, 'no active account');
      check(tid('save-current-panel') && tid('save-current-name') && tid('save-current'), 'save-current panel');
      check(tid('save-current-name').maxLength === 80, `save-current-name maxlength should be 80, got ${tid('save-current-name').maxLength}`);
    });

    await step('no active account: switch asks for confirmation instead of switching', async () => {
      const before = sent().length;
      tid('switch', 'a1').click();
      check(document.body.dataset.busy === 'false', 'no request started');
      check(sent().length === before, `nothing sent, got ${sentSince(before)}`);
      check(tid('confirm-switch', 'a1') instanceof HTMLButtonElement, 'confirm-switch button on the row');
      check(tid('cancel-switch', 'a1') instanceof HTMLButtonElement, 'cancel-switch button on the row');
      check($$('[data-testid="confirm-switch"]').length === 1, 'only on the clicked row');
      check(/Your current Zoho session isn't saved — switching will sign it out\./.test($('[data-id="a1"]').textContent), 'explains why');
      check(tid('confirm-switch', 'a1').textContent === 'Switch anyway', 'confirm label');
      check(tid('cancel-switch', 'a1').textContent === 'Cancel', 'cancel label');
      check(tid('switch', 'a1') && tid('menu', 'a1'), 'row keeps switch/menu');
      check(document.activeElement === tid('cancel-switch', 'a1'), 'focus on Cancel');
      check(tid('save-current-panel'), 'save panel still shown');
    });

    await step('cancel-switch sends nothing', async () => {
      const before = sent().length;
      tid('cancel-switch', 'a1').click();
      await wait(50);
      check(!tid('confirm-switch') && !tid('cancel-switch'), 'confirmation closed');
      check(sent().length === before, `nothing sent, got ${sentSince(before)}`);
      check(activeId() === null, 'still no active account');
      check(document.activeElement === tid('switch', 'a1'), 'focus back on the row');
    });

    await step('Escape cancels the switch confirmation', async () => {
      const before = sent().length;
      tid('switch', 'a3').click();
      check(tid('confirm-switch', 'a3'), 'confirmation open');
      key(document.activeElement, 'Escape');
      await wait(50);
      check(!tid('confirm-switch'), 'closed by Escape');
      check(sent().length === before, `nothing sent, got ${sentSince(before)}`);
      check(document.activeElement === tid('switch', 'a3'), 'focus back on the row');
    });

    await step('Save in the panel still submits while a switch confirmation is open', async () => {
      tid('switch', 'a1').click();
      check(tid('confirm-switch', 'a1'), 'confirmation open');
      type(tid('save-current-name'), '');
      tid('save-current').click();
      check(visible(tid('message')) && /Name must be 1–40 characters/.test(tid('message').textContent), 'form submitted (validation ran)');
      check(!tid('confirm-switch'), 'confirmation closed');
    });

    await step('save current session', async () => {
      type(tid('save-current-name'), 'Recovered');
      tid('save-current').click();
      await idle();
      check(!tid('save-current-panel'), 'panel gone');
      const active = $('[data-testid="account"][data-active="true"] .name');
      check(active?.textContent === 'Recovered', 'new account active');
    });

    await step('with an active account a click switches directly', async () => {
      const before = sent().length;
      tid('switch', 'a1').click();
      check(document.body.dataset.busy === 'true', 'request started immediately');
      check(!tid('confirm-switch'), 'no confirmation');
      const s = sent().slice(before);
      check(s.length === 1 && s[0].type === 'switch' && s[0].id === 'a1', `sent switch a1, got ${sentSince(before)}`);
      await idle();
      check(activeId() === 'a1', `active should be a1, got ${activeId()}`);
    });

    await step('confirm-switch sends switch', async () => {
      // Back to "no active account" by removing the active one.
      tid('menu', 'a1').click();
      tid('remove', 'a1').click();
      tid('confirm-remove', 'a1').click();
      await idle();
      check(activeId() === null && tid('save-current-panel'), 'no active account again');
      const before = sent().length;
      tid('switch', 'a3').click();
      check(sent().length === before, `nothing sent on the first click, got ${sentSince(before)}`);
      tid('confirm-switch', 'a3').click();
      check(document.body.dataset.busy === 'true', 'busy while switching');
      const s = sent().slice(before);
      check(s.length === 1 && s[0].type === 'switch' && s[0].id === 'a3', `sent switch a3, got ${sentSince(before)}`);
      check(!tid('confirm-switch'), 'confirmation closed while switching');
      check($('[data-id="a3"]').classList.contains('is-switching'), 'row shows Switching…');
      await idle();
      check(activeId() === 'a3', `active should be a3, got ${activeId()}`);
      check(!tid('save-current-panel'), 'save panel gone');
      check(document.activeElement === tid('switch', 'a3'), 'focus on the switched row');
    });

    await step('add account → pending view → validation → finish', async () => {
      tid('add-account').click();
      check(text($('#status')) === 'Opening sign-in…', `busy label, got "${text($('#status'))}"`);
      await idle();
      check(tid('pending-panel') && tid('new-account-name') && tid('finish-add') && tid('cancel-add'), 'pending view');
      check(tid('pending-panel').dataset.mode === 'signout', 'data-mode=signout');
      check(text($('.panel-text')) === SIGNOUT_INTRO, 'sign-out intro unchanged');
      check(/^Cancel signs you back in as .+\.$/.test(text($('.panel-note'))), `cancel note, got "${text($('.panel-note'))}"`);
      check(addLabel() === 'Reopen sign-in page', `add-account label, got "${addLabel()}"`);
      check(!tid('private-window-closed'), 'no private-window notice');
      check(tid('finish-add').classList.contains('btn-primary'), 'Save is primary');
      check(!$('[data-testid="account"]'), 'list hidden while pending');
      check(document.activeElement === tid('new-account-name'), 'name input focused');
      check(tid('new-account-name').maxLength === 80, `new-account-name maxlength should be 80, got ${tid('new-account-name').maxLength}`);
      tid('finish-add').click();
      check(/Name must be 1–40 characters/.test(tid('message').textContent), 'empty name rejected');
      type(tid('new-account-name'), 'Fresh');
      tid('finish-add').click();
      await idle();
      check(!tid('pending-panel'), 'pending view gone');
      check($('[data-testid="account"][data-active="true"] .name')?.textContent === 'Fresh', 'new account active');
      check(!visible(tid('message')), 'message cleared');
    });

    await step('add account → cancel restores previous', async () => {
      const before = activeId();
      tid('add-account').click();
      await idle();
      check(tid('pending-panel'), 'pending');
      tid('cancel-add').click();
      await idle();
      check(!tid('pending-panel'), 'not pending');
      check(activeId() === before, `active restored to ${before}, got ${activeId()}`);
    });

    await step('deep clean toggles through setSettings', async () => {
      const box = tid('deep-clean');
      check(box.checked === false, 'initially off');
      box.click();
      check(document.body.dataset.busy === 'true', 'busy while saving');
      await idle();
      check(tid('deep-clean').checked === true, 'on after response');
    });

    await step('a notice next to warnings shows first, styled as a warning', async () => {
      // The stub never returns both; simulate a background that does.
      const real = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = async (msg) => ({ ...(await real(msg)), notice: 'Saved.', warnings: ['1 tab could not be reloaded.'] });
      try {
        $('[data-testid="account"][data-active="false"] [data-testid="switch"]').click();
        await idle();
      } finally {
        window.chrome.runtime.sendMessage = real;
      }
      checkMessage('warning', 'Saved.1 tab could not be reloaded.'); // one span per line
      const lines = $$('#message .message-line').map(text);
      check(lines.join('|') === 'Saved.|1 tab could not be reloaded.', `lines, got ${JSON.stringify(lines)}`);
    });
  }

  /** Old background data: a pending add without `mode` is the sign-out flow. */
  async function pendingSuite() {
    await step('pending without mode renders the sign-out view', async () => {
      await idle();
      const panel = tid('pending-panel');
      check(panel?.dataset.mode === 'signout', `data-mode=signout, got ${panel?.dataset.mode}`);
      check(text(panel.querySelector('.panel-text')) === SIGNOUT_INTRO, 'sign-out intro');
      check(text(panel.querySelector('.panel-note')) === 'Cancel signs you back in as TurfScout Ops.', 'cancel note');
      check(addLabel() === 'Reopen sign-in page', `add-account label, got "${addLabel()}"`);
      check(!tid('private-window-closed'), 'no private-window notice');
      check(document.activeElement === tid('new-account-name'), 'name input focused');
    });
  }

  async function privatePendingSuite() {
    await step('private pending (window open): copy, testids, footer label', async () => {
      await idle();
      checkPrivatePanel({ windowOpen: true, captured: true });
      check(document.activeElement === tid('new-account-name'), 'name input focused');
    });

    await step('"Show private window" sends beginAdd and keeps the typed name', async () => {
      type(tid('new-account-name'), 'Half typed');
      const before = sent().length;
      tid('add-account').click();
      check(text($('#status')) === 'Showing window…', `busy label, got "${text($('#status'))}"`);
      const s = sent().slice(before);
      check(s.length === 1 && s[0].type === 'beginAdd' && Object.keys(s[0]).length === 1, `sent beginAdd, got ${sentSince(before)}`);
      await idle();
      checkPrivatePanel({ windowOpen: true, captured: true });
      check(tid('new-account-name').value === 'Half typed', 'typed name kept');
    });

    await step('empty name is rejected without a request', async () => {
      type(tid('new-account-name'), '  ');
      const before = sent().length;
      tid('finish-add').click();
      check(sent().length === before, `nothing sent, got ${sentSince(before)}`);
      checkMessage('error', 'Name must be 1–40 characters');
    });

    await step('Save adds the account without switching and shows the notice', async () => {
      await savePrivate('Client X', 'a1');
    });

    await step('the notice can be dismissed', async () => {
      $('#message-dismiss').click();
      check(!visible(tid('message')), 'dismissed');
      check(!$('#message-box').classList.contains('message-info'), 'style cleared');
    });

    await step('Add account opens a private window (no sign-out)', async () => {
      const before = sent().length;
      tid('add-account').click();
      check(text($('#status')) === 'Opening private window…', `busy label, got "${text($('#status'))}"`);
      check(sent().slice(before).map((m) => m.type).join() === 'beginAdd', `sent beginAdd, got ${sentSince(before)}`);
      await idle();
      checkPrivatePanel({ windowOpen: true, captured: false });
      check(tid('new-account-name').value === '', 'name input empty for a new add');
    });

    await step('Cancel ends the private add and keeps the active account', async () => {
      const before = sent().length;
      tid('cancel-add').click();
      check(sent().slice(before).map((m) => m.type).join() === 'cancelAdd', `sent cancelAdd, got ${sentSince(before)}`);
      await idle();
      check(!tid('pending-panel'), 'not pending');
      check(activeId() === 'a1', `active still a1, got ${activeId()}`);
      check(!visible(tid('message')), 'no message');
      check(addLabel() === 'Add account', `add-account label, got "${addLabel()}"`);
      check(!visible(tid('incognito-hint')), 'no incognito hint when allowed');
    });

    await step('window closed while the popup is open: refresh shows it', async () => {
      tid('add-account').click();
      await idle();
      window.__stub.db.pending.windowOpen = false; // background: windows.onRemoved
      window.__stub.db.pending.captured = true;
      document.dispatchEvent(new Event('visibilitychange'));
      await until(() => tid('private-window-closed'), 'closed notice after refresh');
      await idle();
      checkPrivatePanel({ windowOpen: false, captured: true });
      tid('cancel-add').click();
      await idle();
    });
  }

  async function privateClosedCapturedSuite() {
    await step('private pending (closed, captured): copy, testids, footer label', async () => {
      await idle();
      checkPrivatePanel({ windowOpen: false, captured: true });
      check(tid('private-window-closed').classList.contains('callout-ok'), 'reassuring (ok) style');
      check(text($('.panel-note')) === 'Cancel discards this sign-in.', `cancel note, got "${text($('.panel-note'))}"`);
    });

    await step('Save still works from the captured sign-in', async () => {
      await savePrivate('Vault admin', 'a1');
    });
  }

  async function privateClosedSuite() {
    await step('private pending (closed, not captured): copy, testids, footer label', async () => {
      await idle();
      checkPrivatePanel({ windowOpen: false, captured: false });
      check(tid('private-window-closed').classList.contains('callout-warn'), 'warning style');
      check(text($('.panel-note')) === 'Cancel stops adding this account.', `cancel note, got "${text($('.panel-note'))}"`);
    });

    await step('Save without a sign-in shows the background error, stays pending', async () => {
      type(tid('new-account-name'), 'Too soon');
      tid('finish-add').click();
      await idle();
      checkMessage('error', 'Sign in to Zoho in the private window first');
      check(tid('pending-panel'), 'still pending');
      check(tid('new-account-name').value === 'Too soon', 'typed name kept');
    });

    await step('"Reopen private window" sends beginAdd and the panel updates', async () => {
      const before = sent().length;
      tid('add-account').click();
      check(text($('#status')) === 'Opening private window…', `busy label, got "${text($('#status'))}"`);
      check(sent().slice(before).map((m) => m.type).join() === 'beginAdd', `sent beginAdd, got ${sentSince(before)}`);
      await idle();
      checkPrivatePanel({ windowOpen: true, captured: false });
      check(!visible(tid('message')), 'error cleared');
      check(tid('new-account-name').value === 'Too soon', 'typed name kept');
      check(document.activeElement === tid('new-account-name'), 'name input focused');
    });
  }

  async function incognitoOffSuite() {
    await step('incognito not allowed: hint and settings button under Add account', async () => {
      await idle();
      const hint = tid('incognito-hint');
      check(visible(hint), 'incognito-hint visible');
      const button = tid('incognito-settings');
      check(button instanceof HTMLButtonElement && visible(button), 'incognito-settings is a visible button');
      check(text(button) === 'Open settings', `button text, got "${text(button)}"`);
      check(text(hint) === `${INCOGNITO_HINT} Open settings`, `hint text, got "${text(hint)}"`);
      check(tid('add-account').compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING, 'hint follows Add account');
      check(hint.compareDocumentPosition(tid('deep-clean')) & Node.DOCUMENT_POSITION_FOLLOWING, 'hint precedes deep clean');
      check(text($(`#${tid('add-account').getAttribute('aria-describedby')}`)) === INCOGNITO_HINT, 'add-account described by the hint');
      check(hint.getBoundingClientRect().right <= document.documentElement.clientWidth, 'fits in 320px');
    });

    await step('Open settings sends openIncognitoSettings', async () => {
      const before = sent().length;
      tid('incognito-settings').click();
      check(document.body.dataset.busy === 'true', 'busy');
      check(tid('incognito-settings').disabled, 'disabled while busy');
      check(text($('#status')) === 'Opening settings…', `busy label, got "${text($('#status'))}"`);
      const s = sent().slice(before);
      check(s.length === 1 && JSON.stringify(s[0]) === '{"type":"openIncognitoSettings"}', `sent exactly {type:'openIncognitoSettings'}, got ${sentSince(before)}`);
      await idle();
      check(!tid('incognito-settings').disabled, 're-enabled');
      check(!visible(tid('message')), 'no message');
    });

    await step('Add account still uses the sign-out flow; hint hidden while pending', async () => {
      tid('add-account').click();
      await idle();
      check(tid('pending-panel')?.dataset.mode === 'signout', 'sign-out pending');
      check(text($('.panel-text')) === SIGNOUT_INTRO, 'sign-out intro');
      check(!visible(tid('incognito-hint')), 'hint hidden while pending');
      tid('cancel-add').click();
      await idle();
      check(visible(tid('incognito-hint')), 'hint back after cancel');
      check(activeId() === 'a1', 'previous account restored');
    });

    await step('hint disappears once Incognito is allowed', async () => {
      window.__stub.db.incognitoAllowed = true;
      document.dispatchEvent(new Event('visibilitychange'));
      await until(() => !visible(tid('incognito-hint')), 'hint hidden after refresh');
      check(!tid('add-account').hasAttribute('aria-describedby'), 'aria-describedby removed');
    });
  }

  const SUITES = {
    list: listSuite,
    pending: pendingSuite,
    'private-pending': privatePendingSuite,
    'private-closed-captured': privateClosedCapturedSuite,
    'private-closed': privateClosedSuite,
    'incognito-off': incognitoOffSuite,
  };

  window.addEventListener('load', async () => {
    const scenario = new URLSearchParams(location.search).get('scenario') || 'list';
    const suite = SUITES[scenario];
    if (suite) await suite();
    else results.push(`FAIL no self-test suite for scenario "${scenario}"`);

    document.body.append(Object.assign(document.createElement('pre'), {
      id: 'selftest',
      textContent: results.join('\n'),
    }));
    console.log(results.join('\n'));
  });
})();
