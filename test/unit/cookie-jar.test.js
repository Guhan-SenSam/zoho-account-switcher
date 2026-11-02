import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toSavedCookie,
  cookieUrl,
  toSetDetails,
  createCookieJar,
} from '../../extension/lib/cookie-jar.js';
import { ZOHO_DOMAINS } from '../../extension/lib/zoho-domains.js';
import { createFakeCookies } from '../helpers/fake-cookies.js';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const now = () => NOW_MS;
const FUTURE = NOW_S + 86_400;

const PK = { topLevelSite: 'https://partner.example', hasCrossSiteAncestor: true };

const byKey = (c) => `${c.name}|${c.domain}|${c.path}|${c.partitionKey?.topLevelSite ?? ''}`;
const sorted = (cookies) => [...cookies].sort((a, b) => byKey(a).localeCompare(byKey(b)));
const stripStore = ({ storeId, ...rest }) => rest;

/** A realistic mix of Zoho cookies (plus non-Zoho noise), set through the fake. */
async function seedRealistic(fake) {
  const sets = [
    // domain cookie, persistent
    { url: 'https://accounts.zoho.com/', domain: '.zoho.com', name: 'IAMAUTHTOKEN', value: 'auth-1', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURE },
    // host-only __Host- session cookie
    { url: 'https://accounts.zoho.com/', name: '__Host-sid', value: 'host-1', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
    // host-only, path scoped, session
    { url: 'https://mail.zoho.com/zm/', name: 'zmsess', value: 'mail-1', path: '/zm', secure: true, sameSite: 'strict' },
    // __Secure- domain cookie on another DC
    { url: 'https://accounts.zoho.com.au/', domain: '.zoho.com.au', name: '__Secure-x', value: 'au-1', path: '/', secure: true, sameSite: 'unspecified', expirationDate: FUTURE },
    // non-secure cookie
    { url: 'http://crm.zohocloud.ca/', name: 'plain', value: 'ca-1', path: '/' },
    // partitioned cookie (CHIPS)
    { url: 'https://cliq.zoho.com/', name: 'chips', value: 'part-1', path: '/', secure: true, sameSite: 'no_restriction', partitionKey: PK },
    // non-Zoho noise that must never be touched
    { url: 'https://notzoho.com/', domain: '.notzoho.com', name: 'IAMAUTHTOKEN', value: 'evil', path: '/', secure: true },
    { url: 'https://www.google.com/', name: 'NID', value: 'g', path: '/', secure: true, expirationDate: FUTURE },
  ];
  for (const d of sets) {
    const c = await fake.set(d);
    assert.ok(c, `seed failed for ${d.name}`);
  }
}

const zohoNames = ['IAMAUTHTOKEN', '__Host-sid', 'zmsess', '__Secure-x', 'plain', 'chips'];

describe('fake chrome.cookies models Chrome semantics', () => {
  test('set without domain is host-only on the URL host; with domain it is a dotted domain cookie', async () => {
    const fake = createFakeCookies({ now });
    const hostOnly = await fake.set({ url: 'https://mail.zoho.com/', name: 'a', value: '1' });
    assert.equal(hostOnly.hostOnly, true);
    assert.equal(hostOnly.domain, 'mail.zoho.com');
    const dom = await fake.set({ url: 'https://mail.zoho.com/', domain: 'zoho.com', name: 'a', value: '2' });
    assert.equal(dom.hostOnly, false);
    assert.equal(dom.domain, '.zoho.com');
    const dotted = await fake.set({ url: 'https://mail.zoho.com/', domain: '.mail.zoho.com', name: 'a', value: '3' });
    assert.equal(dotted.domain, '.mail.zoho.com');
    assert.equal(dotted.hostOnly, false);
    assert.equal(fake.dump().length, 3, 'host-only and domain cookies are distinct');
  });

  test('session iff no expirationDate; same name+domain+path overwrites', async () => {
    const fake = createFakeCookies({ now });
    const s = await fake.set({ url: 'https://zoho.com/', name: 'a', value: '1' });
    assert.equal(s.session, true);
    assert.equal('expirationDate' in s, false);
    const p = await fake.set({ url: 'https://zoho.com/', name: 'a', value: '2', expirationDate: FUTURE });
    assert.equal(p.session, false);
    assert.equal(p.expirationDate, FUTURE);
    assert.equal(fake.dump().length, 1);
    assert.equal(fake.dump()[0].value, '2');
  });

  test('set rejects cookies Chrome refuses', async () => {
    const fake = createFakeCookies({ now });
    const bad = [
      { url: 'https://accounts.zoho.com/', domain: '.zoho.com', name: '__Host-x', value: '1', path: '/', secure: true },
      { url: 'https://accounts.zoho.com/a', name: '__Host-x', value: '1', path: '/a', secure: true },
      { url: 'https://accounts.zoho.com/', name: '__Host-x', value: '1', path: '/' },
      { url: 'https://accounts.zoho.com/', name: '__Secure-x', value: '1' },
      { url: 'https://accounts.zoho.com/', name: 'n', value: '1', sameSite: 'no_restriction' },
      { url: 'http://accounts.zoho.com/', name: 'n', value: '1', secure: true },
      { url: 'https://accounts.zoho.com/', domain: 'notzoho.com', name: 'n', value: '1' },
      { url: 'https://accounts.zoho.com/', domain: 'com', name: 'n', value: '1' },
      { url: 'https://accounts.zoho.com/', name: 'n', value: '1', partitionKey: PK },
    ];
    for (const d of bad) {
      await assert.rejects(fake.set(d), /Failed to parse or set cookie/, JSON.stringify(d));
    }
    assert.equal(fake.dump().length, 0);

    const nullFake = createFakeCookies({ now, invalidSet: 'null' });
    assert.equal(await nullFake.set(bad[0]), null);
  });

  test('set accepts a proper __Host- cookie', async () => {
    const fake = createFakeCookies({ now });
    const c = await fake.set({ url: 'https://accounts.zoho.com/', name: '__Host-x', value: '1', path: '/', secure: true });
    assert.equal(c.hostOnly, true);
  });

  test('set with an expired date deletes the existing cookie and resolves undefined', async () => {
    const fake = createFakeCookies({ now });
    await fake.set({ url: 'https://zoho.com/', name: 'a', value: '1' });
    assert.equal(await fake.set({ url: 'https://zoho.com/', name: 'a', value: '1', expirationDate: NOW_S - 1 }), undefined);
    assert.equal(fake.dump().length, 0);
  });

  test('unknown properties throw like Chrome schema validation', () => {
    const fake = createFakeCookies({ now });
    assert.throws(() => fake.set({ url: 'https://zoho.com/', name: 'a', hostOnly: true }), /Unexpected property: 'hostOnly'/);
    assert.throws(() => fake.set({ url: 'https://zoho.com/', name: 'a', session: true }), /Unexpected property/);
    assert.throws(() => fake.remove({ url: 'https://zoho.com/', name: 'a', domain: 'zoho.com' }), /Unexpected property/);
  });

  test('getAll({domain}) matches the domain and its subdomains only', async () => {
    const fake = createFakeCookies({ now });
    await seedRealistic(fake);
    const com = await fake.getAll({ domain: 'zoho.com' });
    assert.deepEqual(com.map((c) => c.name).sort(), ['IAMAUTHTOKEN', '__Host-sid', 'zmsess'].sort());
    const au = await fake.getAll({ domain: 'zoho.com.au' });
    assert.deepEqual(au.map((c) => c.name), ['__Secure-x']);
    const notzoho = await fake.getAll({ domain: 'zoho.com', name: 'IAMAUTHTOKEN' });
    assert.deepEqual(notzoho.map((c) => c.value), ['auth-1']);
  });

  test('getAll omits partitioned cookies unless partitionKey is given; {} returns all', async () => {
    const fake = createFakeCookies({ now });
    await seedRealistic(fake);
    const plain = await fake.getAll({ domain: 'zoho.com' });
    assert.equal(plain.some((c) => c.name === 'chips'), false);
    const all = await fake.getAll({ domain: 'zoho.com', partitionKey: {} });
    assert.deepEqual(all.map((c) => c.name).sort(), ['IAMAUTHTOKEN', '__Host-sid', 'chips', 'zmsess'].sort());
    const only = await fake.getAll({ domain: 'zoho.com', partitionKey: { topLevelSite: PK.topLevelSite } });
    assert.deepEqual(only.map((c) => c.name), ['chips']);
  });

  test('remove({url, name}) deletes every same-name cookie that would be sent to the URL', async () => {
    const fake = createFakeCookies({ now });
    await fake.set({ url: 'https://mail.zoho.com/', name: 't', value: 'host', path: '/' });
    await fake.set({ url: 'https://mail.zoho.com/', name: 't', value: 'mailpath', path: '/mail' });
    await fake.set({ url: 'https://mail.zoho.com/', domain: '.zoho.com', name: 't', value: 'dom', path: '/' });
    await fake.set({ url: 'https://crm.zoho.com/', name: 't', value: 'othhost', path: '/' });
    await fake.set({ url: 'https://mail.zoho.com/', name: 't', value: 'sec', path: '/', secure: true, domain: 'mail.zoho.com' });
    await fake.set({ url: 'https://mail.zoho.com/', name: 'other', value: 'x', path: '/' });

    await fake.remove({ url: 'http://mail.zoho.com/mail/inbox', name: 't' });
    // host, /mail and .zoho.com cookies went; other host, Secure-over-http and other name survive
    assert.deepEqual(fake.dump().map((c) => c.value).sort(), ['othhost', 'sec', 'x'].sort());
  });

  test('remove leaves partitioned cookies alone unless their partitionKey is given', async () => {
    const fake = createFakeCookies({ now });
    await fake.set({ url: 'https://cliq.zoho.com/', name: 'c', value: 'p', path: '/', secure: true, partitionKey: PK });
    await fake.remove({ url: 'https://cliq.zoho.com/', name: 'c' });
    assert.equal(fake.dump().length, 1);
    await fake.remove({ url: 'https://cliq.zoho.com/', name: 'c', partitionKey: PK });
    assert.equal(fake.dump().length, 0);
  });
});

describe('toSavedCookie', () => {
  test('drops storeId and keeps exactly the SavedCookie fields', () => {
    const chromeCookie = {
      domain: '.zoho.com', hostOnly: false, httpOnly: true, name: 'A', path: '/',
      sameSite: 'no_restriction', secure: true, session: false, storeId: '0', value: 'v',
      expirationDate: FUTURE,
    };
    assert.deepEqual(toSavedCookie(chromeCookie), {
      name: 'A', value: 'v', domain: '.zoho.com', hostOnly: false, path: '/', secure: true,
      httpOnly: true, sameSite: 'no_restriction', session: false, expirationDate: FUTURE,
    });
  });

  test('session cookies have no expirationDate; partitionKey only when present (copied)', () => {
    const pk = { ...PK };
    const s = toSavedCookie({
      domain: 'mail.zoho.com', hostOnly: true, httpOnly: false, name: 'B', path: '/zm',
      sameSite: 'lax', secure: true, session: true, storeId: '0', value: 'w', partitionKey: pk,
    });
    assert.equal('expirationDate' in s, false);
    assert.equal('storeId' in s, false);
    assert.deepEqual(s.partitionKey, PK);
    assert.notEqual(s.partitionKey, pk);
    const noPk = toSavedCookie({
      domain: 'mail.zoho.com', hostOnly: true, httpOnly: false, name: 'B', path: '/',
      sameSite: 'lax', secure: false, session: true, storeId: '0', value: 'w',
    });
    assert.equal('partitionKey' in noPk, false);
  });
});

describe('cookieUrl', () => {
  test('secure -> https, leading dot stripped, path kept', () => {
    assert.equal(cookieUrl({ domain: '.zoho.com', path: '/', secure: true }), 'https://zoho.com/');
    assert.equal(cookieUrl({ domain: 'mail.zoho.com', path: '/zm', secure: true }), 'https://mail.zoho.com/zm');
    assert.equal(cookieUrl({ domain: 'crm.zohocloud.ca', path: '/', secure: false }), 'http://crm.zohocloud.ca/');
  });

  test('missing path defaults to /', () => {
    assert.equal(cookieUrl({ domain: '.zoho.eu', secure: true }), 'https://zoho.eu/');
    assert.equal(cookieUrl({ domain: '.zoho.eu', path: '', secure: true }), 'https://zoho.eu/');
  });
});

describe('toSetDetails', () => {
  test('host-only cookie: no domain field', () => {
    const d = toSetDetails({
      name: '__Host-sid', value: 'v', domain: 'accounts.zoho.com', hostOnly: true, path: '/',
      secure: true, httpOnly: true, sameSite: 'lax', session: true,
    });
    assert.deepEqual(d, {
      url: 'https://accounts.zoho.com/', name: '__Host-sid', value: 'v', path: '/',
      secure: true, httpOnly: true, sameSite: 'lax',
    });
  });

  test('domain cookie keeps domain; persistent keeps expirationDate; partitionKey passed', () => {
    const d = toSetDetails({
      name: 'A', value: 'v', domain: '.zoho.com', hostOnly: false, path: '/', secure: true,
      httpOnly: false, sameSite: 'no_restriction', session: false, expirationDate: FUTURE,
      partitionKey: PK,
    });
    assert.deepEqual(d, {
      url: 'https://zoho.com/', name: 'A', value: 'v', domain: '.zoho.com', path: '/',
      secure: true, httpOnly: false, sameSite: 'no_restriction', expirationDate: FUTURE,
      partitionKey: PK,
    });
  });

  test('sameSite values pass through unchanged; never emits storeId/hostOnly/session', () => {
    for (const sameSite of ['no_restriction', 'lax', 'strict', 'unspecified']) {
      const d = toSetDetails({
        name: 'A', value: 'v', domain: 'zoho.com', hostOnly: true, path: '/', secure: true,
        httpOnly: false, sameSite, session: true, storeId: '0',
      });
      assert.equal(d.sameSite, sameSite);
      for (const k of ['storeId', 'hostOnly', 'session', 'domain', 'expirationDate', 'partitionKey']) {
        assert.equal(k in d, false, `${k} must not be present`);
      }
    }
  });

  test('session cookie never gets an expirationDate even if one is lying around', () => {
    const d = toSetDetails({
      name: 'A', value: 'v', domain: 'zoho.com', hostOnly: true, path: '/', secure: true,
      httpOnly: false, sameSite: 'lax', session: true, expirationDate: FUTURE,
    });
    assert.equal('expirationDate' in d, false);
  });
});

describe('createCookieJar', () => {
  test('importing and creating does not touch chrome', () => {
    assert.equal(globalThis.chrome, undefined);
    assert.doesNotThrow(() => createCookieJar(createFakeCookies()));
  });

  test('default api is read lazily from globalThis.chrome.cookies', async () => {
    const fake = createFakeCookies({ now });
    await fake.set({ url: 'https://zoho.com/', name: 'a', value: '1' });
    globalThis.chrome = { cookies: fake };
    try {
      const jar = createCookieJar();
      assert.equal((await jar.snapshot()).length, 1);
    } finally {
      delete globalThis.chrome;
    }
  });

  describe('snapshot', () => {
    test('collects every Zoho cookie across data centers, including partitioned ones', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const snap = await createCookieJar(fake, { now }).snapshot();
      assert.deepEqual(snap.map((c) => c.name).sort(), [...zohoNames].sort());
      for (const c of snap) assert.equal('storeId' in c, false);
      const chips = snap.find((c) => c.name === 'chips');
      assert.deepEqual(chips.partitionKey, PK);
    });

    test('queries every data center, with and without partitionKey: {}', async () => {
      const fake = createFakeCookies({ now });
      await createCookieJar(fake, { now }).snapshot();
      for (const d of ZOHO_DOMAINS) {
        assert.ok(fake.calls.getAll.some((c) => c.domain === d && c.partitionKey === undefined), d);
        assert.ok(fake.calls.getAll.some((c) => c.domain === d && c.partitionKey && Object.keys(c.partitionKey).length === 0), d);
      }
    });

    test('dedupes cookies returned by both calls', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const snap = await createCookieJar(fake, { now }).snapshot();
      const keys = snap.map(byKey);
      assert.equal(new Set(keys).size, keys.length);
    });

    test('ignores errors from the partitionKey call (older Chrome)', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const api = {
        ...fake,
        getAll: (details) => (details.partitionKey
          ? Promise.reject(new Error("Unexpected property: 'partitionKey'"))
          : fake.getAll(details)),
      };
      const snap = await createCookieJar(api, { now }).snapshot();
      assert.deepEqual(snap.map((c) => c.name).sort(), zohoNames.filter((n) => n !== 'chips').sort());
    });

    test('also ignores a synchronous throw from the partitionKey call', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const api = {
        ...fake,
        getAll: (details) => {
          if (details.partitionKey) throw new TypeError('Unexpected property');
          return fake.getAll(details);
        },
      };
      const snap = await createCookieJar(api, { now }).snapshot();
      assert.equal(snap.length, zohoNames.length - 1);
    });

    test('drops anything that is not a Zoho cookie domain even if the API returns it', async () => {
      const api = {
        getAll: async () => [
          { name: 'x', value: '1', domain: '.notzoho.com', hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true, storeId: '0' },
          { name: 'y', value: '1', domain: '.zoho.com', hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true, storeId: '0' },
        ],
      };
      const snap = await createCookieJar(api, { now }).snapshot();
      assert.deepEqual(snap.map((c) => c.name), ['y']);
    });

    test('propagates errors from the plain getAll call', async () => {
      const api = { getAll: async () => { throw new Error('no permission'); } };
      await assert.rejects(createCookieJar(api, { now }).snapshot(), /no permission/);
    });
  });

  describe('clear', () => {
    test('removes every Zoho cookie (partitioned too), leaves others, returns the count', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const n = await createCookieJar(fake, { now }).clear();
      assert.equal(n, zohoNames.length);
      assert.deepEqual(fake.dump().map((c) => c.value).sort(), ['evil', 'g']);
    });

    test('returns 0 and makes no remove calls when there is nothing to clear', async () => {
      const fake = createFakeCookies({ now });
      assert.equal(await createCookieJar(fake, { now }).clear(), 0);
      assert.equal(fake.calls.remove.length, 0);
    });

    test('counts distinct cookies even when one remove() deletes several', async () => {
      const fake = createFakeCookies({ now });
      await fake.set({ url: 'https://mail.zoho.com/', name: 't', value: 'root', path: '/' });
      await fake.set({ url: 'https://mail.zoho.com/', name: 't', value: 'deep', path: '/mail' });
      await fake.set({ url: 'https://mail.zoho.com/', domain: 'zoho.com', name: 't', value: 'dom', path: '/' });
      const n = await createCookieJar(fake, { now }).clear();
      assert.equal(n, 3);
      assert.equal(fake.dump().length, 0);
    });

    test('re-snapshots and repeats when cookies appear during clearing', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      let injected = false;
      const api = {
        ...fake,
        remove: async (details) => {
          const r = await fake.remove(details);
          if (!injected) {
            injected = true; // a Zoho tab sets a new cookie mid-clear
            await fake.set({ url: 'https://mail.zoho.com/', name: 'late', value: 'x', path: '/' });
          }
          return r;
        },
      };
      const n = await createCookieJar(api, { now }).clear();
      assert.equal(n, zohoNames.length + 1);
      assert.deepEqual(fake.dump().map((c) => c.value).sort(), ['evil', 'g']);
    });

    test('gives up after 3 passes and does not count cookies that survive', async () => {
      const fake = createFakeCookies({ now });
      await fake.set({ url: 'https://zoho.com/', name: 'a', value: '1', path: '/' });
      let k = 0;
      const api = {
        ...fake,
        remove: async (details) => {
          const r = await fake.remove(details);
          k += 1;
          await fake.set({ url: 'https://zoho.com/', name: `zombie${k}`, value: 'z', path: '/' });
          return r;
        },
      };
      const n = await createCookieJar(api, { now }).clear();
      assert.equal(fake.calls.remove.length, 3, 'exactly three removal passes');
      // removed: a, zombie1, zombie2; zombie3 survives
      assert.equal(n, 3);
      assert.deepEqual(fake.dump().map((c) => c.name), ['zombie3']);
    });

    test('a failing remove() does not abort the rest', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const api = {
        ...fake,
        remove: (details) => (details.name === 'zmsess'
          ? Promise.reject(new Error('boom'))
          : fake.remove(details)),
      };
      const n = await createCookieJar(api, { now }).clear();
      assert.equal(n, zohoNames.length - 1);
      assert.deepEqual(
        fake.dump().map((c) => c.name).sort(),
        ['IAMAUTHTOKEN', 'NID', 'zmsess'].sort(), // notzoho IAMAUTHTOKEN, google NID, stuck zmsess
      );
    });

    test('removes partitioned cookies using their partitionKey', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      await createCookieJar(fake, { now }).clear();
      const chipsRemove = fake.calls.remove.find((r) => r.name === 'chips');
      assert.deepEqual(chipsRemove.partitionKey, PK);
      const plainRemove = fake.calls.remove.find((r) => r.name === 'zmsess');
      assert.equal('partitionKey' in plainRemove, false);
      assert.equal(plainRemove.url, 'https://mail.zoho.com/zm');
    });
  });

  describe('restore', () => {
    test('round-trips a realistic jar exactly (host-only, __Host-, paths, session, partitioned)', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const jar = createCookieJar(fake, { now });
      const before = await jar.snapshot();
      const zohoLiveBefore = fake.dump().filter((c) => zohoNames.includes(c.name) && c.value !== 'evil');
      await jar.clear();
      const result = await jar.restore(before);
      assert.deepEqual(result, { restored: zohoNames.length, skipped: 0, failed: [] });
      const after = await jar.snapshot();
      assert.deepEqual(sorted(after), sorted(before));
      const zohoLiveAfter = fake.dump().filter((c) => zohoNames.includes(c.name) && c.value !== 'evil');
      assert.deepEqual(sorted(zohoLiveAfter.map(stripStore)), sorted(zohoLiveBefore.map(stripStore)));
      const host = after.find((c) => c.name === '__Host-sid');
      assert.equal(host.hostOnly, true);
      assert.equal(host.domain, 'accounts.zoho.com');
    });

    test('survives a JSON round trip (as stored in chrome.storage)', async () => {
      const fake = createFakeCookies({ now });
      await seedRealistic(fake);
      const jar = createCookieJar(fake, { now });
      const before = JSON.parse(JSON.stringify(await jar.snapshot()));
      await jar.clear();
      const result = await jar.restore(before);
      assert.equal(result.failed.length, 0);
      assert.deepEqual(sorted(await jar.snapshot()), sorted(before));
    });

    test('skips expired persistent cookies (expirationDate <= now) but never session cookies', async () => {
      const fake = createFakeCookies({ now });
      const jar = createCookieJar(fake, { now });
      const base = { value: 'v', domain: '.zoho.com', hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'lax' };
      const result = await jar.restore([
        { ...base, name: 'past', session: false, expirationDate: NOW_S - 10 },
        { ...base, name: 'boundary', session: false, expirationDate: NOW_S },
        { ...base, name: 'future', session: false, expirationDate: NOW_S + 1 },
        { ...base, name: 'session', session: true },
      ]);
      assert.deepEqual(result, { restored: 2, skipped: 2, failed: [] });
      assert.deepEqual(fake.dump().map((c) => c.name).sort(), ['future', 'session']);
      assert.equal(fake.calls.set.length, 2);
    });

    test('a rejected set() is reported in failed with name, domain and error', async () => {
      const fake = createFakeCookies({ now });
      const jar = createCookieJar(fake, { now });
      const good = { name: 'ok', value: 'v', domain: 'accounts.zoho.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true };
      // A __Host- cookie saved as a domain cookie can't be set: Chrome rejects it.
      const bad = { ...good, name: '__Host-bad', domain: '.zoho.com', hostOnly: false };
      const result = await jar.restore([good, bad]);
      assert.equal(result.restored, 1);
      assert.equal(result.skipped, 0);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].name, '__Host-bad');
      assert.equal(result.failed[0].domain, '.zoho.com');
      assert.match(result.failed[0].error, /Failed to parse or set cookie/);
    });

    test('a set() resolving null/undefined counts as failed', async () => {
      const fake = createFakeCookies({ now, invalidSet: 'null' });
      const jar = createCookieJar(fake, { now });
      const bad = { name: '__Secure-x', value: 'v', domain: 'accounts.zoho.com', hostOnly: true, path: '/', secure: false, httpOnly: false, sameSite: 'lax', session: true };
      const result = await jar.restore([bad]);
      assert.equal(result.restored, 0);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].name, '__Secure-x');
      assert.equal(typeof result.failed[0].error, 'string');

      const undefApi = { set: async () => undefined };
      const r2 = await createCookieJar(undefApi, { now }).restore([{ ...bad, secure: true }]);
      assert.equal(r2.failed.length, 1);
    });

    test('a synchronous throw from set() is a failure, not a crash', async () => {
      const api = {
        set: (d) => {
          if (d.name === 'boom') throw new TypeError('Unexpected property');
          return Promise.resolve({ ...d });
        },
      };
      const base = { value: 'v', domain: 'zoho.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true };
      const r = await createCookieJar(api, { now }).restore([{ ...base, name: 'boom' }, { ...base, name: 'fine' }]);
      assert.equal(r.restored, 1);
      assert.deepEqual(r.failed.map((f) => f.name), ['boom']);
      assert.match(r.failed[0].error, /Unexpected property/);
    });

    test('issues all set() calls in parallel', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const api = {
        set: async (d) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return { ...d };
        },
      };
      const base = { value: 'v', domain: 'zoho.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true };
      await createCookieJar(api, { now }).restore(['a', 'b', 'c', 'd'].map((name) => ({ ...base, name })));
      assert.equal(maxInFlight, 4);
    });

    test('restoring nothing is a no-op', async () => {
      const fake = createFakeCookies({ now });
      const jar = createCookieJar(fake, { now });
      assert.deepEqual(await jar.restore([]), { restored: 0, skipped: 0, failed: [] });
      assert.deepEqual(await jar.restore(undefined), { restored: 0, skipped: 0, failed: [] });
    });

    test('uses Date.now by default for the expiry check', async () => {
      const fake = createFakeCookies();
      const jar = createCookieJar(fake);
      const base = { value: 'v', domain: '.zoho.com', hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: false };
      const r = await jar.restore([
        { ...base, name: 'old', expirationDate: Date.now() / 1000 - 60 },
        { ...base, name: 'new', expirationDate: Date.now() / 1000 + 3600 },
      ]);
      assert.deepEqual(r, { restored: 1, skipped: 1, failed: [] });
    });
  });
});
