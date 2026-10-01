// The shipped package: the manifest the Chrome Web Store will read, the
// version stamp in three places, the permissions the privacy answers name,
// and the store listing draft that quotes the manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { honestyProblems, offPricing } from './honesty.js';

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

test('the Web Store listing draft quotes the manifest description word for word and promises nothing Lot Current cannot', () => {
  const listing = read('../store/listing.md');
  assert.ok(listing.includes(manifest.description), 'store/listing.md must contain the manifest description verbatim: the manifest is the one source');
  assert.match(listing, /Lot Current is not affiliated with Meta Platforms, Inc\./);
  assert.match(listing, /You click Publish\. Lot Current never does\./);
  assert.match(listing, /legal\/chrome-web-store-privacy\.md/);
  // one justification per permission and host permission, from the manifest's own list
  for (const p of [...manifest.permissions, ...manifest.host_permissions, ...manifest.optional_host_permissions]) assert.ok(listing.includes('`' + p + '`'), `store/listing.md does not justify "${p}"`);
  // "not a guarantee" is the honest line; nothing else may promise safety, compliance or a guarantee (the
  // shared customer-facing lists of test/honesty.js, as for the marketing copy and the website)
  assert.deepEqual(honestyProblems(listing), [], 'store/listing.md');
  assert.deepEqual(offPricing(listing, JSON.parse(read('../marketing/pricing.json'))), [], 'store/listing.md quotes a price that is not from pricing.json');
  assert.doesNotMatch(listing, /\bsafe\b|\bcompliant\b|\bguaranteed\b/i);
});
