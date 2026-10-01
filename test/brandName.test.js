// The product is Lot Current (renamed from Lot Sync on 2026-10-01, when the old
// name turned out to belong to another dealership-software company). Nothing a
// person reads may carry the old name: every text file in the repository is
// scanned for "Lot Sync" (any case) and the word "LotSync", and the files people see
// (the extension's pages and manifest, the website and its sources, the
// manager view, the sandbox, the emails, docs, legal, marketing, store) also
// for "lot-sync". The old spelling stays only where it is history or invisible:
// the released part of CHANGELOG.md, HANDOFF.md, the trademark note and the
// attorney questions (which name the other company), the owner's own folder
// path in docs/survey.md, and internal identifiers (storage keys, alarm and
// notification ids, environment variable names, test fixture ids), which keep
// `lotsync`/`lot-sync` so existing installs keep their data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'survey-out', 'test-results']);
const TEXT = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.svg', '.toml', '.sql', '.yml', '.yaml', '.xml', '.ts', '.csv', '']);

// Whole files where the old name is history or names the other company.
const HISTORY = new Set(['HANDOFF.md', 'legal/trademark-note.md', 'legal/questions-for-attorney.md', 'test/brandName.test.js']);
// Single lines that keep the old spelling on purpose.
const KEPT_LINES = [
  /cd E:\\LotSync/, // the owner's existing folder on the Windows machine
  /^- \*\*Renamed to Lot Current\*\*/ // CHANGELOG's entry saying what the old name was
];
// Where people read the text: these must not say lot-sync either.
const VISIBLE = /^(extension\/[^/]+\.html|extension\/manifest\.json|site\/|site-src\/|manager\/[^/]+\.html|demo\/.*\.html|supabase\/templates\/|docs\/|legal\/|marketing\/|store\/|README\.md|PILOT\.md)/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (TEXT.has(extname(entry.name)) && entry.name !== 'package-lock.json') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const FILES = walk(ROOT).map((p) => relative(ROOT, p).split('\\').join('/'));

// CHANGELOG.md: the Unreleased part ships under the new name; released
// versions keep the words they were released with.
function unreleased(text) {
  const start = text.indexOf('## Unreleased');
  const next = text.indexOf('\n## ', start + 1);
  return start < 0 ? '' : text.slice(start, next < 0 ? undefined : next);
}

test('no text file says Lot Sync or LotSync, outside history and the trademark notes', () => {
  const found = [];
  for (const rel of FILES) {
    if (HISTORY.has(rel)) continue;
    let text = readFileSync(join(ROOT, rel), 'utf8');
    if (rel === 'CHANGELOG.md') text = unreleased(text);
    text.split('\n').forEach((line, i) => {
      if (KEPT_LINES.some((re) => re.test(line))) return;
      if (/\blot sync\b/i.test(line) || /\bLotSync\b/.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], 'the old name is still shown:\n' + found.join('\n'));
});

test('the files people see do not say lot-sync either', () => {
  const found = [];
  for (const rel of FILES) {
    if (HISTORY.has(rel) || !VISIBLE.test(rel)) continue;
    readFileSync(join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
      if (/lot-sync/i.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], found.join('\n'));
});

test('the extension, the website and the package carry the new name', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'));
  assert.match(manifest.name, /^Lot Current\b/);
  assert.match(readFileSync(join(ROOT, 'site/index.html'), 'utf8'), /<title>[^<]*\| Lot Current<\/title>/);
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name, 'lot-current');
});

test('the scan sees the files it must: the site, the extension and the legal texts', () => {
  for (const rel of ['site/index.html', 'extension/popup.html', 'extension/manifest.json', 'legal/terms-of-service.md', 'CHANGELOG.md']) {
    assert.ok(FILES.includes(rel), rel);
  }
});
