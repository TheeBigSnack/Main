// The pilot lists (post attempts and to-do flags, extension/src/pilot.js)
// going up through the extension's own syncOnce (extension/src/accountFlow.js)
// to the real sync handler (supabase/functions/sync/index.ts): what the
// manager view reads from post_attempts and todo_items must follow what the
// salesperson's machine holds, whatever that machine's clock says and
// whenever a post lands while a sync is out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, fake, hermetic, functionsFetch, uuid, SUPABASE_URL, ANON_KEY } from './functions/harness.mjs';
import { syncOnce } from '../extension/src/accountFlow.js';
import { sessionFromTokenResponse, storeSession } from '../extension/src/account.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { noteFlags, beginPost, endPost, resolveFlag } from '../extension/src/pilot.js';
import { markPriceUpdated, markTakenDown } from '../extension/src/rescan.js';
import { summarize } from '../manager/data.js';

hermetic();

const ORIGIN = 'https://www.example-motors.test';
const K = siteKeys(ORIGIN);
const D1 = uuid(1);
const U1 = uuid(11);
const TOKEN = 'token-of-u1';
const USER = { id: U1, email: 'sam@example-motors.test' };
const VIN = (n) => `TESTVIN0000000${String(n).padStart(3, '0')}`;
const config = { url: SUPABASE_URL, anonKey: ANON_KEY, functionsUrl: '' };
const ago = (minutes) => new Date(Date.now() - minutes * 60e3).toISOString();

// `skewMs`: how far this machine's clock runs behind the server's.
// `beforeFetch`: runs while the sync request is out, after storage was read.
async function setUp({ skewMs = 0, beforeFetch = null } = {}) {
  fake.reset({
    users: { [TOKEN]: USER },
    rows: {
      dealerships: [{ id: D1, name: 'Example Motors', website_origin: ORIGIN }],
      memberships: [{ user_id: U1, dealership_id: D1, role: 'salesperson', name: 'Sam' }],
    },
  });
  const handler = functionsFetch({ sync: await loadFunction('sync') });
  const fetchImpl = async (...args) => {
    if (beforeFetch) await beforeFetch();
    return handler(...args);
  };
  const data = {};
  const storage = {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
  assert.equal(await storeSession(sessionFromTokenResponse({ access_token: TOKEN, expires_in: 3600, refresh_token: 'refresh', user: USER }, Date.now()), storage), true);
  const sync = async () => {
    const r = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage, now: Date.now() - skewMs } });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  const clock = () => Date.now() - skewMs;
  const iso = (t) => new Date(t).toISOString();
  // one post, as the side panel records it: the attempt, then the registry entry
  const post = (vin, { queue = false, seconds = 8 } = {}) => {
    const end = clock();
    let p = beginPost(storage.data[K.pilot], { vin, name: 'Car', queue, at: iso(end - seconds * 1000) });
    p = endPost(p, vin, 'posted', { at: iso(end) });
    storage.data[K.pilot] = p;
    storage.data[K.posted] = { ...(storage.data[K.posted] || {}), [vin]: { name: 'Car', price: 20000, postedAt: iso(end) } };
  };
  return { storage, sync, clock, iso, post };
}

const priceDiff = (vin, from, to, takenAt) => ({ takenAt, takeDown: [], priceUpdates: [{ vin, name: 'My car', yours: true, from, to }], warnings: [], unreliable: false });

test('an open price item whose website price moves again follows it on the server, however long ago it was flagged', async () => {
  const { storage, sync } = await setUp();
  storage.data[K.posted] = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: ago(3 * 24 * 60) } };
  storage.data[K.pilot] = noteFlags(null, priceDiff(VIN(1), 20000, 19000, ago(60)));
  await sync();
  const item = () => fake.rows('todo_items').filter((t) => t.vin === VIN(1));
  assert.deepEqual(item().map((t) => [t.from_price, t.to_price, t.done_at]), [[20000, 19000, null]]);

  // the website drops again before the listing is updated: the open item keeps its stamp and takes the new price
  storage.data[K.pilot] = noteFlags(storage.data[K.pilot], priceDiff(VIN(1), 20000, 18000, ago(0)));
  assert.equal(storage.data[K.pilot].flags.length, 1, 'still one open item');
  assert.equal(storage.data[K.pilot].flags[0].to, 18000);
  await sync();
  assert.deepEqual(item().map((t) => [t.from_price, t.to_price, t.done_at]), [[20000, 18000, null]], 'the manager view shows the price on the website now');

  // sent again unchanged, it changes nothing and adds no second item
  const r = await sync();
  assert.equal(r.counts.todoItems, 0);
  assert.equal(item().length, 1);
});

// Each check runs at two clock offsets. The tests are written out one per
// line, not made in a loop, so README's count of call sites (test/docs.test.js)
// is the count npm test prints.
async function queueAttemptsReachServer(skewMs) {
  const { sync, post } = await setUp({ skewMs });
  for (let n = 1; n <= 4; n++) {
    post(VIN(n), { queue: true });
    await sync();
  }
  assert.equal(fake.rows('listings').length, 4);
  assert.deepEqual(fake.rows('post_attempts').map((a) => a.vin).sort(), [VIN(1), VIN(2), VIN(3), VIN(4)], 'every attempt, for the manager view\'s median seconds per post');
}

async function tickedItemAndNextPostReachServer(skewMs) {
  const { storage, sync, clock, iso, post } = await setUp({ skewMs });
  storage.data[K.posted] = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: iso(clock() - 3 * 24 * 3600e3) } };
  storage.data[K.pilot] = noteFlags(null, priceDiff(VIN(1), 20000, 19000, iso(clock())));
  await sync();
  const item = () => fake.rows('todo_items').find((t) => t.vin === VIN(1));
  assert.equal(item().done_at, null);
  // the listing is updated and the item ticked off, then another car is posted
  storage.data[K.pilot] = resolveFlag(storage.data[K.pilot], VIN(1), 'price', { at: iso(clock()), how: 'manual' });
  post(VIN(2));
  await sync();
  assert.ok(item().done_at, 'the item is closed on the server, so the manager view no longer lists it');
  assert.equal(item().how, 'manual');
  assert.deepEqual(fake.rows('post_attempts').map((a) => a.vin), [VIN(2)]);
}

test('a machine whose clock runs 30 seconds slow gets every queue post attempt to the server, one sync after each post', () => queueAttemptsReachServer(30e3));
test('a machine whose clock runs 15 minutes slow gets every queue post attempt to the server, one sync after each post', () => queueAttemptsReachServer(15 * 60e3));
test('a machine whose clock runs 30 seconds slow gets a ticked-off to-do item and the next post to the server', () => tickedItemAndNextPostReachServer(30e3));
test('a machine whose clock runs 15 minutes slow gets a ticked-off to-do item and the next post to the server', () => tickedItemAndNextPostReachServer(15 * 60e3));

test('a post confirmed while a sync is out goes up with the next sync', async () => {
  let during = null;
  const { sync, post } = await setUp({ beforeFetch: async () => during && during() });
  post(VIN(1));
  during = () => {
    during = null;
    post(VIN(2)); // confirmed after this sync read storage, before the function answered
  };
  await sync();
  assert.deepEqual(fake.rows('post_attempts').map((a) => a.vin), [VIN(1)]);
  await sync();
  assert.deepEqual(fake.rows('post_attempts').map((a) => a.vin).sort(), [VIN(1), VIN(2)]);
});

test('one salesperson\'s two machines that both flag a price change leave one to-do item, closed when it is fixed on either', async () => {
  const { storage: desktop, sync: syncDesktop } = await setUp();
  // the laptop: the same account, its own storage, the same server
  const handler = functionsFetch({ sync: await loadFunction('sync') });
  const laptop = { data: {} };
  Object.assign(laptop, {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in laptop.data).map((k) => [k, structuredClone(laptop.data[k])]));
    },
    async set(obj) {
      Object.assign(laptop.data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete laptop.data[k];
    },
  });
  assert.equal(await storeSession(sessionFromTokenResponse({ access_token: TOKEN, expires_in: 3600, refresh_token: 'refresh', user: USER }, Date.now()), laptop), true);
  const syncLaptop = async () => {
    const r = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl: handler, storage: laptop, now: Date.now() } });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  const posted = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: ago(3 * 24 * 60) } };
  desktop.data[K.posted] = structuredClone(posted);
  laptop.data[K.posted] = structuredClone(posted);
  await syncDesktop();
  await syncLaptop();

  // each machine's scheduled rescan sees the website price drop, at its own time
  desktop.data[K.pilot] = noteFlags(null, priceDiff(VIN(1), 20000, 19000, ago(30)));
  laptop.data[K.pilot] = noteFlags(null, priceDiff(VIN(1), 20000, 19000, ago(10)));
  await syncDesktop();
  await syncLaptop();
  const items = () => fake.rows('todo_items').filter((t) => t.vin === VIN(1));
  assert.equal(items().length, 1, 'one item for the manager view, not one per machine');
  assert.equal(items()[0].done_at, null);
  assert.equal(laptop.data[K.pilot].flags[0].flaggedAt, desktop.data[K.pilot].flags[0].flaggedAt, 'both machines carry the item under the first sighting');

  // the salesperson updates the listing and ticks it off on the desktop
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(1), 'price', { at: ago(0), how: 'manual' });
  await syncDesktop();
  assert.deepEqual(items().map((t) => [Boolean(t.done_at), t.how]), [[true, 'manual']], 'nothing left open for the manager view');
  // the laptop's next sync closes its flag the same way, and adds no row
  await syncLaptop();
  assert.deepEqual([Boolean(laptop.data[K.pilot].flags[0].doneAt), laptop.data[K.pilot].flags[0].how], [true, 'manual']);
  await syncLaptop();
  assert.equal(items().length, 1);
});

// One of the salesperson's machines (the desktop, the laptop): its own
// storage, the same account and server. `sync(minutesAgo)` runs with the
// machine's clock at that moment, so each step happens in its order: a flag
// ticked off after a sync goes up with the next one.
async function machine() {
  const handler = functionsFetch({ sync: await loadFunction('sync') });
  const storage = { data: {} };
  Object.assign(storage, {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in storage.data).map((k) => [k, structuredClone(storage.data[k])]));
    },
    async set(obj) {
      Object.assign(storage.data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete storage.data[k];
    },
  });
  assert.equal(await storeSession(sessionFromTokenResponse({ access_token: TOKEN, expires_in: 3600, refresh_token: 'refresh', user: USER }, Date.now()), storage), true);
  const sync = async (minutesAgo = 0) => {
    const r = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl: handler, storage, now: Date.now() - minutesAgo * 60e3 } });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  return { storage, sync };
}

const rescan = ({ takenAt, sold = [], prices = [] }) => ({
  takenAt,
  takeDown: sold.map((vin) => ({ vin, name: 'Sold car', yours: true, why: 'gone' })),
  priceUpdates: prices.map(([vin, from, to]) => ({ vin, name: 'My car', yours: true, from, to })),
  warnings: [],
  unreliable: false,
});

// The desktop and the laptop both hold car 1 (20000) and car 2. The laptop
// is shut while the desktop's rescan flags car 1's price drop and car 2's
// sale, and the salesperson updates and takes them down there.
async function fixedWhileTheLaptopWasShut() {
  await setUp(); // the dealership and the account
  const { storage: desktop, sync: syncDesktop } = await machine();
  const { storage: laptop, sync: syncLaptop } = await machine();
  const posted = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: ago(3 * 24 * 60) }, [VIN(2)]: { name: 'Sold car', price: 30000, postedAt: ago(3 * 24 * 60) } };
  desktop.data[K.posted] = structuredClone(posted);
  laptop.data[K.posted] = structuredClone(posted);
  await syncDesktop(900);
  await syncLaptop(900);
  desktop.data[K.pilot] = noteFlags(null, rescan({ takenAt: ago(800), sold: [VIN(2)], prices: [[VIN(1), 20000, 19000]] }));
  await syncDesktop(799);
  desktop.data[K.posted] = markTakenDown(markPriceUpdated(desktop.data[K.posted], VIN(1), 19000, ago(740)), VIN(2));
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(1), null, { at: ago(740), how: 'manual' });
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(2), null, { at: ago(740), how: 'manual' });
  await syncDesktop(739);
  // the laptop's last answer was before it was shut, 15 hours ago, so its
  // next one carries every item closed since, the desktop's two included
  laptop.data[K.sync] = { ...laptop.data[K.sync], since: ago(900) };
  return { desktop, laptop, syncDesktop, syncLaptop };
}

const itemRows = () => fake.rows('todo_items').map((t) => [t.vin, t.kind, t.done_at ? t.how : 'open', t.to_price ?? null]).sort((a, b) => `${a[0]}${a[1]}${a[2]}`.localeCompare(`${b[0]}${b[1]}${b[2]}`));
const managerView = () => summarize({ listings: fake.rows('listings'), todoItems: fake.rows('todo_items'), now: new Date().toISOString() });

test('a machine that rescans before its registry has heard of a fix made on another machine files no second to-do item, and drops the flags it raised', async () => {
  const { laptop, syncLaptop } = await fixedWhileTheLaptopWasShut();
  const fixed = [[VIN(1), 'price', 'manual', 19000], [VIN(2), 'takeDown', 'manual', null]];
  assert.deepEqual(itemRows(), fixed);

  // the laptop opens in the evening: its first rescan runs on its registry
  // from before (car 1 at 20000, car 2 still up) and sees both again
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(200), sold: [VIN(2)], prices: [[VIN(1), 20000, 19000]] }));
  assert.equal(laptop.data[K.pilot].flags.length, 2);
  await syncLaptop(199);
  assert.deepEqual(itemRows(), fixed, 'no second item: the listing already shows the new price, and the sold car is already down');
  assert.equal(laptop.data[K.posted][VIN(1)].price, 19000, 'the laptop now has the price the desktop set');
  assert.equal(VIN(2) in laptop.data[K.posted], false, 'and the take-down');
  assert.deepEqual(laptop.data[K.pilot].flags, [], 'the flags raised from the old registry are dropped, so none is later closed as cleared by the website');
  const s = managerView();
  assert.deepEqual([s.priceMismatches, s.soldStillListed], [[], []], 'nothing open for the manager view');
  assert.deepEqual([s.priceUpdates.flagged, s.priceUpdates.done, s.priceUpdates.cleared, s.takeDowns.flagged, s.takeDowns.done, s.takeDowns.cleared], [1, 1, 0, 1, 1, 0], 'each counted once, as the desktop fixed it');

  // the laptop's next rescan, on the merged registry, has nothing to do
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(20) }));
  await syncLaptop(19);
  assert.deepEqual(itemRows(), fixed);
  assert.deepEqual(laptop.data[K.pilot].flags, []);
});

test('a sighting the listing does not show yet is still an item, whichever machine makes it and whenever it closed', async () => {
  const { desktop, laptop, syncDesktop, syncLaptop } = await fixedWhileTheLaptopWasShut();
  // the website drops car 1 again, to 18000: the laptop, on its old
  // registry, sees 20000 -> 18000, which the listing (19000) does not show
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(200), prices: [[VIN(1), 20000, 18000]] }));
  await syncLaptop(199);
  assert.deepEqual(itemRows(), [[VIN(1), 'price', 'manual', 19000], [VIN(1), 'price', 'open', 18000], [VIN(2), 'takeDown', 'manual', null]], 'a new item for the manager view');
  assert.deepEqual(laptop.data[K.pilot].flags.map((f) => [f.vin, f.to, Boolean(f.doneAt)]), [[VIN(1), 18000, false]], 'kept open on the laptop');
  assert.equal(laptop.data[K.posted][VIN(1)].price, 19000);

  // car 3, posted and synced on the desktop; its price drop is flagged and
  // fixed there before the next sync: the item goes in, closed, though its
  // listing shows the new price by the time it arrives
  desktop.data[K.posted] = { ...desktop.data[K.posted], [VIN(3)]: { name: 'Third car', price: 25000, postedAt: ago(2 * 24 * 60) } };
  await syncDesktop(90);
  desktop.data[K.pilot] = noteFlags(desktop.data[K.pilot], rescan({ takenAt: ago(60), prices: [[VIN(3), 25000, 24000]] }));
  desktop.data[K.posted] = markPriceUpdated(desktop.data[K.posted], VIN(3), 24000, ago(30));
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(3), 'price', { at: ago(30), how: 'manual' });
  await syncDesktop(29);
  assert.deepEqual(itemRows().filter((r) => r[0] === VIN(3)), [[VIN(3), 'price', 'manual', 24000]]);
});

// The desktop and the laptop both hold car 1 (20000) and car 2, both synced.
// The desktop's rescan flags car 1's price drop and car 2's sale and the
// salesperson fixes both there, but the desktop's sync after the fix does
// not get through (offline, say); the laptop's rescan sights both changes
// in the meantime, and only then does the desktop's sync arrive.
async function fixedButSyncedLate() {
  await setUp();
  const { storage: desktop, sync: syncDesktop } = await machine();
  const { storage: laptop, sync: syncLaptop } = await machine();
  const posted = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: ago(3 * 24 * 60) }, [VIN(2)]: { name: 'Sold car', price: 30000, postedAt: ago(3 * 24 * 60) } };
  desktop.data[K.posted] = structuredClone(posted);
  laptop.data[K.posted] = structuredClone(posted);
  await syncDesktop(900);
  await syncLaptop(900);
  desktop.data[K.pilot] = noteFlags(null, rescan({ takenAt: ago(300), sold: [VIN(2)], prices: [[VIN(1), 20000, 19000]] }));
  desktop.data[K.posted] = markTakenDown(markPriceUpdated(desktop.data[K.posted], VIN(1), 19000, ago(295)), VIN(2));
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(1), null, { at: ago(295), how: 'manual' });
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(2), null, { at: ago(295), how: 'manual' });
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(240), sold: [VIN(2)], prices: [[VIN(1), 20000, 19000]] }));
  await syncLaptop(239);
  return { desktop, laptop, syncDesktop, syncLaptop };
}
const flaggedAt = () => Object.fromEntries(fake.rows('todo_items').map((t) => [`${t.vin}@${t.kind}`, Date.parse(t.flagged_at)]));

test('a fix that reaches the server after the other machine sighted the change closes that sighting: one item, from the first sighting, never cleared', async () => {
  const { desktop, laptop, syncDesktop, syncLaptop } = await fixedButSyncedLate();
  assert.deepEqual(itemRows(), [[VIN(1), 'price', 'open', 19000], [VIN(2), 'takeDown', 'open', null]], 'the laptop\'s sightings are open items until the fix arrives');

  await syncDesktop(180);
  const fixed = [[VIN(1), 'price', 'manual', 19000], [VIN(2), 'takeDown', 'manual', null]];
  assert.deepEqual(itemRows(), fixed, 'one item per car, closed as the desktop closed it');
  const first = Date.parse(desktop.data[K.pilot].flags[0].flaggedAt);
  assert.deepEqual(flaggedAt(), { [`${VIN(1)}@price`]: first, [`${VIN(2)}@takeDown`]: first }, 'its hours count from the first sighting, the desktop\'s');
  let s = managerView();
  assert.deepEqual([s.priceMismatches, s.soldStillListed], [[], []], 'nothing open for the manager view');
  assert.deepEqual([s.priceUpdates.flagged, s.priceUpdates.done, s.priceUpdates.cleared, s.takeDowns.flagged, s.takeDowns.done, s.takeDowns.cleared], [1, 1, 0, 1, 1, 0]);
  assert.ok(desktop.data[K.pilot].flags.every((f) => f.doneAt && f.how === 'manual'), 'the desktop keeps its closed flags');

  // the laptop's next sync takes the fix and drops the flags it raised; its next rescan finds nothing to do
  await syncLaptop(120);
  assert.deepEqual(laptop.data[K.pilot].flags, [], 'the laptop\'s sightings are dropped, so none is later closed as cleared by the website');
  assert.equal(laptop.data[K.posted][VIN(1)].price, 19000);
  assert.equal(VIN(2) in laptop.data[K.posted], false);
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(60) }));
  await syncLaptop(59);
  assert.deepEqual(itemRows(), fixed, 'no cleared item, no second item');
  s = managerView();
  assert.deepEqual([s.priceUpdates.flagged, s.priceUpdates.cleared, s.takeDowns.flagged, s.takeDowns.cleared], [1, 0, 1, 0]);
});

test('a machine that rescans on an old registry and ticks its sighting off before it syncs adds no second item', async () => {
  const { laptop, syncLaptop } = await fixedWhileTheLaptopWasShut();
  const fixed = [[VIN(1), 'price', 'manual', 19000], [VIN(2), 'takeDown', 'manual', null]];
  assert.deepEqual(itemRows(), fixed);
  // the laptop's Scan, on its registry from before (car 1 at 20000, car 2 up), shows both on To do; before
  // any sync gets through, upkeep finds car 1's listing at 19000 already and the salesperson clicks Taken down for car 2
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(200), sold: [VIN(2)], prices: [[VIN(1), 20000, 19000]] }));
  laptop.data[K.posted] = markTakenDown(markPriceUpdated(laptop.data[K.posted], VIN(1), 19000, ago(195)), VIN(2));
  laptop.data[K.pilot] = resolveFlag(laptop.data[K.pilot], VIN(1), 'price', { at: ago(195), how: 'detected' });
  laptop.data[K.pilot] = resolveFlag(laptop.data[K.pilot], VIN(2), null, { at: ago(195), how: 'manual' });
  await syncLaptop(100);
  assert.deepEqual(itemRows(), fixed, 'the desktop\'s fix is the item; the laptop\'s late sighting adds none');
  const s = managerView();
  assert.deepEqual([s.priceUpdates.flagged, s.priceUpdates.done, s.takeDowns.flagged, s.takeDowns.done], [1, 1, 1, 1], 'each counted once');
});

test('a change that really happened again is still its own item: the website price back and down again, or a later price, while the other machine was away', async () => {
  // the website drops car 1 to 19000 and goes back to 20000 before anyone acts: the desktop's item closes as cleared
  await setUp();
  const { storage: desktop, sync: syncDesktop } = await machine();
  const { storage: laptop, sync: syncLaptop } = await machine();
  const posted = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: ago(3 * 24 * 60) } };
  desktop.data[K.posted] = structuredClone(posted);
  laptop.data[K.posted] = structuredClone(posted);
  await syncDesktop(900);
  await syncLaptop(900);
  desktop.data[K.pilot] = noteFlags(null, rescan({ takenAt: ago(800), prices: [[VIN(1), 20000, 19000]] }));
  desktop.data[K.pilot] = noteFlags(desktop.data[K.pilot], rescan({ takenAt: ago(700) }));
  await syncDesktop(699);
  assert.deepEqual(itemRows(), [[VIN(1), 'price', 'cleared', 19000]]);
  // it drops to 19000 again: the laptop flags it and the salesperson updates the listing there before the laptop syncs
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(300), prices: [[VIN(1), 20000, 19000]] }));
  laptop.data[K.posted] = markPriceUpdated(laptop.data[K.posted], VIN(1), 19000, ago(290));
  laptop.data[K.pilot] = resolveFlag(laptop.data[K.pilot], VIN(1), 'price', { at: ago(290), how: 'manual' });
  await syncLaptop(289);
  assert.deepEqual(itemRows(), [[VIN(1), 'price', 'cleared', 19000], [VIN(1), 'price', 'manual', 19000]], 'two price drops, two items');

  // later the website drops it to 18000: the desktop (synced, at 19000) flags it and the
  // salesperson updates the listing there, but that sync does not get through; the laptop,
  // meanwhile, sights a further drop to 17500, which the listing does not show: still an item
  await syncDesktop(250);
  assert.equal(desktop.data[K.posted][VIN(1)].price, 19000);
  desktop.data[K.pilot] = noteFlags(desktop.data[K.pilot], rescan({ takenAt: ago(200), prices: [[VIN(1), 19000, 18000]] }));
  desktop.data[K.posted] = markPriceUpdated(desktop.data[K.posted], VIN(1), 18000, ago(190));
  desktop.data[K.pilot] = resolveFlag(desktop.data[K.pilot], VIN(1), 'price', { at: ago(190), how: 'manual' });
  laptop.data[K.pilot] = noteFlags(laptop.data[K.pilot], rescan({ takenAt: ago(150), prices: [[VIN(1), 19000, 17500]] }));
  await syncLaptop(149);
  await syncDesktop(100);
  assert.deepEqual(itemRows(), [[VIN(1), 'price', 'cleared', 19000], [VIN(1), 'price', 'manual', 19000], [VIN(1), 'price', 'manual', 18000], [VIN(1), 'price', 'open', 17500]], 'the fix to 18000 is its own item, and the drop to 17500 stays open');
});
