import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults, defaultSettings, feeGap, suggestedPriceNote, profileFrom, settingsFromProfile, showsLowerPrice, chooseBasis, loadProfile, saveProfile, PROFILE_KEY, SETTINGS_VERSION, DEFAULT_SALESPERSON_TITLE } from '../extension/src/settings.js';
import { vehicle, WAYNESBURG } from './helpers.js';

test('v0.1 settings ({ myStores, basis }) keep working and gain defaults', () => {
  const s = withDefaults({ myStores: [WAYNESBURG], basis: 'beforeFees' }, { name: 'Ron Lewis CDJR Waynesburg' });
  assert.equal(s.version, SETTINGS_VERSION);
  assert.deepEqual(s.myStores, [WAYNESBURG]);
  assert.equal(s.basis, 'beforeFees');
  assert.deepEqual(s.salesperson, { name: '', title: 'sales consultant' });
  assert.deepEqual(s.dealer, { name: 'Ron Lewis CDJR Waynesburg', city: 'Waynesburg', state: '', zip: '' });
  assert.equal(s.priceNote, '');
  assert.equal(s.dailyCap, 10);
  assert.deepEqual(s.rewrite, { enabled: false, endpoint: '', key: '' });
  assert.deepEqual(s.defaults, { titleStatus: 'Clean', condition: 'Very good' });
  // "leave blank" is kept; nonsense falls back
  assert.deepEqual(withDefaults({ defaults: { titleStatus: '', condition: 'Excellent' } }).defaults, { titleStatus: '', condition: 'Excellent' });
  assert.deepEqual(withDefaults({ defaults: { titleStatus: 'Spotless', condition: 42 } }).defaults, { titleStatus: 'Clean', condition: 'Very good' });
});

test("the website's own address fills blank city, state and ZIP but never overrides what was typed", () => {
  const site = { name: WAYNESBURG, address: { street: '1 Example Way', city: 'Waynesburg', state: 'PA', zip: '15370', source: 'structured data' } };
  const fresh = withDefaults({ myStores: [WAYNESBURG] }, site);
  assert.deepEqual(fresh.dealer, { name: WAYNESBURG, city: 'Waynesburg', state: 'PA', zip: '15370' });
  const typed = withDefaults({ dealer: { name: 'Ron Lewis CDJR', city: 'Waynesburg', state: 'PA', zip: '15370' } }, { name: 'x', address: { city: 'Elsewhere', state: 'OH', zip: '43000' } });
  assert.deepEqual(typed.dealer, { name: 'Ron Lewis CDJR', city: 'Waynesburg', state: 'PA', zip: '15370' });
  const partial = withDefaults({ dealer: { city: 'Waynesburg' } }, site);
  assert.deepEqual(partial.dealer, { name: WAYNESBURG, city: 'Waynesburg', state: 'PA', zip: '15370' });
  assert.equal(defaultSettings(site, []).dealer.zip, '15370');
});

test('bad input becomes safe defaults', () => {
  const s = withDefaults(null);
  assert.equal(s.basis, 'website');
  assert.deepEqual(s.myStores, []);
  assert.equal(withDefaults({ dailyCap: -3 }).dailyCap, 10);
  assert.equal(withDefaults({ dailyCap: 4.7 }).dailyCap, 4);
});

test('the fee gap is what most priced cars agree on, and it becomes the suggested price note', () => {
  const lot = [vehicle('usedNormal'), vehicle('certified'), vehicle('usedNoCarfax'), vehicle('usedNoPrice')];
  const fee = feeGap(lot);
  assert.equal(fee.gap, 490);
  assert.equal(fee.total, 3);
  assert.equal(fee.example.vin, lot[0].vin);
  assert.equal(suggestedPriceNote(490), 'Price includes the $490 doc fee; tax and tags extra.');
  assert.equal(suggestedPriceNote(490, 'beforeFees'), 'Price is before the $490 doc fee; tax and tags extra.');
  assert.equal(suggestedPriceNote(0), '');
  // no agreement: no gap
  assert.equal(feeGap([vehicle('usedNormal'), vehicle('certified', { pricing: { internet_price: 30000 } }), vehicle('usedNoCarfax', { pricing: { internet_price: 40000 } })]).gap, 0);
});

test('the synced profile carries the person and dealer details but never the service key', async () => {
  const s = withDefaults({ myStores: [WAYNESBURG], salesperson: { name: 'Roger', title: 'sales consultant' }, dealer: { name: WAYNESBURG, city: 'Waynesburg', state: 'PA', zip: '15370' }, priceNote: 'Tax and tags extra.', dailyCap: 8, rewrite: { enabled: true, endpoint: 'http://localhost:8787', key: 'secret' } });
  const HOME = 'https://www.example-dealer.test';
  const p = profileFrom(s, HOME);
  assert.equal(p.origin, HOME, 'the profile remembers the website it was saved on');
  assert.equal(p.salesperson.name, 'Roger');
  assert.equal(p.dealer.zip, '15370');
  assert.equal(p.dailyCap, 8);
  assert.deepEqual(p.rewrite, { enabled: true, endpoint: 'http://localhost:8787' });
  assert.ok(!JSON.stringify(p).includes('secret'));

  // a fake chrome.storage.sync
  const store = {};
  const fake = { get: async (k) => ({ [k]: store[k] }), set: async (obj) => Object.assign(store, obj) };
  assert.equal(await saveProfile(s, fake, HOME), true);
  assert.equal((await loadProfile(fake)).salesperson.name, 'Roger');
  assert.equal((await loadProfile(fake)).origin, HOME);
  assert.ok(PROFILE_KEY in store);
  assert.equal(await loadProfile({ get: async () => { throw new Error('no sync'); } }), null);

  // the same website: everything carries over, even if the person edited the dealership name
  const same = settingsFromProfile({ ...p, dealer: { ...p.dealer, name: 'Ron Lewis CDJR' } }, { origin: HOME, name: WAYNESBURG });
  assert.deepEqual(same.myStores, [WAYNESBURG]);
  assert.equal(same.dealer.name, 'Ron Lewis CDJR');
  assert.equal(same.rewrite.key, '');
  assert.equal(same.salesperson.name, 'Roger');
  assert.equal(same.priceNote, 'Tax and tags extra.');
  // another website: only the person's own fields do; the dealership's are that website's
  const other = settingsFromProfile(p, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer', address: { city: 'Elsewhere', state: 'OH', zip: '43000' } });
  assert.deepEqual(other.myStores, []);
  assert.deepEqual(other.dealer, { name: 'Some Other Dealer', city: 'Elsewhere', state: 'OH', zip: '43000' });
  assert.equal(other.priceNote, '');
  assert.equal(other.basis, 'website');
  assert.equal(other.dailyCap, 10);
  assert.equal(other.salesperson.name, 'Roger');
  assert.deepEqual(other.defaults, { titleStatus: 'Clean', condition: 'Very good' });
  assert.equal(other.rewrite.endpoint, 'http://localhost:8787');
  // no origin to compare (a profile saved before 0.4.0, or a site without one): keep the profile, as before
  assert.equal(settingsFromProfile(p, {}).dealer.name, WAYNESBURG);
  assert.equal(settingsFromProfile({ ...p, origin: '' }, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' }).priceNote, 'Tax and tags extra.');
  assert.equal(settingsFromProfile(null), null);
  assert.equal(DEFAULT_SALESPERSON_TITLE, 'sales consultant');
});

test('the lower second price is a basis only on a website that shows one; without a scan the previous choice stands', () => {
  const lot = [vehicle('usedNormal'), vehicle('certified')]; // both show a lower second price
  assert.equal(showsLowerPrice(lot), true);
  assert.equal(showsLowerPrice([{ price: 20000 }, { price: 21000, priceBeforeFees: 22000 }]), false, 'a higher second number is not a lower price');
  assert.equal(showsLowerPrice([]), false);
  assert.equal(chooseBasis('beforeFees', 'website', lot), 'beforeFees');
  assert.equal(chooseBasis('beforeFees', 'website', [{ price: 20000 }]), 'website', 'not offered: coerced');
  assert.equal(chooseBasis('website', 'beforeFees', lot), 'website');
  assert.equal(chooseBasis('website', 'beforeFees', null), 'beforeFees', 'no scan yet: a Save must not flip a synced choice');
  assert.equal(chooseBasis('beforeFees', 'website', null), 'website');
});

test('first-run defaults: the store matching the site name; the price note is only suggested, never filled in', () => {
  const site = { name: WAYNESBURG, title: 'Used Vehicles | ' + WAYNESBURG };
  const lot = [vehicle('usedNormal'), vehicle('certified')];
  const s = defaultSettings(site, lot);
  assert.deepEqual(s.myStores, [WAYNESBURG]);
  assert.equal(s.dealer.name, WAYNESBURG);
  assert.equal(s.dealer.city, 'Waynesburg');
  assert.equal(s.priceNote, '', 'a person decides what the price gap means');
  assert.match(suggestedPriceNote(feeGap(lot).gap, s.basis), /\$490 doc fee/);
});
