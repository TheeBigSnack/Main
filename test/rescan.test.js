import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScans, markPosted, markPriceUpdated, markTakenDown, basisPrice, listingBasis, snapshotEntry, makeSnapshot, firstSeenAt } from '../extension/src/rescan.js';
import { snapshot, fixtures, vehicle, STANDARD_ORIGIN, standardCars, standardSite, fakeSiteSearch, httpError, MY_STORE, WAYNESBURG } from './helpers.js';
import { assessVehicle } from '../extension/src/classify.js';
import * as rescan from '../extension/src/rescan.js';
import { readFileSync } from 'node:fs';
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
  assert.deepEqual(posted[VIN.ram], { name: '2019 Ram 1500 Classic Express', price: 27163, basis: 'website', postedAt: '2026-09-26T21:00:00.000Z' });
  posted = markPriceUpdated(posted, VIN.ram, 26163, '2026-09-27T21:00:00.000Z');
  assert.equal(posted[VIN.ram].price, 26163);
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
  assert.equal(listingBasis(entry(27163)[VIN.ram], [s.vehicles[VIN.ram]], 'beforeFees'), 'website');
  assert.equal(listingBasis(entry(26673)[VIN.ram], [s.vehicles[VIN.ram]], 'website'), 'beforeFees');
  assert.equal(listingBasis({ price: 26673, basis: 'website' }, [s.vehicles[VIN.ram]], 'beforeFees'), 'website', 'a recorded basis wins');
  assert.equal(listingBasis({ price: 20000 }, [{ price: 20000 }], 'beforeFees'), 'beforeFees', 'both bases give the same price: the setting');
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

// My listings (popup.js viewMine), as written, with the page around it
// stubbed: each row's parts are collected as viewMine hands them over.
function myListings(posted, vehicles, basis) {
  const src = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const start = src.indexOf('function viewMine(');
  assert.ok(start >= 0, 'viewMine is defined');
  const state = { settings: { basis } };
  const shown = [];
  const scope = {
    state,
    esc: (x) => String(x ?? ''),
    empty: (x) => x,
    rows: (items) => items.join(''),
    row: (entry, parts) => { shown.push(parts); return ''; },
    money: (n) => `$${n}`,
    when: (x) => String(x),
    price: (e) => rescan.basisPrice(e, basis), // what viewMine used before listingWebsitePrice
    listingWebsitePrice: rescan.listingWebsitePrice,
  };
  const viewMine = new Function(...Object.keys(scope), `${src.slice(start, src.indexOf('\n}\n', start) + 2)}\nreturn viewMine;`)(...Object.values(scope));
  viewMine({ mine: Object.entries(posted).map(([vin, p]) => ({ vin, ...p, now: vehicles[vin] || null })) });
  return shown.map((r) => ({ changed: /Website price changed/.test(r.sub), right: r.right, updated: (r.action.match(/data-action="priceUpdated"[^>]*data-price="(\d+)"/) || [])[1] || null }));
}

test('My listings compares each listing on its own price basis: a switch of Price to post is not a change, and Updated records the listing\'s basis price', () => {
  const s = snapshot(LOT); // the Ram: 27,163 main, 26,673 before fees
  for (const [postedAs, setting] of [['website', 'beforeFees'], ['beforeFees', 'website']]) {
    const posted = markPosted({}, s.vehicles[VIN.ram], postedAs, AT);
    const [ram] = myListings(posted, s.vehicles, setting);
    assert.deepEqual(ram, { changed: false, right: `Listed $${posted[VIN.ram].price}`, updated: null }, `posted at the ${postedAs} price, setting now ${setting}`);
  }
  // a listing posted before the basis was recorded: the website price it carries tells
  assert.equal(myListings({ [VIN.ram]: { name: 'Ram', price: 27163, postedAt: AT } }, s.vehicles, 'beforeFees')[0].changed, false);
  assert.equal(myListings({ [VIN.ram]: { name: 'Ram', price: 26673, postedAt: AT } }, s.vehicles, 'website')[0].changed, false);
  // a real drop shows at the listing's own basis, and Updated records that price: the next scan has nothing left
  const posted = markPosted({}, s.vehicles[VIN.ram], 'website', AT);
  const dropped = repriced(snapshot(LOT), VIN.ram, 26163, 25673);
  const [ram] = myListings(posted, dropped.vehicles, 'beforeFees');
  assert.deepEqual(ram, { changed: true, right: 'Listed $27163<br>Website $26163', updated: '26163' });
  const updated = markPriceUpdated(posted, VIN.ram, Number(ram.updated), '2026-09-27T21:00:00.000Z');
  assert.deepEqual(moves(diffScans(dropped, dropped, { posted: updated, confirm: confirmed(), basis: 'beforeFees' })), []);
  assert.equal(myListings(updated, dropped.vehicles, 'beforeFees')[0].changed, false);
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
