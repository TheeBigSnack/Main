// The To do tab's order (extension/src/todoOrder.js): the scan's own order
// unless the salesperson picks oldest first, where an item is as old as the
// open flag the pilot numbers keep for it. Pure, plus two source checks that
// the popup draws the order and reads it back from the setting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TODO_ORDERS, DEFAULT_TODO_ORDER, todoOrderOf, oldestFirst, openFlagTime } from '../extension/src/todoOrder.js';
import { withDefaults } from '../extension/src/settings.js';

test('the To do order is the scan\'s own order unless the salesperson picks oldest first, and is kept per website', () => {
  assert.equal(DEFAULT_TODO_ORDER, 'listed');
  assert.deepEqual(TODO_ORDERS.map((o) => o.id), ['listed', 'oldest']);
  assert.equal(todoOrderOf(undefined), 'listed');
  assert.equal(todoOrderOf('bogus'), 'listed');
  assert.equal(todoOrderOf('oldest'), 'oldest');
  assert.equal(withDefaults({}).todoOrder, 'listed');
  assert.equal(withDefaults({ todoOrder: 'oldest' }).todoOrder, 'oldest');
  assert.equal(withDefaults({ todoOrder: 'nonsense' }).todoOrder, 'listed');
});

test('oldest first sorts by when each item was first flagged; items with no time go last, in the scan\'s order', () => {
  const items = [{ vin: 'B' }, { vin: 'A' }, { vin: 'C' }, { vin: 'D' }, { vin: 'E' }];
  const when = { A: '2026-10-10T09:00:00.000Z', B: '2026-10-12T09:00:00.000Z', C: '2026-10-01T09:00:00.000Z' };
  const flagAt = (item) => when[item.vin] ?? null;
  assert.deepEqual(oldestFirst(items, flagAt).map((i) => i.vin), ['C', 'A', 'B', 'D', 'E']);
});

test('ties keep the scan\'s order, the input is not changed, and a missing list or a bad time is handled', () => {
  const items = [{ vin: 'X' }, { vin: 'Y' }, { vin: 'Z' }];
  const out = oldestFirst(items, () => '2026-10-10T09:00:00.000Z');
  assert.deepEqual(out.map((i) => i.vin), ['X', 'Y', 'Z']);
  assert.notEqual(out, items);
  assert.deepEqual(items.map((i) => i.vin), ['X', 'Y', 'Z']);
  assert.deepEqual(oldestFirst(null, () => null), []);
  assert.deepEqual(oldestFirst([{ vin: 'Q' }], () => 'not a date'), [{ vin: 'Q' }]);
});

test('an item\'s age is the time its open flag of the same car and kind was made; a closed or other flag does not count', () => {
  const flags = [
    { vin: 'A', kind: 'price', flaggedAt: '2026-10-01T09:00:00.000Z', doneAt: '2026-10-02T09:00:00.000Z' },
    { vin: 'A', kind: 'takeDown', flaggedAt: '2026-10-05T09:00:00.000Z' },
    { vin: 'A', kind: 'price', flaggedAt: '2026-10-09T09:00:00.000Z' },
  ];
  assert.equal(openFlagTime(flags, 'A', 'takeDown'), '2026-10-05T09:00:00.000Z');
  assert.equal(openFlagTime(flags, 'A', 'price'), '2026-10-09T09:00:00.000Z', 'the closed price flag is not the open one');
  assert.equal(openFlagTime(flags, 'B', 'price'), null);
  assert.equal(openFlagTime(null, 'A', 'price'), null);
  assert.equal(openFlagTime([{ vin: 'A', kind: 'price' }], 'A', 'price'), null, 'a flag with no time is not aged');
});

// The popup side, by its text: the order control sits in the To do tab, it is
// read back into the setting, and each item's age is its open flag's time.
test('the To do tab draws the order control and reads each item\'s age from its open pilot flag', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /<select id="todoOrder">/);
  assert.match(popup, /else if \(ev\.target\.id === 'todoOrder'\) changeTodoOrder\(ev\.target\.value\);/);
  assert.match(popup, /openFlagTime\(state\.pilot\?\.flags, it\.vin, kind\)/, 'an item is aged by its open flag');
  assert.match(popup, /todoItems\(takeDown, 'takeDown'\)|todoItems\(d\?\.takeDown \|\| \[\], 'takeDown'\)/);
});
