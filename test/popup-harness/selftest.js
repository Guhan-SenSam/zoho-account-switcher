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
    });

    await step('save current session', async () => {
      type(tid('save-current-name'), 'Recovered');
      tid('save-current').click();
      await idle();
      check(!tid('save-current-panel'), 'panel gone');
      const active = $('[data-testid="account"][data-active="true"] .name');
      check(active?.textContent === 'Recovered', 'new account active');
    });

    await step('add account → pending view → validation → finish', async () => {
      tid('add-account').click();
      await idle();
      check(tid('pending-panel') && tid('new-account-name') && tid('finish-add') && tid('cancel-add'), 'pending view');
      check(!$('[data-testid="account"]'), 'list hidden while pending');
      check(document.activeElement === tid('new-account-name'), 'name input focused');
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
