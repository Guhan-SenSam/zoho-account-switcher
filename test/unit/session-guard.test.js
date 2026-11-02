import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAnchorCookie, looksSignedOut, signOutReason } from '../../extension/lib/session-guard.js';
import { ZOHO_DOMAINS } from '../../extension/lib/zoho-domains.js';

const cookie = (name, over = {}) => ({
  name, value: 'v', domain: '.zoho.com', hostOnly: false, path: '/', secure: true,
  httpOnly: true, sameSite: 'lax', session: true, ...over,
});
const anchor = (name = 'IAMAUTH', over = {}) => cookie(name, over);
const hostCookie = (name = 'zmsess', over = {}) => cookie(name, { domain: 'mail.zoho.com', hostOnly: true, httpOnly: false, ...over });

test('anchor = httpOnly, not host-only, domain exactly .<data-center domain>', () => {
  for (const d of ZOHO_DOMAINS) assert.equal(isAnchorCookie(anchor('A', { domain: `.${d}` })), true, d);
  assert.equal(isAnchorCookie(anchor('A', { httpOnly: false })), false, 'not httpOnly');
  assert.equal(isAnchorCookie(anchor('A', { hostOnly: true, domain: 'zoho.com' })), false, 'host-only');
  assert.equal(isAnchorCookie(anchor('A', { domain: '.mail.zoho.com' })), false, 'subdomain cookie');
  assert.equal(isAnchorCookie(anchor('A', { domain: 'zoho.com' })), false, 'no leading dot');
  assert.equal(isAnchorCookie(anchor('A', { domain: '.notzoho.com' })), false, 'not Zoho');
  assert.equal(isAnchorCookie(null), false);
});

test('empty live jar with a non-empty saved copy looks signed out (external wipe)', () => {
  assert.equal(looksSignedOut([hostCookie()], []), true);
  assert.equal(looksSignedOut([anchor()], []), true);
});

test('nothing saved yet: never looks signed out', () => {
  assert.equal(looksSignedOut([], []), false);
  assert.equal(looksSignedOut([], [hostCookie()]), false);
});

test('every anchor missing from live looks signed out, even if other cookies remain', () => {
  const saved = [anchor('IAMAUTH'), anchor('IAMAGENT', { domain: '.zoho.eu' }), hostCookie()];
  assert.equal(looksSignedOut(saved, [hostCookie('zmsess', { value: 'new' }), hostCookie('other')]), true);
});

test('one anchor still present (value rotated) is a normal update', () => {
  const saved = [anchor('IAMAUTH'), anchor('IAMAGENT'), hostCookie()];
  assert.equal(looksSignedOut(saved, [anchor('IAMAUTH', { value: 'rotated' })]), false);
});

test('anchors are matched on name AND domain', () => {
  const saved = [anchor('IAMAUTH')];
  assert.equal(looksSignedOut(saved, [anchor('IAMAUTH', { domain: '.zoho.eu' })]), true, 'other data center');
  assert.equal(looksSignedOut(saved, [anchor('IAMAUTH', { domain: 'zoho.com', hostOnly: true })]), true, 'host-only twin');
  assert.equal(looksSignedOut(saved, [anchor('IAMAUTH', { httpOnly: false })]), false, 'same name+domain is enough');
});

test('saved copy without anchors: the anchor rule does not apply', () => {
  assert.equal(looksSignedOut([hostCookie('a')], [hostCookie('b')]), false);
  assert.equal(looksSignedOut([anchor('A', { httpOnly: false })], [hostCookie('b')]), false);
});

test('signOutReason explains why, null when the live jar is fine', () => {
  assert.equal(signOutReason([anchor()], [anchor('IAMAUTH', { value: 'x' })]), null);
  assert.match(signOutReason([anchor()], []), /no zoho cookies/i);
  assert.match(signOutReason([anchor('IAMAUTH'), hostCookie()], [hostCookie()]), /IAMAUTH \(\.zoho\.com\)/);
});

test('tolerates missing arrays', () => {
  assert.equal(looksSignedOut(undefined, undefined), false);
  assert.equal(looksSignedOut([anchor()], undefined), true);
  assert.equal(looksSignedOut(null, [anchor()]), false);
});
