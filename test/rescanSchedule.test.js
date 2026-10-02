import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoCountFor, badgeText, notificationFor, isDue, latestOf, originsFor, RESCAN_PERIOD_MINUTES, RESCAN_ALARM, SYNC_RETRY_MINUTES, syncRetryAlarm, originOfSyncRetryAlarm } from '../extension/src/rescanSchedule.js';
import { scanWithSearch, siteForSnapshot, performScan, probeTab, UNSUPPORTED_MESSAGE } from '../extension/src/scanRunner.js';
import dealerInspire from '../extension/adapters/dealerInspire.js';
import { fixtures, MY_STORE, fakeDealerPage, fakeChrome } from './helpers.js';
import { withDefaults } from '../extension/src/settings.js';

test('the badge counts only the salesperson\'s own to-dos', () => {
  const diff = { takeDown: [{ yours: true }, { yours: false }], priceUpdates: [{ yours: true }], needsALook: [{ yours: false }], newArrivals: [{}] };
  assert.equal(todoCountFor(diff), 2);
  assert.equal(todoCountFor(null), 0);
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(2), '2');
  assert.equal(badgeText(150), '99');
});

test('a sync retry alarm is named after its website and read back only from its own name', () => {
  const origin = 'https://www.example-motors.test';
  assert.equal(originOfSyncRetryAlarm(syncRetryAlarm(origin)), origin);
  assert.notEqual(syncRetryAlarm(origin), syncRetryAlarm('https://www.example-sister-store.test'), 'one per website');
  assert.notEqual(syncRetryAlarm(origin), RESCAN_ALARM);
  assert.equal(originOfSyncRetryAlarm(RESCAN_ALARM), null, 'the rescan alarm is not a retry');
  assert.equal(originOfSyncRetryAlarm(syncRetryAlarm('')), null, 'no website, no retry');
  assert.equal(originOfSyncRetryAlarm(undefined), null);
  assert.equal(SYNC_RETRY_MINUTES, 1, 'the account server\'s brake counts the last minute');
});

test('a notification only when the count went up', () => {
  assert.equal(notificationFor(0, 0), null);
  assert.deepEqual(notificationFor(0, 2), { title: 'Lot Current', message: '2 of your listings need attention' });
  assert.deepEqual(notificationFor(0, 1), { title: 'Lot Current', message: '1 of your listings needs attention' });
  assert.equal(notificationFor(2, 2), null);
  assert.equal(notificationFor(3, 1), null);
  assert.deepEqual(notificationFor(undefined, 1).message, '1 of your listings needs attention');
});

test('due every 3 hours, with slack for a scan that took a while', () => {
  assert.equal(RESCAN_PERIOD_MINUTES, 180);
  assert.equal(isDue(null), true);
  assert.equal(isDue('2026-09-27T09:00:00Z', '2026-09-27T11:00:00Z'), false);
  assert.equal(isDue('2026-09-27T09:00:00Z', '2026-09-27T11:59:30Z'), true);
  // the alarm fired at 09:00:05 and the scan finished 90 s later; the next alarm at 12:00:05 must still be due
  assert.equal(isDue('2026-09-27T09:01:35Z', '2026-09-27T12:00:05Z'), true);
  assert.equal(isDue('2026-09-27T09:00:00Z', '2026-09-27T11:54:00Z'), false);
  assert.equal(isDue('garbage', '2026-09-27T11:00:00Z'), true);
  // the worker measures from the latest of the last attempt and the last manual scan
  assert.equal(latestOf('2026-09-27T09:00:00Z', '2026-09-27T10:00:00Z'), '2026-09-27T10:00:00Z');
  assert.equal(latestOf(undefined, 'garbage', '2026-09-27T10:00:00Z'), '2026-09-27T10:00:00Z');
  assert.equal(latestOf(null, undefined), null);
});

test('the host permissions a site needs: its own origin plus what its adapter asks for', () => {
  const service = { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/1', apiKey: 'k' };
  // the service worker passes the adapter's own list
  assert.deepEqual(originsFor({ origin: 'https://www.dealer.com' }, dealerInspire.origins(service)), ['https://www.dealer.com/*', 'https://websites-search.api.carscommerce.inc/*']);
  assert.deepEqual(originsFor({ origin: 'http://127.0.0.1:5000' }, ['http://127.0.0.1:5000/*']), ['http://127.0.0.1:5000/*']);
  // the wizard and the popup pass the stored service: the site's adapter is asked, not the service's fields
  assert.deepEqual(originsFor({ origin: 'https://www.dealer.com', adapter: 'dealerInspire' }, service), ['https://www.dealer.com/*', 'https://websites-search.api.carscommerce.inc/*']);
  assert.deepEqual(originsFor({ origin: 'https://www.dealer.com' }, service), ['https://www.dealer.com/*', 'https://websites-search.api.carscommerce.inc/*'], 'an older site record without the adapter id: the adapter that recognises the service');
  assert.deepEqual(originsFor({ origin: 'https://www.dealer.com' }, { unknown: true }), ['https://www.dealer.com/*']);
  assert.deepEqual(originsFor(null, null), []);
  assert.deepEqual(originsFor(null, []), []);
});

const ALL = Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => r);

test('scanWithSearch: records in, snapshot + diff + boilerplate + photo hosts out, and the site kept without service details', async () => {
  const all = ALL.map((r) => ({ ...r, description: `Nice ${r.vin.slice(-4)}.<br>Ron Lewis Real Price includes all costs.` }));
  const search = async (body) => {
    const f = body.filters || {};
    const list = all.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)));
    return { total_vehicle_count: list.length, listings: list.slice((body.page - 1) * body.perPage, body.page * body.perPage) };
  };
  const site = { origin: 'https://x', host: 'x', name: 'Test', title: 't', address: { zip: '15370' }, adapter: 'dealerInspire', service: { search: 's', apiKey: 'k' } };
  const first = await scanWithSearch({ adapter: dealerInspire, search, site, settings: withDefaults(MY_STORE), prevSnapshot: null, posted: {} });
  assert.equal(first.ok, true);
  assert.equal(Object.keys(first.snapshot.vehicles).length, 6);
  assert.equal(first.diff.firstScan, true);
  assert.deepEqual(first.boilerplate, ['Ron Lewis Real Price includes all costs.']);
  assert.deepEqual(first.photoOrigins, ['https://vehicle-images.carscommerce.inc'], 'where the photos live, from the records');
  assert.deepEqual(siteForSnapshot(site), { origin: 'https://x', host: 'x', name: 'Test', title: 't', address: { zip: '15370' }, adapter: 'dealerInspire' });
  assert.equal(first.snapshot.site.service, undefined);

  // the Ram sells: a posted car is flagged for take-down on the next scan
  const sold = all.filter((r) => r.vin !== fixtures.usedNormal.vin);
  const search2 = async (body) => {
    const f = body.filters || {};
    const list = sold.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)));
    return { total_vehicle_count: list.length, listings: list.slice(0, body.perPage) };
  };
  const posted = { [fixtures.usedNormal.vin]: { name: 'Ram', price: 27163, postedAt: 'x' } };
  const second = await scanWithSearch({ adapter: dealerInspire, search: search2, site, settings: withDefaults(MY_STORE), prevSnapshot: first.snapshot, posted });
  assert.equal(second.diff.takeDown.length, 1);
  assert.equal(second.diff.takeDown[0].yours, true);
  assert.equal(todoCountFor(second.diff), 1);
});

test('scanWithSearch passes the adapter\'s scan options through, with the confirm list added', async () => {
  const calls = [];
  const search = async (body) => { calls.push(body); return { total_vehicle_count: 0, listings: [] }; };
  const site = { origin: 'https://x', host: 'x', name: 'Test', title: 't', adapter: 'dealerInspire' };
  const out = await scanWithSearch({ adapter: dealerInspire, search, site, settings: withDefaults(MY_STORE), prevSnapshot: null, posted: { ABC: {} }, options: dealerInspire.scanOptions({ visibleStatusValues: ['publish'] }) });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0].filters.status, ['publish']);
  assert.deepEqual(calls[calls.length - 1].filters.vin, ['ABC']);
  assert.deepEqual(out.photoOrigins, []);
});

// The closest a unit test gets to the mock dealer site (test/e2e/mock-dealer-site.mjs):
// the same page globals, with chrome.scripting.executeScript running each
// injected function in a bare sandbox.
test('performScan on a Dealer Inspire look-alike: neutral probe, the adapter\'s probe, the search through the tab, the site remembered with its service and photo hosts', async () => {
  const origin = 'https://example-dealer.test';
  const page = fakeDealerPage({ records: ALL, origin, name: 'Example Motors' });
  const chrome = fakeChrome(page);
  globalThis.chrome = chrome;
  try {
    const probe = await probeTab(3);
    assert.deepEqual(Object.keys(probe), ['site', 'service', 'adapterId']);
    assert.equal(probe.adapterId, 'dealerInspire');
    assert.deepEqual(probe.site.address, { street: '1 Example Way', city: 'Springfield', state: 'OH', zip: '43215', phone: '(555) 555-0100', source: 'structured data' });
    assert.equal(probe.service.search, origin + '/api/v1/listings/1');

    const r = await performScan({ tabId: 3, origin });
    assert.equal(r.ok, true);
    assert.equal(r.adapterId, 'dealerInspire');
    assert.equal(r.site.name, 'Example Motors');
    assert.equal(r.site.host, 'example-dealer.test');
    assert.equal(r.site.adapter, 'dealerInspire');
    assert.equal(r.vehicles.length, 6, 'the used and certified cars');
    assert.equal(r.res.complete, true);
    assert.deepEqual(r.photoOrigins, ['https://vehicle-images.carscommerce.inc']);
    assert.ok(r.settings && Array.isArray(r.settings.myStores));
    const entry = chrome.store.sites[origin];
    assert.equal(entry.adapter, 'dealerInspire');
    assert.deepEqual(entry.service, { search: origin + '/api/v1/listings/1', apiKey: 'test-key', visibleStatusValues: ['publish', 'modified', 'pend-sale'], hasHelper: true }, 'the service is stored as the probe returned it');
    assert.deepEqual(entry.photoOrigins, ['https://vehicle-images.carscommerce.inc'], 'recorded, not requested');
    assert.equal(entry.site.service, undefined);
    assert.equal(entry.lastError, null);
    // the wizard and the popup ask for the permission set with the stored service
    assert.deepEqual(originsFor(entry.site, entry.service), [origin + '/*']);

    // a page with no inventory service any adapter knows
    globalThis.chrome = fakeChrome(fakeDealerPage({ withService: false, origin }));
    const no = await performScan({ tabId: 3, origin });
    assert.equal(no.ok, false);
    assert.equal(no.message, UNSUPPORTED_MESSAGE);
    assert.match(no.message, /Checked on a real dealership website: Dealer Inspire\. Also tries, not yet checked on a real dealership website: DealerOn; Dealer\.com; Standard vehicle data \(schema\.org\)\./);
    assert.ok(!/Dealer Inspire's search service/.test(no.message));
  } finally {
    delete globalThis.chrome;
  }
});
