// Saved Zoho accounts in chrome.storage.local.
// No `chrome` access at import time: storage is passed in (or read lazily from
// globalThis.chrome when createAccountStore() is called).
//
// Storage keys:
//   accounts: { [id]: Account }  Account = { id, name, color, cookies: SavedCookie[], createdAt, savedAt }
//   order:    string[]
//   activeId: string | null
//   settings: { deepClean: boolean }
//   pending:  null | { previousId: string|null, startedAt: number, previousCookies?: SavedCookie[] }
//             previousCookies: the unsaved session that was live when an add
//             began with no active account (cancelAdd puts it back)
//   switching: null | { from: string|null, to: string, startedAt: number }
//              set while switchTo has cookies in flux; survives a crash so the
//              next service worker can finish the switch (recoverInterruptedSwitch)

// Blue, red, green, purple, deep orange, teal, pink, blue grey.
// All have WCAG contrast >= 5:1 against white text.
export const COLORS = Object.freeze([
  '#1565c0', '#c62828', '#2e7d32', '#6a1b9a', '#bf360c', '#00695c', '#ad1457', '#455a64',
]);

const DEFAULT_SETTINGS = Object.freeze({ deepClean: false });
const STATE_KEYS = ['accounts', 'order', 'activeId', 'settings', 'pending', 'switching'];
const NAME_ERROR = 'Name must be 1–40 characters';
const MAX_NAME = 40;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ALNUM = /[\p{L}\p{N}]/u;

/** 'TurfScout Ops' -> 'TO', 'personal' -> 'PE', 'x' -> 'X'. Max 2 chars, uppercase. */
export function initials(name) {
  const words = String(name ?? '')
    .split(/[\s._@-]+/u)
    .map((w) => Array.from(w).filter((ch) => ALNUM.test(ch)))
    .filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  const chars = words.length === 1 ? words[0].slice(0, 2) : [words[0][0], words[1][0]];
  return Array.from(chars.join('').toUpperCase()).slice(0, 2).join('');
}

function validName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const length = Array.from(trimmed).length;
  if (length < 1 || length > MAX_NAME) throw new Error(NAME_ERROR);
  return trimmed;
}

function fillState(raw) {
  return {
    accounts: isObject(raw.accounts) ? raw.accounts : {},
    order: Array.isArray(raw.order) ? raw.order : [],
    activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
    settings: { ...DEFAULT_SETTINGS, ...(isObject(raw.settings) ? raw.settings : {}) },
    pending: isObject(raw.pending) ? raw.pending : null,
    switching: isObject(raw.switching) ? raw.switching : null,
  };
}

/** Ids in display order: stored order (deduped, existing only), then any strays by createdAt. */
function orderedIds(accounts, order) {
  const ids = [];
  const seen = new Set();
  for (const id of order) {
    if (Object.hasOwn(accounts, id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const strays = Object.keys(accounts)
    .filter((id) => !seen.has(id))
    .sort((a, b) => (accounts[a].createdAt ?? 0) - (accounts[b].createdAt ?? 0));
  return [...ids, ...strays];
}

/** First color nobody uses; if all are used, the first least-used one (so it cycles). */
function pickColor(accounts) {
  const uses = new Map(COLORS.map((c) => [c, 0]));
  for (const a of Object.values(accounts)) {
    if (uses.has(a.color)) uses.set(a.color, uses.get(a.color) + 1);
  }
  const least = Math.min(...uses.values());
  return COLORS.find((c) => uses.get(c) === least);
}

function summary(a) {
  return {
    id: a.id,
    name: a.name,
    color: a.color,
    initials: initials(a.name),
    createdAt: a.createdAt,
    savedAt: a.savedAt,
    cookieCount: Array.isArray(a.cookies) ? a.cookies.length : 0,
  };
}

function validPending(p) {
  if (p === null) return null;
  if (!isObject(p)
    || !(p.previousId === null || typeof p.previousId === 'string')
    || typeof p.startedAt !== 'number'
    || (p.previousCookies !== undefined && !Array.isArray(p.previousCookies))) {
    throw new TypeError(
      'pending must be null or { previousId: string|null, startedAt: number, previousCookies?: array }',
    );
  }
  const pending = { previousId: p.previousId, startedAt: p.startedAt };
  if (p.previousCookies !== undefined) pending.previousCookies = structuredClone(p.previousCookies);
  return pending;
}

function validSwitching(m) {
  if (m === null) return null;
  if (!isObject(m)
    || !(m.from === null || typeof m.from === 'string')
    || typeof m.to !== 'string'
    || typeof m.startedAt !== 'number') {
    throw new TypeError('switching must be null or { from: string|null, to: string, startedAt: number }');
  }
  return { from: m.from, to: m.to, startedAt: m.startedAt };
}

export function createAccountStore(
  storage = globalThis.chrome?.storage?.local,
  { now = () => Date.now() } = {},
) {
  const store = () => {
    if (!storage) throw new Error('chrome.storage.local is not available');
    return storage;
  };

  // Promise-chain mutex. Every operation (reads included, so a read issued after
  // a mutation sees it) runs after the previous one settles; read-modify-write
  // sequences never interleave. A failed operation doesn't break the chain.
  let tail = Promise.resolve();
  function exclusive(fn) {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  }

  const read = async (keys = STATE_KEYS) => fillState(await store().get(keys));
  const write = (items) => store().set(items);

  return {
    getState() {
      return exclusive(() => read());
    },

    list() {
      return exclusive(async () => {
        const { accounts, order } = await read(['accounts', 'order']);
        return orderedIds(accounts, order).map((id) => summary(accounts[id]));
      });
    },

    get(id) {
      return exclusive(async () => {
        const { accounts } = await read(['accounts']);
        return typeof id === 'string' && Object.hasOwn(accounts, id) ? accounts[id] : null;
      });
    },

    create({ name, cookies = [] } = {}) {
      return exclusive(async () => {
        const clean = validName(name);
        if (!Array.isArray(cookies)) throw new TypeError('cookies must be an array');
        const { accounts, order } = await read(['accounts', 'order']);
        const t = now();
        const account = {
          id: crypto.randomUUID(),
          name: clean,
          color: pickColor(accounts),
          cookies: structuredClone(cookies),
          createdAt: t,
          savedAt: t,
        };
        accounts[account.id] = account;
        await write({ accounts, order: [...orderedIds(accounts, order).filter((id) => id !== account.id), account.id] });
        return structuredClone(account);
      });
    },

    updateCookies(id, cookies) {
      return exclusive(async () => {
        if (!Array.isArray(cookies)) throw new TypeError('cookies must be an array');
        const { accounts } = await read(['accounts']);
        if (typeof id !== 'string' || !Object.hasOwn(accounts, id)) return null;
        accounts[id] = { ...accounts[id], cookies: structuredClone(cookies), savedAt: now() };
        await write({ accounts });
        return structuredClone(accounts[id]);
      });
    },

    rename(id, name) {
      return exclusive(async () => {
        const clean = validName(name);
        const { accounts } = await read(['accounts']);
        if (typeof id !== 'string' || !Object.hasOwn(accounts, id)) throw new Error('Unknown account');
        accounts[id] = { ...accounts[id], name: clean };
        await write({ accounts });
        return structuredClone(accounts[id]);
      });
    },

    /** Deletes the saved snapshot only. Returns false if there was nothing to remove. */
    remove(id) {
      return exclusive(async () => {
        const { accounts, order, activeId } = await read(['accounts', 'order', 'activeId']);
        const existed = typeof id === 'string' && Object.hasOwn(accounts, id);
        if (!existed && !order.includes(id) && activeId !== id) return false;
        if (existed) delete accounts[id];
        const items = { accounts, order: order.filter((x) => x !== id) };
        if (activeId === id) items.activeId = null;
        await write(items);
        return existed;
      });
    },

    getActiveId() {
      return exclusive(async () => (await read(['activeId'])).activeId);
    },

    setActiveId(idOrNull) {
      return exclusive(async () => {
        if (idOrNull !== null) {
          const { accounts } = await read(['accounts']);
          if (typeof idOrNull !== 'string' || !Object.hasOwn(accounts, idOrNull)) {
            throw new Error('Unknown account');
          }
        }
        await write({ activeId: idOrNull });
        return idOrNull;
      });
    },

    getSettings() {
      return exclusive(async () => (await read(['settings'])).settings);
    },

    /** Merges known keys (type-checked) into settings; unknown keys are ignored. Returns merged settings. */
    updateSettings(patch) {
      return exclusive(async () => {
        if (!isObject(patch)) throw new TypeError('settings patch must be an object');
        const { settings } = await read(['settings']);
        for (const [key, dflt] of Object.entries(DEFAULT_SETTINGS)) {
          if (!Object.hasOwn(patch, key)) continue;
          if (typeof patch[key] !== typeof dflt) throw new TypeError(`${key} must be a ${typeof dflt}`);
          settings[key] = patch[key];
        }
        await write({ settings });
        return settings;
      });
    },

    getPending() {
      return exclusive(async () => (await read(['pending'])).pending);
    },

    setPending(pendingOrNull) {
      return exclusive(async () => {
        const pending = validPending(pendingOrNull);
        await write({ pending });
        return pending;
      });
    },

    getSwitching() {
      return exclusive(async () => (await read(['switching'])).switching);
    },

    setSwitching(markerOrNull) {
      return exclusive(async () => {
        const switching = validSwitching(markerOrNull);
        await write({ switching });
        return switching;
      });
    },
  };
}
