import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoCountFor, badgeText, notificationFor, isDue, latestOf, originsFor, RESCAN_PERIOD_MINUTES } from '../extension/src/rescanSchedule.js';
import { scanWithSearch, siteForSnapshot } from '../extension/src/scanRunner.js';
import dealerInspire from '../extension/adapters/dealerInspire.js';
import { fixtures, MY_STORE } from './helpers.js';
import { withDefaults } from '../extension/src/settings.js';

test('the badge counts only the salesperson\'s own to-dos', () => {
  const diff = { takeDown: [{ yours: true }, { yours: false }], priceUpdates: [{ yours: true }], needsALook: [{ yours: false }], newArrivals: [{}] };
  assert.equal(todoCountFor(diff), 2);
  assert.equal(todoCountFor(null), 0);
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(2), '2');
  assert.equal(badgeText(150), '99');
});

test('a notification only when the count went up', () => {
  assert.equal(notificationFor(0, 0), null);
  assert.deepEqual(notificationFor(0, 2), { title: 'Lot Sync', message: '2 of your listings need attention' });
  assert.deepEqual(notificationFor(0, 1), { title: 'Lot Sync', message: '1 of your listings needs attention' });
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

test('the host permissions a site needs: its own origin and its service', () => {
  assert.deepEqual(originsFor({ origin: 'https://www.dealer.com' }, { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/1' }), ['https://www.dealer.com/*', 'https://websites-search.api.carscommerce.inc/*']);
  assert.deepEqual(originsFor({ origin: 'http://127.0.0.1:5000' }, { search: 'http://127.0.0.1:5000/api/v1/listings/1' }), ['http://127.0.0.1:5000/*']);
  assert.deepEqual(originsFor(null, null), []);
});

test('scanWithSearch: records in, snapshot + diff + boilerplate out, and the site kept without service details', async () => {
  const all = Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => ({ ...r, description: `Nice ${r.vin.slice(-4)}.<br>Ron Lewis Real Price includes all costs.` }));
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
