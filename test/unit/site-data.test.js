import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteData, DEEP_CLEAN_DATA_TYPES } from '../../extension/lib/site-data.js';
import { ZOHO_HOST_PATTERNS, KNOWN_SUBDOMAINS, ZOHO_DOMAINS, SIGN_IN_URL } from '../../extension/lib/zoho-domains.js';

function fakes({ tabs: openTabs = [], executeScript, reload } = {}) {
  const log = [];
  const tabs = {
    async query(q) { log.push(['tabs.query', q]); return structuredClone(openTabs); },
    async reload(tabId) {
      log.push(['tabs.reload', tabId]);
      if (reload) return reload(tabId);
    },
    async create(props) { log.push(['tabs.create', props]); return { id: 999, ...props }; },
  };
  const scripting = {
    async executeScript(inj) {
      log.push(['scripting.executeScript', inj.target.tabId, inj]);
      if (executeScript) return executeScript(inj);
      return [{ result: undefined }];
    },
  };
  const browsingData = {
    async remove(options, dataTypes) { log.push(['browsingData.remove', options, dataTypes]); },
  };
  return { log, tabs, scripting, browsingData };
}

const zohoTabs = [
  { id: 1, url: 'https://mail.zoho.com/zm/#mail' },
  { id: 2, url: 'https://crm.zoho.in/crm/org1/tab/Home' },
  { id: 3, url: 'https://custom-tenant.zoho.eu/app' },
];

test('listZohoTabs queries tabs by the Zoho host patterns', async () => {
  const f = fakes({ tabs: zohoTabs });
  const result = await createSiteData(f).listZohoTabs();
  assert.deepEqual(f.log, [['tabs.query', { url: [...ZOHO_HOST_PATTERNS] }]]);
  assert.deepEqual(result.map((t) => t.id), [1, 2, 3]);
});

test('resetTabs clears sessionStorage in each tab, then reloads it', async () => {
  const f = fakes({ tabs: zohoTabs });
  const count = await createSiteData(f).resetTabs();
  assert.equal(count, 3);
  for (const id of [1, 2, 3]) {
    const exec = f.log.findIndex(([n, tabId]) => n === 'scripting.executeScript' && tabId === id);
    const rel = f.log.findIndex(([n, tabId]) => n === 'tabs.reload' && tabId === id);
    assert.ok(exec >= 0, `executeScript for tab ${id}`);
    assert.ok(rel > exec, `reload after executeScript for tab ${id}`);
    const inj = f.log[exec][2];
    assert.deepEqual(inj.target, { tabId: id, allFrames: true });
    assert.equal(typeof inj.func, 'function');
  }
});

test('the injected function clears sessionStorage', async () => {
  const f = fakes({ tabs: [zohoTabs[0]] });
  await createSiteData(f).resetTabs();
  const { func } = f.log.find(([n]) => n === 'scripting.executeScript')[2];
  let cleared = 0;
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: { clear() { cleared++; } }, configurable: true });
  try {
    func();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved);
    else delete globalThis.sessionStorage;
  }
  assert.equal(cleared, 1);
});

test('the injected function does not throw when sessionStorage is inaccessible', async () => {
  const f = fakes({ tabs: [zohoTabs[0]] });
  await createSiteData(f).resetTabs();
  const { func } = f.log.find(([n]) => n === 'scripting.executeScript')[2];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  try {
    assert.doesNotThrow(() => func());
  } finally {
    if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved);
    else delete globalThis.sessionStorage;
  }
});

test('resetTabs: a tab whose script injection fails is still reloaded, others unaffected', async () => {
  const f = fakes({
    tabs: zohoTabs,
    executeScript: (inj) => {
      if (inj.target.tabId === 2) throw new Error('Cannot access contents of the page (chrome-error://)');
      return [{ result: undefined }];
    },
  });
  const count = await createSiteData(f).resetTabs();
  assert.equal(count, 3);
  const reloaded = f.log.filter(([n]) => n === 'tabs.reload').map(([, id]) => id).sort();
  assert.deepEqual(reloaded, [1, 2, 3]);
});

test('resetTabs: a tab that fails to reload does not stop the others', async () => {
  const f = fakes({
    tabs: zohoTabs,
    reload: (tabId) => { if (tabId === 1) throw new Error('No tab with id: 1'); },
  });
  const count = await createSiteData(f).resetTabs();
  assert.equal(count, 2);
  const reloaded = f.log.filter(([n]) => n === 'tabs.reload').map(([, id]) => id).sort();
  assert.deepEqual(reloaded, [1, 2, 3]);
});

test('resetTabs: skips tabs without a usable id', async () => {
  const f = fakes({ tabs: [{ id: -1, url: 'https://mail.zoho.com/' }, { url: 'https://mail.zoho.com/' }, zohoTabs[0]] });
  const count = await createSiteData(f).resetTabs();
  assert.equal(count, 1);
  assert.deepEqual(f.log.filter(([n]) => n === 'tabs.reload').map(([, id]) => id), [1]);
});

test('resetTabs with no Zoho tabs returns 0', async () => {
  const f = fakes();
  assert.equal(await createSiteData(f).resetTabs(), 0);
});

test('deepClean removes storage (never cookies) for all known + open Zoho origins', async () => {
  const f = fakes({ tabs: [...zohoTabs, { id: 4, url: 'https://mail.zoho.com/other' }, { id: 5 }] });
  await createSiteData(f).deepClean();
  const call = f.log.find(([n]) => n === 'browsingData.remove');
  assert.ok(call, 'browsingData.remove called');
  const [, options, dataTypes] = call;

  assert.deepEqual(dataTypes, { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true });
  assert.deepEqual(dataTypes, DEEP_CLEAN_DATA_TYPES);
  assert.equal('cookies' in dataTypes, false);

  const { origins } = options;
  assert.equal(new Set(origins).size, origins.length, 'deduped');
  for (const d of ZOHO_DOMAINS) {
    assert.ok(origins.includes(`https://${d}`), `bare https://${d}`);
    for (const sub of KNOWN_SUBDOMAINS) assert.ok(origins.includes(`https://${sub}.${d}`), `https://${sub}.${d}`);
  }
  assert.ok(origins.includes('https://custom-tenant.zoho.eu'), 'open tab origin included');
  // 16 subdomains × 9 domains + 9 bare domains + 1 extra open-tab origin
  assert.equal(origins.length, KNOWN_SUBDOMAINS.length * ZOHO_DOMAINS.length + ZOHO_DOMAINS.length + 1);
  for (const o of origins) assert.doesNotMatch(o, /\/$/, 'origins have no trailing slash');
});

test('deepClean ignores non-Zoho or unparsable tab URLs', async () => {
  const f = fakes({ tabs: [{ id: 1, url: 'https://evil.example/' }, { id: 2, url: 'not a url' }, { id: 3, url: 'https://zoho.com.evil.net/' }] });
  await createSiteData(f).deepClean();
  const { origins } = f.log.find(([n]) => n === 'browsingData.remove')[1];
  assert.equal(origins.some((o) => o.includes('evil')), false);
  assert.equal(origins.length, KNOWN_SUBDOMAINS.length * ZOHO_DOMAINS.length + ZOHO_DOMAINS.length);
});

test('openSignIn opens the Zoho sign-in page in a new active tab', async () => {
  const f = fakes();
  await createSiteData(f).openSignIn();
  assert.deepEqual(f.log, [['tabs.create', { url: SIGN_IN_URL, active: true }]]);
});

test('defaults to globalThis.chrome lazily (not at import time)', async () => {
  const f = fakes({ tabs: [zohoTabs[0]] });
  const saved = globalThis.chrome;
  globalThis.chrome = { tabs: f.tabs, scripting: f.scripting, browsingData: f.browsingData };
  try {
    assert.equal(await createSiteData().resetTabs(), 1);
  } finally {
    if (saved === undefined) delete globalThis.chrome; else globalThis.chrome = saved;
  }
});
