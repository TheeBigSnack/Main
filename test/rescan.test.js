import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScans, markPosted, markPriceUpdated, markTakenDown, basisPrice } from '../extension/src/rescan.js';
import { snapshot, fixtures, vehicle } from './helpers.js';

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
  assert.equal(basisPrice({ priceBeforeFees: 19000 }, 'beforeFees'), 19000);
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

test('price drop on a car you posted: update from your listing price', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: { low: { label: 'Ron Lewis Real Price', value: '26163' } } } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
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
  const curr = snapshot([['usedNormal'], ['certified'], ['usedNoCarfax'], ['usedNoPhotos', { extra_fields: { lightning: { pricing: { low: { label: 'Ron Lewis Real Price', value: '34485' } } } } }]]);
  const d = diffScans(snapshot(LOT), curr, { confirm: confirmed() });
  assert.equal(d.priceUpdates.length, 1);
  assert.equal(d.priceUpdates[0].change, 1000);
  assert.equal(d.priceUpdates[0].yours, false);
});

test('"before fees" price basis compares the price without the doc fee', () => {
  const curr = snapshot([['usedNormal', { pricing: { internet_price: 25673 } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const website = diffScans(snapshot(LOT), curr, { confirm: confirmed() });
  const beforeFees = diffScans(snapshot(LOT), curr, { confirm: confirmed(), basis: 'beforeFees' });
  assert.equal(website.priceUpdates.length, 0);
  assert.equal(beforeFees.priceUpdates.length, 1);
  assert.equal(beforeFees.priceUpdates[0].change, -1000);
});

test('website switches to "call for price": needs a look', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { extra_fields: { lightning: { pricing: { low: false, high: { label: 'Price', value: 'Please call for price' } } } } }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed() });
  assert.equal(d.priceUpdates.length, 0);
  assert.equal(d.needsALook.length, 1);
  assert.match(d.needsALook[0].text, /no longer shows a price/);
});

test('car you posted goes sale-pending: take down', () => {
  const posted = { [VIN.ram]: { name: 'Ram', price: 27163 } };
  const curr = snapshot([['usedNormal', { status: 'pend-sale' }], ['certified'], ['usedNoCarfax'], ['usedNoPhotos']]);
  const d = diffScans(snapshot(LOT), curr, { posted, confirm: confirmed() });
  assert.equal(d.takeDown.length, 1);
  assert.equal(d.takeDown[0].why, 'sale-pending');
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

test('posted-listing bookkeeping', () => {
  const s = snapshot(LOT);
  let posted = markPosted({}, s.vehicles[VIN.ram], 'website', '2026-09-26T21:00:00.000Z');
  assert.deepEqual(posted[VIN.ram], { name: '2019 Ram 1500 Classic Express', price: 27163, postedAt: '2026-09-26T21:00:00.000Z' });
  posted = markPriceUpdated(posted, VIN.ram, 26163, '2026-09-27T21:00:00.000Z');
  assert.equal(posted[VIN.ram].price, 26163);
  posted = markTakenDown(posted, VIN.ram);
  assert.deepEqual(posted, {});
});
