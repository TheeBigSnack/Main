import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shortLocation, storeNames, matchStore, conditionFromSchemaOrg, conditionWordFromPath, toNumber } from '../extension/src/normalize.js';
import { conditionWordFromUrl, websitePrice, normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { fixtures } from './helpers.js';

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

// ---------- numbers ----------

test('toNumber reads one amount, and text with two amounts in it is no number', () => {
  for (const [text, n] of [['$24,995', 24995], ['24995', 24995], ['24,995.00', 24995], ['$ 24,995', 24995], [' 41,230 ', 41230], ['27163.5', 27163.5], ['-3', -3], ['0', 0]]) assert.equal(toNumber(text), n, text);
  assert.equal(toNumber(24995), 24995);
  // a was/now pair in one field is never run together into one number
  for (const text of ['$24,995 $25,495', '24995 25495', '$24,995$25,495', '24,995 / 25,495', '24 995', '1,2345', '12,34', '', '$', 'Call', '1e5']) assert.equal(toNumber(text), null, text);
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(null), null);
});

test('a Dealer Inspire price field with two amounts in it is no price, and the second line never stands in for it', () => {
  const display = (pricing) => ({ extra_fields: { lightning: { pricing } } });
  const two = '$24,995 $25,495';
  assert.deepEqual(websitePrice(display({ low: { label: 'Price', value: two }, high: { label: 'Was', value: '26673' } })), { value: null, label: 'the price shows more than one amount' });
  assert.deepEqual(websitePrice(display({ low: false, high: { label: 'Price', value: two } })), { value: null, label: 'the price shows more than one amount' });
  assert.deepEqual(websitePrice({ pricing: { our_price: two, price: 24995 } }), { value: null, label: 'the price shows more than one amount' }, 'the hidden fields never stand in either');
  assert.deepEqual(websitePrice({ pricing: { our_price: '$24,995', price: 23995 } }), { value: 24995, label: 'Price' });
  // and a car with such a price is not ready to post: it goes to To do with the reason
  const raw = structuredClone(fixtures.usedNormal);
  raw.extra_fields.lightning.pricing.low.value = two;
  const v = normalizeVehicle(raw);
  assert.equal(v.price, null);
  assert.equal(v.priceBeforeFees, null);
  assert.equal(v.priceLabel, 'the price shows more than one amount');
});

// ---------- pre-owned signs any website can carry ----------

test('conditionFromSchemaOrg: the four schema.org condition values, however they are written', () => {
  const cases = {
    'https://schema.org/UsedCondition': 'used',
    'http://schema.org/UsedCondition': 'used',
    'https://www.schema.org/UsedCondition/': 'used',
    'schema:UsedCondition': 'used',
    UsedCondition: 'used',
    ' usedcondition ': 'used',
    'https://schema.org/NewCondition': 'new',
    NewCondition: 'new',
    'https://schema.org/DamagedCondition': 'damaged',
    RefurbishedCondition: 'refurbished',
  };
  for (const [value, says] of Object.entries(cases)) assert.equal(conditionFromSchemaOrg(value), says, value);
  assert.equal(conditionFromSchemaOrg({ '@id': 'https://schema.org/UsedCondition' }), 'used', 'a JSON-LD reference');
  assert.equal(conditionFromSchemaOrg(['', 'https://schema.org/NewCondition']), 'new', 'the first value that is one');
  // the website's own words are not schema.org values (classify.js reads those)
  for (const value of ['Used', 'New', 'Certified Pre-Owned', 'https://example.test/UsedCondition', 'https://schema.org/InStock', 'UsedConditions', 'schema.org/Used', '', null, undefined, 7, {}, []]) {
    assert.equal(conditionFromSchemaOrg(value), null, String(value));
  }
});

test('conditionWordFromPath: a condition word before the model year, or a segment of its own; never after the year', () => {
  const cases = {
    'https://x.test/inventory/used-2019-ram-1500-classic-express-4wd/': 'used',
    '/inventory/certified-used-2022-jeep-wagoneer-series-iii/': 'certified used',
    '/certified-pre-owned-2022-jeep-wagoneer/': 'certified pre-owned',
    '/preowned-2020-ford-f-150/': 'preowned',
    '/inventory/new-2027-jeep-grand-cherokee-limited/': 'new',
    '/used-2012-volkswagen-new-beetle-3vwsampl/': 'used', // "New Beetle" is a model
    '/inventory/2010-volkswagen-new-beetle/': null,
    '/2019/new/ram-1500/': null, // after the year: never read
    '/used/ram/1500/1c6sampl8hs000106/': 'used', // a segment of its own, no year at all
    '/used/Ram/2019-Ram-1500-Classic-abc.htm': 'used',
    '/used-vehicles/2019-ram-1500/': 'used',
    '/Used%20Cars/2019-Ram-1500/': 'used',
    '/new-inventory/2027-kia-telluride/': 'new',
    '/new-arrivals/2019-ram-1500/': null, // a page of arrivals lists used cars too
    '/inventory/used-cars-near-springfield/2019-ram-1500/': null, // more than a condition in that segment
    '/cpo/2021-toyota-rav4/': 'cpo',
    '/demo-2024-jeep-compass/': 'demo',
    '/loaner/2024-jeep-compass/': 'loaner',
    '/used/new-2027-jeep-compass/': 'new', // the year's own segment speaks first
    '/used-Springfield-2019-Ram-1500-1C6SAMPL8HS000106': 'used',
    '/USED-2019-RAM-1500/': 'used',
    '/vehicle/2019-ram-1500?condition=used': null, // the query is not the path
    '/vehicle/ram-1500#used': null, // an in-page fragment is not a route
    'http://sandbox.test/demo/site/index.html#/inventory/used-2020-ford-f-150-xlt/': 'used', // a single-page route is
    '/inventory/': null,
    '/': null,
  };
  for (const [url, word] of Object.entries(cases)) assert.equal(conditionWordFromPath(url), word, url);
  for (const junk of ['', '   ', null, undefined, 42, {}, 'http://[not a host']) assert.equal(conditionWordFromPath(junk), null, String(junk));
  assert.equal(conditionWordFromPath('/inventory/used-2019-%E0%A4%A-ram/'), 'used', 'a stray % in the address is read as it is');
});

test('conditionWordFromPath reads every Dealer Inspire address in the fixtures and the sandbox exactly as that adapter does', () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(new URL('../demo/site/inventory.js', import.meta.url), 'utf8'), ctx);
  const sandbox = ['day1', 'day2'].flatMap((day) => ctx.window.LOT_SYNC_INVENTORY.records(day, 'http://sandbox.test/demo/site/'));
  const urls = [...Object.values(fixtures).filter((r) => r && r.vdp_url), ...sandbox].map((r) => r.vdp_url);
  assert.ok(urls.length >= 25);
  for (const url of urls) assert.equal(conditionWordFromPath(url), conditionWordFromUrl(url), url);
});
