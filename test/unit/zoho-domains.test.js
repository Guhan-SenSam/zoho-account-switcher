import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZOHO_DOMAINS,
  ZOHO_HOST_PATTERNS,
  KNOWN_SUBDOMAINS,
  SIGN_IN_URL,
  REGULAR_STORE_ID,
  isZohoHost,
  isZohoUrl,
  isZohoCookieDomain,
} from '../../extension/lib/zoho-domains.js';

describe('zoho-domains constants', () => {
  test('ZOHO_DOMAINS lists every data center', () => {
    assert.deepEqual([...ZOHO_DOMAINS], [
      'zoho.com', 'zoho.in', 'zoho.eu', 'zoho.com.au', 'zoho.jp',
      'zoho.com.cn', 'zoho.sa', 'zoho.uk', 'zohocloud.ca',
    ]);
  });

  test('ZOHO_HOST_PATTERNS is one *://*.domain/* pattern per data center', () => {
    assert.deepEqual([...ZOHO_HOST_PATTERNS], ZOHO_DOMAINS.map((d) => `*://*.${d}/*`));
  });

  test('KNOWN_SUBDOMAINS', () => {
    assert.deepEqual([...KNOWN_SUBDOMAINS], [
      'accounts', 'mail', 'mailadmin', 'admin', 'vault', 'workplace', 'crm', 'desk',
      'projects', 'cliq', 'calendar', 'workdrive', 'people', 'books', 'one', 'www',
    ]);
  });

  test('REGULAR_STORE_ID is the regular profile\'s cookie store', () => {
    assert.equal(REGULAR_STORE_ID, '0');
  });

  test('SIGN_IN_URL', () => {
    assert.equal(SIGN_IN_URL, 'https://accounts.zoho.com/signin');
  });

  test('constants cannot be mutated by consumers', () => {
    assert.ok(Object.isFrozen(ZOHO_DOMAINS));
    assert.ok(Object.isFrozen(ZOHO_HOST_PATTERNS));
    assert.ok(Object.isFrozen(KNOWN_SUBDOMAINS));
  });
});

describe('isZohoHost', () => {
  const zoho = [
    'zoho.com', 'mail.zoho.com', 'accounts.zoho.com', 'a.b.c.zoho.com',
    'zoho.in', 'mail.zoho.in', 'zoho.eu', 'crm.zoho.eu',
    'zoho.com.au', 'accounts.zoho.com.au', 'zoho.jp', 'vault.zoho.jp',
    'zoho.com.cn', 'mail.zoho.com.cn', 'zoho.sa', 'zoho.uk',
    'zohocloud.ca', 'crm.zohocloud.ca',
    'ZOHO.COM', 'Mail.Zoho.In', 'ACCOUNTS.ZOHO.COM.AU',
  ];
  for (const host of zoho) {
    test(`${host} is Zoho`, () => assert.equal(isZohoHost(host), true));
  }

  const notZoho = [
    'notzoho.com', 'xzoho.in', 'evilzoho.com.au', 'myzohocloud.ca',
    'zoho.com.evil.net', 'mail.zoho.com.evil.net', 'zohocloud.ca.evil.com',
    'zoho.community', 'zoho.co', 'zoho.com.br', 'mail.zoho.com.br', 'zoho.ca',
    'zoho', 'com', 'com.au', '',
    '.zoho.com', 'a..zoho.com', 'zoho.com.', 'zoho.com:443', ' zoho.com',
  ];
  for (const host of notZoho) {
    test(`${JSON.stringify(host)} is not Zoho`, () => assert.equal(isZohoHost(host), false));
  }

  test('non-strings are not Zoho', () => {
    for (const v of [undefined, null, 42, {}, ['zoho.com']]) {
      assert.equal(isZohoHost(v), false);
    }
  });
});

describe('isZohoUrl', () => {
  const yes = [
    'https://mail.zoho.com/zm/#mail/folder/inbox',
    'http://zoho.com',
    'https://zoho.com/',
    'https://accounts.zoho.com.au/signin?servicename=x',
    'https://mail.zoho.com:8443/x',
    'HTTPS://CRM.ZOHOCLOUD.CA/crm',
  ];
  for (const url of yes) {
    test(`${url} is a Zoho URL`, () => assert.equal(isZohoUrl(url), true));
  }

  const no = [
    'https://notzoho.com/',
    'https://zoho.com.evil.net/',
    'https://zoho.community/',
    'https://xzoho.in/',
    'https://evil.net/?r=zoho.com',
    'https://evil.net/#.zoho.com',
    'https://zoho.com@evil.net/',
    'https://mail.zoho.com.evil.net/zm',
    'ftp://zoho.com/',
    'wss://mail.zoho.com/socket',
    'chrome://extensions',
    'chrome-extension://abc/popup.html',
    'about:blank',
    'not a url',
    'zoho.com',
    '',
  ];
  for (const url of no) {
    test(`${JSON.stringify(url)} is not a Zoho URL`, () => assert.equal(isZohoUrl(url), false));
  }

  test('non-strings are not Zoho URLs', () => {
    for (const v of [undefined, null, 42, {}]) {
      assert.equal(isZohoUrl(v), false);
    }
  });

  test('accepts URL objects', () => {
    assert.equal(isZohoUrl(new URL('https://mail.zoho.eu/')), true);
  });
});

describe('isZohoCookieDomain', () => {
  const yes = [
    '.zoho.com', 'zoho.com', 'mail.zoho.com', '.mail.zoho.com',
    '.accounts.zoho.com.au', 'accounts.zoho.com.au', '.zohocloud.ca', '.ZOHO.IN',
  ];
  for (const d of yes) {
    test(`${d} is a Zoho cookie domain`, () => assert.equal(isZohoCookieDomain(d), true));
  }

  const no = [
    '.notzoho.com', 'notzoho.com', '.zoho.com.evil.net', '.zoho.community',
    '.xzoho.in', '..zoho.com', '.', '', '.com', 'evil.net',
  ];
  for (const d of no) {
    test(`${JSON.stringify(d)} is not a Zoho cookie domain`, () => assert.equal(isZohoCookieDomain(d), false));
  }

  test('non-strings are not Zoho cookie domains', () => {
    for (const v of [undefined, null, 1]) {
      assert.equal(isZohoCookieDomain(v), false);
    }
  });
});
