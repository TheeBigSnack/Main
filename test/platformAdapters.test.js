// The DealerOn and Dealer.com adapters and the inventory-data reader they
// share (extension/adapters/inventoryJson.js). The sites are synthetic
// stand-ins (test/platformSites.js): no live DealerOn or Dealer.com page has
// been read yet, so these tests pin the behaviour the adapters promise, not
// the platforms' exact data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dealerOn, { pageAddress as dealerOnPage, pagePhotos } from '../extension/adapters/dealerOn.js';
import dealerCom, { pageAddress as dealerComPage } from '../extension/adapters/dealerCom.js';
import dealerInspire from '../extension/adapters/dealerInspire.js';
import schemaOrg from '../extension/adapters/schemaOrg.js';
import { keyName, pick, findCards, totalCount, labeledPrices, choosePrices, priceKind, imageUrls, normalizeInventoryRecord, MAX_INVENTORY_PAGES, mileageOf, cappedText, crawlDelaySeconds, scanInventory, MAX_PAGE_GAP_MS, MAX_FAILED_IN_A_ROW } from '../extension/adapters/inventoryJson.js';
import { assessVehicle, DECISION, checkPreOwned } from '../extension/src/classify.js';
import { basisPrice } from '../extension/src/rescan.js';
import { feeGap, withDefaults } from '../extension/src/settings.js';
import { scanWithSearch } from '../extension/src/scanRunner.js';
import { VEHICLE_FIELDS } from '../extension/src/vehicle.js';
import { fakeDealerPage, fakeStandardPage, runInPage } from './helpers.js';
import {
  DEALERON_ORIGIN, DEALERON_LIST, DEALERCOM_ORIGIN, DEALERCOM_LIST, platformCars, dealerOnSite, dealerComSite, dealerOnCard, dealerComRecord,
  dealerOnPath, dealerComPath, dealerOnCarPage, platformSearch, fakePlatformPage, answerWith,
} from './platformSites.js';

const onService = { kind: 'dealerOn', origin: DEALERON_ORIGIN, inventoryUrl: DEALERON_LIST, listUrl: DEALERON_ORIGIN + '/searchused.aspx' };
const comService = { kind: 'dealerCom', origin: DEALERCOM_ORIGIN, inventoryUrl: DEALERCOM_LIST, listUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm' };

// ---------- the shared reader ----------

test('keyName and pick read a field by its usual names, with or without a Vehicle prefix, nested one level or in an attribute list', () => {
  assert.equal(keyName('VehicleVin'), 'vin');
  assert.equal(keyName('stock_number'), 'stocknumber');
  assert.equal(keyName('Vehicle'), 'vehicle', 'a bare "Vehicle" stays a word');
  assert.equal(pick({ VehicleMake: 'Jeep' }, ['make']), 'Jeep');
  assert.equal(pick({ address: { accountName: 'Sample Ford' } }, ['accountname'], { nested: true }), 'Sample Ford');
  assert.equal(pick({ address: { accountName: 'Sample Ford' } }, ['accountname']), undefined, 'nested objects only when asked');
  assert.equal(pick({ attributes: [{ name: 'exteriorColor', value: 'Red' }] }, ['exteriorcolor']), 'Red');
  assert.equal(pick({ make: '', brand: 'Kia' }, ['make', 'brand']), 'Kia', 'an empty value is no value');
  assert.equal(pick({ make: 'Kia', inner: { make: 'Ford' } }, ['make'], { nested: true }), 'Kia', 'own keys first');
  assert.equal(pick({ brand: 'Kia', inner: { make: 'Ford' } }, ['make', 'brand'], { nested: true }), 'Kia', 'any own name before a nested one');
  assert.equal(pick(null, ['make']), undefined);
});

test('findCards finds the records that carry a valid VIN in the answer\'s largest list, one per VIN, and lifts a nested card', () => {
  const [a, b, c] = platformCars(3);
  const json = {
    featured: { vin: a.vin }, // not in a list: not a car of the list
    DisplayCards: [{ VehicleCard: { VehicleVin: b.vin, VehicleYear: 2019 }, Badge: 'Great deal' }, { VehicleCard: { VehicleVin: b.vin } }, { VehicleCard: { VehicleVin: c.vin } }, { VehicleCard: { VehicleVin: 'NOTAVIN' } }],
    more: { similar: [{ vin: a.vin.toLowerCase(), year: 2018 }] },
  };
  const cards = findCards(json);
  assert.deepEqual(cards.map((x) => x.VehicleVin), [b.vin, c.vin], 'the two-car list, not the one-car list beside it');
  assert.equal(cards[0].Badge, 'Great deal', 'what sits next to the nested card is kept');
  assert.equal(cards[0].VehicleCard, undefined, 'the nested card is lifted, not copied');
  assert.deepEqual(findCards({ inventory: [{ vin: a.vin.toLowerCase() }] }).map((x) => x.vin), [a.vin.toLowerCase()]);
  assert.deepEqual(findCards(null), []);
  assert.deepEqual(findCards({ inventory: [] }), []);
});

test('totalCount reads only a field named as a count, never a bare total or a car', () => {
  assert.equal(totalCount({ Paging: { PaginationDataModel: { TotalCount: 41 } } }), 41);
  assert.equal(totalCount({ pageInfo: { totalCount: 7 } }), 7);
  assert.equal(totalCount({ total: 25999, pricing: { total: 3 } }), null, 'a bare total can be a price');
  assert.equal(totalCount({ inventory: [{ vin: platformCars(1)[0].vin, totalCount: 9 }] }), null, 'never inside a car');
  assert.equal(totalCount({ pageInfo: { totalCount: 'many' } }), null);
});

test('labeledPrices reads labelled entries and price-named fields; never payments, photos or "Call"', () => {
  const got = labeledPrices({
    pricing: { retailPrice: '$23,495', dprice: [{ typeClass: 'internetPrice', label: 'Sample Price', value: '$23,985', isFinalPrice: true }, { label: 'Payment', value: 'From $399/mo' }] },
    VehiclePriceLabel: 'Sample Price',
    images: [{ price: 1 }],
    callPrice: 'Call for price',
  });
  assert.deepEqual(got.map((e) => [e.value, e.label, e.final]), [[23495, 'retail Price', false], [23985, 'Sample Price', true]]);
});

test('priceKind: selling, base, plain, named and everything that is not the price', () => {
  const k = (label, key = '', final = false, dealer = '') => priceKind({ label, key, final, value: 1 }, dealer);
  assert.equal(k('Example Price', '', false, 'Example Motors of Springfield'), 'selling', 'a price named for this dealership');
  assert.equal(k('E. Example Price', '', false, 'E. Example Auto Group'), 'selling');
  assert.equal(k('Example Price'), 'named', 'with no dealership name to match, a named price is not taken as the dealer\'s');
  assert.equal(k('Other Price', '', false, 'Example Motors'), 'named');
  assert.equal(k('Internet Price'), 'selling');
  assert.equal(k('Price', 'x.retailPrice'), 'base', 'Dealer.com labels its retail entry just "Price"');
  assert.equal(k('Retail Value'), 'base');
  assert.equal(k('Retail Price'), 'base');
  assert.equal(k('Price'), 'plain');
  assert.equal(k('MSRP', '', true), 'other', 'a final flag never makes an MSRP the price');
  for (const label of ['MSRP', 'Was', 'Doc Fee', 'Conditional Offer', 'Payment', 'Est. Monthly', 'Dealer Discount', 'Factory Rebate', 'Cash Back', 'Total Savings',
    'KBB Price', 'Kelley Blue Book Value', 'Market Price', 'Market Value', 'Employee Price', 'Supplier Price', 'Military Price', 'Loyalty Price', 'Wholesale Price',
    'Previous Price', 'Prior Price', 'Lowest Price', 'Highest Price', 'Estimated Value', 'Book Value', 'Trade-In Value']) {
    // the dealership's name holds the words, but not at its opening: they keep their meaning
    assert.equal(k(label, '', false, 'Springfield KBB Market Employee Wholesale Motors'), 'other', label);
  }
  // as the opening words of the dealership's name they are its own price (R-8, repair round 2)
  assert.equal(k('KBB Price', '', false, 'KBB Market Employee Wholesale Motors'), 'selling');
  assert.equal(k('Market Price', '', false, 'KBB Market Employee Wholesale Motors'), 'other', 'not the name\'s opening words');
  assert.equal(k('Final price', 'finalPrice', true), 'selling');
});

test('choosePrices: the dealer\'s selling price, the lower base price beside it, and no price when it can\'t tell', () => {
  const e = (value, label, extra = {}) => ({ value, label, key: '', final: false, ...extra });
  const dealer = 'Example Motors';
  // the surveyed shape (made-up amounts): a retail figure, a doc fee, and the dealer-named price with the fee in it
  assert.deepEqual(choosePrices([e(31000, 'Retail Value'), e(700, 'Doc Fee'), e(31700, 'Example Price')], { dealer }), { price: 31700, priceLabel: 'Example Price', priceBeforeFees: 31000 });
  assert.deepEqual(choosePrices([e(23000, 'Price', { key: 'p.retailPrice' }), e(23500, 'Example Price', { final: true })]), { price: 23500, priceLabel: 'Example Price', priceBeforeFees: 23000 });
  // the same dealer-named price on a record that names no dealership: no guess
  assert.deepEqual(choosePrices([e(31000, 'Retail Value'), e(31700, 'Example Price')]), { price: null, priceLabel: 'Two prices on the website', priceBeforeFees: null });
  // a retail price above a sale price is not a "before fees" price
  assert.deepEqual(choosePrices([e(26000, 'Retail Price'), e(24500, 'Sale Price')]), { price: 24500, priceLabel: 'Sale Price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([e(19999, 'Price')]), { price: 19999, priceLabel: 'Price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([e(19999, 'Retail Price')]), { price: 19999, priceLabel: 'Retail Price', priceBeforeFees: null }, 'a base price that is the only price is the price');
  assert.deepEqual(choosePrices([e(30000, 'MSRP')]), { price: null, priceLabel: 'Call for price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([]), { price: null, priceLabel: 'Call for price', priceBeforeFees: null });
  assert.equal(choosePrices([e(20000, 'Internet Price'), e(20500, 'Example Price')], { dealer }).price, null, 'two selling prices, nothing to rank them: no price');
  assert.equal(choosePrices([e(20000, 'Internet Price'), e(20500, 'Example Price', { final: true })]).price, 20500, 'the one the platform marks final wins');
  assert.equal(choosePrices([e(20000, 'Price'), e(21000, 'Price')]).price, null);
  // book, market and conditional figures never become the price or the lower price
  assert.deepEqual(choosePrices([e(20000, 'Price'), e(22500, 'KBB Price')]), { price: 20000, priceLabel: 'Price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([e(20000, 'Price'), e(19000, 'Employee Price')]), { price: 20000, priceLabel: 'Price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([e(21000, 'Internet Price'), e(18500, 'KBB Value')]), { price: 21000, priceLabel: 'Internet Price', priceBeforeFees: null });
  assert.equal(choosePrices([e(18500, 'Kelley Blue Book Value')]).price, null);
  const fields = labeledPrices({ price: 21000, previousPrice: 23000, wholesalePrice: 17000 });
  assert.deepEqual(choosePrices(fields), { price: 21000, priceLabel: 'price', priceBeforeFees: null });
});

test('imageUrls: strings or { uri | url | src }, absolute, http(s) only, once each', () => {
  assert.deepEqual(imageUrls(['/a.jpg', { uri: 'https://pictures.dealer.com/x.jpg' }, { src: '/a.jpg' }, 'javascript:alert(1)', { nope: 1 }], 'https://d.test/car'), ['https://d.test/a.jpg', 'https://pictures.dealer.com/x.jpg']);
  assert.deepEqual(imageUrls(null, 'https://d.test/'), []);
  assert.deepEqual(imageUrls('https://d.test/one.jpg'), ['https://d.test/one.jpg']);
});

// ---------- DealerOn: the record ----------

test('a DealerOn card becomes the flat vehicle; three signs say pre-owned and it is ready', () => {
  const [c] = platformCars(1, { from: 1 });
  const v = dealerOn.normalize({ card: dealerOnCard(c).VehicleCard, origin: DEALERON_ORIGIN });
  assert.deepEqual(Object.keys(v).sort(), [...VEHICLE_FIELDS].sort());
  assert.equal(v.vin, c.vin);
  assert.equal(v.name, `${c.year} ${c.make} ${c.model} ${c.trim}`);
  assert.equal(v.stock, c.stock);
  assert.equal(v.mileage, c.miles, 'the "34,512"-style text is a number');
  assert.equal(v.url, DEALERON_ORIGIN + dealerOnPath(c));
  assert.equal(v.urlConditionWord, 'used');
  assert.equal(v.inventoryType, 'Used');
  assert.equal(v.siteTitle, `Used ${c.year} ${c.make} ${c.model} ${c.trim}`);
  assert.equal(v.price, c.base + c.fee, 'the dealer\'s price, fee included, by default');
  assert.equal(v.priceBeforeFees, c.base);
  assert.equal(v.location, 'Sample Motors');
  assert.equal(v.photoCount, c.photos, 'the list says how many photos the car has');
  assert.equal(v.photos.length, 1, 'the list carries one thumbnail; the post-time read brings the rest');
  assert.equal(v.descriptionRaw, null, 'the list has no description: this read did not have one');
  assert.equal(v.bodyType, c.body);
  assert.equal(checkPreOwned(v).verdict, 'pre-owned');
  assert.equal(assessVehicle(v, withDefaults({})).decision, DECISION.READY);
});

test('DealerOn: a certified car, a new car, a one-letter condition code and a card with no condition at all', () => {
  const [c] = platformCars(1); // i = 200: certified
  const cert = dealerOn.normalize({ card: dealerOnCard(c).VehicleCard, origin: DEALERON_ORIGIN });
  assert.equal(cert.inventoryType, 'Certified Used');
  assert.equal(checkPreOwned(cert).verdict, 'pre-owned');
  const fresh = { ...dealerOnCard(c).VehicleCard, VehicleIsCertified: false, VehicleCondition: 'New', VehicleName: `New ${c.year} ${c.make}`, VehicleDetailUrl: `/new-Springfield-${c.year}-${c.make}-${c.vin}` };
  assert.equal(assessVehicle(dealerOn.normalize({ card: fresh, origin: DEALERON_ORIGIN }), {}).decision, DECISION.SKIP, 'new never enters a posting flow');
  const coded = dealerOn.normalize({ card: { ...dealerOnCard(c).VehicleCard, VehicleIsCertified: false, VehicleCondition: 'U' }, origin: DEALERON_ORIGIN });
  assert.equal(coded.inventoryType, 'Used');
  const bare = { VehicleVin: c.vin, VehicleYear: c.year, VehicleMake: c.make, VehicleModel: c.model, VehicleInternetPrice: 19999, Mileage: 40000, VehicleDetailUrl: '/vehicle-details/' + c.vin, VehiclePhotos: ['/p.jpg'] };
  const unknown = dealerOn.normalize({ card: bare, origin: DEALERON_ORIGIN });
  assert.equal(unknown.inventoryType, null);
  assert.equal(assessVehicle(unknown, {}).decision, DECISION.REVIEW, 'nothing says used: Needs a look, never Ready');
  const bodyWord = dealerOn.normalize({ card: { ...bare, VehicleType: 'SUV' }, origin: DEALERON_ORIGIN });
  assert.equal(bodyWord.inventoryType, null, 'a type field that names a body is not a condition');
});

test('the price basis setting chooses between the dealer\'s price and the base price below it', () => {
  const lot = platformCars(5).map((c) => dealerOn.normalize({ card: dealerOnCard(c).VehicleCard, origin: DEALERON_ORIGIN }));
  for (const v of lot) {
    assert.equal(basisPrice(v, 'website'), v.price);
    assert.equal(basisPrice(v, 'beforeFees'), v.priceBeforeFees);
    assert.ok(v.priceBeforeFees < v.price);
  }
  assert.equal(feeGap(lot).gap, 490, 'the fee the wizard suggests for the price note, read from this lot');
  const com = platformCars(3).map((c) => dealerCom.normalize({ card: dealerComRecord(c), origin: DEALERCOM_ORIGIN }));
  assert.equal(feeGap(com).gap, 490);
});

// ---------- Dealer.com: the record ----------

test('a Dealer.com record becomes the flat vehicle from its published field names', () => {
  const [c] = platformCars(1, { from: 1 });
  const v = dealerCom.normalize({ card: dealerComRecord(c), origin: DEALERCOM_ORIGIN });
  assert.deepEqual(Object.keys(v).sort(), [...VEHICLE_FIELDS].sort());
  assert.equal(v.vin, c.vin);
  assert.equal(v.mileage, c.miles);
  assert.equal(v.inventoryType, 'used');
  assert.equal(v.urlConditionWord, 'used');
  assert.equal(v.url, DEALERCOM_ORIGIN + dealerComPath(c));
  assert.equal(v.price, c.base + c.fee);
  assert.equal(v.priceLabel, 'Sample Price');
  assert.equal(v.priceBeforeFees, c.base);
  assert.equal(v.location, 'Sample Chevrolet');
  assert.equal(v.drivetrain, 'FWD');
  assert.equal(v.photos.length, c.photos);
  assert.ok(v.photos.every((u) => u.startsWith('https://pictures.dealer.com/')));
  assert.equal(checkPreOwned(v).verdict, 'pre-owned', 'type and address agree');
  assert.equal(assessVehicle(v, withDefaults({})).decision, DECISION.READY);
  const cert = dealerCom.normalize({ card: dealerComRecord(platformCars(1)[0]), origin: DEALERCOM_ORIGIN });
  assert.equal(cert.inventoryType, 'Certified Used');
  assert.equal(cert.urlConditionWord, 'certified');
  assert.equal(dealerCom.normalize({ card: { vin: 'short' }, origin: DEALERCOM_ORIGIN }), null);
  assert.equal(normalizeInventoryRecord({ ...dealerComRecord(c), link: 'javascript:void(0)' }, { origin: DEALERCOM_ORIGIN }).url, null);
});

// ---------- the in-page probes ----------

test('the DealerOn probe takes the list address the page itself asked for, on its own website only', async () => {
  const other = 'https://tracking.example-analytics.test/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/1/2';
  const page = fakePlatformPage({ origin: DEALERON_ORIGIN, path: '/searchused.aspx#top', requested: [other, DEALERON_LIST, DEALERON_LIST + '&pt=2'] });
  assert.deepEqual(await runInPage(page, dealerOn.probeInPage), { kind: 'dealerOn', origin: DEALERON_ORIGIN, inventoryUrl: DEALERON_LIST, listUrl: DEALERON_ORIGIN + '/searchused.aspx' });
  // a DealerOn car page: the platform is known, the list is not
  const car = fakePlatformPage({ origin: DEALERON_ORIGIN, path: '/used-Springfield-2019-Jeep', text: 'Copyright © 2026 by DealerOn. All rights reserved.', scripts: [DEALERON_ORIGIN + '/dealeron-js.aspx'] });
  assert.equal((await runInPage(car, dealerOn.probeInPage)).inventoryUrl, null);
  const scripted = fakePlatformPage({ origin: DEALERON_ORIGIN, scripts: ['https://cdn.dealeron.com/app.js'] });
  assert.equal((await runInPage(scripted, dealerOn.probeInPage)).kind, 'dealerOn');
  assert.equal(await runInPage(fakePlatformPage({ origin: DEALERON_ORIGIN, text: 'We sell cars. DealerOne Motors.' }), dealerOn.probeInPage), null);
  assert.equal(await runInPage(fakePlatformPage({ origin: 'https://www.facebook.com', text: 'Copyright by DealerOn' }), dealerOn.probeInPage), null, 'never on Facebook');
});

test('the Dealer.com probe: the getInventory request, the page\'s DDC object or its files; never its credit line alone', async () => {
  const page = fakePlatformPage({ origin: DEALERCOM_ORIGIN, path: '/used-inventory/index.htm', requested: [DEALERCOM_ORIGIN + '/static/app.js', DEALERCOM_LIST] });
  assert.deepEqual(await runInPage(page, dealerCom.probeInPage), { kind: 'dealerCom', origin: DEALERCOM_ORIGIN, inventoryUrl: DEALERCOM_LIST, listUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm' });
  assert.equal((await runInPage(fakePlatformPage({ origin: DEALERCOM_ORIGIN, windowExtras: { DDC: {} } }), dealerCom.probeInPage)).inventoryUrl, null);
  assert.equal((await runInPage(fakePlatformPage({ origin: DEALERCOM_ORIGIN, scripts: ['https://static.dealer.com/v9/x.js'] }), dealerCom.probeInPage)).kind, 'dealerCom');
  assert.equal(await runInPage(fakePlatformPage({ origin: DEALERCOM_ORIGIN, text: 'Website by Dealer.com' }), dealerCom.probeInPage), null, 'a credit line alone is not the platform');
  assert.equal(await runInPage(fakePlatformPage({ origin: DEALERCOM_ORIGIN, text: 'Your trusted dealer. com-munity first.' }), dealerCom.probeInPage), null);
  assert.equal(await runInPage(fakePlatformPage({ origin: DEALERCOM_ORIGIN, scripts: ['https://cdn.notdealer.com/x.js'] }), dealerCom.probeInPage), null, 'a look-alike host is not dealer.com');
});

test('neither probe claims another platform\'s page, and no other probe claims theirs', async () => {
  const onPage = () => fakePlatformPage({ origin: DEALERON_ORIGIN, path: '/searchused.aspx', requested: [DEALERON_LIST], text: 'Copyright © 2026 by DealerOn' });
  const comPage = () => fakePlatformPage({ origin: DEALERCOM_ORIGIN, path: '/used-inventory/index.htm', requested: [DEALERCOM_LIST], windowExtras: { DDC: {} }, text: 'Website by Dealer.com' });
  assert.equal(await runInPage(onPage(), dealerCom.probeInPage), null);
  assert.equal(await runInPage(comPage(), dealerOn.probeInPage), null);
  for (const p of [onPage, comPage]) {
    assert.equal(await runInPage(p(), dealerInspire.probeInPage), null);
    assert.equal(await runInPage(p(), schemaOrg.probeInPage), null, 'a script-drawn list shows the standard reader no car links');
  }
  for (const a of [dealerOn, dealerCom]) {
    assert.equal(await runInPage(fakeDealerPage(), a.probeInPage), null, `${a.PLATFORM.id} on a Dealer Inspire page`);
    assert.equal(await runInPage(fakeStandardPage(), a.probeInPage), null, `${a.PLATFORM.id} on a standard-data page`);
  }
});

// ---------- the in-page and worker searches ----------

test('searchInPage: one GET on the website, JSON parsed, a web page as text, nothing off the website', async () => {
  const [c] = platformCars(1);
  const site = dealerOnSite({ cars: [c] });
  for (const a of [dealerOn, dealerCom]) {
    const origin = a === dealerOn ? DEALERON_ORIGIN : DEALERCOM_ORIGIN;
    const page = fakePlatformPage({ site: a === dealerOn ? site : dealerComSite({ cars: [c] }), origin });
    const service = { kind: a.PLATFORM.id, origin };
    const list = await runInPage(page, a.searchInPage, service, { url: a === dealerOn ? DEALERON_LIST : DEALERCOM_LIST });
    assert.equal(list.ok, true);
    assert.equal(list.data.status, 200);
    assert.ok(list.data.json && typeof list.data.json === 'object');
    assert.equal(list.data.text, '');
    const off = await runInPage(page, a.searchInPage, service, { url: 'https://elsewhere.test/x' });
    assert.equal(off.ok, false);
    assert.match(off.error, /reads only/);
    assert.equal(page.fetchCalls.length, 1, 'nothing was sent off the website');
    assert.deepEqual(page.fetchCalls[0].init.headers, undefined, 'no header of its own');
    assert.equal((await runInPage(page, a.searchInPage, service, {})).ok, false);
  }
  const page = fakePlatformPage({ site, origin: DEALERON_ORIGIN });
  const car = await runInPage(page, dealerOn.searchInPage, onService, { url: DEALERON_ORIGIN + dealerOnPath(c) });
  assert.equal(car.data.json, null);
  assert.match(car.data.text, new RegExp(c.vin));
  const gone = await runInPage(page, dealerOn.searchInPage, onService, { url: DEALERON_ORIGIN + '/used-nothing' });
  assert.deepEqual([gone.ok, gone.data.status, gone.data.ok], [true, 404, false]);
});

test('makeDirectSearch: the same GET from the worker, without cookies, never off the website', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, url, redirected: false, headers: { get: () => 'application/json' }, text: async () => '{"inventory":[]}' };
  };
  for (const [a, service] of [[dealerOn, onService], [dealerCom, comService]]) {
    const search = a.makeDirectSearch(service, fetchImpl);
    const r = await search({ url: service.inventoryUrl });
    assert.deepEqual(r.json, { inventory: [] });
    assert.equal(seen.at(-1).init.credentials, 'omit');
    await assert.rejects(search({ url: 'https://elsewhere.test/' }), /reads only/);
  }
  assert.equal(seen.length, 2);
});

// ---------- scan ----------

test('DealerOn scan pages by "pt" until the stated count is read', async () => {
  const cars = platformCars(10);
  const search = platformSearch(dealerOnSite({ cars, perPage: 4 }));
  const res = await dealerOn.scan(search, dealerOn.scanOptions(onService));
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.equal(res.total, 10);
  assert.equal(res.records.length, 10);
  assert.equal(res.requests, 3);
  assert.equal(search.calls[0], DEALERON_LIST, 'page 1 is the address the page itself asked for');
  assert.match(search.calls[1], /[?&]pt=2(&|$)/);
  assert.equal(new URL(search.calls[1]).searchParams.get('pn'), '24', 'the page\'s own parameters are kept');
});

test('without a stated count the list ends at a short page, and a page number that does not move the list leaves the scan not complete', async () => {
  const cars = platformCars(10);
  const res = await dealerOn.scan(platformSearch(dealerOnSite({ cars, perPage: 4, withTotal: false })), dealerOn.scanOptions(onService));
  assert.equal(res.complete, true);
  assert.equal(res.records.length, 10);
  assert.equal(res.total, 10);
  // a site whose pages all answer the first page
  const site = dealerOnSite({ cars, perPage: 4, withTotal: false });
  const first = site.get(DEALERON_LIST);
  const stuck = platformSearch({ get: (u) => (u.startsWith(DEALERON_ORIGIN + '/api/') ? first : site.get(u)) });
  const res2 = await dealerOn.scan(stuck, dealerOn.scanOptions(onService));
  assert.equal(res2.ok, true);
  assert.equal(res2.complete, false, 'four cars read, and nothing says that is all');
  assert.equal(res2.records.length, 4);
  assert.equal(res2.requests, 2);
});

test('Dealer.com scan pages by "start", counted from the first car', async () => {
  const cars = platformCars(9);
  const search = platformSearch(dealerComSite({ cars, perPage: 4 }));
  const res = await dealerCom.scan(search, dealerCom.scanOptions(comService));
  assert.equal(res.complete, true);
  assert.equal(res.records.length, 9);
  assert.deepEqual(search.calls.map((u) => new URL(u).searchParams.get('start')), ['0', '4', '8']);
  assert.equal(dealerComPage(DEALERCOM_LIST.replace('start=0', 'start=35'), 1, 35), DEALERCOM_LIST, 'a page the person had moved to still starts from the first car');
  assert.equal(dealerOnPage(DEALERON_LIST, 1), DEALERON_LIST);
  assert.equal(dealerOnPage(DEALERON_LIST + '&pt=3', 1), DEALERON_LIST + '&pt=1');
});

test('a scan stops at the list\'s limit, and a refusal or a bad first answer stops it with the reason', async () => {
  const many = { get: (u) => {
    const p = Number(new URL(u).searchParams.get('pt') || 1);
    return { ok: true, status: 200, contentType: 'application/json', json: { DisplayCards: platformCars(2, { from: p * 2 }).map((c) => dealerOnCard(c)) } };
  } };
  const capped = await dealerOn.scan(platformSearch(many), dealerOn.scanOptions(onService));
  assert.equal(capped.requests, MAX_INVENTORY_PAGES);
  assert.equal(capped.complete, false);
  for (const status of [401, 403, 429, 503]) {
    const res = await dealerOn.scan(platformSearch({ get: () => answerWith(status) }), dealerOn.scanOptions(onService));
    assert.equal(res.ok, false);
    assert.match(res.message, new RegExp(String(status)));
    assert.equal(res.requests, 1, 'never retried');
  }
  const htmlAnswer = await dealerCom.scan(platformSearch({ get: () => answerWith(200, '<html>sign in</html>') }), dealerCom.scanOptions(comService));
  assert.equal(htmlAnswer.ok, false);
  assert.match(htmlAnswer.message, /not inventory data/);
  const offsite = await dealerCom.scan(async () => ({ ok: true, status: 200, finalUrl: 'https://elsewhere.test/x', json: { inventory: [] } }), dealerCom.scanOptions(comService));
  assert.equal(offsite.ok, false);
  assert.match(offsite.message, /elsewhere\.test/);
  const noList = await dealerOn.scan(platformSearch(new Map()), dealerOn.scanOptions({ ...onService, inventoryUrl: null }));
  assert.equal(noList.ok, false);
  assert.match(noList.message, /used inventory page, wait until the cars show/);
  assert.equal(noList.requests, 0);
  // a later page failing keeps what was read and says the scan is not complete
  const site = dealerOnSite({ cars: platformCars(8), perPage: 4 });
  const flaky = platformSearch({ get: (u) => (/pt=2/.test(u) ? answerWith(500) : site.get(u)) });
  const part = await dealerOn.scan(flaky, dealerOn.scanOptions(onService));
  assert.deepEqual([part.ok, part.complete, part.records.length], [true, false, 4]);
  assert.deepEqual(dealerOn.scanOptions({ ...onService, inventoryUrl: 'https://elsewhere.test/api' }), { origin: DEALERON_ORIGIN, inventoryUrl: null }, 'a stored list address off the website is never used');
});

test('a car missing from the list is gone only when its own page answers 404 or 410; anything readable leaves it unconfirmed; a server error marks nothing', async () => {
  const cars = platformCars(4);
  const [sold, banner, redirected, unknown, broken] = platformCars(5, { from: 60 });
  const site = dealerComSite({ cars, gone: [sold] });
  site.set(DEALERCOM_ORIGIN + dealerComPath(banner), { ok: true, status: 200, contentType: 'text/html', text: `<p>SOLD</p><p>VIN ${banner.vin}</p>` });
  site.set(DEALERCOM_ORIGIN + dealerComPath(broken), answerWith(500));
  const confirmUrls = Object.fromEntries([sold, banner, redirected, broken].map((c) => [c.vin, DEALERCOM_ORIGIN + dealerComPath(c)]));
  confirmUrls[unknown.vin] = 'https://elsewhere.test' + dealerComPath(unknown);
  const base = platformSearch(site);
  const search = async (r) => (r.url === confirmUrls[redirected.vin] ? { ...answerWith(404), finalUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm', redirected: true } : base(r));
  const res = await dealerCom.scan(search, { ...dealerCom.scanOptions(comService), confirmVins: [cars[0].vin, sold.vin, banner.vin, redirected.vin, unknown.vin], confirmUrls });
  assert.deepEqual(res.confirm.notFound, [sold.vin]);
  assert.deepEqual(res.confirm.checked, [sold.vin, banner.vin, redirected.vin], 'the car with no page on the website is not asked for');
  assert.equal(res.confirm.error, null, 'a page that still shows the car, a redirect and an unknown page are unsure, not errors');
  assert.equal(res.unread, undefined, 'a car off the list is never kept as if it were still listed');
  const res2 = await dealerCom.scan(platformSearch(site), { ...dealerCom.scanOptions(comService), confirmVins: [sold.vin, broken.vin], confirmUrls: { ...confirmUrls, [broken.vin]: DEALERCOM_ORIGIN + dealerComPath(broken) } });
  assert.equal(res2.confirm.error, null, 'one failing car page leaves that car unconfirmed, not every car');
  assert.deepEqual(res2.confirm.notFound, [sold.vin]);
  assert.deepEqual(Object.keys(res2.confirm.unchecked), [broken.vin]);
  assert.match(res2.confirm.unchecked[broken.vin], /500/);
  // through the rescan: the sold car is taken down, the others wait as "not confirmed gone"
  const settings = withDefaults({});
  const siteInfo = { origin: DEALERCOM_ORIGIN, host: 'www.sample-dealercom.test', name: 'Sample Chevrolet', title: '', adapter: 'dealerCom' };
  const all = [...cars, sold, banner];
  const first = await scanWithSearch({ adapter: dealerCom, search: platformSearch(dealerComSite({ cars: all })), site: siteInfo, settings, options: dealerCom.scanOptions(comService) });
  const second = await scanWithSearch({ adapter: dealerCom, search: platformSearch(site), site: siteInfo, settings, prevSnapshot: first.snapshot, options: dealerCom.scanOptions(comService) });
  assert.deepEqual(second.diff.takeDown.map((t) => t.vin), [sold.vin]);
  assert.deepEqual(second.diff.needsALook.map((t) => t.vin), [banner.vin]);
  assert.match(second.diff.needsALook[0].text, /not confirmed gone/);
});

test('a rescan through scanWithSearch: a sold car goes on To do, the dealer\'s price is what changes are measured in', async () => {
  const cars = platformCars(5, { from: 1 });
  const settings = withDefaults({});
  const site = { origin: DEALERON_ORIGIN, host: 'www.sample-dealeron.test', name: 'Sample Motors', title: '', adapter: 'dealerOn' };
  const first = await scanWithSearch({ adapter: dealerOn, search: platformSearch(dealerOnSite({ cars })), site, settings, options: dealerOn.scanOptions(onService) });
  assert.equal(first.ok, true);
  const ready = Object.values(first.snapshot.vehicles).filter((e) => e.decision === DECISION.READY);
  assert.equal(ready.length, cars.length);
  const [gone, ...kept] = cars;
  const cheaper = kept.map((c, i) => (i === 0 ? { ...c, base: c.base - 1000 } : c));
  const second = await scanWithSearch({ adapter: dealerOn, search: platformSearch(dealerOnSite({ cars: cheaper, gone: [gone] })), site, settings, prevSnapshot: first.snapshot, posted: { [gone.vin]: { price: gone.base + gone.fee }, [kept[0].vin]: { price: kept[0].base + kept[0].fee } }, options: dealerOn.scanOptions(onService) });
  assert.equal(second.ok, true);
  assert.deepEqual(second.diff.takeDown.map((t) => t.vin), [gone.vin]);
  const drop = second.diff.priceUpdates.find((p) => p.vin === kept[0].vin);
  assert.deepEqual([drop.from, drop.to], [kept[0].base + kept[0].fee, kept[0].base - 1000 + kept[0].fee]);
});

// ---------- getDetails ----------

test('DealerOn getDetails: the car from the list, then every full-size photo of this car from its page', async () => {
  const cars = platformCars(3);
  const search = platformSearch(dealerOnSite({ cars }));
  const d = await dealerOn.getDetails(search, cars[1].vin.toLowerCase(), dealerOn.scanOptions(onService));
  assert.equal(d.ok, true);
  const v = dealerOn.normalize(d.record);
  assert.equal(v.vin, cars[1].vin);
  assert.equal(v.photos.length, cars[1].photos);
  assert.ok(v.photos.every((u) => u.includes(`/${cars[1].vin.toLowerCase()}/ip/`) && !/thumbs/.test(u)), 'this car\'s photos only, full size');
  assert.equal(v.photos[0], `${DEALERON_ORIGIN}/inventoryphotos/12345/${cars[1].vin.toLowerCase()}/ip/1.jpg`, 'the address without its resize query');
  assert.equal(search.calls.at(-1), DEALERON_ORIGIN + dealerOnPath(cars[1]));
  assert.deepEqual(pagePhotos(dealerOnCarPage(cars[0]), cars[0].vin, DEALERON_ORIGIN + '/x').length, cars[0].photos);
  assert.deepEqual(pagePhotos('', cars[0].vin, DEALERON_ORIGIN), []);
  const none = await dealerOn.getDetails(search, platformCars(1, { from: 90 })[0].vin, dealerOn.scanOptions(onService));
  assert.deepEqual([none.ok, none.record, none.complete], [true, null, true], 'the whole list was read: the car is gone');
  const failing = await dealerOn.getDetails(platformSearch({ get: () => answerWith(403) }), cars[0].vin, dealerOn.scanOptions(onService));
  assert.equal(failing.ok, false);
  assert.match(failing.message, /403/);
});

test('Dealer.com getDetails: a car page\'s photos of other cars are never taken; its standard data for this VIN is', async () => {
  const cars = platformCars(2, { from: 1 });
  const site = dealerComSite({ cars });
  const d = await dealerCom.getDetails(platformSearch(site), cars[0].vin, dealerCom.scanOptions(comService));
  const v = dealerCom.normalize(d.record);
  assert.equal(v.photos.length, cars[0].photos, 'the list\'s own images; the page\'s similar-car photo is not one');
  assert.ok(!v.photos.some((u) => /othercar/.test(u)));
  const node = { '@context': 'https://schema.org', '@type': 'Car', vehicleIdentificationNumber: cars[0].vin, name: 'Used car', description: 'One owner, clean.', image: Array.from({ length: 8 }, (_, n) => `https://pictures.dealer.com/s/sampledealer/${n}/p${n}.jpg`) };
  site.set(DEALERCOM_ORIGIN + dealerComPath(cars[0]), { ok: true, status: 200, contentType: 'text/html', text: `<html><head><script type="application/ld+json">${JSON.stringify(node)}</script></head><body>${cars[0].vin}</body></html>` });
  const d2 = await dealerCom.getDetails(platformSearch(site), cars[0].vin, dealerCom.scanOptions(comService));
  const v2 = dealerCom.normalize(d2.record);
  assert.equal(v2.photos.length, 8);
  assert.equal(v2.descriptionRaw, 'One owner, clean.');
});

test('origins and photoOrigins: the website itself, and where the photos are', () => {
  assert.deepEqual(dealerOn.origins(onService), [DEALERON_ORIGIN + '/*']);
  assert.deepEqual(dealerCom.origins(comService), [DEALERCOM_ORIGIN + '/*']);
  assert.deepEqual(dealerOn.origins({ origin: 'ftp://x' }), []);
  const records = platformCars(2).map((c) => ({ card: dealerComRecord(c), origin: DEALERCOM_ORIGIN }));
  assert.deepEqual(dealerCom.photoOrigins(records), ['https://pictures.dealer.com']);
  const onRecords = platformCars(2).map((c) => ({ card: dealerOnCard(c).VehicleCard, origin: DEALERON_ORIGIN }));
  assert.deepEqual(dealerOn.photoOrigins(onRecords), [DEALERON_ORIGIN], 'DealerOn photos are on the website itself');
});

test('DealerOn keeps the 10-second gap its robots.txt asks for between car-page reads, the same gap every time', async () => {
  const { PAGE_GAP_MS } = await import('../extension/adapters/dealerOn.js');
  assert.equal(PAGE_GAP_MS, 10000);
  const [a, b] = platformCars(2, { from: 70 });
  const site = dealerOnSite({ cars: platformCars(2), gone: [a, b] });
  const confirmUrls = { [a.vin]: DEALERON_ORIGIN + dealerOnPath(a), [b.vin]: DEALERON_ORIGIN + dealerOnPath(b) };
  const times = [];
  const search = platformSearch(site);
  const timed = async (r) => { times.push(Date.now()); return search(r); };
  const res = await dealerOn.scan(timed, { ...dealerOn.scanOptions(onService), confirmVins: [a.vin, b.vin], confirmUrls, pageGapMs: 60 });
  assert.deepEqual(res.confirm.notFound, [a.vin, b.vin]);
  const [, first, second] = times; // the list, then the two car pages
  assert.ok(second - first >= 55, `the second car page waited for the gap (${second - first} ms)`);
  // the list pages themselves are not held up
  const quick = await dealerOn.scan(platformSearch(dealerOnSite({ cars: platformCars(10), perPage: 4 })), { ...dealerOn.scanOptions(onService), pageGapMs: 60000 });
  assert.equal(quick.complete, true);
});

test('a scan checks at most MAX_CONFIRM_PAGES missing cars at their pages; the rest wait unconfirmed and the checked ones still count', async () => {
  const { MAX_CONFIRM_PAGES } = await import('../extension/adapters/inventoryJson.js');
  const missing = platformCars(MAX_CONFIRM_PAGES + 3, { from: 100 });
  const search = platformSearch(dealerComSite({ cars: platformCars(2), gone: missing }));
  const confirmUrls = Object.fromEntries(missing.map((c) => [c.vin, DEALERCOM_ORIGIN + dealerComPath(c)]));
  const res = await dealerCom.scan(search, { ...dealerCom.scanOptions(comService), confirmVins: missing.map((c) => c.vin), confirmUrls });
  assert.equal(res.confirm.checked.length, MAX_CONFIRM_PAGES);
  assert.deepEqual(res.confirm.notFound, missing.slice(0, MAX_CONFIRM_PAGES).map((c) => c.vin));
  assert.equal(res.confirm.error, null, 'the cars left for later are not an error, so the checked ones are marked gone');
});

test('findCards takes the lot\'s own list, not a featured list beside it, so paging by count still reads every car', async () => {
  const lot = platformCars(10, { from: 300 });
  const featured = platformCars(2, { from: 400 });
  const site = new Map();
  for (let start = 0; start < 12; start += 4) {
    const u = new URL(DEALERCOM_LIST);
    u.searchParams.set('start', String(start));
    const body = { featured: featured.map((c) => dealerComRecord(c)), inventory: lot.slice(start, start + 4).map((c) => dealerComRecord(c)) };
    site.set(u.href, { ok: true, status: 200, contentType: 'application/json', json: body, text: '' });
  }
  const res = await dealerCom.scan(platformSearch(site), dealerCom.scanOptions(comService));
  assert.deepEqual(res.records.map((r) => r.card.vin).sort(), lot.map((c) => c.vin).sort());
  assert.equal(res.complete, true);
});

test('a first answer with no cars and no count of zero is not an empty lot', async () => {
  const bad = await dealerCom.scan(platformSearch({ get: () => ({ ok: true, status: 200, contentType: 'application/json', json: { error: 'Session expired' } }) }), dealerCom.scanOptions(comService));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /held no cars/);
  const empty = await dealerCom.scan(platformSearch({ get: () => ({ ok: true, status: 200, contentType: 'application/json', json: { pageInfo: { totalCount: 0 }, inventory: [] } }) }), dealerCom.scanOptions(comService));
  assert.deepEqual([empty.ok, empty.complete, empty.records.length], [true, true, 0], 'a lot the website says is empty');
});

test('pick never takes the car\'s address, title or condition from a nested object', () => {
  const [c] = platformCars(1, { from: 1 });
  const card = { vin: c.vin, year: c.year, make: c.make, model: c.model, heading: `Used ${c.year} ${c.make}`, link: dealerComPath(c), carfax: { link: `https://www.carfax.com/vehiclehistory/ar20/${c.vin}` }, dealer: { name: 'Store' }, offer: { type: 'Used Car Special' } };
  const v = normalizeInventoryRecord(card, { origin: DEALERCOM_ORIGIN });
  assert.equal(v.url, DEALERCOM_ORIGIN + dealerComPath(c));
  assert.equal(v.siteTitle, `Used ${c.year} ${c.make}`);
  assert.equal(v.inventoryType, null);
  assert.equal(v.carfaxUrl, `https://www.carfax.com/vehiclehistory/ar20/${c.vin}`, 'the Carfax link is still found as a Carfax link');
  const bare = normalizeInventoryRecord({ vin: c.vin, carfax: { link: 'https://www.carfax.com/x' } }, { origin: DEALERCOM_ORIGIN });
  assert.equal(bare.url, null);
});

test('at post time from a car\'s own page, the list address comes from the last scan of this website', async () => {
  const { fetchVehicleDetails } = await import('../extension/src/vehicleDetails.js');
  const cars = platformCars(3, { from: 1 });
  const site = dealerOnSite({ cars });
  const page = fakePlatformPage({ site, origin: DEALERON_ORIGIN, path: dealerOnPath(cars[1]), text: 'Copyright © 2026 by DealerOn', scripts: [DEALERON_ORIGIN + '/dealeron-js.aspx'] });
  const store = {};
  const prev = globalThis.chrome;
  globalThis.chrome = {
    scripting: { executeScript: async ({ func, args = [] }) => [{ result: await runInPage(page, func, ...args) }] },
    storage: { local: { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) } },
  };
  try {
    const before = await fetchVehicleDetails(1, cars[1].vin);
    assert.equal(before.ok, false);
    assert.match(before.message, /used inventory page, wait until the cars show, and try again/);
    const { SITES_KEY } = await import('../extension/src/storageKeys.js');
    store[SITES_KEY] = { [DEALERON_ORIGIN]: { adapter: 'dealerOn', service: onService } };
    const after = await fetchVehicleDetails(1, cars[1].vin);
    assert.equal(after.ok, true, after.message);
    assert.equal(after.vehicle.vin, cars[1].vin);
    assert.equal(after.vehicle.photos.length, cars[1].photos);
    store[SITES_KEY] = { [DEALERON_ORIGIN]: { adapter: 'dealerCom', service: comService } };
    assert.equal((await fetchVehicleDetails(1, cars[1].vin)).ok, false, 'a service another adapter stored is never borrowed');
  } finally {
    globalThis.chrome = prev;
  }
});

// ---------- from the full review (2026-10-01) ----------

test('a certified loaner or demo keeps its word: the gate never sees it as Certified Used', () => {
  const [c] = platformCars(1, { from: 500 });
  for (const word of ['Loaner', 'Service Loaner', 'Demo', 'Demonstrator', 'Courtesy Vehicle']) {
    const record = { ...dealerComRecord({ ...c, certified: true }), inventoryType: word, link: '/certified/' + c.make + '/x.htm' };
    const v = normalizeInventoryRecord(record, { origin: DEALERCOM_ORIGIN });
    assert.equal(v.inventoryType, word, `${word}: the condition word is kept`);
    assert.equal(v.isDemo || v.isLoaner, true, `${word}: flagged like the platform's own flag`);
    const verdict = assessVehicle(v, withDefaults({})).decision;
    assert.ok(verdict === DECISION.REVIEW || verdict === DECISION.SKIP, `${word} + certified is ${verdict}, never ready`);
    assert.notEqual(checkPreOwned(v).verdict, 'pre-owned');
  }
  const plain = normalizeInventoryRecord({ ...dealerComRecord({ ...c, certified: true }), inventoryType: 'used' }, { origin: DEALERCOM_ORIGIN });
  assert.equal(plain.inventoryType, 'Certified Used', 'a certified used car is still Certified Used');
  assert.deepEqual([plain.isDemo, plain.isLoaner], [false, false]);
  const fresh = normalizeInventoryRecord({ ...dealerComRecord({ ...c, certified: true }), inventoryType: 'new' }, { origin: DEALERCOM_ORIGIN });
  assert.equal(fresh.inventoryType, 'new', 'a certified flag never makes a new car used');
});

test('mileage is kept only in miles: kilometres and other units are no mileage, with the reason', () => {
  const [c] = platformCars(1, { from: 510 });
  const base = dealerComRecord(c);
  const read = (odometer, extra = {}) => mileageOf({ ...base, odometer, ...extra });
  assert.deepEqual(read(31207), { value: 31207, reason: '' }, 'a bare number is miles');
  assert.deepEqual(read('31,207'), { value: 31207, reason: '' });
  assert.deepEqual(read('31,207 miles'), { value: 31207, reason: '' });
  assert.deepEqual(read('31,207 mi.'), { value: 31207, reason: '' });
  assert.deepEqual(read('31,207.6 miles'), { value: 31207.6, reason: '' }, 'decimals kept, as in a number');
  assert.deepEqual(read('64,120 km'), { value: null, reason: 'the mileage is in kilometres' });
  assert.deepEqual(read('64120 KM'), { value: null, reason: 'the mileage is in kilometres' });
  assert.deepEqual(read(64120, { odometerUnit: 'km' }), { value: null, reason: 'the mileage is in kilometres' }, 'a unit field beside a bare number');
  assert.deepEqual(read({ value: 64120, unit: 'kilometres' }), { value: null, reason: 'the mileage is in kilometres' });
  assert.deepEqual(read({ value: 31207, unit: 'mi' }), { value: 31207, reason: '' });
  assert.deepEqual(read('1,250 hours'), { value: null, reason: 'the list does not say the mileage is in miles' });
  assert.deepEqual(read('about 30k'), { value: null, reason: 'the mileage is not a number' });
  assert.equal(mileageOf({ vin: c.vin }).reason, 'the list gives no mileage');
  const v = normalizeInventoryRecord({ ...base, odometer: '64,120 km' }, { origin: DEALERCOM_ORIGIN });
  assert.equal(v.mileage, null, 'never posted as 64,120 miles');
  assert.equal(assessVehicle(v, withDefaults({})).decision, DECISION.REVIEW, 'no mileage waits on Needs a look');
});

// A body read in chunks that counts what was read and whether the read was cut off.
function streamedResponse(chunks, { contentType = 'text/html' } = {}) {
  const state = { reads: 0, cancelled: false };
  const encoder = new TextEncoder();
  const body = {
    getReader: () => ({
      read: async () => {
        if (state.reads >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: encoder.encode(chunks[state.reads++]) };
      },
      cancel: async () => { state.cancelled = true; },
    }),
  };
  const res = { ok: true, status: 200, url: '', redirected: false, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? contentType : null) }, body, text: async () => { throw new Error('read whole'); } };
  return { res, state };
}

test('responses are read only up to the 3 MB limit, in the page and in the worker', async () => {
  const mb = 'x'.repeat(1000000);
  const small = streamedResponse(['ab', 'cd', 'ef']);
  assert.equal(await cappedText(small.res, 3), 'abc');
  assert.equal(small.state.cancelled, true, 'the rest is never read');
  const whole = streamedResponse(['ab', 'cd']);
  assert.equal(await cappedText(whole.res, 10), 'abcd');
  assert.equal(whole.state.cancelled, false);
  for (const a of [dealerOn, dealerCom]) {
    const origin = a === dealerOn ? DEALERON_ORIGIN : DEALERCOM_ORIGIN;
    const page = fakePlatformPage({ origin });
    const big = streamedResponse(Array.from({ length: 10 }, () => mb));
    page.fetch = async (href) => ({ ...big.res, url: String(href) });
    page.TextDecoder = TextDecoder;
    const got = await runInPage(page, a.searchInPage, { kind: a.PLATFORM.id, origin }, { url: origin + '/big' });
    assert.equal(got.ok, true);
    assert.equal(got.data.text.length, 3000000, `${a.PLATFORM.name}: cut at the limit`);
    assert.ok(big.state.reads <= 3 && big.state.cancelled, `${a.PLATFORM.name}: stopped reading at the limit (${big.state.reads} chunks)`);
  }
  const worker = streamedResponse(Array.from({ length: 10 }, () => mb));
  const direct = dealerCom.makeDirectSearch(comService, async (url) => ({ ...worker.res, url }));
  const answer = await direct({ url: DEALERCOM_ORIGIN + '/big' });
  assert.equal(answer.text.length, 3000000);
  assert.ok(worker.state.reads <= 3 && worker.state.cancelled, 'the worker stops reading at the limit too');
});

test('crawlDelaySeconds reads the delay robots.txt gives every robot, and nothing else', () => {
  assert.equal(crawlDelaySeconds('User-agent: *\nCrawl-delay: 10\nDisallow: /x'), 10);
  assert.equal(crawlDelaySeconds('User-agent: SomeBot\nCrawl-delay: 60\n\nUser-agent: *\nDisallow: /x'), null, 'a delay for a named robot only');
  assert.equal(crawlDelaySeconds('User-agent: SomeBot\nUser-agent: *\ncrawl-delay : 2.5 # please'), 2.5, 'a group naming several robots, any case, a comment');
  assert.equal(crawlDelaySeconds('User-agent: *\nCrawl-delay: soon'), null);
  assert.equal(crawlDelaySeconds(''), null);
  assert.equal(crawlDelaySeconds(null), null);
});

test('the gap between car-page reads is the Crawl-delay of the website\'s own robots.txt, read once; a refusal there checks nothing', async () => {
  const [a, b, c] = platformCars(3, { from: 520 });
  const confirmUrls = Object.fromEntries([a, b, c].map((x) => [x.vin, DEALERCOM_ORIGIN + dealerComPath(x)]));
  const run = async (robots, platformGap = 0) => {
    const site = dealerComSite({ cars: platformCars(2), gone: [a, b, c] });
    if (robots) site.set(DEALERCOM_ORIGIN + '/robots.txt', robots);
    const search = platformSearch(site);
    const times = [];
    const timed = async (r) => { times.push({ url: r.url, at: Date.now() }); return search(r); };
    const platform = { pageAddress: dealerComPage, pagePhotos: () => [], pageGapMs: platformGap };
    const res = await scanInventory(timed, { ...dealerCom.scanOptions(comService), confirmVins: [a.vin, b.vin, c.vin], confirmUrls }, platform);
    const pages = times.filter((t) => Object.values(confirmUrls).includes(t.url));
    const gaps = pages.slice(1).map((t, i) => t.at - pages[i].at);
    return { res, times, pages, gaps };
  };
  const text = (body) => ({ ok: true, status: 200, contentType: 'text/plain', text: body });

  const asked = await run(text('User-agent: *\nCrawl-delay: 0.06\n'));
  assert.equal(asked.times.filter((t) => t.url.endsWith('/robots.txt')).length, 1, 'robots.txt read once');
  assert.deepEqual(asked.res.confirm.notFound, [a.vin, b.vin, c.vin]);
  assert.ok(asked.gaps.every((g) => g >= 55), `every gap kept (${asked.gaps})`);

  const none = await run(null, 200);
  assert.deepEqual(none.res.confirm.notFound, [a.vin, b.vin, c.vin]);
  assert.ok(none.gaps.every((g) => g < 150), `no robots.txt (404): no rules, no gap, not the platform's (${none.gaps})`);

  const unreadable = await run({ ok: false, status: 500, contentType: 'text/plain', text: '' }, 60);
  assert.ok(unreadable.gaps.every((g) => g >= 55), `an unreadable robots.txt keeps the platform's own gap (${unreadable.gaps})`);
  const softPage = await run({ ok: true, status: 200, contentType: 'text/html', text: '<!doctype html><html><body>Page not found</body></html>' }, 60);
  assert.ok(softPage.gaps.every((g) => g >= 55), `a web page answering for robots.txt is no rules: the platform's gap (${softPage.gaps})`);
  const untyped = await run({ ok: true, status: 200, contentType: '', text: '<html><body>Not found</body></html>' }, 60);
  assert.ok(untyped.gaps.every((g) => g >= 55), `the same without a content type (${untyped.gaps})`);
  const moved = await (async () => {
    const site = dealerComSite({ cars: platformCars(2), gone: [a, b, c] });
    const base = platformSearch(site);
    const times = [];
    const search = async (r) => {
      times.push({ url: r.url, at: Date.now() });
      if (r.url.endsWith('/robots.txt')) return { ok: true, status: 200, contentType: 'text/plain', text: 'User-agent: *\nCrawl-delay: 0\n', finalUrl: 'https://elsewhere.test/robots.txt', redirected: true };
      return base(r);
    };
    await scanInventory(search, { ...dealerCom.scanOptions(comService), confirmVins: [a.vin, b.vin, c.vin], confirmUrls }, { pageAddress: dealerComPage, pagePhotos: () => [], pageGapMs: 60 });
    const pages = times.filter((t) => Object.values(confirmUrls).includes(t.url));
    return pages.slice(1).map((t, i) => t.at - pages[i].at);
  })();
  assert.ok(moved.every((g) => g >= 55), `a robots.txt from another website is not this one's rules (${moved})`);

  const slow = await run(text('User-agent: *\nCrawl-delay: 30\n'));
  assert.ok(30000 > MAX_PAGE_GAP_MS);
  assert.equal(slow.pages.length, 1, 'a website asking for more than the longest gap gets one car page per scan');
  assert.deepEqual(slow.res.confirm.notFound, [a.vin]);
  assert.equal(slow.res.confirm.error, null, 'the rest wait unconfirmed, not an error');

  const refused = await run({ ok: false, status: 429, contentType: 'text/plain', text: '' });
  assert.equal(refused.pages.length, 0, 'no car page after robots.txt asked for fewer requests');
  assert.match(refused.res.confirm.error, /robots\.txt.*429/);

  const oneSearch = platformSearch(dealerComSite({ cars: platformCars(2), gone: [a] }));
  const one = await scanInventory(oneSearch, { ...dealerCom.scanOptions(comService), confirmVins: [a.vin], confirmUrls }, { pageAddress: dealerComPage, pagePhotos: () => [], pageGapMs: 0 });
  assert.deepEqual(one.confirm.notFound, [a.vin]);
  assert.ok(!oneSearch.calls.some((u) => u.endsWith('/robots.txt')), 'one car page needs no robots.txt');
});

// ---------- from the full review (2026-10-02) ----------

test('a missing car whose page fails on its own stays unconfirmed by itself; the other cars are still marked gone', async () => {
  const cars = platformCars(2);
  const [sold, broken, offsite, later] = platformCars(4, { from: 70 });
  const all = [...cars, sold, broken, offsite, later];
  const site = dealerOnSite({ cars, gone: [sold, later] });
  site.set(DEALERON_ORIGIN + dealerOnPath(broken), answerWith(502));
  const base = platformSearch(site);
  const urls = Object.fromEntries([sold, broken, offsite, later].map((c) => [c.vin, DEALERON_ORIGIN + dealerOnPath(c)]));
  const search = async (r) => (r.url === urls[offsite.vin] ? { ...answerWith(200, '<p>a car</p>'), finalUrl: 'https://elsewhere.test/car', redirected: true } : base(r));
  const options = { ...dealerOn.scanOptions(onService), pageGapMs: 0 };
  const res = await dealerOn.scan(search, { ...options, confirmVins: [sold.vin, broken.vin, offsite.vin, later.vin], confirmUrls: urls });
  assert.equal(res.confirm.error, null, 'a 502 and an answer from another website are about those two cars only');
  assert.deepEqual(res.confirm.notFound, [sold.vin, later.vin], 'the car after the failing pages is still checked');
  assert.deepEqual(res.confirm.checked, [sold.vin, later.vin]);
  assert.deepEqual(Object.keys(res.confirm.unchecked), [broken.vin, offsite.vin]);
  assert.match(res.confirm.unchecked[broken.vin], /502/);
  assert.match(res.confirm.unchecked[offsite.vin], /elsewhere\.test/);
  // through the rescan: the two sold cars are taken down, the other two wait
  const settings = withDefaults({});
  const siteInfo = { origin: DEALERON_ORIGIN, host: 'www.sample-dealeron.test', name: 'Sample Motors', title: '', adapter: 'dealerOn' };
  const first = await scanWithSearch({ adapter: dealerOn, search: platformSearch(dealerOnSite({ cars: all })), site: siteInfo, settings, options });
  const second = await scanWithSearch({ adapter: dealerOn, search, site: siteInfo, settings, prevSnapshot: first.snapshot, options });
  assert.deepEqual(second.diff.takeDown.map((t) => t.vin).sort(), [sold.vin, later.vin].sort());
  assert.deepEqual(second.diff.needsALook.map((t) => t.vin).sort(), [broken.vin, offsite.vin].sort());
  assert.ok(!second.diff.warnings.some((w) => /Couldn't double-check/.test(w)), second.diff.warnings.join(' | '));
});

test('a refusal still withholds every sold result; a request that fails outright is that car\'s alone; failing pages in a row stop the check', async () => {
  const cars = platformCars(2);
  const [a, b, c, d] = platformCars(4, { from: 80 });
  const urls = Object.fromEntries([a, b, c, d].map((x) => [x.vin, DEALERON_ORIGIN + dealerOnPath(x)]));
  const options = { ...dealerOn.scanOptions(onService), pageGapMs: 0, confirmVins: [a.vin, b.vin, c.vin, d.vin], confirmUrls: urls };

  const refusing = dealerOnSite({ cars, gone: [a, c, d] });
  refusing.set(urls[b.vin], answerWith(403));
  const refusedSearch = platformSearch(refusing);
  const refused = await dealerOn.scan(refusedSearch, options);
  assert.match(refused.confirm.error, /403/);
  assert.ok(!refusedSearch.calls.includes(urls[c.vin]), 'nothing more is read after a refusal');

  // a page redirecting to another website makes the browser's fetch fail (no CORS answer there)
  const base = platformSearch(dealerOnSite({ cars, gone: [a, b, c, d] }));
  const thrown = await dealerOn.scan(async (r) => { if (r.url === urls[b.vin]) throw new TypeError('Failed to fetch'); return base(r); }, options);
  assert.equal(thrown.confirm.error, null);
  assert.deepEqual(thrown.confirm.unchecked, { [b.vin]: 'its page could not be read (Failed to fetch)' });
  assert.deepEqual(thrown.confirm.notFound, [a.vin, c.vin, d.vin], 'the other cars are still checked and marked gone');

  const failing = dealerOnSite({ cars, gone: [d] });
  for (const x of [a, b, c]) failing.set(urls[x.vin], answerWith(500));
  const failingSearch = platformSearch(failing);
  const bad = await dealerOn.scan(failingSearch, options);
  assert.equal(MAX_FAILED_IN_A_ROW, 3);
  assert.equal(bad.confirm.error, null);
  assert.deepEqual(Object.keys(bad.confirm.unchecked), [a.vin, b.vin, c.vin]);
  assert.ok(!failingSearch.calls.includes(urls[d.vin]), 'after three failing pages in a row the rest wait for the next scan');
  assert.deepEqual(bad.confirm.notFound, []);

  const fine = await dealerOn.scan(platformSearch(dealerOnSite({ cars, gone: [a, b, c, d] })), options);
  assert.equal(fine.confirm.unchecked, undefined, 'unchecked only when some');
});

test('getDetails says when the list read stopped early, so a car on an unread page is not called gone', async () => {
  const cars = platformCars(8);
  const site = dealerOnSite({ cars, perPage: 4 });
  const pageOne = site.get(dealerOnPage(DEALERON_LIST, 1));
  const isPageTwo = (u) => new URL(u).searchParams.get('pt') === '2';
  const cases = [
    ['answers 500', answerWith(500)],
    ['is not inventory data', answerWith(200, '<html>sign in</html>')],
    ['repeats page 1', pageOne],
  ];
  for (const [label, answer] of cases) {
    const search = platformSearch({ get: (u) => (isPageTwo(u) ? answer : site.get(u)) });
    const onLaterPage = await dealerOn.getDetails(search, cars[6].vin, dealerOn.scanOptions(onService));
    assert.deepEqual([onLaterPage.ok, onLaterPage.record, onLaterPage.complete], [true, null, false], `page 2 ${label}: not proof the car is gone`);
    const onFirstPage = await dealerOn.getDetails(search, cars[1].vin, dealerOn.scanOptions(onService));
    assert.equal(dealerOn.normalize(onFirstPage.record).vin, cars[1].vin, `page 2 ${label}: a car on page 1 is still found`);
  }
  const comCars = platformCars(6);
  const comSite = dealerComSite({ cars: comCars, perPage: 3 });
  const comFirst = comSite.get(dealerComPage(DEALERCOM_LIST, 1, 3));
  const repeating = platformSearch({ get: (u) => (new URL(u).searchParams.get('start') === '3' ? comFirst : comSite.get(u)) });
  const com = await dealerCom.getDetails(repeating, comCars[4].vin, dealerCom.scanOptions(comService));
  assert.deepEqual([com.ok, com.record, com.complete], [true, null, false]);
  const gone = await dealerCom.getDetails(platformSearch(comSite), platformCars(1, { from: 95 })[0].vin, dealerCom.scanOptions(comService));
  assert.deepEqual([gone.ok, gone.record, gone.complete], [true, null, true]);
});

test('a footer credit alone never makes a page DealerOn or Dealer.com', async () => {
  for (const text of ['Copyright © 2026 by DealerOn. All rights reserved.', 'Website by DealerOn', 'Powered by DealerOn']) {
    assert.equal(await runInPage(fakePlatformPage({ origin: DEALERON_ORIGIN, path: '/used-cars', text }), dealerOn.probeInPage), null, text);
  }
  for (const text of ['Website by Dealer.com', 'Powered by Dealer.com', 'Site by Dealer.com']) {
    assert.equal(await runInPage(fakePlatformPage({ origin: DEALERCOM_ORIGIN, path: '/used-cars', text }), dealerCom.probeInPage), null, text);
  }
  const credit = 'Copyright © 2026 by DealerOn';
  const withOwnFile = (extra) => fakePlatformPage({ origin: DEALERON_ORIGIN, path: '/used-Springfield-2019-Jeep', text: credit, ...extra });
  assert.equal((await runInPage(withOwnFile({ scripts: [DEALERON_ORIGIN + '/dealeron-js.aspx'] }), dealerOn.probeInPage)).kind, 'dealerOn', 'the credit beside DealerOn\'s own script on the website');
  assert.equal((await runInPage(withOwnFile({ requested: [DEALERON_ORIGIN + '/resources/vhcliaa/components/spaCosmos/skeletonLoaders/x.svg'] }), dealerOn.probeInPage)).kind, 'dealerOn', 'the credit beside a Cosmos file the page loaded');
  assert.equal(await runInPage(withOwnFile({ scripts: ['https://elsewhere.test/resources/vhcliaa/x.js'] }), dealerOn.probeInPage), null, 'a look-alike path on another website does not count');
  assert.equal(await runInPage(fakePlatformPage({ origin: DEALERON_ORIGIN, scripts: [DEALERON_ORIGIN + '/dealeron-js.aspx'] }), dealerOn.probeInPage), null, 'nor a file path without the credit');
});

// ---------- PR #9 on the reviewed code (2026-10-07) ----------

// Loaner and demo types as a platform may write them in one word or with
// underscores, as codes often are.
const GLUED_UNIT_TYPES = ['SERVICE_LOANER', 'Service_Loaner', 'ServiceLoaner', 'SERVICELOANER', 'CourtesyVehicle', 'DEMO_UNIT', 'DemoUnit'];

// R-3, the repair round: a loaner or demo type written in one word or with
// underscores is the same word. Before, the reader saw no condition in
// "SERVICE_LOANER" at all, the certified mark filled the empty type with
// Certified Used, and the car reached Ready.
test('R-3: a loaner or demo type written in one word or with underscores is still a loaner or demo on DealerOn and Dealer.com', () => {
  const [c] = platformCars(1, { from: 540 });
  const car = { ...c, certified: true };
  for (const [platform, origin, record] of [
    ['DealerOn', DEALERON_ORIGIN, (word, certified) => ({ ...dealerOnCard({ ...car, certified }).VehicleCard, VehicleCondition: word })],
    ['Dealer.com', DEALERCOM_ORIGIN, (word, certified) => ({ ...dealerComRecord({ ...car, certified }), inventoryType: word })],
  ]) {
    for (const word of GLUED_UNIT_TYPES) {
      for (const certified of [true, false]) {
        const v = normalizeInventoryRecord(record(word, certified), { origin });
        const where = `${platform}, ${word}${certified ? ', certified' : ''}`;
        assert.doesNotMatch(String(v.inventoryType), /certified used/i, `${where}: never read as Certified Used`);
        assert.equal(v.isDemo || v.isLoaner, true, `${where}: flagged like the platform's own flag (type ${v.inventoryType})`);
        assert.equal(v.isDemo, /demo/i.test(word), `${where}: a demo is a demo, a loaner a loaner`);
        const decision = assessVehicle(v, withDefaults({})).decision;
        assert.notEqual(decision, DECISION.READY, `${where}: never Ready`);
        assert.equal(decision, DECISION.REVIEW, `${where}: the website also calls it pre-owned, so Needs a look`);
      }
    }
  }
  // the same spellings of a used or certified type still read as pre-owned
  for (const word of ['PRE_OWNED', 'PreOwned', 'CERTIFIED_PRE_OWNED', 'USED_VEHICLE']) {
    const v = normalizeInventoryRecord({ ...dealerComRecord({ ...c, certified: false }), inventoryType: word }, { origin: DEALERCOM_ORIGIN });
    assert.equal(checkPreOwned(v).checks.find((x) => x.key === 'type').says, 'pre-owned', word);
    assert.deepEqual([v.isDemo, v.isLoaner], [false, false], word);
  }
});

// R-3: a card typed Loaner, Demo or Courtesy and marked certified. Its
// type and its certified mark disagree, so a person looks at it: Needs a
// look, whatever the title and the address say, never Ready and never read
// as Certified Used (before the fix it could pass as Certified Used, and
// with no other sign the certified mark was dropped and the car skipped as
// sold-as-new without a word about the mark).
test('R-3: a certified card typed Loaner, Demo or Courtesy goes to Needs a look on DealerOn and Dealer.com, never Ready and never Certified Used', async () => {
  const [c] = platformCars(1, { from: 540 });
  const car = { ...c, certified: true };
  const bare = `/${car.year}-${car.make}-${car.model}-${car.vin}`; // an address with no condition word
  const shapes = [
    ['DealerOn', DEALERON_ORIGIN, (word, plain) => ({ ...dealerOnCard(car).VehicleCard, VehicleCondition: word, ...(plain ? { VehicleName: `${car.year} ${car.make} ${car.model} ${car.trim}`, VehicleDetailUrl: bare } : {}) })],
    ['Dealer.com', DEALERCOM_ORIGIN, (word, plain) => ({ ...dealerComRecord(car), inventoryType: word, ...(plain ? { link: bare } : {}) })],
  ];
  for (const [platform, origin, record] of shapes) {
    for (const word of ['Loaner', 'Service Loaner', 'Demo', 'Demonstrator', 'Courtesy', 'Courtesy Vehicle', 'Certified Loaner', ...GLUED_UNIT_TYPES]) {
      for (const plain of [false, true]) {
        const v = normalizeInventoryRecord(record(word, plain), { origin });
        const where = `${platform}, ${word}${plain ? ', no other condition word' : ''}`;
        assert.doesNotMatch(String(v.inventoryType), /certified used/i, `${where}: never read as Certified Used`);
        assert.equal(v.isDemo || v.isLoaner, true, `${where}: flagged like the platform's own flag`);
        const verdict = checkPreOwned(v);
        assert.equal(verdict.verdict, 'review', `${where}: ${verdict.reason}`);
        assert.match(verdict.reason, /^Listed as pre-owned but also flagged as a (?:demo|loaner)\./, where);
        assert.equal(assessVehicle(v, withDefaults({})).decision, DECISION.REVIEW, `${where}: Needs a look`);
      }
    }
  }
  // not certified: the loaner word alone, with nothing that says pre-owned, is sold as new, as before
  const loaner = normalizeInventoryRecord({ ...dealerComRecord({ ...c, certified: false }), inventoryType: 'Loaner', link: bare }, { origin: DEALERCOM_ORIGIN });
  assert.equal(assessVehicle(loaner, withDefaults({})).decision, DECISION.SKIP);
  // a plain certified used car gains no second sign from its certified mark
  const cpo = normalizeInventoryRecord({ ...dealerComRecord(car), link: bare }, { origin: DEALERCOM_ORIGIN });
  assert.equal(cpo.inventoryType, 'Certified Used');
  assert.equal(cpo.readableType, null);
  // through a scan: the car is listed under Needs a look on both platforms
  const settings = withDefaults({});
  for (const [platform, adapter, siteOf, service, mutate] of [
    ['DealerOn', dealerOn, dealerOnSite, onService, (body) => { for (const d of body.DisplayCards) if (d.VehicleCard.VehicleVin === car.vin) d.VehicleCard.VehicleCondition = 'Service Loaner'; }],
    ['Dealer.com', dealerCom, dealerComSite, comService, (body) => { for (const r of body.inventory) if (r.vin === car.vin) r.inventoryType = 'Demo'; }],
  ]) {
    const site = siteOf({ cars: [car, ...platformCars(2, { from: 541 })] });
    for (const answer of site.values()) if (answer.json) mutate(answer.json);
    const siteInfo = { origin: service.origin, host: new URL(service.origin).hostname, name: 'Sample Motors', title: '', adapter: adapter.PLATFORM.id };
    const run = await scanWithSearch({ adapter, search: platformSearch(site), site: siteInfo, settings, options: adapter.scanOptions(service) });
    assert.equal(run.ok, true, platform);
    assert.equal(run.snapshot.vehicles[car.vin].decision, DECISION.REVIEW, `${platform}: the certified loaner or demo waits on Needs a look`);
    assert.doesNotMatch(String(run.vehicles.find((v) => v.vin === car.vin).inventoryType), /certified used/i, platform);
  }
});

// R-3, the repair round: the certified mark counts whatever else the title
// says. Before, it was only the title's fallback, so a title that opened
// with any word of its own ("Loaner 2017 ...", "Sale 2017 ...") dropped it
// and the gate skipped the car as sold as new; a "Certified Loaner" type
// with no separate certified flag lost it too. When the title or the
// address calls the car new, the website says new, loaner and certified at
// once: it is skipped as sold as new (never Ready, never Certified Used),
// and a note names the certified mark.
test('R-3: a certified loaner or demo goes to Needs a look whatever its title opens with, and is skipped only when the website also calls it new', () => {
  const [c] = platformCars(1, { from: 540 });
  const car = { ...c, certified: true };
  const bare = `/${car.year}-${car.make}-${car.model}-${car.vin}`;
  const on = (patch, certified = true) => normalizeInventoryRecord({ ...dealerOnCard({ ...car, certified }).VehicleCard, VehicleDetailUrl: bare, ...patch }, { origin: DEALERON_ORIGIN });
  const com = (patch, certified = true) => normalizeInventoryRecord({ ...dealerComRecord({ ...car, certified }), link: bare, ...patch }, { origin: DEALERCOM_ORIGIN });
  const name = `${car.year} ${car.make} ${car.model}`;
  const look = {
    'DealerOn, a title that opens with the loaner word': on({ VehicleCondition: 'Loaner', VehicleName: `Loaner ${name}` }),
    'DealerOn, a title that opens with another word': on({ VehicleCondition: 'Loaner', VehicleName: `Sale ${name}` }),
    'DealerOn, a demo whose title opens with Demo': on({ VehicleCondition: 'Demo', VehicleName: `Demo ${name}` }),
    'DealerOn, "Certified Loaner" with no certified flag': on({ VehicleCondition: 'Certified Loaner', VehicleName: name }, false),
    'DealerOn, "CERTIFIED_SERVICE_LOANER" with no certified flag': on({ VehicleCondition: 'CERTIFIED_SERVICE_LOANER', VehicleName: name }, false),
    'Dealer.com, a title that opens with another word': com({ inventoryType: 'Loaner', title: [`Special ${name}`, car.trim] }),
    'Dealer.com, "Certified Demo" with no certified flag': com({ inventoryType: 'Certified Demo' }, false),
  };
  for (const [what, v] of Object.entries(look)) {
    const verdict = checkPreOwned(v);
    assert.equal(verdict.verdict, 'review', `${what}: ${verdict.reason}`);
    assert.match(verdict.reason, /^Listed as pre-owned but also flagged as a (?:demo|loaner)\./, what);
    assert.equal(assessVehicle(v, withDefaults({})).decision, DECISION.REVIEW, what);
    assert.doesNotMatch(String(v.inventoryType), /certified used/i, what);
  }
  const fresh = {
    'DealerOn, a title that says new': on({ VehicleCondition: 'Demo', VehicleName: `New ${name}` }),
    'Dealer.com, an address that says new': com({ inventoryType: 'Loaner', link: `/new/${car.make}/${car.year}-${car.make}-${car.model}.htm` }),
  };
  for (const [what, v] of Object.entries(fresh)) {
    const a = assessVehicle(v, withDefaults({}));
    assert.equal(a.decision, DECISION.SKIP, `${what}: the website also calls it new: skipped as sold as new`);
    assert.doesNotMatch(String(v.inventoryType), /certified used/i, what);
    assert.ok(a.notes.includes('The website also lists it as "Certified".'), `${what}: a note names the certified mark (${a.notes.join(' | ')})`);
  }
  // a plain loaner with no certified mark anywhere, and nothing that says used, is still sold as new
  const loaner = on({ VehicleCondition: 'Loaner', VehicleName: `Loaner ${name}` }, false);
  assert.equal(loaner.readableType, null);
  assert.equal(assessVehicle(loaner, withDefaults({})).decision, DECISION.SKIP);
});

// R-8: the only price a car has, labelled as a guide's value or an offer
// for the car ("Market Price", "KBB Value", "Instant Cash Offer"). Some
// websites label their own selling price that way, so, as the standard-data
// reader does (schemaOrgNormalize.js priceFromOffers), the car gets no price
// and the reason quotes the label for a person to check; a cash or trade-in
// offer is never read as the price, whatever words sit beside it.
test('R-8: a lone guide or offer label is quoted, never read as the price; a cash offer never is', () => {
  const e = (value, label, extra = {}) => ({ value, label, key: '', final: false, ...extra });
  const quoted = (label) => ({ price: null, priceLabel: `the list labels its price "${label}", which Lot Current does not read as the selling price`, priceBeforeFees: null });
  for (const label of ['Market Price', 'Market Value', 'KBB Value', 'Kelley Blue Book Fair Purchase Price', 'Fair Market Value', 'Typical Listing Price', 'Book Value', 'Black Book Price', 'NADA Value', 'J.D. Power Value', 'Edmunds Price', 'Estimated Value', 'Trade-In Value', 'Trade-In Offer', 'Cash Offer', 'Instant Cash Offer', 'Your Cash Offer', 'Our Instant Offer']) {
    assert.deepEqual(choosePrices([e(24995, label)], { dealer: 'Example Motors' }), quoted(label), label);
    assert.equal(priceKind({ label, key: '', final: true, value: 1 }, 'Example Motors'), 'other', `${label}: never a selling price, even marked final`);
  }
  // the key's own words count when the entry has no label of its own (a field named for the price)
  assert.deepEqual(choosePrices(labeledPrices({ marketPrice: 24995 })), quoted('market Price'));
  assert.deepEqual(choosePrices(labeledPrices({ pricing: [{ typeClass: 'cashOffer', value: '$19,500' }] })), quoted('cash Offer'));
  // a payment beside it changes nothing; two such labels are both quoted
  assert.deepEqual(choosePrices([e(24995, 'Market Price'), e(399, 'Est. Monthly Payment')]), quoted('Market Price'));
  assert.deepEqual(choosePrices([e(24995, 'KBB Value'), e(25500, 'Market Value')]), { price: null, priceLabel: 'the list labels its prices "KBB Value" and "Market Value", which Lot Current does not read as the selling price', priceBeforeFees: null });
  // beside the selling price, an offer is neither the price nor the lower price
  assert.deepEqual(choosePrices([e(21000, 'Internet Price'), e(19000, 'Instant Cash Offer')]), { price: 21000, priceLabel: 'Internet Price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([e(21000, 'Price'), e(19000, 'Your Cash Offer')]), { price: 21000, priceLabel: 'Price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([e(21000, 'Retail Price'), e(21500, 'Our Instant Offer', { final: true })]), { price: 21000, priceLabel: 'Retail Price', priceBeforeFees: null });
  // other figures that are not the price keep the plain reason
  assert.deepEqual(choosePrices([e(30000, 'MSRP')]), { price: null, priceLabel: 'Call for price', priceBeforeFees: null });
  // through both platforms' records: no price, the reason quoted on Not ready
  const [c] = platformCars(1, { from: 560 });
  const com = normalizeInventoryRecord({ ...dealerComRecord(c), pricing: { dprice: [{ typeClass: 'marketValue', label: 'Market Value', value: '$24,995', isFinalPrice: true }] } }, { origin: DEALERCOM_ORIGIN });
  assert.deepEqual([com.price, com.priceBeforeFees], [null, null]);
  assert.deepEqual(assessVehicle(com, withDefaults({})).blockers.map((b) => b.text), ['No price on the website (the list labels its price "Market Value", which Lot Current does not read as the selling price)']);
  const { VehicleRetailPrice, VehicleInternetPrice, ...noPrices } = dealerOnCard(c).VehicleCard;
  assert.ok(VehicleRetailPrice && VehicleInternetPrice);
  const on = normalizeInventoryRecord({ ...noPrices, VehicleInstantCashOfferPrice: 19500 }, { origin: DEALERON_ORIGIN });
  assert.equal(on.price, null, 'a cash offer is never the price');
  assert.equal(on.priceLabel, 'the list labels its price "Instant Cash Offer Price", which Lot Current does not read as the selling price');
});

// R-8, the repair round: DealerOn carries its price's label in a field of
// its own (VehiclePriceLabel, as test/platformSites.js has it). When that
// label names a guide's value or an offer, the price beside it is that
// figure, whatever the price field is called, so the car gets no price and
// the label is quoted. Before, "Market Value" there was ignored and the car
// went out at its Internet Price. A guide's value under a name with no
// "price" in it (VehicleMarketValue, VehicleKbbValue) was not seen at all,
// so a car with only that figure got the plain "Call for price".
test('R-8: a record that labels its price "Market Value" in a field of its own gets no price, the label quoted; a guide value under its own name is quoted too', () => {
  const [c] = platformCars(1, { from: 560 });
  const quoted = (label) => `the list labels its price "${label}", which Lot Current does not read as the selling price`;
  const card = dealerOnCard(c).VehicleCard;
  const { VehicleRetailPrice, ...onlyInternet } = card;
  assert.ok(VehicleRetailPrice);
  for (const label of ['Market Value', 'Market Price', 'Instant Cash Offer', 'Your Cash Offer', 'KBB Value', 'Trade-In Value', 'Estimated Value']) {
    const v = normalizeInventoryRecord({ ...onlyInternet, VehiclePriceLabel: label }, { origin: DEALERON_ORIGIN });
    assert.deepEqual([v.price, v.priceLabel, v.priceBeforeFees], [null, quoted(label), null], label);
    assert.equal(assessVehicle(v, withDefaults({})).decision, DECISION.NOT_READY, `${label}: Not ready`);
    // beside a retail price too: the website's own price is the guide's figure, so the retail one is not taken either
    const full = normalizeInventoryRecord({ ...card, VehiclePriceLabel: label }, { origin: DEALERON_ORIGIN });
    assert.deepEqual([full.price, full.priceLabel], [null, quoted(label)], `${label}, beside a retail price`);
  }
  // the usual labels change nothing
  for (const label of ['Sample Motors Price', 'Internet Price', 'Sale Price', 'Price', 'Our Price', 'Retail Price', '']) {
    const v = normalizeInventoryRecord({ ...card, VehiclePriceLabel: label }, { origin: DEALERON_ORIGIN });
    assert.deepEqual([v.price, v.priceBeforeFees], [c.base + c.fee, c.base], `"${label}"`);
  }
  // a guide's value under a name of its own, with no price beside it: quoted, never "Call for price"
  const { VehicleInternetPrice, ...noPrices } = onlyInternet;
  assert.ok(VehicleInternetPrice);
  for (const [key, label] of [['VehicleMarketValue', 'Market Value'], ['VehicleKbbValue', 'Kbb Value'], ['VehicleTradeInValue', 'Trade In Value'], ['VehicleInstantCashOffer', 'Instant Cash Offer']]) {
    const v = normalizeInventoryRecord({ ...noPrices, [key]: 24995 }, { origin: DEALERON_ORIGIN });
    assert.deepEqual([v.price, v.priceLabel], [null, quoted(label)], key);
  }
  const com = normalizeInventoryRecord({ ...dealerComRecord(c), pricing: {}, marketValue: '$24,995' }, { origin: DEALERCOM_ORIGIN });
  assert.deepEqual([com.price, com.priceLabel], [null, quoted('market Value')]);
  // beside the selling price, such a figure is neither the price nor the lower price
  const beside = normalizeInventoryRecord({ ...card, VehicleMarketValue: 30000, VehicleTradeInValue: 15000 }, { origin: DEALERON_ORIGIN });
  assert.deepEqual([beside.price, beside.priceBeforeFees], [c.base + c.fee, c.base]);
  // a payment or a bonus is no guide's label: not quoted as one
  assert.deepEqual(choosePrices([{ value: 399, label: 'Estimated Payment', key: '', final: false }]), { price: null, priceLabel: 'Call for price', priceBeforeFees: null });
  assert.deepEqual(choosePrices([{ value: 1000, label: 'Trade-In Bonus', key: '', final: false }, { value: 500, label: 'Trade-In Assistance', key: '', final: false }]).priceLabel, 'Call for price');
});

// The CHANGELOG's "one car that can't be checked holds back only itself"
// holds on DealerOn and Dealer.com too, through the scan runner and the
// rescan diff of the reviewed code: a car whose own page fails is listed
// under Needs a look with its reason, the other cars' verdicts still count,
// and the cars a failing run of pages kept from being checked are checked
// first next time (scanRunner.confirmOrder), so three broken pages never
// hold back a sold car for more than one scan.
test('DealerOn and Dealer.com: a car whose page fails holds back only itself, scan after scan', async () => {
  const settings = withDefaults({});
  for (const [platform, adapter, siteOf, path, service, goneStatus] of [
    ['DealerOn', dealerOn, dealerOnSite, dealerOnPath, onService, 404],
    ['Dealer.com', dealerCom, dealerComSite, dealerComPath, comService, 410],
  ]) {
    const cars = platformCars(8, { from: 600 });
    const [a, b, c, sold] = platformCars(4, { from: 620 });
    const siteInfo = { origin: service.origin, host: new URL(service.origin).hostname, name: 'Sample Motors', title: '', adapter: adapter.PLATFORM.id };
    const options = { ...adapter.scanOptions(service), pageGapMs: 0 };
    const posted = Object.fromEntries([a, b, c, sold].map((x) => [x.vin, { price: x.base + x.fee, postedAt: '2026-10-01T15:00:00.000Z', name: `${x.year} ${x.make} ${x.model}` }]));
    const first = await scanWithSearch({ adapter, search: platformSearch(siteOf({ cars: [...cars, a, b, c, sold] })), site: siteInfo, settings, posted, options });
    assert.equal(first.ok, true, platform);
    // a, b and c leave the list and their pages answer 500; the sold car's page answers 404 or 410
    const failing = siteOf({ cars, gone: [sold], goneStatus });
    for (const x of [a, b, c]) failing.set(service.origin + path(x), answerWith(500, 'Server error'));
    const second = await scanWithSearch({ adapter, search: platformSearch(failing), site: siteInfo, settings, prevSnapshot: first.snapshot, posted, options });
    assert.equal(second.ok, true, platform);
    assert.ok(!second.diff.warnings.some((w) => /Couldn't double-check/.test(w)), `${platform}: the check as a whole did not fail: ${second.diff.warnings.join(' | ')}`);
    const look = Object.fromEntries(second.diff.needsALook.map((i) => [i.vin, i.text]));
    for (const x of [a, b, c]) assert.match(look[x.vin] || '', /^Missing from this scan, and its page gave HTTP 500, so it was not marked gone\. Check the car on the website; if it sold, take your listing down/, `${platform}: each failing page is that car's own item, with the reason`);
    assert.match(look[sold.vin] || '', /not confirmed gone/, `${platform}: three failing pages in a row stop this scan's check before the sold car`);
    assert.deepEqual(second.diff.takeDown, []);
    assert.deepEqual(Object.keys(second.snapshot.unchecked || {}).sort(), [a.vin, b.vin, c.vin].sort());
    // the next scan checks the sold car first, so the broken pages hold it back no longer
    const third = await scanWithSearch({ adapter, search: platformSearch(failing), site: siteInfo, settings, prevSnapshot: second.snapshot, posted, options });
    assert.deepEqual(third.diff.takeDown.map((t) => [t.vin, t.why]), [[sold.vin, 'gone']], `${platform}: the sold car goes on To do`);
    assert.deepEqual(third.diff.needsALook.map((i) => i.vin).sort(), [a.vin, b.vin, c.vin].sort());
  }
});

// R-8, repair round 2: a dealership whose own name holds a guide's, an
// offer's or a not-the-price word ("Kelley", "Market", "Value", "Old",
// "Trade", "Wholesale", "Book"). DealerOn labels the price "<Dealer> Price"
// and Dealer.com its final price "<First word> Price"; both are the
// dealership's own price, so the car keeps its selling price and stays
// Ready. Before, the own label was tested against the not-the-price words
// before the dealer name was looked at, and every car of such a dealership
// got no price (DealerOn) or its base price without the fee (Dealer.com).
// A guide's label the dealer name does not explain still blocks.
const NAMES_WITH_PRICE_WORDS = ['Kelley Chevrolet', 'Old Town Ford', 'Value Auto Mart', 'Auto Market of Springfield', 'Wholesale Auto Outlet', 'Military Auto Sales', 'Trade Winds Toyota', 'Prior Lake Chevrolet', 'Book Motors', 'Sample Motors'];

test('R-8: a dealership whose name holds a guide or not-the-price word keeps its own "<Dealer> Price" on DealerOn and Dealer.com', () => {
  const [c] = platformCars(1, { from: 570 });
  const car = { ...c, certified: false };
  for (const dealer of NAMES_WITH_PRICE_WORDS) {
    const on = normalizeInventoryRecord(dealerOnCard(car, { dealer }).VehicleCard, { origin: DEALERON_ORIGIN });
    assert.deepEqual([on.price, on.priceLabel, on.priceBeforeFees], [car.base + car.fee, 'Internet Price', car.base], `DealerOn, ${dealer}`);
    assert.equal(assessVehicle(on, withDefaults({})).decision, DECISION.READY, `DealerOn, ${dealer}: Ready`);
    const com = normalizeInventoryRecord(dealerComRecord(car, { dealer }), { origin: DEALERCOM_ORIGIN });
    assert.deepEqual([com.price, com.priceLabel, com.priceBeforeFees], [car.base + car.fee, `${dealer.split(' ')[0]} Price`, car.base], `Dealer.com, ${dealer}`);
    assert.equal(assessVehicle(com, withDefaults({})).decision, DECISION.READY, `Dealer.com, ${dealer}: Ready`);
  }
  // a label the dealership's name does not explain still blocks, and is quoted
  const quoted = (label) => `the list labels its price "${label}", which Lot Current does not read as the selling price`;
  for (const [dealer, label] of [['Kelley Chevrolet', 'Kelley Blue Book Price'], ['Kelley Chevrolet', 'Market Value'], ['Auto Market of Springfield', 'Market Value'], ['Value Auto Mart', 'KBB Value'], ['Book Motors', 'Instant Cash Offer'], ['Power Chevrolet', 'J.D. Power Price']]) {
    const v = normalizeInventoryRecord({ ...dealerOnCard(car, { dealer }).VehicleCard, VehiclePriceLabel: label }, { origin: DEALERON_ORIGIN });
    assert.deepEqual([v.price, v.priceLabel], [null, quoted(label)], `DealerOn, ${dealer}, "${label}"`);
  }
  for (const [dealer, label] of [['Kelley Chevrolet', 'Kelley Blue Book Price'], ['Old Town Ford', 'KBB Value'], ['Power Chevrolet', 'J.D. Power Price']]) {
    const record = dealerComRecord(car, { dealer });
    const dprice = record.pricing.dprice.map((e) => (e.isFinalPrice ? { ...e, label } : e));
    const v = normalizeInventoryRecord({ ...record, pricing: { ...record.pricing, dprice } }, { origin: DEALERCOM_ORIGIN });
    assert.deepEqual([v.price, v.priceBeforeFees], [car.base, null], `Dealer.com, ${dealer}, "${label}": the guide's figure is not the price`);
  }
  // the words a dealer name explains are only that name's: "Kelley Price" is no dealer's own price at another store
  assert.equal(priceKind({ label: 'Kelley Price', key: 'dprice.internetPrice', final: true, value: 1 }, 'Sample Chevrolet'), 'other');
  assert.equal(priceKind({ label: 'Kelley Price', key: 'dprice.internetPrice', final: true, value: 1 }, 'Kelley Chevrolet'), 'selling');
  assert.equal(priceKind({ label: 'Old Town Price', key: '', final: false, value: 1 }, 'Old Town Ford'), 'selling');
  assert.equal(priceKind({ label: 'Old Town Price', key: '', final: false, value: 1 }, 'New Town Ford'), 'other');
});
