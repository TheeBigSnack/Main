// The shipped package: the manifest the Chrome Web Store will read, the
// version stamp in three places, the permissions the privacy answers name,
// and the store listing draft that quotes the manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { section } from '../scripts/store-check.mjs';
import { copyProblems } from './copyGuards.js';

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

// The justification tables, row by row: a pattern named elsewhere in the
// file (the bullet list above the listing's table) justifies nothing.
// { pattern: [text, ...] } for the rows "| <prefix>`pattern`<suffix> | text |".
function justificationRows(text, rowRe) {
  const rows = {};
  for (const m of text.matchAll(rowRe)) (rows[m[1]] = rows[m[1]] || []).push(m[2].trim());
  return rows;
}
function assertJustified(rows, where) {
  const want = [
    ...manifest.permissions.map((p) => [p, false]),
    ...manifest.host_permissions.map((p) => [p, false]),
    ...manifest.optional_host_permissions.map((p) => [p, true]),
  ];
  for (const [p] of want) {
    assert.ok(rows[p], `${where} has no justification row for "${p}"`);
    assert.equal(rows[p].length, 1, `${where} justifies "${p}" in ${rows[p].length} rows`);
    assert.ok(rows[p][0].length >= 20, `${where}: the row for "${p}" says nothing`);
  }
  assert.deepEqual(Object.keys(rows).sort(), want.map(([p]) => p).sort(), `${where} justifies a permission the manifest does not ask for`);
  return want;
}

test('the listing justifies every manifest permission in its own table row, optional ones marked, and nothing else', () => {
  const listing = read('../store/listing.md');
  const table = section(listing, 'Permission justifications');
  assert.ok(table, 'store/listing.md has a "Permission justifications" section');
  const rows = justificationRows(table, /^\| `([^`]+)`(?: \(optional\))? \| (.*?) \|$/gm);
  const optional = new Set([...table.matchAll(/^\| `([^`]+)` \(optional\) \|/gm)].map((m) => m[1]));
  for (const [p, isOptional] of assertJustified(rows, 'store/listing.md')) {
    assert.equal(optional.has(p), isOptional, `store/listing.md: "${p}" is ${isOptional ? '' : 'not '}optional in the manifest`);
  }
});

test('the Web Store privacy answers justify every manifest permission in their own table row', () => {
  const doc = read('../legal/chrome-web-store-privacy.md');
  const table = section(doc, 'Permission justifications');
  assert.ok(table, 'legal/chrome-web-store-privacy.md has a "Permission justifications" section');
  const rows = justificationRows(table, /^\| (?:Optional host |Host )?`([^`]+)` \| (.*?) \|$/gm);
  assertJustified(rows, 'legal/chrome-web-store-privacy.md');
  for (const p of manifest.optional_host_permissions) assert.match(table, new RegExp(`^\\| Optional host \`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \\|`, 'm'), `"${p}" is marked optional`);
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
  // "not a guarantee" is the honest line; nothing else may promise safety, compliance, a guarantee or anything about an account
  // (test/copyGuards.js, the same rules as the website and the marketing kit), and the listing never says safe or compliant at all
  assert.deepEqual(copyProblems(listing), [], 'store/listing.md');
  assert.doesNotMatch(listing, /\bsafe\b|\bcompliant\b|\bguaranteed\b/i);
  // the Web Store answers are read by the same reviewer
  assert.deepEqual(copyProblems(read('../legal/chrome-web-store-privacy.md')), [], 'legal/chrome-web-store-privacy.md');
});
