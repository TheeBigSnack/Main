// The shipped package: the manifest the Chrome Web Store will read, the
// version stamp in three places, and the permissions the privacy answers name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../extension/manifest.json'));
const pkg = JSON.parse(read('../package.json'));
const lock = JSON.parse(read('../package-lock.json'));

test('the manifest description fits the Web Store limit and says who publishes', () => {
  assert.ok(manifest.description.length <= 132, `${manifest.description.length} characters; the limit is 132`);
  assert.match(manifest.description, /for you to publish/);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.icons && manifest.icons['128'], 'a 128px icon for the store');
});

test('one version everywhere', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version, 'package.json version must match the manifest');
  assert.equal(lock.version, manifest.version, 'package-lock.json version must match the manifest');
  assert.equal(lock.packages[''].version, manifest.version);
});

test('every permission the manifest asks for is explained in the Web Store privacy answers', () => {
  const doc = read('../legal/chrome-web-store-privacy.md');
  const wanted = [...manifest.permissions, ...manifest.host_permissions, ...manifest.optional_host_permissions];
  for (const p of wanted) assert.ok(doc.includes(p), `chrome-web-store-privacy.md does not mention "${p}"`);
  // and nothing beyond what CLAUDE.md records as approved widenings
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'sidePanel', 'alarms', 'notifications']);
  assert.deepEqual(manifest.host_permissions, ['https://www.facebook.com/marketplace/*', 'https://vehicle-images.carscommerce.inc/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://vpic.nhtsa.dot.gov/*', 'https://*/*']);
});

test('the package script exists and the packed zip is ignored by git', () => {
  assert.equal(pkg.scripts.pack, 'node scripts/pack.mjs');
  assert.match(read('../.gitignore'), /^dist\/$/m);
  assert.match(pkg.engines.node, />=22/);
});
