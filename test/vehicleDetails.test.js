import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recheck } from '../extension/src/vehicleDetails.js';
import { vehicle, MY_STORE } from './helpers.js';

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
