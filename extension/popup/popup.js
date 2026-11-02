// Zoho Account Switcher — toolbar popup.
//
// Talks to the background service worker only through
// chrome.runtime.sendMessage({ type, ...args }). Every response carries the full
// `state` ({ accounts, activeId, pending, settings, busy }) and the popup simply
// re-renders from it. User-provided text is only ever inserted via text nodes.

const NAME_ERROR = 'Name must be 1–40 characters';
/** Same rule as the store (lib/accounts.js): 1–40 Unicode code points after trim. */
const NAME_MAX = 40;
/**
 * `maxlength` counts UTF-16 code units and a code point is at most two, so 80
 * never blocks a name the store accepts; validName() enforces the real limit.
 */
const NAME_MAXLENGTH = String(NAME_MAX * 2);
const POLL_MS = 400;

const BUSY_LABELS = {
  getState: 'Loading…',
  switch: 'Switching…',
  beginAdd: 'Opening sign-in…',
  finishAdd: 'Saving…',
  cancelAdd: 'Cancelling…',
  saveCurrentAs: 'Saving…',
  rename: 'Saving…',
  remove: 'Removing…',
  setSettings: 'Saving…',
};

const ui = {
  /** Last state received from the background, or null before the first load. */
  state: null,
  /** Number of requests currently awaiting a response. */
  inFlight: 0,
  busyLabel: '',
  /** The user request currently in flight (for row-level "Switching…" feedback). */
  op: null,
  /** Row that has its ⋯ menu / rename form / remove or switch confirmation open. */
  rowId: null,
  /** null | 'menu' | 'rename' | 'confirm' (remove) | 'confirm-switch' */
  rowMode: null,
  drafts: { pending: '', saveCurrent: '', rename: '' },
  /** null | { kind: 'error' | 'warning', lines: string[] } */
  message: null,
  /** Focus to restore after the next render (captured before controls get disabled). */
  savedFocus: null,
  pollTimer: 0,
};

const els = {
  main: document.getElementById('main'),
  footer: document.getElementById('footer'),
  addAccount: document.getElementById('add-account'),
  addLabel: document.querySelector('#add-account .btn-label'),
  addIcon: document.querySelector('#add-account .btn-icon'),
  deepClean: document.getElementById('deep-clean'),
  messageBox: document.getElementById('message-box'),
  message: document.getElementById('message'),
  messageDismiss: document.getElementById('message-dismiss'),
  spinner: document.querySelector('.spinner'),
  status: document.getElementById('status'),
};

// ---------------------------------------------------------------------------
// Messaging

function isBusy() {
  return ui.inFlight > 0 || ui.state?.busy === true;
}

async function sendRaw(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res && typeof res === 'object') return res;
    return { ok: false, error: 'No response from the extension. Close and reopen this popup.' };
  } catch (err) {
    return { ok: false, error: `Couldn't reach the extension: ${err?.message || err}` };
  }
}

/**
 * Sends a user-initiated request: marks the UI busy, clears the message area,
 * then re-renders from the returned state.
 * @param {object} msg       protocol request
 * @param {object} [opts]
 * @param {(res: object) => void} [opts.onOk]  adjust UI-local state on success
 * @param {object} [opts.focus]                focus target after success
 */
async function request(msg, { onOk, focus } = {}) {
  if (isBusy()) return null;
  clearTimeout(ui.pollTimer);
  ui.savedFocus = focusKeyOf(document.activeElement);
  ui.message = null;
  ui.inFlight += 1;
  ui.busyLabel = BUSY_LABELS[msg.type] || 'Working…';
  ui.op = msg;
  render();

  const res = await sendRaw(msg);

  ui.inFlight -= 1;
  ui.op = null;
  if (res.state) ui.state = res.state;
  let focusTarget = null;
  if (res.ok) {
    onOk?.(res);
    focusTarget = focus ?? null;
    const warnings = Array.isArray(res.warnings) ? res.warnings.filter(Boolean).map(String) : [];
    if (warnings.length) ui.message = { kind: 'warning', lines: warnings };
  } else {
    ui.message = { kind: 'error', lines: [String(res.error || 'Something went wrong.')] };
  }
  render({ focus: focusTarget });
  return res;
}

/** Quiet state refresh (no busy flicker, keeps the message). */
async function refresh() {
  clearTimeout(ui.pollTimer);
  if (ui.inFlight > 0) return;
  const res = await sendRaw({ type: 'getState' });
  if (ui.inFlight > 0) return; // a user request started meanwhile; its response wins
  if (res.state) {
    ui.state = res.state;
    render();
  } else if (!res.ok && !ui.state) {
    ui.message = { kind: 'error', lines: [String(res.error)] };
    render();
  }
}

// ---------------------------------------------------------------------------
// Actions

function closeRow() {
  ui.rowId = null;
  ui.rowMode = null;
  ui.drafts.rename = '';
}

function openRow(id, mode) {
  ui.rowId = id;
  ui.rowMode = mode;
}

function accountById(id) {
  return ui.state?.accounts?.find((a) => a.id === id) ?? null;
}

function validName(raw) {
  const name = String(raw ?? '').trim();
  const length = [...name].length; // code points, not UTF-16 units
  return length >= 1 && length <= NAME_MAX ? name : null;
}

/**
 * True while the "Save this session as" panel is offered next to the list: no
 * account is active, so the browser may be signed in to a Zoho account that
 * isn't saved, and switching would sign it out.
 */
function switchNeedsConfirm(state = ui.state) {
  return Boolean(state) && !state.pending && state.activeId == null
    && Array.isArray(state.accounts) && state.accounts.length > 0;
}

function showError(text, focus) {
  ui.message = { kind: 'error', lines: [text] };
  render({ focus });
}

function onSwitch(account) {
  if (isBusy()) return;
  if (account.id === ui.state?.activeId) {
    closeRow();
    render();
    return;
  }
  closeRow();
  if (switchNeedsConfirm()) {
    openRow(account.id, 'confirm-switch');
    render({ focus: { testid: 'cancel-switch', id: account.id } });
    return;
  }
  request({ type: 'switch', id: account.id }, { focus: { testid: 'switch', id: account.id } });
}

function onConfirmSwitch(account) {
  if (isBusy()) return;
  closeRow();
  // Move focus to the row's own switch button first, so it stays on this row
  // whether the switch succeeds or fails.
  const focus = { testid: 'switch', id: account.id };
  render({ focus });
  request({ type: 'switch', id: account.id }, { focus });
}

function onCancelSwitch(account) {
  closeRow();
  render({ focus: { testid: 'switch', id: account.id } });
}

function onToggleMenu(account) {
  if (ui.rowId === account.id && ui.rowMode === 'menu') {
    closeRow();
    render({ focus: { testid: 'menu', id: account.id } });
  } else {
    closeRow();
    openRow(account.id, 'menu');
    render({ focus: { testid: 'rename', id: account.id } });
  }
}

function onStartRename(account) {
  openRow(account.id, 'rename');
  ui.drafts.rename = account.name;
  render({ focus: { testid: 'rename-input', id: account.id, select: true } });
}

function onSubmitRename(account) {
  const name = validName(ui.drafts.rename);
  if (!name) return showError(NAME_ERROR, { testid: 'rename-input', id: account.id });
  if (name === account.name) {
    closeRow();
    render({ focus: { testid: 'menu', id: account.id } });
    return;
  }
  request({ type: 'rename', id: account.id, name }, {
    onOk: closeRow,
    focus: { testid: 'menu', id: account.id },
  });
}

function onStartRemove(account) {
  openRow(account.id, 'confirm');
  render({ focus: { testid: 'cancel-remove', id: account.id } });
}

function onConfirmRemove(account) {
  request({ type: 'remove', id: account.id }, { onOk: closeRow });
}

function onCancelRow(account) {
  closeRow();
  render({ focus: { testid: 'menu', id: account.id } });
}

function onAddAccount() {
  const wasPending = Boolean(ui.state?.pending);
  closeRow();
  request({ type: 'beginAdd' }, {
    // When already pending this only re-opens the sign-in tab; keep the typed name.
    onOk: () => { if (!wasPending) ui.drafts.pending = ''; },
    focus: { testid: 'new-account-name' },
  });
}

function onFinishAdd() {
  const name = validName(ui.drafts.pending);
  if (!name) return showError(NAME_ERROR, { testid: 'new-account-name' });
  request({ type: 'finishAdd', name }, {
    onOk: () => { ui.drafts.pending = ''; },
  });
}

function onCancelAdd() {
  request({ type: 'cancelAdd' }, {
    onOk: () => { ui.drafts.pending = ''; },
  });
}

function onSaveCurrent() {
  closeRow(); // e.g. a switch confirmation that was open when Save was clicked
  const name = validName(ui.drafts.saveCurrent);
  if (!name) return showError(NAME_ERROR, { testid: 'save-current-name' });
  request({ type: 'saveCurrentAs', name }, {
    onOk: () => { ui.drafts.saveCurrent = ''; },
  });
}

function onDeepCleanChange() {
  const deepClean = els.deepClean.checked;
  request({ type: 'setSettings', patch: { deepClean } }, { focus: { testid: 'deep-clean' } });
}

// ---------------------------------------------------------------------------
// DOM helpers

/** Tiny element builder. Strings become text nodes — never parsed as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'testid') el.dataset.testid = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

function svgIcon(pathD, { size = 16, stroke = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', pathD);
  if (stroke) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  } else {
    path.setAttribute('fill', 'currentColor');
  }
  svg.append(path);
  return svg;
}

const ICON_DOTS = 'M3.5 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z';
const ICON_PENCIL = 'M10.5 2.5l3 3L6 13H3v-3l7.5-7.5Z';
const ICON_TRASH = 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5';
const ICON_USERS = 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-4.5 6c0-2.2 2-3.8 4.5-3.8s4.5 1.6 4.5 3.8M10.5 2.7a2.5 2.5 0 0 1 0 4.6M12 9.9c1.5.5 2.5 1.8 2.5 3.6';

const relTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const relTimeNumeric = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });

function timeAgo(ts) {
  if (!Number.isFinite(ts)) return '';
  const seconds = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relTime.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relTime.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return relTime.format(Math.round(seconds / 86400), 'day');
  // 'always' avoids "Last used last month".
  if (abs < 86400 * 365) return relTimeNumeric.format(Math.round(seconds / (86400 * 30)), 'month');
  return relTimeNumeric.format(Math.round(seconds / (86400 * 365)), 'year');
}

/** Identifies a focusable control across re-renders (by data-testid + row id). */
function focusKeyOf(el) {
  if (!el || el === document.body || !el.dataset?.testid) return null;
  const row = el.closest('[data-id]');
  return { testid: el.dataset.testid, id: row?.dataset.id ?? null };
}

function findByKey(key) {
  if (!key) return null;
  const sel = `[data-testid="${CSS.escape(key.testid)}"]`;
  if (key.id != null) {
    return document.querySelector(`[data-id="${CSS.escape(key.id)}"] ${sel}`);
  }
  return document.querySelector(sel);
}

function restoreFocus(key) {
  let el = findByKey(key);
  if (!el && key.id != null) {
    // The row went away (e.g. removed): land on something sensible instead of <body>.
    el = document.querySelector('[data-testid="switch"]') || els.addAccount;
  }
  if (!el || el.disabled) return false;
  el.focus({ preventScroll: false });
  if (el instanceof HTMLInputElement && el.type === 'text') {
    if (key.select) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering

function render({ focus = null } = {}) {
  const key = focus ?? ui.savedFocus ?? focusKeyOf(document.activeElement);
  ui.savedFocus = null;
  const state = ui.state;

  if (!state) {
    els.main.replaceChildren();
    els.footer.hidden = true;
  } else {
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    if (ui.rowId && !accounts.some((a) => a.id === ui.rowId)) closeRow();
    if (state.pending) closeRow();
    if (ui.rowMode === 'confirm-switch' && !switchNeedsConfirm(state)) closeRow();

    const views = [];
    if (state.pending) {
      views.push(renderPending(state, accounts));
    } else if (accounts.length === 0) {
      // First run: explain, then offer "save this session"; the footer offers "Add account".
      views.push(renderEmpty());
      if (state.activeId == null) views.push(renderSaveCurrent(accounts));
    } else {
      if (state.activeId == null) views.push(renderSaveCurrent(accounts));
      views.push(renderList(state, accounts));
    }
    els.main.replaceChildren(...views);
    renderFooter(state, accounts);
  }

  renderMessage();
  applyBusy();
  if (isBusy()) {
    // Controls are disabled; remember where focus belongs once they come back.
    if (!ui.savedFocus) ui.savedFocus = key;
  } else if (key) {
    restoreFocus(key);
  }
  schedulePoll();
}

function renderPending(state, accounts) {
  const previous = accounts.find((a) => a.id === state.pending?.previousId) ?? null;
  const input = h('input', {
    type: 'text',
    id: 'new-account-name',
    testid: 'new-account-name',
    class: 'input',
    maxlength: NAME_MAXLENGTH,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'e.g. Work, Personal, Client X',
    value: ui.drafts.pending,
    oninput: (e) => { ui.drafts.pending = e.target.value; },
  });
  return h('section', { class: 'panel panel-accent', testid: 'pending-panel', 'aria-labelledby': 'pending-title' },
    h('h2', { class: 'panel-title', id: 'pending-title' }, 'Adding an account'),
    h('p', { class: 'panel-text' }, 'Sign in to Zoho in the tab that just opened, then name this account.'),
    h('form', {
      class: 'stack',
      novalidate: true,
      onsubmit: (e) => { e.preventDefault(); onFinishAdd(); },
    },
      h('label', { class: 'field-label', for: 'new-account-name' }, 'Account name'),
      input,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', testid: 'cancel-add', onclick: onCancelAdd }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary', testid: 'finish-add' }, 'Save account'),
      ),
    ),
    h('p', { class: 'panel-note' },
      previous
        ? ['Cancel signs you back in as ', h('strong', null, previous.name), '.']
        : 'Cancel discards this sign-in.'),
  );
}

function renderSaveCurrent(accounts) {
  const first = accounts.length === 0;
  return h('section', { class: `panel${first ? ' panel-accent' : ''}`, testid: 'save-current-panel' },
    h('form', {
      class: 'stack',
      novalidate: true,
      onsubmit: (e) => { e.preventDefault(); onSaveCurrent(); },
    },
      h('label', { class: 'panel-text', for: 'save-current-name' },
        h('strong', { class: 'panel-lead' }, 'Already signed in to Zoho?'),
        h('span', { class: 'panel-lead' }, 'Save this session as:')),
      h('div', { class: 'inline-form' },
        h('input', {
          type: 'text',
          id: 'save-current-name',
          testid: 'save-current-name',
          class: 'input',
          maxlength: NAME_MAXLENGTH,
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: 'Account name',
          value: ui.drafts.saveCurrent,
          oninput: (e) => { ui.drafts.saveCurrent = e.target.value; },
        }),
        h('button', { type: 'submit', class: `btn${first ? ' btn-primary' : ''}`, testid: 'save-current' }, 'Save'),
      ),
    ),
  );
}

function renderEmpty() {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, svgIcon(ICON_USERS, { size: 22, stroke: true })),
    h('p', { class: 'empty-title' }, 'No saved accounts yet'),
    h('p', { class: 'empty-text' }, 'Sign in once per Zoho account, then switch with one click.'),
  );
}

function renderList(state, accounts) {
  return h('ul', { class: 'accounts', 'aria-label': 'Saved Zoho accounts' },
    accounts.map((a) => renderAccount(a, a.id === state.activeId)));
}

function avatar(account) {
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, account.initials ?? '');
  // CSSOM assignment: an invalid value is simply ignored, never parsed as markup.
  if (account.color) el.style.setProperty('--avatar', account.color);
  return el;
}

function renderAccount(account, active) {
  const open = ui.rowId === account.id ? ui.rowMode : null;
  const li = h('li', {
    class: `account${active ? ' is-active' : ''}${open ? ` is-${open}` : ''}`,
    testid: 'account',
    dataset: { id: account.id, active: String(active) },
  });

  if (open === 'rename') {
    li.append(renderRenameForm(account));
    return li;
  }

  const switching = ui.op?.type === 'switch' && ui.op.id === account.id;
  if (switching) li.classList.add('is-switching');
  let sub;
  if (switching) sub = 'Switching…';
  else if (account.cookieCount === 0) sub = 'No saved sign-in';
  else if (active) sub = 'Current session';
  else sub = account.savedAt ? `Last used ${timeAgo(account.savedAt)}` : 'Saved';

  const actionsId = `actions-${account.id}`;
  li.append(h('div', { class: 'row' },
    h('button', {
      type: 'button',
      class: 'switch',
      testid: 'switch',
      'aria-current': active ? 'true' : null,
      title: active ? `${account.name} (active)` : `Switch to ${account.name}`,
      onclick: () => onSwitch(account),
    },
      avatar(account),
      h('span', { class: 'meta' },
        h('span', { class: 'name' }, account.name),
        h('span', { class: `sub${account.cookieCount === 0 ? ' sub-warn' : ''}` }, sub),
      ),
      active ? h('span', { class: 'pill' }, 'Active') : null,
    ),
    h('button', {
      type: 'button',
      class: 'icon-btn menu-btn',
      testid: 'menu',
      'aria-label': `Options for ${account.name}`,
      'aria-haspopup': 'true',
      'aria-expanded': open === 'menu' ? 'true' : 'false',
      'aria-controls': open === 'menu' ? actionsId : null,
      onclick: () => onToggleMenu(account),
    }, svgIcon(ICON_DOTS)),
  ));

  if (open === 'menu') {
    li.append(h('div', { class: 'row-extra row-actions', id: actionsId, role: 'group', 'aria-label': `Options for ${account.name}` },
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', testid: 'rename', onclick: () => onStartRename(account) },
        svgIcon(ICON_PENCIL, { size: 13, stroke: true }), 'Rename'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger-text', testid: 'remove', onclick: () => onStartRemove(account) },
        svgIcon(ICON_TRASH, { size: 13, stroke: true }), 'Remove'),
    ));
  } else if (open === 'confirm') {
    li.append(h('div', { class: 'row-extra confirm', role: 'group', 'aria-label': `Remove ${account.name}` },
      h('p', { class: 'confirm-text' },
        h('strong', null, 'Confirm remove?'), ' ',
        active
          ? 'The saved copy is deleted; you stay signed in to Zoho.'
          : 'The saved sign-in is deleted.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-sm', testid: 'cancel-remove', onclick: () => onCancelRow(account) }, 'Cancel'),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', testid: 'confirm-remove', onclick: () => onConfirmRemove(account) }, 'Remove'),
      ),
    ));
  } else if (open === 'confirm-switch') {
    const textId = `switch-warning-${account.id}`;
    li.append(h('div', { class: 'row-extra confirm', role: 'group', 'aria-label': `Switch to ${account.name}`, 'aria-describedby': textId },
      h('p', { class: 'confirm-text', id: textId },
        h('strong', null, "Your current Zoho session isn't saved"), ' — switching will sign it out.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-sm', testid: 'cancel-switch', onclick: () => onCancelSwitch(account) }, 'Cancel'),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', testid: 'confirm-switch', onclick: () => onConfirmSwitch(account) }, 'Switch anyway'),
      ),
    ));
  }
  return li;
}

function renderRenameForm(account) {
  return h('form', {
    class: 'row rename-form',
    novalidate: true,
    onsubmit: (e) => { e.preventDefault(); onSubmitRename(account); },
  },
    avatar(account),
    h('input', {
      type: 'text',
      class: 'input input-sm',
      testid: 'rename-input',
      maxlength: NAME_MAXLENGTH,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `New name for ${account.name}`,
      value: ui.drafts.rename,
      oninput: (e) => { ui.drafts.rename = e.target.value; },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancelRow(account);
        }
      },
    }),
    h('button', { type: 'submit', class: 'btn btn-sm btn-primary', testid: 'rename-save' }, 'Save'),
    h('button', { type: 'button', class: 'btn btn-sm', testid: 'rename-cancel', onclick: () => onCancelRow(account) }, 'Cancel'),
  );
}

function renderFooter(state, accounts) {
  els.footer.hidden = false;
  const pending = Boolean(state.pending);
  // While an add is pending, beginAdd just re-opens the sign-in tab.
  els.addLabel.textContent = pending ? 'Reopen sign-in page' : 'Add account';
  els.addIcon.textContent = pending ? '↗' : '+';
  els.addAccount.classList.toggle('btn-primary', !pending && accounts.length === 0);
  els.addAccount.classList.toggle('btn-dashed', !pending && accounts.length > 0);
  els.deepClean.checked = Boolean(state.settings?.deepClean);
}

function renderMessage() {
  const msg = ui.message;
  els.messageBox.hidden = !msg;
  els.messageBox.className = `message${msg ? ` message-${msg.kind}` : ''}`;
  els.message.setAttribute('role', msg?.kind === 'error' ? 'alert' : 'status');
  const lines = msg ? msg.lines.map((line) => h('span', { class: 'message-line' }, line)) : [];
  els.message.replaceChildren(...lines);
}

function applyBusy() {
  const busy = isBusy();
  document.body.dataset.busy = String(busy);
  els.main.setAttribute('aria-busy', String(busy));
  const label = busy ? (ui.inFlight > 0 && ui.busyLabel) || 'Working…' : '';
  els.status.textContent = label;
  els.spinner.setAttribute('aria-label', label || 'Idle');
  for (const control of document.querySelectorAll('#main button, #main input, #footer button, #footer input')) {
    control.disabled = busy;
  }
}

function schedulePoll() {
  clearTimeout(ui.pollTimer);
  // Another context (e.g. a previous popup) started an operation: watch until it ends.
  if (ui.inFlight === 0 && ui.state?.busy === true) {
    ui.pollTimer = setTimeout(refresh, POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Global listeners

els.addAccount.addEventListener('click', onAddAccount);
els.deepClean.addEventListener('change', onDeepCleanChange);
els.messageDismiss.addEventListener('click', () => {
  ui.message = null;
  renderMessage();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !ui.rowId) return;
  const id = ui.rowId;
  // A cancelled switch confirmation returns to the row it was opened from.
  const testid = ui.rowMode === 'confirm-switch' ? 'switch' : 'menu';
  e.preventDefault(); // keep the popup open; Esc only closes the row's menu
  closeRow();
  render({ focus: { testid, id } });
});

document.addEventListener('click', (e) => {
  if (!ui.rowId || !(e.target instanceof Element)) return;
  // Ignore clicks on nodes a handler just replaced; they no longer describe where the user is.
  if (!e.target.isConnected) return;
  if (e.target.closest('[data-id]')?.dataset.id === ui.rowId) return;
  // Re-rendering here would detach the clicked submit button's form before the
  // browser submits it (and the submit would be dropped); the submit handler
  // closes the row itself.
  if (e.target.closest('#main form button[type="submit"]')) return;
  closeRow();
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.state) refresh();
});

// Initial load.
request({ type: 'getState' }).then(() => {
  if (ui.state?.pending) restoreFocus({ testid: 'new-account-name' });
});
