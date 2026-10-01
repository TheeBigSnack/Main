// The pilot lists (post attempts and to-do flags, extension/src/pilot.js)
// going up through the extension's own syncOnce (extension/src/accountFlow.js)
// to the real sync handler (supabase/functions/sync/index.ts): what the
// manager view reads from post_attempts and todo_items must follow what the
// salesperson's machine holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, fake, hermetic, functionsFetch, uuid, SUPABASE_URL, ANON_KEY } from './functions/harness.mjs';
import { syncOnce } from '../extension/src/accountFlow.js';
import { sessionFromTokenResponse, storeSession } from '../extension/src/account.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { noteFlags } from '../extension/src/pilot.js';

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

async function setUp() {
  fake.reset({
    users: { [TOKEN]: USER },
    rows: {
      dealerships: [{ id: D1, name: 'Example Motors', website_origin: ORIGIN }],
      memberships: [{ user_id: U1, dealership_id: D1, role: 'salesperson', name: 'Sam' }],
    },
  });
  const fetchImpl = functionsFetch({ sync: await loadFunction('sync') });
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
    const r = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage, now: Date.now() } });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  return { storage, sync };
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
