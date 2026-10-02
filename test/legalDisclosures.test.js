// What the legal drafts and the store texts say Lot Current does on Facebook
// and on its own, held to the code. Each test reads the code fact first, so a
// change to the code fails here with the texts to update, and then reads the
// texts the attorney, Google's reviewer and the user are given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// The text from a "## " heading to the next "## " heading.
function section(text, heading) {
  const start = text.indexOf('\n' + heading + '\n');
  assert.ok(start >= 0, `no "${heading}" heading`);
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// The cell after "| <first cell> |" on a table row whose first cell matches.
function rowText(text, firstCell) {
  const line = text.split('\n').find((l) => l.startsWith('| ' + firstCell + ' |'));
  assert.ok(line, `no table row for ${firstCell}`);
  return line;
}

test('the attorney\'s automated-means question says how the form is typed into and that a queue opens the next form without a click', () => {
  // the code: suggestion boxes are typed one character at a time with key events and a fixed pause
  const fill = read('extension/facebook/fillForm.js');
  assert.match(fill, /async function typeText\(el, value\) \{[\s\S]*?for \(const ch of String\(value\)\) \{[\s\S]*?key\(el, ch\)[\s\S]*?await sleep\(\d+\);/, 'fillForm.js no longer types character by character: update questions-for-attorney.md 1 and this test');
  assert.doesNotMatch(fill, /Math\.random/, 'a random delay would break rule 2; the texts say the pauses are fixed');
  // the code: in a queue a car that passes every check opens and fills the form with no click
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /if \(state\.queueMode && canAutoOpen\(\)\)[^\n]*openForm\(/, 'the queue no longer opens the next form by itself: update questions-for-attorney.md 1, the scripting rows and this test');

  const q1 = section(read('legal/questions-for-attorney.md'), '## 1. Meta\'s Terms and Commerce Policies').split('\n').find((l) => l.includes('"using automated means"'));
  assert.ok(q1, 'questions-for-attorney.md 1 lost its automated-means question');
  assert.doesNotMatch(q1, /uses no delays/, 'the question says no delays while the fill pauses between characters');
  assert.match(q1, /one character at a time with key events/);
  assert.match(q1, /fixed pause/);
  assert.match(q1, /no randomized or "human-like" delays/);
  assert.match(q1, /queue/);
  assert.match(q1, /without another click/);
  assert.match(q1, /does the queue's opening and filling of the next car's form without a click change the answer\?/, 'the attorney is asked about the queue itself');

  // what Google's reviewer reads for the scripting permission
  const store = rowText(read('legal/chrome-web-store-privacy.md'), '`scripting`');
  const listing = rowText(read('store/listing.md'), '`scripting`');
  for (const [where, row] of [['legal/chrome-web-store-privacy.md', store], ['store/listing.md', listing]]) {
    assert.match(row, /queue/, `${where}: the scripting row leaves out the queue's forms`);
    assert.match(row, /without another click/, `${where}: the scripting row says every form is filled from a click`);
    assert.match(row, /to-do item/, `${where}: the scripting row leaves out the listing read and the price fill`);
    assert.doesNotMatch(row, /form (?:the person opened )?when (?:the user|they) click Post/, `${where}: the scripting row says the form is filled only on a click on Post`);
  }
  // and the data inventory the privacy texts follow
  const inventory = rowText(read('docs/data-inventory.md'), 'Fill the Marketplace form (`facebook/fillForm.js`)');
  assert.match(inventory, /in a queue the person started, each car that passes every check, without another click/);
});

test('the Terms say what Lot Current does with nobody at the computer: the rescan the User allowed and its upload, never Facebook', () => {
  // the code: an alarm rescans the websites the person allowed and, signed in, syncs the result
  const bg = read('extension/background.js');
  const rescan = bg.slice(bg.indexOf('async function runRescan'), bg.indexOf('async function rescanDueSites'));
  assert.ok(rescan.length > 100 && /\bsyncSite\(/.test(rescan), 'the background rescan no longer syncs: update the Terms and this test');
  assert.match(bg, /chrome\.alarms\.create\(RESCAN_ALARM, \{ periodInMinutes: RESCAN_PERIOD_MINUTES/);
  assert.match(read('extension/src/rescanSchedule.js'), /RESCAN_PERIOD_MINUTES = 180;/, 'the rescan is no longer every 3 hours: update the Terms and this test');
  assert.match(bg, /if \(!info\.auto\) continue;/, 'the rescan no longer waits for the person\'s allowing it: update the Terms and this test');

  const what = section(read('legal/terms-of-service.md'), '## 1. What Lot Current is');
  assert.doesNotMatch(what, /does not act while the User is away/, 'the Terms say Lot Current does nothing while the User is away');
  assert.match(what, /never acts on Facebook while the User is away/);
  assert.match(what, /If the User allows it, Lot Current re-reads the dealership's website every 3 hours while Chrome is open/);
  assert.match(what, /while the User is signed in, sends the results to the dealership's records/);
});
