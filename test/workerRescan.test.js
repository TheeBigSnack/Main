// The service worker's rescan (background.js runRescan), run under Node with
// a fake chrome.storage and the standard-data test website: a rescan can run
// for a while, and a to-do item the salesperson ticks off while it runs
// (Taken down, Updated, as the popup and the side panel record them) must
// stay handled when the rescan saves its diff and records the pilot flags.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardCars, standardSite, fakeSiteSearch, httpError, STANDARD_ORIGIN as O } from './helpers.js';

// chrome.storage answers a tick later, as in the browser, and hands out copies.
const store = {};
const copy = (x) => (x === undefined ? x : structuredClone(x));
const later = (fn) => new Promise((resolve) => setTimeout(() => resolve(fn()), 0));
const local = {
  get: (keys) => later(() => Object.fromEntries([].concat(keys).filter((key) => key in store).map((key) => [key, copy(store[key])]))),
  set: (obj) => later(() => { for (const [key, value] of Object.entries(obj)) store[key] = copy(value); }),
};
let badge = null;
const listeners = { addListener() {} };
globalThis.chrome = {
  alarms: { onAlarm: listeners },
  runtime: { onMessage: listeners, onInstalled: listeners, onStartup: listeners },
  storage: { local },
  permissions: { contains: async () => true },
  action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async ({ text }) => { badge = text; } },
  notifications: { create: async () => {} },
};

const { runRescan } = await import('../extension/background.js');
const schemaOrg = (await import('../extension/adapters/schemaOrg.js')).default;
const { scanWithSearch } = await import('../extension/src/scanRunner.js');
const { withDefaults } = await import('../extension/src/settings.js');
const { markTakenDown, markPriceUpdated } = await import('../extension/src/rescan.js');
const { recordFlags, updatePilot, resolveFlag } = await import('../extension/src/pilot.js');
const { updateKey } = await import('../extension/src/storage.js');
const { siteKeys, SITES_KEY } = await import('../extension/src/storageKeys.js');

const LIST = O + '/used-vehicles/';
const SERVICE = { kind: 'schemaOrg', origin: O, listUrl: LIST };
const k = siteKeys(O);

test('a rescan keeps the to-do items the salesperson ticked off while it ran, and opens no pilot flag for them', async () => {
  const cars = standardCars(6);
  const [sold, cut] = cars;
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options });
  const posted = {
    [sold.vin]: { name: 'Sold car', price: sold.price, postedAt: '2026-09-29T12:00:00.000Z' },
    [cut.vin]: { name: 'Re-priced car', price: cut.price, postedAt: '2026-09-29T12:00:00.000Z' },
  };
  // the website sells one posted car and drops the other's price
  const today = standardSite({ cars: [{ ...cut, price: cut.price - 500 }, ...cars.slice(2)] });
  today.set(O + sold.path, httpError(404));
  const day2 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(today), site, settings, prevSnapshot: day1.snapshot, posted, options });
  assert.deepEqual(day2.diff.takeDown.map((t) => [t.vin, t.yours]), [[sold.vin, true]]);
  assert.deepEqual(day2.diff.priceUpdates.map((u) => [u.vin, u.to, u.yours]), [[cut.vin, cut.price - 500, true]]);
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: day2.snapshot, [k.posted]: posted, [k.diff]: day2.diff, [k.boilerplate]: day2.boilerplate,
  });
  await recordFlags(O, day2.diff, day2.diff.takenAt); // the flags that rescan opened

  // The next rescan reads the website again; while it is reading, the
  // salesperson clicks Taken down on the sold car and Updated on the other,
  // the way the popup records them.
  const search = fakeSiteSearch(today);
  const ticked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === O + sold.path && !ticked.includes('sold')) {
      ticked.push('sold');
      await updateKey(k.posted, (p) => markTakenDown(p || {}, sold.vin));
      await updateKey(k.diff, (d) => ({ ...d, takeDown: d.takeDown.filter((t) => t.vin !== sold.vin), priceUpdates: d.priceUpdates.filter((u) => u.vin !== sold.vin), needsALook: d.needsALook.filter((n) => n.vin !== sold.vin) }));
      await updatePilot(O, (p) => resolveFlag(p, sold.vin, null, { how: 'manual' }));
    }
    if (url === O + cut.path && !ticked.includes('cut')) {
      ticked.push('cut');
      await updateKey(k.posted, (p) => markPriceUpdated(p || {}, cut.vin, cut.price - 500));
      await updateKey(k.diff, (d) => ({ ...d, priceUpdates: d.priceUpdates.filter((u) => u.vin !== cut.vin) }));
      await updatePilot(O, (p) => resolveFlag(p, cut.vin, 'price', { how: 'manual' }));
    }
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  try {
    const r = await runRescan(O, { reason: 'alarm' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(ticked.sort(), ['cut', 'sold'], 'both were ticked off while the rescan ran');
    const diff = store[k.diff];
    assert.deepEqual(diff.takeDown.filter((t) => t.yours), [], 'the car taken down does not come back to To do');
    assert.deepEqual(diff.priceUpdates.filter((u) => u.yours), [], 'nor does the price already updated');
    assert.equal(r.count, 0);
    assert.equal(badge, '', 'the badge shows nothing to do');
    const flags = store[k.pilot].flags;
    assert.deepEqual(flags.map((f) => [f.vin, f.kind, f.how]).sort(), [[cut.vin, 'price', 'manual'], [sold.vin, 'takeDown', 'manual']].sort(), 'one flag per item, each closed by the salesperson; none opened again');
    // the website's own state is saved as read: the sold car is gone from the snapshot
    assert.equal(store[k.snapshot].vehicles[sold.vin], undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
