import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ZOHO_HOST_PATTERNS } from '../../extension/lib/zoho-domains.js';

const manifest = JSON.parse(await readFile(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));

test('manifest is MV3 with the expected identity', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Zoho Account Switcher');
  assert.equal(manifest.version, '1.0.0');
  assert.ok(manifest.description.length > 0 && manifest.description.length <= 132);
});

test('permissions are exactly what the extension uses', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['browsingData', 'cookies', 'scripting', 'storage']);
});

test('host_permissions equal ZOHO_HOST_PATTERNS', () => {
  assert.deepEqual(manifest.host_permissions, [...ZOHO_HOST_PATTERNS]);
});

test('background is a module service worker', () => {
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
});

test('action popup, title and icons', () => {
  const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
  assert.equal(typeof manifest.action.default_title, 'string');
  assert.deepEqual(manifest.action.default_icon, icons);
  assert.deepEqual(manifest.icons, icons);
});

test('Alt+Shift+Z opens the popup', () => {
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Alt+Shift+Z');
  assert.equal(typeof manifest.commands._execute_action.description, 'string');
});
