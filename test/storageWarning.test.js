import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCAL_QUOTA_BYTES, STORAGE_WARN_SHARE, STORAGE_FULL, storageNearlyFull, storageNearlyFullText } from '../extension/src/storage.js';

test('The popup warns once the storage in use reaches 80 percent of the quota, before a save fails', () => {
  assert.equal(LOCAL_QUOTA_BYTES, 10485760, 'chrome.storage.local without unlimitedStorage: 10 MB');
  assert.equal(STORAGE_WARN_SHARE, 0.8);
  const at = LOCAL_QUOTA_BYTES * 0.8; // 8388608 bytes
  assert.equal(storageNearlyFull(at - 1), false, 'just under 80 percent: no warning');
  assert.equal(storageNearlyFull(at), true, 'at 80 percent: warned');
  assert.equal(storageNearlyFull(LOCAL_QUOTA_BYTES), true, 'full: warned');
  assert.equal(storageNearlyFull(0), false);
  for (const bad of [undefined, null, NaN, Infinity, 'lots']) assert.equal(storageNearlyFull(bad), false, `${String(bad)} is not a count`);
});

test('The warning says how full the storage is, with the same advice the full message gives', () => {
  const text = storageNearlyFullText(LOCAL_QUOTA_BYTES * 0.85);
  assert.equal(text, "Chrome's storage for Lot Current is 85% full. When it is full, saves fail. Clear the numbers on the Numbers tab, or open an old dealership website and click Clear everything for this website in Settings.");
  assert.ok(STORAGE_FULL.startsWith("Couldn't save: Chrome's storage for Lot Current is full. "), 'the full message is unchanged');
  assert.ok(STORAGE_FULL.endsWith(text.slice(text.indexOf('Clear the numbers'))), 'both name the same things to clear');
  assert.match(storageNearlyFullText(at80()), /^Chrome's storage for Lot Current is 80% full\./);
});

test('The To do tab reads the storage in use once when the popup loads, and draws the warning under the other banners', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /chrome\.storage\.local\.getBytesInUse\(null\)/, 'the bytes in use, all keys');
  assert.match(popup, /await checkRescanPermission\(\);\n  await checkStorageUse\(\);/, 'the load reads it after the permission check');
  assert.match(popup, /function storageBanner\(\) \{/);
  assert.match(popup, /id="storageWarning"/);
  assert.match(popup, /let html = setupBanner\(\) \+ scheduleBanner\(\) \+ storageBanner\(\) \+ notSharedBanner\(\);/);
});

const at80 = () => LOCAL_QUOTA_BYTES * 0.8;
