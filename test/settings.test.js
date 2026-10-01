import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults, defaultSettings, feeGap, suggestedPriceNote, priceStepModel, profileFrom, settingsFromProfile, showsLowerPrice, chooseBasis, loadProfile, saveProfile, PROFILE_KEY, SETTINGS_VERSION, DEFAULT_SALESPERSON_TITLE } from '../extension/src/settings.js';
import { LEGAL, acceptLegal, legalIsCurrent, legalHosted, isPlaceholderUrl } from '../extension/src/legalLinks.js';
import { vehicle, WAYNESBURG } from './helpers.js';

test('v0.1 settings ({ myStores, basis }) keep working and gain defaults', () => {
  const s = withDefaults({ myStores: [WAYNESBURG], basis: 'beforeFees' }, { name: 'Ron Lewis CDJR Waynesburg' });
  assert.equal(s.version, SETTINGS_VERSION);
  assert.deepEqual(s.myStores, [WAYNESBURG]);
  assert.equal(s.basis, 'beforeFees');
  assert.deepEqual(s.salesperson, { name: '', title: 'sales consultant', closingLine: '' });
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
  // no origin to compare (a site without one): keep the profile, as before
  assert.equal(settingsFromProfile(p, {}).dealer.name, WAYNESBURG);
  // a profile saved before 0.4.0 has no origin key at all: kept whole, as before
  const legacy = { ...p };
  delete legacy.origin;
  assert.equal(settingsFromProfile(legacy, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' }).priceNote, 'Tax and tags extra.');
  // a profile saved with no website (from a Facebook tab, before the popup
  // refused that) names no dealership: only the person's own fields carry
  const nowhere = settingsFromProfile({ ...p, origin: '' }, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' });
  assert.deepEqual(nowhere.dealer, { name: 'Some Other Dealer', city: '', state: '', zip: '' });
  assert.deepEqual([nowhere.priceNote, nowhere.dailyCap, nowhere.basis, nowhere.myStores], ['', 10, 'website', []]);
  assert.equal(nowhere.salesperson.name, 'Roger', 'the person\'s own fields still carry');
  // and no profile is written without the website it belongs to
  const before = JSON.stringify(store);
  assert.equal(await saveProfile(s, fake, ''), false);
  assert.equal(await saveProfile(s, fake), false);
  assert.equal(JSON.stringify(store), before, 'nothing was written');
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

test("the wizard's Price step model: the lower price only on a website that shows one, the gap's wording, and the example's prices only", () => {
  const lot = [vehicle('usedNormal'), vehicle('certified'), vehicle('usedNoCarfax'), vehicle('usedNoPrice')];
  const m = priceStepModel(lot);
  assert.equal(m.showsLower, true);
  assert.equal(m.gap, 490);
  assert.equal(m.suggested, 'Price includes the $490 doc fee; tax and tags extra.');
  assert.deepEqual(m.example, { price: lot[0].price, priceBeforeFees: lot[0].priceBeforeFees, priceLabel: lot[0].priceLabel }, 'three prices, not the whole car: the model sits in the wizard\'s saved state');
  assert.equal(priceStepModel(lot, 'beforeFees').suggested, 'Price is before the $490 doc fee; tax and tags extra.');
  // a website with one price per car: nothing to choose, nothing to suggest
  const plain = priceStepModel([{ price: 20000 }, { price: 21000, priceBeforeFees: 22000 }]);
  assert.deepEqual(plain, { showsLower: false, gap: 0, example: null, suggested: '' });
  assert.deepEqual(priceStepModel([]), { showsLower: false, gap: 0, example: null, suggested: '' });
  assert.deepEqual(priceStepModel(null), { showsLower: false, gap: 0, example: null, suggested: '' });
  // the basis is chosen through chooseBasis, from the model as from the entries: a radio value the site cannot support never lands in settings
  assert.equal(chooseBasis('beforeFees', 'website', m), 'beforeFees');
  assert.equal(chooseBasis('beforeFees', 'beforeFees', plain), 'website', 'not shown here: coerced, even against the previous choice');
  assert.equal(chooseBasis('website', 'beforeFees', m), 'website');
  assert.equal(chooseBasis('beforeFees', 'website', null), 'website', 'no read yet: the previous choice stands');
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

test('the Terms and Privacy acceptance: blank by default, garbage becomes blank, and it follows the person to any website', () => {
  const blank = { version: '', acceptedAt: '' };
  assert.deepEqual(withDefaults({}).legal, blank);
  assert.deepEqual(withDefaults({ legal: 'yes' }).legal, blank);
  assert.deepEqual(withDefaults({ legal: 42 }).legal, blank);
  assert.deepEqual(withDefaults({ legal: { version: 42, acceptedAt: null } }).legal, blank);
  assert.deepEqual(withDefaults({ legal: { version: LEGAL.version, acceptedAt: ['x'] } }).legal, { version: LEGAL.version, acceptedAt: '' });
  assert.equal(legalIsCurrent(blank), false);
  // the placeholders and the edition
  assert.ok(Object.isFrozen(LEGAL));
  assert.match(LEGAL.version, /^\d{4}-\d{2}-\d{2}/);
  for (const k of ['termsUrl', 'privacyUrl', 'rulesUrl']) assert.match(LEGAL[k], /^https:\/\//, `${k} is an https address`);
  // what the wizard's Terms step and the Settings tick record
  const accepted = acceptLegal('2026-09-28T12:00:00.000Z');
  assert.deepEqual(accepted, { version: LEGAL.version, acceptedAt: '2026-09-28T12:00:00.000Z' });
  assert.match(acceptLegal().acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(legalIsCurrent(accepted), true);
  assert.equal(legalIsCurrent({ version: 'older', acceptedAt: '2026-01-01T00:00:00.000Z' }), false, 'an older edition re-asks');
  // the round trip through the synced profile: it is the person's, so it carries over to another dealership's website too
  const s = withDefaults({ salesperson: { name: 'Roger' }, legal: accepted });
  assert.deepEqual(s.legal, accepted);
  const HOME = 'https://www.example-dealer.test';
  const p = profileFrom(s, HOME);
  assert.deepEqual(p.legal, accepted);
  assert.deepEqual(settingsFromProfile(p, { origin: HOME, name: 'Home Dealer' }).legal, accepted);
  assert.deepEqual(settingsFromProfile(p, { origin: 'https://www.some-other-dealer.test', name: 'Some Other Dealer' }).legal, accepted);
  // a profile saved before the Terms step existed
  const { legal, ...older } = p;
  assert.deepEqual(settingsFromProfile(older, { origin: HOME }).legal, blank);
});

test('a placeholder legal address is one nobody can read; the Terms step gates only once both documents are hosted', () => {
  // the predicate, against sample addresses (the live constant changes when the site is up)
  for (const url of ['https://lotsync.example/terms', 'https://www.lotsync.example/privacy/', 'https://LOTSYNC.EXAMPLE', 'https://example', '', null, 'not a url', 'http://lotsync.com/terms', 'ftp://lotsync.com/terms']) {
    assert.equal(isPlaceholderUrl(url), true, `${url} is a placeholder`);
  }
  for (const url of ['https://lotsync.com/terms', 'https://www.lot-sync.co/privacy', 'https://example.com/terms', 'https://myexample.net/terms']) {
    assert.equal(isPlaceholderUrl(url), false, `${url} could be hosted`);
  }
  // legalHosted is that predicate over the live addresses, whatever they are today
  assert.equal(legalHosted(), !isPlaceholderUrl(LEGAL.termsUrl) && !isPlaceholderUrl(LEGAL.privacyUrl));
});

test("the Ready list's order and the new-arrival window are this website's settings: defaults, limits, and never in the synced profile", () => {
  const s = withDefaults({});
  assert.equal(s.readySort, 'newest');
  assert.equal(s.newDays, 7);
  assert.equal(withDefaults({ readySort: 'price' }).readySort, 'price');
  assert.equal(withDefaults({ readySort: 'longest' }).readySort, 'longest');
  assert.equal(withDefaults({ readySort: 'name' }).readySort, 'name');
  assert.equal(withDefaults({ readySort: 'sideways' }).readySort, 'newest', 'an unknown order is the default');
  assert.equal(withDefaults({ newDays: 14 }).newDays, 14);
  assert.equal(withDefaults({ newDays: '3' }).newDays, 3);
  assert.equal(withDefaults({ newDays: 0 }).newDays, 7);
  assert.equal(withDefaults({ newDays: 45 }).newDays, 30);
  assert.equal(withDefaults({ newDays: 2.9 }).newDays, 2);
  assert.equal(withDefaults({ newDays: 'soon' }).newDays, 7);
  // the profile carries neither, so neither follows the person to another website, nor comes back from the profile on this one
  const p = profileFrom(withDefaults({ readySort: 'price', newDays: 14 }), 'https://www.example-dealer.test');
  assert.ok(!('readySort' in p) && !('newDays' in p));
  const seeded = settingsFromProfile(p, { origin: 'https://www.example-dealer.test' });
  assert.equal(seeded.readySort, 'newest');
  assert.equal(seeded.newDays, 7);
});
