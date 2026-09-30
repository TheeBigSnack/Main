// The edge cases a second review of the known-keys take-down rule found
// (supabase/functions/sync/index.ts step 2, extension/src/sync.js,
// extension/src/accountFlow.js syncOnce), each run against the real handler
// and the extension's own syncOnce: a Clear everything that lands after the
// merge or during a first sync, a listing the merge did not keep, and a
// re-post from a machine with a slow clock inside the 10-minute look-back.
// In each, nobody took the car down, so nothing may be taken down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, fake, hermetic, functionsFetch, uuid, SUPABASE_URL, ANON_KEY } from './functions/harness.mjs';
import { syncOnce } from '../extension/src/accountFlow.js';
import { sessionFromTokenResponse, storeSession } from '../extension/src/account.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { markTakenDown, markPosted } from '../extension/src/rescan.js';

hermetic();

const ORIGIN = 'https://www.example-motors.test';
const K = siteKeys(ORIGIN);
const D1 = uuid(1);
const U1 = uuid(11);
const U2 = uuid(12);
const TOKEN = { u1: 'token-of-u1', u2: 'token-of-u2' };
const USERS = { [TOKEN.u1]: { id: U1, email: 'sam@example-motors.test' }, [TOKEN.u2]: { id: U2, email: 'max@example-motors.test' } };
const VIN = (n) => `TESTVIN0000000${String(n).padStart(3, '0')}`;
const config = { url: SUPABASE_URL, anonKey: ANON_KEY, functionsUrl: '' };

function world({ dbAheadMs = 0 } = {}) {
  fake.reset({
    users: USERS,
    now: () => Date.now() + dbAheadMs,
    rows: {
      dealerships: [{ id: D1, name: 'Example Motors', website_origin: ORIGIN }],
      memberships: [{ user_id: U1, dealership_id: D1, role: 'salesperson', name: 'Sam' }, { user_id: U2, dealership_id: D1, role: 'salesperson', name: 'Max' }],
    },
  });
}

async function machine(token = TOKEN.u1, posted = {}, hooks = {}) {
  const data = {};
  const storage = {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (hooks.get) await hooks.get(list, data);
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
      if (hooks.set) await hooks.set(obj, data);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
  const user = USERS[token];
  assert.equal(await storeSession(sessionFromTokenResponse({ access_token: token, expires_in: 3600, refresh_token: 'refresh', user }, Date.now()), storage), true);
  data[K.posted] = posted;
  return storage;
}

async function setUp(opts) {
  world(opts);
  const fetchImpl = functionsFetch({ sync: await loadFunction('sync') });
  return async (storage) => {
    const r = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage, now: Date.now() } });
    return r;
  };
}
const car = (name, price, postedAt = new Date().toISOString()) => ({ name, price, postedAt });
const rowOf = (vin) => fake.rows('listings').find((l) => l.vin === vin);

test('Clear everything landing after the merge and before the sync state is written takes nothing down', async () => {
  const sync = await setUp();
  let armed = false;
  const hooks = {
    async set(obj, data) {
      // the popup's Clear everything lands right after the merge wrote the registry
      if (armed && K.posted in obj) {
        armed = false;
        for (const k of Object.values(K)) delete data[k];
      }
    },
  };
  const old = new Date(Date.now() - 86400e3).toISOString();
  const desktop = await machine(TOKEN.u1, { [VIN(1)]: car('A', 10000, old), [VIN(2)]: car('B', 12000, old) }, hooks);
  assert.equal((await sync(desktop)).ok, true);
  desktop.data[K.posted][VIN(3)] = car('C', 13000); // a change, so the merge writes
  armed = true;
  assert.equal((await sync(desktop)).ok, true);
  assert.equal(K.sync in desktop.data, false, 'the cleared state is not written back');
  const r = await sync(desktop); // the first sync after the clear
  assert.equal(r.ok, true);
  assert.equal(r.counts.takenDown, 0);
  for (const n of [1, 2, 3]) assert.equal(rowOf(VIN(n)).status, 'listed', `car ${n} stays up`);
  assert.deepEqual(Object.keys(desktop.data[K.posted]).sort(), [VIN(1), VIN(2), VIN(3)], 'the registry comes back from the server');
});

test('a first sync: Clear everything and a new post while the request is out take nothing down next', async () => {
  const sync = await setUp();
  const old = new Date(Date.now() - 86400e3).toISOString();
  const other = await machine(TOKEN.u1, { [VIN(1)]: car('A', 10000, old), [VIN(2)]: car('B', 12000, old) });
  await sync(other);
  const desktop = await machine(TOKEN.u1, { [VIN(1)]: car('A', 10000, old), [VIN(2)]: car('B', 12000, old) });
  const out = fake.hold((e) => e.table === 'memberships');
  const pending = sync(desktop);
  await out.arrived;
  for (const k of Object.values(K)) delete desktop.data[k]; // Clear everything
  desktop.data[K.posted] = markPosted({}, { vin: VIN(3), name: 'C', price: 9000 }, 'website'); // and a post the side panel records
  out.commit();
  assert.equal((await pending).ok, true);
  const r = await sync(desktop);
  assert.equal(r.counts.takenDown, 0);
  for (const n of [1, 2]) assert.equal(rowOf(VIN(n)).status, 'listed', `car ${n} stays up`);
});

test('an own listed post the merge does not keep (a colleague\'s newer take-down of the car shadows it) is not known and stays up', async () => {
  const sync = await setUp();
  const t1 = new Date(Date.now() - 2 * 3600e3).toISOString();
  const desktop = await machine(TOKEN.u1, { [VIN(9)]: car('Shared car', 20000, t1) }); // posted while its syncs were failing
  const laptop = await machine(TOKEN.u1);
  const max = await machine(TOKEN.u2);
  await sync(laptop);
  max.data[K.posted] = { [VIN(9)]: car('Shared car', 20000, new Date(Date.now() - 3600e3).toISOString()) };
  await sync(max);
  await sync(laptop); // the laptop holds Max's entry
  await sync(desktop); // a conflict: the desktop keeps its own entry
  max.data[K.posted] = markTakenDown(max.data[K.posted], VIN(9));
  await sync(max);
  const d = await sync(desktop); // the desktop's post goes in
  assert.equal(d.counts.listingsInserted, 1);
  await sync(laptop);
  const again = await sync(laptop); // nobody touched anything
  assert.equal(again.counts.takenDown, 0);
  const sams = fake.rows('listings').filter((l) => l.vin === VIN(9) && l.user_id === U1);
  assert.deepEqual(sams.map((l) => l.status), ['listed'], 'Sam\'s live post stays up');
});

test('the same, from a new laptop signing in after the colleague\'s take-down', async () => {
  const sync = await setUp();
  const t1 = new Date(Date.now() - 2 * 3600e3).toISOString();
  const desktop = await machine(TOKEN.u1, { [VIN(9)]: car('Shared car', 20000, t1) });
  const max = await machine(TOKEN.u2);
  max.data[K.posted] = { [VIN(9)]: car('Shared car', 20000, new Date(Date.now() - 3600e3).toISOString()) };
  await sync(max);
  await sync(desktop);
  max.data[K.posted] = markTakenDown(max.data[K.posted], VIN(9));
  await sync(max);
  await sync(desktop);
  const laptop = await machine(TOKEN.u1);
  assert.equal((await sync(laptop)).counts.takenDown, 0);
  assert.equal((await sync(laptop)).counts.takenDown, 0);
  const sams = fake.rows('listings').filter((l) => l.vin === VIN(9) && l.user_id === U1);
  assert.deepEqual(sams.map((l) => l.status), ['listed']);
});

test('a re-post from a machine whose clock is slow, inside the look-back, is not dropped by the re-delivered take-down', async () => {
  const sync = await setUp();
  const desktop = await machine(TOKEN.u1, { [VIN(4)]: car('Car', 20000, new Date(Date.now() - 5 * 60e3).toISOString()) });
  const laptop = await machine(TOKEN.u1);
  await sync(desktop);
  await sync(laptop);
  desktop.data[K.posted] = markTakenDown(desktop.data[K.posted], VIN(4));
  await sync(desktop); // down
  await sync(laptop); // the laptop hears of it
  assert.equal(VIN(4) in laptop.data[K.posted], false);
  // the laptop, its clock 10 minutes slow, posts the car again
  laptop.data[K.posted] = { [VIN(4)]: car('Car', 20000, new Date(Date.now() - 10 * 60e3).toISOString()) };
  const a = await sync(laptop);
  assert.equal(a.counts.listingsInserted, 1);
  assert.equal(VIN(4) in laptop.data[K.posted], true, 'the re-post stays in the registry');
  const b = await sync(laptop);
  assert.equal(b.counts.takenDown, 0);
  assert.deepEqual(fake.rows('listings').filter((l) => l.vin === VIN(4)).map((l) => l.status).sort(), ['listed', 'taken_down'], 'the re-post is up; the first post stays down');
});
