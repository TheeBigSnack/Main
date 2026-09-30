import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScans, markPosted, markPriceUpdated, markTakenDown, basisPrice } from '../extension/src/rescan.js';
import { snapshot, fixtures, vehicle, STANDARD_ORIGIN, standardCars, standardSite, fakeSiteSearch, httpError } from './helpers.js';
import schemaOrg from '../extension/adapters/schemaOrg.js';
import { scanWithSearch } from '../extension/src/scanRunner.js';
import { withDefaults } from '../extension/src/settings.js';

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
  assert.deepEqual(posted[VIN.ram], { name: '2019 Ram 1500 Classic Express', price: 27163, postedAt: '2026-09-26T21:00:00.000Z' });
  posted = markPriceUpdated(posted, VIN.ram, 26163, '2026-09-27T21:00:00.000Z');
  assert.equal(posted[VIN.ram].price, 26163);
  posted = markTakenDown(posted, VIN.ram);
  assert.deepEqual(posted, {});
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
  for (const status of [403, 429, 500]) {
    const { out } = await standardRescan(cars, cars.slice(1), (site) => site.set(STANDARD_ORIGIN + cars[0].path, httpError(status)));
    assert.match(out.res.confirm.error, new RegExp(String(status)));
    assert.deepEqual(out.diff.takeDown, [], `HTTP ${status}`);
    assert.deepEqual(out.diff.needsALook.map((n) => n.vin), [cars[0].vin]);
    assert.match(out.diff.warnings.join(' '), /Couldn't double-check missing cars .*Nothing was marked as gone/);
  }
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
