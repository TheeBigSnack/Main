// The side panel keeps the times of its last scan the way the snapshot holds
// them: when the scan began (startedAt) and the read times of cars carried over
// unread (carriedReadAt), as well as when it finished (takenAt). The two places
// that price a car from that scan (the list's draft pill, draftScanCar, and the
// price the panel fills for a listing, upkeepPriceNow's scanCar) pass all of
// them, so each car is read as of the time the To do list reads it
// (src/rescan.js scanCar). The panel's code runs in the page, so this reads its
// source as panelKeyboard.test.js does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// The scan the two price checks read, as the panel passes it.
const SCAN = '{ takenAt: state.snapshotTakenAt, startedAt: state.snapshotStartedAt, carriedReadAt: state.snapshotCarriedReadAt, vehicles: state.snapshotVehicles }';

// (A regex test, not assert.match: a failure prints the whole source.)
const has = (re, what) => assert.ok(re.test(src), what);

test('the side panel keeps when its last scan began and the carried read times, beside when it finished', () => {
  has(/\n {4}snapshotStartedAt: data\[k\.snapshot\]\?\.startedAt \|\| null,/, 'loaded from the saved snapshot');
  has(/\n {4}snapshotCarriedReadAt: data\[k\.snapshot\]\?\.carriedReadAt \|\| null,/, 'loaded from the saved snapshot');
  has(/\n {2}snapshotStartedAt: null,/, 'declared with the other scan fields');
  has(/\n {2}snapshotCarriedReadAt: null,/, 'declared with the other scan fields');
});

test('a new scan sets those fields from its snapshot, as it sets the finish time', () => {
  has(/\n {6}state\.snapshotTakenAt = \(snap && snap\.takenAt\) \|\| null;/, 'the finish time, as before');
  has(/\n {6}state\.snapshotStartedAt = \(snap && snap\.startedAt\) \|\| null;/, 'the start time');
  has(/\n {6}state\.snapshotCarriedReadAt = \(snap && snap\.carriedReadAt\) \|\| null;/, 'the carried read times');
});

test('the list\'s draft pill and the price the panel fills read each car through the whole scan (draftScanCar, scanCar), not the finish time alone', () => {
  assert.ok(src.includes(`draftScanCar(state.drafts[r.vin], ${SCAN}, r.vin)`), 'the list\'s draft pill passes the whole scan');
  assert.ok(src.includes(`scanCar(state.posted[vin], ${SCAN}, vin)`), 'the price the panel fills for a listing (upkeepPriceNow) passes the whole scan');
  assert.ok(!src.includes('{ takenAt: state.snapshotTakenAt, vehicles: state.snapshotVehicles }'), 'no call passes the finish time alone');
});
