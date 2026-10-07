import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScans, markPosted, markPriceUpdated, markTakenDown, markLookDismissed, lookDismissed, basisPrice, snapshotEntry, makeSnapshot, firstSeenAt, listingStatus, pendingText, settleDiff, postedBasis, withPostedBasis, withSeenBasis, listingWebsitePrice } from '../extension/src/rescan.js';
import { noteFlags } from '../extension/src/pilot.js';
import { scanFromStored } from '../extension/src/accountFlow.js';
import { snapshot, fixtures, vehicle, STANDARD_ORIGIN, standardCars, standardSite, standardCarPage, standardListPage, fakeSiteSearch, httpError, MY_STORE, WAYNESBURG } from './helpers.js';
import { assessVehicle } from '../extension/src/classify.js';
import * as rescan from '../extension/src/rescan.js';
import { readFileSync } from 'node:fs';
import schemaOrg from '../extension/adapters/schemaOrg.js';
import { scanWithSearch, confirmOrder } from '../extension/src/scanRunner.js';
import { withDefaults } from '../extension/src/settings.js';
import { MANUFACTURERS } from '../extension/src/vin.js';

const VIN = {
  ram: fixtures.usedNormal.vin, // ready, $27,163
  wagoneer: fixtures.certified.vin, // other store
  hellcat: fixtures.usedNoCarfax.vin, // no photos
  tradesman: fixtures.usedNoPhotos.vin, // no photos
};
const LOT = [['usedNormal'], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']];
const confirmed = (...vins) => ({ checked: vins, notFound: vins, error: null });

test('the price to post: the lower second price only when this car shows one below its main price', () => {
  const car = vehicle('usedNormal'); // 27163 main, 26673 before fees
  assert.equal(basisPrice(car), 27163);
  assert.equal(basisPrice(car, 'beforeFees'), 26673);
  assert.equal(basisPrice({ price: 20000 }, 'beforeFees'), 20000, 'no second price: the main price');
  assert.equal(basisPrice({ price: 20000, priceBeforeFees: 21000 }, 'beforeFees'), 20000, 'a higher second number is not a price before fees');
  assert.equal(basisPrice({ price: 20000, priceBeforeFees: 0 }, 'beforeFees'), 20000);
  assert.equal(basisPrice({ priceBeforeFees: 19000 }, 'beforeFees'), null, 'no main price (call for price): no price on either basis');
  assert.equal(basisPrice({ price: null, priceBeforeFees: 19000 }, 'beforeFees'), null);
  assert.equal(basisPrice({}, 'beforeFees'), null);
  assert.equal(basisPrice(null), null);
});

test('first scan: nothing to do yet', () => {
  const d = diffScans(null, snapshot(LOT));
  assert.equal(d.firstScan, true);
  assert.equal(d.takeDown.length + d.priceUpdates.length + d.newArrivals.length + d.needsALook.length, 0);
});

test('nothing changed: nothing to do', () => {
  const d = diffScans(snapshot(LOT), snapshot(LOT), { confirm: confirmed() });
  assert.equal(d.takeDown.length + d.priceUpdates.length + d.newArrivals.length + d.nowReady.length + d.needsALook.length, 0);
});

test('sold car you posted: take it down (confirmed by VIN lookup)', () => {
  const posted = { [VIN.ram]: { name: '2019 Ram 1500 Classic Express', price: 27163 } };
  const curr = snapshot(LOT.filter(([n]) => n !== 'usedNormal'));
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed(VIN.ram) });
  assert.equal(d.takeDown.length, 1);
  assert.equal(d.takeDown[0].vin, VIN.ram);
  assert.equal(d.takeDown[0].why, 'gone');
  assert.equal(d.takeDown[0].yours, true);
});

test('your posted cars are listed before other sold cars', () => {
  const posted = { [VIN.hellcat]: { name: 'Hellcat', price: 53485 } };
  const curr = snapshot([['certified'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed(VIN.ram, VIN.hellcat) });
  assert.deepEqual(d.takeDown.map((t) => t.vin), [VIN.hellcat, VIN.ram]);
});

test('missing but not confirmed gone: needs a look, not take down', () => {
  const curr = snapshot(LOT.filter(([n]) => n !== 'usedNormal'));
  const d = diffScans(snapshot(LOT), curr, { confirm: { checked: [], notFound: [], error: null } });
  assert.equal(d.takeDown.length, 0);
  assert.equal(d.needsALook.length, 1);
});

test('VIN double-check failed: warns and marks nothing gone', () => {
  const curr = snapshot(LOT.filter(([n]) => n !== 'usedNormal'));
  const d = diffScans(snapshot(LOT), curr, { confirm: { checked: [], notFound: [], error: 'network error' } });
  assert.equal(d.takeDown.length, 0);
  assert.match(d.warnings[0], /Couldn't double-check/);
});

test('more than half the lot vanishing at once is treated as a website hiccup', () => {
  const big = [];
  for (let i = 0; i < 12; i += 1) big.push(['usedNormal', { vin: `1C6RR7FT0KS64${String(1000 + i)}` }]);
  const prev = snapshot(big);
  const curr = snapshot(big.slice(0, 3));
  const gone = big.slice(3).map(([, p]) => p.vin);
  const d = diffScans(prev, curr, { confirm: confirmed(...gone) });
  assert.equal(d.takeDown.length, 0);
  assert.match(d.warnings.join(' '), /disappeared at once/);
});

test('a lot that really shrinks by more than half: held back scan after scan, offered once two agree, and saved only by the salesperson\'s click', () => {
  const big = [];
  for (let i = 0; i < 12; i += 1) big.push(['usedNormal', { vin: `1C6RR7FT0KS64${String(1000 + i)}` }]);
  const vins = big.map(([, p]) => p.vin);
  const saved = snapshot(big, undefined, '2026-09-26T09:00:00.000Z');
  const posted = { [vins[11]]: { name: 'Ram', price: 27163, basis: 'website', postedAt: '2026-09-20T12:00:00.000Z' } };
  const at = (h) => `2026-09-26T${String(h).padStart(2, '0')}:00:00.000Z`;
  const read = (h, n = 4, from = 0) => snapshot(big.slice(from, from + n), undefined, at(h));
  // what a save does: the diff, settled, with the read held back against the diff saved before it
  const scanAt = (snap, before, confirm = null) => {
    const d = diffScans(saved, snap, { posted, confirm });
    d.takenAt = snap.takenAt;
    return rescan.withWithheld(settleDiff(d, posted), snap, before);
  };

  // the first short read: held back, not offered, nothing to accept
  const first = scanAt(read(12), null);
  assert.equal(first.unreliable, true);
  assert.deepEqual({ ...first.withheld, snapshot: undefined }, { since: at(12), scans: 1, cars: 4, saved: 12, snapshot: undefined });
  assert.equal(rescan.withheldOffer(first), null);
  assert.equal(rescan.acceptWithheld(first), null);
  assert.equal(first.takeDown.length, 0, 'nothing marked gone');
  // the second agreeing read: offered, counted from the first
  const second = scanAt(read(15), first);
  assert.equal(second.withheld.scans, 2);
  assert.equal(second.withheld.since, at(12));
  assert.equal(rescan.withheldOffer(second).cars, 4);
  assert.equal(second.withheld.snapshot.takenAt, at(15), 'the newest read is the one offered');
  // a car sold between two scans hours apart still agrees; another part of the lot does not
  assert.equal(scanAt(read(18, 3), second).withheld.scans, 3);
  assert.equal(scanAt(read(18, 4, 4), second).withheld.scans, 1);
  // an empty list, or one the website itself says is not whole, is never offered
  const empty = snapshot([], undefined, at(18));
  assert.equal(scanAt(empty, scanAt(empty, null)).withheld.scans, 1);
  const part = { ...read(18), complete: false };
  assert.equal(scanAt(part, second).withheld.scans, 1);
  // a scan that is saved holds nothing back, and starts the count again
  const whole = rescan.withWithheld(diffScans(saved, saved, { posted }), saved, second);
  assert.equal(whole.unreliable, false);
  assert.equal('withheld' in whole, false);
  assert.equal(scanAt(read(21), whole).withheld.scans, 1);

  // the click: the read becomes the saved list, the hiccup warning goes, the items stay
  const took = rescan.acceptWithheld(second, '2026-09-26T16:00:00.000Z');
  assert.equal(took.snapshot, second.withheld.snapshot);
  assert.equal(took.diff.unreliable, false);
  assert.equal('withheld' in took.diff, false);
  assert.doesNotMatch(took.diff.warnings.join(' '), /disappeared at once/);
  assert.deepEqual(took.diff.accepted, { at: '2026-09-26T16:00:00.000Z', cars: 4, saved: 12 });
  assert.equal(took.diff.takeDown.length, 0, 'still nothing marked gone');
  assert.ok(took.diff.needsALook.some((n) => n.vin === vins[11] && n.yours), 'the posted car it missed stays a question');
  assert.notEqual(scanFromStored({ snapshot: took.snapshot, diff: took.diff }), null, 'and the scan now counts as a trusted one');
  // the next scan compares with the new list: no hiccup, and the posted car
  // it misses is gone only once the website's own search cannot find it
  const next = diffScans(took.snapshot, read(18), { posted, confirm: confirmed(vins[11]) });
  assert.equal(next.unreliable, false);
  assert.deepEqual(next.takeDown.map((t) => [t.vin, t.why]), [[vins[11], 'gone']]);
  assert.equal(diffScans(took.snapshot, read(18), { posted, confirm: { checked: [], notFound: [], error: 'timeout' } }).takeDown.length, 0);
});

test('price drop on a car you posted: update from your listing price', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: { low: { value: '26163' } } } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed() });
  assert.equal(d.priceUpdates.length, 1);
  assert.deepEqual(
    { from: d.priceUpdates[0].from, to: d.priceUpdates[0].to, change: d.priceUpdates[0].change, yours: d.priceUpdates[0].yours },
    { from: 27163, to: 26163, change: -1000, yours: true }
  );
});

test('posted listing still at an old price is caught even if the website changed two scans ago', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 28000 } }; // posted before an earlier drop
  const d = diffScans(snapshot(LOT), snapshot(LOT), { posted, confirm: confirmed() });
  assert.equal(d.priceUpdates.length, 1);
  assert.equal(d.priceUpdates[0].to, 27163);
});

test('price increase on a car nobody posted is reported too', () => {
  const curr = snapshot([['usedNormal'], ['certified'], ['usedNoCarfax'], ['usedNoPhotos', { extra_fields: { lightning: { pricing: { low: { value: '34485' } } } } }]]);
  const d = diffScans(snapshot(LOT), curr, { confirm: confirmed() });
  assert.equal(d.priceUpdates.length, 1);
  assert.equal(d.priceUpdates[0].change, 1000);
  assert.equal(d.priceUpdates[0].yours, false);
});

test('"before fees" price basis compares the price without the doc fee', () => {
  const curr = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: { high: { label: 'Was', value: '25673' } } } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const website = diffScans(snapshot(LOT), curr, { confirm: confirmed() });
  const beforeFees = diffScans(snapshot(LOT), curr, { confirm: confirmed(), basis: 'beforeFees' });
  assert.equal(website.priceUpdates.length, 0);
  assert.equal(beforeFees.priceUpdates.length, 1);
  assert.equal(beforeFees.priceUpdates[0].change, -1000);
});

// "Price to post" applies to new posts: each listing records the basis it
// was posted at and is compared with the website on that basis, so a change
// of the setting is never read as a website price change.
test('a change of the price setting is not a website price change: each listing is compared on the basis it was posted at', () => {
  const s = snapshot(LOT);
  const ram = s.vehicles[VIN.ram]; // $27,163 main, $26,673 shown below it
  const at = '2026-09-26T21:00:00.000Z';
  // posted on the main price; the dealer then switches to the lower second price; the website is unchanged
  const posted = markPosted({}, ram, 'website', at);
  const d = diffScans(s, snapshot(LOT), { posted, confirm: confirmed(), basis: 'beforeFees' });
  assert.deepEqual(d.priceUpdates, []);
  assert.equal(noteFlags(null, d).flags.length, 0, 'nothing for the pilot numbers either');
  assert.equal(listingStatus(ram, posted[VIN.ram].price, basisPrice(ram, postedBasis(posted[VIN.ram], 'beforeFees'))).text, 'Matches the website');
  // a real website change is still mirrored, on the listing's own basis
  const drop = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: { low: { value: '26163' }, high: { label: 'Was', value: '25673' } } } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  assert.deepEqual(diffScans(s, drop, { posted, confirm: confirmed(), basis: 'beforeFees' }).priceUpdates.map((u) => [u.from, u.to]), [[27163, 26163]]);
  // the other way round: posted on the lower price, the setting back to the main price
  const lower = markPosted({}, ram, 'beforeFees', at);
  assert.equal(lower[VIN.ram].price, 26673);
  assert.deepEqual(diffScans(s, snapshot(LOT), { posted: lower, confirm: confirmed(), basis: 'website' }).priceUpdates, []);
  // an entry kept before the basis was recorded: the price it carries tells the basis it was posted at
  // (postedBasis reads it off the scans), so a change of the setting asks for no price edit on it either
  const legacy = { [VIN.ram]: { name: 'Ram', price: 27163, postedAt: at } };
  assert.deepEqual(diffScans(s, snapshot(LOT), { posted: legacy, confirm: confirmed(), basis: 'beforeFees' }).priceUpdates, []);
  // one whose price is on neither basis follows the setting, which is why a change of the setting stamps it first
  const unknown = { [VIN.ram]: { name: 'Ram', price: 28000, postedAt: at } };
  assert.equal(diffScans(s, snapshot(LOT), { posted: unknown, confirm: confirmed(), basis: 'beforeFees' }).priceUpdates[0].to, 26673);
  assert.equal(diffScans(s, snapshot(LOT), { posted: withPostedBasis(unknown, 'website'), confirm: confirmed(), basis: 'beforeFees' }).priceUpdates[0].to, 27163);
  const stamped = withPostedBasis(legacy, 'website');
  assert.deepEqual(stamped[VIN.ram], { name: 'Ram', price: 27163, postedAt: at, basis: 'website' });
  assert.deepEqual(diffScans(s, snapshot(LOT), { posted: stamped, confirm: confirmed(), basis: 'beforeFees' }).priceUpdates, []);
  assert.equal(withPostedBasis(stamped, 'beforeFees'), undefined, 'an entry that has a basis keeps it: nothing to write');
  assert.equal(withPostedBasis(null, 'website'), undefined);
  assert.equal(postedBasis({ basis: 'beforeFees' }, 'website'), 'beforeFees');
  assert.equal(postedBasis({}, 'beforeFees'), 'beforeFees');
  assert.equal(postedBasis(null, 'anything else'), 'website');
});

// The posting rules every salesperson ticks (legal/posting-rules.md,
// src/postingRules.js) say to change a listing's price only when the website
// changes: no made-up drops, no raising a price to lower it later. A dealer
// switching "Price to post" to the lower second price and back, with the
// website unchanged, must therefore never ask for a price edit on a listing
// already posted, either way, nor count one in the numbers or the scan counts.
test('switching the price setting there and back asks for no price edit on a posted listing, either way', () => {
  const s = snapshot(LOT);
  const at = '2026-09-26T21:00:00.000Z';
  for (const postedOn of ['website', 'beforeFees']) {
    const posted = markPosted(markPosted({}, s.vehicles[VIN.ram], postedOn, at), s.vehicles[VIN.tradesman], postedOn, at);
    for (const basis of ['beforeFees', 'website', 'beforeFees']) {
      const d = diffScans(s, s, { posted, confirm: confirmed(), basis });
      assert.deepEqual(d.priceUpdates, [], `posted on ${postedOn}, scanned on ${basis}: no price to edit`);
      assert.equal(noteFlags(null, d).flags.length, 0, 'nothing for the numbers');
      assert.equal(scanFromStored({ snapshot: s, diff: { ...d, takenAt: at } }).priceUpdateCount, 0, 'nor for the scan counts');
    }
  }
});

test('website switches to "call for price": needs a look', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: { low: false, high: { label: 'Price', value: 'Please call for price' } } } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed() });
  assert.equal(d.priceUpdates.length, 0);
  assert.equal(d.needsALook.length, 1);
  assert.match(d.needsALook[0].text, /no longer shows a price/);
});

test('under the "before fees" basis, "call for price" still needs a look, and a hidden number never becomes a price update', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 26673 } }; // posted at the "Was" line
  const call = { low: false, high: { label: 'Price', value: 'Please call for price' } };
  // the display says call for price; the hidden internet_price is still 26673
  const day2 = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: call } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d2 = diffScans(snapshot(LOT), day2, { posted, confirm: confirmed(), basis: 'beforeFees' });
  assert.equal(d2.priceUpdates.length, 0);
  assert.equal(d2.needsALook.length, 1);
  assert.match(d2.needsALook[0].text, /no longer shows a price/);
  assert.equal(listingStatus(day2.vehicles[VIN.ram], 26673, basisPrice(day2.vehicles[VIN.ram], 'beforeFees')).text, 'Website no longer shows a price');
  // the hidden number changes while the page still says call for price: not a price the website shows
  const day3 = snapshot([['usedNormal', { pricing: { internet_price: 24999, price: 24999 }, extra_fields: { lightning: { pricing: call } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d3 = diffScans(day2, day3, { posted, confirm: confirmed(), basis: 'beforeFees' });
  assert.equal(d3.priceUpdates.length, 0);
  assert.match(d3.needsALook.map((n) => n.text).join(' '), /no longer shows a price/);
});

test('settleDiff: a diff saved after a long scan drops the salesperson\'s items handled meanwhile, and keeps everything else', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 }, [VIN.hellcat]: { name: 'Hellcat', price: 53485 }, [VIN.tradesman]: { name: 'Tradesman', price: 33485 } };
  const curr = snapshot([['usedNormal', { status: 'pend-sale' }], ['certified'], ['usedNoPhotos', { extra_fields: { lightning: { pricing: { low: { value: '32485' } } } } }]]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: { checked: [], notFound: [], error: null } });
  assert.deepEqual(d.takeDown.map((t) => t.vin), [VIN.ram]);
  assert.deepEqual(d.priceUpdates.map((u) => u.vin), [VIN.tradesman]);
  assert.deepEqual(d.needsALook.map((n) => n.vin), [VIN.hellcat], 'the posted car missing from this scan');
  // meanwhile: the Ram taken down, the Tradesman's price updated, the Hellcat taken down
  const now = { [VIN.tradesman]: { ...posted[VIN.tradesman], price: 32485 } };
  const settled = settleDiff(d, now);
  assert.deepEqual([settled.takeDown, settled.priceUpdates, settled.needsALook], [[], [], []]);
  assert.equal(settled.counts, d.counts, 'the rest of the diff as it was');
  // nothing handled: nothing changes; a price updated to another number keeps the item
  assert.deepEqual(settleDiff(d, posted), d);
  assert.deepEqual(settleDiff(d, { ...posted, [VIN.tradesman]: { ...posted[VIN.tradesman], price: 30000 } }).priceUpdates.map((u) => u.vin), [VIN.tradesman]);
  // a colleague's car (mine: false) is never the salesperson's item; items about the lot are kept
  const lot = { ...d, newArrivals: [{ vin: 'X' }], priceUpdates: [...d.priceUpdates, { vin: VIN.wagoneer, yours: false, from: 1, to: 2 }] };
  assert.deepEqual(settleDiff(lot, { ...posted, [VIN.ram]: { ...posted[VIN.ram], mine: false } }).takeDown, []);
  assert.deepEqual(settleDiff(lot, {}).priceUpdates.map((u) => u.vin), [VIN.wagoneer]);
  assert.deepEqual(settleDiff(lot, {}).newArrivals, [{ vin: 'X' }]);
  assert.equal(settleDiff(null, posted), null);
});

test('car you posted goes sale-pending: take down', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { status: 'pend-sale' }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed() });
  assert.equal(d.takeDown.length, 1);
  assert.equal(d.takeDown[0].why, 'sale-pending');
});

test('a posted car stays on Take down on every scan while the website marks it sale-pending or sold, until Taken down', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const pending = snapshot([['usedNormal', { status: 'pend-sale' }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const first = diffScans(snapshot(LOT), pending, { posted, confirm: confirmed() });
  const again = diffScans(pending, pending, { posted, confirm: confirmed() }); // the next rescan: the saved snapshot already says pending
  for (const d of [first, again]) assert.deepEqual(d.takeDown.map((t) => [t.vin, t.why, t.text, t.yours]), [[VIN.ram, 'sale-pending', 'Sale pending on the website', true]]);
  // a website that marks the car sold (a schema.org SoldOut offer reads "Sold") says sold, scan after scan
  const sold = snapshot([['usedNormal', { extra_fields: { lightning: { statusLabel: 'Sold' } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  for (const prev of [snapshot(LOT), sold]) assert.deepEqual(diffScans(prev, sold, { posted, confirm: confirmed() }).takeDown.map((t) => t.text), ['Marked sold on the website']);
  // Taken down ends it; the car back for sale ends it
  assert.deepEqual(diffScans(pending, pending, { posted: markTakenDown(posted, VIN.ram), confirm: confirmed() }).takeDown, []);
  assert.deepEqual(diffScans(pending, snapshot(LOT), { posted, confirm: confirmed() }).takeDown, []);
});

// A posted car the website now calls new, demo or loaner has to come down
// (dealers may not list those): it goes under Take down on every scan, as a
// car not sold. One whose details need a look stays under Needs a look on
// every scan until the salesperson dismisses it for the reason shown; a new
// reason raises it again.
test('a posted car the website retypes new goes under Take down, and one that needs a look can be dismissed for its reason', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const retyped = snapshot([['usedNormal', { type: 'New', vdp_url: 'https://x.com/inventory/new-2019-ram-1500-x/', extra_fields: { title: 'New 2019 Ram 1500 Classic Express', readable_type: 'New', lightning: { inventoryType: 'New', vdp_title: 'New 2019 Ram 1500 Classic Express' } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  assert.equal(retyped.vehicles[VIN.ram].decision, 'skip', 'every sign now says new');
  const disagree = snapshot([['usedNormal', { vdp_url: 'https://x.com/inventory/new-2019-ram-1500-x/' }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  assert.equal(disagree.vehicles[VIN.ram].decision, 'review', 'the signs disagree');
  for (const prev of [snapshot(LOT), retyped]) {
    const d = diffScans(prev, retyped, { posted, confirm: confirmed() });
    assert.deepEqual(d.takeDown.map((t) => [t.vin, t.yours, t.why, t.lastPrice]), [[VIN.ram, true, 'not-pre-owned', 27163]]);
    assert.equal(d.takeDown[0].text, `${retyped.vehicles[VIN.ram].reason} Delete the listing: the car was not sold.`);
    assert.deepEqual(d.needsALook, [], 'not under Needs a look as well');
  }
  for (const prev of [snapshot(LOT), disagree]) {
    const d = diffScans(prev, disagree, { posted, confirm: confirmed() });
    assert.deepEqual(d.needsALook.map((n) => [n.vin, n.yours, n.why, n.text]), [[VIN.ram, true, 'review', disagree.vehicles[VIN.ram].reason]]);
    assert.deepEqual(d.takeDown, []);
  }
  for (const now of [retyped, disagree]) {
    const d = diffScans(now, now, { posted: {}, confirm: confirmed() });
    assert.deepEqual([d.takeDown, d.needsALook], [[], []], 'not posted: the Review tab holds it, To do does not');
  }
  // sale pending and retyped new: one take-down, the website's sold word first
  const both = snapshot([['usedNormal', { type: 'New', status: 'pend-sale', vdp_url: 'https://x.com/inventory/new-2019-ram-1500-x/', extra_fields: { title: 'New 2019 Ram 1500 Classic Express', readable_type: 'New', lightning: { inventoryType: 'New', vdp_title: 'New 2019 Ram 1500 Classic Express' } } }]]);
  assert.deepEqual(diffScans(both, both, { posted, confirm: confirmed() }).takeDown.map((t) => t.why), ['sale-pending']);

  // Dismiss: off To do while the website gives the same reason, back with another
  const reason = disagree.vehicles[VIN.ram].reason;
  const dismissed = markLookDismissed(posted, VIN.ram, reason, AT);
  assert.deepEqual(dismissed[VIN.ram], { name: 'Ram', price: 27163, lookDismissed: { reason, at: AT } });
  assert.deepEqual(diffScans(disagree, disagree, { posted: dismissed, confirm: confirmed() }).needsALook, []);
  assert.deepEqual(posted[VIN.ram].lookDismissed, undefined, 'the input is not changed');
  const otherReason = snapshot([['usedNormal', { mileage: 3 }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  assert.equal(otherReason.vehicles[VIN.ram].decision, 'review');
  assert.notEqual(otherReason.vehicles[VIN.ram].reason, reason);
  assert.deepEqual(diffScans(disagree, otherReason, { posted: dismissed, confirm: confirmed() }).needsALook.map((n) => n.text), [otherReason.vehicles[VIN.ram].reason], 'another reason raises it again');
  // a dismissal never hides a take-down, a price change or a missing car
  assert.deepEqual(diffScans(disagree, retyped, { posted: dismissed, confirm: confirmed() }).takeDown.map((t) => t.why), ['not-pre-owned']);
  assert.deepEqual(diffScans(disagree, snapshot([]), { posted: dismissed, confirm: { checked: [VIN.ram], notFound: [] } }).needsALook.filter((n) => n.yours).map((n) => n.vin), [VIN.ram]);
  // nothing to dismiss: an entry not posted, or no reason
  assert.equal(markLookDismissed(posted, 'NOPE', reason), posted);
  assert.equal(markLookDismissed(posted, VIN.ram, ''), posted);
  assert.equal(lookDismissed(dismissed[VIN.ram], reason), true);
  assert.equal(lookDismissed(posted[VIN.ram], reason), false);
});

test('My listings: sold, sale-pending and held back by the pre-owned check come before a price change', () => {
  const entry = (patch) => snapshot([['usedNormal', patch]]).vehicles[VIN.ram];
  assert.deepEqual(listingStatus(null, 27163, null), { tone: 'bad', text: 'Not on the website at the last scan' });
  assert.deepEqual(listingStatus(entry({ status: 'pend-sale' }), 27163, 26163), { tone: 'bad', text: 'Sale pending on the website' });
  assert.deepEqual(listingStatus(entry({ extra_fields: { lightning: { statusLabel: 'Sold' } } }), 27163, 27163), { tone: 'bad', text: 'Marked sold on the website' });
  assert.deepEqual(listingStatus(entry({ vdp_url: 'https://x.com/inventory/new-2019-ram-1500-x/' }), 27163, 27163), { tone: 'warn', text: 'Needs a look (see To do)' });
  assert.deepEqual(listingStatus({ decision: 'skip' }, 27163, 27163), { tone: 'bad', text: 'Not pre-owned on the website' });
  assert.deepEqual(listingStatus(entry(), 28000, 27163), { tone: 'warn', text: 'Website price changed', priceChanged: true });
  assert.deepEqual(listingStatus(entry(), 27163, 27163), { tone: 'good', text: 'Matches the website' });
  assert.equal(pendingText({ statusLabel: 'Reserved (sale pending)' }), 'Sale pending on the website');
  assert.equal(pendingText({ status: 'publish', statusLabel: '' }), null);
});

test('My listings: a posted car whose website price is gone says so, as To do does, not "Matches the website"', () => {
  const entry = snapshot([['usedNormal']]).vehicles[VIN.ram];
  const noPrice = { ...entry, price: null, priceLabel: 'call for price' };
  const status = listingStatus(noPrice, 27163, null);
  assert.deepEqual(status, { tone: 'warn', text: 'Website no longer shows a price' });
  const posted = markPosted({}, { vin: VIN.ram, name: entry.name, price: 27163 });
  const todo = diffScans({ vehicles: { [VIN.ram]: entry } }, { vehicles: { [VIN.ram]: noPrice } }, { posted, confirm: confirmed() }).needsALook.map((n) => n.text);
  assert.ok(todo.some((t) => t.startsWith(status.text)), `To do says ${JSON.stringify(todo)}`);
  assert.deepEqual(listingStatus(noPrice, null, null), { tone: 'good', text: 'Matches the website' }, 'a listing posted without a price still matches');
});

test('new arrival shows up with its decision', () => {
  const curr = snapshot([...LOT, ['usedZeroMiles']]);
  const d = diffScans(snapshot(LOT), curr, { confirm: confirmed() });
  assert.equal(d.newArrivals.length, 1);
  assert.equal(d.newArrivals[0].vin, fixtures.usedZeroMiles.vin);
  assert.equal(d.newArrivals[0].decision, 'review');
});

test('car that just got photos becomes ready', () => {
  const settings = {}; // no store filter
  const prev = snapshot(LOT, settings);
  const curr = snapshot([['usedNormal'], ['certified'], ['usedNoCarfax'], ['usedNoPhotos', { media: { image_count: 18 } }]], settings);
  const d = diffScans(prev, curr, { confirm: confirmed() });
  assert.equal(d.nowReady.length, 1);
  assert.equal(d.nowReady[0].vin, VIN.tradesman);
  assert.equal(d.nowReady[0].what, 'photos added');
});

test('a posted car that stops passing the pre-owned check needs a look', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { vdp_url: 'https://x.com/inventory/new-2019-ram-1500-x/' }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed() });
  assert.equal(d.needsALook.length, 1);
  assert.equal(d.needsALook[0].yours, true);
});

test('a colleague\'s entry (mine: false, merged in by sync) is never yours: no take-down or price flag as yours, no posted-price comparison', () => {
  const posted = {
    [VIN.ram]: { name: 'Ram', price: 27163, postedAt: '2026-09-26T21:00:00.000Z' }, // own: no flag
    [VIN.hellcat]: { name: 'Hellcat', price: 50000, postedAt: '2026-09-26T21:00:00.000Z', userId: 'u2', mine: false }, // a colleague's
  };
  // both cars gone: yours is the Ram only, and the colleague's car still shows, after yours
  const gone = diffScans(snapshot(LOT), snapshot([['certified'], ['usedNoPhotos']]), { posted, confirm: confirmed(VIN.ram, VIN.hellcat) });
  assert.deepEqual(gone.takeDown.map((t) => [t.vin, t.yours]), [[VIN.ram, true], [VIN.hellcat, false]]);
  assert.equal(gone.takeDown[1].lastPrice, 53485, 'the website price, not the colleague\'s listing price');
  // the colleague's listing price is not compared with the website (their machine does that); the last scan's is
  const same = diffScans(snapshot(LOT), snapshot(LOT), { posted, confirm: confirmed() });
  assert.deepEqual(same.priceUpdates, []);
  assert.deepEqual(same.needsALook, []);
  // the colleague's car goes sale-pending: not a take-down of yours
  const pending = diffScans(snapshot(LOT), snapshot([['usedNormal'], ['certified'], ['usedNoCarfax', { status: 'pend-sale' }], ['usedNoPhotos']]), { posted, confirm: confirmed() });
  assert.deepEqual(pending.takeDown, []);
  // an entry with userId but no flag (an own entry the server labelled) is still yours
  const labelled = { [VIN.ram]: { name: 'Ram', price: 27163, userId: 'u1' } };
  const d = diffScans(snapshot(LOT), snapshot(LOT.filter(([n]) => n !== 'usedNormal')), { posted: labelled, confirm: confirmed(VIN.ram) });
  assert.equal(d.takeDown[0].yours, true);
});

test('posted-listing bookkeeping', () => {
  const s = snapshot(LOT);
  let posted = markPosted({}, s.vehicles[VIN.ram], 'website', '2026-09-26T21:00:00.000Z');
  assert.deepEqual(posted[VIN.ram], { name: '2019 Ram 1500 Classic Express', price: 27163, basis: 'website', postedAt: '2026-09-26T21:00:00.000Z' });
  posted = markPriceUpdated(posted, VIN.ram, 26163, '2026-09-27T21:00:00.000Z');
  assert.equal(posted[VIN.ram].price, 26163);
  assert.equal(posted[VIN.ram].basis, 'website', 'an updated price stays on the basis the listing was posted at');
  posted = markTakenDown(posted, VIN.ram);
  assert.deepEqual(posted, {});
});

// Rule 4: price changes only mirror the website. A listing keeps the price
// basis it was posted with, so the dealer switching Settings (Price to post)
// never turns a listing into a price change the website didn't make.
// A copy of a snapshot with one car's website prices changed.
const repriced = (s, vin, price, priceBeforeFees) => ({ ...s, vehicles: { ...s.vehicles, [vin]: { ...s.vehicles[vin], price, priceBeforeFees } } });
const moves = (d) => d.priceUpdates.map(({ vin, from, to, change, yours }) => ({ vin, from, to, change, yours }));
const AT = '2026-09-26T21:00:00.000Z';

test('a posted listing keeps the price basis it was posted with: switching the setting is not a price change', () => {
  const s = snapshot(LOT); // the Ram: 27,163 main, 26,673 before fees
  for (const [postedAs, setting] of [['website', 'beforeFees'], ['beforeFees', 'website']]) {
    const posted = markPosted({}, s.vehicles[VIN.ram], postedAs, AT);
    assert.equal(posted[VIN.ram].basis, postedAs, 'the entry records the basis');
    const d = diffScans(s, snapshot(LOT), { posted, confirm: confirmed(), basis: setting });
    assert.deepEqual(moves(d), [], `posted at the ${postedAs} price, setting now ${setting}, website unchanged: nothing to update`);
  }
  // a real drop on the website still shows, at the price of the basis the listing carries
  const posted = markPosted({}, s.vehicles[VIN.ram], 'website', AT);
  const dropped = repriced(snapshot(LOT), VIN.ram, 26163, 25673);
  assert.deepEqual(moves(diffScans(s, dropped, { posted, confirm: confirmed(), basis: 'beforeFees' })), [{ vin: VIN.ram, from: 27163, to: 26163, change: -1000, yours: true }]);
  // updating the listing keeps its basis, so the next scan has nothing left
  const updated = markPriceUpdated(posted, VIN.ram, 26163, '2026-09-27T21:00:00.000Z');
  assert.equal(updated[VIN.ram].basis, 'website');
  assert.deepEqual(moves(diffScans(dropped, dropped, { posted: updated, confirm: confirmed(), basis: 'beforeFees' })), []);
  // a car nobody posted is compared scan to scan under the current setting, as before
  assert.deepEqual(moves(diffScans(s, dropped, { confirm: confirmed(), basis: 'beforeFees' })), [{ vin: VIN.ram, from: 26673, to: 25673, change: -1000, yours: false }]);
});

test('a listing posted before the basis was recorded: its basis is the website price it carries', () => {
  const s = snapshot(LOT);
  const entry = (price) => ({ [VIN.ram]: { name: 'Ram', price, postedAt: AT } });
  assert.equal(postedBasis(entry(27163)[VIN.ram], 'beforeFees', [s.vehicles[VIN.ram]]), 'website');
  assert.equal(postedBasis(entry(26673)[VIN.ram], 'website', [s.vehicles[VIN.ram]]), 'beforeFees');
  assert.equal(postedBasis({ price: 26673, basis: 'website' }, 'beforeFees', [s.vehicles[VIN.ram]]), 'website', 'a recorded basis wins');
  assert.equal(postedBasis({ price: 20000 }, 'beforeFees', [{ price: 20000 }]), 'beforeFees', 'both bases give the same price: the setting');
  assert.deepEqual(moves(diffScans(s, snapshot(LOT), { posted: entry(27163), confirm: confirmed(), basis: 'beforeFees' })), []);
  assert.deepEqual(moves(diffScans(s, snapshot(LOT), { posted: entry(26673), confirm: confirmed(), basis: 'website' })), []);
  // with no earlier scan (a first scan) the car as the website shows it now decides
  assert.deepEqual(moves(diffScans(null, snapshot(LOT), { posted: entry(27163), basis: 'beforeFees' })), []);
  // a real drop still shows, at the listing's own basis
  const dropped = repriced(snapshot(LOT), VIN.ram, 26163, 25673);
  assert.deepEqual(moves(diffScans(s, dropped, { posted: entry(26673), confirm: confirmed(), basis: 'website' })), [{ vin: VIN.ram, from: 26673, to: 25673, change: -1000, yours: true }]);
  // a listing price that matches no website price is a real difference: compared under the setting, as before
  assert.deepEqual(moves(diffScans(s, snapshot(LOT), { posted: entry(28000), confirm: confirmed(), basis: 'beforeFees' })), [{ vin: VIN.ram, from: 28000, to: 26673, change: -1327, yours: true }]);
});

// An entry with no basis (brought by a sync from a server row that has none) is
// read off the scans only while one basis still gives its price. Once the
// website moves the price, nothing but the setting would be left, and a
// listing posted at the main price would be asked for the website's drop plus
// the doc-fee gap. The scan that reads the basis records it (withSeenBasis).
test('a basis read off a scan is kept on the entry: a real drop never grows by the doc-fee gap on the next scan', () => {
  const s = snapshot(LOT); // the Ram: 27,163 main, 26,673 before fees
  const synced = { [VIN.ram]: { name: 'Ram', price: 27163, postedAt: AT } }; // posted at the main price elsewhere, no basis
  const dropped = repriced(snapshot(LOT), VIN.ram, 26663, 26173); // the website drops $500
  const first = diffScans(s, dropped, { posted: synced, confirm: confirmed(), basis: 'beforeFees' });
  assert.deepEqual(moves(first), [{ vin: VIN.ram, from: 27163, to: 26663, change: -500, yours: true }]);
  const kept = withSeenBasis(synced, s, dropped);
  assert.deepEqual(kept[VIN.ram], { name: 'Ram', price: 27163, postedAt: AT, basis: 'website' });
  // the next scan, the website unchanged: still the website's $500, not $990
  assert.deepEqual(moves(diffScans(dropped, dropped, { posted: kept, confirm: confirmed(), basis: 'beforeFees' })), [{ vin: VIN.ram, from: 27163, to: 26663, change: -500, yours: true }]);
  assert.equal(listingWebsitePrice(kept[VIN.ram], dropped.vehicles[VIN.ram], 'beforeFees'), 26663, 'My listings agrees');
  // without it, that next scan would have nothing but the setting to go by
  assert.deepEqual(moves(diffScans(dropped, dropped, { posted: synced, confirm: confirmed(), basis: 'beforeFees' })).map((m) => m.change), [-990]);
  // posted at the lower second price: read and kept the same way
  assert.equal(withSeenBasis({ [VIN.ram]: { price: 26673 } }, s, dropped)[VIN.ram].basis, 'beforeFees');
  // read from this scan when the last one doesn't settle it (a first scan, or a car new to the list)
  assert.equal(withSeenBasis(synced, null, s)[VIN.ram].basis, 'website');
  // nothing to record: a basis already there, both bases giving the price, neither giving it, a car not in either scan
  assert.equal(withSeenBasis({ [VIN.ram]: { price: 27163, basis: 'beforeFees' } }, s, s), undefined);
  assert.equal(withSeenBasis({ X: { price: 20000 } }, { vehicles: { X: { price: 20000 } } }, { vehicles: { X: { price: 20000 } } }), undefined);
  assert.equal(withSeenBasis({ [VIN.ram]: { price: 28000 } }, s, dropped), undefined);
  assert.equal(withSeenBasis({ GONE: { price: 27163 } }, s, dropped), undefined);
  assert.equal(withSeenBasis(null, s, dropped), undefined);
  // other entries are carried over as they are
  const both = withSeenBasis({ ...synced, OTHER: { price: 1, basis: 'website' } }, s, dropped);
  assert.deepEqual(both.OTHER, { price: 1, basis: 'website' });
});

// A scan taken before a listing got its price (this computer's last scan,
// when the car was posted or its price updated on another computer and came
// by sync) shows the website as it was then. After a website price cut, the
// price the listing was given can equal the other price on that scan: read
// off it and kept on the entry, the cut would be asked for again on every
// scan. Only scans taken once the listing had its price (updatedAt, else
// postedAt) are read, by the rescan, by the scan that records the basis and
// by a change of Price to post.
test('a scan from before a listing got its price never decides its basis: a website cut made before the post is not asked for again', () => {
  const at = (day) => `2026-10-0${day}T09:00:00.000Z`;
  const shows = (day, price, lower) => repriced(snapshot(LOT, MY_STORE, at(day)), VIN.ram, price, lower);
  // this computer's last scan: $1,000 between the two prices; the website then cuts $1,000,
  // and the car is posted on another computer at the new main price; it arrives by sync with no basis
  const last = shows(1, 27163, 26163);
  const synced = { [VIN.ram]: { name: 'Ram', price: 26163, postedAt: at(2) } };
  let posted = synced;
  let prev = last;
  for (const day of [3, 4, 5]) {
    const scan = shows(day, 26163, 25163);
    assert.deepEqual(moves(diffScans(prev, scan, { posted, confirm: confirmed(), basis: 'website' })), [], `scan of day ${day}: the website made no change since the post`);
    posted = withSeenBasis(posted, prev, scan) || posted;
    prev = scan;
  }
  assert.equal(posted[VIN.ram].basis, 'website', 'read off the first scan taken after the post');
  // the same for a listing whose price was updated on another computer after this computer's last scan
  const updated = { [VIN.ram]: { name: 'Ram', price: 26163, postedAt: '2026-09-20T09:00:00.000Z', updatedAt: at(2) } };
  assert.deepEqual(moves(diffScans(last, shows(3, 26163, 25163), { posted: updated, confirm: confirmed(), basis: 'website' })), []);
  assert.equal(withSeenBasis(updated, last, shows(3, 26163, 25163))[VIN.ram].basis, 'website');
  // a scan from before is never read, even when it is the only one that matches: nothing is recorded
  assert.equal(withSeenBasis(synced, last, shows(3, 26663, 25663)), undefined);
  // a change of Price to post before the next scan leaves such a listing for that scan to read
  assert.equal(withPostedBasis(synced, 'website', last), undefined);
  assert.deepEqual(moves(diffScans(last, shows(3, 26163, 25163), { posted: synced, confirm: confirmed(), basis: 'beforeFees' })), []);
  // a scan taken once the listing had its price is read as before, by each of them
  assert.equal(withPostedBasis(synced, 'beforeFees', shows(2, 26163, 25163))[VIN.ram].basis, 'website');
  assert.equal(withPostedBasis({ [VIN.ram]: { name: 'Ram', price: 26163, postedAt: '2026-09-20T09:00:00.000Z' } }, 'website', last)[VIN.ram].basis, 'beforeFees');
  assert.equal(withSeenBasis(synced, shows(2, 26163, 25163), shows(3, 26663, 25663))[VIN.ram].basis, 'website', 'the oldest scan since the post decides');
});

// My listings (popup.js viewMine) takes each listing's line from listingLine,
// with the basis read as the rescan reads it (scanCar, postedBasis). On a
// last scan taken before the listing got its price, a website price that
// differs from the listing's is the website as it was before, not a change
// since: no price is named, there is nothing for Updated to record, and the
// price is compared at the next scan. What the scan says about the car
// itself (gone, sold, sale-pending, held back by the pre-owned check) shows
// as before, as To do raises it on every scan.
test('My listings\' line: a scan from before the listing\'s price names no price of its own and offers nothing to record; a scan since reads as the rescan does', () => {
  const line = rescan.listingLine;
  assert.equal(typeof line, 'function', 'rescan.js exports listingLine');
  const at = (day) => `2026-10-0${day}T09:00:00.000Z`;
  const shows = (day, price, lower) => repriced(snapshot(LOT, MY_STORE, at(day)), VIN.ram, price, lower);
  const WAITS = { tone: '', text: 'Price compared at the next scan', waits: true };
  const MATCHES = { tone: 'good', text: 'Matches the website' };
  const parts = (l) => [l.basis, l.site, l.status];

  // the last scan here is from before the website's $500 cut; the listing was posted after it, elsewhere, with no basis
  const before = shows(1, 27663, 27173);
  const synced = { name: 'Ram', price: 27163, postedAt: at(2) };
  assert.deepEqual(parts(line(synced, before, VIN.ram, 'beforeFees')), ['beforeFees', null, WAITS], 'on neither price: the setting\'s older price is not named');
  assert.deepEqual(parts(line(synced, before, VIN.ram, 'website')), ['website', null, WAITS]);
  // cut by exactly the gap: the older scan's lower price is the listing's, and is not read as its basis
  const gap = shows(1, 27163, 26673);
  assert.deepEqual(parts(line({ ...synced, price: 26673 }, gap, VIN.ram, 'website')), ['website', null, WAITS]);
  // the price the setting gives on that scan is the listing's: it matches, nothing is read and nothing offered
  assert.deepEqual(parts(line({ ...synced, price: 27663 }, before, VIN.ram, 'website')), ['website', 27663, MATCHES]);
  // the same for a listing that carries its basis (posted here after the scan, at the price read when the form was filled)
  assert.deepEqual(parts(line({ ...synced, basis: 'website' }, before, VIN.ram, 'beforeFees')), ['website', null, WAITS]);
  assert.deepEqual(parts(line({ ...synced, price: 27173, basis: 'beforeFees' }, before, VIN.ram, 'website')), ['beforeFees', 27173, MATCHES]);
  // a price updated after the scan counts from the update
  const updated = { name: 'Ram', price: 27163, basis: 'website', postedAt: '2026-09-20T09:00:00.000Z', updatedAt: at(2) };
  assert.deepEqual(parts(line(updated, before, VIN.ram, 'website')), ['website', null, WAITS]);
  // the website's call for price on a scan from before is not "no longer shows a price" either
  const noPrice = repriced(before, VIN.ram, null, null);
  assert.deepEqual(parts(line(synced, noPrice, VIN.ram, 'website')), ['website', null, WAITS]);
  // what the scan says about the car itself still shows, and names no price of that scan's but the listing's own
  // (on the lower second price, its pre-cut $27,173 is not the website's now)
  const held = (snap, patch) => ({ ...snap, vehicles: { ...snap.vehicles, [VIN.ram]: { ...snap.vehicles[VIN.ram], ...patch } } });
  const HELD = [[{ status: 'pend-sale' }, 'Sale pending on the website'], [{ decision: 'skip' }, 'Not pre-owned on the website'], [{ decision: 'review' }, 'Needs a look (see To do)']];
  for (const [patch, text] of HELD) {
    for (const basis of ['website', 'beforeFees']) {
      const l = line(synced, held(before, patch), VIN.ram, basis);
      assert.deepEqual([l.status.text, l.site, l.compared], [text, null, false], `${text}, ${basis}: no price of a scan from before`);
    }
    assert.deepEqual([line({ ...synced, price: 27663 }, held(before, patch), VIN.ram, 'website').site, line({ ...synced, price: 27663 }, held(before, patch), VIN.ram, 'website').status.text], [27663, text], 'the listing\'s own price on it');
    // on a scan since, the website price is named as before
    const l = line(synced, held(shows(3, 26663, 26173), patch), VIN.ram, 'beforeFees');
    assert.deepEqual([l.status.text, l.site, l.compared], [text, 26173, true], `${text}: a scan since names it`);
  }
  assert.equal(line(synced, before, VIN.ram, 'website').compared, false);
  assert.deepEqual(parts(line(synced, snapshot([], MY_STORE, at(1)), VIN.ram, 'website')), ['website', null, { tone: 'bad', text: 'Not on the website at the last scan' }]);
  assert.equal(line(synced, null, VIN.ram, 'website').status.text, 'Not on the website at the last scan', 'no scan at all');
  // a scan with no time, for a listing that has one, is from before as far as anyone can tell
  assert.deepEqual(parts(line(synced, { ...before, takenAt: undefined }, VIN.ram, 'website')), ['website', null, WAITS]);

  // a scan taken since the listing's price: as today
  const since = shows(3, 27163, 26673);
  assert.deepEqual(parts(line({ ...synced, price: 26673 }, since, VIN.ram, 'website')), ['beforeFees', 26673, MATCHES], 'the basis read off it');
  assert.deepEqual(parts(line(synced, since, VIN.ram, 'beforeFees')), ['website', 27163, MATCHES]);
  assert.deepEqual(parts(line({ ...synced, price: 27663 }, since, VIN.ram, 'website')), ['website', 27163, { tone: 'warn', text: 'Website price changed', priceChanged: true }], 'on neither price: the setting, and Updated records its price');
  assert.deepEqual(parts(line({ ...synced, price: 27663 }, since, VIN.ram, 'beforeFees')), ['beforeFees', 26673, { tone: 'warn', text: 'Website price changed', priceChanged: true }]);
  assert.deepEqual(parts(line({ ...synced, price: 27663, basis: 'website' }, since, VIN.ram, 'beforeFees')), ['website', 27163, { tone: 'warn', text: 'Website price changed', priceChanged: true }]);
  assert.deepEqual(parts(line({ ...synced, postedAt: at(3) }, since, VIN.ram, 'beforeFees')), ['website', 27163, MATCHES], 'taken the moment the listing got its price counts as since');
  // a listing with no time at all is read off any scan, as the rescan reads it
  assert.deepEqual(parts(line({ name: 'Ram', price: 26673 }, gap, VIN.ram, 'website')), ['beforeFees', 26673, MATCHES]);
  // the website shows no price: said, as To do says it
  assert.deepEqual(parts(line(synced, repriced(since, VIN.ram, null, null), VIN.ram, 'website')), ['website', null, { tone: 'warn', text: 'Website no longer shows a price' }]);
  assert.equal(line(synced, repriced(since, VIN.ram, null, null), VIN.ram, 'website').compared, true, 'a scan since: its missing price is the website\'s now');
  assert.equal(line(synced, since, VIN.ram, 'website').compared, true);
  // and the line agrees with the rescan's price for the listing (listingWebsitePrice) wherever it names one
  for (const [entry, snap, basis] of [[{ ...synced, price: 26673 }, since, 'website'], [{ ...synced, price: 27663 }, since, 'beforeFees'], [{ ...synced, price: 27663 }, before, 'website']]) {
    assert.equal(line(entry, snap, VIN.ram, basis).site, listingWebsitePrice(entry, snap.vehicles[VIN.ram], basis, [rescan.scanCar(entry, snap, VIN.ram)]));
  }
});

// Every place that saves a scan records the basis it read (scanRunner.js
// keepSeenBasis): the popup's Scan, set-up's read and the background rescan,
// each handing over the scan's diff. A read held back as a website hiccup
// (diff.unreliable) records nothing: the recorded basis goes up with the next
// sync and becomes every computer's, so it comes only from a read the
// extension trusts, and the next trusted scan reads it again.
test('the popup, set-up and the background rescan each record the basis a scan reads, and none from a read held back as a hiccup', async () => {
  for (const [file, diff] of [['popup.js', 'r.diff'], ['wizard.js', 'diff'], ['background.js', 'diff']]) {
    const src = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    const calls = [...src.matchAll(/keepSeenBasis\(([^;]*)\)\.catch/g)].map((m) => m[1].split(',').map((x) => x.trim()));
    assert.equal(calls.length, 1, `${file} records it once`);
    assert.equal(calls[0][3], diff, `${file} hands over this scan's diff`);
  }
  const { keepSeenBasis } = await import('../extension/src/scanRunner.js');
  const fresh = () => ({ ['posted:' + STANDARD_ORIGIN]: { [VIN.ram]: { name: 'Ram', price: 26673, postedAt: AT } } });
  const storageOf = (store) => ({ get: async (key) => ({ [key]: store[key] }), set: async (obj) => Object.assign(store, obj), lock: (name, fn) => fn() });
  const lot = snapshot(LOT); // the Ram: $27,163, or $26,673 before the fee
  const trusted = diffScans(snapshot(LOT), lot, { confirm: confirmed() });
  assert.equal(trusted.unreliable, false);
  const store = fresh();
  await keepSeenBasis(STANDARD_ORIGIN, null, lot, trusted, storageOf(store));
  assert.equal(store['posted:' + STANDARD_ORIGIN][VIN.ram].basis, 'beforeFees', 'a trusted read records the basis it shows');
  // the same read, judged a website hiccup and held back: nothing recorded
  for (const diff of [{ ...trusted, unreliable: true }, null, undefined, {}]) {
    const held = fresh();
    assert.equal(await keepSeenBasis(STANDARD_ORIGIN, null, lot, diff, storageOf(held)), undefined);
    assert.equal(held['posted:' + STANDARD_ORIGIN][VIN.ram].basis, undefined, `nothing recorded with the diff ${JSON.stringify(diff && { unreliable: diff.unreliable })}`);
  }
});

// My listings (popup.js viewMine), as written, with the page around it
// stubbed: each row's parts are collected as viewMine hands them over.
// `snap`: the last scan.
function myListings(posted, snap, basis) {
  const src = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const start = src.indexOf('function viewMine(');
  assert.ok(start >= 0, 'viewMine is defined');
  const state = { settings: { basis }, snapshot: snap };
  const shown = [];
  const scope = {
    state,
    esc: (x) => String(x ?? ''),
    empty: (x) => x,
    rows: (items) => items.join(''),
    row: (entry, parts) => { shown.push(parts); return ''; },
    money: (n) => `$${n}`,
    when: (x) => String(x),
    day: (x) => String(x),
    // the listing's line from the last scan (rescan.js listingLine) and the basis the setting gives (postedBasis)
    postedBasis: rescan.postedBasis,
    listingLine: rescan.listingLine,
    notShared: () => null,
    notSharedText: String,
    viewColleagues: () => '',
    openListing: () => '', // the Open listing link (popup.test.js checks it)
  };
  const viewMine = new Function(...Object.keys(scope), `${src.slice(start, src.indexOf('\n}\n', start) + 2)}\nreturn viewMine;`)(...Object.values(scope));
  viewMine({ mine: Object.entries(posted).map(([vin, p]) => ({ vin, ...p, now: snap.vehicles[vin] || null })) });
  return shown.map((r) => ({ changed: /Website price changed/.test(r.sub), right: r.right, updated: (r.action.match(/data-action="priceUpdated"[^>]*data-price="(\d+)"/) || [])[1] || null }));
}

test('My listings compares each listing on its own price basis: a switch of Price to post is not a change, and Updated records the listing\'s basis price', () => {
  const s = snapshot(LOT); // the Ram: 27,163 main, 26,673 before fees
  for (const [postedAs, setting] of [['website', 'beforeFees'], ['beforeFees', 'website']]) {
    const posted = markPosted({}, s.vehicles[VIN.ram], postedAs, AT);
    const [ram] = myListings(posted, s, setting);
    assert.deepEqual(ram, { changed: false, right: `Listed $${posted[VIN.ram].price}`, updated: null }, `posted at the ${postedAs} price, setting now ${setting}`);
  }
  // a listing posted before the basis was recorded: the website price it carries tells
  assert.equal(myListings({ [VIN.ram]: { name: 'Ram', price: 27163, postedAt: AT } }, s, 'beforeFees')[0].changed, false);
  assert.equal(myListings({ [VIN.ram]: { name: 'Ram', price: 26673, postedAt: AT } }, s, 'website')[0].changed, false);
  // a real drop shows at the listing's own basis, and Updated records that price: the next scan has nothing left
  const posted = markPosted({}, s.vehicles[VIN.ram], 'website', AT);
  const dropped = repriced(snapshot(LOT), VIN.ram, 26163, 25673);
  const [ram] = myListings(posted, dropped, 'beforeFees');
  assert.deepEqual(ram, { changed: true, right: 'Listed $27163<br>Website $26163', updated: '26163' });
  const updated = markPriceUpdated(posted, VIN.ram, Number(ram.updated), '2026-09-27T21:00:00.000Z');
  assert.deepEqual(moves(diffScans(dropped, dropped, { posted: updated, confirm: confirmed(), basis: 'beforeFees' })), []);
  assert.equal(myListings(updated, dropped, 'beforeFees')[0].changed, false);
  // the helper itself: the listing's basis, read from this scan when the entry has none
  assert.equal(rescan.listingWebsitePrice?.({ price: 27163, basis: 'website' }, s.vehicles[VIN.ram], 'beforeFees'), 27163);
  assert.equal(rescan.listingWebsitePrice?.({ price: 26673 }, s.vehicles[VIN.ram], 'website'), 26673);
  assert.equal(rescan.listingWebsitePrice?.({ price: 28000 }, s.vehicles[VIN.ram], 'beforeFees'), 26673, 'a price on no basis: the setting');
});

// ---------- the same rules for a website read from its own pages ----------
// (extension/adapters/schemaOrg.js: a missing car is checked at the page the
// last scan kept for it, which scanWithSearch hands over as confirmUrls)

const STD = { kind: 'schemaOrg', origin: STANDARD_ORIGIN, listUrl: STANDARD_ORIGIN + '/used-vehicles/' };
const STD_SITE = { origin: STANDARD_ORIGIN, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
async function standardRescan(cars, today, change = () => {}) {
  const settings = withDefaults({}, STD_SITE);
  const first = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars, perPage: 10 })), site: STD_SITE, settings, options: schemaOrg.scanOptions(STD) });
  assert.equal(first.ok, true);
  const site = standardSite({ cars: today, perPage: 10 });
  change(site);
  const seen = [];
  const spy = { ...schemaOrg, scan: (search, options) => { seen.push(options); return schemaOrg.scan(search, options); } };
  const out = await scanWithSearch({ adapter: spy, search: fakeSiteSearch(site), site: STD_SITE, settings, prevSnapshot: first.snapshot, options: schemaOrg.scanOptions(STD) });
  assert.equal(out.ok, true);
  return { first, out, options: seen[0] };
}

test('a website read from its pages: 11 of 20 cars gone at once, each page answering 404, marks nothing gone', async () => {
  const cars = standardCars(20);
  const { first, out, options } = await standardRescan(cars, cars.slice(11));
  assert.deepEqual(options.confirmUrls, Object.fromEntries(cars.map((c) => [c.vin, STANDARD_ORIGIN + c.path])), 'every car\'s last page, from the last snapshot');
  assert.equal(options.lastSeen, first.snapshot.vehicles);
  assert.equal(out.res.confirm.notFound.length, 11, 'each page said 404');
  assert.equal(out.diff.unreliable, true);
  assert.deepEqual(out.diff.takeDown, []);
  assert.equal(out.diff.needsALook.length, 11);
  assert.match(out.diff.warnings.join(' '), /11 of 20 cars disappeared at once/);
});

test('a website read from its pages: half the lot gone, each page confirming it, is taken down', async () => {
  const cars = standardCars(20);
  const { out } = await standardRescan(cars, cars.slice(10));
  assert.equal(out.diff.unreliable, false);
  assert.equal(out.diff.takeDown.length, 10);
  assert.ok(out.diff.takeDown.every((t) => t.why === 'gone'));
});

test('a website read from its pages: a missing car whose page could not be checked is never marked gone', async () => {
  const cars = standardCars(12);
  // a refusal stops the whole check: nothing is marked gone, and the scan says so
  for (const status of [403, 429, 503]) {
    const { out } = await standardRescan(cars, cars.slice(1), (site) => site.set(STANDARD_ORIGIN + cars[0].path, httpError(status)));
    assert.match(out.res.confirm.error, new RegExp(String(status)));
    assert.deepEqual(out.diff.takeDown, [], `HTTP ${status}`);
    assert.deepEqual(out.diff.needsALook.map((n) => n.vin), [cars[0].vin]);
    assert.match(out.diff.warnings.join(' '), /Couldn't double-check missing cars .*Nothing was marked as gone/);
  }
  // any other failure leaves that one car unchecked, under Needs a look with the reason
  const { out } = await standardRescan(cars, cars.slice(1), (site) => site.set(STANDARD_ORIGIN + cars[0].path, httpError(500)));
  assert.equal(out.res.confirm.error, null);
  assert.deepEqual(out.diff.takeDown, [], 'HTTP 500');
  assert.deepEqual(out.diff.needsALook.map((n) => [n.vin, n.text]), [[cars[0].vin, 'Missing from this scan, and its page gave HTTP 500, so it was not marked gone. Check the car on the website.']]);
});

test('a website read from its pages: one posted car whose page keeps failing never holds back another sold car, scan after scan', async () => {
  const cars = standardCars(8);
  const [broken, sold] = cars;
  const page = (text, extra = {}) => ({ ok: true, status: 200, contentType: 'text/html', text, ...extra });
  for (const failure of [httpError(500), page('<html><body>This vehicle is no longer available</body></html>'), page(standardCarPage(broken), { redirected: true, finalUrl: 'https://other.example/x' })]) {
    // one car is the salesperson's own listing, the other a colleague's (merged in by sync): either one's page used to block every verdict
    for (const [mineBroken, mineSold] of [[true, true], [false, true]]) {
      let posted = markPosted({}, { vin: sold.vin, name: 'sold car', price: sold.price });
      posted = markPosted(posted, { vin: broken.vin, name: 'broken car', price: broken.price });
      posted[broken.vin].mine = mineBroken;
      posted[sold.vin].mine = mineSold;
      const first = await rescanOf(standardSite({ cars }), null, posted);
      let prev = first.snapshot;
      for (const day of [2, 3, 4]) {
        const site = standardSite({ cars: cars.slice(2) });
        site.set(STANDARD_ORIGIN + broken.path, failure);
        site.set(STANDARD_ORIGIN + sold.path, httpError(404));
        const out = await rescanOf(site, prev, posted);
        const label = `day ${day}, ${failure.finalUrl || (failure.ok ? 'no data' : failure.status)}, broken car ${mineBroken ? 'mine' : 'a colleague\'s'}`;
        assert.equal(out.res.confirm.error, null, label);
        assert.deepEqual(out.diff.takeDown.map((t) => [t.vin, t.why]), [[sold.vin, 'gone']], `${label}: the 404 car is on Take down`);
        const held = out.diff.needsALook.find((n) => n.vin === broken.vin);
        assert.ok(held, `${label}: the car that could not be checked stays under Needs a look`);
        assert.doesNotMatch(held.text, /Rescan later/, label);
        assert.match(held.text, /^Missing from this scan, and its page (gave HTTP 500|has no vehicle data to check against|sent Lot Current to another website), so it was not marked gone\./, label);
        if (mineBroken) assert.match(held.text, /click Taken down on My listings/, label);
        assert.ok(!out.diff.warnings.some((w) => /Couldn't double-check/.test(w)), label);
        prev = out.snapshot;
      }
    }
  }
});

test('confirmOrder: the cars the last check left unchecked go last, the ones it never got to before the pages that failed', () => {
  assert.deepEqual(confirmOrder(['A', 'B', 'C', 'D', 'E'], { C: 'its page gave HTTP 500', A: 'its page gave HTTP 500', E: 'not checked this time' }), ['B', 'D', 'E', 'A', 'C']);
  assert.deepEqual(confirmOrder(['A', 'B'], undefined), ['A', 'B'], 'nothing left unchecked: the order stands');
  assert.deepEqual(confirmOrder(['a', 'B'], { A: 'x' }), ['B', 'a'], 'VINs in any case');
});

test('a website read from its pages: posted cars whose pages keep failing are checked after the others, so a sold car behind them is taken down', async () => {
  const cars = standardCars(10);
  const broken = cars.slice(0, 5); // posted first, their pages fail on every scan
  const sold = cars[5];
  let posted = {};
  for (const c of [...broken, sold]) posted = markPosted(posted, { vin: c.vin, name: 'posted car', price: c.price });
  const day0 = await rescanOf(standardSite({ cars }), null, posted);
  const site = () => {
    const m = standardSite({ cars: cars.slice(6) });
    for (const c of broken) m.set(STANDARD_ORIGIN + c.path, httpError(500));
    m.set(STANDARD_ORIGIN + sold.path, httpError(404));
    return m;
  };
  // day 1: the failing pages come first and stop the check before the sold car's page
  const day1 = await rescanOf(site(), day0.snapshot, posted);
  assert.deepEqual(day1.diff.takeDown, []);
  assert.match(day1.res.confirm.unchecked[sold.vin], /not checked this time/);
  assert.deepEqual(Object.keys(day1.snapshot.unchecked).sort(), [...broken, sold].map((c) => c.vin).sort(), 'the snapshot keeps the cars left unchecked');
  // day 2: those go last, the one never checked first among them, and the sold car is found gone
  const seen = [];
  const spy = { ...schemaOrg, scan: (search, options) => { seen.push(options); return schemaOrg.scan(search, options); } };
  const day2 = await scanWithSearch({ adapter: spy, search: fakeSiteSearch(site()), site: STD_SITE, settings: withDefaults({}, STD_SITE), prevSnapshot: day1.snapshot, posted, options: schemaOrg.scanOptions(STD) });
  assert.equal(seen[0].confirmVins[seen[0].confirmVins.length - Object.keys(day1.snapshot.unchecked).length], sold.vin, 'the car the last check never reached comes first among those it left');
  assert.deepEqual(seen[0].confirmVins.slice(-3), broken.slice(0, 3).map((c) => c.vin).reverse(), 'the pages that failed first come last');
  assert.deepEqual(day2.diff.takeDown.map((t) => [t.vin, t.why]), [[sold.vin, 'gone']]);
  assert.equal(day2.snapshot.unchecked[sold.vin], undefined, 'checked now: no longer left');
});

// A list that names each car by its address and VIN only, as many do: the
// price, the mileage and the photos are on the car's own page.
function thinListSite(cars, broken = {}) {
  const item = (c) => ({ '@type': 'Car', name: `Used ${c.year} ${c.make} ${c.model} ${c.trim}`, url: STANDARD_ORIGIN + c.path, vehicleIdentificationNumber: c.vin });
  const list = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: cars.map((c, n) => ({ '@type': 'ListItem', position: n + 1, item: item(c) })) };
  const site = standardSite({ cars, perPage: cars.length });
  site.set(STD.listUrl, { ok: true, status: 200, contentType: 'text/html', text: `<!doctype html><html><head><title>Used</title><script type="application/ld+json">${JSON.stringify(list)}</script></head><body>${cars.map((c) => `<a href="${c.path}">${c.year} ${c.make}</a>`).join(' ')}</body></html>` });
  for (const [path, answer] of Object.entries(broken)) site.set(STANDARD_ORIGIN + path, answer);
  return site;
}
const rescanOf = (site, prevSnapshot, posted = {}) => scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(site), site: STD_SITE, settings: withDefaults({}, STD_SITE), prevSnapshot, posted, options: schemaOrg.scanOptions(STD) });

test('a website read from its pages: a car still listed whose page fails keeps its last reading, not the thinner list\'s', async () => {
  const cars = standardCars(6);
  const first = await rescanOf(thinListSite(cars), null);
  assert.equal(first.snapshot.vehicles[cars[2].vin].decision, 'ready');
  const bad = await rescanOf(thinListSite(cars, { [cars[2].path]: httpError(500) }), first.snapshot);
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.res.unread, [cars[2].vin]);
  assert.equal(bad.res.complete, false);
  assert.equal(bad.res.confirm.error, null, 'a listed car is not missing, so its page is not asked for again');
  assert.deepEqual(bad.snapshot.vehicles[cars[2].vin], first.snapshot.vehicles[cars[2].vin], 'the last reading stands');
  assert.deepEqual([bad.diff.needsALook, bad.diff.priceUpdates, bad.diff.takeDown, bad.diff.newArrivals], [[], [], [], []], 'a bad server day puts nothing on the to-do list');
  assert.equal(bad.diff.warnings[0], "One car's page could not be read this time, so that car shows what the last scan read.");
  // the day after, the page answers again and is read as usual
  const next = await rescanOf(thinListSite(cars), bad.snapshot);
  assert.equal(next.res.unread, undefined);
  assert.equal(next.res.complete, true);
});

test('a website read from its pages: a posted car sold on a bad server day is taken down once its page can be checked', async () => {
  const cars = standardCars(12);
  const posted = markPosted({}, { vin: cars[0].vin, name: 'posted car', price: cars[0].price });
  const first = await rescanOf(thinListSite(cars), null, posted);
  const rest = cars.slice(1);
  const bad = await rescanOf(thinListSite(rest, { [cars[0].path]: httpError(429) }), first.snapshot, posted);
  assert.deepEqual(bad.diff.takeDown, []);
  assert.deepEqual(bad.diff.needsALook.map((n) => n.vin), [cars[0].vin]);
  assert.deepEqual(bad.snapshot.missingPages, { [cars[0].vin]: STANDARD_ORIGIN + cars[0].path }, 'the page it was last seen on is kept');
  for (const day of [1, 2]) {
    // its page is gone; still posted (nobody has taken the listing down yet), so it stays on Take down
    const prev = day === 1 ? bad.snapshot : (await rescanOf(thinListSite(rest), bad.snapshot, posted)).snapshot;
    const good = await rescanOf(thinListSite(rest), prev, posted);
    assert.deepEqual(good.diff.takeDown.map((t) => [t.vin, t.why]), [[cars[0].vin, 'gone']], `rescan ${day} after the bad day`);
  }
});

// A price drop the page shows while its markup still says the old price (the
// case the visible-price check exists for), with another car at that old
// price on the same page: the other car's tile or card is not this car's price.
const htmlAnswer = (text) => ({ ok: true, status: 200, contentType: 'text/html', text });
test('a website read from its pages: a posted car whose page dropped its price while its markup did not is not kept at the old price by another car\'s tile at that price', async () => {
  const cars = standardCars(6);
  const posted = markPosted({}, { vin: cars[0].vin, name: 'posted car', price: cars[0].price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  assert.equal(first.snapshot.vehicles[cars[0].vin].price, 15000);
  const dropped = (carousel) => {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(standardCarPage(cars[0], { carousel }).replace('Our price $15,000', 'Our price $14,000')));
    return site;
  };
  for (const carousel of [[{ ...cars[1], price: 15000 }], [{ ...cars[1], price: 15000 }, { ...cars[2], price: 17000 }]]) {
    const day2 = await rescanOf(dropped(carousel), first.snapshot, posted);
    assert.deepEqual(day2.diff.priceUpdates, [], `${carousel.length} other car(s) on the page`);
    assert.deepEqual(day2.diff.needsALook.map((n) => [n.vin, n.text]), [[cars[0].vin, 'Website no longer shows a price (the page does not show this price)']], `${carousel.length} other car(s) on the page`);
  }
  // with no other car at the old price the same page reads the same way, and the page's own price is still read when the markup has it
  const fixed = standardSite({ cars, perPage: 10 });
  fixed.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(standardCarPage(cars[0], { price: 14000, carousel: [{ ...cars[1], price: 15000 }] })));
  const day3 = await rescanOf(fixed, first.snapshot, posted);
  assert.deepEqual(day3.diff.priceUpdates.map((u) => [u.vin, u.from, u.to]), [[cars[0].vin, 15000, 14000]]);
});

test('a website read from its pages: a car read from the list is priced from its own card, never from another car\'s card at its markup price', async () => {
  const cars = standardCars(4);
  // the list's data says $15,000 for the first car, its card shows $14,000, and the second car's card shows $15,000
  const listed = [{ ...cars[0], price: 15000 }, { ...cars[1], price: 15000 }, cars[2], cars[3]];
  const list = standardListPage(listed).replace(/<span>\$15,000<\/span>/, '<span>$14,000</span>');
  const site = standardSite({ cars: listed, perPage: 10 });
  site.set(STD.listUrl, htmlAnswer(list));
  site.set(STANDARD_ORIGIN + cars[0].path, httpError(500)); // its own page can't be read: the list's data stands in
  const out = await rescanOf(site, null);
  const car0 = out.vehicles.find((v) => v.vin === cars[0].vin);
  assert.equal(car0.price, null, 'the card for this car shows another amount');
  assert.equal(car0.priceLabel, 'the page does not show this price');
  assert.equal(out.vehicles.find((v) => v.vin === cars[1].vin).price, 15000, 'the second car\'s own page is read as usual');
  // its own card at the list's price: the list's data stands
  const same = standardSite({ cars: listed, perPage: 10 });
  same.set(STANDARD_ORIGIN + cars[0].path, httpError(500));
  assert.equal((await rescanOf(same, null)).vehicles.find((v) => v.vin === cars[0].vin).price, 15000);
});

// Real tiles and cards link to more than the car's page: a "Check
// availability" form, financing, a trade-in page. Those links don't make a
// card something else: it is still that car's card.
const extraLinks = {
  'a contact link': () => ' <a href="/contact-us/">Check availability</a>',
  'a finance link': () => ' <a href="/finance/apply/">Get pre-approved</a>',
  'a form with its VIN': (c) => ` <a href="/contact-us/?vin=${c.vin}">Ask about it</a>`,
};
const withExtraLinks = (html, cars, extra) => {
  let k = 0;
  return html.replace(/<\/div>/g, () => extra(cars[k++]) + '</div>');
};

test('a website read from its pages: a car read from the list keeps the list\'s price when its card also links to a contact form, financing or a form with its VIN', async () => {
  const cars = standardCars(4);
  for (const [name, extra] of Object.entries(extraLinks)) {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STD.listUrl, htmlAnswer(withExtraLinks(standardListPage(cars), cars, extra)));
    // the car pages carry no markup of their own: the list's data is all there is
    for (const c of cars) site.set(STANDARD_ORIGIN + c.path, htmlAnswer(standardCarPage(c).replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')));
    const out = await rescanOf(site, null);
    assert.deepEqual(out.vehicles.map((v) => v.price), cars.map((c) => c.price), name);
    assert.deepEqual(Object.values(out.snapshot.vehicles).map((e) => e.decision), cars.map(() => 'ready'), name);
  }
});

test('a website read from its pages: on a lot whose cards link to more than the car, a later scan still takes unchanged cars from the list instead of reading every car page again', async () => {
  const cars = standardCars(24);
  const site = () => {
    const s = standardSite({ cars, perPage: 30 });
    s.set(STD.listUrl, htmlAnswer(withExtraLinks(standardListPage(cars), cars, extraLinks['a finance link'])));
    return s;
  };
  const first = await rescanOf(site(), null);
  assert.equal(first.res.requests, 25, 'the first scan reads the list and every car page');
  const second = await rescanOf(site(), first.snapshot);
  assert.equal(second.res.requests, 1, 'the second reads only the list');
  assert.equal(second.diff.priceUpdates.length + second.diff.needsALook.length, 0);
});

// A lot whose car addresses carry no VIN ("/used/<year>-<make>-<model>-<stock>/").
const vinLessCars = (count) => standardCars(count).map((c) => ({ ...c, path: `/used/${c.year}-${c.make}-${c.model}-${c.stock}/`.toLowerCase() }));
const noMarkup = (html) => html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');

test('a website read from its pages: on a lot whose car addresses carry no VIN, a car read from the list keeps its price when its card links to its page with a query added or also links to a search for its model', async () => {
  const cars = vinLessCars(4);
  const edits = {
    'the card links to the car with "?srp=1"': (list) => list.replace(/href="(\/used\/[^"]+\/)"/g, 'href="$1?srp=1"'),
    'the card also links to "More like this", a search for its model': (list) => {
      let k = 0;
      return list.replace(/<\/div>/g, () => {
        const c = cars[k++];
        return ` <a href="${`/used-vehicles/${c.year}-${c.make}-${c.model}/`.toLowerCase()}">More like this</a></div>`;
      });
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STD.listUrl, htmlAnswer(edit(standardListPage(cars))));
    // the car pages carry no markup of their own: the list's data and its cards are all there is
    for (const c of cars) {
      site.set(STANDARD_ORIGIN + c.path, htmlAnswer(noMarkup(standardCarPage(c))));
      site.set(STANDARD_ORIGIN + c.path + '?srp=1', htmlAnswer(noMarkup(standardCarPage(c))));
    }
    const out = await rescanOf(site, null);
    assert.deepEqual(out.vehicles.map((v) => v.price), cars.map((c) => c.price), name);
    assert.deepEqual(Object.values(out.snapshot.vehicles).map((e) => e.decision), cars.map(() => 'ready'), name);
  }
  // and a later scan takes the unchanged cars from the list, reading no car page again
  const many = vinLessCars(24);
  const site = () => {
    const s = standardSite({ cars: many, perPage: 30 });
    s.set(STD.listUrl, htmlAnswer(standardListPage(many).replace(/href="(\/used\/[^"]+\/)"/g, 'href="$1?srp=1"')));
    for (const c of many) s.set(STANDARD_ORIGIN + c.path + '?srp=1', s.get(STANDARD_ORIGIN + c.path));
    return s;
  };
  const first = await rescanOf(site(), null);
  assert.equal(first.res.requests, 25);
  const second = await rescanOf(site(), first.snapshot);
  assert.equal(second.res.requests, 1, 'the second scan reads only the list');
  assert.equal(second.diff.priceUpdates.length + second.diff.needsALook.length, 0);
});

test('a website read from its pages: another car\'s tile at the old price is not this car\'s price when the tile also links to a contact form or a form with its VIN, or is the only other car on the page', async () => {
  const cars = standardCars(6);
  const posted = markPosted({}, { vin: cars[0].vin, name: 'posted car', price: cars[0].price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  const tile = (c, price, extra) => `<div class="tile"><a href="${c.path}">${c.year} ${c.make} ${c.model}</a> <span>$${price.toLocaleString('en-US')}</span>${extra(c)}</div>`;
  const asides = {};
  for (const [name, extra] of Object.entries(extraLinks)) asides[`two tiles, each with ${name}`] = `<aside>${tile(cars[1], 15000, extra)}${tile(cars[2], 17000, extra)}</aside>`;
  asides['one tile, with a contact link'] = `<section><h2>You may also like</h2>${tile(cars[1], 15000, extraLinks['a contact link'])}</section>`;
  asides['one tile, with a form with its VIN'] = `<section><h2>You may also like</h2>${tile(cars[1], 15000, extraLinks['a form with its VIN'])}</section>`;
  for (const [name, aside] of Object.entries(asides)) {
    const site = standardSite({ cars, perPage: 10 });
    // the page now says $14,000; its markup still says $15,000, the other car's price
    const html = standardCarPage(cars[0]).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', aside + '<a href="/used-vehicles/">');
    site.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(html));
    const out = await rescanOf(site, first.snapshot, posted);
    assert.equal(out.snapshot.vehicles[cars[0].vin].price, null, name);
    assert.deepEqual(out.diff.needsALook.map((n) => [n.vin, n.text]), [[cars[0].vin, 'Website no longer shows a price (the page does not show this price)']], name);
  }
});

test('a website read from its pages: on a lot whose car addresses carry no VIN, a tile for a car the list does not name (a new car, another store\'s) at the old price is not this car\'s price', async () => {
  const cars = standardCars(6).map((c) => ({ ...c, path: `/used/${c.year}-${c.make}-${c.model}-${c.stock}/`.toLowerCase() }));
  const posted = markPosted({}, { vin: cars[0].vin, name: 'posted car', price: cars[0].price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  assert.equal(first.snapshot.vehicles[cars[0].vin].price, 15000);
  const elsewhere = '<aside><div class="tile"><a href="/new/2027-kia-telluride-n5000/">2027 Kia Telluride</a> <span>$15,000</span> <a href="/contact-us/">Ask about it</a></div></aside>';
  const site = standardSite({ cars, perPage: 10 });
  site.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(standardCarPage(cars[0]).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', elsewhere + '<a href="/used-vehicles/">')));
  const out = await rescanOf(site, first.snapshot, posted);
  assert.equal(out.snapshot.vehicles[cars[0].vin].price, null);
  assert.deepEqual(out.diff.needsALook.map((n) => [n.vin, n.text]), [[cars[0].vin, 'Website no longer shows a price (the page does not show this price)']]);
});

test('a website read from its pages: another car\'s tile at the old price is not this car\'s price when it links to that car through an address without a VIN that reads like a car page, in the scan and at post time', async () => {
  const cars = standardCars(6);
  const posted = markPosted({}, { vin: cars[0].vin, name: 'posted car', price: cars[0].price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  const o = cars[1];
  // the lot's car addresses carry the VIN; these tiles link through an address the list never uses
  const aside = `<aside><div class="tile"><a href="/used/${o.year}-${o.make}-${o.model}-${o.stock}/">${o.year} ${o.make}</a> <span>$15,000</span></div><div class="tile"><a href="/used/${cars[2].year}-${cars[2].make}-${cars[2].model}-${cars[2].stock}/">${cars[2].year} ${cars[2].make}</a> <span>$17,000</span></div></aside>`.toLowerCase();
  const site = standardSite({ cars, perPage: 10 });
  site.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(standardCarPage(cars[0]).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', aside + '<a href="/used-vehicles/">')));
  const out = await rescanOf(site, first.snapshot, posted);
  assert.equal(out.snapshot.vehicles[cars[0].vin].price, null);
  assert.deepEqual(out.diff.needsALook.map((n) => [n.vin, n.text]), [[cars[0].vin, 'Website no longer shows a price (the page does not show this price)']]);
  const one = await schemaOrg.getDetails(fakeSiteSearch(site), cars[0].vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + cars[0].path });
  assert.equal(schemaOrg.normalize(one.record).price, null, 'post time');
});

test('a website read from its pages: another car\'s tile at the old price is not this car\'s price when the car\'s markup gives another address of its page, since the page is read for that car', async () => {
  const cars = standardCars(6);
  const c = cars[0];
  const posted = markPosted({}, { vin: c.vin, name: 'posted car', price: c.price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  const tileOf = (o, amount) => `<div class="tile"><a href="/used/${o.year}-${o.make}-${o.model}-${o.stock}/">${o.year} ${o.make}</a> <span>${amount}</span></div>`.toLowerCase();
  const aside = `<aside>${tileOf(cars[1], '$15,000')}${tileOf(cars[2], '$17,000')}</aside>`;
  const markupAt = {
    'with http:// for https://': STANDARD_ORIGIN.replace('https:', 'http:') + c.path,
    'at the car\'s stock number': `${STANDARD_ORIGIN}/inventory/${c.stock}/`,
  };
  for (const [name, url] of Object.entries(markupAt)) {
    const site = standardSite({ cars, perPage: 10 });
    const html = standardCarPage(c).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', aside + '<a href="/used-vehicles/">').replace(`"url":"${STANDARD_ORIGIN}${c.path}"`, `"url":"${url}"`);
    assert.ok(html.includes(`"url":"${url}"`), name);
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(html));
    const out = await rescanOf(site, first.snapshot, posted);
    assert.equal(out.snapshot.vehicles[c.vin].price, null, name);
    assert.deepEqual(out.diff.needsALook.map((n) => [n.vin, n.text]), [[c.vin, 'Website no longer shows a price (the page does not show this price)']], name);
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    assert.equal(schemaOrg.normalize(one.record).price, null, `post time: ${name}`);
  }
});

test('a website read from its pages: on a lot whose car addresses carry the VIN, a car\'s own price stays its own when its price box links a search for its model in other words (F150 for F-150, Chevy for Chevrolet, a model without its body style, a new-car search, a sort, a tracking, campaign, place or mileage query, a page number, a round price limit, a range of years, any other word without a digit), and another car\'s tile at the old price is told apart by its make, its model year, a new car\'s model or trim, a model with a digit or an id, also one after a word a search uses', async () => {
  const base = standardCars(4);
  const variants = {
    'F150 for an F-150': { patch: (c) => ({ ...c, make: 'Ford', model: 'F-150', trim: 'XLT' }), href: (c) => `/used-vehicles/${c.year}-ford-f150/` },
    'a model without its body style': { patch: (c) => ({ ...c, model: 'Civic Sedan' }), href: (c) => `/used-vehicles/${c.year}-honda-civic/` },
    'Chevy for Chevrolet': { patch: (c) => ({ ...c, make: 'Chevrolet', model: 'Equinox', trim: 'LT' }), href: (c) => `/used-vehicles/${c.year}-chevy-equinox/` },
    'a search for the new model': { patch: (c) => c, href: () => '/new-vehicles/2027-honda-civic/' },
    'a breadcrumb to its year and make': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda/` },
    'a sort': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?sort=price` },
    'a tracking query': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?utm_source=vdp&utm_medium=site` },
    'a page number': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?page=2` },
    'a place word': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic-near-me/` },
    'a fuel word': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic-hybrid/` },
    'a place query': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?zip=43215&radius=100` },
    'a tracking query with digits': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?utm_source=vdp&utm_campaign=fall2026&gclid=EAIaIQobChMI2026` },
    'a page number in the path': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/page/3/` },
    'a price limit': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic-under-20000/` },
    'a price limit in thousands': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic-under-20k/` },
    'a campaign query': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?campaign=fall2026` },
    'a mileage query': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year}-honda-civic/?miles=0-50000` },
    'a range of years with its own in it': { patch: (c) => c, href: (c) => `/used-vehicles/${c.year - 2}-${c.year + 2}-honda-civic/` },
    'a search for the new model, sorted': { patch: (c) => c, href: () => '/new-vehicles/2027-honda-civic/?sort=price' },
  };
  for (const [name, v] of Object.entries(variants)) {
    const cars = base.slice();
    cars[0] = v.patch(cars[0]);
    const c = cars[0];
    const site = standardSite({ cars, perPage: 10 });
    // its title in a bar of its own, so the price box and the link sit in a block without it
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(standardCarPage(c).replace(/(<h1>[^<]*<\/h1>)<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, (all, h1, price, miles) => `<div class="bar">${h1}</div><div class="main"><div class="price-box"><p>Our price ${price}</p><p>${miles}</p><a href="${v.href(c)}">See all</a></div></div>`)));
    const out = await rescanOf(site, null);
    assert.equal(out.vehicles.find((x) => x.vin === c.vin).price, c.price, `scan: ${name}`);
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    assert.equal(schemaOrg.normalize(one.record).price, c.price, `post time: ${name}`);
  }
  // a link that names another car in the same place still takes the block with it: no price, never the wrong one
  const cars = base.slice();
  const c = cars[0];
  const site = standardSite({ cars, perPage: 10 });
  site.set(STANDARD_ORIGIN + c.path, htmlAnswer(standardCarPage(c).replace(/(<h1>[^<]*<\/h1>)<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, (all, h1, price, miles) => `<div class="bar">${h1}</div><div class="main"><div class="price-box"><p>Our price ${price}</p><p>${miles}</p><a href="/used/${c.year}-honda-civic-sm9999/">Next vehicle</a></div></div>`)));
  assert.equal((await rescanOf(site, null)).vehicles.find((x) => x.vin === c.vin).price, null, 'another car\'s address');
  // and another car's tile at the old price is not this car's price when its address names another
  // model year, another make (also one the VIN check has no maker code for), a new car's other model or
  // trim at another year, another model with a digit or an id in its query, even without a stock number;
  // a stock number or id after a word a search also uses ("max", "under", "p"), under a query name that is
  // not a search's own ("view", "start", "order", "referrer"), or after a model year that only looks like
  // the start of a range, still tells the car apart
  const stalePrice = async (car, hrefs) => {
    const posted = markPosted({}, { vin: car.vin, name: 'posted car', price: car.price });
    const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
    const was = '$' + car.price.toLocaleString('en-US');
    for (const href of hrefs) {
      const stale = standardSite({ cars, perPage: 10 });
      stale.set(STANDARD_ORIGIN + car.path, htmlAnswer(standardCarPage(car).replace(`Our price ${was}`, 'Our price $9,999').replace('<a href="/used-vehicles/">', `<aside><div class="tile"><a href="${href}">Another car</a> <span>${was}</span></div></aside><a href="/used-vehicles/">`)));
      const out = await rescanOf(stale, first.snapshot, posted);
      assert.equal(out.snapshot.vehicles[car.vin].price, null, href);
      const one = await schemaOrg.getDetails(fakeSiteSearch(stale), car.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + car.path });
      assert.equal(schemaOrg.normalize(one.record).price, null, `post time: ${href}`);
    }
  };
  await stalePrice(c, [
    `/used/${c.year + 1}-honda-civic-ex/`, `/used/${c.year}-toyota-camry/`, `/used/${c.year}-land-rover-discovery/`, `/used/${c.year}-ford-f250-xlt/`, `/used/${c.year}-honda-civic/?id=88001`,
    `/used/${c.year}-mitsubishi-outlander/`, `/used/${c.year}-porsche-macan/`, `/used/${c.year}-aston-martin-vantage/`, `/used/${c.year}-rolls-royce-ghost/`,
    `/used/${c.year}-freightliner-sprinter/`, `/used/${c.year}-geo-tracker/`,
    `/new/${c.year + 11}-honda-civic-sport/`, `/new-vehicles/${c.year + 11}-honda-accord/`, `/used/${c.year}-honda-civic/?utm_source=similar&id=88001`,
    `/used/${c.year}-honda-civic-p-123/`, `/used/${c.year}-honda-civic/p/123/`, `/used/${c.year}-honda-civic-ex/page/88/`, `/used/${c.year}-honda-civic-max-88001/`, `/used/${c.year}-honda-civic-under-88001/`,
    `/used/${c.year}-honda-civic/?view=88001`, `/used/${c.year}-honda-civic/?start=88001`, `/used/${c.year}-honda-civic/?order=88001`, `/used/${c.year}-honda-civic/?referrer=88001`,
    `/used/${c.year}-${c.year + 15}-honda-civic/`, `/used/${c.year - 1}-${c.year}-honda-accord/`,
  ]);
  // a model that shares its name with a search's word: another Expedition MAX's stock number on an Escape's page
  const escape = cars.find((x) => x.model === 'Escape');
  await stalePrice(escape, [`/used/${escape.year}-ford-expedition-max-12345/`, `/used/${escape.year}-ford-expedition-max/12345/`]);
});

test('a website read from its pages: on a car whose model name holds a search word ("Expedition MAX"), another car\'s round stock number after that word still names another car', async () => {
  // with and without the VIN in the lot's car addresses; the stock numbers are numbers, one of them round
  for (const vinInAddress of [true, false]) {
    const cars = standardCars(5).map((c, i) => ({ ...c, stock: String(10000 + i * 2500 + 7) }));
    Object.assign(cars[2], { make: 'Ford', model: 'Expedition MAX' });
    if (!vinInAddress) for (const c of cars) c.path = `/used/${c.year}-${c.make}-${c.model.replace(/ /g, '-')}-${c.stock}/`.toLowerCase();
    else cars[2].path = `/inventory/used-${cars[2].year}-ford-expedition-max-${cars[2].vin}/`.toLowerCase();
    const car = cars[2];
    const posted = markPosted({}, { vin: car.vin, name: 'posted car', price: car.price });
    const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
    const was = '$' + car.price.toLocaleString('en-US');
    for (const href of [`/used/${car.year}-ford-expedition-max-17500/`, `/used/${car.year}-ford-expedition-max-2000/`, `/used/${car.year}-ford-expedition-max-20k/`]) {
      const stale = standardSite({ cars, perPage: 10 });
      stale.set(STANDARD_ORIGIN + car.path, htmlAnswer(standardCarPage(car).replace(`Our price ${was}`, 'Our price $9,999').replace('<a href="/used-vehicles/">', `<aside><div class="tile"><div class="head"><a href="${href}">Similar car</a></div><div class="info"><span>${was}</span></div></div></aside><a href="/used-vehicles/">`)));
      const out = await rescanOf(stale, first.snapshot, posted);
      assert.equal(out.snapshot.vehicles[car.vin].price, null, `${vinInAddress ? 'VIN' : 'stock'} lot: ${href}`);
      const one = await schemaOrg.getDetails(fakeSiteSearch(stale), car.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + car.path });
      assert.equal(schemaOrg.normalize(one.record).price, null, `${vinInAddress ? 'VIN' : 'stock'} lot, post time: ${href}`);
    }
  }
});

test('a website read from its pages: another car\'s tile at the old price is told apart by its make, for every make the VIN check knows and every make the probe names', async () => {
  const cars = standardCars(4);
  const c = cars[0];
  // the probe's make words (the first line of its SUBSET_WORDS), a make in two words joined as an address writes it
  const line = schemaOrg.probeInPage.toString().match(/SUBSET_WORDS = new Set\(\[\s*\n([^\n]*)\n/)[1];
  const probeWords = [...line.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(probeWords.includes('mitsubishi') && probeWords.includes('porsche'), 'the probe\'s make words were found');
  const pairs = { alfa: 'alfa-romeo', romeo: 'alfa-romeo', aston: 'aston-martin', land: 'land-rover', rover: 'land-rover', rolls: 'rolls-royce', royce: 'rolls-royce', harley: 'harley-davidson', davidson: 'harley-davidson', guzzi: 'moto-guzzi', motorrad: 'bmw-motorrad' };
  const slugs = new Set([...probeWords.map((w) => pairs[w] || w), ...MANUFACTURERS.flatMap(([, , makes]) => makes.map((m) => m.toLowerCase().replace(/[^a-z0-9]+/g, '-')))]);
  slugs.delete('honda');
  for (const slug of slugs) {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(standardCarPage(c).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', `<aside><div class="tile"><a href="/used/${c.year}-${slug}-sport/">Another car</a> <span>$15,000</span></div></aside><a href="/used-vehicles/">`)));
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    assert.equal(schemaOrg.normalize(one.record).price, null, slug);
  }
});

test('a website read from its pages: on a lot whose car addresses neither carry a VIN nor read like a car page, another car\'s tile at the old price is not this car\'s price at post time either, once the last scan\'s car pages are known', async () => {
  const cars = standardCars(6).map((c, i) => ({ ...c, path: `/vdp/${7000 + i}/` }));
  const posted = markPosted({}, { vin: cars[0].vin, name: 'posted car', price: cars[0].price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  assert.equal(first.snapshot.vehicles[cars[0].vin].price, 15000);
  const aside = `<aside><div class="tile"><a href="${cars[1].path}">${cars[1].year} ${cars[1].make}</a> <span>$15,000</span></div><div class="tile"><a href="${cars[2].path}">${cars[2].year} ${cars[2].make}</a> <span>$17,000</span></div></aside>`;
  const site = standardSite({ cars, perPage: 10 });
  site.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(standardCarPage(cars[0]).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', aside + '<a href="/used-vehicles/">')));
  const out = await rescanOf(site, first.snapshot, posted);
  assert.equal(out.snapshot.vehicles[cars[0].vin].price, null, 'the scan knows the lot\'s car pages');
  const carPages = Object.entries(first.snapshot.vehicles).map(([vin, e]) => ({ vin, url: e.url }));
  const one = await schemaOrg.getDetails(fakeSiteSearch(site), cars[0].vin, { origin: STANDARD_ORIGIN, listUrl: STD.listUrl, url: STANDARD_ORIGIN + cars[0].path, carPages });
  assert.equal(schemaOrg.normalize(one.record).price, null, 'post time, with the last scan\'s car pages');
  // the car's own price is still read there when no other car shows the old one
  site.set(STANDARD_ORIGIN + cars[0].path, htmlAnswer(standardCarPage(cars[0]).replace('<a href="/used-vehicles/">', aside.replace('$15,000', '$15,500') + '<a href="/used-vehicles/">')));
  const fine = await schemaOrg.getDetails(fakeSiteSearch(site), cars[0].vin, { origin: STANDARD_ORIGIN, listUrl: STD.listUrl, url: STANDARD_ORIGIN + cars[0].path, carPages });
  assert.equal(schemaOrg.normalize(fine.record).price, 15000);
});

test('a website read from its pages: a car\'s own price stays its own when its price box also links to a model search, another address of the same car, or a page of its own', async () => {
  const cars = standardCars(4);
  const c = cars[0];
  const boxes = {
    'a "See all" search for its model': `<a href="/used-vehicles/${c.year}-${c.make}-${c.model}/">See all ${c.year} ${c.make} ${c.model}</a>`.toLowerCase(),
    'another address of the same car': `<a href="/used/${c.year}-${c.make}-${c.model}-${c.stock}/">Share</a>`.toLowerCase(),
    'its print page': `<a href="${c.path}?print=1">Print</a>`,
  };
  for (const [name, link] of Object.entries(boxes)) {
    const html = standardCarPage(c, { carousel: [cars[1], cars[2]] }).replace(/<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, `<section class="info"><p>Our price $1</p><p>$2</p>${link}</section>`);
    // read in a scan, which knows the lot's car addresses
    const site = standardSite({ cars, perPage: 10 });
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(html));
    const out = await rescanOf(site, null);
    const v = out.vehicles.find((x) => x.vin === c.vin);
    assert.equal(v.price, c.price, `scan: ${name}`);
    assert.equal(v.mileage, c.miles, `scan: ${name}`);
    // and at post time, from the car's page alone
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    assert.equal(schemaOrg.normalize(one.record).price, c.price, `post time: ${name}`);
  }
});

test('a website read from its pages: on a lot whose car addresses carry no VIN, a car\'s own price stays its own when its page links to a search for its own model', async () => {
  const cars = vinLessCars(4);
  const c = cars[0];
  const see = `<a href="${`/used-vehicles/${c.year}-${c.make}-${c.model}/`.toLowerCase()}">See all ${c.year} ${c.make} ${c.model}</a>`;
  const layouts = {
    'in its price box': standardCarPage(c).replace(/<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, `<section class="info"><p>Our price $1</p><p>$2</p>${see}</section>`),
    'beside its price box, its title in a bar of its own': standardCarPage(c).replace(/(<h1>[^<]*<\/h1>)<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, `<div class="bar">$1</div><div class="main"><div class="price-box"><p>Our price $2</p><p>$3</p><a href="/contact-us/">Check availability</a></div><div class="specs"><p>Automatic</p>${see}</div></div>`),
  };
  for (const [name, html] of Object.entries(layouts)) {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(html));
    const out = await rescanOf(site, null);
    assert.equal(out.vehicles.find((x) => x.vin === c.vin).price, c.price, `scan: ${name}`);
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    assert.equal(schemaOrg.normalize(one.record).price, c.price, `post time: ${name}`);
  }
});

test('a website read from its pages: beside one other car\'s tile in the block that holds its price box (its title in a bar of its own), a car gets no price rather than risk the tile\'s, in the scan and at post time', async () => {
  const cars = standardCars(4);
  const [c, o] = cars;
  const page = (price, tile) => standardCarPage(c).replace(/(<h1>[^<]*<\/h1>)<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, (all, h1, was, miles) => `<div class="bar">${h1}</div><div class="main"><div class="price-box"><p>Our price ${price}</p><p>${miles}</p><a href="/contact-us/">Check availability</a> <a href="/finance/">Get financing</a></div>${tile}</div>`);
  const similar = (amount) => `<div class="similar"><h3>Similar</h3><a href="${o.path}">${o.year} ${o.make} ${o.model} ${amount}</a></div>`;
  const read = async (html, prev = null, posted = {}) => {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(html));
    const out = await rescanOf(site, prev, posted);
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    return { out, atPost: schemaOrg.normalize(one.record) };
  };
  // the block is the tile's card whole, the car's own price box with it: no price, the safe side, even when the
  // page is honest (Lot Current cannot tell this price box from a tile's price piece)
  const fine = await read(page('$15,000', similar('$15,500')));
  assert.equal(fine.out.vehicles.find((v) => v.vin === c.vin).price, null, 'scan');
  assert.notEqual(fine.out.snapshot.vehicles[c.vin].decision, 'ready');
  assert.equal(fine.atPost.price, null, 'post time');
  // the page now says $14,000; its markup still says $15,000, the price on the tile
  const posted = markPosted({}, { vin: c.vin, name: 'posted car', price: c.price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  const split = `<div class="tile"><div class="photo"><a href="${o.path}"><img alt=""></a><span>Low miles</span></div><div class="info"><span>$15,000</span></div></div>`;
  const head = (beside) => `<div class="tile"><div class="head"><a href="${o.path}">${o.year} ${o.make} ${o.model}</a> <span>${beside}</span></div><div class="info"><span>$15,000</span></div></div>`;
  const loose = `<div class="head"><a href="${o.path}">${o.year} ${o.make} ${o.model}</a> <span>Save $500</span></div><div class="info"><span>$15,000</span></div>`;
  for (const [name, tile] of [
    ['the tile\'s amount in its link', similar('$15,000')],
    ['the tile\'s amount outside the element around its link', split],
    ['a saving beside the tile\'s link, its amount beside that', head('Save $500')],
    ['a payment beside the tile\'s link, its amount beside that', head('Est. $299/mo')],
    ['the tile\'s pieces loose beside the price box', loose],
  ]) {
    const stale = await read(page('$14,000', tile), first.snapshot, posted);
    assert.equal(stale.out.snapshot.vehicles[c.vin].price, null, name);
    assert.deepEqual(stale.out.diff.needsALook.map((n) => [n.vin, n.text]), [[c.vin, 'Website no longer shows a price (the page does not show this price)']], name);
    assert.equal(stale.atPost.price, null, `post time: ${name}`);
  }
});

test('a website read from its pages: another car\'s lone tile at a posted car\'s old price is not its price, whatever sits beside the tile\'s link, wherever the tile sits and however its "$" is written, also beside a page that shows no amount of its own or a price box that shows two, in the scan and at post time', async () => {
  const cars = standardCars(4);
  const [c, o] = cars;
  const read = async (html, prev, posted) => {
    const site = standardSite({ cars, perPage: 10 });
    site.set(STANDARD_ORIGIN + c.path, htmlAnswer(html));
    const out = await rescanOf(site, prev, posted);
    const one = await schemaOrg.getDetails(fakeSiteSearch(site), c.vin, { origin: STANDARD_ORIGIN, listUrl: null, url: STANDARD_ORIGIN + c.path });
    return { out, atPost: schemaOrg.normalize(one.record) };
  };
  // the page now says $14,000; its markup still says $15,000, the price on the tile
  const posted = markPosted({}, { vin: c.vin, name: 'posted car', price: c.price });
  const first = await rescanOf(standardSite({ cars, perPage: 10 }), null, posted);
  const L = `<a href="${o.path}">${o.year} ${o.make} ${o.model}</a>`;
  const tile = (beside, info = '$15,000') => `<div class="tile"><div class="head">${L} <span>${beside}</span></div><div class="info"><span>${info}</span></div></div>`;
  const plain = (extra) => standardCarPage(c).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', `${extra}<a href="/used-vehicles/">`);
  const bar = (main) => standardCarPage(c).replace(/(<h1>[^<]*<\/h1>)<p>Our price ([^<]+)<\/p><p>([^<]+)<\/p>/, (all, h1) => `<div class="bar">${h1}</div>${main}`);
  const box = (price) => `<div class="price-box"><p>Our price ${price}</p><p>20,000 miles</p><a href="/contact-us/">Check availability</a></div>`;
  const layouts = [];
  // the page's title and price box together; the tile alone in an aside or straight in the page
  for (const [beside, info] of [['Price drop $500'], ['$500 dealer discount'], ['Reduced $1,000'], ['$1,000 bonus cash'], ['$16,000', 'Sale price $15,000']]) {
    layouts.push([`an aside, "${beside}" beside the tile's link`, plain(`<aside>${tile(beside, info)}</aside>`)]);
    layouts.push([`straight in the page, "${beside}" beside the tile's link`, plain(tile(beside, info))]);
  }
  // the title in a bar of its own: the tile's price after the block that holds the price box and the tile's link,
  // or a "$" in an element of its own
  layouts.push(['the tile\'s price after the block holding the price box and its link', bar(`<div class="outer"><div class="main">${box('$14,000')}<div class="head">${L} <span>$16,000</span></div></div><div class="info"><span>$15,000</span></div></div>`)]);
  layouts.push(['a "$" in an element of its own', bar(`<div class="main">${box('<sup>$</sup>14,000')}<div class="head">${L} <span>$16,000</span></div><div class="info"><sup>$</sup>15,000</div></div>`)]);
  // the tile's price before its link, another amount beside the link, and the page showing no amount of its own:
  // more text after the title in the title's own block; "Call for price" beside the tile or after it
  const priceFirst = `<div class="tile"><div class="info"><span>$15,000</span></div><div class="head">${L} <span>$16,000</span></div></div>`;
  layouts.push(['text after the title in its own block, then the tile, its price first', bar('').replace('<div class="bar">', '<div class="top">').replace('</h1></div>', `</h1><p>20,000 miles</p><p>Automatic, one owner</p></div>${priceFirst}`)]);
  layouts.push(['"Call for price" beside the tile\'s pieces, its price first', bar(`<div class="main">${box('Call for price')}<div class="info"><span>$15,000</span></div><div class="head">${L} <span>$16,000</span></div></div>`)]);
  layouts.push(['the tile right after the title, its price first, "Contact us for today\'s pricing" after it', bar(`<aside>${priceFirst}</aside>${box('Contact us for today\'s pricing')}`).replace('<div class="bar">', '<div>')]);
  // the price box and the tile's price grouped together, or a note in the price box with another amount
  layouts.push(['the price box and the tile\'s price in one group', bar(`<div class="main"><div class="group">${box('$14,000')}<div class="info"><span>$15,000</span></div></div><div class="head">${L} <span>$16,000</span></div></div>`)]);
  layouts.push(['a note with another amount in the price box', bar(`<div class="main"><div class="price-box"><p>Our price $14,000</p><p>Similar cars from $15,000</p></div><div class="head">${L} <span>$16,000</span></div></div>`)]);
  // a price box that shows no amount, whatever it says instead, beside the tile's pieces or after the whole tile
  const pieces = `<div class="photo"><span>$15,000</span></div><div class="head">${L} <span>$16,000</span></div>`;
  const noAmount = (says) => `<div class="price-box"><p>${says}</p><p>20,000 miles</p></div>`;
  for (const says of ['Call for price', 'Get today\'s price', 'Contact dealer for price', 'Call for internet price', 'Call for special pricing', 'Price: Call', 'Click for price', 'Request a quote', 'Unlock our price', '']) {
    layouts.push([`"${says}" beside the tile's pieces`, bar(`<div class="main">${noAmount(says)}${pieces}</div>`)]);
    layouts.push([`"${says}" after the whole tile`, bar(`<div class="tile">${pieces}</div>${noAmount(says)}`)]);
  }
  for (const [name, html] of layouts) {
    const stale = await read(html, first.snapshot, posted);
    assert.equal(stale.out.snapshot.vehicles[c.vin].price, null, name);
    assert.deepEqual(stale.out.diff.needsALook.map((n) => [n.vin, n.text]), [[c.vin, 'Website no longer shows a price (the page does not show this price)']], name);
    assert.equal(stale.atPost.price, null, `post time: ${name}`);
  }
  // the honest page: title and price box together, the same tile beside it; the car keeps its price
  const honest = await read(standardCarPage(c).replace('<a href="/used-vehicles/">', `<aside>${tile('Price drop $500', '$15,500')}</aside><a href="/used-vehicles/">`), null, {});
  assert.equal(honest.out.vehicles.find((v) => v.vin === c.vin).price, 15000);
  assert.equal(honest.atPost.price, 15000);
});

test('a website read from its pages: a one-car list\'s card keeps the text its tile was cut from, so a car read from the list keeps its mileage', async () => {
  const cars = standardCars(1);
  const [c] = cars;
  const site = standardSite({ cars, perPage: 10 });
  // the card's title and price in one block, its mileage in another; the list's data gives the mileage without a unit, so it counts only as the card shows it
  site.set(STD.listUrl, htmlAnswer(standardListPage(cars).replace(/,"unitCode":"SMI"/g, '').replace(/<div class="card">(<a [^>]*>[^<]*<\/a>) (<span>[^<]*<\/span>) (<span>[^<]*<\/span>)/, '<div class="card"><div class="top">$1 $2</div><div class="specs">$3</div>')));
  site.set(STANDARD_ORIGIN + c.path, htmlAnswer(noMarkup(standardCarPage(c))));
  const out = await rescanOf(site, null);
  assert.equal(out.vehicles[0].price, c.price);
  assert.equal(out.vehicles[0].mileage, c.miles);
  assert.equal(out.snapshot.vehicles[c.vin].decision, 'ready');
});

// ---------- the dates the snapshot keeps for the Ready and To do tabs ----------
// (src/readyList.js reads them: the website's own in-stock date, and when
// Lot Current first saw the car, carried from one saved snapshot to the next)

test('the snapshot keeps the website\'s in-stock date as the record gave it, and no date is no date', () => {
  const s = snapshot([['usedNormal'], ['certified'], ['usedNoPrice', { date_in_stock: null }]]);
  assert.equal(s.vehicles[VIN.ram].dateInStock, fixtures.usedNormal.date_in_stock);
  assert.equal(s.vehicles[VIN.wagoneer].dateInStock, fixtures.certified.date_in_stock);
  assert.equal(s.vehicles[fixtures.usedNoPrice.vin].dateInStock, null);
  assert.equal(snapshotEntry({ vin: 'X', dateInStock: '   ' }, { decision: 'ready', blockers: [] }).dateInStock, null, 'blank is no date');
  assert.equal(snapshotEntry({ vin: 'X', dateInStock: 20260920 }, { decision: 'ready', blockers: [] }).dateInStock, null, 'only the website\'s own text is kept, never a number made into a date');
});

test('when Lot Current first saw a car: null on a first scan, this scan\'s time for a newcomer, carried over for the rest', () => {
  const T1 = '2026-09-26T21:00:00.000Z';
  const T2 = '2026-09-27T09:00:00.000Z';
  const T3 = '2026-09-28T09:00:00.000Z';
  // first scan: nothing is new by first sighting
  const first = snapshot(LOT, MY_STORE, T1);
  assert.deepEqual(Object.values(first.vehicles).map((e) => e.firstSeenAt), [null, null, null, null]);
  assert.equal(firstSeenAt(null, VIN.ram, T1), null);
  // a rescan: the newcomer gets this scan's time, the others keep null
  const withNewcomer = (takenAt, previous) => makeSnapshotFrom([...LOT, ['usedZeroMiles']], takenAt, previous);
  const second = withNewcomer(T2, first);
  assert.equal(second.vehicles[fixtures.usedZeroMiles.vin].firstSeenAt, T2);
  for (const vin of Object.values(VIN)) assert.equal(second.vehicles[vin].firstSeenAt, null, `${vin} was already there`);
  // the scan after: the newcomer's first sighting stays what it was
  const third = withNewcomer(T3, second);
  assert.equal(third.vehicles[fixtures.usedZeroMiles.vin].firstSeenAt, T2);
  // a car that leaves and comes back is seen afresh
  const without = makeSnapshotFrom(LOT, T3, second);
  const back = withNewcomer('2026-09-29T09:00:00.000Z', without);
  assert.equal(back.vehicles[fixtures.usedZeroMiles.vin].firstSeenAt, '2026-09-29T09:00:00.000Z');
  // an entry saved before the field existed carries null: Lot Current did not see that car arrive either
  const old = { ...first, vehicles: Object.fromEntries(Object.entries(first.vehicles).map(([vin, e]) => { const { firstSeenAt: _, ...rest } = e; return [vin, rest]; })) };
  assert.ok(!('firstSeenAt' in old.vehicles[VIN.ram]));
  const after = withNewcomer(T2, old);
  assert.equal(after.vehicles[VIN.ram].firstSeenAt, null);
  assert.equal(after.vehicles[fixtures.usedZeroMiles.vin].firstSeenAt, T2);
  // garbage in the previous snapshot is a first scan
  assert.equal(firstSeenAt({ vehicles: 'x' }, VIN.ram, T2), null);
  assert.equal(firstSeenAt({ vehicles: { [VIN.ram]: { firstSeenAt: 42 } } }, VIN.ram, T2), null, 'a non-string date is no date');
  assert.equal(firstSeenAt({ vehicles: {} }, VIN.ram, ''), null, 'a newcomer with no scan time gets none, never an invented one');
  // the diff is as it was: the newcomer is a new arrival once, by the VIN diff
  assert.deepEqual(diffScans(first, second).newArrivals.map((n) => n.vin), [fixtures.usedZeroMiles.vin]);
  assert.deepEqual(diffScans(second, third).newArrivals, []);
});

function makeSnapshotFrom(items, takenAt, previous) {
  const vehicles = items.map(([name, patch]) => vehicle(name, patch));
  const assessments = vehicles.map((v) => assessVehicle(v, MY_STORE));
  return makeSnapshot({ site: { origin: 'https://example-dealer.test', name: 'Test' }, takenAt, complete: true, vehicles, assessments, previous });
}

test('the scan runner carries the first sighting through its own snapshot, on the first scan, a rescan, and after a scan it did not save', async () => {
  const cars = standardCars(12);
  const first = await rescanOf(thinListSite(cars), null);
  assert.deepEqual([...new Set(Object.values(first.snapshot.vehicles).map((e) => e.firstSeenAt))], [null], 'a first scan: nothing new by first sighting');
  assert.deepEqual([...new Set(Object.values(first.snapshot.vehicles).map((e) => e.dateInStock))], [null], 'this website gives no in-stock date');
  // a rescan with a newcomer
  const more = standardCars(13);
  const second = await rescanOf(thinListSite(more), first.snapshot);
  const newcomer = more[12].vin;
  assert.equal(second.snapshot.vehicles[newcomer].firstSeenAt, second.res.fetchedAt);
  assert.ok(second.snapshot.vehicles[newcomer].firstSeenAt > first.res.fetchedAt);
  for (const c of cars) assert.equal(second.snapshot.vehicles[c.vin].firstSeenAt, null, 'the rest were already there');
  // a scan whose snapshot is not saved (11 of 13 gone at once is unreliable): the next scan still carries from the last saved one
  const broken = await rescanOf(thinListSite(more.slice(11)), second.snapshot);
  assert.equal(broken.diff.unreliable, true);
  const third = await rescanOf(thinListSite(more), second.snapshot);
  assert.equal(third.snapshot.vehicles[newcomer].firstSeenAt, second.res.fetchedAt, 'the first sighting is the saved snapshot\'s, not the broken scan\'s');
  for (const c of cars) assert.equal(third.snapshot.vehicles[c.vin].firstSeenAt, null);
  // a car whose page failed keeps its whole last entry, dates included
  const bad = await rescanOf(thinListSite(more, { [more[12].path]: httpError(500) }), second.snapshot);
  assert.deepEqual(bad.res.unread, [newcomer]);
  assert.equal(bad.snapshot.vehicles[newcomer].firstSeenAt, second.res.fetchedAt);
});

test('the same first-sighting rule through the inventory-service adapter the background rescan uses', async () => {
  const { default: dealerInspire } = await import('../extension/adapters/dealerInspire.js');
  const { fakeDealerPage, runInPage } = await import('./helpers.js');
  const site = { origin: 'https://example-dealer.test', host: 'example-dealer.test', name: 'Example Motors', title: 'Used', adapter: 'dealerInspire' };
  const service = { search: 'https://example-dealer.test/api/v1/listings/1', apiKey: 'test-key', visibleStatusValues: ['publish', 'modified', 'pend-sale'] };
  const scanOf = (records, prevSnapshot) => {
    const page = fakeDealerPage({ records });
    const search = (body) => runInPage(page, dealerInspire.searchInPage, service, body).then((r) => r.data);
    return scanWithSearch({ adapter: dealerInspire, search, site, settings: withDefaults({ myStores: [WAYNESBURG] }, site), prevSnapshot, options: dealerInspire.scanOptions(service) });
  };
  const day1 = [fixtures.usedNormal, fixtures.certified, fixtures.usedNoCarfax];
  const first = await scanOf(day1, null);
  assert.equal(first.ok, true);
  assert.deepEqual(Object.values(first.snapshot.vehicles).map((e) => [e.dateInStock, e.firstSeenAt]), day1.map((r) => [r.date_in_stock, null]), 'the website\'s dates, and nothing new by first sighting');
  const second = await scanOf([...day1, fixtures.usedNoPhotos], first.snapshot);
  assert.equal(second.snapshot.vehicles[fixtures.usedNoPhotos.vin].firstSeenAt, second.res.fetchedAt);
  assert.equal(second.snapshot.vehicles[fixtures.usedNoPhotos.vin].dateInStock, fixtures.usedNoPhotos.date_in_stock);
  assert.equal(second.snapshot.vehicles[fixtures.usedNormal.vin].firstSeenAt, null);
});

test("a new arrival in the diff carries the car's dates, so To do can show them when this scan's snapshot is not saved", async () => {
  const { dateLine } = await import('../extension/src/readyList.js');
  // the scan times and "now" are on the machine's own clock, as the popup's are, so the words below hold in every time zone
  const T1 = new Date(2026, 8, 30, 9, 0).toISOString();
  const T2 = new Date(2026, 9, 1, 9, 0).toISOString();
  const big = [];
  for (let i = 0; i < 12; i += 1) big.push(['usedNormal', { vin: `1C6RR7FT0KS64${String(1000 + i)}`, date_in_stock: '2026-09-01T00:00:00.000Z' }]);
  const prev = makeSnapshotFrom(big, T1, null);
  const dated = ['usedNoCarfax', { date_in_stock: '2026-09-30T00:00:00.000Z' }];
  const undated = ['usedNoPhotos', { date_in_stock: null }];
  // a scan that drops 10 of 12 cars is unreliable: the popup and the service worker save its diff but not its snapshot
  const curr = makeSnapshotFrom([...big.slice(0, 2), dated, undated], T2, prev);
  const d = diffScans(prev, curr);
  assert.equal(d.unreliable, true);
  assert.deepEqual(d.newArrivals.map((n) => [n.vin, n.dateInStock, n.firstSeenAt]), [[VIN.hellcat, '2026-09-30T00:00:00.000Z', T2], [VIN.tradesman, null, T2]], 'the website\'s date as it gave it, and this sighting');
  const now = new Date(2026, 9, 1, 12, 0).getTime();
  assert.equal(dateLine(d.newArrivals[0], { now, locale: 'en-US' }), 'on the website since Sep 30 · 1 day on the lot');
  assert.equal(dateLine(d.newArrivals[1], { now, locale: 'en-US' }), 'Lot Current first saw it Oct 1');
  // a reliable rescan says the same of its newcomer
  const ok = diffScans(prev, makeSnapshotFrom([...big, dated], T2, prev));
  assert.equal(ok.unreliable, false);
  assert.deepEqual(ok.newArrivals.map((n) => [n.vin, n.dateInStock, n.firstSeenAt]), [[VIN.hellcat, '2026-09-30T00:00:00.000Z', T2]]);
  // a first scan has no arrivals, and nothing else in the diff changed shape
  assert.deepEqual(diffScans(null, curr).newArrivals, []);
  assert.deepEqual(Object.keys(ok.newArrivals[0]).sort(), ['dateInStock', 'decision', 'firstSeenAt', 'name', 'price', 'reason', 'stock', 'url', 'vin']);
});

test('a car the last snapshot still names among its missing pages is not a first sighting when it comes back: it keeps the sighting kept for it, else none', async () => {
  const T1 = '2026-09-27T09:00:00.000Z';
  const T2 = '2026-09-28T09:00:00.000Z';
  const page = 'https://example-dealer.test/car/x';
  // the rule itself (rescan.js firstSeenAt)
  assert.equal(firstSeenAt({ vehicles: {}, missingPages: { X: page } }, 'X', T2), null, 'known before, when it arrived unknown: no date, never this scan\'s');
  assert.equal(firstSeenAt({ vehicles: {}, missingPages: { X: page }, missingSeen: { X: T1 } }, 'X', T2), T1, 'known before, with the sighting the snapshot kept');
  assert.equal(firstSeenAt({ vehicles: {}, missingPages: { X: page }, missingSeen: { X: 42 } }, 'X', T2), null, 'a non-string sighting is none');
  assert.equal(firstSeenAt({ vehicles: {}, missingPages: { Y: page }, missingSeen: { X: T1 } }, 'X', T2), T2, 'a car not among the missing pages is a newcomer');
  assert.equal(firstSeenAt({ vehicles: {}, missingPages: 'x' }, 'X', T2), T2, 'garbage missing pages are none');
  // through the scan runner: a car already there at the first scan leaves the list on a bad server day (its page cannot be checked, so it is kept among the missing pages) and is back the scan after
  const cars = standardCars(12);
  const first = await rescanOf(thinListSite(cars), null);
  const rest = cars.slice(1);
  const bad = await rescanOf(thinListSite(rest, { [cars[0].path]: httpError(429) }), first.snapshot);
  assert.deepEqual(Object.keys(bad.snapshot.missingPages), [cars[0].vin]);
  assert.equal(bad.snapshot.missingSeen, undefined, 'nothing to keep: Lot Current did not see this car arrive');
  const back = await rescanOf(thinListSite(cars), bad.snapshot);
  assert.deepEqual(back.diff.newArrivals.map((n) => n.vin), [cars[0].vin], 'the VIN diff still lists its return once');
  assert.equal(back.snapshot.vehicles[cars[0].vin].firstSeenAt, null, 'not a first sighting: Lot Current had seen it in both scans before');
  // a newcomer that leaves and comes back keeps the sighting it had
  const more = standardCars(13);
  const newcomer = more[12];
  const second = await rescanOf(thinListSite(more), first.snapshot);
  const seenAt = second.snapshot.vehicles[newcomer.vin].firstSeenAt;
  assert.equal(seenAt, second.res.fetchedAt);
  const gone = await rescanOf(thinListSite(cars, { [newcomer.path]: httpError(500) }), second.snapshot);
  assert.deepEqual(gone.snapshot.missingPages, { [newcomer.vin]: STANDARD_ORIGIN + newcomer.path });
  assert.deepEqual(gone.snapshot.missingSeen, { [newcomer.vin]: seenAt }, 'its sighting goes with its page');
  const returned = await rescanOf(thinListSite(more), gone.snapshot);
  assert.equal(returned.snapshot.vehicles[newcomer.vin].firstSeenAt, seenAt, 'the sighting it had, not this scan\'s');
  assert.equal(returned.snapshot.missingSeen, undefined);
  // a posted car gone for several scans keeps its page and its sighting the whole time
  const posted = markPosted({}, { vin: newcomer.vin, name: 'posted car', price: newcomer.price });
  let prev = second.snapshot;
  for (let day = 1; day <= 3; day += 1) {
    const out = await rescanOf(thinListSite(cars, { [newcomer.path]: httpError(500) }), prev, posted);
    assert.deepEqual(out.snapshot.missingSeen, { [newcomer.vin]: seenAt }, `scan ${day} without it`);
    prev = out.snapshot;
  }
  assert.equal((await rescanOf(thinListSite(more), prev, posted)).snapshot.vehicles[newcomer.vin].firstSeenAt, seenAt);
});
