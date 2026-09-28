// Sync (Milestone 4): the rows the function writes, the payload that goes
// up, the merge that comes down, and two machines converging on one
// registry through a small in-memory model of the sync function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toServerRows, syncPayload, mergeRegistry, mergeFlags, scanRow, scanSummary, nextSyncState, SYNC_VERSION } from '../extension/src/sync.js';
import { markPosted, markPriceUpdated, markTakenDown } from '../extension/src/rescan.js';
import { beginPost, endPost, noteFlags, resolveFlag } from '../extension/src/pilot.js';

const T = (min, sec = 0) => new Date(Date.UTC(2026, 10, 16, 9, min, sec)).toISOString(); // Nov 16 2026 09:mm:ss
const ORIGIN = 'https://www.example-motors.test';
const D = '00000000-0000-4000-8000-00000000000d';
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const VIN_A = 'TESTVIN00000000A1';
const VIN_B = 'TESTVIN00000000B2';
const VIN_C = 'TESTVIN00000000C3';

const car = (vin, name, price) => ({ vin, name, price });

// ---------- what goes up ----------

test('toServerRows: a registry entry becomes one listing row, the caller\'s, with nulls for what is missing', () => {
  const posted = {
    [VIN_A.toLowerCase()]: { name: '2019 Ram 1500', price: 28995, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex', updatedAt: T(5) },
    [VIN_B]: { name: '2020 Jeep', price: null, postedAt: T(1), postedWith: '0.4.0' },
    [VIN_C]: { name: 'Not mine', price: 1, postedAt: T(2), userId: U2 },
    BADENTRY: 'garbage',
    NOTIME: { name: 'no time', price: 5 },
  };
  const { listings, postAttempts, todoItems } = toServerRows({ origin: ORIGIN, posted, pilot: null, dealershipId: D, userId: U1 });
  assert.equal(listings.length, 2, 'the colleague\'s entry, the garbage and the entry without a time are left out');
  assert.deepEqual(listings[0], {
    dealership_id: D, user_id: U1, vin: VIN_A, name: '2019 Ram 1500', price: 28995, posted_at: T(0),
    listing_url: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex', updated_at: T(5), status: 'listed', taken_down_at: null,
  });
  assert.deepEqual(listings[1], { dealership_id: D, user_id: U1, vin: VIN_B, name: '2020 Jeep', price: null, posted_at: T(1), listing_url: null, salesperson: null, updated_at: null, status: 'listed', taken_down_at: null });
  assert.deepEqual(postAttempts, []);
  assert.deepEqual(todoItems, []);
  // an http link is not a listing link
  assert.equal(toServerRows({ posted: { [VIN_A]: { postedAt: T(0), listingUrl: 'http://x' } }, dealershipId: D, userId: U1 }).listings[0].listing_url, null);
});

test('toServerRows: post attempts and to-do flags map to post_attempts and todo_items', () => {
  let pilot = beginPost(null, { vin: VIN_A, name: '2019 Ram 1500', salesperson: 'Alex', queue: true, at: T(0) });
  pilot = endPost(pilot, VIN_A, 'posted', { at: T(1, 5) });
  pilot = beginPost(pilot, { vin: VIN_B, name: '2020 Jeep', at: T(2) });
  pilot = endPost(pilot, VIN_B, 'blocked', { at: T(2, 3), reason: 'not-on-website' });
  const diff = { takeDown: [{ vin: VIN_A, name: '2019 Ram 1500', yours: true, why: 'gone' }], priceUpdates: [{ vin: VIN_B, name: '2020 Jeep', yours: true, from: 30000, to: 29500 }], warnings: [], unreliable: false };
  pilot = noteFlags(pilot, diff, { at: T(10) });
  pilot = resolveFlag(pilot, VIN_A, 'takeDown', { at: T(40), how: 'detected' });
  const { postAttempts, todoItems } = toServerRows({ posted: {}, pilot, dealershipId: D, userId: U1 });
  assert.deepEqual(postAttempts, [
    { dealership_id: D, user_id: U1, vin: VIN_A, name: '2019 Ram 1500', salesperson: 'Alex', queue: true, started_at: T(0), ended_at: T(1, 5), outcome: 'posted', seconds: 65, reason: null },
    { dealership_id: D, user_id: U1, vin: VIN_B, name: '2020 Jeep', salesperson: null, queue: false, started_at: T(2), ended_at: T(2, 3), outcome: 'blocked', seconds: 3, reason: 'not-on-website' },
  ]);
  assert.deepEqual(todoItems, [
    { dealership_id: D, vin: VIN_A, kind: 'takeDown', name: '2019 Ram 1500', flagged_at: T(10), done_at: T(40), how: 'detected', from_price: null, to_price: null },
    { dealership_id: D, vin: VIN_B, kind: 'price', name: '2020 Jeep', flagged_at: T(10), done_at: null, how: null, from_price: 30000, to_price: 29500 },
  ]);
});

test('scan summary and row', () => {
  assert.equal(scanSummary(null), null);
  assert.equal(scanSummary({ cars: 3 }), null, 'a scan without a time is not a scan');
  assert.deepEqual(scanRow({ takenAt: T(0), cars: 41, ready: 29, takeDownCount: 2, priceUpdateCount: '1' }, { origin: ORIGIN, dealershipId: D }), {
    dealership_id: D, website_origin: ORIGIN, taken_at: T(0), cars: 41, ready: 29, take_down_count: 2, price_update_count: 1,
  });
});

test('syncPayload: the caller\'s whole registry, only the pilot entries that changed since the last sync, the scan and since', () => {
  const posted = {
    [VIN_A]: { name: 'A', price: 1, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex', postedWith: '0.4.0' },
    [VIN_C]: { name: 'C', price: 3, postedAt: T(0), userId: U2 },
  };
  let pilot = beginPost(null, { vin: VIN_A, at: T(0) });
  pilot = endPost(pilot, VIN_A, 'posted', { at: T(1) });
  pilot = beginPost(pilot, { vin: VIN_B, at: T(20) });
  pilot = noteFlags(pilot, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [], warnings: [] }, { at: T(2) });
  const body = syncPayload({ origin: ORIGIN, posted, pilot, scan: { takenAt: T(30), cars: 10 }, since: T(15), userId: U1 });
  assert.equal(body.version, SYNC_VERSION);
  assert.equal(body.origin, ORIGIN);
  assert.deepEqual(Object.keys(body.posted), [VIN_A], 'the colleague\'s entry is theirs to sync');
  assert.deepEqual(body.posted[VIN_A], { name: 'A', price: 1, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex' }, 'postedWith stays local');
  assert.deepEqual(body.pilot.posts.map((a) => a.vin), [VIN_B], 'the attempt from before since is already on the server');
  assert.deepEqual(body.pilot.flags, [], 'the flag from before since too');
  assert.deepEqual(body.scan, { takenAt: T(30), cars: 10, ready: null, takeDownCount: null, priceUpdateCount: null });
  assert.equal(body.since, T(15));
  // never synced: everything goes
  const first = syncPayload({ origin: ORIGIN, posted, pilot, scan: null, since: null, userId: U1 });
  assert.equal(first.pilot.posts.length, 2);
  assert.equal(first.pilot.flags.length, 1);
  assert.equal(first.scan, null);
  assert.equal(first.since, null);
  // a flag closed after since goes up again so the server closes it too
  const closed = resolveFlag(pilot, VIN_A, 'takeDown', { at: T(16), how: 'manual' });
  assert.equal(syncPayload({ origin: ORIGIN, posted, pilot: closed, since: T(15), userId: U1 }).pilot.flags.length, 1);
  // fills never leave the browser
  assert.equal('fills' in body.pilot, false);
});

// ---------- what comes down ----------

const row = (vin, over = {}) => ({
  id: `id-${vin}-${over.posted_at || T(0)}`, dealership_id: D, user_id: U2, vin, name: `Car ${vin.slice(-2)}`, price: 20000, posted_at: T(0),
  listing_url: null, salesperson: 'Sam', updated_at: null, taken_down_at: null, status: 'listed', ...over,
});

test('mergeRegistry: a VIN only on the server is added with its link and who posted', () => {
  const local = { [VIN_A]: { name: 'A', price: 1, postedAt: T(0) } };
  const out = mergeRegistry(local, { listings: [row(VIN_B, { listing_url: 'https://www.facebook.com/marketplace/item/2/' })] });
  assert.deepEqual(out, {
    [VIN_A]: { name: 'A', price: 1, postedAt: T(0) },
    [VIN_B]: { name: 'Car B2', price: 20000, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/2/', salesperson: 'Sam', userId: U2 },
  });
  assert.deepEqual(local, { [VIN_A]: { name: 'A', price: 1, postedAt: T(0) } }, 'the input is not changed');
  assert.deepEqual(mergeRegistry(local, [row(VIN_B)]), mergeRegistry(local, { listings: [row(VIN_B)] }), 'a plain array of rows works too');
  assert.deepEqual(mergeRegistry(local, null), local);
});

test('mergeRegistry: a VIN taken down on the server is removed here; a newer local post of the same car is kept', () => {
  const local = { [VIN_A]: { name: 'A', price: 1, postedAt: T(0) }, [VIN_B]: { name: 'B', price: 2, postedAt: T(30) } };
  const remote = [row(VIN_A, { status: 'taken_down', taken_down_at: T(20) }), row(VIN_B, { status: 'taken_down', taken_down_at: T(10) })];
  const out = mergeRegistry(local, remote);
  assert.deepEqual(Object.keys(out), [VIN_B], 'A was the same post and is gone; B was posted again here after the server\'s post was taken down');
  assert.deepEqual(out[VIN_B], local[VIN_B]);
});

test('mergeRegistry: the newest change wins for the price, both ways; a local change made after since is kept when the server\'s is older', () => {
  const local = { [VIN_A]: { name: 'A', price: 19000, postedAt: T(0), updatedAt: T(10) } };
  // the server's change is newer
  const newer = mergeRegistry(local, [row(VIN_A, { price: 18500, updated_at: T(12) })], { since: T(5) });
  assert.equal(newer[VIN_A].price, 18500);
  assert.equal(newer[VIN_A].updatedAt, T(12));
  // the local change is newer (made after since, not yet acknowledged)
  const older = mergeRegistry(local, [row(VIN_A, { price: 18500, updated_at: T(8) })], { since: T(5) });
  assert.equal(older[VIN_A].price, 19000);
  assert.equal(older[VIN_A].updatedAt, T(10));
  // a tie keeps the local entry as it is
  const tie = mergeRegistry(local, [row(VIN_A, { price: 18500, updated_at: T(10) })]);
  assert.equal(tie[VIN_A].price, 19000);
  // an entry never updated on either side: the post time decides, so nothing moves
  const plain = mergeRegistry({ [VIN_A]: { name: 'A', price: 19000, postedAt: T(0) } }, [row(VIN_A, { price: 18500 })]);
  assert.equal(plain[VIN_A].price, 19000);
});

test('mergeRegistry: a missing link, name or salesperson is filled from the server; the newer post of a car re-posted elsewhere replaces the old one', () => {
  const local = { [VIN_A]: { name: '', price: 1, postedAt: T(0), postedWith: '0.4.0' } };
  const filled = mergeRegistry(local, [row(VIN_A, { listing_url: 'https://www.facebook.com/marketplace/item/9/', user_id: U1 })]);
  assert.deepEqual(filled[VIN_A], { name: 'Car A1', price: 1, postedAt: T(0), postedWith: '0.4.0', listingUrl: 'https://www.facebook.com/marketplace/item/9/', salesperson: 'Sam', userId: U1 });
  const reposted = mergeRegistry(local, [row(VIN_A, { posted_at: T(0) , status: 'taken_down', taken_down_at: T(5) }), row(VIN_A, { posted_at: T(6), price: 7 })]);
  assert.deepEqual(reposted[VIN_A], { name: 'Car A1', price: 7, postedAt: T(6), postedWith: '0.4.0', salesperson: 'Sam', userId: U2 });
});

test('mergeFlags: a flag closed on another machine closes here; nothing is added or reopened', () => {
  let pilot = noteFlags(null, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [{ vin: VIN_B, name: 'B', yours: true, from: 2, to: 1 }], warnings: [] }, { at: T(0) });
  const remote = {
    todoItems: [
      { dealership_id: D, vin: VIN_A, kind: 'takeDown', flagged_at: T(0), done_at: T(30), how: 'detected' },
      { dealership_id: D, vin: VIN_B, kind: 'price', flagged_at: T(0), done_at: null, how: null },
      { dealership_id: D, vin: VIN_C, kind: 'price', flagged_at: T(0), done_at: T(30), how: 'manual' },
    ],
  };
  const merged = mergeFlags(pilot, remote);
  assert.equal(merged.flags.length, 2, 'nothing added');
  const a = merged.flags.find((f) => f.vin === VIN_A);
  assert.equal(a.doneAt, T(30));
  assert.equal(a.how, 'detected');
  assert.equal(a.hours, 0.5);
  assert.equal(merged.flags.find((f) => f.vin === VIN_B).doneAt, undefined);
  // closed here already: left alone
  pilot = resolveFlag(pilot, VIN_B, 'price', { at: T(10), how: 'manual' });
  const again = mergeFlags(pilot, { todoItems: [{ vin: VIN_B, kind: 'price', flagged_at: T(0), done_at: T(50), how: 'detected' }] });
  assert.equal(again.flags.find((f) => f.vin === VIN_B).doneAt, T(10));
  assert.deepEqual(mergeFlags(pilot, null), pilot, 'no answer: the same record back');
});

test('the state kept for the next sync', () => {
  const s = nextSyncState(null, { serverTime: T(1), dealership: { id: D, name: 'Example Motors' }, role: 'salesperson' });
  assert.deepEqual(s, { version: SYNC_VERSION, since: T(1), dealershipId: D, dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: T(1) });
  assert.equal(nextSyncState(s, { ok: false }).since, T(1), 'a failed answer keeps the last state');
});

// ---------- two machines converge ----------

// A small model of the sync function (supabase/functions/sync/index.ts):
// the caller's rows are upserted (a row of another user is never touched,
// a taken-down row is never relisted), the caller's listed rows that are
// missing from the registry among those the server already held at `since`
// (created_at, the server's stamp; the client's posted_at is never compared
// with since) are taken down, and the whole current registry comes back.
// A row inserted by a call gets the call's own serverTime as created_at,
// as the function takes serverTime after its writes.
function fakeServer() {
  const listings = [];
  const clock = { t: Date.UTC(2026, 10, 16, 12, 0, 0) };
  const tick = () => new Date((clock.t += 1000)).toISOString();
  return {
    listings,
    sync(userId, body) {
      const now = tick();
      const rows = toServerRows({ origin: body.origin, posted: body.posted, pilot: body.pilot, dealershipId: D, userId });
      const sent = new Set(rows.listings.map((r) => `${r.vin}@${r.posted_at}`));
      for (const r of listings) {
        if (r.user_id === userId && r.status === 'listed' && !sent.has(`${r.vin}@${r.posted_at}`) && body.since && Date.parse(r.created_at) <= Date.parse(body.since)) {
          r.status = 'taken_down';
          r.taken_down_at = now;
        }
      }
      for (const incoming of rows.listings) {
        const have = listings.find((r) => r.vin === incoming.vin && r.posted_at === incoming.posted_at);
        if (!have) {
          listings.push({ id: `${incoming.vin}@${incoming.posted_at}`, ...incoming, created_at: now });
          continue;
        }
        if (have.user_id !== userId || have.status !== 'listed') continue;
        const newer = Date.parse(incoming.updated_at || incoming.posted_at) > Date.parse(have.updated_at || have.posted_at);
        if (newer) Object.assign(have, { price: incoming.price, updated_at: incoming.updated_at });
        if (!have.listing_url && incoming.listing_url) have.listing_url = incoming.listing_url;
      }
      return { ok: true, serverTime: now, dealership: { id: D, name: 'Example Motors' }, role: 'salesperson', listings: listings.map((r) => ({ ...r })), todoItems: [] };
    },
  };
}

function machine(userId, posted) {
  return { userId, posted, since: null };
}

function sync(server, m) {
  const answer = server.sync(m.userId, syncPayload({ origin: ORIGIN, posted: m.posted, pilot: null, scan: null, since: m.since, userId: m.userId }));
  m.posted = mergeRegistry(m.posted, answer, { since: m.since });
  m.since = answer.serverTime;
  return answer;
}

const listedOn = (server) => Object.fromEntries(server.listings.filter((r) => r.status === 'listed').map((r) => [r.vin, r.price]));
const prices = (m) => Object.fromEntries(Object.entries(m.posted).map(([vin, e]) => [vin, e.price]));

test('two machines starting from different registries converge after both sync, and keep converging through a take-down and a price change', () => {
  const server = fakeServer();
  const alex = machine(U1, markPosted(markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', T(0), { salesperson: 'Alex' }), car(VIN_B, '2020 Jeep', 34995), 'website', T(1), { salesperson: 'Alex', listingUrl: 'https://www.facebook.com/marketplace/item/2/' }));
  const sam = machine(U2, markPosted({}, car(VIN_C, '2018 Honda', 21495), 'website', T(2), { salesperson: 'Sam' }));

  sync(server, alex);
  sync(server, sam);
  assert.deepEqual(Object.keys(sam.posted).sort(), [VIN_A, VIN_B, VIN_C].sort(), 'Sam sees Alex\'s cars after one sync');
  sync(server, alex);
  assert.deepEqual(prices(alex), prices(sam), 'and after Alex\'s next sync both registries agree');
  assert.deepEqual(prices(alex), listedOn(server));
  assert.equal(sam.posted[VIN_B].listingUrl, 'https://www.facebook.com/marketplace/item/2/', 'the listing link travels');
  assert.equal(sam.posted[VIN_A].salesperson, 'Alex');
  assert.equal(sam.posted[VIN_A].userId, U1, 'a colleague\'s entry remembers whose it is');

  // Alex sells the Ram and takes it down; Sam's machine drops it on its next sync
  alex.posted = markTakenDown(alex.posted, VIN_A);
  sync(server, alex);
  assert.equal(server.listings.find((r) => r.vin === VIN_A).status, 'taken_down');
  sync(server, sam);
  assert.equal(VIN_A in sam.posted, false);
  assert.deepEqual(prices(alex), prices(sam));

  // Sam drops the Honda's price; Alex's machine picks it up
  sam.posted = markPriceUpdated(sam.posted, VIN_C, 20995, T(50));
  sync(server, sam);
  sync(server, alex);
  assert.equal(alex.posted[VIN_C].price, 20995);
  assert.equal(alex.posted[VIN_C].updatedAt, T(50));
  assert.deepEqual(prices(alex), prices(sam));
  assert.deepEqual(prices(alex), listedOn(server));

  // Sam's own sync never touches Alex's rows: Sam has Alex's Jeep in the registry but the server keeps Alex as its owner
  assert.equal(server.listings.find((r) => r.vin === VIN_B).user_id, U1);

  // a third machine of Alex's, never synced, comes up to date and marks nothing down
  const alexLaptop = machine(U1, {});
  sync(server, alexLaptop);
  assert.deepEqual(prices(alexLaptop), prices(alex));
  assert.equal(server.listings.filter((r) => r.status === 'taken_down').length, 1, 'a first sync from an empty machine takes nothing down');
});

// The take-down rule compares server stamps only. Two traced cases from the
// review, both the same salesperson signed in on a showroom desktop and a
// laptop: a post whose upload from the desktop is delayed past a laptop
// sync, and a desktop clock six minutes slow. Under the old rule (the
// client's posted_at against since) the laptop's next sync marked the post
// taken down, the desktop could never relist it, and its merge dropped the
// entry from the registry that owned it.

test('the same salesperson on two machines: a post uploaded late from one is not taken down by the other, which never received it', () => {
  const server = fakeServer();
  const desktop = machine(U1, {});
  const laptop = machine(U1, {});
  sync(server, desktop);
  sync(server, laptop);

  // the desktop posts the Ram; its upload is delayed (offline, say) while the laptop syncs
  desktop.posted = markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', T(30), { salesperson: 'Alex' });
  sync(server, laptop);
  const laptopSince = laptop.since;

  // the desktop's upload arrives: the Ram was posted before the laptop's last sync, which is what the old rule tripped on
  sync(server, desktop);
  const ram = server.listings.find((r) => r.vin === VIN_A);
  assert.ok(Date.parse(ram.posted_at) < Date.parse(laptopSince), 'the post is older than the laptop\'s last sync');
  assert.ok(Date.parse(ram.created_at) > Date.parse(laptopSince), 'but the server first saw it after that sync');

  // the laptop syncs again without the Ram in its registry
  sync(server, laptop);
  assert.equal(ram.status, 'listed', 'the Ram stays listed');
  assert.equal(laptop.posted[VIN_A].price, 28995, 'and the laptop receives it');
  assert.equal(laptop.posted[VIN_A].userId, U1);

  // from then on both machines carry it through every sync
  sync(server, laptop);
  sync(server, desktop);
  assert.equal(ram.status, 'listed');
  assert.deepEqual(prices(desktop), prices(laptop));

  // a real take-down from the laptop still reaches the server and the desktop
  laptop.posted = markTakenDown(laptop.posted, VIN_A);
  sync(server, laptop);
  assert.equal(ram.status, 'taken_down');
  sync(server, desktop);
  assert.equal(VIN_A in desktop.posted, false);
});

test('a clock six minutes slow on one machine: its post survives the other machine\'s sync', () => {
  const server = fakeServer();
  const desktop = machine(U1, {});
  const laptop = machine(U1, {});
  sync(server, desktop);
  sync(server, laptop);

  // the desktop's clock is six minutes behind: the Ram it posts now is stamped before the laptop's last sync
  const slow = new Date(Date.parse(laptop.since) - 6 * 60 * 1000).toISOString();
  desktop.posted = markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', slow, { salesperson: 'Alex' });
  sync(server, desktop);
  const ram = server.listings.find((r) => r.vin === VIN_A);
  assert.equal(ram.posted_at, slow);
  assert.ok(Date.parse(ram.posted_at) < Date.parse(laptop.since), 'the post looks older than the laptop\'s last sync');

  sync(server, laptop);
  assert.equal(ram.status, 'listed', 'the server first saw the Ram after the laptop\'s last sync, whatever the desktop\'s clock said');
  assert.equal(laptop.posted[VIN_A].postedAt, slow);
  sync(server, desktop);
  assert.equal(VIN_A in desktop.posted, true);
  assert.equal(ram.status, 'listed');
});

test('a take-down right after the post\'s own sync counts at the very next sync (created_at is not after that sync\'s serverTime)', () => {
  const server = fakeServer();
  const desktop = machine(U1, {});
  sync(server, desktop);
  desktop.posted = markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', T(30), { salesperson: 'Alex' });
  sync(server, desktop);
  const ram = server.listings.find((r) => r.vin === VIN_A);
  assert.equal(ram.created_at, desktop.since);
  desktop.posted = markTakenDown(desktop.posted, VIN_A);
  sync(server, desktop);
  assert.equal(ram.status, 'taken_down');
});
