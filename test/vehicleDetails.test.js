import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recheck, fetchVehicleDetails } from '../extension/src/vehicleDetails.js';
import { vehicle, fixtures, MY_STORE, fakeDealerPage, fakeChrome } from './helpers.js';

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
