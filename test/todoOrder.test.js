// The To do tab's order (extension/src/todoOrder.js): the scan's own order
// unless the salesperson picks oldest first, where an item is as old as the
// open flag the pilot numbers keep for it. Pure, plus two source checks that
// the popup draws the order and reads it back from the setting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TODO_ORDERS, DEFAULT_TODO_ORDER, todoOrderOf, oldestFirst, openFlagTime, orderedTodo, todoOrderControl } from '../extension/src/todoOrder.js';
import { withDefaults, withTodoOrder } from '../extension/src/settings.js';

test('the To do order is the scan\'s own order unless the salesperson picks oldest first, and is kept per website', () => {
  assert.equal(DEFAULT_TODO_ORDER, 'listed');
  assert.deepEqual(TODO_ORDERS.map((o) => o.id), ['listed', 'oldest']);
  assert.equal(todoOrderOf(undefined), 'listed');
  assert.equal(todoOrderOf('bogus'), 'listed');
  assert.equal(todoOrderOf('oldest'), 'oldest');
  assert.equal(withDefaults({}).todoOrder, 'listed');
  assert.equal(withDefaults({ todoOrder: 'oldest' }).todoOrder, 'oldest');
  assert.equal(withDefaults({ todoOrder: 'nonsense' }).todoOrder, 'listed');
  assert.equal(withTodoOrder({ readySort: 'price', newDays: 9 }, 'oldest', {}).readySort, 'price', 'saving the order keeps the other settings');
  assert.equal(withTodoOrder({ readySort: 'price', newDays: 9 }, 'oldest', {}).newDays, 9);
  assert.equal(withTodoOrder({}, 'nonsense', {}).todoOrder, 'listed');
  assert.equal(withTodoOrder({}, 'oldest', {}).todoOrder, 'oldest', 'a chosen order is what gets saved, not the default');
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

test('the caller\'s list keeps the scan\'s order whatever the times are', () => {
  const items = [{ vin: 'B' }, { vin: 'A' }, { vin: 'C' }];
  const when = { A: '2026-10-10T09:00:00.000Z', B: '2026-10-12T09:00:00.000Z', C: '2026-10-01T09:00:00.000Z' };
  assert.deepEqual(oldestFirst(items, (i) => when[i.vin]).map((i) => i.vin), ['C', 'A', 'B']);
  assert.deepEqual(items.map((i) => i.vin), ['B', 'A', 'C'], 'the scan diff the popup keeps is not reordered');
});

test('the To do list is ordered by each kind\'s own flags when oldest first is chosen, and as the scan lists it otherwise', () => {
  const flags = [
    { vin: 'A', kind: 'price', flaggedAt: '2026-10-09T09:00:00.000Z' },
    { vin: 'B', kind: 'price', flaggedAt: '2026-10-02T09:00:00.000Z' },
    { vin: 'A', kind: 'takeDown', flaggedAt: '2026-10-01T09:00:00.000Z' },
  ];
  const prices = [{ vin: 'A' }, { vin: 'B' }];
  assert.deepEqual(orderedTodo(prices, 'price', flags, 'oldest').map((i) => i.vin), ['B', 'A']);
  assert.deepEqual(orderedTodo(prices, 'price', flags, 'listed').map((i) => i.vin), ['A', 'B']);
  assert.deepEqual(orderedTodo(prices, 'price', flags, undefined).map((i) => i.vin), ['A', 'B'], 'the default is the scan\'s order');
  const takes = [{ vin: 'B' }, { vin: 'A' }];
  assert.deepEqual(orderedTodo(takes, 'takeDown', flags, 'oldest').map((i) => i.vin), ['A', 'B'], 'take-downs are aged by take-down flags only: B has none, so it goes last');
  assert.deepEqual(orderedTodo(prices, 'price', null, 'oldest').map((i) => i.vin), ['A', 'B'], 'with no flags, the scan\'s order');
  assert.deepEqual(orderedTodo(null, 'price', flags, 'oldest'), []);
});

test('the order control lists both orders with the one chosen selected, and is drawn only for two or more items', () => {
  const html = todoOrderControl('oldest', 2);
  assert.match(html, /^<div class="toolbar listControls"><label class="control"><span>Order<\/span><select id="todoOrder">/);
  assert.match(html, /<option value="oldest" selected>Oldest first<\/option>/);
  assert.match(html, /<option value="listed">As the scan lists them<\/option>/);
  assert.match(todoOrderControl('listed', 2), /<option value="listed" selected>/);
  assert.equal(todoOrderControl('listed', 1), '', 'one item has no order to choose');
  assert.equal(todoOrderControl('listed', 0), '');
});

// The popup's To do tab uses these for its two kinds of items and for the
// control, and saves the choice with withTodoOrder: a source check that each
// is wired, since the popup itself has no unit test.
test('the To do tab orders both its item lists through orderedTodo, draws todoOrderControl, and saves the choice with withTodoOrder', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /const takeDown = orderedTodo\(d\?\.takeDown \|\| \[\], 'takeDown', state\.pilot\?\.flags, state\.settings\?\.todoOrder\);/);
  assert.match(popup, /const updates = orderedTodo\(d\?\.priceUpdates \|\| \[\], 'price', state\.pilot\?\.flags, state\.settings\?\.todoOrder\);/);
  assert.match(popup, /return html \+ todoOrderControl\(state\.settings\?\.todoOrder, takeDown\.length \+ updates\.length\) \+ parts\.join\(''\);/);
  assert.match(popup, /else if \(ev\.target\.id === 'todoOrder'\) changeTodoOrder\(ev\.target\.value\);/);
  assert.match(popup, /state\.settings = withTodoOrder\(state\.settings \|\| \{\}, value, site\);/);
  assert.match(popup, /await update\('settings', \(s\) => withTodoOrder\(s \|\| state\.settings \|\| \{\}, value, site\)\);/);
});
