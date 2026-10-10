// What the pilot numbers (extension/src/pilot.js) hold, against what the
// texts say they hold. The records name more than timings: each post
// attempt and to-do item carries the car's VIN and name, a post attempt the
// salesperson's name from Settings and the reason it stopped, a price change
// the website's old and new price. The field list below is the one place
// that says so: a field pilot.js starts writing fails here until it is
// added, with the words docs/data-inventory.md's pilot row names it by. The
// salesperson reads the same before set-up ends (the Terms step) and on the
// Numbers tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginPost, notePostStep, endPost, noteFill, noteFlags, resolveFlag, POST_STEPS } from '../extension/src/pilot.js';
import { wiz, wizardHtml } from '../extension/wizard.js';
import { loadPopup } from './popupHarness.js';

// Every field of a pilot record, per list, with the words the pilot row of
// docs/data-inventory.md uses for it.
const PILOT_FIELDS = {
  posts: {
    vin: 'VIN', name: 'car name', salesperson: 'salesperson name', queue: 'queue or not', startedAt: 'when started',
    reviewedAt: 'reviewed', formOpenedAt: 'form opened', filledAt: 'filled', endedAt: 'ended', outcome: 'outcome', seconds: 'seconds', reason: 'reason',
  },
  fills: {
    at: 'when', vin: 'VIN', mapVersion: 'form map', version: 'build version', filled: 'field keys filled', partial: 'needing a click',
    blocked: 'blocked', changed: 'changed', preexisting: 'whether another car was already on the form',
  },
  flags: {
    vin: 'VIN', kind: 'kind', name: 'car name', why: 'why', from: 'the two prices', to: 'the two prices',
    flaggedAt: 'when flagged', doneAt: 'done', how: 'how', hours: 'hours',
  },
};

// Every record pilot.js can write, with every option it takes.
function everyRecord() {
  const at = '2026-09-30T15:00:00.000Z';
  let p = beginPost(null, { vin: '1HGSAMPL2LH100007', name: '2020 Example Truck', salesperson: 'Sam', queue: true, at });
  for (const step of POST_STEPS) p = notePostStep(p, '1HGSAMPL2LH100007', step, at);
  p = endPost(p, '1HGSAMPL2LH100007', 'blocked', { at, reason: 'vin-mismatch' });
  const fieldList = [{ key: 'price' }];
  p = noteFill(p, { vin: '1HGSAMPL2LH100007', at, mapVersion: 'map-1', version: '0.0.0', fill: { filled: fieldList, partial: fieldList, blocked: fieldList, changedAfterFill: fieldList, preexisting: [{ key: 'title' }] } });
  p = noteFlags(p, {
    takeDown: [{ vin: '1HGSAMPL2LH100007', name: '2020 Example Truck', yours: true, why: 'gone' }],
    priceUpdates: [{ vin: '1HGSAMPL0KH100003', name: '2019 Example Sedan', yours: true, from: 21000, to: 20500 }],
  }, { at });
  return resolveFlag(p, '1HGSAMPL2LH100007', null, { at: '2026-09-30T18:00:00.000Z', how: 'manual' });
}

test('every field a pilot record holds is in the list above, and the list holds no field pilot.js no longer writes', () => {
  const p = everyRecord();
  for (const list of Object.keys(PILOT_FIELDS)) {
    const written = new Set(p[list].flatMap((entry) => Object.keys(entry)));
    assert.deepEqual([...written].sort(), Object.keys(PILOT_FIELDS[list]).sort(), `the ${list} records hold other fields than the list names: add a new one, with its words in docs/data-inventory.md`);
  }
});

test('docs/data-inventory.md\'s pilot row names every field a pilot record holds', () => {
  const inventory = readFileSync(new URL('../docs/data-inventory.md', import.meta.url), 'utf8');
  const row = inventory.split('\n').find((line) => line.startsWith('| `pilot:<origin>`'));
  assert.ok(row, 'docs/data-inventory.md has no pilot:<origin> row');
  for (const [list, fields] of Object.entries(PILOT_FIELDS)) {
    for (const [field, words] of Object.entries(fields)) assert.ok(row.includes(words), `the pilot row does not name the ${list} field ${field} ("${words}")`);
  }
});

// The car, the person and the prices, in the words a salesperson reads.
const NAMES_WHAT_IS_KEPT = [/\bVIN\b/, /\bname\b[^.]*\bfrom Settings\b/, /old and new price/];

test('set-up\'s Terms step says the pilot numbers keep the car, the salesperson\'s name and the old and new price', () => {
  wiz.step = 'terms';
  const html = wizardHtml();
  const summary = html.slice(html.indexOf('In short:'));
  for (const re of NAMES_WHAT_IS_KEPT) assert.match(summary, re);
});

test('the Numbers tab says the same above its numbers', async () => {
  const p = await loadPopup();
  await p.tab('pilot');
  const lead = p.panel().split('</p>')[0];
  assert.match(lead, /The numbers your dealership sees/);
  for (const re of NAMES_WHAT_IS_KEPT) assert.match(lead, re);
});
