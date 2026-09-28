import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortLocation, storeNames, matchStore } from '../extension/src/normalize.js';

// The pilot dealer's store names, as a worked example of a group whose
// stores share the group and brand words (test/fixtures/records.json).
const CRANBERRY = 'Ron Lewis Chrysler Dodge Jeep Ram Cranberry';
const PLEASANT_HILLS = 'Ron Lewis Chrysler Dodge Jeep Ram Pleasant Hills';
const WAYNESBURG = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
const GROUP = [CRANBERRY, PLEASANT_HILLS, WAYNESBURG];

// ---------- shortLocation ----------

test('a group whose store names share a prefix: what differs per store is the short name', () => {
  assert.deepEqual(GROUP.map((l) => shortLocation(l, GROUP)), ['Cranberry', 'Pleasant Hills', 'Waynesburg']);
  // no brand words at all: the shared words are still the group part
  const plain = ['Smith Auto Sales North', 'Smith Auto Sales South'];
  assert.deepEqual(plain.map((l) => shortLocation(l, plain)), ['North', 'South']);
  // a prefix is whole words: "Smith Ford" and "Smith Fiat" share "Smith", not "Smith F"
  const close = ['Smith Ford', 'Smith Fiat'];
  assert.deepEqual(close.map((l) => shortLocation(l, close)), ['Ford', 'Fiat']);
  // punctuation and case in the shared part do not matter
  const dashed = ['Ron Lewis CDJR - Waynesburg', 'ron lewis CDJR - Cranberry'];
  assert.deepEqual(dashed.map((l) => shortLocation(l, dashed)), ['Waynesburg', 'Cranberry']);
});

test('a brand left in the store\'s own part is stripped too', () => {
  const mixed = ['Ron Lewis Ford Cranberry', WAYNESBURG];
  assert.deepEqual(mixed.map((l) => shortLocation(l, mixed)), ['Cranberry', 'Waynesburg']);
  const of = ['Smith Chevrolet of Dayton', 'Smith Ford of Troy'];
  assert.deepEqual(of.map((l) => shortLocation(l, of)), ['Dayton', 'Troy']);
});

test('a one-store website falls back to the brand list', () => {
  assert.equal(shortLocation(WAYNESBURG, [WAYNESBURG]), 'Waynesburg');
  assert.equal(shortLocation('Smith Chevrolet Buick GMC of Dayton', ['Smith Chevrolet Buick GMC of Dayton']), 'Dayton');
  // a name made of brands only, or with no brand at all, is kept whole
  assert.equal(shortLocation('Smith Chevrolet Buick GMC', ['Smith Chevrolet Buick GMC']), 'Smith Chevrolet Buick GMC');
  assert.equal(shortLocation('Smith Auto Sales', ['Smith Auto Sales']), 'Smith Auto Sales');
});

test('store names with no common prefix fall back to the brand list, one by one', () => {
  const lot = ['Smith Ford', 'Jones Chevrolet Dayton'];
  assert.deepEqual(lot.map((l) => shortLocation(l, lot)), ['Smith Ford', 'Dayton']);
});

test('the short name is never empty: a name with nothing to strip is returned whole', () => {
  assert.equal(shortLocation('Ford'), 'Ford');
  assert.equal(shortLocation('Ford', ['Ford']), 'Ford');
  // the shared prefix is the whole of one name: that store keeps its name
  const nested = ['Smith Ford', 'Smith Ford Dayton'];
  assert.deepEqual(nested.map((l) => shortLocation(l, nested)), ['Smith Ford', 'Dayton']);
  assert.equal(shortLocation('  Smith Ford  ', ['Smith Ford', 'Smith Ford']), 'Smith Ford');
  // no name at all is the one empty answer, as before
  assert.equal(shortLocation(''), '');
  assert.equal(shortLocation(null), '');
  assert.equal(shortLocation(undefined, GROUP), '');
});

test('the old one-argument call still works (a record on its own, before the lot is known)', () => {
  assert.equal(shortLocation(CRANBERRY), 'Cranberry');
  assert.equal(shortLocation(PLEASANT_HILLS), 'Pleasant Hills');
  assert.equal(shortLocation(CRANBERRY, null), 'Cranberry');
  assert.equal(shortLocation(CRANBERRY, []), 'Cranberry');
  // and the lot may leave the name itself out
  assert.equal(shortLocation('Smith Auto Sales North', ['Smith Auto Sales South']), 'North');
});

// ---------- storeNames ----------

test('storeNames: each store once, trimmed, sorted, blanks dropped', () => {
  assert.deepEqual(storeNames([{ location: 'B' }, { location: 'A' }, { location: 'B' }, { location: '' }, null, { location: ' A ' }, { location: 7 }]), ['A', 'B']);
  assert.deepEqual(storeNames([]), []);
  assert.deepEqual(storeNames(null), []);
});

// ---------- matchStore: the wizard's default tick ----------

const pilotSite = { name: WAYNESBURG, title: 'Used Vehicles for Sale Near Washington | ' + WAYNESBURG, host: 'ronlewischryslerdodgejeepramwaynesburg.com', address: { city: 'Waynesburg', state: 'PA', zip: '15370' } };

test('the store whose name is the website\'s own name is the one, and only one, to tick', () => {
  assert.equal(matchStore(pilotSite, GROUP), WAYNESBURG);
  // case and punctuation do not matter
  assert.equal(matchStore({ name: 'RON LEWIS CDJR - WAYNESBURG' }, ['Ron Lewis CDJR Waynesburg', 'Ron Lewis CDJR Cranberry']), 'Ron Lewis CDJR Waynesburg');
  // the page title carrying the store name is enough
  assert.equal(matchStore({ name: 'Used Cars', title: 'Used Cars | Ron Lewis CDJR Cranberry' }, ['Ron Lewis CDJR Waynesburg', 'Ron Lewis CDJR Cranberry']), 'Ron Lewis CDJR Cranberry');
});

test('a group website: the group prefix alone ticks nothing; the town from the structured-data address, or in the host, decides', () => {
  const group = { name: 'Ron Lewis Automotive', title: 'Used | Ron Lewis Automotive', host: 'ronlewisauto.com' };
  assert.equal(matchStore(group, GROUP), null, 'every store carries the group name, so none stands out');
  assert.equal(matchStore({ ...group, address: { city: 'Cranberry' } }, GROUP), CRANBERRY);
  assert.equal(matchStore({ name: 'Used Cars', title: 'Used Cars', host: 'ronlewispleasanthills.com' }, GROUP), PLEASANT_HILLS);
  // the website's name inside a store's name counts when only one store has it
  assert.equal(matchStore({ name: 'Waynesburg', host: 'x.test' }, GROUP), WAYNESBURG);
});

test('when nothing stands out, nothing is ticked', () => {
  assert.equal(matchStore({ name: 'Example Motors', title: 'Used Vehicles for Sale | Example Motors', host: 'example-dealer.test', address: { city: 'Springfield' } }, GROUP), null);
  // two stores fit the same rule: no guess between them
  assert.equal(matchStore({ name: 'Smith Auto Group Northeast', host: 'smithauto.com' }, ['Smith Auto North', 'Smith Auto South', 'Smith Auto East']), null);
  // a one-store website is ticked only when it matches, like any other
  assert.equal(matchStore({ name: 'Smith Auto Group', host: 'smithautogroup.com' }, ['Smith Ford of Dayton']), null);
  assert.equal(matchStore({ name: 'Smith Ford', host: 'smithford.com' }, ['Smith Ford of Dayton']), 'Smith Ford of Dayton');
  // a short part ("GMC") is too common to count as found in the host
  assert.equal(matchStore({ name: 'Used Cars', host: 'gmcountrymotors.com' }, ['Smith Buick', 'Smith GMC']), null);
  assert.equal(matchStore(null, GROUP), null);
  assert.equal(matchStore(pilotSite, []), null);
  assert.equal(matchStore({}, GROUP), null);
});
