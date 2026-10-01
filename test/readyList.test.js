// The Ready to post list's helpers (extension/src/readyList.js): the four
// sort orders with ties and missing values, what "new" means at the edges of
// its window and for posted cars, the search box, and the words under each
// car, which name where a date came from and count days on the lot only
// from the website's own date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SORT_ORDERS, DEFAULT_SORT, sortOrder, DEFAULT_NEW_DAYS, MIN_NEW_DAYS, MAX_NEW_DAYS, newDaysOf, DAY_MS,
  lotDate, ageDays, daysOnLot, isNew, shortDate, dateLine, filterText, compareEntries, sortEntries, newCars,
} from '../extension/src/readyList.js';
import { snapshot, fixtures } from './helpers.js';

// Noon on 1 October 2026 in the machine's own time zone: the website's
// calendar dates are counted in the person's day, so the tests build "now"
// the same way the popup's clock gives it.
const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime();
const car = (vin, patch = {}) => ({ vin, name: `2020 Make Model ${vin}`, stock: `S${vin}`, price: 20000, ...patch });
const SITE_DATE = '2026-09-28T00:00:00.000Z';
const SEEN = '2026-09-29T15:30:00.000Z';

test('the sort orders are the four the popup offers, and anything unknown is the default, newest on the lot', () => {
  assert.deepEqual(SORT_ORDERS.map((o) => o.id), ['newest', 'longest', 'price', 'name']);
  assert.deepEqual(SORT_ORDERS.map((o) => o.label), ['Newest on the lot', 'Longest on the lot', 'Price, low to high', 'Name']);
  assert.equal(DEFAULT_SORT, 'newest');
  for (const id of ['newest', 'longest', 'price', 'name']) assert.equal(sortOrder(id), id);
  for (const bad of [undefined, null, '', 'oldest', 42, 'Newest on the lot']) assert.equal(sortOrder(bad), 'newest', String(bad));
});

test('the new-arrival window is 1 to 30 days, 7 by default, and junk is the default', () => {
  assert.equal(DEFAULT_NEW_DAYS, 7);
  assert.deepEqual([MIN_NEW_DAYS, MAX_NEW_DAYS], [1, 30]);
  assert.equal(newDaysOf(undefined), 7);
  assert.equal(newDaysOf(null), 7);
  assert.equal(newDaysOf('abc'), 7);
  assert.equal(newDaysOf(0), 7, 'a zero is not a window');
  assert.equal(newDaysOf(-3), 7);
  assert.equal(newDaysOf(0.5), 7);
  assert.equal(newDaysOf(1), 1);
  assert.equal(newDaysOf('14'), 14);
  assert.equal(newDaysOf(14.9), 14, 'whole days');
  assert.equal(newDaysOf(30), 30);
  assert.equal(newDaysOf(31), 30, 'capped at 30');
  assert.equal(newDaysOf(Infinity), 7);
});

test("a car's date: the website's in-stock date first, else the scan that first saw it, else nothing", () => {
  assert.deepEqual(lotDate(car('A', { dateInStock: SITE_DATE, firstSeenAt: SEEN })), { at: Date.parse(SITE_DATE), dateOnly: true, source: 'website' });
  assert.deepEqual(lotDate(car('A', { dateInStock: '2026-09-28', firstSeenAt: SEEN })), { at: Date.parse('2026-09-28'), dateOnly: true, source: 'website' }, 'a bare date is a calendar date too');
  assert.deepEqual(lotDate(car('A', { dateInStock: null, firstSeenAt: SEEN })), { at: Date.parse(SEEN), dateOnly: false, source: 'lotSync' });
  assert.deepEqual(lotDate(car('A', { dateInStock: 'not a date', firstSeenAt: SEEN })), { at: Date.parse(SEEN), dateOnly: false, source: 'lotSync' }, 'an unreadable website date is no date');
  assert.deepEqual(lotDate(car('A', { dateInStock: '', firstSeenAt: '' })), null);
  assert.deepEqual(lotDate(car('A', { firstSeenAt: null })), null, 'a car already there at the first scan');
  assert.deepEqual(lotDate(car('A')), null, 'an entry saved before the dates existed');
  assert.deepEqual(lotDate(null), null);
  assert.deepEqual(lotDate('x'), null);
  // the snapshot entries the real pipeline builds carry the website's date as the record gave it
  const s = snapshot([['usedNormal'], ['certified']]);
  assert.equal(s.vehicles[fixtures.usedNormal.vin].dateInStock, fixtures.usedNormal.date_in_stock);
  assert.equal(lotDate(s.vehicles[fixtures.usedNormal.vin]).source, 'website');
});

test("how long ago: whole calendar days for the website's date, in the person's day; a fraction for a sighting; none without a date", () => {
  assert.equal(ageDays(car('A', { dateInStock: SITE_DATE }), NOW), 3);
  assert.equal(ageDays(car('A', { dateInStock: '2026-10-01T00:00:00.000Z' }), NOW), 0, 'in stock today');
  assert.equal(ageDays(car('A', { dateInStock: '2026-10-02T00:00:00.000Z' }), NOW), 0, "the website's date is tomorrow (its clock, or midnight UTC read the evening before): not negative");
  // a sighting at the same moment, a day before, a day and a half before
  assert.equal(ageDays(car('A', { firstSeenAt: new Date(NOW).toISOString() }), NOW), 0);
  assert.equal(ageDays(car('A', { firstSeenAt: new Date(NOW - DAY_MS).toISOString() }), NOW), 1);
  assert.equal(ageDays(car('A', { firstSeenAt: new Date(NOW - 1.5 * DAY_MS).toISOString() }), NOW), 1.5);
  assert.equal(ageDays(car('A'), NOW), null);
  // days on the lot only from the website's date
  assert.equal(daysOnLot(car('A', { dateInStock: SITE_DATE }), NOW), 3);
  assert.equal(daysOnLot(car('A', { dateInStock: '2026-10-01T00:00:00.000Z' }), NOW), 0);
  assert.equal(daysOnLot(car('A', { firstSeenAt: new Date(NOW - 3 * DAY_MS).toISOString() }), NOW), null, 'a first sighting says nothing about how long the car was there');
  assert.equal(daysOnLot(car('A'), NOW), null);
});

test('new: within the window by the website\'s date, inclusive at the edge, calendar days', () => {
  const inStock = (daysAgo) => new Date(Date.UTC(2026, 9, 1) - daysAgo * DAY_MS).toISOString();
  assert.equal(isNew(car('A', { dateInStock: inStock(0) }), { now: NOW }), true, 'today');
  assert.equal(isNew(car('A', { dateInStock: inStock(6) }), { now: NOW }), true);
  assert.equal(isNew(car('A', { dateInStock: inStock(7) }), { now: NOW }), true, 'exactly 7 days ago is within a 7-day window');
  assert.equal(isNew(car('A', { dateInStock: inStock(8) }), { now: NOW }), false, 'the day after the window');
  assert.equal(isNew(car('A', { dateInStock: inStock(-1) }), { now: NOW }), true, 'a date in the future counts as within the window');
  // the window is the setting
  assert.equal(isNew(car('A', { dateInStock: inStock(8) }), { now: NOW, days: 10 }), true);
  assert.equal(isNew(car('A', { dateInStock: inStock(2) }), { now: NOW, days: 1 }), false);
  assert.equal(isNew(car('A', { dateInStock: inStock(1) }), { now: NOW, days: 1 }), true);
  assert.equal(isNew(car('A', { dateInStock: inStock(30) }), { now: NOW, days: 30 }), true);
  assert.equal(isNew(car('A', { dateInStock: inStock(31) }), { now: NOW, days: 30 }), false);
  assert.equal(isNew(car('A', { dateInStock: inStock(8) }), { now: NOW, days: 99 }), true, 'a window over 30 is 30');
  assert.equal(isNew(car('A', { dateInStock: inStock(31) }), { now: NOW, days: 99 }), false);
  assert.equal(isNew(car('A', { dateInStock: inStock(5) }), { now: NOW, days: 'junk' }), true, 'junk is the default 7');
  assert.equal(isNew(car('A', { dateInStock: inStock(8) }), { now: NOW, days: 0 }), false, 'a zero is the default 7, not forever');
  assert.equal(isNew(car('A', { dateInStock: inStock(5) }), { now: NOW, days: 0 }), true);
});

test('new: by the first sighting when the website gives no date, to the millisecond at the edge; never on a first scan', () => {
  const seen = (msAgo) => new Date(NOW - msAgo).toISOString();
  assert.equal(isNew(car('A', { firstSeenAt: seen(0) }), { now: NOW }), true);
  assert.equal(isNew(car('A', { firstSeenAt: seen(7 * DAY_MS) }), { now: NOW }), true, 'exactly 7 days ago');
  assert.equal(isNew(car('A', { firstSeenAt: seen(7 * DAY_MS + 1) }), { now: NOW }), false, 'one millisecond past the window');
  assert.equal(isNew(car('A', { firstSeenAt: seen(-60000) }), { now: NOW }), true, 'a sighting a minute ahead of this clock is still new');
  assert.equal(isNew(car('A', { firstSeenAt: null }), { now: NOW }), false, 'already there at the first scan');
  assert.equal(isNew(car('A'), { now: NOW }), false, 'no dates at all');
  // the website's date wins over the sighting, both ways
  assert.equal(isNew(car('A', { dateInStock: '2026-08-01T00:00:00.000Z', firstSeenAt: seen(DAY_MS) }), { now: NOW }), false, 'the website says it has been there two months, however recently Lot Sync first saw it');
  assert.equal(isNew(car('A', { dateInStock: '2026-09-30T00:00:00.000Z', firstSeenAt: seen(20 * DAY_MS) }), { now: NOW }), true);
  assert.equal(isNew(null, { now: NOW }), false);
  assert.equal(isNew(undefined), false);
});

test('a posted car is never new, whatever its date, a colleague\'s post included', () => {
  const fresh = car('A', { dateInStock: '2026-10-01T00:00:00.000Z', firstSeenAt: new Date(NOW).toISOString() });
  assert.equal(isNew(fresh, { now: NOW }), true);
  assert.equal(isNew(fresh, { now: NOW, posted: { A: { name: 'x', price: 20000, postedAt: new Date(NOW).toISOString() } } }), false);
  assert.equal(isNew(fresh, { now: NOW, posted: { A: { name: 'x', price: 20000, postedAt: new Date(NOW).toISOString(), mine: false } } }), false, 'a colleague posted it');
  assert.equal(isNew(fresh, { now: NOW, posted: { B: {} } }), true, 'another car posted');
  assert.equal(isNew(fresh, { now: NOW, posted: null }), true);
  // newCars: the new ones, newest first
  const lot = [
    car('OLD', { dateInStock: '2026-09-01T00:00:00.000Z' }),
    car('NEW1', { dateInStock: '2026-09-29T00:00:00.000Z' }),
    car('NEW2', { dateInStock: '2026-09-30T00:00:00.000Z' }),
    car('POSTED', { dateInStock: '2026-10-01T00:00:00.000Z' }),
    car('SEEN', { firstSeenAt: new Date(NOW - 2 * DAY_MS).toISOString() }),
    car('NONE'),
  ];
  assert.deepEqual(newCars(lot, { now: NOW, posted: { POSTED: {} } }).map((e) => e.vin), ['NEW2', 'SEEN', 'NEW1']);
  assert.deepEqual(newCars(lot, { now: NOW, days: 1 }).map((e) => e.vin), ['POSTED', 'NEW2']);
  assert.deepEqual(newCars(null), []);
});

test("the date in the person's locale, short: the website's calendar date as written, the year only when it is not this year", () => {
  assert.equal(shortDate(Date.parse(SITE_DATE), { now: NOW, locale: 'en-US', dateOnly: true }), 'Sep 28');
  assert.equal(shortDate(Date.parse('2025-12-31T00:00:00.000Z'), { now: NOW, locale: 'en-US', dateOnly: true }), 'Dec 31, 2025');
  assert.match(shortDate(Date.parse(SITE_DATE), { now: NOW, locale: 'en-GB', dateOnly: true }), /^28 Sept?$/, 'the locale decides the form (the month\'s short name changed between ICU versions)');
  // a moment is shown in the person's own time zone: noon local on a given day is that day anywhere
  const noonLocal = new Date(2026, 8, 29, 12, 0, 0).getTime();
  assert.equal(shortDate(noonLocal, { now: NOW, locale: 'en-US' }), 'Sep 29');
});

test('the line under a car names where its date came from, and counts days on the lot only from the website', () => {
  const at = { now: NOW, locale: 'en-US' };
  assert.equal(dateLine(car('A', { dateInStock: SITE_DATE }), at), 'on the website since Sep 28 · 3 days on the lot');
  assert.equal(dateLine(car('A', { dateInStock: '2026-09-30T00:00:00.000Z' }), at), 'on the website since Sep 30 · 1 day on the lot');
  assert.equal(dateLine(car('A', { dateInStock: '2026-10-01T00:00:00.000Z' }), at), 'on the website since Oct 1 · under a day on the lot');
  assert.equal(dateLine(car('A', { dateInStock: '2025-11-20T00:00:00.000Z' }), at), 'on the website since Nov 20, 2025 · 315 days on the lot');
  assert.equal(dateLine(car('A', { dateInStock: SITE_DATE, firstSeenAt: SEEN }), at), 'on the website since Sep 28 · 3 days on the lot', 'the website first');
  const seen = new Date(2026, 8, 29, 15, 30).toISOString();
  assert.equal(dateLine(car('A', { firstSeenAt: seen }), at), 'Lot Sync first saw it Sep 29');
  assert.doesNotMatch(dateLine(car('A', { firstSeenAt: seen }), at), /on the lot/, 'a first sighting never counts days on the lot');
  assert.equal(dateLine(car('A', { dateInStock: 'garbage', firstSeenAt: seen }), at), 'Lot Sync first saw it Sep 29');
  assert.equal(dateLine(car('A', { firstSeenAt: null }), at), 'no date on the website, and Lot Sync did not see it arrive');
  assert.equal(dateLine(car('A'), at), 'no date on the website, and Lot Sync did not see it arrive');
  assert.equal(dateLine(null, at), '');
  assert.equal(dateLine(undefined), '');
});

test('the search box: every typed word must match the stock number, the end of the VIN or a word of the name', () => {
  const f150 = { vin: '1FTSAMPL9LE000001', stock: 'EM1001', name: '2020 Ford F-150 XLT' };
  const ok = (text) => assert.equal(filterText(f150, text), true, `"${text}" matches`);
  const no = (text) => assert.equal(filterText(f150, text), false, `"${text}" does not match`);
  ok('');
  ok('   ');
  ok(undefined);
  ok(null);
  // the name's words, from their start, any case
  ok('ford');
  ok('FORD');
  ok('for');
  ok('f-150');
  ok('f150');
  ok('F150');
  ok('2020');
  ok('20');
  ok('xlt');
  ok('ford xlt');
  ok('  2020   ford ');
  no('ord', 'the middle of a word is not a word');
  no('150');
  no('toyota');
  no('ford toyota');
  no('2019');
  // the stock number, whole or in part
  ok('EM1001');
  ok('em1001');
  ok('1001');
  ok('em-1001');
  no('EM1002');
  // the VIN: its last six characters or more
  ok('000001');
  ok('LE000001');
  ok('le000001');
  ok('1FTSAMPL9LE000001');
  ok('1ftsampl9le000001');
  no('00001', 'five characters are not enough');
  no('1FTSAM', 'the start of the VIN is not the end');
  no('000002');
  // several words, each must match something
  ok('ford 000001');
  ok('EM1001 2020 f150');
  no('ford 000002');
  // thin entries
  assert.equal(filterText({ vin: 'X', name: '' }, 'x'), false, 'no stock, a one-letter VIN, no name');
  assert.equal(filterText({ vin: 'X', name: '' }, ''), true);
  assert.equal(filterText(null, 'ford'), false);
  assert.equal(filterText(null, ''), true);
  assert.equal(filterText({ name: '2019 Honda Civic' }, 'civic'), true, 'no stock, no VIN');
});

test('newest on the lot: later dates first, by the website\'s date or the sighting, the undated after them, then by name and VIN', () => {
  const lot = [
    car('B', { name: 'B car', dateInStock: '2026-09-20T00:00:00.000Z' }),
    car('A', { name: 'A car', dateInStock: '2026-09-20T00:00:00.000Z' }),
    car('N2', { name: 'N car' }),
    car('S', { name: 'S car', firstSeenAt: '2026-09-25T10:00:00.000Z' }),
    car('N1', { name: 'N car' }),
    car('C', { name: 'C car', dateInStock: '2026-09-30T00:00:00.000Z' }),
    car('O', { name: 'O car', dateInStock: '2026-09-01T00:00:00.000Z', firstSeenAt: '2026-09-29T10:00:00.000Z' }),
  ];
  assert.deepEqual(sortEntries(lot, 'newest').map((e) => e.vin), ['C', 'S', 'A', 'B', 'O', 'N1', 'N2']);
  assert.deepEqual(sortEntries(lot, 'newest').map((e) => e.vin), sortEntries(lot).map((e) => e.vin), 'the default order');
  assert.deepEqual(lot.map((e) => e.vin), ['B', 'A', 'N2', 'S', 'N1', 'C', 'O'], 'the input is not changed');
  assert.deepEqual(sortEntries([], 'newest'), []);
  assert.deepEqual(sortEntries(null, 'newest'), []);
});

test('longest on the lot: earlier dates first, the undated still after the dated, then by name', () => {
  const lot = [
    car('B', { name: 'B car', dateInStock: '2026-09-20T00:00:00.000Z' }),
    car('N', { name: 'N car' }),
    car('A', { name: 'A car', dateInStock: '2026-09-20T00:00:00.000Z' }),
    car('S', { name: 'S car', firstSeenAt: '2026-09-25T10:00:00.000Z' }),
    car('C', { name: 'C car', dateInStock: '2026-09-30T00:00:00.000Z' }),
    car('O', { name: 'O car', dateInStock: '2026-09-01T00:00:00.000Z' }),
    car('M', { name: 'M car', firstSeenAt: null }),
  ];
  assert.deepEqual(sortEntries(lot, 'longest').map((e) => e.vin), ['O', 'A', 'B', 'S', 'C', 'M', 'N']);
  // the two date orders are each other's reverse over the dated cars, and agree on the undated tail
  const newest = sortEntries(lot, 'newest').map((e) => e.vin);
  assert.deepEqual(newest.slice(0, 5).reverse().map((v) => (v === 'A' || v === 'B' ? 'AB' : v)), ['O', 'AB', 'AB', 'S', 'C']);
  assert.deepEqual(newest.slice(5), ['M', 'N']);
});

test("price, low to high, on the dealer's price basis: ties by name, a car with no price last", () => {
  const lot = [
    car('P2', { name: 'Z car', price: 20000 }),
    car('NONE', { name: 'A car', price: null }),
    car('P1', { name: 'Y car', price: 10000 }),
    car('P2B', { name: 'B car', price: 20000 }),
    car('ZERO', { name: 'C car', price: 0 }),
    car('LOW', { name: 'L car', price: 30000, priceBeforeFees: 9000 }),
  ];
  assert.deepEqual(sortEntries(lot, 'price').map((e) => e.vin), ['P1', 'P2B', 'P2', 'LOW', 'NONE', 'ZERO'], "the website's main price");
  assert.deepEqual(sortEntries(lot, 'price', { basis: 'beforeFees' }).map((e) => e.vin), ['LOW', 'P1', 'P2B', 'P2', 'NONE', 'ZERO'], 'the lower second price, where a car shows one');
  assert.ok(compareEntries('price')(lot[1], lot[4]) < 0, 'two unpriced cars: by name');
});

test('by name, then by VIN, so two cars with one name keep one order', () => {
  const lot = [car('2', { name: 'Same' }), car('B', { name: 'b car' }), car('1', { name: 'Same' }), car('A', { name: 'A car' }), car('X', { name: '' })];
  assert.deepEqual(sortEntries(lot, 'name').map((e) => e.vin), ['X', 'A', 'B', '1', '2']);
  assert.deepEqual(sortEntries(lot, 'nonsense').map((e) => e.vin), sortEntries(lot, 'newest').map((e) => e.vin), 'an unknown order is the default');
  // the comparators are stable under a shuffle of equal cars
  const twins = [car('T2', { name: 'Twin' }), car('T1', { name: 'Twin' })];
  for (const order of ['newest', 'longest', 'price', 'name']) assert.deepEqual(sortEntries(twins, order).map((e) => e.vin), ['T1', 'T2'], order);
});

test("a website's calendar date reads the same in every spelling of midnight UTC and as month/day/year; a value that names no real day is no date", () => {
  const at = Date.UTC(2026, 8, 20);
  const forms = ['2026-09-20', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00Z', '2026-09-20T00:00Z', '2026-09-20T00:00:00.0Z', '2026-09-20T00:00:00+00:00', '2026-09-20T00:00:00.000+00:00', '2026-09-20T00:00:00-00:00', '2026-09-20T00:00:00+0000', '09/20/2026', '9/20/2026', ' 2026-09-20 '];
  for (const v of forms) {
    assert.deepEqual(lotDate(car('A', { dateInStock: v })), { at, dateOnly: true, source: 'website' }, v);
    assert.equal(dateLine(car('A', { dateInStock: v }), { now: NOW, locale: 'en-US' }), 'on the website since Sep 20 · 11 days on the lot', v);
    assert.equal(isNew(car('A', { dateInStock: v }), { now: NOW, days: 11 }), true, `${v} is within an 11-day window`);
    assert.equal(isNew(car('A', { dateInStock: v }), { now: NOW, days: 10 }), false, `${v} is outside a 10-day window`);
  }
  // a time of day, or an offset that is not UTC, is a moment, shown in the person's own time zone
  assert.deepEqual(lotDate(car('A', { dateInStock: '2026-09-20T10:00:00Z' })), { at: Date.parse('2026-09-20T10:00:00Z'), dateOnly: false, source: 'website' });
  assert.deepEqual(lotDate(car('A', { dateInStock: '2026-09-20T00:00:00+02:00' })), { at: Date.parse('2026-09-20T00:00:00+02:00'), dateOnly: false, source: 'website' });
  // no real day: no date, never a guess at what was meant (24/09 read as month/day, a 30 February, a 13th month, a month 0)
  for (const v of ['24/09/2026', '02/30/2026', '13/01/2026', '0/10/2026', '2026-02-30', '2026-13-01', '2026-09-20T00:00:00+01:00 x']) {
    assert.equal(lotDate(car('A', { dateInStock: v })), null, `${v} is no date`);
    assert.equal(lotDate(car('A', { dateInStock: v, firstSeenAt: SEEN })).source, 'lotSync', `${v}: the sighting stands in`);
  }
});

test("the two date orders agree with the lines shown in every time zone: the website's Sep 30 is newer than a sighting on the evening of Sep 29", () => {
  const was = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland']) {
      process.env.TZ = tz; // Node reads a change of TZ on the next date it makes
      const site30 = car('A', { name: 'A car', dateInStock: '2026-09-30T00:00:00.000Z' }); // shown "on the website since Sep 30"
      const eve29 = car('B', { name: 'B car', firstSeenAt: new Date(2026, 8, 29, 22, 0).toISOString() }); // "Lot Sync first saw it Sep 29"
      const site29 = car('D', { name: 'D car', dateInStock: '2026-09-29' });
      const early30 = car('C', { name: 'C car', firstSeenAt: new Date(2026, 8, 30, 0, 30).toISOString() }); // half past midnight on the 30th
      assert.deepEqual(sortEntries([eve29, site30, site29], 'newest').map((e) => e.vin), ['A', 'B', 'D'], `${tz}: newest`);
      assert.deepEqual(sortEntries([eve29, site30, site29], 'longest').map((e) => e.vin), ['D', 'B', 'A'], `${tz}: longest`);
      assert.deepEqual(sortEntries([site30, early30, eve29], 'newest').map((e) => e.vin), ['C', 'A', 'B'], `${tz}: a sighting on the 30th sorts with the 30th`);
      // what the pill and the count say is unchanged by the zone: counted in the person's day
      const noon1 = new Date(2026, 9, 1, 12, 0).getTime();
      assert.equal(ageDays(site30, noon1), 1, tz);
      assert.equal(ageDays(site29, noon1), 2, tz);
      assert.equal(shortDate(Date.parse('2026-09-30T00:00:00.000Z'), { now: noon1, locale: 'en-US', dateOnly: true }), 'Sep 30', tz);
    }
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});
