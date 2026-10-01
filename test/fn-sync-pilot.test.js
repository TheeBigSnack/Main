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

for (const [label, skewMs] of [['30 seconds', 30e3], ['15 minutes', 15 * 60e3]]) {
  test(`a machine whose clock runs ${label} slow gets every queue post attempt to the server, one sync after each post`, async () => {
    const { sync, post } = await setUp({ skewMs });
    for (let n = 1; n <= 4; n++) {
      post(VIN(n), { queue: true });
      await sync();
    }
    assert.equal(fake.rows('listings').length, 4);
    assert.deepEqual(fake.rows('post_attempts').map((a) => a.vin).sort(), [VIN(1), VIN(2), VIN(3), VIN(4)], 'every attempt, for the manager view\'s median seconds per post');
  });

  test(`a machine whose clock runs ${label} slow gets a ticked-off to-do item and the next post to the server`, async () => {
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
  });
}

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
