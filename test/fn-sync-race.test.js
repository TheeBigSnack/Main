// The sync races from the round H review, each run against the real sync
// handler (supabase/functions/sync/index.ts) and the extension's own
// syncOnce (extension/src/accountFlow.js), with the fake database holding
// one request's transaction open while another request runs (fake.hold)
// and, where it matters, its clock apart from the function's (fake.now).
//
// Each was a take-down decided by time: the listing's created_at (the
// database's clock, stamped when its transaction began) against the
// caller's last serverTime (the function's clock, taken before separate
// reads), a taken_down_at stamped by one call against another call's
// serverTime, and a merge that put back what the person had just removed.
// The fix decides take-downs by `known`, the posts a machine sent or
// received at its last sync, and looks back a margin before `since` for
// the take-downs it sends down (supabase/README.md, the /sync contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, fake, hermetic, functionsFetch, uuid, SUPABASE_URL, ANON_KEY } from './functions/harness.mjs';
import { syncOnce } from '../extension/src/accountFlow.js';
import { sessionFromTokenResponse, storeSession } from '../extension/src/account.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { markTakenDown } from '../extension/src/rescan.js';

hermetic();

const ORIGIN = 'https://www.example-motors.test';
const K = siteKeys(ORIGIN);
const D1 = uuid(1);
const U1 = uuid(11); // the salesperson, on a showroom desktop and a laptop
const U2 = uuid(12); // a colleague
const TOKEN = { u1: 'token-of-u1', u2: 'token-of-u2' };
const USERS = { [TOKEN.u1]: { id: U1, email: 'sam@example-motors.test' }, [TOKEN.u2]: { id: U2, email: 'max@example-motors.test' } };
const VIN = (n) => `TESTVIN0000000${String(n).padStart(3, '0')}`;
const config = { url: SUPABASE_URL, anonKey: ANON_KEY, functionsUrl: '' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One dealership and its two members; `dbAheadMs` sets the database's clock
// ahead of the function's.
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

// chrome.storage.local's shape, in memory, with a signed-in session.
async function machine(token = TOKEN.u1, posted = {}) {
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
    assert.equal(r.ok, true, r.error);
    return r;
  };
}

const car = (name, price, postedAt = new Date().toISOString()) => ({ name, price, postedAt });
const rowOf = (vin) => fake.rows('listings').find((l) => l.vin === vin);
const listedRead = (e) => e.table === 'listings' && e.op === 'select' && e.columns === '*' && e.filters.some((f) => f.column === 'status' && f.value === 'listed');

test('race: a post from the salesperson\'s other machine whose insert began before this sync\'s serverTime and committed after its reads is never taken down by this machine', async () => {
  const sync = await setUp();
  const desktop = await machine(TOKEN.u1, { [VIN(6)]: car('Their own older car', 18000, new Date(Date.now() - 86400e3).toISOString()) });
  const laptop = await machine();
  await sync(desktop);
  await sync(laptop);

  // the laptop posts; its insert begins (created_at is taken) and stays open
  laptop.data[K.posted] = { ...laptop.data[K.posted], [VIN(7)]: car('Just posted', 30000) };
  const insert = fake.hold((e) => e.table === 'listings' && e.op === 'insert');
  const laptopSync = sync(laptop);
  await insert.arrived;
  // the desktop's rescan syncs meanwhile, start to finish, and does not see the car
  const a = await sync(desktop);
  assert.equal(VIN(7) in desktop.data[K.posted], false);
  insert.commit();
  assert.equal((await laptopSync).counts.listingsInserted, 1);
  assert.ok(Date.parse(rowOf(VIN(7)).created_at) <= Date.parse(a.serverTime), 'stamped before the desktop\'s serverTime, as a time rule would have it held then');

  // the desktop's next sync: the car is the laptop's post, which the desktop never had
  const a2 = await sync(desktop);
  assert.equal(a2.counts.takenDown, 0, 'nothing taken down that the desktop never knew');
  assert.equal(rowOf(VIN(7)).status, 'listed');
  assert.equal(desktop.data[K.posted][VIN(7)].price, 30000, 'the desktop receives it now');
  await sync(laptop);
  assert.equal(VIN(7) in laptop.data[K.posted], true, 'and the laptop keeps tracking it');
  assert.equal(rowOf(VIN(6)).status, 'listed');
});

test('race: a post that lands between this sync\'s serverTime and its reads is received, and a take-down of it counts at the next sync (no clock skew needed)', async () => {
  const sync = await setUp();
  const desktop = await machine();
  const laptop = await machine();
  await sync(desktop);
  await sync(laptop);

  // the desktop's sync has taken its serverTime and waits at its read of the listed rows
  const read = fake.hold(listedRead);
  const desktopSync = sync(desktop);
  await read.arrived;
  await wait(5); // the laptop's insert begins after that serverTime
  laptop.data[K.posted] = { [VIN(8)]: car('From the laptop', 30000) };
  await sync(laptop);
  read.commit();
  const a = await desktopSync;
  assert.equal(desktop.data[K.posted][VIN(8)].price, 30000, 'the desktop received the car');
  assert.ok(Date.parse(rowOf(VIN(8)).created_at) > Date.parse(a.serverTime), 'stamped after the desktop\'s serverTime, so a time rule would never count it as held');

  // Taken down, on the desktop
  desktop.data[K.posted] = markTakenDown(desktop.data[K.posted], VIN(8));
  const a2 = await sync(desktop);
  assert.equal(a2.counts.takenDown, 1);
  assert.equal(rowOf(VIN(8)).status, 'taken_down');
  assert.equal(VIN(8) in desktop.data[K.posted], false, 'and the car does not come back');
  await sync(laptop);
  assert.equal(VIN(8) in laptop.data[K.posted], false, 'the laptop drops it too');
});

test('race: with the database\'s clock ahead of the function\'s, a take-down right after the post\'s own sync still counts', async () => {
  const sync = await setUp({ dbAheadMs: 2000 });
  const desktop = await machine();
  await sync(desktop);
  desktop.data[K.posted] = { [VIN(1)]: car('My car', 20000) };
  const a = await sync(desktop);
  assert.equal(a.counts.listingsInserted, 1);
  assert.ok(Date.parse(rowOf(VIN(1)).created_at) > Date.parse(a.serverTime), 'the row looks newer than the sync that inserted it');
  desktop.data[K.posted] = markTakenDown(desktop.data[K.posted], VIN(1));
  const b = await sync(desktop);
  assert.equal(b.counts.takenDown, 1);
  assert.equal(rowOf(VIN(1)).status, 'taken_down');
  assert.equal(VIN(1) in desktop.data[K.posted], false);
});

test('race: Taken down clicked while this machine\'s own sync is out is not undone by that sync\'s answer, and the next sync takes the car down', async () => {
  const sync = await setUp();
  const desktop = await machine(TOKEN.u1, { [VIN(3)]: car('Sold car', 12000, new Date(Date.now() - 86400e3).toISOString()) });
  await sync(desktop);

  const out = fake.hold((e) => e.table === 'memberships'); // the request has left with the car in it
  const r = sync(desktop);
  await out.arrived;
  desktop.data[K.posted] = markTakenDown(desktop.data[K.posted], VIN(3)); // the popup's Taken down
  out.commit();
  const a = await r;
  assert.equal(a.counts.takenDown, 0, 'the request carried the car, so the server kept it up');
  assert.equal(VIN(3) in desktop.data[K.posted], false, 'the answer does not put it back');

  const a2 = await sync(desktop);
  assert.equal(a2.counts.takenDown, 1);
  assert.equal(rowOf(VIN(3)).status, 'taken_down');
  assert.equal(VIN(3) in desktop.data[K.posted], false);
});

test('race: a take-down stamped before another machine\'s serverTime but committed after its reads still reaches that machine and a colleague\'s', async () => {
  const sync = await setUp();
  const laptop = await machine(TOKEN.u1, { [VIN(5)]: car('Sold car', 15000, new Date(Date.now() - 3600e3).toISOString()) });
  const desktop = await machine();
  const colleague = await machine(TOKEN.u2);
  await sync(laptop);
  await sync(desktop);
  await sync(colleague);
  assert.equal(VIN(5) in desktop.data[K.posted], true);
  assert.equal(colleague.data[K.posted][VIN(5)].mine, false);

  // the laptop takes the car down; its update is stamped by the function and stays open
  laptop.data[K.posted] = markTakenDown(laptop.data[K.posted], VIN(5));
  const update = fake.hold((e) => e.table === 'listings' && e.op === 'update' && e.payload.status === 'taken_down');
  const laptopSync = sync(laptop);
  const sent = await update.arrived;
  await wait(5);
  // the desktop and the colleague sync meanwhile and still read the car as listed
  const a = await sync(desktop);
  await sync(colleague);
  assert.ok(Date.parse(sent.payload.taken_down_at) < Date.parse(a.serverTime), 'stamped before the desktop\'s serverTime');
  assert.equal(VIN(5) in desktop.data[K.posted], true);
  update.commit();
  assert.equal((await laptopSync).counts.takenDown, 1);

  // their next syncs look back far enough to hear of it
  await sync(desktop);
  await sync(colleague);
  assert.equal(VIN(5) in desktop.data[K.posted], false, 'the salesperson\'s other machine drops the car');
  assert.equal(VIN(5) in colleague.data[K.posted], false, 'and so does the colleague\'s');
  await sync(desktop);
  assert.equal(VIN(5) in desktop.data[K.posted], false, 'and it stays dropped');
});
