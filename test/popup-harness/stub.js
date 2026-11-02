// Dev-only: a fake `chrome.runtime.sendMessage` for viewing the real popup
// outside the extension. Injected (as a classic script, before popup.js) by
// serve.mjs when popup.html is requested with ?scenario=<name>.
//
// Query params:
//   scenario=<name>          initial state (see SCENARIOS below)
//   delay=<ms>               simulated background latency (default 500)
//   click=<testid>@<id>,...  clicks to perform after the first render, in order
//                            (e.g. click=menu@a2,rename@a2); `@id` is optional
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
    acct('a1', 'TurfScout Ops', 'TO', '#1565c0', 20e3),
    acct('a2', 'Personal', 'PE', '#2e7d32', 3 * HOUR),
    acct('a3', 'Acme Corp — Admin', 'AC', '#c62828', 26 * HOUR),
    acct('a4', 'Client: Northwind Traders International', 'CN', '#6a1b9a', 9 * 24 * HOUR),
  ];

  const MANY = [
    ...FOUR,
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

  const SCENARIOS = {
    list: { state: base() },
    'deep-clean-on': { state: base({ settings: { deepClean: true } }) },
    many: { state: base({ accounts: MANY, activeId: 'a5' }) },
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
  const createActive = (name) => {
    const id = `n${nextId++}`;
    db.accounts = [...db.accounts, {
      id, name, initials: initials(name), color: COLORS[db.accounts.length % COLORS.length],
      cookieCount: 18, createdAt: Date.now(), savedAt: Date.now(),
    }];
    db.activeId = id;
  };

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
      if (!db.pending) db.pending = { previousId: db.activeId, startedAt: Date.now() };
      db.activeId = null;
      return { warnings: [] };
    },
    finishAdd: ({ name }) => {
      need(db.pending, 'No account is being added');
      createActive(checkName(name));
      db.pending = null;
      return {};
    },
    cancelAdd: () => {
      need(db.pending, 'No account is being added');
      db.activeId = findAcct(db.pending.previousId) ? db.pending.previousId : null;
      db.pending = null;
      return { warnings: [] };
    },
    saveCurrentAs: ({ name }) => {
      need(!db.pending && db.activeId === null, 'An account is already active');
      createActive(checkName(name));
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
  };

  const sent = [];
  window.__stub = { sent };

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

  // Scripted clicks for screenshots of row menus / rename / confirm states.
  const clicks = (params.get('click') || '').split(',').filter(Boolean);
  if (clicks.length) {
    window.addEventListener('load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(400);
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
