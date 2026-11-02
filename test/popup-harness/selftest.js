// Dev-only: drives the real popup against stub.js and checks the data-testid
// contract and the main flows. Injected by serve.mjs when ?selftest is present.
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

  window.addEventListener('load', async () => {
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
      await idle();
      check(tid('pending-panel') && tid('new-account-name') && tid('finish-add') && tid('cancel-add'), 'pending view');
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

    document.body.append(Object.assign(document.createElement('pre'), {
      id: 'selftest',
      textContent: results.join('\n'),
    }));
    console.log(results.join('\n'));
  });
})();
