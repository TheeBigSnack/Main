// The shipped package: the manifest the Chrome Web Store will read, the
// version stamp in three places, the permissions the privacy answers name,
// and the store listing draft that quotes the manifest.

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
  // and nothing beyond what was approved. activeTab, scripting and storage
  // are the first build's (0.1.0). Changing these lists is a widening: ask
  // the owner first (CLAUDE.md).
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'sidePanel', 'alarms', 'notifications']);
  assert.deepEqual(manifest.host_permissions, ['https://www.facebook.com/marketplace/*', 'https://vehicle-images.carscommerce.inc/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://vpic.nhtsa.dot.gov/*', 'https://*/*']);
});

// Each widening since the first build, where it was decided, and the
// CHANGELOG section that recorded it. The test reads that section, so a
// pointer here that names the wrong release fails instead of sending the
// next reader to a section that says nothing about the permission.
const WIDENINGS = [
  { permission: 'sidePanel', decided: 'Milestone 1 (CLAUDE.md\'s ledger)', changelog: ['0.2.0'] },
  { permission: 'https://www.facebook.com/marketplace/*', decided: 'Milestone 1 (CLAUDE.md\'s ledger)', changelog: ['0.2.0'] },
  { permission: 'https://vehicle-images.carscommerce.inc/*', decided: 'Milestone 1 (CLAUDE.md\'s ledger)', changelog: ['0.2.0'] },
  { permission: 'https://vpic.nhtsa.dot.gov/*', decided: 'the owner\'s VIN double-check request (HANDOFF section 1), shipped in Milestone 1', changelog: ['0.2.0'] },
  { permission: 'alarms', decided: 'Milestone 2 (PLAN.md)', changelog: ['0.3.0'] },
  { permission: 'notifications', decided: 'Milestone 2 (PLAN.md)', changelog: ['0.3.0'] },
  // the dealer's website (Milestone 2), then a car's photo servers asked at post time (the owner, 2026-09-29)
  { permission: 'https://*/*', decided: 'Milestone 2 (PLAN.md); the owner, 2026-09-29 (CLAUDE.md\'s ledger)', changelog: ['0.3.0', 'Unreleased'] },
];

// The text of one CHANGELOG section: from its "## <release>" heading to the next "## ".
function changelogSection(changelog, release) {
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
      assert.ok(section, `CHANGELOG.md has no "## ${release}" section`);
      assert.ok(section.includes('`' + w.permission + '`'), `CHANGELOG.md's "## ${release}" section does not record "${w.permission}"`);
    }
  }
});

test('the CHANGELOG section reader finds a release and stops at the next heading', () => {
  const text = '# Changelog\n\n## Unreleased\n- a\n\n## 0.2.0 (date)\n- `x`\n\n## 0.1.0\n- `y`\n';
  assert.equal(changelogSection(text, '0.2.0'), '## 0.2.0 (date)\n- `x`\n');
  assert.equal(changelogSection(text, '0.1.0'), '## 0.1.0\n- `y`\n');
  assert.equal(changelogSection(text, '0.4.0'), null);
  assert.ok(!changelogSection(text, '0.2.0').includes('`y`'));
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
  // "not a guarantee" is the honest line; nothing else may promise safety, compliance or a guarantee (as test/marketing.test.js checks the marketing copy)
  const rest = listing.replace(/(not|no|isn't|not be|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)[a-z' ]{0,20}guarantee[ds]?/gi, '').replace(/a guarantee\b/gi, '');
  assert.doesNotMatch(rest, /\bguarantee[ds]?\b/i, 'the listing makes a guarantee');
  assert.doesNotMatch(listing, /\bsafe\b|\bcompliant\b|\bguaranteed\b/i);
  for (const re of [/approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i, /compliant with (meta|facebook)/i, /\d+\s*(%|percent|x|times) (faster|more|fewer)/i, /hours? (a|per) (day|week)/i, /\b(five|5) stars?\b/i]) {
    assert.doesNotMatch(listing, re, `store/listing.md matches ${re}`);
  }
});
