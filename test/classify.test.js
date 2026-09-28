import { test } from 'node:test';
import assert from 'node:assert/strict';
import { websitePrice, conditionWordFromUrl, normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { assessVehicle, readCondition, titleConditionWords, DECISION } from '../extension/src/classify.js';
import { fixtures, vehicle, raw, MY_STORE } from './helpers.js';

const assess = (name, patch, settings = MY_STORE) => assessVehicle(vehicle(name, patch), settings);

// ---------- reading the website's data ----------

test('main website price is the "Ron Lewis Real Price" shown on the site', () => {
  assert.deepEqual(websitePrice(fixtures.usedNormal), { value: 27163, label: 'Ron Lewis Real Price' });
  assert.equal(vehicle('usedNormal').priceBeforeFees, 26673);
});

test('"Please call for price" means no price, even if a number is buried elsewhere', () => {
  assert.equal(websitePrice(fixtures.usedNoPrice).value, null);
  // record has pricing.price 33295 but the site shows "Please call for price"
  assert.equal(websitePrice(fixtures.newHighMiles).value, null);
  assert.equal(websitePrice(fixtures.newHighMiles).label, 'Please call for price');
});

test('falls back to the pricing block when the display pricing is absent', () => {
  const r = raw('usedNormal');
  delete r.extra_fields.lightning.pricing;
  assert.equal(websitePrice(r).value, 27163);
});

test('reads the condition word from the vehicle page address', () => {
  assert.equal(conditionWordFromUrl(fixtures.usedNormal.vdp_url), 'used');
  assert.equal(conditionWordFromUrl(fixtures.certified.vdp_url), 'certified used');
  assert.equal(conditionWordFromUrl(fixtures.newNormal.vdp_url), 'new');
  assert.equal(conditionWordFromUrl('https://x.com/inventory/2019-ram-1500/'), null);
});

test('condition words', () => {
  assert.equal(readCondition('Used'), 'pre-owned');
  assert.equal(readCondition('Certified Used'), 'pre-owned');
  assert.equal(readCondition('Certified Pre-Owned'), 'pre-owned');
  assert.equal(readCondition('Pre Owned'), 'pre-owned');
  assert.equal(readCondition('New'), 'new');
  assert.equal(readCondition('demo'), 'demo');
  assert.equal(readCondition(''), 'unknown');
  assert.equal(titleConditionWords('Certified Pre-Owned 2022 Jeep Wagoneer Series III'), 'Certified Pre-Owned');
  assert.equal(titleConditionWords('2010 Volkswagen New Beetle'), null);
});

// ---------- the real cars from the site ----------

test('used Ram with Carfax, photos and price at Waynesburg: ready to post', () => {
  const a = assess('usedNormal');
  assert.equal(a.decision, DECISION.READY);
  assert.match(a.reason, /inventory type, web address, title and Carfax agree/);
});

test('certified used Wagoneer at Cranberry: pre-owned, but at another store', () => {
  const a = assess('certified');
  assert.equal(a.decision, DECISION.NOT_READY);
  assert.deepEqual(a.blockers.map((b) => b.code), ['other-store']);
  assert.equal(a.blockers[0].text, 'At Cranberry'); // the short name a record on its own gets (normalize.test.js has the per-lot rule)
  // with no store filter it's ready
  assert.equal(assess('certified', {}, {}).decision, DECISION.READY);
});

test('used Hellcat with NO Carfax still passes the pre-owned check', () => {
  const a = assess('usedNoCarfax', {}, {});
  // blocked only because it has no photos yet, not because of Carfax
  assert.equal(a.decision, DECISION.NOT_READY);
  assert.deepEqual(a.blockers.map((b) => b.code), ['no-photos']);
  assert.ok(a.notes.some((n) => /No Carfax report linked/.test(n)));
  // give it photos and it's ready
  assert.equal(assess('usedNoCarfax', { media: { image_count: 12 } }, {}).decision, DECISION.READY);
});

test('used Honda with 0 miles on the website: needs a look', () => {
  const a = assess('usedZeroMiles');
  assert.equal(a.decision, DECISION.REVIEW);
  assert.match(a.reason, /0 miles/);
});

test('used Ram with no photos: not ready', () => {
  const a = assess('usedNoPhotos', {}, {});
  assert.equal(a.decision, DECISION.NOT_READY);
  assert.deepEqual(a.blockers.map((b) => b.code), ['no-photos']);
});

test('used Ram with "call for price": not ready', () => {
  const a = assess('usedNoPrice');
  assert.equal(a.decision, DECISION.NOT_READY);
  assert.deepEqual(a.blockers.map((b) => b.code), ['no-photos', 'no-price']);
});

test('new Grand Cherokee: skipped', () => {
  const a = assess('newNormal');
  assert.equal(a.decision, DECISION.SKIP);
  assert.match(a.reason, /New vehicle/);
});

test('"New" Grand Cherokee L with 29,296 miles is still skipped (mileage never makes a car used)', () => {
  const a = assess('newHighMiles');
  assert.equal(a.decision, DECISION.SKIP);
});

test('new unit in transit: skipped', () => {
  assert.equal(assess('newInTransit').decision, DECISION.SKIP);
});

// ---------- made-up edge cases ----------

test('website disagrees with itself (type says used, address says new): needs a look', () => {
  const a = assess('usedNormal', { vdp_url: 'https://x.com/inventory/new-2019-ram-1500-classic-express-1c6rr7ft0ks643289/' });
  assert.equal(a.decision, DECISION.REVIEW);
  assert.match(a.reason, /disagrees/);
});

test('listed as used but flagged demo: needs a look; flagged demo and new: skipped', () => {
  assert.equal(assess('usedNormal', { is_demo: true }).decision, DECISION.REVIEW);
  assert.equal(assess('newNormal', { is_loaner: true }).decision, DECISION.SKIP);
  assert.equal(assess('usedNormal', { extra_fields: { title: 'Demo 2019 Ram 1500 Classic Express' } }).decision, DECISION.REVIEW);
});

test('new car with a Carfax link is still skipped, with a note to fix its type', () => {
  const a = assess('newNormal', { history_report: { carfax_url: 'https://www.carfax.com/vehiclehistory/ar20/x' } });
  assert.equal(a.decision, DECISION.SKIP);
  assert.ok(a.notes.some((n) => /fix its type/.test(n)));
});

test('only one sign of pre-owned: needs a look, unless Carfax backs it up', () => {
  const patch = { type: null, extra_fields: { title: null, readable_type: null, lightning: { inventoryType: null, vdp_title: null } } };
  const lonely = assess('usedNormal', { ...patch, history_report: { carfax_url: null } });
  assert.equal(lonely.decision, DECISION.REVIEW);
  assert.match(lonely.reason, /Only one sign/);
  assert.equal(assess('usedNormal', patch).decision, DECISION.READY);
});

test('nothing says new or used: needs a look', () => {
  const a = assess('usedNormal', {
    type: null,
    vdp_url: 'https://x.com/inventory/2019-ram-1500/',
    extra_fields: { title: null, readable_type: null, lightning: { inventoryType: null, vdp_title: null } },
  });
  assert.equal(a.decision, DECISION.REVIEW);
});

test('"New" in a model name is not read as a new car', () => {
  const a = assess('usedNormal', { model: 'New Beetle', extra_fields: { title: 'Pre-Owned 2019 Volkswagen New Beetle' } });
  assert.equal(a.decision, DECISION.READY);
});

test('sale pending and in-transit used cars are not ready', () => {
  assert.deepEqual(assess('usedNormal', { status: 'pend-sale' }).blockers.map((b) => b.code), ['sale-pending']);
  assert.deepEqual(
    assess('usedNormal', { in_transit: 'yes', extra_fields: { availability_rt: 'In-Transit' } }).blockers.map((b) => b.code),
    ['not-on-lot']
  );
});

test('missing VIN is ignored', () => {
  assert.equal(normalizeVehicle({ type: 'Used' }), null);
});
