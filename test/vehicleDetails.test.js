import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { recheck, fetchVehicleDetails, fetchVehicleDetailsDirect, readCarForPost } from '../extension/src/vehicleDetails.js';
import { probeTab } from '../extension/src/scanRunner.js';
import { probeSiteInPage } from '../extension/src/scan.js';
import { vehicle, fixtures, MY_STORE, fakeDealerPage, fakeChrome, runInPage, standardSite, standardCars, standardCarPage, standardListPage, fakeStandardPage, STANDARD_ORIGIN } from './helpers.js';
import { SITES_KEY } from '../extension/src/storageKeys.js';
import { adapterById } from '../extension/adapters/index.js';
import { DEALERON_ORIGIN, DEALERON_LIST, DEALERCOM_ORIGIN, DEALERCOM_LIST, platformCars, dealerOnSite, dealerComSite, dealerOnCard, dealerComRecord, dealerOnPath, fakePlatformPage, answerWith } from './platformSites.js';

test('the post-time re-check lets a ready car through and nothing else', () => {
  assert.equal(recheck(vehicle('usedNormal'), MY_STORE).ok, true);

  const gone = recheck(vehicle('usedNormal', { status: 'pend-sale' }), MY_STORE);
  assert.equal(gone.ok, false);
  assert.match(gone.message, /isn't ready.*Sale pending/);

  const retyped = recheck(vehicle('usedNormal', { type: 'New', vdp_url: 'https://x.com/inventory/new-2019-ram-1500-classic-express/', extra_fields: { title: 'New 2019 Ram 1500 Classic Express', readable_type: 'New', lightning: { inventoryType: 'New', vdp_title: 'New 2019 Ram 1500 Classic Express' } } }), MY_STORE);
  assert.equal(retyped.ok, false);
  assert.match(retyped.message, /new vehicle/);

  const odd = recheck(vehicle('usedZeroMiles'), {});
  assert.equal(odd.ok, false);
  assert.match(odd.message, /needs a look/);

  const elsewhere = recheck(vehicle('certified'), MY_STORE);
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.message, /At Cranberry/);
});

test('fetchVehicleDetails reads one car through the dealer tab: the neutral probe, the adapter\'s probe, then its search', async () => {
  const records = Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => ({ ...r, media: { image_count: 5, images: ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'] } }));
  globalThis.chrome = fakeChrome(fakeDealerPage({ records }));
  try {
    const r = await fetchVehicleDetails(1, fixtures.usedNormal.vin.toLowerCase());
    assert.equal(r.ok, true);
    assert.equal(r.vehicle.vin, fixtures.usedNormal.vin);
    assert.equal(r.vehicle.photos.length, 5, 'every photo at post time');
    assert.equal(r.site.name, 'Example Motors');
    assert.ok(!Number.isNaN(Date.parse(r.fetchedAt)));

    const retyped = await fetchVehicleDetails(1, fixtures.newNormal.vin);
    assert.equal(retyped.ok, true, 'a new car is still fetched, so the re-check can refuse it');
    assert.equal(recheck(retyped.vehicle, MY_STORE).ok, false);

    const gone = await fetchVehicleDetails(1, 'NOPE');
    assert.equal(gone.ok, false);
    assert.equal(gone.notFound, true);

    globalThis.chrome = fakeChrome(fakeDealerPage({ withService: false }));
    const unsupported = await fetchVehicleDetails(1, fixtures.usedNormal.vin);
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.message, /isn't a dealership inventory page/);

    globalThis.chrome = { scripting: { executeScript: async () => { throw new Error('No tab with id'); } } };
    const noTab = await fetchVehicleDetails(1, fixtures.usedNormal.vin);
    assert.equal(noTab.ok, false);
    assert.match(noTab.message, /Couldn't reach the dealership website tab.*No tab with id/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------- reading the car without the dealer tab (posting from the side panel) ----------

const DEALER = 'https://example-dealer.test';
const SERVICE = { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/1', apiKey: 'test-key', visibleStatusValues: ['publish', 'modified', 'pend-sale'] };
const DI_INFO = { name: 'Example Motors', adapter: 'dealerInspire', service: SERVICE, site: { origin: DEALER, name: 'Example Motors' } };
const allRecords = () => Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => ({ ...r, media: { image_count: 4, images: ['1.jpg', '2.jpg', '3.jpg', '4.jpg'] } }));

// The inventory service answering the extension's own POST, as the worker's rescan sends it.
function serviceFetch(records, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const f = body.filters || {};
    const list = records.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)) && (!f.status || f.status.includes(r.status)));
    return { ok: true, status: 200, json: async () => ({ data: { total_vehicle_count: list.length, listings: list.slice(0, body.perPage || 50) } }) };
  };
}

async function withFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('a dealer tab that now shows another website is not read: the post goes on another way', async () => {
  globalThis.chrome = fakeChrome(fakeDealerPage({ records: allRecords(), origin: 'https://another-dealer.test' }));
  try {
    const r = await fetchVehicleDetails(1, fixtures.usedNormal.vin, { origin: DEALER });
    assert.equal(r.ok, false);
    assert.equal(r.tabUnusable, true);
    assert.match(r.message, /now shows another-dealer\.test, not example-dealer\.test/);
    const same = await fetchVehicleDetails(1, fixtures.usedNormal.vin, { origin: 'https://another-dealer.test' });
    assert.equal(same.ok, true, 'the tab on the post\'s own website is read as before');
    assert.equal(same.via, 'tab');
    const noOrigin = await fetchVehicleDetails(1, fixtures.usedNormal.vin);
    assert.equal(noOrigin.ok, true, 'no website named: the tab is read, as the popup\'s Post always did');
  } finally {
    delete globalThis.chrome;
  }
});

test('without the website permission nothing is sent: the answer names the patterns to ask Chrome for', async () => {
  const calls = [];
  const asked = [];
  await withFetch(serviceFetch(allRecords(), calls), async () => {
    const r = await fetchVehicleDetailsDirect(DEALER, DI_INFO, fixtures.usedNormal.vin, { contains: async (p) => { asked.push(p); return false; } });
    assert.equal(r.ok, false);
    assert.equal(r.needsPermission, true);
    assert.deepEqual(r.origins.sort(), ['https://example-dealer.test/*', 'https://websites-search.api.carscommerce.inc/*']);
    assert.match(r.message, /Click Allow reading example-dealer\.test, or open the website's used inventory page and click Post in the popup\./);
    // Chrome's prompt lists the inventory service too, so the message names every host it asks for
    assert.match(r.message, /Chrome has to let Lot Current read example-dealer\.test and websites-search\.api\.carscommerce\.inc \(/);
    assert.deepEqual(asked, [{ origins: r.origins }]);
    const threw = await fetchVehicleDetailsDirect(DEALER, DI_INFO, fixtures.usedNormal.vin, { contains: async () => { throw new Error('no such API'); } });
    assert.equal(threw.needsPermission, true, 'a check that fails counts as not granted');
  });
  assert.equal(calls.length, 0, 'no request without the permission');
});

test('with the permission, the car is read straight from the inventory service, as the automatic rescan reads it', async () => {
  const calls = [];
  await withFetch(serviceFetch(allRecords(), calls), async () => {
    const r = await fetchVehicleDetailsDirect(DEALER, DI_INFO, fixtures.usedNormal.vin.toLowerCase(), { contains: async () => true });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'direct');
    assert.equal(r.vehicle.vin, fixtures.usedNormal.vin);
    assert.equal(r.vehicle.photos.length, 4, 'every photo, as through the tab');
    assert.equal(r.site.name, 'Example Motors');
    assert.equal(recheck(r.vehicle, MY_STORE).ok, true);
    assert.equal(calls[0].url, SERVICE.search + '/search');
    assert.equal(calls[0].init.headers['x-api-key'], 'test-key', 'the website\'s own public key, as the tab sends it');
    assert.deepEqual(JSON.parse(calls[0].init.body).filters.vin, [fixtures.usedNormal.vin]);

    const gone = await fetchVehicleDetailsDirect(DEALER, DI_INFO, 'NOPE', { contains: async () => true });
    assert.deepEqual([gone.ok, gone.notFound], [false, true]);
    assert.match(gone.message, /isn't on the website any more/);

    const retyped = await fetchVehicleDetailsDirect(DEALER, DI_INFO, fixtures.newNormal.vin, { contains: async () => true });
    assert.equal(retyped.ok, true, 'a car that became new is still read, so the re-check refuses it');
    assert.equal(recheck(retyped.vehicle, MY_STORE).ok, false);
  });
  await withFetch(async () => ({ ok: false, status: 503 }), async () => {
    const down = await fetchVehicleDetailsDirect(DEALER, DI_INFO, fixtures.usedNormal.vin, { contains: async () => true });
    assert.equal(down.ok, false);
    assert.match(down.message, /^Couldn't read the .*503\. If the website keeps turning Lot Current away, open its used inventory page and click Post in the popup\.$/);
  });
});

test('a website the registry does not know, or no adapter reads, is said plainly', async () => {
  const none = await fetchVehicleDetailsDirect(DEALER, null, fixtures.usedNormal.vin, { contains: async () => true });
  assert.equal(none.ok, false);
  assert.match(none.message, /hasn't read example-dealer\.test on this computer yet.*Scan website/);
  const noService = await fetchVehicleDetailsDirect(DEALER, { name: 'X', adapter: 'dealerInspire' }, fixtures.usedNormal.vin, { contains: async () => true });
  assert.match(noService.message, /hasn't read/);
  const unknown = await fetchVehicleDetailsDirect(DEALER, { adapter: 'gone', service: { what: 1 } }, fixtures.usedNormal.vin, { contains: async () => true });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /can't read example-dealer\.test any more/);
});

test('a website read through its standard vehicle data: the car\'s own page, read without the tab', async () => {
  const cars = standardCars(3);
  const site = standardSite({ cars });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const got = site.get(url) || { ok: false, status: 404, contentType: 'text/plain', text: 'Not found' };
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: () => got.contentType }, text: async () => got.text };
  };
  const info = { name: 'Sample Motors', adapter: 'schemaOrg', service: { kind: 'schemaOrg', origin: STANDARD_ORIGIN, listUrl: STANDARD_ORIGIN + '/used-vehicles/' }, site: { origin: STANDARD_ORIGIN, name: 'Sample Motors' } };
  await withFetch(fetchImpl, async () => {
    const r = await fetchVehicleDetailsDirect(STANDARD_ORIGIN, info, cars[1].vin, { url: STANDARD_ORIGIN + cars[1].path, contains: async (p) => { assert.deepEqual(p, { origins: [STANDARD_ORIGIN + '/*'] }); return true; } });
    assert.equal(r.ok, true);
    assert.equal(r.vehicle.vin, cars[1].vin);
    assert.equal(r.vehicle.price, cars[1].price);
  });
  assert.equal(seen[0].url, STANDARD_ORIGIN + cars[1].path, 'the car\'s own page first');
  assert.equal(seen[0].init.credentials, 'omit', 'without cookies, as the automatic rescan reads');
});

test('the post-time read knows the last scan\'s car pages, so another car\'s tile at the old price is not this car\'s price', async () => {
  // a lot whose car addresses neither carry a VIN nor read like a car page
  const cars = standardCars(4).map((c, i) => ({ ...c, path: `/vdp/${7000 + i}/` }));
  const site = standardSite({ cars });
  const tiles = `<aside><div class="tile"><a href="${cars[1].path}">${cars[1].year} ${cars[1].make}</a> <span>$15,000</span></div><div class="tile"><a href="${cars[2].path}">${cars[2].year} ${cars[2].make}</a> <span>$16,000</span></div></aside>`;
  // the page now says $14,000; its markup still says $15,000, the price on the other car's tile
  site.set(STANDARD_ORIGIN + cars[0].path, { ok: true, status: 200, contentType: 'text/html', text: standardCarPage(cars[0]).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', tiles + '<a href="/used-vehicles/">') });
  const fetchImpl = async (url) => {
    const got = site.get(url) || { ok: false, status: 404, contentType: 'text/plain', text: 'Not found' };
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: () => got.contentType }, text: async () => got.text };
  };
  const info = { name: 'Sample Motors', adapter: 'schemaOrg', service: { kind: 'schemaOrg', origin: STANDARD_ORIGIN, listUrl: STANDARD_ORIGIN + '/used-vehicles/' }, site: { origin: STANDARD_ORIGIN, name: 'Sample Motors' } };
  const snapshot = { vehicles: Object.fromEntries(cars.map((c) => [c.vin, { url: STANDARD_ORIGIN + c.path, price: c.price }])) };
  globalThis.chrome = fakeChrome({}, { ['snapshot:' + STANDARD_ORIGIN]: snapshot });
  try {
    await withFetch(fetchImpl, async () => {
      const r = await fetchVehicleDetailsDirect(STANDARD_ORIGIN, info, cars[0].vin, { url: STANDARD_ORIGIN + cars[0].path, contains: async () => true });
      assert.equal(r.ok, true);
      assert.equal(r.vehicle.price, null);
      assert.equal(recheck(r.vehicle, {}).ok, false, 'the post stops');
    });
  } finally {
    delete globalThis.chrome;
  }
});

test('the post-time read through the dealer tab knows the last scan\'s car pages too, on its first read and on its second, the way the last scan read the website', async () => {
  const O = STANDARD_ORIGIN;
  // a lot whose car addresses neither carry a VIN nor read like a car page
  const cars = standardCars(6).map((c, i) => ({ ...c, path: `/vdp/${7000 + i}/` }));
  const site = standardSite({ cars, perPage: 10 });
  const tiles = `<aside><div class="tile"><a href="${cars[1].path}">${cars[1].year} ${cars[1].make}</a> <span>$15,000</span></div><div class="tile"><a href="${cars[2].path}">${cars[2].year} ${cars[2].make}</a> <span>$16,000</span></div></aside>`;
  // the page now says $14,000; its markup still says $15,000, the price on the other car's tile
  site.set(O + cars[0].path, { ok: true, status: 200, contentType: 'text/html', text: standardCarPage(cars[0]).replace('Our price $15,000', 'Our price $14,000').replace('<a href="/used-vehicles/">', tiles + '<a href="/used-vehicles/">') });
  const whole = site.get(O + '/used-vehicles/');
  const snapshot = { vehicles: Object.fromEntries(cars.map((c) => [c.vin, { url: O + c.path, price: c.price }])) };
  const read = async ({ second, known }) => {
    // second: the tab shows a list without the car, and the last scan read another list that has it
    site.set(O + '/used-vehicles/', second ? { ok: true, status: 200, contentType: 'text/html', text: standardListPage(cars.slice(3, 5)) } : whole);
    site.set(O + '/pre-owned/', whole);
    const page = fakeStandardPage({ site, path: '/used-vehicles/' });
    const store = { [SITES_KEY]: { [O]: { adapter: 'schemaOrg', service: { kind: 'schemaOrg', origin: O, listUrl: O + (second ? '/pre-owned/' : '/used-vehicles/') } } } };
    if (known) store['snapshot:' + O] = snapshot;
    globalThis.chrome = fakeChrome(page, store);
    try {
      const r = await fetchVehicleDetails(1, cars[0].vin, { origin: O, ...(second ? {} : { url: O + cars[0].path }) });
      assert.equal(r.ok, true, r.message);
      return { price: r.vehicle.price, fetched: page.fetchCalls.map((c) => c.url.replace(O, '')) };
    } finally {
      delete globalThis.chrome;
    }
  };
  const first = await read({ second: false, known: true });
  assert.deepEqual(first, { price: null, fetched: ['/vdp/7000/'] }, 'the first read, from the car\'s known page');
  const again = await read({ second: true, known: true });
  assert.deepEqual(again, { price: null, fetched: ['/used-vehicles/', '/pre-owned/', '/vdp/7000/'] }, 'the second read, from the last scan\'s list');
  // without the last scan's car pages, nothing tells the tile's link from a link to anything else
  assert.equal((await read({ second: false, known: false })).price, 15000);
  assert.equal((await read({ second: true, known: false })).price, 15000);
});

test('readCarForPost: the tab when it shows the website, the direct read only when the tab can\'t be used', async () => {
  const records = allRecords();
  const calls = [];
  await withFetch(serviceFetch(records, calls), async () => {
    // the popup's Post: the tab answers, nothing is sent from the extension
    globalThis.chrome = fakeChrome(fakeDealerPage({ records, origin: DEALER }));
    try {
      const viaTab = await readCarForPost({ tabId: 1, origin: DEALER, info: DI_INFO, vin: fixtures.usedNormal.vin, contains: async () => true });
      assert.deepEqual([viaTab.ok, viaTab.via], [true, 'tab']);
      // the tab says the car is gone: final, never asked again another way
      const gone = await readCarForPost({ tabId: 1, origin: DEALER, info: DI_INFO, vin: 'NOPE', contains: async () => true });
      assert.deepEqual([gone.ok, gone.notFound], [false, true]);
      assert.equal(calls.length, 0, 'the extension sent nothing while the tab could answer');
    } finally {
      delete globalThis.chrome;
    }

    // the tab was closed: read from the extension with the permission
    globalThis.chrome = { scripting: { executeScript: async () => { throw new Error('No tab with id: 1'); } } };
    try {
      const closed = await readCarForPost({ tabId: 1, origin: DEALER, info: DI_INFO, vin: fixtures.usedNormal.vin, contains: async () => true });
      assert.deepEqual([closed.ok, closed.via], [true, 'direct']);
      assert.equal(calls.length, 1);
      // and without it, the person is asked
      const ask = await readCarForPost({ tabId: 1, origin: DEALER, info: DI_INFO, vin: fixtures.usedNormal.vin, contains: async () => false });
      assert.equal(ask.needsPermission, true);
      // no registry entry to read it through: the tab's own words
      const noInfo = await readCarForPost({ tabId: 1, origin: DEALER, info: null, vin: fixtures.usedNormal.vin, contains: async () => true });
      assert.equal(noInfo.ok, false);
      assert.match(noInfo.message, /Couldn't reach the dealership website tab/);
    } finally {
      delete globalThis.chrome;
    }

    // the side panel's own list: no tab at all
    const fromList = await readCarForPost({ tabId: null, origin: DEALER, info: DI_INFO, vin: fixtures.usedNormal.vin, contains: async () => true });
    assert.deepEqual([fromList.ok, fromList.via], [true, 'direct']);
    const undefinedTab = await readCarForPost({ origin: DEALER, info: DI_INFO, vin: fixtures.usedNormal.vin, contains: async () => true });
    assert.equal(undefinedTab.via, 'direct');
  });
});

// The side panel's own list posts with no dealer tab at all. For a DealerOn
// or Dealer.com website that read goes registry entry -> adapter ->
// permission patterns -> the adapter's getDetails over its direct search (the
// list, then the car's own page), the same way the automatic rescan reads it.
function platformFetch(site, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), credentials: init && init.credentials });
    const got = site.get(String(url)) || answerWith(404, 'Not found');
    return { ok: got.ok, status: got.status, url: String(url), redirected: false, headers: { get: () => got.contentType }, text: async () => got.text };
  };
}

test('a DealerOn or Dealer.com car posted from the side panel\'s list is read without a tab: the list, then its own page, with the website permission only', async () => {
  const cars = platformCars(6);
  const car = cars[2];
  for (const [kind, origin, list, siteFn] of [['dealerOn', DEALERON_ORIGIN, DEALERON_LIST, dealerOnSite], ['dealerCom', DEALERCOM_ORIGIN, DEALERCOM_LIST, dealerComSite]]) {
    const service = { kind, origin, inventoryUrl: list, listUrl: origin + '/used-inventory/' };
    // the registry entry as the scan stores it, and an older one that does not name its adapter
    for (const info of [{ name: 'Sample', adapter: kind, service, site: { origin, name: 'Sample' } }, { name: 'Sample', service }]) {
      const calls = [];
      await withFetch(platformFetch(siteFn({ cars }), calls), async () => {
        const asked = [];
        const r = await readCarForPost({ tabId: null, origin, info, vin: car.vin.toLowerCase(), contains: async (p) => { asked.push(p); return true; } });
        assert.deepEqual([r.ok, r.via], [true, 'direct'], `${kind}: read straight from the extension`);
        assert.deepEqual(asked, [{ origins: [origin + '/*'] }], `${kind}: only the website itself is asked for`);
        assert.equal(r.vehicle.vin, car.vin);
        assert.equal(r.vehicle.photos.length, car.photos, `${kind}: every photo, not the list's thumbnail`);
        assert.equal(r.vehicle.price, car.base + car.fee, `${kind}: the website's price`);
        assert.equal(r.site.origin, origin);
        assert.ok(calls.length >= 2 && calls.every((c) => c.url.startsWith(origin + '/')), `${kind}: only the website is read`);
        assert.ok(calls.every((c) => c.credentials === 'omit'), `${kind}: without the browser's cookies`);
        assert.equal(calls[0].url, list, `${kind}: the list first`);
        assert.ok(calls.slice(1).some((c) => c.url.includes(car.vin.slice(-8).toLowerCase()) || c.url.includes(car.vin)), `${kind}: then the car's own page`);

        // a car the list no longer has is gone
        const gone = await readCarForPost({ tabId: null, origin, info, vin: platformCars(1, { from: 50 })[0].vin, contains: async () => true });
        assert.deepEqual([gone.ok, gone.notFound], [false, true], `${kind}: a car missing from the whole list is not on the website any more`);
      });
      // without the permission nothing is sent, and the patterns to ask for are named
      const none = [];
      await withFetch(platformFetch(siteFn({ cars }), none), async () => {
        const ask = await readCarForPost({ tabId: null, origin, info, vin: car.vin, contains: async () => false });
        assert.equal(ask.needsPermission, true);
        assert.deepEqual(ask.origins, [origin + '/*']);
      });
      assert.equal(none.length, 0, `${kind}: nothing sent without the permission`);
    }
  }
});

// A queue's start tab the salesperson has since moved to Facebook: nothing of
// Lot Current's is injected into it and nothing of it is read (store/listing.md:
// no other Facebook page is read), so the car is read the other way.
function facebookPage(path = '/marketplace/inbox/') {
  const document = {
    title: 'Marketplace - Inbox | Facebook',
    body: { innerText: 'Buyer: can I see it at 12 Oak Street, Springfield, OH 43215 tomorrow?' },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return vm.createContext({ window: {}, document, location: { origin: 'https://www.facebook.com', hostname: 'www.facebook.com', href: 'https://www.facebook.com' + path }, URL });
}

test('a dealer tab that now shows a Facebook page has nothing injected into it: the post-time read goes on another way', async () => {
  const injected = [];
  const page = facebookPage();
  const chrome = fakeChrome(page);
  const inject = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (opts) => { injected.push(opts.func.name); return inject(opts); };
  globalThis.chrome = chrome;
  const calls = [];
  try {
    await withFetch(serviceFetch(allRecords(), calls), async () => {
      const r = await fetchVehicleDetails(7, fixtures.usedNormal.vin, { origin: DEALER });
      assert.deepEqual([r.ok, r.tabUnusable], [false, true]);
      assert.match(r.message, /now shows www\.facebook\.com, not example-dealer\.test/);
      const read = await readCarForPost({ tabId: 7, origin: DEALER, info: DI_INFO, vin: fixtures.usedNormal.vin, contains: async () => true });
      assert.deepEqual([read.ok, read.via], [true, 'direct'], 'read straight from the website instead');
    });
    assert.deepEqual(injected, [], 'nothing is injected into the Facebook page');
    assert.equal(calls.length, 1);

    // a tab whose address Chrome does not show is not read either
    chrome.tabs.get = async (id) => ({ id });
    const hidden = await fetchVehicleDetails(7, fixtures.usedNormal.vin, { origin: DEALER });
    assert.deepEqual([hidden.ok, hidden.tabUnusable], [false, true]);
    assert.match(hidden.message, /no longer shows example-dealer\.test/);
    chrome.tabs.get = async () => { throw new Error('No tab with id: 7'); };
    const closed = await fetchVehicleDetails(7, fixtures.usedNormal.vin, { origin: DEALER });
    assert.match(closed.message, /Couldn't reach the dealership website tab.*No tab with id: 7/);
    assert.deepEqual(injected, []);

    // no website named (the popup's Scan): the neutral probe itself reads nothing of a Facebook page
    chrome.tabs.get = async (id) => ({ id, url: page.location.href });
    const unnamed = await fetchVehicleDetails(7, fixtures.usedNormal.vin);
    assert.deepEqual([unnamed.ok, unnamed.tabUnusable], [false, true]);
    assert.deepEqual(injected, ['probeSiteInPage'], 'only the neutral probe, which returns at once');
    for (const path of ['/marketplace/you/selling/', '/']) assert.equal(await runInPage(facebookPage(path), probeSiteInPage), null);
    assert.equal(await runInPage(vm.createContext({ ...facebookPage(), location: { origin: 'https://web.facebook.com', hostname: 'web.facebook.com', href: 'https://web.facebook.com/marketplace/' } }), probeSiteInPage), null);
  } finally {
    delete globalThis.chrome;
  }
  // and a dealer page is still probed in full
  const dealer = await runInPage(fakeDealerPage({ origin: DEALER }), probeSiteInPage);
  assert.equal(dealer.origin, DEALER);
});

// A dealer tab on another list of the same website (the new cars, a search
// the salesperson filtered for a customer) loaded only that list, and the
// probe's list address is that one. A used car missing from it is not sold:
// the read is made once more through the same tab with the list the last
// scan of this website read, and only that answer is final.
test('a dealer tab on another list of the website does not call a used car sold: the last scan\'s list is read too', async () => {
  const cars = platformCars(4, { from: 1 });
  const json = (body) => ({ ok: true, status: 200, contentType: 'application/json', text: JSON.stringify(body), json: body });
  const cases = [
    {
      what: 'Dealer.com, the new-car page',
      origin: DEALERCOM_ORIGIN,
      adapter: 'dealerCom',
      service: { kind: 'dealerCom', origin: DEALERCOM_ORIGIN, inventoryUrl: DEALERCOM_LIST, listUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm' },
      site: dealerComSite({ cars }),
      other: DEALERCOM_LIST.replace('AUTO_USED', 'AUTO_NEW'),
      otherBody: (list) => ({ pageInfo: { totalCount: list.length, pageSize: 35, pageStart: 0 }, inventory: list.map((c) => ({ ...dealerComRecord(c), inventoryType: 'new' })) }),
      path: '/new-inventory/index.htm',
      extras: { windowExtras: { DDC: {} }, text: 'Website by Dealer.com' },
    },
    {
      what: 'DealerOn, a used search filtered to one make',
      origin: DEALERON_ORIGIN,
      adapter: 'dealerOn',
      service: { kind: 'dealerOn', origin: DEALERON_ORIGIN, inventoryUrl: DEALERON_LIST, listUrl: DEALERON_ORIGIN + '/searchused.aspx' },
      site: dealerOnSite({ cars }),
      other: DEALERON_LIST + '&make=Other',
      otherBody: (list) => ({ DisplayCards: list.map((c) => dealerOnCard(c)), Paging: { PaginationDataModel: { TotalCount: list.length, PageNumber: 1 } } }),
      path: '/searchused.aspx?make=Other',
      extras: { text: 'Copyright © 2026 by DealerOn' },
    },
  ];
  for (const k of cases) {
    const others = platformCars(2, { from: 40 });
    k.site.set(k.other, json(k.otherBody(others)));
    const page = fakePlatformPage({ site: k.site, origin: k.origin, path: k.path, requested: [k.other], ...k.extras });
    const store = { [SITES_KEY]: { [k.origin]: { adapter: k.adapter, service: k.service } } };
    globalThis.chrome = fakeChrome(page, store);
    try {
      const info = store[SITES_KEY][k.origin];
      const r = await readCarForPost({ tabId: 1, origin: k.origin, info, vin: cars[1].vin, contains: async () => false });
      assert.equal(r.ok, true, `${k.what}: ${r.message}`);
      assert.equal(r.via, 'tab', `${k.what}: through the same tab, so no website permission is needed`);
      assert.equal(r.vehicle.vin, cars[1].vin);
      assert.ok(page.fetchCalls.some((c) => c.url === k.other) && page.fetchCalls.some((c) => c.url.startsWith(k.service.inventoryUrl.split('?')[0])), `${k.what}: both lists were read`);
      // a car on the list the page loaded is read from it, with no second read
      page.fetchCalls.length = 0;
      const onThisList = await readCarForPost({ tabId: 1, origin: k.origin, info, vin: others[0].vin, contains: async () => false });
      assert.equal(onThisList.ok, true, `${k.what}: ${onThisList.message}`);
      assert.ok(page.fetchCalls.every((c) => !c.url.startsWith(k.service.inventoryUrl.split('?')[0]) || c.url.startsWith(k.other)), `${k.what}: the last scan's list is not read for a car the page's list has`);
      // a car on neither list is gone, as before
      const gone = await readCarForPost({ tabId: 1, origin: k.origin, info, vin: platformCars(1, { from: 90 })[0].vin, contains: async () => false });
      assert.deepEqual([gone.ok, gone.notFound], [false, true], k.what);
      // with nothing stored for the website, the page's own list is all there is
      delete store[SITES_KEY];
      const alone = await fetchVehicleDetails(1, cars[1].vin, { origin: k.origin });
      assert.deepEqual([alone.ok, alone.notFound], [false, true], `${k.what}: no last scan, no second list`);
    } finally {
      delete globalThis.chrome;
    }
  }
});

// An adapter that read only part of the website's list (a later list page
// failed, or the paging did not move the list on) cannot say a car is gone:
// getDetails answers record null with complete false, and the side panel is
// told the list could not be read whole, never that the car is sold.
test('a car missing from a list the website did not give whole is not called gone', async () => {
  const adapter = adapterById('dealerOn');
  const real = adapter.getDetails;
  const info = { adapter: 'dealerOn', service: { kind: 'dealerOn', origin: DEALERON_ORIGIN, inventoryUrl: DEALERON_LIST, listUrl: DEALERON_ORIGIN + '/searchused.aspx' } };
  const vin = platformCars(1, { from: 3 })[0].vin;
  try {
    adapter.getDetails = async () => ({ ok: true, record: null, complete: false, fetchedAt: new Date().toISOString() });
    const partial = await fetchVehicleDetailsDirect(DEALERON_ORIGIN, info, vin, { contains: async () => true });
    assert.equal(partial.ok, false);
    assert.equal(partial.notFound, undefined, 'not "not on the website any more"');
    // the cause can last (a next link that loops, paging the website ignores): no "try again in a minute", and no "turning Lot Current away"
    assert.equal(partial.message, "Couldn't read the website's whole list of cars, so this car couldn't be checked. Open the website's used inventory page, click Scan website in the popup, then post this car from the popup there.");
    adapter.getDetails = async () => ({ ok: true, record: null, complete: true, fetchedAt: new Date().toISOString() });
    const whole = await fetchVehicleDetailsDirect(DEALERON_ORIGIN, info, vin, { contains: async () => true });
    assert.deepEqual([whole.ok, whole.notFound], [false, true], 'a whole list without the car: gone, as before');
    adapter.getDetails = async () => ({ ok: true, record: null, fetchedAt: new Date().toISOString() });
    assert.equal((await fetchVehicleDetailsDirect(DEALERON_ORIGIN, info, vin, { contains: async () => true })).notFound, true, 'an adapter that does not say: as before');
    // a page with no vehicle data is not the website turning Lot Current away; a failing page may be
    adapter.getDetails = async () => ({ ok: false, message: "The car's page on the website has no vehicle data Lot Current can read.", carPage: true, noData: true });
    const blank = await fetchVehicleDetailsDirect(DEALERON_ORIGIN, info, vin, { contains: async () => true });
    assert.deepEqual([blank.ok, blank.notFound, blank.carPage, blank.noData], [false, undefined, true, true]);
    assert.equal(blank.message, "The car's page on the website has no vehicle data Lot Current can read.");
    adapter.getDetails = async () => ({ ok: false, message: "Couldn't read the car's page on the website (HTTP 500).", carPage: true });
    assert.match((await fetchVehicleDetailsDirect(DEALERON_ORIGIN, info, vin, { contains: async () => true })).message, /HTTP 500\)\. If the website keeps turning Lot Current away/);
  } finally {
    adapter.getDetails = real;
  }
});

// The same tab on another list that the website gave only in part (its
// page 2 failed, or the paging did not move it on): the adapter answers
// record null with complete false. That is no more final than a car missing
// from it: the list the last scan read is read too, and only its answer counts.
test('a car missing from the part of another list the website gave is read from the last scan\'s list before anything is said', async () => {
  const cars = platformCars(4, { from: 1 });
  const json = (body) => ({ ok: true, status: 200, contentType: 'application/json', text: JSON.stringify(body), json: body });
  const service = { kind: 'dealerCom', origin: DEALERCOM_ORIGIN, inventoryUrl: DEALERCOM_LIST, listUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm' };
  const other = DEALERCOM_LIST.replace('AUTO_USED', 'AUTO_NEW');
  const site = dealerComSite({ cars });
  const others = platformCars(2, { from: 40 });
  site.set(other, json({ pageInfo: { totalCount: 50, pageSize: 35, pageStart: 0 }, inventory: others.map((c) => ({ ...dealerComRecord(c), inventoryType: 'new' })) }));
  const page = fakePlatformPage({ site, origin: DEALERCOM_ORIGIN, path: '/new-inventory/index.htm', requested: [other], windowExtras: { DDC: {} }, text: 'Website by Dealer.com' });
  const store = { [SITES_KEY]: { [DEALERCOM_ORIGIN]: { adapter: 'dealerCom', service } } };
  const adapter = adapterById('dealerCom');
  const real = adapter.getDetails;
  // the list reader as the shared inventory reader answers once it says so:
  // a list it could not read whole gives complete false with record null
  const cutShort = new Set([other]);
  adapter.getDetails = async (search, vin, options) => {
    const r = await real(search, vin, options);
    return r.ok && !r.record && cutShort.has(options.inventoryUrl) ? { ...r, complete: false } : r;
  };
  globalThis.chrome = fakeChrome(page, store);
  try {
    const info = store[SITES_KEY][DEALERCOM_ORIGIN];
    const r = await readCarForPost({ tabId: 1, origin: DEALERCOM_ORIGIN, info, vin: cars[1].vin, contains: async () => false });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.via, 'tab', 'through the same tab, so no website permission is needed');
    assert.equal(r.vehicle.vin, cars[1].vin);
    assert.ok(page.fetchCalls.some((c) => c.url.startsWith(DEALERCOM_LIST.split('?')[0]) && c.url.includes('AUTO_USED')), 'the last scan\'s list was read');

    // a car the last scan's whole list does not have either is gone
    const gone = await readCarForPost({ tabId: 1, origin: DEALERCOM_ORIGIN, info, vin: platformCars(1, { from: 90 })[0].vin, contains: async () => false });
    assert.deepEqual([gone.ok, gone.notFound], [false, true]);

    // when the last scan's list is cut short too, nothing is called gone
    cutShort.add(DEALERCOM_LIST);
    const both = await readCarForPost({ tabId: 1, origin: DEALERCOM_ORIGIN, info, vin: platformCars(1, { from: 90 })[0].vin, contains: async () => false });
    assert.deepEqual([both.ok, both.notFound, both.incomplete], [false, undefined, true]);
    assert.match(both.message, /^Couldn't read the website's whole list of cars, so this car couldn't be checked\. Open the website's used inventory page/);

    // with nothing stored for the website, the page's own part-read list says only that
    delete store[SITES_KEY];
    const alone = await fetchVehicleDetails(1, cars[1].vin, { origin: DEALERCOM_ORIGIN });
    assert.deepEqual([alone.ok, alone.notFound, alone.incomplete], [false, undefined, true]);
  } finally {
    adapter.getDetails = real;
    delete globalThis.chrome;
  }
});

// The same tab on another list whose first page fails (a 500) or holds no
// cars and no count: that is no answer about the car either, so the list
// the last scan read is read too. A refusal is never followed by another read.
test('a dealer tab whose own list fails on its first page reads the car from the last scan\'s list; a refusal is never followed by another read', async () => {
  const cars = platformCars(4, { from: 1 });
  const json = (body) => ({ ok: true, status: 200, contentType: 'application/json', text: JSON.stringify(body), json: body });
  const service = { kind: 'dealerCom', origin: DEALERCOM_ORIGIN, inventoryUrl: DEALERCOM_LIST, listUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm' };
  const other = DEALERCOM_LIST.replace('AUTO_USED', 'AUTO_NEW');
  const usedList = (c) => c.url.startsWith(DEALERCOM_LIST.split('?')[0]) && c.url.includes('AUTO_USED');
  const tabOn = (answer) => {
    const site = dealerComSite({ cars });
    site.set(other, answer);
    const page = fakePlatformPage({ site, origin: DEALERCOM_ORIGIN, path: '/new-inventory/index.htm', requested: [other], windowExtras: { DDC: {} }, text: 'Website by Dealer.com' });
    const store = { [SITES_KEY]: { [DEALERCOM_ORIGIN]: { adapter: 'dealerCom', service } } };
    globalThis.chrome = fakeChrome(page, store);
    return { page, info: store[SITES_KEY][DEALERCOM_ORIGIN] };
  };
  try {
    for (const [what, answer] of [['a 500', answerWith(500, 'Server error')], ['no cars and no count', json({ inventory: [] })]]) {
      const { page, info } = tabOn(answer);
      const r = await readCarForPost({ tabId: 1, origin: DEALERCOM_ORIGIN, info, vin: cars[1].vin, contains: async () => false });
      assert.equal(r.ok, true, `${what}: ${r.message}`);
      assert.equal(r.via, 'tab', `${what}: through the same tab`);
      assert.equal(r.vehicle.vin, cars[1].vin);
      assert.ok(page.fetchCalls.some(usedList), `${what}: the last scan's list was read`);
    }
    for (const status of [429, 403]) {
      const { page, info } = tabOn(answerWith(status, 'No'));
      const r = await readCarForPost({ tabId: 1, origin: DEALERCOM_ORIGIN, info, vin: cars[1].vin, contains: async () => false });
      assert.equal(r.ok, false);
      assert.match(r.message, new RegExp(`\\(${status}\\)`));
      assert.ok(!page.fetchCalls.some(usedList), `${status}: nothing more is asked of a website that refused`);
    }
  } finally {
    delete globalThis.chrome;
  }
});

// The adapter the last scan used reads the car at post time, even when
// another adapter's probe answers on the open page: a DealerOn car page that
// shows standard vehicle data but no DealerOn mark is still read the way the
// scan read the lot, so its price is chosen the same way (on the dealer's basis).
test('at post time the adapter the last scan used reads the car, not another adapter whose probe answered on the page', async () => {
  const cars = platformCars(4, { from: 1 });
  const car = cars[1];
  const service = { kind: 'dealerOn', origin: DEALERON_ORIGIN, inventoryUrl: DEALERON_LIST, listUrl: DEALERON_ORIGIN + '/searchused.aspx' };
  const site = dealerOnSite({ cars });
  const path = dealerOnPath(car);
  // the car's page carries standard vehicle data at another price, and nothing that marks it as DealerOn's
  const node = { '@context': 'https://schema.org', '@type': 'Car', name: `${car.year} ${car.make} ${car.model}`, vehicleIdentificationNumber: car.vin, url: DEALERON_ORIGIN + path, offers: { '@type': 'Offer', price: 1234, priceCurrency: 'USD' } };
  const carPage = `<!doctype html><html><head><title>${car.year} ${car.make} ${car.model}</title><script type="application/ld+json">${JSON.stringify(node)}</script></head><body><h1>${car.year} ${car.make} ${car.model}</h1><p>$1,234</p></body></html>`;
  // the website serves that page at the car's address too, so the page's own reader can read the car from it
  site.set(DEALERON_ORIGIN + path, { ok: true, status: 200, contentType: 'text/html', text: carPage });
  const page = fakeStandardPage({ site, origin: DEALERON_ORIGIN, path, html: carPage });
  const store = { [SITES_KEY]: { [DEALERON_ORIGIN]: { adapter: 'dealerOn', service } } };
  globalThis.chrome = fakeChrome(page, store);
  try {
    const probe = await probeTab(1);
    assert.equal(probe.adapterId, 'schemaOrg', 'the page itself reads as standard vehicle data');
    const r = await fetchVehicleDetails(1, car.vin, { origin: DEALERON_ORIGIN, url: DEALERON_ORIGIN + path });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.vehicle.vin, car.vin);
    assert.equal(r.vehicle.price, car.base + car.fee, 'the price the last scan\'s reader chooses, not the page markup\'s');
    assert.ok(page.fetchCalls.some((c) => c.url === DEALERON_LIST), 'read through the list the last scan read');
    // with no last scan stored, the page's own reader is all there is
    delete store[SITES_KEY];
    page.fetchCalls.length = 0;
    const alone = await fetchVehicleDetails(1, car.vin, { origin: DEALERON_ORIGIN, url: DEALERON_ORIGIN + path });
    assert.ok(!page.fetchCalls.some((c) => c.url === DEALERON_LIST), 'no stored reader: not read through it');
    assert.deepEqual([alone.ok, alone.vehicle && alone.vehicle.price], [true, 1234], alone.message);
  } finally {
    delete globalThis.chrome;
  }
});
