import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { recheck, fetchVehicleDetails, fetchVehicleDetailsDirect, readCarForPost } from '../extension/src/vehicleDetails.js';
import { probeSiteInPage } from '../extension/src/scan.js';
import { vehicle, fixtures, MY_STORE, fakeDealerPage, fakeChrome, runInPage, standardSite, standardCars, STANDARD_ORIGIN } from './helpers.js';

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
