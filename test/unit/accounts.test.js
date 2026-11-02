import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { COLORS, initials, createAccountStore } from '../../extension/lib/accounts.js';
import { createFakeStorage } from '../helpers/fake-storage.js';

const NAME_MESSAGE = 'Name must be 1–40 characters';
const NAME_ERROR = { name: 'Error', message: NAME_MESSAGE };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cookie = (name, value = 'v') => ({
  name, value, domain: '.zoho.com', hostOnly: false, path: '/', secure: true,
  httpOnly: true, sameSite: 'lax', session: true,
});

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Deterministic jitter so concurrent storage calls resolve out of step.
function jitter(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % 3;
  };
}

describe('fake chrome.storage.local', () => {
  test('get supports null, string, array and defaults-object forms', async () => {
    const s = createFakeStorage({ a: 1, b: { x: 2 }, c: null });
    assert.deepEqual(await s.get(null), { a: 1, b: { x: 2 }, c: null });
    assert.deepEqual(await s.get(), { a: 1, b: { x: 2 }, c: null });
    assert.deepEqual(await s.get('a'), { a: 1 });
    assert.deepEqual(await s.get('missing'), {});
    assert.deepEqual(await s.get(['a', 'c', 'missing']), { a: 1, c: null });
    assert.deepEqual(await s.get({ a: 0, z: 'dflt' }), { a: 1, z: 'dflt' });
  });

  test('values are deep-cloned in and out', async () => {
    const s = createFakeStorage();
    const obj = { nested: { n: 1 } };
    await s.set({ obj });
    obj.nested.n = 2;
    const { obj: read1 } = await s.get('obj');
    assert.equal(read1.nested.n, 1);
    read1.nested.n = 3;
    const { obj: read2 } = await s.get('obj');
    assert.equal(read2.nested.n, 1);
  });

  test('remove, clear, and undefined values are not stored', async () => {
    const s = createFakeStorage({ a: 1, b: 2, c: 3 });
    await s.remove('a');
    await s.remove(['b']);
    assert.deepEqual(await s.get(null), { c: 3 });
    await s.set({ c: undefined, d: 4 });
    assert.deepEqual(await s.get(null), { c: 3, d: 4 });
    await s.clear();
    assert.deepEqual(await s.get(null), {});
  });

  test('operations resolve asynchronously', async () => {
    const s = createFakeStorage({ a: 1 });
    let resolved = false;
    const p = s.get('a').then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false);
    await p;
    assert.equal(resolved, true);
  });
});

describe('COLORS', () => {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  test('8 distinct hex colors', () => {
    assert.equal(COLORS.length, 8);
    assert.equal(new Set(COLORS.map((c) => c.toLowerCase())).size, 8);
    for (const c of COLORS) assert.match(c, /^#[0-9a-fA-F]{6}$/);
  });

  test('each is readable with white text (WCAG contrast >= 4.5)', () => {
    for (const c of COLORS) {
      const ratio = 1.05 / (luminance(c) + 0.05);
      assert.ok(ratio >= 4.5, `${c} contrast ${ratio.toFixed(2)}`);
    }
  });

  test('is frozen', () => assert.ok(Object.isFrozen(COLORS)));
});

describe('initials', () => {
  const cases = [
    ['TurfScout Ops', 'TO'],
    ['personal', 'PE'],
    ['x', 'X'],
    ['  spaced   out  ', 'SO'],
    ['Acme Corp Admin', 'AC'],
    ['john.doe@zoho.com', 'JD'],
    ['work-account', 'WA'],
    ['émile zola', 'ÉZ'],
    ['😀 Fun', 'FU'],
    ['42', '42'],
    ['', '?'],
    ['   ', '?'],
  ];
  for (const [name, expected] of cases) {
    test(`${JSON.stringify(name)} -> ${expected}`, () => assert.equal(initials(name), expected));
  }

  test('never more than 2 characters', () => {
    assert.equal(initials('straße'), 'ST');
    assert.ok([...initials('ßß')].length <= 2);
  });
});

describe('createAccountStore', () => {
  test('importing and creating does not touch chrome', () => {
    assert.equal(globalThis.chrome, undefined);
    assert.doesNotThrow(() => createAccountStore(createFakeStorage()));
  });

  test('default storage is read lazily from globalThis.chrome.storage.local', async () => {
    const storage = createFakeStorage({ activeId: null });
    globalThis.chrome = { storage: { local: storage } };
    try {
      const store = createAccountStore();
      await store.create({ name: 'Lazy', cookies: [] });
      assert.equal(Object.keys(storage.dump().accounts).length, 1);
    } finally {
      delete globalThis.chrome;
    }
  });

  describe('getState', () => {
    test('fills defaults on empty storage', async () => {
      const store = createAccountStore(createFakeStorage());
      assert.deepEqual(await store.getState(), {
        accounts: {}, order: [], activeId: null, settings: { deepClean: false }, pending: null, switching: null,
      });
    });

    test('merges stored settings over defaults and keeps stored values', async () => {
      const pending = { previousId: null, startedAt: 5 };
      const store = createAccountStore(createFakeStorage({ settings: {}, activeId: 'a', pending }));
      const state = await store.getState();
      assert.deepEqual(state.settings, { deepClean: false });
      assert.equal(state.activeId, 'a');
      assert.deepEqual(state.pending, pending);
    });
  });

  describe('create', () => {
    test('creates an account, persists it and appends it to order', async () => {
      const c = clock(5_000);
      const storage = createFakeStorage();
      const store = createAccountStore(storage, { now: c.now });
      const cookies = [cookie('A'), cookie('B')];
      const acct = await store.create({ name: '  Work  ', cookies });
      assert.match(acct.id, UUID);
      assert.deepEqual(acct, {
        id: acct.id, name: 'Work', color: COLORS[0], cookies, createdAt: 5_000, savedAt: 5_000,
      });
      const dump = storage.dump();
      assert.deepEqual(dump.accounts[acct.id], acct);
      assert.deepEqual(dump.order, [acct.id]);

      const second = await store.create({ name: 'Personal', cookies: [] });
      assert.deepEqual(storage.dump().order, [acct.id, second.id]);
      assert.notEqual(second.id, acct.id);
    });

    test('cookies default to []', async () => {
      const store = createAccountStore(createFakeStorage());
      const a = await store.create({ name: 'NoCookies' });
      assert.deepEqual(a.cookies, []);
    });

    test('validates names: 1–40 chars after trimming', async () => {
      const store = createAccountStore(createFakeStorage());
      for (const bad of ['', '   ', 'x'.repeat(41), `  ${'y'.repeat(41)}  `, undefined, null, 42]) {
        await assert.rejects(store.create({ name: bad, cookies: [] }), NAME_ERROR, String(bad));
      }
      assert.equal((await store.create({ name: 'x'.repeat(40), cookies: [] })).name, 'x'.repeat(40));
      assert.equal((await store.create({ name: `  ${'z'.repeat(40)}  `, cookies: [] })).name, 'z'.repeat(40));
      assert.equal((await store.list()).length, 2);
    });

    test('picks the first unused color, reuses freed colors, cycles when all are used', async () => {
      const store = createAccountStore(createFakeStorage());
      const made = [];
      for (let i = 0; i < 8; i += 1) made.push(await store.create({ name: `A${i}`, cookies: [] }));
      assert.deepEqual(made.map((a) => a.color), COLORS);

      const ninth = await store.create({ name: 'Ninth', cookies: [] });
      assert.equal(ninth.color, COLORS[0]);
      const tenth = await store.create({ name: 'Tenth', cookies: [] });
      assert.equal(tenth.color, COLORS[1]);

      const store2 = createAccountStore(createFakeStorage());
      const a = await store2.create({ name: 'a', cookies: [] });
      await store2.create({ name: 'b', cookies: [] });
      await store2.remove(a.id);
      const c = await store2.create({ name: 'c', cookies: [] });
      assert.equal(c.color, COLORS[0], 'freed color is reused first');
    });
  });

  describe('list and get', () => {
    test('list returns summaries in order without cookie arrays', async () => {
      const c = clock(100);
      const store = createAccountStore(createFakeStorage(), { now: c.now });
      const a = await store.create({ name: 'TurfScout Ops', cookies: [cookie('A'), cookie('B')] });
      c.advance(10);
      const b = await store.create({ name: 'personal', cookies: [] });
      assert.deepEqual(await store.list(), [
        { id: a.id, name: 'TurfScout Ops', color: COLORS[0], initials: 'TO', createdAt: 100, savedAt: 100, cookieCount: 2 },
        { id: b.id, name: 'personal', color: COLORS[1], initials: 'PE', createdAt: 110, savedAt: 110, cookieCount: 0 },
      ]);
    });

    test('list follows the stored order and tolerates stale ids', async () => {
      const acct = (id, createdAt) => ({ id, name: id, color: COLORS[0], cookies: [], createdAt, savedAt: createdAt });
      const storage = createFakeStorage({
        accounts: { a: acct('a', 1), b: acct('b', 2), c: acct('c', 3) },
        order: ['c', 'ghost', 'a', 'c'],
      });
      const store = createAccountStore(storage);
      // stale/duplicate ids dropped; accounts missing from order appended by createdAt
      assert.deepEqual((await store.list()).map((s) => s.id), ['c', 'a', 'b']);
    });

    test('list is empty on empty storage', async () => {
      assert.deepEqual(await createAccountStore(createFakeStorage()).list(), []);
    });

    test('get returns the full account or null', async () => {
      const store = createAccountStore(createFakeStorage());
      const a = await store.create({ name: 'Work', cookies: [cookie('A')] });
      assert.deepEqual(await store.get(a.id), a);
      assert.equal(await store.get('nope'), null);
      assert.equal(await store.get(undefined), null);
    });

    test('returned objects are copies', async () => {
      const store = createAccountStore(createFakeStorage());
      const a = await store.create({ name: 'Work', cookies: [cookie('A')] });
      a.cookies.push(cookie('X'));
      a.name = 'mutated';
      const got = await store.get(a.id);
      assert.equal(got.cookies.length, 1);
      assert.equal(got.name, 'Work');
      got.cookies.length = 0;
      assert.equal((await store.get(a.id)).cookies.length, 1);
    });
  });

  describe('updateCookies', () => {
    test('replaces cookies and bumps savedAt', async () => {
      const c = clock(1_000);
      const store = createAccountStore(createFakeStorage(), { now: c.now });
      const a = await store.create({ name: 'Work', cookies: [cookie('A')] });
      c.advance(500);
      const updated = await store.updateCookies(a.id, [cookie('B'), cookie('C')]);
      assert.equal(updated.savedAt, 1_500);
      assert.equal(updated.createdAt, 1_000);
      const got = await store.get(a.id);
      assert.deepEqual(got.cookies.map((x) => x.name), ['B', 'C']);
      assert.equal(got.savedAt, 1_500);
    });

    test('is a no-op for an unknown id', async () => {
      const storage = createFakeStorage();
      const store = createAccountStore(storage);
      await store.create({ name: 'Work', cookies: [] });
      const before = storage.dump();
      assert.equal(await store.updateCookies('nope', [cookie('A')]), null);
      assert.deepEqual(storage.dump(), before);
    });
  });

  describe('rename', () => {
    test('renames with validation', async () => {
      const store = createAccountStore(createFakeStorage());
      const a = await store.create({ name: 'Work', cookies: [] });
      const r = await store.rename(a.id, '  Office  ');
      assert.equal(r.name, 'Office');
      assert.equal((await store.get(a.id)).name, 'Office');
      assert.equal((await store.list())[0].initials, 'OF');
      await assert.rejects(store.rename(a.id, '   '), NAME_ERROR);
      await assert.rejects(store.rename(a.id, 'q'.repeat(41)), NAME_ERROR);
      assert.equal((await store.get(a.id)).name, 'Office');
    });

    test('unknown id throws', async () => {
      const store = createAccountStore(createFakeStorage());
      await assert.rejects(store.rename('nope', 'Name'), /^Error: Unknown account$/);
    });
  });

  describe('remove', () => {
    test('deletes the account and its order entry; clears activeId when it was active', async () => {
      const storage = createFakeStorage();
      const store = createAccountStore(storage);
      const a = await store.create({ name: 'A', cookies: [] });
      const b = await store.create({ name: 'B', cookies: [] });
      await store.setActiveId(a.id);
      assert.equal(await store.remove(a.id), true);
      assert.equal(await store.get(a.id), null);
      assert.deepEqual(storage.dump().order, [b.id]);
      assert.equal(await store.getActiveId(), null);
    });

    test('keeps activeId when another account is removed', async () => {
      const store = createAccountStore(createFakeStorage());
      const a = await store.create({ name: 'A', cookies: [] });
      const b = await store.create({ name: 'B', cookies: [] });
      await store.setActiveId(a.id);
      await store.remove(b.id);
      assert.equal(await store.getActiveId(), a.id);
    });

    test('unknown id is a no-op returning false', async () => {
      const storage = createFakeStorage();
      const store = createAccountStore(storage);
      await store.create({ name: 'A', cookies: [] });
      const before = storage.dump();
      assert.equal(await store.remove('nope'), false);
      assert.deepEqual(storage.dump(), before);
    });
  });

  describe('activeId', () => {
    test('get/set, including null', async () => {
      const store = createAccountStore(createFakeStorage());
      assert.equal(await store.getActiveId(), null);
      const a = await store.create({ name: 'A', cookies: [] });
      await store.setActiveId(a.id);
      assert.equal(await store.getActiveId(), a.id);
      assert.equal((await store.getState()).activeId, a.id);
      await store.setActiveId(null);
      assert.equal(await store.getActiveId(), null);
    });

    test('setting an unknown id throws and leaves activeId unchanged', async () => {
      const store = createAccountStore(createFakeStorage());
      const a = await store.create({ name: 'A', cookies: [] });
      await store.setActiveId(a.id);
      await assert.rejects(store.setActiveId('nope'), /^Error: Unknown account$/);
      assert.equal(await store.getActiveId(), a.id);
    });
  });

  describe('settings', () => {
    test('defaults, merge, and returns merged settings', async () => {
      const storage = createFakeStorage();
      const store = createAccountStore(storage);
      assert.deepEqual(await store.getSettings(), { deepClean: false });
      assert.deepEqual(await store.updateSettings({ deepClean: true }), { deepClean: true });
      assert.deepEqual(await store.getSettings(), { deepClean: true });
      assert.deepEqual(storage.dump().settings, { deepClean: true });
      assert.deepEqual(await store.updateSettings({}), { deepClean: true });
    });

    test('ignores unknown keys and rejects wrong types', async () => {
      const store = createAccountStore(createFakeStorage());
      assert.deepEqual(await store.updateSettings({ evil: 1, deepClean: true }), { deepClean: true });
      await assert.rejects(store.updateSettings({ deepClean: 'yes' }), TypeError);
      await assert.rejects(store.updateSettings(null), TypeError);
      assert.deepEqual(await store.getSettings(), { deepClean: true });
    });
  });

  describe('pending', () => {
    test('get/set/clear', async () => {
      const store = createAccountStore(createFakeStorage());
      assert.equal(await store.getPending(), null);
      const p = { previousId: 'abc', startedAt: 123 };
      await store.setPending(p);
      assert.deepEqual(await store.getPending(), p);
      await store.setPending({ previousId: null, startedAt: 9 });
      assert.deepEqual(await store.getPending(), { previousId: null, startedAt: 9 });
      await store.setPending(null);
      assert.equal(await store.getPending(), null);
    });

    test('rejects malformed pending values', async () => {
      const store = createAccountStore(createFakeStorage());
      await assert.rejects(store.setPending('yes'), TypeError);
      await assert.rejects(store.setPending({ previousId: 1, startedAt: 1 }), TypeError);
      await assert.rejects(store.setPending({ previousId: null }), TypeError);
      await assert.rejects(store.setPending({ previousId: null, startedAt: 1, previousCookies: 'x' }), TypeError);
      await assert.rejects(store.setPending({ previousId: null, startedAt: 1, previousCookies: null }), TypeError);
      assert.equal(await store.getPending(), null);
    });

    test('optional previousCookies (an unsaved session stashed by beginAdd) round-trips', async () => {
      const storage = createFakeStorage();
      const store = createAccountStore(storage);
      const p = { previousId: null, startedAt: 2, previousCookies: [cookie('A'), cookie('B')] };
      assert.deepEqual(await store.setPending(p), p);
      assert.deepEqual(await store.getPending(), p);
      assert.deepEqual(storage.dump().pending, p);
      assert.deepEqual(await store.setPending({ previousId: 'x', startedAt: 3, junk: 1 }), { previousId: 'x', startedAt: 3 });
    });
  });

  describe('switching (switch-in-progress marker)', () => {
    test('get/set/clear; included in getState', async () => {
      const storage = createFakeStorage();
      const store = createAccountStore(storage);
      assert.equal(await store.getSwitching(), null);
      const m = { from: 'a', to: 'b', startedAt: 7 };
      assert.deepEqual(await store.setSwitching(m), m);
      assert.deepEqual(await store.getSwitching(), m);
      assert.deepEqual((await store.getState()).switching, m);
      assert.deepEqual(storage.dump().switching, m);
      await store.setSwitching({ from: null, to: 'b', startedAt: 8 });
      assert.deepEqual(await store.getSwitching(), { from: null, to: 'b', startedAt: 8 });
      await store.setSwitching(null);
      assert.equal(await store.getSwitching(), null);
      assert.equal((await store.getState()).switching, null);
    });

    test('drops unknown fields and rejects malformed markers', async () => {
      const store = createAccountStore(createFakeStorage());
      assert.deepEqual(await store.setSwitching({ from: 'a', to: 'b', startedAt: 1, extra: 1 }), { from: 'a', to: 'b', startedAt: 1 });
      for (const bad of ['yes', {}, { from: 'a', to: null, startedAt: 1 }, { from: 1, to: 'b', startedAt: 1 }, { from: 'a', to: 'b' }]) {
        await assert.rejects(store.setSwitching(bad), TypeError, JSON.stringify(bad));
      }
      assert.deepEqual(await store.getSwitching(), { from: 'a', to: 'b', startedAt: 1 });
    });

    test('a malformed stored value reads as null', async () => {
      const store = createAccountStore(createFakeStorage({ switching: 'garbage' }));
      assert.equal(await store.getSwitching(), null);
    });
  });

  describe('mutex', () => {
    test('many concurrent create() calls never lose a write', async () => {
      const storage = createFakeStorage({}, { latency: jitter() });
      const store = createAccountStore(storage);
      const N = 25;
      const made = await Promise.all(
        Array.from({ length: N }, (_, i) => store.create({ name: `Acct ${i}`, cookies: [cookie(`c${i}`)] })),
      );
      const dump = storage.dump();
      assert.equal(Object.keys(dump.accounts).length, N);
      assert.deepEqual(dump.order, made.map((a) => a.id), 'order follows call order');
      // colors were assigned as if sequential
      assert.deepEqual(made.slice(0, 8).map((a) => a.color), COLORS);
    });

    test('mixed concurrent mutations are applied in call order without losing any', async () => {
      const storage = createFakeStorage({}, { latency: jitter(3) });
      const store = createAccountStore(storage);
      const a = await store.create({ name: 'A', cookies: [] });

      const ops = [];
      for (let i = 0; i < 10; i += 1) {
        ops.push(store.updateCookies(a.id, [cookie(`round${i}`)]));
        ops.push(store.create({ name: `New ${i}`, cookies: [] }));
      }
      ops.push(store.rename(a.id, 'Renamed'));
      ops.push(store.setActiveId(a.id));
      ops.push(store.updateSettings({ deepClean: true }));
      ops.push(store.setPending({ previousId: a.id, startedAt: 1 }));
      ops.push(store.create({ name: 'x'.repeat(99), cookies: [] }).catch((e) => e)); // failure mid-chain
      ops.push(store.create({ name: 'After failure', cookies: [] }));
      const results = await Promise.all(ops);

      assert.equal(results.at(-2).message, NAME_MESSAGE);
      const state = await store.getState();
      assert.equal(Object.keys(state.accounts).length, 12);
      assert.equal(state.order.length, 12);
      assert.equal(state.accounts[a.id].name, 'Renamed');
      assert.deepEqual(state.accounts[a.id].cookies.map((x) => x.name), ['round9'], 'last update wins');
      assert.equal(state.activeId, a.id);
      assert.deepEqual(state.settings, { deepClean: true });
      assert.deepEqual(state.pending, { previousId: a.id, startedAt: 1 });
      assert.equal(state.accounts[state.order.at(-1)].name, 'After failure');
    });

    test('concurrent remove + create do not resurrect or drop accounts', async () => {
      const storage = createFakeStorage({}, { latency: jitter(11) });
      const store = createAccountStore(storage);
      const first = await Promise.all([1, 2, 3, 4].map((i) => store.create({ name: `K${i}`, cookies: [] })));
      await Promise.all([
        store.remove(first[0].id),
        store.create({ name: 'K5', cookies: [] }),
        store.remove(first[2].id),
        store.create({ name: 'K6', cookies: [] }),
      ]);
      const names = (await store.list()).map((s) => s.name);
      assert.deepEqual(names, ['K2', 'K4', 'K5', 'K6']);
    });

    test('a read issued after a mutation sees that mutation', async () => {
      const storage = createFakeStorage({}, { latency: jitter(5) });
      const store = createAccountStore(storage);
      const created = store.create({ name: 'A', cookies: [] });
      const listed = store.list();
      const [a, list] = await Promise.all([created, listed]);
      assert.deepEqual(list.map((s) => s.id), [a.id]);
    });
  });
});
