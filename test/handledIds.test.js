// Every button id the side panel's click handler acts on is drawn somewhere:
// a handler for a button nobody draws is dead code, and a button whose id was
// renamed in one place and not the other does nothing when a person clicks it.
// Static: it reads the handler's cases and the id="..." attributes the panel
// and its modules draw. The ids drawn with a template (id="${...}") are not
// listed here, so a case must match a literal id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const EXT = new URL('../extension/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, EXT), 'utf8');

// The body of onClick in sidepanel.js: from its header to the first line that
// closes it at column zero.
function clickHandler(src) {
  const start = src.indexOf('async function onClick(ev) {');
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? '' : src.slice(start, end);
}

// Every id the handler acts on: a switch case ('name') or a btn.id comparison.
function handledIds(body) {
  const ids = new Set();
  for (const m of body.matchAll(/case '([^']+)':/g)) ids.add(m[1]);
  for (const m of body.matchAll(/btn\.id === '([^']+)'/g)) ids.add(m[1]);
  return [...ids].sort();
}

// The module files that draw the side panel's buttons.
function drawingSources() {
  const out = [read('sidepanel.js'), read('sidepanel.html'), read('wizard.js'), read('upkeep.js')];
  for (const f of readdirSync(new URL('src/', EXT))) if (f.endsWith('.js')) out.push(read('src/' + f));
  return out;
}

test('every button id the side panel handler acts on is drawn by the panel or its modules', () => {
  const ids = handledIds(clickHandler(read('sidepanel.js')));
  assert.ok(ids.length >= 20, `the handler's ids were not found (${ids.length})`);
  const drawn = drawingSources().join('\n');
  const missing = ids.filter((id) => !new RegExp(`id=["']${id}["']`).test(drawn));
  assert.deepEqual(missing, [], 'a handled id is not drawn anywhere: the click does nothing');
});

test('the handler reader finds the cases and id comparisons it is meant to find', () => {
  const ids = handledIds(clickHandler(read('sidepanel.js')));
  for (const id of ['fillNow', 'queueStop', 'photosNone', 'skipBlocked']) assert.ok(ids.includes(id), `${id} is not read from the handler`);
});
