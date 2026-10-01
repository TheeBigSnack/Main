// The posts a salesperson took off their posted list (src/takenDown.js):
// what one take-down keeps, whether the website still listed the car, and
// the pruning. The daily cap's use of it is in test/cap.test.js, the
// popup's in test/popup.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTakenDown, takenDownList, stillListedNow, KEEP_DAYS, MAX_ENTRIES } from '../extension/src/takenDown.js';

const T = (day, h = 9) => new Date(Date.UTC(2026, 10, day, h, 0)).toISOString(); // Nov <day> 2026
const VIN = 'TESTVIN00000000A1';

test('one take-down keeps the VIN, when it was posted, when it was taken down and whether the website still listed it', () => {
  const log = noteTakenDown(null, { vin: VIN.toLowerCase(), postedAt: T(10), stillListed: true }, T(11), T(11));
  assert.deepEqual(log, [{ vin: VIN, postedAt: T(10), takenDownAt: T(11), stillListed: true }]);
  // the same post taken down again (a write that failed the first time) is one entry, the newer
  const again = noteTakenDown(log, { vin: VIN, postedAt: T(10) }, T(12), T(12));
  assert.deepEqual(again, [{ vin: VIN, postedAt: T(10), takenDownAt: T(12), stillListed: false }]);
  // another post of the same car is another entry
  assert.equal(noteTakenDown(again, { vin: VIN, postedAt: T(13) }, T(14), T(14)).length, 2);
  // nothing to note without a VIN or a time
  assert.deepEqual(noteTakenDown(log, { postedAt: T(10) }, T(11), T(11)), log);
  assert.deepEqual(noteTakenDown(log, { vin: VIN }, 'not a time', T(11)), log);
  // an entry with no posting time is kept (it counts toward no day)
  assert.deepEqual(noteTakenDown(null, { vin: VIN }, T(11), T(11)), [{ vin: VIN, postedAt: null, takenDownAt: T(11), stillListed: false }]);
});

test('the stored list is read defensively: what is not an entry is dropped', () => {
  assert.deepEqual(takenDownList(null), []);
  assert.deepEqual(takenDownList({ vin: VIN }), []);
  assert.deepEqual(takenDownList([null, 'x', { vin: VIN }, { vin: '', takenDownAt: T(1) }, { vin: VIN, takenDownAt: T(1), postedAt: 'never', stillListed: 'yes' }]), [{ vin: VIN, postedAt: null, takenDownAt: T(1), stillListed: false }]);
});

test('pruned on every write: nothing older than KEEP_DAYS, at most MAX_ENTRIES, the newest kept', () => {
  assert.equal(KEEP_DAYS, 30);
  const old = noteTakenDown(null, { vin: VIN, postedAt: T(1) }, T(1), T(1));
  const after = new Date(Date.parse(T(1)) + (KEEP_DAYS + 1) * 864e5).toISOString();
  const later = noteTakenDown(old, { vin: 'TESTVIN00000000B2', postedAt: after }, after, after);
  assert.deepEqual(later.map((e) => e.vin), ['TESTVIN00000000B2'], 'the take-down from more than KEEP_DAYS ago is dropped');
  let many = [];
  for (let i = 0; i < MAX_ENTRIES + 3; i += 1) many.push({ vin: `TESTVIN${String(i).padStart(10, '0')}`, postedAt: T(10), takenDownAt: new Date(Date.parse(T(10)) + i * 60000).toISOString() });
  many = noteTakenDown(many, { vin: VIN, postedAt: T(10) }, T(20), T(20));
  assert.equal(many.length, MAX_ENTRIES);
  assert.equal(many.at(-1).vin, VIN, 'the newest take-down is last');
  assert.ok(!many.some((e) => e.vin === 'TESTVIN0000000000'), 'the oldest went');
});

test('the website still listed the car when it is in the last scan as ready and not flagged to take down', () => {
  const snapshot = { vehicles: { [VIN]: { vin: VIN, decision: 'ready' }, TESTVIN00000000B2: { vin: 'TESTVIN00000000B2', decision: 'review' } } };
  assert.equal(stillListedNow(snapshot, null, VIN), true);
  assert.equal(stillListedNow(snapshot, { takeDown: [{ vin: VIN, why: 'sale-pending' }] }, VIN), false, 'sale pending on the website');
  assert.equal(stillListedNow(snapshot, null, 'TESTVIN00000000B2'), false, 'not ready to post');
  assert.equal(stillListedNow(snapshot, null, 'TESTVIN00000000C3'), false, 'gone from the website');
  assert.equal(stillListedNow(null, null, VIN), false, 'no scan');
});
