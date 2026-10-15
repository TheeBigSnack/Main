import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCAL_QUOTA_BYTES, STORAGE_WARN_SHARE, STORAGE_FULL, storageNearlyFull, storageNearlyFullText, storageWarningText } from '../extension/src/storage.js';

const at = LOCAL_QUOTA_BYTES * 0.8; // 8388608 bytes, the warning's line

test('The popup warns once the storage in use reaches 80 percent of the quota, before a save fails', () => {
  assert.equal(LOCAL_QUOTA_BYTES, 10485760, 'chrome.storage.local without unlimitedStorage: 10 MB');
  assert.equal(STORAGE_WARN_SHARE, 0.8);
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
  assert.match(storageNearlyFullText(at), /^Chrome's storage for Lot Current is 80% full\./);
});

test('The text the To do tab draws is the warning at the line and nothing below it', () => {
  assert.equal(storageWarningText(at - 1), '', 'below the line: no banner text');
  assert.equal(storageWarningText(at), storageNearlyFullText(at), 'at the line: the warning');
  assert.equal(storageWarningText(undefined), '', 'a count Chrome did not give: no banner text');
  assert.equal(storageWarningText(LOCAL_QUOTA_BYTES * 0.95), storageNearlyFullText(LOCAL_QUOTA_BYTES * 0.95));
});

test('The popup reads the storage when it opens, again on each storage change, and draws the warning under the other banners', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /state\.storageBytes = await chrome\.storage\.local\.getBytesInUse\(null\);/, 'the bytes in use, all keys');
  assert.match(popup, /  await checkStorageUse\(\); \/\/ the bytes in use, whichever tab the popup opened on/, 'read at start-up, on any tab');
  assert.match(popup, /if \(area === 'local'\) refreshStorageUse\(\);/, 'and again on each storage change');
  assert.match(popup, /async function refreshStorageUse\(\) \{\n  const before = storageBanner\(\);\n  await checkStorageUse\(\);\n  if \(storageBanner\(\) !== before\) render\(\);\n\}/, 'redrawn only when the warning moves');
  assert.match(popup, /function storageBanner\(\) \{\n  const text = storageWarningText\(state\.storageBytes\);\n  return text \? `<div class="banner warn" id="storageWarning">\$\{esc\(text\)\}<\/div>` : '';\n\}/);
  assert.match(popup, /if \(!state\.snapshot && !d\) \{\n    return storageBanner\(\) \+ setupBanner\(\) \+ empty\(/, 'drawn for a website with no scan yet too');
  assert.match(popup, /let html = setupBanner\(\) \+ scheduleBanner\(\) \+ storageBanner\(\) \+ notSharedBanner\(\);/);
});
