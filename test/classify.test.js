import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { websitePrice, conditionWordFromUrl, normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { trimRecord } from '../extension/adapters/dealerInspire.js';
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

test('a demo or loaner named after the model year is never Ready: in the title, the trim or the page address', () => {
  const vin = '1C4RJFBG0RC000001';
  const used = {
    vin, year: 2024, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', inventoryType: 'Used', readableType: null, isDemo: false, isLoaner: false,
    siteTitle: 'Used 2024 Jeep Grand Cherokee Limited', url: `https://www.example-dealer.test/used/2024-jeep-grand-cherokee-limited-${vin.toLowerCase()}/`, urlConditionWord: 'used',
    carfaxUrl: 'https://www.carfax.com/x', mileage: 3120, price: 40000, photoCount: 10, availability: 'In-Stock',
  };
  const ready = assessVehicle(used, {});
  assert.equal(ready.decision, DECISION.READY, 'the plain used car is ready');
  const held = {
    'Demo after the year in the title': { siteTitle: '2024 Jeep Grand Cherokee Limited Demo' },
    'Service Loaner after the year in the title': { siteTitle: 'Used 2024 Jeep Grand Cherokee Limited Service Loaner' },
    'Demonstrator before the page title\'s dealership part': { siteTitle: 'Used 2024 Jeep Grand Cherokee Limited Demonstrator | Example Motors' },
    'Courtesy vehicle in the title': { siteTitle: 'Used 2024 Jeep Grand Cherokee Limited Courtesy Vehicle' },
    'Loaner in the trim': { trim: 'Limited Loaner' },
    'demo in the page address after the year': { url: `https://www.example-dealer.test/used/2024-jeep-grand-cherokee-limited-demo-${vin.toLowerCase()}/` },
    'loaner in a later part of the page address': { url: `https://www.example-dealer.test/used/2024-jeep-grand-cherokee/loaner/${vin.toLowerCase()}` },
    'demo in an address with no model year': { url: `https://www.example-dealer.test/vehicle/jeep-grand-cherokee-limited-demo-${vin.toLowerCase()}` },
  };
  for (const [what, patch] of Object.entries(held)) {
    const a = assessVehicle({ ...used, ...patch }, {});
    assert.equal(a.decision, DECISION.REVIEW, what);
    assert.match(a.reason, /Demos and loaners are usually sold as new/, what);
    assert.ok(a.notes.some((n) => /^The website's (title|trim|web address) says "/.test(n)), `${what}: the website's words are shown`);
  }
  assert.match(assessVehicle({ ...used, siteTitle: '2024 Jeep Grand Cherokee Limited Demo' }, {}).reason, /its title says "Demo"/);
  // with nothing saying used, the word alone makes it a demo: skipped, as a flagged demo is
  const bare = assessVehicle({ ...used, inventoryType: null, urlConditionWord: null, siteTitle: '2024 Jeep Grand Cherokee Limited Loaner', url: null }, {});
  assert.equal(bare.decision, DECISION.SKIP);
  assert.match(bare.reason, /^Loaner unit, sold as new/);
  // a dealership's name is never read as a demo or loaner word
  for (const siteTitle of ['Used 2024 Jeep Grand Cherokee Limited | Courtesy Chrysler Dodge Jeep Ram', 'Used 2024 Jeep Grand Cherokee Limited - Courtesy Motors', 'Used 2024 Jeep Grand Cherokee Limited – Courtesy Cars of Springfield']) {
    assert.equal(assessVehicle({ ...used, siteTitle }, {}).decision, DECISION.READY, siteTitle);
  }
  // nor a word that only contains one
  assert.equal(assessVehicle({ ...used, siteTitle: 'Used 2024 Jeep Grand Cherokee Limited Demolition Package' }, {}).decision, DECISION.READY);
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

// ---------- signs any website can carry (schema.org condition values) ----------

test('condition words: schema.org condition values, however they are written', () => {
  for (const used of ['https://schema.org/UsedCondition', 'http://schema.org/UsedCondition', 'https://www.schema.org/UsedCondition/', 'schema:UsedCondition', 'UsedCondition', ' usedcondition ']) {
    assert.equal(readCondition(used), 'pre-owned', used);
  }
  assert.equal(readCondition('https://schema.org/NewCondition'), 'new');
  assert.equal(readCondition('NewCondition'), 'new');
  assert.equal(readCondition('https://schema.org/DamagedCondition'), 'damaged');
  assert.equal(readCondition('schema:RefurbishedCondition'), 'refurbished');
  // the website's own words for them
  assert.equal(readCondition('Damaged'), 'damaged');
  assert.equal(readCondition('Used - Damaged'), 'damaged', 'damaged is read before used');
  assert.equal(readCondition('Refurbished'), 'refurbished');
  // not a schema.org value, and not a condition word either
  assert.equal(readCondition('https://example.test/UsedCondition'), 'unknown');
  assert.equal(readCondition('https://schema.org/InStock'), 'unknown');
  // demo still wins, and the old words read as before
  assert.equal(readCondition('Demo'), 'demo');
  assert.equal(readCondition('Certified Used'), 'pre-owned');
  assert.equal(readCondition('New'), 'new');
});

test('damaged or refurbished goes to a person, never to Ready, whatever the other signs say', () => {
  const ready = vehicle('usedNormal'); // all three signs and Carfax say pre-owned
  assert.equal(assessVehicle(ready, MY_STORE).decision, DECISION.READY);
  for (const [word, Word] of [['damaged', 'Damaged'], ['refurbished', 'Refurbished']]) {
    for (const patch of [{ inventoryType: Word }, { inventoryType: `https://schema.org/${Word}Condition` }, { siteTitle: `${Word} 2019 Ram 1500 Classic Express` }, { urlConditionWord: word }]) {
      const a = assessVehicle({ ...ready, ...patch }, MY_STORE);
      assert.equal(a.decision, DECISION.REVIEW, JSON.stringify(patch));
      assert.match(a.reason, new RegExp(`^The website lists it as ${word} \\(`));
    }
  }
  assert.equal(assessVehicle({ ...ready, inventoryType: 'Damaged' }, MY_STORE).reason, 'The website lists it as damaged (inventory type). Check its condition before posting.');
  assert.equal(
    assessVehicle({ ...ready, inventoryType: 'https://schema.org/DamagedCondition', siteTitle: 'Refurbished 2019 Ram 1500 Classic Express' }, MY_STORE).reason,
    'The website lists it as damaged (inventory type) and refurbished (title). Check its condition before posting.'
  );
  // a new car stays skipped and a demo stays a demo, damaged or not
  assert.equal(assessVehicle({ ...vehicle('newNormal'), siteTitle: 'Damaged 2027 Jeep Grand Cherokee Limited' }, MY_STORE).decision, DECISION.SKIP);
  assert.equal(assessVehicle({ ...vehicle('newNormal'), inventoryType: 'Damaged', isDemo: true }, MY_STORE).decision, DECISION.SKIP);
});

test('a schema.org condition is one sign like any other: it supports, it never admits a car on its own', () => {
  const used = vehicle('usedNormal');
  // alone, with no other sign and no Carfax: a person checks
  const lonely = { ...used, inventoryType: 'https://schema.org/UsedCondition', urlConditionWord: null, siteTitle: '2019 Ram 1500 Classic Express', readableType: null, carfaxUrl: null };
  const a = assessVehicle(lonely, MY_STORE);
  assert.equal(a.decision, DECISION.REVIEW);
  assert.equal(a.reason, "Only one sign it's pre-owned (inventory type), and no Carfax report.");
  // beside the other signs it counts exactly as "Used" does
  const verdict = (a) => [a.decision, a.reason, a.notes, a.checks.map((c) => c.says)];
  assert.deepEqual(verdict(assessVehicle({ ...used, inventoryType: 'https://schema.org/UsedCondition' }, MY_STORE)), verdict(assessVehicle(used, MY_STORE)));
  // and against them it is a disagreement, in either direction
  assert.match(assessVehicle({ ...used, inventoryType: 'https://schema.org/NewCondition' }, MY_STORE).reason, /disagrees with itself/);
  assert.match(assessVehicle({ ...used, inventoryType: 'UsedCondition', urlConditionWord: 'new', siteTitle: null, readableType: null }, MY_STORE).reason, /disagrees with itself/);
});

// ---------- every decision the gate made before it learned any of that ----------

// Each Dealer Inspire record and each sandbox car, as it is and with one
// sign taken away at a time, under the lot's own store and under none. The
// same generator produced test/fixtures/structured/gate-before.json from
// classify.js as it was on 2026-09-29, before schema.org condition values
// and the damaged and refurbished words; nothing a Dealer Inspire website
// says may be decided differently since.
const VARIANTS = {
  asIs: {},
  noCarfax: { carfaxUrl: null },
  noAddressWord: { urlConditionWord: null },
  noTitle: { siteTitle: null, readableType: null },
  noType: { inventoryType: null },
  demo: { isDemo: true },
};

function gateCases() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(new URL('../demo/site/inventory.js', import.meta.url), 'utf8'), ctx);
  const inventory = ctx.window.LOT_SYNC_INVENTORY;
  const lots = [
    ['records', MY_STORE, Object.entries(fixtures).filter(([k]) => k !== '_about').map(([k, r]) => [k, normalizeVehicle(r)])],
    ...['day1', 'day2'].map((day) => [day, { myStores: ['Example Motors Springfield'] }, inventory.records(day, 'http://sandbox.test/demo/site/').map((r) => [r.vin, normalizeVehicle(trimRecord(r, { fullRecords: true }))])]),
  ];
  const out = {};
  for (const [lot, settings, vehicles] of lots) {
    for (const [id, v] of vehicles) {
      for (const [variant, patch] of Object.entries(VARIANTS)) {
        const a = assessVehicle({ ...v, ...patch }, settings);
        out[`${lot} ${id} ${variant}`] = { decision: a.decision, reason: a.reason, blockers: a.blockers.map((b) => b.text), notes: a.notes, says: a.checks.map((c) => c.says) };
      }
      out[`${lot} ${id} anyStore`] = assessVehicle(v, {}).decision;
    }
  }
  return out;
}

test('regression: every Dealer Inspire record and every sandbox car is decided exactly as before, for the same reason', () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/structured/gate-before.json', import.meta.url), 'utf8'));
  const now = gateCases();
  assert.deepEqual(Object.keys(now), Object.keys(before), 'the same cases: records.json and the sandbox lot have not changed under the baseline');
  for (const [key, then] of Object.entries(before)) assert.deepEqual(now[key], then, key);
  // the baseline covers every decision the gate can make
  const decisions = new Set(Object.values(before).map((c) => (typeof c === 'string' ? c : c.decision)));
  assert.deepEqual([...decisions].sort(), ['not-ready', 'ready', 'review', 'skip']);
});
