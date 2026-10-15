// Platform names stay out of extension/src (CLAUDE.md: platform code lives
// under extension/adapters/, and src/ gains none). A comment may name a
// platform, since a comment is how the code explains a quirk (panelList.js
// says why a Dealer Inspire list is read as it is); code and strings may not,
// because a string is what a person reads on screen or what a branch
// compares. The names come from the adapters themselves, so a new platform
// is checked with no change here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ADAPTERS } from '../extension/adapters/index.js';

const SRC = new URL('../extension/src/', import.meta.url);

// Block comments, then line comments. A line comment starts where `//`
// follows the start of a line or a space, `;`, a bracket or a comma, so the
// `//` of an address ("https://") in a string is not taken for one. A string
// that holds ` //` followed by a name is read as a comment: a known gap.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[\s;,([{])\/\/.*$/gm, '$1');
}

// Every name a platform goes by: its id as the code writes it, and the name
// people see, with the words of a name as they are (a dot, a space).
const NAMES = ADAPTERS.flatMap((a) => [a.PLATFORM.id, a.PLATFORM.name])
  .filter((n) => !/[()]/.test(n))
  .map((n) => n.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));

// The platform names a piece of code (comments already removed) mentions.
// A name is a whole word: `schemaOrg` is found in `schemaOrg.js` but not in
// `conditionFromSchemaOrg`, and `DealerOn` not in `DealerOnline`.
function mentions(code) {
  const found = [];
  for (const name of NAMES) {
    const re = new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`, 'i');
    if (re.test(code)) found.push(name);
  }
  return found;
}

test('the guard names every adapter id and the name people see for each platform', () => {
  assert.ok(ADAPTERS.length >= 3, 'the built adapters are listed');
  for (const a of ADAPTERS) {
    assert.ok(mentions(a.PLATFORM.id).length > 0, `${a.PLATFORM.id} is guarded`);
  }
  assert.ok(mentions('Dealer Inspire').length > 0, 'the Dealer Inspire name is guarded');
  assert.ok(mentions('Dealer.com').length > 0, 'the Dealer.com name is guarded');
});

test('the guard reads a comment as a comment and code or a string as code', () => {
  assert.deepEqual(mentions(codeOnly('// Dealer Inspire lists read as they are\nconst x = 1;')), []);
  assert.deepEqual(mentions(codeOnly('/* DealerOn is read by its own adapter */ const x = 1;')), []);
  assert.deepEqual(mentions(codeOnly("const label = 'Dealer Inspire';")), ['Dealer\\s+Inspire']);
  assert.deepEqual(mentions(codeOnly("import x from '../adapters/schemaOrg.js';")), ['schemaOrg']);
  assert.deepEqual(mentions(codeOnly("const u = 'https://dealership.example/x'; // the list")), []);
  assert.deepEqual(mentions(codeOnly('function conditionFromSchemaOrg(v) { return v; }')), []);
  assert.deepEqual(mentions(codeOnly('const o = { dealerOnline: 1 };')), []);
});

test('extension/src names no platform in code or in a string', () => {
  const offenders = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    const found = mentions(codeOnly(readFileSync(new URL(file, SRC), 'utf8')));
    if (found.length) offenders.push(`${file}: ${found.join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'platform code belongs under extension/adapters/');
});
