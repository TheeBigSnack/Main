// Sync (Milestone 4): the rows the function writes, the payload that goes
// up, the merge that comes down, and two machines converging on one
// registry through a small in-memory model of the sync function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toServerRows, syncPayload, mergeRegistry, mergeFlags, scanRow, scanSummary, nextSyncState, localDayRange, planFrom, postKey, SYNC_VERSION, MAX_KNOWN, UPLOAD_MARGIN_MS, FUTURE_SKEW_MS, flagsAwaitingSync, clearNumbersKeepingUnsynced, notSharedFrom } from '../extension/src/sync.js';
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
    listing_url: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex', updated_at: T(5), status: 'listed', taken_down_at: null, listed_before: false,
  });
  assert.deepEqual(listings[1], { dealership_id: D, user_id: U1, vin: VIN_B, name: '2020 Jeep', price: null, posted_at: T(1), listing_url: null, salesperson: null, updated_at: null, status: 'listed', taken_down_at: null, listed_before: false });
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

test('syncPayload: the caller\'s whole registry, only the pilot entries that changed since the last sync (by this machine\'s clock), the scan and since', () => {
  const posted = {
    [VIN_A]: { name: 'A', price: 1, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex', postedWith: '0.4.0' },
    [VIN_C]: { name: 'C', price: 3, postedAt: T(0), userId: U2 },
  };
  let pilot = beginPost(null, { vin: VIN_A, at: T(0) });
  pilot = endPost(pilot, VIN_A, 'posted', { at: T(1) });
  pilot = beginPost(pilot, { vin: VIN_B, at: T(20) });
  pilot = noteFlags(pilot, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [], warnings: [] }, { at: T(2) });
  const localSince = new Date(Date.parse(T(15)) + UPLOAD_MARGIN_MS).toISOString(); // T(15) once the margin is taken off
  const body = syncPayload({ origin: ORIGIN, posted, pilot, scan: { takenAt: T(30), cars: 10 }, since: T(15), localSince, userId: U1 });
  assert.equal(body.version, SYNC_VERSION);
  assert.equal(body.origin, ORIGIN);
  assert.deepEqual(Object.keys(body.posted), [VIN_A], 'the colleague\'s entry is theirs to sync');
  assert.deepEqual(body.posted[VIN_A], { name: 'A', price: 1, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Alex' }, 'postedWith stays local');
  assert.deepEqual(body.pilot.posts.map((a) => a.vin), [VIN_B], 'the attempt from before since is already on the server');
  assert.deepEqual(body.pilot.flags.map((f) => f.vin), [VIN_A], 'an open flag goes up on every sync, even one flagged before since');
  assert.deepEqual(body.scan, { takenAt: T(30), cars: 10, ready: null, takeDownCount: null, priceUpdateCount: null });
  assert.equal(body.since, T(15));
  assert.deepEqual(body.known, [], 'no known keys given: none go up, so the function takes nothing down');
  // never synced: everything goes
  const first = syncPayload({ origin: ORIGIN, posted, pilot, scan: null, since: null, userId: U1 });
  assert.equal(first.pilot.posts.length, 2);
  assert.equal(first.pilot.flags.length, 1);
  assert.equal(first.scan, null);
  assert.equal(first.since, null);
  assert.deepEqual(first.known, []);
  // a flag closed after since goes up again so the server closes it too
  const closed = resolveFlag(pilot, VIN_A, 'takeDown', { at: T(16), how: 'manual' });
  assert.equal(syncPayload({ origin: ORIGIN, posted, pilot: closed, since: T(15), localSince, userId: U1 }).pilot.flags.length, 1);
  // a flag closed before since is already closed on the server
  const closedBefore = resolveFlag(pilot, VIN_A, 'takeDown', { at: T(14), how: 'manual' });
  assert.deepEqual(syncPayload({ origin: ORIGIN, posted, pilot: closedBefore, since: T(15), localSince, userId: U1 }).pilot.flags, []);
  // the server's since never decides what goes up: with no localSince (a state from an older build) everything goes once
  assert.equal(syncPayload({ origin: ORIGIN, posted, pilot: closedBefore, since: T(15), userId: U1 }).pilot.posts.length, 2);
  // fills never leave the browser
  assert.equal('fills' in body.pilot, false);
});

test('syncPayload: an open price flag whose website price moved again goes up with the new prices, though its stamp is from before since', () => {
  let pilot = noteFlags(null, { takeDown: [], priceUpdates: [{ vin: VIN_A, name: 'A', yours: true, from: 20000, to: 19000 }], warnings: [] }, { at: T(2) });
  pilot = noteFlags(pilot, { takeDown: [], priceUpdates: [{ vin: VIN_A, name: 'A', yours: true, from: 20000, to: 18000 }], warnings: [] }, { at: T(20) });
  assert.equal(pilot.flags[0].flaggedAt, T(2), 'the open item keeps its stamp');
  const body = syncPayload({ origin: ORIGIN, posted: {}, pilot, since: T(15), localSince: T(15), userId: U1 });
  assert.deepEqual(body.pilot.flags.map((f) => [f.vin, f.from, f.to, f.flaggedAt]), [[VIN_A, 20000, 18000, T(2)]]);
});

test('syncPayload: a clock six minutes slow here still sends the post made and the to-do item ticked off just after a sync', () => {
  // since is the server's clock; this machine's stamps run six minutes behind it
  const since = T(30);
  const here = (min) => T(30 - 6 + min);
  let pilot = noteFlags(null, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [], warnings: [] }, { at: T(0) });
  pilot = beginPost(pilot, { vin: VIN_B, at: here(1) });
  pilot = endPost(pilot, VIN_B, 'posted', { at: here(2) });
  pilot = resolveFlag(pilot, VIN_A, 'takeDown', { at: here(2), how: 'manual' });
  assert.ok(Date.parse(here(2)) < Date.parse(since), 'both stamps look older than the last sync');
  // this machine's clock when that sync began: the cutoff comes from the same clock as the stamps
  const body = syncPayload({ origin: ORIGIN, posted: {}, pilot, since, localSince: here(0), userId: U1 });
  assert.deepEqual(body.pilot.posts.map((a) => a.vin), [VIN_B], 'the post attempt goes up');
  assert.deepEqual(body.pilot.flags.map((f) => [f.vin, Boolean(f.doneAt)]), [[VIN_A, true]], 'the closed to-do item goes up, so the server closes it');
  // entries from before the margin ahead of the last sync's start, by this machine's clock, are on the server already and stay here
  assert.deepEqual(syncPayload({ origin: ORIGIN, posted: {}, pilot, since: T(59), localSince: here(35), userId: U1 }).pilot.posts, []);
});

test('syncPayload sends the state\'s known keys as the function matches them: VIN@postedAt, each once, well formed, at most MAX_KNOWN', () => {
  assert.equal(postKey(VIN_A.toLowerCase(), '2026-11-16T09:00:00Z'), `${VIN_A}@${T(0)}`, 'the VIN in capitals, the time to the millisecond');
  assert.equal(postKey(VIN_A, 'not a time'), '');
  assert.equal(postKey('', T(0)), '');
  const body = syncPayload({ origin: ORIGIN, posted: {}, known: [`${VIN_A}@${T(0)}`, `${VIN_A.toLowerCase()}@2026-11-16T09:00:00.000+00:00`, `${VIN_B}@${T(1)}`, 'no key', `${VIN_C}@never`, 42, null], userId: U1 });
  assert.deepEqual(body.known, [`${VIN_A}@${T(0)}`, `${VIN_B}@${T(1)}`], 'the same post spelled twice is one key; what is no key is left out');
  assert.deepEqual(syncPayload({ origin: ORIGIN, known: 'not a list' }).known, []);
  const many = Array.from({ length: MAX_KNOWN + 5 }, (_, i) => `TESTVIN${String(i).padStart(10, '0')}@${T(0)}`);
  const capped = syncPayload({ origin: ORIGIN, known: many }).known;
  assert.equal(capped.length, MAX_KNOWN, 'the function refuses more than MAX_ROWS; a key left out can only miss a take-down');
  assert.deepEqual(capped, many.slice(0, MAX_KNOWN));
});

test('syncPayload sends the caller\'s local calendar day as today: { from, to }, the day cap.js counts, so the server can count their posts in it', () => {
  const at = new Date(2026, 10, 16, 15, 30); // a local afternoon
  const body = syncPayload({ origin: ORIGIN, posted: {}, now: at });
  assert.deepEqual(body.today, { from: new Date(2026, 10, 16).toISOString(), to: new Date(2026, 10, 17).toISOString() });
  assert.deepEqual(localDayRange(at), body.today);
  assert.deepEqual(localDayRange(at.toISOString()), body.today, 'an ISO stamp works too');
  assert.deepEqual(localDayRange(at.getTime()), body.today, 'and milliseconds');
  // the range is the local day, half-open, so a post at 23:59 local counts on the day it was made, wherever the server sits
  const late = new Date(2026, 10, 16, 23, 59);
  assert.ok(Date.parse(localDayRange(late).from) <= late.getTime() && late.getTime() < Date.parse(localDayRange(late).to));
  assert.deepEqual(localDayRange(late), body.today, 'the same day');
  assert.notDeepEqual(localDayRange(new Date(2026, 10, 17, 0, 0)), body.today, 'midnight starts the next one');
  // the span is a day (23 to 25 hours on a clock-change day; the function accepts up to 48)
  const span = Date.parse(body.today.to) - Date.parse(body.today.from);
  assert.ok(span >= 23 * 3600 * 1000 && span <= 25 * 3600 * 1000);
  assert.equal(localDayRange('nonsense'), null);
  assert.ok(syncPayload({ origin: ORIGIN }).today, 'the moment defaults to now');
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

test('mergeRegistry: a change stamped more than FUTURE_SKEW_MS ahead of the server\'s clock never outranks a later one', () => {
  const fn = readFileSync(new URL('../supabase/functions/sync/index.ts', import.meta.url), 'utf8');
  const skew = fn.match(/const FUTURE_SKEW_MS = ([\d *]+);/)[1].split('*').reduce((a, b) => a * Number(b), 1);
  assert.equal(FUTURE_SKEW_MS, skew, 'the sync function\'s FUTURE_SKEW_MS');
  const ahead = T(10 + 6 * 60); // a clock 6 hours ahead
  const local = { [VIN_A]: { name: 'A', price: 19000, postedAt: T(0), updatedAt: ahead, userId: U1 } };
  const sent = { [VIN_A]: { name: 'A', price: 19000, postedAt: T(0), updatedAt: ahead } };
  // the request carried the change: the server wrote it as made at its own time, and that stamp replaces the one from the future
  const taken = mergeRegistry(local, { serverTime: T(11), listings: [row(VIN_A, { user_id: U1, price: 19000, updated_at: T(10) })] }, { userId: U1, sent });
  assert.deepEqual([taken[VIN_A].price, taken[VIN_A].updatedAt], [19000, T(10)]);
  // a later change made elsewhere since then wins as well
  const later = mergeRegistry(local, { serverTime: T(31), listings: [row(VIN_A, { user_id: U1, price: 18000, updated_at: T(30) })] }, { userId: U1, sent });
  assert.deepEqual([later[VIN_A].price, later[VIN_A].updatedAt], [18000, T(30)]);
  // a change made here while the request was out has not reached the server yet: it is kept and goes up next time
  const meanwhile = mergeRegistry(local, { serverTime: T(11), listings: [row(VIN_A, { user_id: U1, price: 20000, updated_at: null })] }, { userId: U1, sent: { [VIN_A]: { ...sent[VIN_A], updatedAt: undefined } } });
  assert.deepEqual([meanwhile[VIN_A].price, meanwhile[VIN_A].updatedAt], [19000, ahead]);
  // without the server's clock nothing is known to be ahead: the newest stamp wins, as before
  assert.equal(mergeRegistry(local, [row(VIN_A, { user_id: U1, price: 18000, updated_at: T(30) })], { userId: U1, sent })[VIN_A].price, 19000);
  // a server stamp that far ahead counts as no change time: a real change made here wins and goes up
  const mine = { [VIN_A]: { name: 'A', price: 17500, postedAt: T(0), updatedAt: T(20), userId: U1 } };
  const theirs = mergeRegistry(mine, { serverTime: T(21), listings: [row(VIN_A, { user_id: U1, price: 30000, updated_at: ahead })] }, { userId: U1 });
  assert.deepEqual([theirs[VIN_A].price, theirs[VIN_A].updatedAt], [17500, T(20)]);
  // a stamp just inside the margin is a clock a little fast, and still counts
  const near = T(11 + 4); // 4 minutes ahead of the server
  const fine = mergeRegistry({ [VIN_A]: { ...local[VIN_A], updatedAt: near } }, { serverTime: T(11), listings: [row(VIN_A, { user_id: U1, price: 18000, updated_at: T(10) })] }, { userId: U1, sent: { [VIN_A]: { ...sent[VIN_A], updatedAt: near } } });
  assert.deepEqual([fine[VIN_A].price, fine[VIN_A].updatedAt], [19000, near]);
});

test('mergeRegistry: a missing link, name or salesperson is filled from the server; the newer post of a car re-posted elsewhere replaces the old one', () => {
  const local = { [VIN_A]: { name: '', price: 1, postedAt: T(0), postedWith: '0.4.0' } };
  const filled = mergeRegistry(local, [row(VIN_A, { listing_url: 'https://www.facebook.com/marketplace/item/9/', user_id: U1 })]);
  assert.deepEqual(filled[VIN_A], { name: 'Car A1', price: 1, postedAt: T(0), postedWith: '0.4.0', listingUrl: 'https://www.facebook.com/marketplace/item/9/', salesperson: 'Sam', userId: U1 });
  const reposted = mergeRegistry(local, [row(VIN_A, { posted_at: T(0) , status: 'taken_down', taken_down_at: T(5) }), row(VIN_A, { posted_at: T(6), price: 7 })]);
  assert.deepEqual(reposted[VIN_A], { name: 'Car A1', price: 7, postedAt: T(6), postedWith: '0.4.0', salesperson: 'Sam', userId: U2 });
});

// forget_person clears a departed salesperson's name on the server (0006_privacy.sql), but a colleague's
// machine that synced before kept it on every car of theirs still listed: a name was only ever filled in
test('mergeRegistry: a colleague\'s entry follows the server\'s salesperson name, a cleared one included; the caller\'s own keeps theirs', () => {
  const local = {
    [VIN_A]: { name: 'Car A1', price: 20000, postedAt: T(0), salesperson: 'Jane Colleague', userId: U2, mine: false },
    [VIN_B]: { name: 'Car B2', price: 20000, postedAt: T(0), salesperson: 'Alex', userId: U1 },
  };
  // what forget_person leaves: the colleague's row still listed, under their bare account id, with no name
  for (const updated of [null, T(5)]) {
    const out = mergeRegistry(local, [row(VIN_A, { salesperson: null, updated_at: updated }), row(VIN_B, { user_id: U1, salesperson: null, updated_at: updated })], { userId: U1 });
    assert.equal('salesperson' in out[VIN_A], false, `the cleared name leaves the colleague's copy (updated_at ${updated})`);
    assert.deepEqual([out[VIN_A].userId, out[VIN_A].mine], [U2, false], 'the entry stays the colleague\'s, under the id the server keeps');
    assert.equal(out[VIN_B].salesperson, 'Alex', 'the caller\'s own entry keeps the name from their Settings');
  }
  // a name the owner corrected on the server reaches the colleague's copy too
  assert.equal(mergeRegistry(local, [row(VIN_A, { salesperson: 'Jane C.' })], { userId: U1 })[VIN_A].salesperson, 'Jane C.');
  // without the caller's id nobody's row is known to be a colleague's: a missing name is only filled in
  assert.equal(mergeRegistry(local, [row(VIN_A, { salesperson: null })])[VIN_A].salesperson, 'Jane Colleague');
});

// Round H review: Taken down clicked while a sync was out came back with that
// sync's answer, which still listed the car (the request carried it).
test('mergeRegistry: the caller\'s listed row the request sent and the registry dropped meanwhile is not put back; anything else still is', () => {
  const sent = { [VIN_A]: { name: 'A', price: 1, postedAt: T(0) }, [VIN_B]: { name: 'B', price: 2, postedAt: T(1) } };
  const remote = { listings: [row(VIN_A, { user_id: U1, posted_at: T(0) }), row(VIN_B, { user_id: U1, posted_at: T(1) }), row(VIN_C, { user_id: U1, posted_at: T(2) })] };
  const current = { [VIN_B]: sent[VIN_B] }; // A was taken down here while the request was out
  const out = mergeRegistry(current, remote, { userId: U1, sent });
  assert.deepEqual(Object.keys(out).sort(), [VIN_B, VIN_C], 'A stays gone; C, a post of the caller\'s from another machine, arrives');
  assert.deepEqual(Object.keys(mergeRegistry(current, remote, { userId: U1 })).sort(), [VIN_A, VIN_B, VIN_C], 'without what was sent, a missing row is one to add');
  // a newer post of the car from another machine is another post: it arrives
  const reposted = mergeRegistry(current, { listings: [row(VIN_A, { user_id: U1, posted_at: T(0) }), row(VIN_A, { user_id: U1, posted_at: T(9) })] }, { userId: U1, sent });
  assert.equal(reposted[VIN_A].postedAt, T(9));
  // a colleague's row is theirs: the caller never sends it, and it is added back as theirs whatever `sent` says
  const theirs = mergeRegistry({}, { listings: [row(VIN_A, { user_id: U2, posted_at: T(0) })] }, { userId: U1, sent });
  assert.equal(theirs[VIN_A].mine, false);
});

test('mergeRegistry: the same post read listed and then taken down in one answer counts as taken down', () => {
  const local = { [VIN_A]: { name: 'A', price: 1, postedAt: T(0), userId: U1 } };
  const listed = row(VIN_A, { user_id: U1, posted_at: T(0) });
  const down = { ...listed, status: 'taken_down', taken_down_at: T(5) };
  assert.deepEqual(mergeRegistry(local, { listings: [listed, down] }, { userId: U1 }), {}, 'removed here too');
  assert.deepEqual(mergeRegistry({}, { listings: [listed, down] }, { userId: U1 }), {}, 'and never added');
  assert.deepEqual(mergeRegistry({}, { listings: [down, listed] }, { userId: U1 }), {}, 'in either order');
});

test('toServerRows and syncPayload store a number too big for an integer column as unknown, as the sync function does', () => {
  const huge = 2499525495;
  const posted = { [VIN_A]: { name: 'A', price: huge, postedAt: T(0) }, [VIN_B]: { name: 'B', price: '2147483647', postedAt: T(1) } };
  const pilot = { posts: [{ vin: VIN_A, startedAt: T(0), endedAt: T(1), outcome: 'posted', seconds: 9e12 }], flags: [{ vin: VIN_A, kind: 'price', flaggedAt: T(2), from: 20000, to: huge }] };
  const rows = toServerRows({ posted, pilot, userId: U1 });
  assert.deepEqual(rows.listings.map((l) => l.price), [null, 2147483647]);
  assert.equal(rows.postAttempts[0].seconds, null);
  assert.deepEqual([rows.todoItems[0].from_price, rows.todoItems[0].to_price], [20000, null]);
  assert.equal(syncPayload({ posted, userId: U1 }).posted[VIN_A].price, null);
  assert.equal(scanSummary({ takenAt: T(3), cars: -3e9, ready: 1 }).cars, null);
});

test('mergeFlags: a flag closed on another machine closes here; nothing is reopened, and without the registry nothing is added', () => {
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

test('mergeFlags: the same sold car or price change flagged on the salesperson\'s other machine is one item: its time is taken, and its close closes the flag here', () => {
  // this machine (the laptop) flagged three items at its own scan, T(20)
  const pilot = noteFlags(null, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [{ vin: VIN_B, name: 'B', yours: true, from: 2, to: 1 }, { vin: VIN_C, name: 'C', yours: true, from: 3, to: 2 }], warnings: [] }, { at: T(20) });
  const remote = {
    todoItems: [
      // the desktop flagged A at T(10) and ticked it off at T(40)
      { vin: VIN_A, kind: 'takeDown', flagged_at: T(10), done_at: T(40), how: 'manual' },
      // the desktop flagged B at T(5); still open
      { vin: VIN_B, kind: 'price', flagged_at: T(5), done_at: null },
      // C: an older item of the same car, closed before this flag was raised, is another item
      { vin: VIN_C, kind: 'price', flagged_at: T(1), done_at: T(15), how: 'detected' },
    ],
  };
  const merged = mergeFlags(pilot, remote);
  const flag = (vin) => merged.flags.find((f) => f.vin === vin);
  assert.equal(merged.flags.length, 3, 'nothing added');
  assert.deepEqual([flag(VIN_A).doneAt, flag(VIN_A).how, flag(VIN_A).flaggedAt], [T(40), 'manual', T(20)], 'closed here as it was closed there');
  assert.deepEqual([flag(VIN_B).flaggedAt, flag(VIN_B).doneAt], [T(5), undefined], 'still open, under the first sighting\'s time');
  assert.deepEqual([flag(VIN_C).flaggedAt, flag(VIN_C).doneAt], [T(20), undefined], 'left as it is');
  assert.deepEqual(mergeFlags(merged, remote), merged, 'a second answer changes nothing');
  // a flag raised after the other machine's item closed is a new item
  const later = noteFlags(null, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [], warnings: [] }, { at: T(45) });
  assert.deepEqual(mergeFlags(later, remote), later);
});

test('mergeFlags: a flag the merged registry shows already handled, with no item open on the server, was raised from a registry that had not heard of the fix, and is dropped', () => {
  // this machine's rescan ran on its registry from before a fix made on the
  // salesperson's other machine: A's sale, B's price drop to 19000, C's to 18000
  const pilot = noteFlags(null, { takeDown: [{ vin: VIN_A, name: 'A', yours: true }], priceUpdates: [{ vin: VIN_B, name: 'B', yours: true, from: 20000, to: 19000 }, { vin: VIN_C, name: 'C', yours: true, from: 20000, to: 18000 }], warnings: [] }, { at: T(50) });
  // the registry this sync merged: A is down, B is at the website price, C is not yet
  const registry = { [VIN_B]: { name: 'B', price: 19000, postedAt: T(0), updatedAt: T(30) }, [VIN_C]: { name: 'C', price: 19500, postedAt: T(0), updatedAt: T(30) } };
  // the other machine's items, closed before this flag was raised (or long ago, and not in the answer at all)
  const closedThere = { todoItems: [{ vin: VIN_A, kind: 'takeDown', flagged_at: T(10), done_at: T(30), how: 'manual' }, { vin: VIN_B, kind: 'price', flagged_at: T(10), done_at: T(30), how: 'manual', from_price: 20000, to_price: 19000 }] };
  for (const remote of [closedThere, { todoItems: [] }]) {
    const merged = mergeFlags(pilot, remote, { posted: registry });
    assert.deepEqual(merged.flags.map((f) => [f.vin, f.kind, f.doneAt]), [[VIN_C, 'price', undefined]], 'A and B dropped; C, which the listing does not show, kept open');
  }
  // an item open on the server (this flag's own, or the other machine's) is followed as before, whatever the registry says
  const open = { todoItems: [{ vin: VIN_A, kind: 'takeDown', flagged_at: T(50), done_at: null }, { vin: VIN_B, kind: 'price', flagged_at: T(20), done_at: null }] };
  const followed = mergeFlags(pilot, open, { posted: registry });
  assert.deepEqual(followed.flags.map((f) => [f.vin, f.flaggedAt, f.doneAt]), [[VIN_A, T(50), undefined], [VIN_B, T(20), undefined], [VIN_C, T(50), undefined]]);
  // a colleague's entry of the car is not the salesperson's own: B's flag stands
  assert.equal(mergeFlags(pilot, { todoItems: [] }, { posted: { ...registry, [VIN_B]: { ...registry[VIN_B], mine: false } } }).flags.length, 2);
  // without the registry nothing is dropped, and a closed flag is never touched
  assert.deepEqual(mergeFlags(pilot, closedThere), pilot);
  const ticked = resolveFlag(pilot, VIN_B, 'price', { at: T(55), how: 'manual' });
  assert.deepEqual(mergeFlags(ticked, { todoItems: [] }, { posted: registry }).flags.map((f) => [f.vin, Boolean(f.doneAt)]), [[VIN_B, true], [VIN_C, false]]);
});

// A machine that no longer holds an open item (Clear the numbers before it
// kept open items, Clear everything for this website) would open a second
// one at its next scan and close only that one: the first stayed open on
// the manager's list for good. It takes the item in instead.
test('mergeFlags: an open item on one of the caller\'s own listings that this machine does not hold is taken in with its flagging time', () => {
  const posted = {
    [VIN_A]: { name: 'A', price: 20000, postedAt: T(-60), userId: U1 },
    [VIN_B]: { name: 'B', price: 21000, postedAt: T(-60) },
    [VIN_C]: { name: 'C', price: 22000, postedAt: T(-60), userId: U2, mine: false },
    TESTVIN00000000D4: { name: 'D', price: 23000, postedAt: T(5), userId: U1 },
  };
  const remote = {
    todoItems: [
      { dealership_id: D, vin: VIN_A.toLowerCase(), kind: 'takeDown', name: 'A', flagged_at: T(0), done_at: null, how: null },
      { dealership_id: D, vin: VIN_B, kind: 'price', name: 'B', flagged_at: T(0), done_at: null, how: null, from_price: 21000, to_price: 20500 },
      { dealership_id: D, vin: VIN_C, kind: 'takeDown', name: 'C', flagged_at: T(0), done_at: null, how: null }, // a colleague's listing
      { dealership_id: D, vin: 'TESTVIN00000000D4', kind: 'takeDown', name: 'D', flagged_at: T(0), done_at: null, how: null }, // flagged before this post of the car
      { dealership_id: D, vin: VIN_B, kind: 'takeDown', name: 'B', flagged_at: T(1), done_at: T(2), how: 'manual' }, // closed
      { dealership_id: D, vin: VIN_A, kind: 'bogus', flagged_at: T(0), done_at: null },
    ],
  };
  const merged = mergeFlags(null, remote, { posted, userId: U1 });
  assert.deepEqual(merged.flags, [
    { vin: VIN_A, kind: 'takeDown', name: 'A', flaggedAt: T(0) },
    { vin: VIN_B, kind: 'price', name: 'B', flaggedAt: T(0), from: 21000, to: 20500 },
  ]);
  // held already (open or closed here): not taken in twice, never reopened
  assert.deepEqual(mergeFlags(merged, remote, { posted, userId: U1 }), merged);
  const closedHere = resolveFlag(merged, VIN_A, null, { at: T(9), how: 'manual' });
  assert.deepEqual(mergeFlags(closedHere, remote, { posted, userId: U1 }), closedHere);
  // and it closes the dealership's item it came from
  const up = syncPayload({ origin: ORIGIN, posted, pilot: closedHere, since: null, userId: U1, now: new Date(T(10)) });
  assert.deepEqual(up.pilot.flags.filter((f) => f.doneAt).map((f) => [f.vin, f.kind, f.flaggedAt]), [[VIN_A, 'takeDown', T(0)]]);
});

// "Clear the numbers": a to-do flag closed since the last sync has not gone
// up yet, and only its upload closes the dealership's copy of the item.
test('clearNumbersKeepingUnsynced keeps the closed to-do items the next sync still sends, and only while there is a last sync to measure from', () => {
  const gone = (vin) => ({ vin, name: vin, yours: true, why: 'gone' });
  let pilot = noteFlags(null, { takeDown: [gone(VIN_A), gone(VIN_B), gone(VIN_C)], priceUpdates: [], warnings: [] }, { at: T(0) });
  pilot = resolveFlag(pilot, VIN_A, null, { at: T(10), how: 'manual' }); // closed, then the T(30) sync sent it
  pilot = resolveFlag(pilot, VIN_B, null, { at: T(35), how: 'manual' }); // Taken down after that sync
  pilot = beginPost(pilot, { vin: VIN_C, at: T(1) });
  pilot = endPost(pilot, VIN_C, 'posted', { at: T(2) });
  const state = { version: SYNC_VERSION, since: T(30), localSince: T(30), known: [] };
  const sent = syncPayload({ origin: ORIGIN, posted: {}, pilot, since: state.since, localSince: state.localSince, userId: U1 }).pilot.flags.filter((f) => f.doneAt);
  assert.deepEqual(flagsAwaitingSync(pilot, state), sent, 'exactly the closed flags the next sync sends');
  const kept = clearNumbersKeepingUnsynced(pilot, state);
  assert.deepEqual(kept.flags.map((f) => [f.vin, f.doneAt || null]), [[VIN_B, T(35)], [VIN_C, null]], 'the closed one not sent yet and the open one stay');
  assert.deepEqual(kept.posts, [], 'the finished post goes');
  // the next sync sends it closed, and a clear after that one lets it go
  assert.deepEqual(syncPayload({ origin: ORIGIN, posted: {}, pilot: kept, since: state.since, localSince: state.localSince, userId: U1 }).pilot.flags.filter((f) => f.doneAt).map((f) => f.vin), [VIN_B]);
  assert.deepEqual(clearNumbersKeepingUnsynced(kept, { ...state, since: T(50), localSince: T(50) }).flags.map((f) => f.vin), [VIN_C]);
  // a flag closed within UPLOAD_MARGIN_MS before the last sync began (that sync may have read storage before it was written) still waits for it
  assert.deepEqual(flagsAwaitingSync(resolveFlag(pilot, VIN_C, null, { at: T(25) }), state).map((f) => f.vin), [VIN_B, VIN_C]);
  // a state from a build that kept no localSince: the next sync sends every closed flag, so every one waits
  assert.deepEqual(flagsAwaitingSync(pilot, { version: SYNC_VERSION, since: T(30), known: [] }).map((f) => f.vin), [VIN_A, VIN_B]);
  // no last sync (never synced here, a first sync still pending, or Sign out forgot the state): nothing waits
  for (const none of [null, undefined, {}, { version: SYNC_VERSION, since: null, known: [], pending: true }, 'garbage']) {
    assert.deepEqual(flagsAwaitingSync(pilot, none), []);
    assert.deepEqual(clearNumbersKeepingUnsynced(pilot, none).flags.map((f) => f.vin), [VIN_C]);
  }
});

test('the state kept for the next sync: since, the dealership, the role, the plan and the server\'s count of today\'s posts', () => {
  const today = { from: T(0), to: new Date(Date.UTC(2026, 10, 17, 9, 0)).toISOString() };
  const s = nextSyncState(null, { serverTime: T(1), dealership: { id: D, name: 'Example Motors' }, role: 'salesperson' });
  assert.deepEqual(s, { version: SYNC_VERSION, since: T(1), localSince: null, known: [], dealershipId: D, dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: T(1), plan: null, postsToday: null, notShared: [] }, 'an answer without a plan or a count (an older function) leaves both null');
  assert.equal(nextSyncState(s, { ok: false }).since, T(1), 'a failed answer keeps the last state');
  const plan = { state: 'pilot', pilotEndsAt: T(30), currentPeriodEnd: null, seats: 5 };
  const s2 = nextSyncState(s, { serverTime: T(2), plan, postsToday: 3 }, { today, localSince: T(1, 50) });
  assert.equal(s2.localSince, T(1, 50), 'the machine\'s own clock when this sync began, for what goes up next');
  assert.deepEqual(s2.plan, plan);
  assert.deepEqual(s2.postsToday, { count: 3, from: today.from, to: today.to });
  assert.equal(s2.dealershipName, 'Example Motors', 'what the answer leaves out is kept');
  assert.equal(s2.since, T(2));
  // a count without the day it was counted in is no count; null from the server (no usable today) is null here; so is a bad number
  assert.equal(nextSyncState(s2, { serverTime: T(3), postsToday: 3 }).postsToday, null);
  assert.equal(nextSyncState(s2, { serverTime: T(3), postsToday: null }, { today }).postsToday, null);
  assert.equal(nextSyncState(s2, { serverTime: T(3), postsToday: -1 }, { today }).postsToday, null);
  assert.equal(nextSyncState(s2, { serverTime: T(3), postsToday: '3' }, { today }).postsToday, null);
  assert.equal(nextSyncState(s2, { serverTime: T(3), postsToday: 0 }, { today }).postsToday.count, 0, 'zero is a count');
  assert.equal(nextSyncState(s2, { serverTime: T(3), postsToday: 2 }, { today: { from: 'x', to: today.to } }).postsToday, null, 'a day that does not parse is no day');
  // a 402 carries the plan and nothing else: the plan is replaced; since and the count are not invented
  const lapsed = nextSyncState(s2, { ok: false, error: 'lapsed', code: 'lapsed', plan: { state: 'lapsed', pilotEndsAt: T(0), currentPeriodEnd: null, seats: null } });
  assert.deepEqual(lapsed.plan, { state: 'lapsed', pilotEndsAt: T(0), currentPeriodEnd: null, seats: null });
  assert.equal(lapsed.since, T(2));
  assert.equal(nextSyncState(s2, { ok: false, code: 'lapsed' }, { localSince: T(9) }).localSince, T(1, 50), 'an answer that did not sync keeps the last localSince');
  assert.equal(lapsed.lastSyncAt, T(2));
  assert.equal(lapsed.postsToday, null);
  // an answer without a plan keeps the last one learned
  assert.deepEqual(nextSyncState(lapsed, { serverTime: T(4) }).plan, lapsed.plan);
  // known: the caller's own posts the request sent, and their own listed rows that came back; a 402 keeps the last list
  const sent = { [VIN_A]: { postedAt: T(0) }, [VIN_B.toLowerCase()]: { vin: VIN_B, postedAt: T(1) }, NOTIME: { price: 1 } };
  const answer = { serverTime: T(5), listings: [row(VIN_A, { user_id: U1, posted_at: T(0) }), row(VIN_C, { user_id: U1, posted_at: T(2) }), row(VIN_C, { user_id: U1, posted_at: T(1), status: 'taken_down', taken_down_at: T(3) }), row('TESTVIN00000000D4', { user_id: U2, posted_at: T(3) })] };
  const k = nextSyncState(s2, answer, { sent, userId: U1 });
  assert.deepEqual(k.known, [`${VIN_A}@${T(0)}`, `${VIN_B}@${T(1)}`, `${VIN_C}@${T(2)}`], 'sent, then received: never a colleague\'s row or a taken-down one');
  assert.deepEqual(nextSyncState(k, { ok: false, code: 'lapsed', plan: { state: 'lapsed' } }).known, k.known, 'nothing synced, the last list stands');
  assert.deepEqual(nextSyncState(k, { serverTime: T(6), listings: [] }, { sent: {}, userId: U1 }).known, [], 'an empty registry sent and nothing received: nothing known');
  assert.deepEqual(nextSyncState(null, answer, { sent: {} }).known, [], 'with no user to tell whose rows are whose, nothing received is known');
  // the plan is one shape: dates as ISO text, seats an integer or null, an unknown word as none, not an object as no plan
  assert.deepEqual(planFrom({ state: 'active', pilotEndsAt: null, currentPeriodEnd: '2026-12-01T00:00:00+00:00', seats: '7' }), { state: 'active', pilotEndsAt: null, currentPeriodEnd: '2026-12-01T00:00:00.000Z', seats: null });
  assert.deepEqual(planFrom({ state: 'active', seats: 7 }), { state: 'active', pilotEndsAt: null, currentPeriodEnd: null, seats: 7 });
  assert.equal(planFrom({ state: 'gold' }).state, 'none');
  assert.equal(planFrom('pilot'), null);
  assert.equal(planFrom(null), null);
});

// The sync function skips an upload of a VIN a colleague has up
// (counts.conflicts) and sets aside a post stamped more than FUTURE_SKEW_MS
// ahead of its clock (counts.rejected). The person is told which of their
// posts the dealership's list does not hold, read off the answer, which
// carries every listing that is up.
test('a post the function refused, because a colleague has the car up or because its time is ahead of the server\'s clock, is named in the state until a sync shares it', () => {
  const VIN_D = 'TESTVIN00000000D4';
  const VIN_E = 'TESTVIN00000000E5';
  const fn = readFileSync(new URL('../supabase/functions/sync/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /^const FUTURE_SKEW_MS = 5 \* 60 \* 1000;/m, 'the function\'s skew and FUTURE_SKEW_MS here are the same');
  assert.equal(FUTURE_SKEW_MS, 5 * 60 * 1000);
  // Pat (U2) posted the Ram at 09:10; this salesperson's machine, last synced at 09:00, still offered it, and they posted it at 09:30
  const local = {
    [VIN_A]: { name: 'Ram', price: 28995, postedAt: T(30) }, // refused: Pat has it up
    [VIN_B]: { name: 'Jeep', price: 34995, postedAt: T(5) }, // shared
    [VIN_C]: { name: 'Honda', price: 21495, postedAt: T(39) }, // made while the request was out, no colleague: goes up next time
    [VIN_D]: { name: 'Ford', price: 15995, postedAt: T(50) }, // stamped ten minutes past the server's 09:40
  };
  const answer = { serverTime: T(40), counts: { conflicts: 1, rejected: 1 }, listings: [row(VIN_A, { user_id: U2, posted_at: T(10), salesperson: 'Pat' }), row(VIN_B, { user_id: U1, posted_at: T(5) }), row(VIN_E, { user_id: U2, posted_at: T(1) })] };
  const held = mergeRegistry(local, answer, { userId: U1 });
  assert.deepEqual(held[VIN_A], local[VIN_A], 'the person\'s own Ram stays theirs here (it goes up again)');
  const expected = [{ vin: VIN_A, postedAt: T(30), reason: 'colleague', by: 'Pat' }, { vin: VIN_D, postedAt: T(50), reason: 'clock' }];
  assert.deepEqual(notSharedFrom(held, answer, { userId: U1 }), expected);
  const state = nextSyncState({ since: T(0) }, answer, { sent: local, userId: U1, held });
  assert.deepEqual(state.notShared, expected, 'kept for My listings and Settings');
  assert.deepEqual(nextSyncState(state, { ok: false, code: 'lapsed', plan: { state: 'lapsed' } }).notShared, expected, 'a 402 synced nothing: the list stands');
  // Pat takes the Ram down and the clock is put right: the next sync shares both, and the list empties
  const later = { serverTime: T(59), listings: [row(VIN_A, { user_id: U2, posted_at: T(10), status: 'taken_down', taken_down_at: T(55) }), row(VIN_A, { user_id: U1, posted_at: T(30) }), row(VIN_B, { user_id: U1, posted_at: T(5) }), row(VIN_D, { user_id: U1, posted_at: T(50) })] };
  assert.deepEqual(nextSyncState(state, later, { userId: U1, held: mergeRegistry(held, later, { userId: U1 }) }).notShared, []);
  // a colleague's entry is never the person's to share, and without a user or a serverTime nothing is said
  assert.deepEqual(notSharedFrom({ [VIN_E]: { postedAt: T(1), userId: U2, mine: false } }, answer, { userId: U1 }), []);
  assert.deepEqual(notSharedFrom(held, answer, {}), []);
  assert.deepEqual(notSharedFrom(held, { listings: answer.listings }, { userId: U1 }), []);
  assert.deepEqual(notSharedFrom(null, answer, { userId: U1 }), []);
});

// ---------- two machines converge ----------

// A small model of the sync function (supabase/functions/sync/index.ts):
// the caller's rows are upserted (a row of another user is never touched,
// a taken-down row is never relisted), the caller's listed rows whose key
// is in `known` (the posts that machine sent or received at its last sync)
// and missing from the registry are taken down (no time is compared), and
// the whole current registry comes back.
function fakeServer() {
  const listings = [];
  const clock = { t: Date.UTC(2026, 10, 16, 12, 0, 0) };
  const tick = () => new Date((clock.t += 1000)).toISOString();
  return {
    listings,
    sync(userId, body) {
      const now = tick();
      const rows = toServerRows({ origin: body.origin, posted: body.posted, pilot: body.pilot, dealershipId: D, userId });
      const sent = new Set(rows.listings.map((r) => postKey(r.vin, r.posted_at)));
      const known = new Set(body.known);
      for (const r of listings) {
        const key = postKey(r.vin, r.posted_at);
        if (r.user_id === userId && r.status === 'listed' && known.has(key) && !sent.has(key)) {
          r.status = 'taken_down';
          r.taken_down_at = now;
        }
      }
      for (const incoming of rows.listings) {
        const have = listings.find((r) => r.vin === incoming.vin && r.posted_at === incoming.posted_at);
        if (!have) {
          listings.push({ id: `${incoming.vin}@${incoming.posted_at}`, ...incoming });
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
  return { userId, posted, state: null };
}

// One round the way src/accountFlow.js syncOnce runs it.
function sync(server, m) {
  const since = m.state ? m.state.since : null;
  const body = syncPayload({ origin: ORIGIN, posted: m.posted, known: m.state && m.state.known, pilot: null, scan: null, since, userId: m.userId });
  const answer = server.sync(m.userId, body);
  m.posted = mergeRegistry(m.posted, answer, { since, userId: m.userId, sent: body.posted });
  m.state = nextSyncState(m.state, answer, { sent: body.posted, userId: m.userId });
  return answer;
}
const knows = (m, vin, postedAt) => Boolean(m.state && m.state.known.includes(postKey(vin, postedAt)));

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
  assert.deepEqual(syncPayload({ origin: ORIGIN, posted: {}, known: null, userId: U1 }).known, [], 'it knows nothing yet');
  sync(server, alexLaptop);
  assert.deepEqual(prices(alexLaptop), prices(alex));
  assert.equal(server.listings.filter((r) => r.status === 'taken_down').length, 1, 'a first sync from an empty machine takes nothing down');
});

// The take-down rule compares keys the machine knew, never times. Two traced
// cases from the review, both the same salesperson signed in on a showroom
// desktop and a laptop: a post whose upload from the desktop is delayed past
// a laptop sync, and a desktop clock six minutes slow. Under an older rule
// (the client's posted_at against since) the laptop's next sync marked the
// post taken down, the desktop could never relist it, and its merge dropped
// the entry from the registry that owned it. The rule after it (the
// server's created_at against since) still took down a post whose insert
// committed after the laptop's reads (test/fn-sync-race.test.js).

test('the same salesperson on two machines: a post uploaded late from one is not taken down by the other, which never received it', () => {
  const server = fakeServer();
  const desktop = machine(U1, {});
  const laptop = machine(U1, {});
  sync(server, desktop);
  sync(server, laptop);

  // the desktop posts the Ram; its upload is delayed (offline, say) while the laptop syncs
  desktop.posted = markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', T(30), { salesperson: 'Alex' });
  sync(server, laptop);
  const laptopSince = laptop.state.since;

  // the desktop's upload arrives: the Ram was posted before the laptop's last sync, which is what the oldest rule tripped on
  sync(server, desktop);
  const ram = server.listings.find((r) => r.vin === VIN_A);
  assert.ok(Date.parse(ram.posted_at) < Date.parse(laptopSince), 'the post is older than the laptop\'s last sync');
  assert.equal(knows(laptop, VIN_A, ram.posted_at), false, 'but the laptop never sent or received it');

  // the laptop syncs again without the Ram in its registry
  sync(server, laptop);
  assert.equal(ram.status, 'listed', 'the Ram stays listed');
  assert.equal(laptop.posted[VIN_A].price, 28995, 'and the laptop receives it');
  assert.equal(laptop.posted[VIN_A].userId, U1);
  assert.equal(knows(laptop, VIN_A, ram.posted_at), true, 'and knows it from then on');

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
  const slow = new Date(Date.parse(laptop.state.since) - 6 * 60 * 1000).toISOString();
  desktop.posted = markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', slow, { salesperson: 'Alex' });
  sync(server, desktop);
  const ram = server.listings.find((r) => r.vin === VIN_A);
  assert.equal(ram.posted_at, slow);
  assert.ok(Date.parse(ram.posted_at) < Date.parse(laptop.state.since), 'the post looks older than the laptop\'s last sync');

  sync(server, laptop);
  assert.equal(ram.status, 'listed', 'the laptop never knew the Ram, whatever the desktop\'s clock said');
  assert.equal(laptop.posted[VIN_A].postedAt, slow);
  sync(server, desktop);
  assert.equal(VIN_A in desktop.posted, true);
  assert.equal(ram.status, 'listed');
});

test('a take-down right after the post\'s own sync counts at the very next sync (the sync that sent it keeps it in known)', () => {
  const server = fakeServer();
  const desktop = machine(U1, {});
  sync(server, desktop);
  desktop.posted = markPosted({}, car(VIN_A, '2019 Ram 1500', 28995), 'website', T(30), { salesperson: 'Alex' });
  sync(server, desktop);
  const ram = server.listings.find((r) => r.vin === VIN_A);
  assert.equal(knows(desktop, VIN_A, T(30)), true);
  desktop.posted = markTakenDown(desktop.posted, VIN_A);
  sync(server, desktop);
  assert.equal(ram.status, 'taken_down');
  sync(server, desktop);
  assert.equal(knows(desktop, VIN_A, T(30)), false, 'and once it is down, it is no longer known');
});

// Security audit S4/S7: a colleague's post of a VIN the caller has up must never push the caller's entry out of
// their own upload, or the sync function would take the caller's live row down.
test('mergeRegistry: a colleague\'s newer post never takes over the caller\'s own entry, which still goes up whole', () => {
  const mine = { name: 'A', price: 20000, postedAt: T(0), listingUrl: 'https://www.facebook.com/marketplace/item/1/' };
  const remote = { listings: [row(VIN_A, { user_id: U1, posted_at: T(0), listing_url: mine.listingUrl }), row(VIN_A, { user_id: U2, posted_at: T(30) })] };
  const out = mergeRegistry({ [VIN_A]: mine }, remote, { userId: U1 });
  assert.equal(out[VIN_A].postedAt, T(0), 'judged by the caller\'s own row, not the colleague\'s newer one');
  assert.notEqual(out[VIN_A].mine, false);
  const up = syncPayload({ origin: ORIGIN, posted: out, userId: U1 });
  assert.ok(up.posted[VIN_A], 'the entry is still in the next upload, so the server keeps the caller\'s row listed');
  assert.equal(up.posted[VIN_A].postedAt, T(0));
  // with no row of the caller's on the server at all, the entry stays exactly as it was
  const alone = mergeRegistry({ [VIN_A]: mine }, { listings: [row(VIN_A, { user_id: U2, posted_at: T(30) })] }, { userId: U1 });
  assert.deepEqual(alone[VIN_A], mine);
  // the caller's own take-down on another machine still removes the entry
  const down = mergeRegistry({ [VIN_A]: mine }, { listings: [row(VIN_A, { user_id: U1, posted_at: T(0), status: 'taken_down', taken_down_at: T(20) }), row(VIN_A, { user_id: U2, posted_at: T(30) })] }, { userId: U1 });
  assert.notEqual(down[VIN_A] && down[VIN_A].postedAt, T(0), 'a taken-down own row is not kept as the caller\'s live entry');
});
