import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBadge, PENDING_COLOR, DEFAULT_TITLE } from '../../extension/lib/badge.js';

function fakeAction() {
  const calls = [];
  const rec = (name) => async (details) => { calls.push([name, details]); };
  return {
    calls,
    setBadgeText: rec('setBadgeText'),
    setBadgeBackgroundColor: rec('setBadgeBackgroundColor'),
    setBadgeTextColor: rec('setBadgeTextColor'),
    setTitle: rec('setTitle'),
    last(name) {
      const hit = calls.filter(([n]) => n === name).at(-1);
      return hit ? hit[1] : undefined;
    },
  };
}

const acct = { id: 'a1', name: 'TurfScout Ops', color: '#2563eb', initials: 'TO' };

test('active account: initials on the account colour, title names the account', async () => {
  const action = fakeAction();
  await createBadge(action).show({ active: acct, pending: false });
  assert.deepEqual(action.last('setBadgeText'), { text: 'TO' });
  assert.deepEqual(action.last('setBadgeBackgroundColor'), { color: '#2563eb' });
  assert.deepEqual(action.last('setTitle'), { title: 'Zoho: TurfScout Ops' });
});

test('pending add: "+" on grey, even if an account summary is passed', async () => {
  const action = fakeAction();
  await createBadge(action).show({ active: acct, pending: true });
  assert.deepEqual(action.last('setBadgeText'), { text: '+' });
  assert.deepEqual(action.last('setBadgeBackgroundColor'), { color: PENDING_COLOR });
  assert.match(action.last('setTitle').title, /^Zoho/);
});

test('no account: empty text and the default title', async () => {
  const action = fakeAction();
  await createBadge(action).show({ active: null, pending: false });
  assert.deepEqual(action.last('setBadgeText'), { text: '' });
  assert.deepEqual(action.last('setTitle'), { title: DEFAULT_TITLE });
  assert.equal(DEFAULT_TITLE, 'Zoho Account Switcher');
});

test('falls back to computed initials when the summary lacks them', async () => {
  const action = fakeAction();
  await createBadge(action).show({ active: { id: 'x', name: 'personal', color: '#000000' }, pending: false });
  assert.deepEqual(action.last('setBadgeText'), { text: 'PE' });
});

test('works when setBadgeTextColor is unavailable (older Chrome)', async () => {
  const action = fakeAction();
  delete action.setBadgeTextColor;
  await createBadge(action).show({ active: acct, pending: false });
  assert.deepEqual(action.last('setBadgeText'), { text: 'TO' });
});

test('show() with no arguments behaves like "no account"', async () => {
  const action = fakeAction();
  await createBadge(action).show();
  assert.deepEqual(action.last('setBadgeText'), { text: '' });
});

test('defaults to globalThis.chrome.action lazily (not at import time)', async () => {
  const action = fakeAction();
  const saved = globalThis.chrome;
  globalThis.chrome = { action };
  try {
    await createBadge().show({ active: acct, pending: false });
  } finally {
    if (saved === undefined) delete globalThis.chrome; else globalThis.chrome = saved;
  }
  assert.deepEqual(action.last('setBadgeText'), { text: 'TO' });
});
