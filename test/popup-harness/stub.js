// Dev-only: a fake `chrome.runtime.sendMessage` for viewing the real popup
// outside the extension. Injected (as a classic script, before popup.js) by
// serve.mjs when popup.html is requested with ?scenario=<name>.
//
// Query params:
//   scenario=<name>          initial state (see SCENARIOS below)
//   delay=<ms>               simulated background latency (default 500)
//   fill=<testid>=<text>     type into an input after the first render (repeatable;
//                            runs before `click`), e.g. fill=new-account-name=Work
//   click=<testid>@<id>,...  clicks to perform after the first render, in order
//                            (e.g. click=menu@a2,rename@a2); `@id` is optional
//
// A scenario whose state has `incognitoAllowed: true` makes beginAdd / finishAdd /
// cancelAdd behave like the background's private-window mode (the current account
// stays active; finishAdd returns a `notice`). Otherwise they use the sign-out
// flow. In private mode finishAdd succeeds while the private window is open (the
// stub assumes you signed in there) or once a sign-in was captured.
//
// Every request is also recorded in `window.__stub.sent` (at call time) so the
// self-test can assert exactly what the popup sent.
(() => {
  const params = new URLSearchParams(location.search);
  const DELAY = Number(params.get('delay') ?? 500);
  const HOUR = 3600e3;
  const now = Date.now();

  const acct = (id, name, initials, color, savedAgo, cookieCount = 24) => ({
    id, name, initials, color, cookieCount,
    createdAt: now - 30 * 24 * HOUR,
    savedAt: now - savedAgo,
  });

  const FOUR = [
    acct('a1', 'Work', 'WO', '#1565c0', 20e3),
    acct('a2', 'Personal', 'PE', '#2e7d32', 3 * HOUR),
    acct('a3', 'Acme Corp — Admin', 'AC', '#c62828', 26 * HOUR),
    acct('a4', 'Client: Northwind', 'CN', '#6a1b9a', 9 * 24 * HOUR),
  ];

  const MANY = [
    ...FOUR,
    // Longest allowed name (40), active: checks truncation next to the Active pill.
    acct('a9', 'Northwind Traders International, Billing', 'NT', '#1565c0', 6 * 24 * HOUR),
    acct('a5', 'Support desk', 'SD', '#bf360c', 5 * 60e3),
    acct('a6', 'Vault (shared)', 'VS', '#00695c', 40 * 24 * HOUR),
    acct('a7', 'Billing', 'BI', '#ad1457', 2 * HOUR),
    acct('a8', 'x', 'X', '#455a64', 50 * 60e3, 0),
  ];

  const base = (over) => ({
    accounts: FOUR,
    activeId: 'a1',
    pending: null,
    settings: { deepClean: false },
    busy: false,
    ...over,
  });

  /** state.pending for a private-window add, as the background sends it. */
  const privatePending = (over) => ({
    mode: 'private', previousId: 'a1', startedAt: now - 40e3, windowOpen: true, captured: false, ...over,
  });

  const SCENARIOS = {
    list: { state: base() },
    'incognito-off': { state: base({ incognitoAllowed: false }) },
    'private-pending': { state: base({ incognitoAllowed: true, pending: privatePending({ captured: true }) }) },
    'private-closed-captured': {
      state: base({ incognitoAllowed: true, pending: privatePending({ windowOpen: false, captured: true }) }),
    },
    'private-closed': {
      state: base({ incognitoAllowed: true, pending: privatePending({ windowOpen: false, captured: false }) }),
    },
    'deep-clean-on': { state: base({ settings: { deepClean: true } }) },
    many: { state: base({ accounts: MANY, activeId: 'a9' }) },
    pending: { state: base({ activeId: null, pending: { previousId: 'a1', startedAt: now - 30e3 } }) },
    'pending-first': { state: base({ accounts: [], activeId: null, pending: { previousId: null, startedAt: now } }) },
    'no-active': { state: base({ activeId: null }) },
    empty: { state: base({ accounts: [], activeId: null }) },
    error: {
      state: base(),
      getState: (state) => ({ ok: false, error: 'Unknown account', state }),
    },
    warning: {
      state: base(),
      getState: (state) => ({
        ok: true,
        state,
        warnings: [
          '2 cookies could not be restored (__Host-zalb, JSESSIONID).',
          '1 Zoho tab could not be reloaded.',
        ],
      }),
    },
    busy: { state: base({ busy: true }) },
  };

  const scenario = SCENARIOS[params.get('scenario')] ?? SCENARIOS.list;
  const db = structuredClone(scenario.state);
  // Mirrors COLORS in extension/lib/accounts.js.
  const COLORS = ['#1565c0', '#c62828', '#2e7d32', '#6a1b9a', '#bf360c', '#00695c', '#ad1457', '#455a64'];

  const initials = (name) => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const raw = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
    return raw.toUpperCase();
  };
  // Mirrors validName in extension/lib/accounts.js: 1–40 Unicode code points after trim.
  const checkName = (name) => {
    const n = String(name ?? '').trim();
    const length = [...n].length;
    if (length < 1 || length > 40) throw new Error('Name must be 1–40 characters');
    return n;
  };
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const findAcct = (id) => db.accounts.find((a) => a.id === id);
  let nextId = 100;
  const createAccount = (name, { activate = true } = {}) => {
    const id = `n${nextId++}`;
    db.accounts = [...db.accounts, {
      id, name, initials: initials(name), color: COLORS[db.accounts.length % COLORS.length],
      cookieCount: 18, createdAt: Date.now(), savedAt: Date.now(),
    }];
    if (activate) db.activeId = id;
  };
  const isPrivate = (pending) => pending?.mode === 'private';

  const handlers = {
    getState: () => ({}),
    switch: ({ id }) => {
      need(!db.pending, 'Finish or cancel adding an account first');
      need(findAcct(id), 'Unknown account');
      db.activeId = id;
      findAcct(id).savedAt = Date.now();
      return { warnings: [] };
    },
    beginAdd: () => {
      if (isPrivate(db.pending)) {
        // Window open: just focused. Closed: a new window with a fresh sign-in.
        if (!db.pending.windowOpen) db.pending = { ...db.pending, windowOpen: true, captured: false };
        return { warnings: [], mode: 'private' };
      }
      if (!db.pending && db.incognitoAllowed === true) {
        db.pending = {
          mode: 'private', previousId: db.activeId, startedAt: Date.now(), windowOpen: true, captured: false,
        };
        return { warnings: [], mode: 'private' };
      }
      if (!db.pending) {
        db.pending = {
          mode: 'signout', previousId: db.activeId, startedAt: Date.now(), windowOpen: false, captured: false,
        };
      }
      db.activeId = null;
      return { warnings: [], mode: 'signout' };
    },
    finishAdd: ({ name }) => {
      need(db.pending, 'No account is being added');
      const valid = checkName(name);
      if (isPrivate(db.pending)) {
        need(db.pending.windowOpen || db.pending.captured, 'Sign in to Zoho in the private window first');
        createAccount(valid, { activate: false });
        db.pending = null;
        return { notice: `Saved “${valid}”. Click it to switch.` };
      }
      createAccount(valid);
      db.pending = null;
      return {};
    },
    cancelAdd: () => {
      need(db.pending, 'No account is being added');
      if (!isPrivate(db.pending)) {
        db.activeId = findAcct(db.pending.previousId) ? db.pending.previousId : null;
      }
      db.pending = null;
      return { warnings: [] };
    },
    saveCurrentAs: ({ name }) => {
      need(!db.pending && db.activeId === null, 'An account is already active');
      createAccount(checkName(name));
      return {};
    },
    rename: ({ id, name }) => {
      const a = findAcct(id);
      need(a, 'Unknown account');
      a.name = checkName(name);
      a.initials = initials(a.name);
      return {};
    },
    remove: ({ id }) => {
      db.accounts = db.accounts.filter((a) => a.id !== id);
      if (db.activeId === id) db.activeId = null;
      return {};
    },
    setSettings: ({ patch }) => {
      db.settings = { ...db.settings, ...patch };
      return {};
    },
    // The real background opens chrome://extensions/?id=… in a new tab.
    openIncognitoSettings: () => ({}),
  };

  const sent = [];
  /** `db` is the fake background's state; the self-test edits it to simulate events. */
  window.__stub = { sent, db };

  let firstGetState = true;
  async function sendMessage(msg) {
    sent.push(structuredClone(msg));
    await new Promise((r) => setTimeout(r, msg.type === 'getState' && firstGetState ? 150 : DELAY));
    const state = () => structuredClone(db);
    console.log('[stub] →', JSON.stringify(msg));
    if (msg.type === 'getState' && firstGetState && scenario.getState) {
      firstGetState = false;
      return scenario.getState(state());
    }
    if (msg.type === 'getState') firstGetState = false;
    try {
      const handler = handlers[msg.type];
      if (!handler) throw new Error('Unknown request');
      const extra = handler(msg);
      return { ok: true, state: state(), ...extra };
    } catch (err) {
      return { ok: false, error: err.message, state: state() };
    }
  }

  Object.defineProperty(window, 'chrome', {
    value: { runtime: { sendMessage } },
    configurable: true,
    writable: true,
  });

  // Scripted typing and clicks for screenshots of row menus / rename / confirm states.
  const fills = params.getAll('fill').filter(Boolean);
  const clicks = (params.get('click') || '').split(',').filter(Boolean);
  if (fills.length || clicks.length) {
    window.addEventListener('load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(400);
      for (const fill of fills) {
        const at = fill.indexOf('=');
        const testid = at < 0 ? fill : fill.slice(0, at);
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (!el) { console.warn('[stub] missing', testid); continue; }
        el.value = at < 0 ? '' : fill.slice(at + 1);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      for (const step of clicks) {
        const [testid, id] = step.split('@');
        const scope = id ? `[data-id="${id}"] ` : '';
        const el = document.querySelector(`${scope}[data-testid="${testid}"]`);
        if (!el) { console.warn('[stub] missing', step); continue; }
        el.focus();
        el.click();
        await wait(100);
      }
    });
  }
})();
