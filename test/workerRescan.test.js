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

const { runRescan, updateBadge } = await import('../extension/background.js');
const schemaOrg = (await import('../extension/adapters/schemaOrg.js')).default;
const { scanWithSearch } = await import('../extension/src/scanRunner.js');
const { withDefaults } = await import('../extension/src/settings.js');
const { markTakenDown, markPriceUpdated } = await import('../extension/src/rescan.js');
const { recordFlags, updatePilot, resolveFlag } = await import('../extension/src/pilot.js');
const { updateKey, clearWebsiteRecords } = await import('../extension/src/storage.js');
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

test('a rescan that reads most of the lot gone holds the read back with the diff, counts agreeing reads on, and never saves it as the snapshot', async () => {
  for (const key of Object.keys(store)) delete store[key];
  const cars = standardCars(12);
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const full = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options });
  assert.equal(Object.keys(full.snapshot.vehicles).length, 12);
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: full.snapshot, [k.posted]: {}, [k.boilerplate]: full.boilerplate,
  });
  // the website now lists 4 of the 12
  const short = standardSite({ cars: cars.slice(0, 4) });
  for (const c of cars.slice(4)) short.set(O + c.path, httpError(404));
  const search = fakeSiteSearch(short);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  try {
    assert.equal((await runRescan(O, { reason: 'alarm' })).ok, true);
    const first = store[k.diff];
    assert.equal(first.unreliable, true);
    assert.deepEqual([first.withheld.scans, first.withheld.cars, first.withheld.saved], [1, 4, 12]);
    assert.equal(Object.keys(store[k.snapshot].vehicles).length, 12, 'the saved list stays');
    assert.equal((await runRescan(O, { reason: 'alarm' })).ok, true);
    const second = store[k.diff];
    assert.deepEqual([second.withheld.scans, second.withheld.since], [2, first.withheld.since], 'the second agreeing read counts on from the first');
    assert.equal(Object.keys(second.withheld.snapshot.vehicles).length, 4);
    assert.equal(Object.keys(store[k.snapshot].vehicles).length, 12, 'no rescan replaces the saved list; only the salesperson\'s click in To do does');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A listing with no price basis (brought by a sync) gets the one the
// rescan reads (src/scanRunner.js keepSeenBasis), from the last saved scan
// (the one this rescan replaces), then this one; a scan taken before the
// listing was posted is not read (src/rescan.js scanCar).
test('a rescan records the price basis the last saved scan shows for a listing with none, unless that scan was taken before the listing was posted', async () => {
  for (const key of Object.keys(store)) delete store[key];
  const [kept, cut, other] = standardCars(3);
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars: [kept, cut, other] })), site, settings, options });
  // the last saved scan, taken on Jan 2nd, showed a second price $500 below each car's main price
  const last = structuredClone(day1.snapshot);
  last.takenAt = '2020-01-02T12:00:00.000Z';
  last.startedAt = last.takenAt;
  for (const car of [kept, cut]) last.vehicles[car.vin].priceBeforeFees = car.price - 500;
  const posted = {
    // posted at the main price before that scan
    [kept.vin]: { name: 'Kept car', price: kept.price, postedAt: '2020-01-01T12:00:00.000Z' },
    // the website then cut $500, and the car was posted on another computer at the new main price after that scan
    [cut.vin]: { name: 'Cut car', price: cut.price - 500, postedAt: '2020-01-03T12:00:00.000Z' },
  };
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: last, [k.posted]: posted, [k.diff]: day1.diff, [k.boilerplate]: day1.boilerplate,
  });
  const search = fakeSiteSearch(standardSite({ cars: [kept, { ...cut, price: cut.price - 500 }, other] }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  try {
    const r = await runRescan(O, { reason: 'alarm' });
    assert.equal(r.ok, true, r.error);
    assert.equal(store[k.posted][kept.vin].basis, 'website', 'read off the last saved scan: the main price');
    assert.equal(store[k.posted][cut.vin].basis, undefined, 'that scan predates the post, and this one shows one price only: nothing to record');
    assert.deepEqual(store[k.diff].priceUpdates.filter((u) => u.yours), [], 'both listings match the website');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A rescan held back as a website hiccup records no price basis at all: the
// basis goes up with the next sync and becomes every computer's, so none is
// taken off a read the extension does not trust. The saved list stays, so
// the next trusted rescan reads it from the same last scan.
test('a rescan held back as a website hiccup records no price basis, even one the last saved scan shows', async () => {
  for (const key of Object.keys(store)) delete store[key];
  const cars = standardCars(12);
  const [car] = cars;
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const full = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options });
  // the last saved scan, taken after the post, showed a second price $500 below the car's main price
  const last = structuredClone(full.snapshot);
  last.takenAt = '2020-01-02T12:00:00.000Z';
  last.startedAt = last.takenAt;
  last.vehicles[car.vin].priceBeforeFees = car.price - 500;
  const posted = { [car.vin]: { name: 'Posted car', price: car.price - 500, postedAt: '2020-01-01T12:00:00.000Z' } }; // synced with no basis
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: last, [k.posted]: posted, [k.boilerplate]: full.boilerplate,
  });
  // the website now lists 4 of the 12: held back
  const short = standardSite({ cars: cars.slice(0, 4) });
  for (const c of cars.slice(4)) short.set(O + c.path, httpError(404));
  const search = fakeSiteSearch(short);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  try {
    assert.equal((await runRescan(O, { reason: 'alarm' })).ok, true);
    assert.equal(store[k.diff].unreliable, true);
    assert.equal(store[k.posted][car.vin].basis, undefined, 'nothing recorded from a held-back rescan');
    assert.equal(store[k.snapshot].takenAt, last.takenAt, 'the last saved scan stays, for the next trusted rescan to read');
    // the website lists the whole lot again: that trusted rescan records the basis the last saved scan shows
    globalThis.fetch = async (url) => {
      const got = await fakeSiteSearch(standardSite({ cars }))({ url });
      return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
    };
    assert.equal((await runRescan(O, { reason: 'alarm' })).ok, true);
    assert.equal(store[k.diff].unreliable, false);
    assert.equal(store[k.posted][car.vin].basis, 'beforeFees');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a to-do notice the system refused to show is made again by the next scan, and a notice shown is not repeated', async () => {
  for (const key of Object.keys(store)) delete store[key];
  const cars = standardCars(6);
  const [sold] = cars;
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options });
  // the website sells the posted car: its page is gone and it is no longer listed
  const today = standardSite({ cars: cars.slice(1) });
  today.set(O + sold.path, httpError(404));
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: day1.snapshot, [k.posted]: { [sold.vin]: { name: 'Sold car', price: sold.price, postedAt: '2020-01-01T12:00:00.000Z' } }, [k.diff]: day1.diff, [k.boilerplate]: day1.boilerplate,
  });
  const search = fakeSiteSearch(today);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  const realCreate = globalThis.chrome.notifications.create;
  const shown = [];
  let refuse = true;
  globalThis.chrome.notifications.create = async (id, opts) => {
    shown.push(opts.message);
    if (refuse) throw new Error('notifications are blocked');
  };
  try {
    const first = await runRescan(O, { reason: 'alarm' });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.count, 1, 'one to-do item for this computer');
    assert.equal(shown.length, 1, 'the notice was attempted');
    assert.equal(store[SITES_KEY][O].lastNotifiedCount, 0, 'a notice the system refused is not recorded as sent');
    refuse = false;
    await runRescan(O, { reason: 'alarm' });
    assert.equal(shown.length, 2, 'the next scan makes the same notice');
    assert.equal(store[SITES_KEY][O].lastNotifiedCount, 1, 'a notice shown is recorded');
    await runRescan(O, { reason: 'alarm' });
    assert.equal(shown.length, 2, 'a notice shown is not repeated while the count stays the same');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.chrome.notifications.create = realCreate;
  }
});

test('a to-do notice is made for a new sold car after the items were cleared between scans', async () => {
  for (const key of Object.keys(store)) delete store[key];
  const cars = standardCars(6);
  const [a, b, c, d] = cars;
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options });
  const posted = (list) => Object.fromEntries(list.map((car) => [car.vin, { name: 'Posted car', price: car.price, postedAt: '2020-01-01T12:00:00.000Z' }]));
  // a website with the given cars listed, and the given ones sold (their pages are gone)
  const website = (listed, sold = []) => {
    const s = standardSite({ cars: listed });
    for (const car of sold) s.set(O + car.path, httpError(404));
    return s;
  };
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: day1.snapshot, [k.posted]: posted([a, b, c, d]), [k.diff]: day1.diff, [k.boilerplate]: day1.boilerplate,
  });
  let search = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  const realCreate = globalThis.chrome.notifications.create;
  const shown = [];
  globalThis.chrome.notifications.create = async (id, opts) => { shown.push(opts.message); };
  try {
    // the website sells the first two posted cars: two to-do items, one notice
    search = fakeSiteSearch(website(cars.slice(2), [a, b]));
    const first = await runRescan(O, { reason: 'alarm' });
    assert.equal(first.count, 2, first.error);
    assert.equal(shown.length, 1);
    // the salesperson handles both: the to-do items are cleared and the two cars leave the posted list
    store[k.diff] = { ...store[k.diff], takeDown: [], priceUpdates: [], needsALook: [] };
    store[k.posted] = posted([c, d]);
    await updateBadge();
    assert.equal(badge, '', 'the badge shows no to-do items');
    assert.equal(store[SITES_KEY][O].lastNotifiedCount, 0, 'the items handled lower the count the website was told about');
    // then a posted car sells: the next scan announces it
    search = fakeSiteSearch(website(cars.slice(3), [c]));
    const second = await runRescan(O, { reason: 'alarm' });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.count, 1);
    assert.equal(shown.length, 2, 'the new sold car is announced');
    assert.match(shown[1], /^1 of your listings needs attention/);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.chrome.notifications.create = realCreate;
  }
});

// Clear everything for this website (the popup) while a rescan is still
// reading: the rescan must not write the website's records back, nor register
// the website for rescans again (review U3).
const clearWhileReading = async () => clearWebsiteRecords(O, {
  sitesKey: SITES_KEY,
  diffKey: k.diff,
  recordKeys: Object.values(k),
  storage: local,
  remove: async (keys) => { for (const key of keys) delete store[key]; },
});

async function registeredWebsite() {
  for (const key of Object.keys(store)) delete store[key];
  const cars = standardCars(6);
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options: schemaOrg.scanOptions(SERVICE) });
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: day1.snapshot, [k.posted]: {}, [k.boilerplate]: day1.boilerplate,
  });
  // the website has sold one car since, so the rescan has a to-do item to save
  return standardSite({ cars: cars.slice(1) });
}

test('a rescan still reading when the website is cleared writes nothing back and does not register the website again', async () => {
  const today = await registeredWebsite();
  const search = fakeSiteSearch(today);
  let cleared = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!cleared) { cleared = true; await clearWhileReading(); }
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  try {
    const r = await runRescan(O, { reason: 'alarm' });
    assert.equal(r.ok, false, 'the read is not saved');
    assert.match(r.error, /cleared/);
    assert.equal(store[SITES_KEY][O], undefined, 'the website is not registered again');
    for (const key of Object.values(k)) assert.equal(store[key], undefined, `${key} is not written back`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a rescan that fails after the website is cleared does not register it again', async () => {
  await registeredWebsite();
  let cleared = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!cleared) { cleared = true; await clearWhileReading(); }
    return { ok: false, status: 503, url, redirected: false, headers: { get: () => null }, text: async () => '' };
  };
  try {
    const r = await runRescan(O, { reason: 'alarm' });
    assert.equal(r.ok, false);
    assert.equal((store[SITES_KEY] || {})[O], undefined, 'the failure note does not register the website again');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a to-do item found by a rescan from the side panel is not recorded as notified, so the next automatic rescan still tells the person', async () => {
  for (const key of Object.keys(store)) delete store[key];
  const cars = standardCars(6);
  const [sold] = cars;
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars })), site, settings, options });
  const today = standardSite({ cars: cars.slice(1) });
  today.set(O + sold.path, httpError(404));
  Object.assign(store, {
    [SITES_KEY]: { [O]: { name: 'Sample Motors', adapter: 'schemaOrg', service: SERVICE, site, auto: true } },
    [k.settings]: settings, [k.snapshot]: day1.snapshot, [k.posted]: { [sold.vin]: { name: 'Sold car', price: sold.price, postedAt: '2020-01-01T12:00:00.000Z' } }, [k.diff]: day1.diff, [k.boilerplate]: day1.boilerplate,
  });
  const search = fakeSiteSearch(today);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const got = await search({ url });
    return { ok: got.ok, status: got.status, url, redirected: false, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
  };
  const realCreate = globalThis.chrome.notifications.create;
  const shown = [];
  globalThis.chrome.notifications.create = async (id, opts) => { shown.push(opts.message); };
  try {
    // the person clicks Rescan in the side panel: the count goes to 1, and no notice is due from that rescan
    const panel = await runRescan(O, { reason: 'panel' });
    assert.equal(panel.ok, true, panel.error);
    assert.equal(panel.count, 1);
    assert.equal(shown.length, 0, 'the side panel rescan sends no notice');
    assert.equal(store[SITES_KEY][O].lastNotifiedCount, 0, 'so the count is not recorded as notified');
    // the automatic rescan a few hours later finds the same item and tells the person
    const alarm = await runRescan(O, { reason: 'alarm' });
    assert.equal(alarm.ok, true, alarm.error);
    assert.equal(shown.length, 1, 'the automatic rescan makes the notice');
    assert.equal(store[SITES_KEY][O].lastNotifiedCount, 1);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.chrome.notifications.create = realCreate;
  }
});
