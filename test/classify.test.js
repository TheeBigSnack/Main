import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { websitePrice, conditionWordFromUrl, normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { trimRecord } from '../extension/adapters/dealerInspire.js';
import { assessVehicle, readCondition, titleConditionWords, DECISION } from '../extension/src/classify.js';
import { fixtures, vehicle, raw, MY_STORE } from './helpers.js';
import { showsLowerPrice } from '../extension/src/settings.js';

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
  const r = structuredClone(raw('usedNormal'));
  delete r.extra_fields.lightning.pricing;
  assert.equal(websitePrice(r).value, 27163);
});

test('the lower second price is one the website displays: never only the hidden pricing fields, never an MSRP', () => {
  const display = (pricing) => ({ extra_fields: { lightning: { pricing } } });
  // the hidden fields say otherwise: the displayed "Was" line decides
  assert.equal(vehicle('usedNormal', { pricing: { internet_price: 25500, price: 25500 } }).priceBeforeFees, 26673);
  // the website shows its main price only; internet_price still holds a lower number
  const single = vehicle('usedNormal', display({ high: false }));
  assert.equal(single.price, 27163);
  assert.equal(single.priceBeforeFees, null);
  assert.equal(showsLowerPrice([single]), false, 'a number only the hidden fields carry is never offered as a basis');
  // "Please call for price" with the hidden fields still filled in
  const call = vehicle('usedNormal', display({ low: false, high: { label: 'Price', value: 'Please call for price' } }));
  assert.equal(call.price, null);
  assert.equal(call.priceBeforeFees, null);
  assert.equal(normalizeVehicle(fixtures.newHighMiles).priceBeforeFees, null, 'the live record: call for price over internet_price 33295');
  // a second number labelled MSRP is not a price before fees
  assert.equal(vehicle('usedNormal', display({ high: { label: 'MSRP', value: '26673' } })).priceBeforeFees, null);
  // no display pricing at all: nothing shows a second price
  const bare = structuredClone(raw('usedNormal'));
  delete bare.extra_fields.lightning.pricing;
  assert.equal(normalizeVehicle(bare).priceBeforeFees, null);
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

// The second condition field (readableType) backs up the title when the title has no condition word. For a demo or
// loaner it also counts when the title has words of its own: a car the website lists there as pre-owned (the
// certified mark the DealerOn and Dealer.com readers keep beside a loaner word) goes to Needs a look, not skipped
// without a word, unless something on the website calls it new. Nothing else about the gate changes.
test('a demo or loaner the second condition field calls pre-owned gets a look whatever the title opens with; a new sign still skips it', () => {
  const vin = '1C4RJFBG0RC000001';
  const loaner = {
    vin, year: 2024, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', inventoryType: 'Loaner', readableType: 'Certified', isDemo: false, isLoaner: true,
    siteTitle: 'Loaner 2024 Jeep Grand Cherokee Limited', url: `https://www.example-dealer.test/vehicle/2024-jeep-grand-cherokee-${vin.toLowerCase()}`, urlConditionWord: null,
    carfaxUrl: null, mileage: 3120, price: 40000, photoCount: 10, availability: 'In-Stock',
  };
  for (const siteTitle of ['Loaner 2024 Jeep Grand Cherokee Limited', 'Sale 2024 Jeep Grand Cherokee Limited', '2024 Jeep Grand Cherokee Limited']) {
    const a = assessVehicle({ ...loaner, siteTitle }, {});
    assert.equal(a.decision, DECISION.REVIEW, siteTitle);
    assert.match(a.reason, /^Listed as pre-owned but also flagged as a loaner\./, siteTitle);
    assert.ok(a.notes.includes('The website also lists it as "Certified".'), `${siteTitle}: ${a.notes.join(' | ')}`);
  }
  for (const patch of [{ siteTitle: 'New 2024 Jeep Grand Cherokee Limited' }, { urlConditionWord: 'new' }]) {
    const a = assessVehicle({ ...loaner, ...patch }, {});
    assert.equal(a.decision, DECISION.SKIP, JSON.stringify(patch));
    assert.ok(a.notes.includes('The website also lists it as "Certified".'), JSON.stringify(patch));
  }
  // a second field that says new, or nothing, leaves the loaner sold as new
  for (const readableType of ['New', null]) assert.equal(assessVehicle({ ...loaner, readableType }, {}).decision, DECISION.SKIP, String(readableType));
  // a car that is no demo or loaner is decided by its three signs alone, as before
  const used = { ...loaner, inventoryType: 'Used', isLoaner: false, urlConditionWord: 'used', siteTitle: 'Sale 2024 Jeep Grand Cherokee Limited', readableType: 'Certified Pre-Owned' };
  const plain = assessVehicle(used, {});
  assert.equal(plain.decision, DECISION.READY);
  assert.equal(plain.reason, 'Pre-owned: inventory type, web address agree.');
  // the note only when nothing else calls the car pre-owned
  assert.deepEqual(assessVehicle({ ...used, isDemo: true }, {}).notes, []);
});

// The record's two condition fields (inventoryType and readableType) that
// disagree, one calling the car new and the other pre-owned, send it to Needs
// a look naming both words, whatever the title and the address say, unless
// every sign calls it new, when it is skipped as new as before (the
// DealerOn and Dealer.com readers keep "used" and "New" from two fields this
// way; a Dealer Inspire record carries type and readable_type). Before, the
// second field was read only when the title had no condition word, so a
// record with "Used" in one field and "New" in the other could be Ready.
test('two condition fields that disagree on new and pre-owned send the car to Needs a look, naming both words', () => {
  const vin = '1C4RJFBG0RC000002';
  const used = {
    vin, year: 2021, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', inventoryType: 'Used', readableType: 'New', isDemo: false, isLoaner: false,
    siteTitle: 'Used 2021 Jeep Grand Cherokee Limited', url: `https://www.example-dealer.test/used/2021-jeep-grand-cherokee-limited-${vin.toLowerCase()}/`, urlConditionWord: 'used',
    carfaxUrl: 'https://www.carfax.com/x', mileage: 31200, price: 30000, photoCount: 10, availability: 'In-Stock',
  };
  const cases = [
    [used, 'Used', 'New'],
    [{ ...used, inventoryType: 'Certified Used' }, 'Certified Used', 'New'],
    [{ ...used, siteTitle: '2021 Jeep Grand Cherokee Limited' }, 'Used', 'New'],
    [{ ...used, inventoryType: 'New', readableType: 'Pre-Owned' }, 'New', 'Pre-Owned'],
    [{ ...used, inventoryType: 'New', readableType: 'Pre-Owned', siteTitle: '2021 Jeep Grand Cherokee Limited', urlConditionWord: 'new' }, 'New', 'Pre-Owned'],
  ];
  for (const [v, first, second] of cases) {
    const a = assessVehicle(v, {});
    assert.equal(a.decision, DECISION.REVIEW, `${first} / ${second}: ${a.reason}`);
    assert.equal(a.reason, `The website disagrees with itself: it lists the car as "${first}" and as "${second}". Check its condition before posting.`);
  }
  // a car every sign (type, title, address) calls new is still skipped as new
  assert.equal(assessVehicle({ ...used, inventoryType: 'New', readableType: 'Pre-Owned', siteTitle: 'New 2021 Jeep Grand Cherokee Limited', urlConditionWord: 'new' }, {}).decision, DECISION.SKIP);
  // fields that agree, or a second field that says neither, change nothing
  assert.equal(assessVehicle({ ...used, readableType: 'Pre-Owned' }, {}).decision, DECISION.READY);
  assert.equal(assessVehicle({ ...used, readableType: null }, {}).decision, DECISION.READY);
  assert.equal(assessVehicle({ ...used, inventoryType: 'New', readableType: 'New', siteTitle: 'New 2021 Jeep Grand Cherokee Limited', urlConditionWord: 'new' }, {}).decision, DECISION.SKIP);
  // a demo or loaner is decided by the loaner rule first, as before
  assert.equal(assessVehicle({ ...used, isLoaner: true }, {}).decision, DECISION.REVIEW);
  assert.match(assessVehicle({ ...used, isLoaner: true }, {}).reason, /^Listed as pre-owned but also flagged as a loaner\./);
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
    'Demo after a " - " in the title': { siteTitle: '2024 Jeep Grand Cherokee Limited - Demo' },
    'Service Loaner after a " - " in the title': { siteTitle: 'Used 2024 Jeep Grand Cherokee Limited - Service Loaner' },
    'Demo Unit after a " | " in the title': { siteTitle: 'Used 2024 Jeep Grand Cherokee Limited | Demo Unit' },
    'Loaner between the car and the dealership': { siteTitle: 'Used 2024 Jeep Grand Cherokee Limited | Loaner | Example Motors' },
    'Demo after a separator in a title with no model year': { siteTitle: 'Jeep Grand Cherokee Limited - Demo' },
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

test('a courtesy car, vehicle or loaner after a title separator is never Ready; a dealership name that starts with Courtesy still is', () => {
  const vin = '1C4RJFBG0RC000001';
  const used = {
    vin, year: 2024, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', inventoryType: 'Used', readableType: null, isDemo: false, isLoaner: false,
    siteTitle: 'Used 2024 Jeep Grand Cherokee Limited', url: `https://www.example-dealer.test/used/2024-jeep-grand-cherokee-limited-${vin.toLowerCase()}/`, urlConditionWord: 'used',
    carfaxUrl: 'https://www.carfax.com/x', mileage: 3120, price: 40000, photoCount: 10, availability: 'In-Stock',
  };
  for (const [siteTitle, word] of [
    ['Used 2024 Jeep Grand Cherokee Limited - Courtesy Vehicle', 'Courtesy Vehicle'],
    ['Used 2024 Jeep Grand Cherokee Limited | Courtesy Car', 'Courtesy Car'],
    ['Used 2024 Jeep Grand Cherokee Limited | Courtesy Loaner | Example Motors', 'Courtesy Loaner'],
    ['Used 2024 Jeep Grand Cherokee Limited - Courtesy Vehicle for Sale', 'Courtesy Vehicle'],
    ['Used 2024 Jeep Grand Cherokee Limited - Courtesy Vehicle For Sale in Springfield, OH | Example Motors', 'Courtesy Vehicle'],
    ['Used 2024 Jeep Grand Cherokee Limited | Courtesy Car for Sale near Springfield', 'Courtesy Car'],
  ]) {
    const a = assessVehicle({ ...used, siteTitle }, {});
    assert.equal(a.decision, DECISION.REVIEW, siteTitle);
    assert.match(a.reason, new RegExp(`its title says "${word}"`), siteTitle);
  }
  assert.equal(assessVehicle({ ...used, inventoryType: null, urlConditionWord: null, url: null, siteTitle: '2024 Jeep Grand Cherokee Limited - Courtesy Vehicle' }, {}).decision, DECISION.SKIP);
  for (const siteTitle of ['Used 2024 Jeep Grand Cherokee Limited | Courtesy Car Center', 'Used 2024 Jeep Grand Cherokee Limited - Courtesy Cars', 'Used 2024 Jeep Grand Cherokee Limited – Courtesy Cars of Springfield', 'Used 2024 Jeep Grand Cherokee Limited | Courtesy Motors', 'Used 2024 Jeep Grand Cherokee Limited | Courtesy Cars for Sale', 'Used 2024 Jeep Grand Cherokee Limited | Courtesy Car for Salem Motors']) {
    assert.equal(assessVehicle({ ...used, siteTitle }, {}).decision, DECISION.READY, siteTitle);
  }
  // before the model year, as README says, "courtesy" counts on its own, even as a dealership's name
  for (const siteTitle of ['Courtesy Motors | Used 2024 Jeep Grand Cherokee Limited', 'Courtesy Car Center - Used 2024 Jeep Grand Cherokee Limited', 'Courtesy Chevrolet: Used 2024 Jeep Grand Cherokee Limited']) {
    assert.equal(assessVehicle({ ...used, siteTitle }, {}).decision, DECISION.REVIEW, siteTitle);
  }
  // the README's list of words holds after a separator too
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /before the model year, "courtesy" counts even on its own, so a title that opens with such a dealership name is read as a demo/);
  const listed = readme.match(/so does the word (.+?), in the car's own title/);
  assert.ok(listed, 'README names the demo and loaner words');
  const words = [...listed[1].matchAll(/"([^"]+)"|\b(demo|demonstrator|loaner)\b/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(words.sort(), ['courtesy car', 'courtesy loaner', 'courtesy vehicle', 'demo', 'demonstrator', 'loaner']);
  for (const word of words) assert.equal(assessVehicle({ ...used, siteTitle: `Used 2024 Jeep Grand Cherokee Limited - ${word}` }, {}).decision, DECISION.REVIEW, word);
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

// ---------- what the field notes and the README say about the gate ----------

import { checkPreOwned } from '../extension/src/classify.js';

test('the field notes and the README describe the gate as it decides: its signs in its order, and Carfax backing a lone sign', () => {
  const fields = readFileSync(new URL('../extension/src/vehicle.js', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const car = { inventoryType: 'Used', urlConditionWord: 'used', siteTitle: 'Used 2021 Example Sedan', readableType: null, carfaxUrl: null, mileage: 34567 };
  // the signs are numbered in the order the gate reads them
  const order = checkPreOwned(car).checks.map((c) => c.key);
  const sign = (field) => Number(new RegExp(`'${field}', //[^\\n]*?sign (\\d)`).exec(fields)[1]);
  assert.deepEqual({ type: sign('inventoryType'), url: sign('urlConditionWord'), title: sign('siteTitle') }, { type: order.indexOf('type') + 1, url: order.indexOf('url') + 1, title: order.indexOf('title') + 1 });
  // two signs pass with no Carfax link; one sign needs it
  assert.equal(checkPreOwned({ ...car, siteTitle: '2021 Example Sedan' }).verdict, 'pre-owned');
  assert.equal(checkPreOwned({ ...car, siteTitle: '2021 Example Sedan', urlConditionWord: null }).verdict, 'review');
  assert.equal(checkPreOwned({ ...car, siteTitle: '2021 Example Sedan', urlConditionWord: null, carfaxUrl: 'https://www.carfax.com/x' }).verdict, 'pre-owned');
  // and the notes say so: not "three signs must agree", not "no report = needs a look" on its own, not "never blocks"
  assert.doesNotMatch(fields, /three signs must agree/);
  assert.match(fields, /'carfaxUrl', \/\/ the pre-owned gate: backs up a lone pre-owned sign/);
  assert.doesNotMatch(readme, /a missing one never blocks a car/);
  assert.match(readme, /a car with only one pre-owned sign [^.]*needs the report, or it goes to \*\*Needs a look\*\*/);
});
