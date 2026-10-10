// A car saved as a Facebook draft keeps the price the draft was filled
// with, so a listing published from the draft is recorded at that price and
// a website price that moved while the draft waited is flagged
// (extension/src/drafts.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRecord, draftPrice, markDraftPosted, draftPriceUpdate, withPriceUpdate, draftPill } from '../extension/src/drafts.js';
import { diffScans, markPosted, markPriceUpdated, basisPrice } from '../extension/src/rescan.js';
import { snapshot, fixtures } from './helpers.js';

const VIN = fixtures.usedNormal.vin; // ready, $27,163 ($26,673 before fees)
const AT = '2026-10-01T15:00:00.000Z';
const LOT = [['usedNormal'], ['certified']];
// the same lot after the website dropped this car's prices by `by`
function dropped(by) {
  const s = snapshot(LOT, undefined, '2026-10-03T15:00:00.000Z');
  const e = s.vehicles[VIN];
  Object.assign(e, { price: e.price - by, priceBeforeFees: e.priceBeforeFees - by });
  return s;
}

test('a draft is kept with the price the form was filled with, and the basis it was filled under', () => {
  assert.deepEqual(draftRecord({ name: 'Car', price: 27163, basis: 'website', savedAt: AT }), { name: 'Car', savedAt: AT, price: 27163, basis: 'website' });
  assert.equal(draftRecord({ name: 'Car', price: 26673, basis: 'beforeFees', savedAt: AT }).basis, 'beforeFees');
  assert.equal(draftRecord({ name: 'Car', price: null, basis: 'odd', savedAt: AT }).price, null);
  assert.equal(draftRecord({ name: 'Car', price: 1, basis: 'odd', savedAt: AT }).basis, 'website');
  for (const d of [null, {}, { savedAt: AT }, { price: 0 }, { price: -5 }, { price: '27163' }, { price: NaN }]) assert.equal(draftPrice(d), null, JSON.stringify(d));
  assert.equal(draftPrice({ price: 27163 }), 27163);
});

test('a draft published after the website dropped the price is recorded at the draft\'s price, and the drop is flagged on every rescan until the listing is updated', () => {
  const day1 = snapshot(LOT);
  const day3 = dropped(1500);
  const draft = draftRecord({ name: day1.vehicles[VIN].name, price: basisPrice(day1.vehicles[VIN]), basis: 'website', savedAt: AT });
  assert.equal(draft.price, 27163);

  // Mark posted on day 3, with the website at $25,663
  const posted = markDraftPosted({}, day3.vehicles[VIN], draft, 'website', AT);
  assert.equal(posted[VIN].price, 27163, 'the listing shows the draft\'s price, so that is what is recorded');
  assert.equal(posted[VIN].postedAt, AT);
  const now = draftPriceUpdate(draft, day3.vehicles[VIN], 'website');
  assert.deepEqual([now.from, now.to, now.change, now.yours], [27163, 25663, -1500, true]);

  // the next rescans compare the website with the recorded price: the drop is listed, as diffScans lists it for any of your listings
  for (const prev of [day1, day3]) {
    const d = diffScans(prev, dropped(1500), { posted });
    assert.deepEqual(d.priceUpdates.map((p) => [p.vin, p.from, p.to, p.yours]), [[VIN, 27163, 25663, true]]);
    const { vin, from, to, change, yours } = d.priceUpdates[0];
    assert.deepEqual({ vin, from, to, change, yours }, { vin: now.vin, from: now.from, to: now.to, change: now.change, yours: now.yours });
  }
  // once the person updates the listing, nothing more
  assert.deepEqual(diffScans(day3, dropped(1500), { posted: markPriceUpdated(posted, VIN, 25663) }).priceUpdates, []);

  // what happened before: recorded at the website's price, so no rescan ever flagged the $1,500 gap
  const before = markPosted({}, day3.vehicles[VIN], 'website', AT);
  assert.equal(before[VIN].price, 25663);
  assert.deepEqual(diffScans(day3, dropped(1500), { posted: before }).priceUpdates, []);
});

test('a draft on the lower price before fees is compared on that basis; a draft saved without a price is recorded at the website\'s price', () => {
  const day1 = snapshot(LOT);
  const draft = draftRecord({ name: 'Ram', price: basisPrice(day1.vehicles[VIN], 'beforeFees'), basis: 'beforeFees', savedAt: AT });
  const day3 = dropped(500).vehicles[VIN];
  assert.equal(markDraftPosted({}, day3, draft, 'beforeFees', AT)[VIN].price, 26673);
  assert.deepEqual([draftPriceUpdate(draft, day3, 'beforeFees').from, draftPriceUpdate(draft, day3, 'beforeFees').to], [26673, 26173]);
  // nothing moved: nothing to update
  assert.equal(draftPriceUpdate(draft, day1.vehicles[VIN], 'beforeFees'), null);
  // an old draft record, saved before drafts kept their price
  const old = { name: 'Ram', savedAt: AT };
  assert.equal(markDraftPosted({}, day3, old, 'website', AT)[VIN].price, 26663, 'the website price on the day it is marked');
  assert.equal(draftPriceUpdate(old, day3, 'website'), null);
  // and the rest of the entry is markPosted's, extras included
  assert.deepEqual(markDraftPosted({}, day3, draft, 'beforeFees', AT, { salesperson: 'Pat' })[VIN], { ...markPosted({}, day3, 'beforeFees', AT, { salesperson: 'Pat' })[VIN], price: 26673 });
  // a website that shows no price now: no update offered (the rescan's Needs a look says so)
  assert.equal(draftPriceUpdate(draft, { ...day3, price: null, priceBeforeFees: null }, 'beforeFees'), null);
});

test('the update goes on the saved To do list in place of any other for the car, in the rescan\'s order', () => {
  const item = { vin: 'AAA', name: 'A', yours: true, from: 27163, to: 25663, change: -1500 };
  const diff = { takenAt: AT, takeDown: [{ vin: 'X' }], priceUpdates: [
    { vin: 'BBB', yours: true, from: 30000, to: 29000, change: -1000 },
    { vin: 'AAA', yours: false, from: 26000, to: 25663, change: -337 },
    { vin: 'CCC', yours: false, from: 20000, to: 15000, change: -5000 },
  ] };
  const next = withPriceUpdate(diff, item);
  assert.deepEqual(next.priceUpdates.map((p) => p.vin), ['AAA', 'BBB', 'CCC'], 'yours first, biggest move first; the old AAA row replaced');
  assert.equal(next.priceUpdates[0], item);
  assert.deepEqual(next.takeDown, diff.takeDown, 'everything else stays');
  assert.equal(diff.priceUpdates.length, 3, 'the stored list is not changed in place');
  assert.deepEqual(withPriceUpdate({ takenAt: AT }, item).priceUpdates, [item]);
  assert.equal(withPriceUpdate(null, item), undefined, 'no saved list: nothing written');
  assert.equal(withPriceUpdate(diff, null), undefined);
});

test('the draft\'s pill shows its price, and says when the website\'s price moved or the car is not ready any more', () => {
  const day1 = snapshot(LOT).vehicles[VIN];
  const draft = draftRecord({ name: 'Ram', price: 27163, basis: 'website', savedAt: AT });
  assert.deepEqual(draftPill(draft, day1), { tone: 'warn', text: 'Draft on Facebook at $27,163', title: 'Saved as a draft on Facebook: publish it there, then mark it posted.' });
  const moved = draftPill(draft, dropped(1500).vehicles[VIN]);
  assert.equal(moved.tone, 'bad');
  assert.equal(moved.text, 'Draft on Facebook at $27,163: the website now shows $25,663');
  assert.match(moved.title, /^Change the price on the draft to \$25,663 before you publish it\./);
  assert.match(moved.title, /recorded at \$27,163 and To do lists the price to update/);
  const gone = draftPill(draft, day1, { ready: false });
  assert.deepEqual([gone.tone, gone.text], ['bad', 'Draft on Facebook: not ready now']);
  assert.match(gone.title, /Don't publish the draft/);
  const old = draftPill({ name: 'Ram', savedAt: AT }, day1);
  assert.deepEqual([old.tone, old.text], ['warn', 'Draft on Facebook']);
  assert.match(old.title, /did not keep this draft's price, so check it against the website/);
  // from the side panel, Mark posted is in the popup
  assert.match(draftPill(draft, day1, { markWhere: ' in the popup' }).title, /mark it posted in the popup\.$/);
  // no word of what the website price is when the car is missing from the scan
  assert.equal(draftPill(draft, undefined).text, 'Draft on Facebook at $27,163');
});
