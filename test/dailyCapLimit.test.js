// The daily post cap is a safety setting the dealership can change, up to 100
// (CLAUDE.md, non-negotiable 7). The Settings form stops at 100, but the stored
// value is read through withDefaults, so a value that came in from a synced
// profile or from storage, not from the form, is held to the same limit there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withDefaults } from '../extension/src/settings.js';
import { DEFAULT_DAILY_CAP, MAX_DAILY_CAP } from '../extension/src/cap.js';

const cap = (dailyCap) => withDefaults({ dailyCap }, {}).dailyCap;

test('the daily cap is at most 100 whatever is stored, and 10 when it is missing or not a count of at least one', () => {
  assert.equal(MAX_DAILY_CAP, 100);
  assert.equal(DEFAULT_DAILY_CAP, 10);
  assert.equal(cap(undefined), 10);
  assert.equal(cap(0), 10);
  assert.equal(cap(-5), 10);
  assert.equal(cap(0.5), 10, 'a fraction under one post is not a cap of none');
  assert.equal(cap(NaN), 10);
  assert.equal(cap('20'), 10, 'a string is not a count');
  assert.equal(cap(1), 1);
  assert.equal(cap(25.9), 25, 'a fraction is dropped');
  assert.equal(cap(100), 100);
  assert.equal(cap(101), 100, 'above 100 is held to 100');
  assert.equal(cap(500), 100);
  assert.equal(cap(1e9), 100);
});

test('the Settings form and its field stop at the same limit as the stored one', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /import \{[^}]*\bMAX_DAILY_CAP\b[^}]*\} from '\.\/src\/cap\.js';/, 'popup.js imports the limit from cap.js');
  assert.match(popup, /dailyCap: Math\.max\(1, Math\.min\(MAX_DAILY_CAP, Number\(form\.get\('dailyCap'\)\) \|\| DEFAULT_DAILY_CAP\)\)/, 'the form saves at most the limit');
  assert.match(popup, /'dailyCap', s\.dailyCap, 'type="number" min="1" max="' \+ MAX_DAILY_CAP \+ '"'/, 'the field offers no more than the limit');
});
