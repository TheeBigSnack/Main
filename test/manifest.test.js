// The shipped package: the manifest the Chrome Web Store will read, the
// version stamp in three places, the permissions the privacy answers name,
// and the store listing draft that quotes the manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { section } from '../scripts/store-check.mjs';
import { copyProblems } from './copyGuards.js';
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
  // and nothing beyond what was approved. activeTab, scripting and storage
  // are the first build's (0.1.0). Changing these lists is a widening: ask
  // the owner first (CLAUDE.md).
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'sidePanel', 'alarms', 'notifications']);
  assert.deepEqual(manifest.host_permissions, ['https://www.facebook.com/marketplace/*', 'https://vehicle-images.carscommerce.inc/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://vpic.nhtsa.dot.gov/*', 'https://*/*']);
  // and no other key that widens what the extension can reach or who can reach it: optional permissions
  // (cookies, debugger, tabs...), content scripts on Facebook or any other site, pages that other sites can
  // message, files any page can load, or a content security policy of its own. Adding one is a widening
  // the owner approves first (CLAUDE.md, "Ask the owner before"), then lists here and in the privacy answers.
  assert.deepEqual(Object.keys(manifest).sort(), ['action', 'background', 'description', 'host_permissions', 'icons', 'manifest_version', 'minimum_chrome_version', 'name', 'optional_host_permissions', 'permissions', 'side_panel', 'version'], 'the manifest has a key that is not on the approved list');
  for (const key of ['optional_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'content_security_policy']) assert.ok(!(key in manifest), `the manifest asks for ${key}`);
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' }, 'one module service worker');
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
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

// What a salesperson reads next to Chrome's install prompt names the hosts
// that prompt shows, as Chrome shows them, and nothing else: the static image
// host belongs to one website platform, so calling it "the dealership's photo
// host" is wrong for every other dealership, and dropping it from the
// manifest at the store release (store/listing.md) must change these lines too.
test('the install steps name exactly the hosts Chrome shows at install, and no text calls the static image host the dealership\'s', () => {
  const shown = manifest.host_permissions.map((p) => p.replace(/^https:\/\//, '').replace(/\/\*$/, '')).sort();
  for (const rel of ['../README.md', '../docs/help.md', '../marketing/onboarding-store.md']) {
    const lines = read(rel).split('\n').filter((l) => /Chrome (?:will say|says) the extension can read and change data on|At install, Chrome shows what the extension can read/.test(l));
    assert.ok(lines.length, `${rel} no longer says what Chrome shows at install`);
    for (const l of lines) {
      const prompt = l.split(/\. |; /).find((s) => /can read and change data on|what the extension can read/.test(s));
      const named = [...new Set([...prompt.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|inc|gov|org|net)(?:\/[a-z]+)?/g)].map((m) => m[0]))].sort();
      assert.deepEqual(named, shown, `${rel}: the install prompt line names ${named.join(', ') || 'no host'}, but Chrome shows ${shown.join(', ')}`);
    }
  }
  for (const rel of ['../README.md', '../docs/help.md', '../marketing/onboarding-store.md', '../legal/chrome-web-store-privacy.md', '../store/listing.md']) {
    assert.doesNotMatch(read(rel), /the dealer(?:ship's)? (?:photo|image) host/, `${rel} calls the manifest's static image host the dealership's own`);
    // one Dealer Inspire website has been checked (extension/adapters/README.md: "photo host seen so far"), so no text says every one uses it
    assert.doesNotMatch(read(rel), /(?:that|which) Dealer Inspire (?:dealership )?websites use/, `${rel} says every Dealer Inspire website keeps its photos on the static image host, which only the websites checked so far do`);
  }
});

// Each widening since the first build, where it was decided, and the
// CHANGELOG section that recorded it. The test reads that section, so a
// pointer here that names the wrong release fails instead of sending the
// next reader to a section that says nothing about the permission. A change
// not released yet is named by its entry's title, not by "Unreleased": a
// release renames that heading to the version's (scripts/release.mjs), and
// test/release.test.js runs this file on that layout.
const WIDENINGS = [
  { permission: 'sidePanel', decided: 'Milestone 1 (CLAUDE.md\'s ledger)', changelog: ['0.2.0'] },
  { permission: 'https://www.facebook.com/marketplace/*', decided: 'Milestone 1 (CLAUDE.md\'s ledger)', changelog: ['0.2.0'] },
  { permission: 'https://vehicle-images.carscommerce.inc/*', decided: 'Milestone 1 (CLAUDE.md\'s ledger)', changelog: ['0.2.0'] },
  { permission: 'https://vpic.nhtsa.dot.gov/*', decided: 'the owner\'s VIN double-check request (HANDOFF section 1), shipped in Milestone 1', changelog: ['0.2.0'] },
  { permission: 'alarms', decided: 'Milestone 2 (PLAN.md)', changelog: ['0.3.0'] },
  { permission: 'notifications', decided: 'Milestone 2 (PLAN.md)', changelog: ['0.3.0'] },
  // the dealer's website (Milestone 2), then a car's photo servers asked at post time (the owner, 2026-09-29)
  { permission: 'https://*/*', decided: 'Milestone 2 (PLAN.md); the owner, 2026-09-29 (CLAUDE.md\'s ledger)', changelog: ['0.3.0', { entry: 'Photos from any server' }] },
];

// The text of one CHANGELOG section: from its "## <release>" heading to the
// next "## ", or, for { entry }, the section holding the bullet "- **<entry>".
function changelogSection(changelog, release) {
  if (release && typeof release === 'object') return changelog.split(/\n(?=## )/).slice(1).find((s) => s.includes(`\n- **${release.entry}`)) ?? null;
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).split(' ')[0] === release);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

test('every permission beyond the first build\'s is recorded in the CHANGELOG release this test names for it', () => {
  const firstBuild = ['activeTab', 'scripting', 'storage'];
  const asked = [...manifest.permissions, ...manifest.host_permissions, ...manifest.optional_host_permissions].filter((p) => !firstBuild.includes(p));
  assert.deepEqual([...new Set(asked)].sort(), WIDENINGS.map((w) => w.permission).sort(), 'every widening needs its line in WIDENINGS');
  const changelog = read('../CHANGELOG.md');
  for (const w of WIDENINGS) {
    for (const release of w.changelog) {
      const section = changelogSection(changelog, release);
      const name = typeof release === 'object' ? `"${release.entry}" entry's` : `"## ${release}"`;
      assert.ok(section, `CHANGELOG.md has no ${name} section`);
      assert.ok(section.includes('`' + w.permission + '`'), `CHANGELOG.md's ${name} section does not record "${w.permission}"`);
    }
  }
});

test('the CHANGELOG section reader finds a release and stops at the next heading', () => {
  const text = '# Changelog\n\n## Unreleased\n- a\n\n## 0.2.0 (date)\n- `x`\n\n## 0.1.0\n- `y`\n';
  assert.equal(changelogSection(text, '0.2.0'), '## 0.2.0 (date)\n- `x`\n');
  assert.equal(changelogSection(text, '0.1.0'), '## 0.1.0\n- `y`\n');
  assert.equal(changelogSection(text, '0.4.0'), null);
  assert.ok(!changelogSection(text, '0.2.0').includes('`y`'));
  // by entry title, under Unreleased or under the heading a release renamed it to
  const entry = '- **Photos** from `z`\n';
  assert.equal(changelogSection(`# Changelog\n\n## Unreleased\n${entry}\n## 0.2.0 (date)\n- \`x\`\n`, { entry: 'Photos' }), `## Unreleased\n${entry}`);
  assert.equal(changelogSection(`# Changelog\n\n## Unreleased\n\n## 0.3.0 (date)\n${entry}\n## 0.2.0 (date)\n- \`x\`\n`, { entry: 'Photos' }), `## 0.3.0 (date)\n${entry}`);
  assert.equal(changelogSection(text, { entry: 'Photos' }), null);
});

// Every top-level key, pinned like the permissions above: a new one (a
// content script, web-accessible files, a connection from web pages, an
// options page) can reach pages or change what the extension is, so it fails
// here until someone has looked at it and updated this list.
test('the manifest has exactly the keys it has today: no content scripts or other new way onto a page arrives unreviewed', () => {
  assert.deepEqual(Object.keys(manifest).sort(), [
    'action', 'background', 'description', 'host_permissions', 'icons', 'manifest_version', 'minimum_chrome_version', 'name', 'optional_host_permissions', 'permissions', 'side_panel', 'version',
  ]);
  assert.deepEqual(Object.keys(manifest.background).sort(), ['service_worker', 'type'], 'one service worker, nothing else in the background');
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
  // "not a guarantee" is the honest line; nothing else may promise safety, compliance, a guarantee or anything about
  // an account (test/copyGuards.js and the shared lists of test/honesty.js, the same rules as the website and the
  // marketing kit), no price but pricing.json's, and the listing never says safe or compliant at all
  assert.deepEqual(copyProblems(listing), [], 'store/listing.md');
  assert.deepEqual(honestyProblems(listing), [], 'store/listing.md');
  assert.deepEqual(offPricing(listing, JSON.parse(read('../marketing/pricing.json'))), [], 'store/listing.md quotes a price that is not from pricing.json');
  assert.doesNotMatch(listing, /\bsafe\b|\bcompliant\b|\bguaranteed\b/i);
  // the Web Store answers are read by the same reviewer
  assert.deepEqual(copyProblems(read('../legal/chrome-web-store-privacy.md')), [], 'legal/chrome-web-store-privacy.md');
});
