import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capStatus, postsToday, serverPostsToday } from '../extension/src/cap.js';
import { mergeRegistry, syncPayload } from '../extension/src/sync.js';
import { markPosted } from '../extension/src/rescan.js';

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const VIN_A = 'TESTVIN00000000A1';
const VIN_B = 'TESTVIN00000000B2';
const VIN_C = 'TESTVIN00000000C3';
const now = new Date(2026, 8, 26, 15, 0); // Sept 26, 3pm local
const today = (min) => new Date(2026, 8, 26, 9, min).toISOString();
const row = (vin, userId, over = {}) => ({ dealership_id: 'd', user_id: userId, vin, name: `Car ${vin.slice(-2)}`, price: 20000, posted_at: today(0), listing_url: null, salesperson: null, updated_at: null, taken_down_at: null, status: 'listed', ...over });

// Non-negotiable 7: the cap is per salesperson. Sync writes the whole
// dealership's registry into posted:<origin>; the colleagues' entries carry
// `mine: false` and must not count.
test('the daily cap counts only this salesperson\'s posts: a colleague\'s merged entry is skipped, an own entry is not', () => {
  const posted = {
    [VIN_A]: { name: 'A', price: 1, postedAt: today(1) },
    [VIN_B]: { name: 'B', price: 2, postedAt: today(2), userId: U1 }, // own, labelled by the server
    [VIN_C]: { name: 'C', price: 3, postedAt: today(3), userId: U2, mine: false }, // a colleague's
  };
  assert.equal(postsToday(posted, now), 2);
  assert.deepEqual(capStatus(posted, 2, now), { used: 2, cap: 2, remaining: 0, reached: true });
  // an entry that says mine: true (never written today, but harmless) counts like one with no flag
  assert.equal(postsToday({ ...posted, [VIN_C]: { ...posted[VIN_C], mine: true } }, now), 3);
});

test('three salespeople, cap 10 each: after a sync nobody is blocked by the others\' posts, and the merge marks only the colleagues\' entries', () => {
  // Alex and Sam posted five cars each today; Riley posted nothing and syncs
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(row(`TESTVINALEX0000${i}A`, U1, { posted_at: today(i) }), row(`TESTVINSAM00000${i}S`, U2, { posted_at: today(10 + i) }));
  const riley = mergeRegistry({}, { listings: rows }, { since: null, userId: 'riley' });
  assert.equal(Object.keys(riley).length, 10, 'Riley sees every listing of the dealership');
  assert.ok(Object.values(riley).every((e) => e.mine === false));
  assert.deepEqual(capStatus(riley, 10, now), { used: 0, cap: 10, remaining: 10, reached: false }, 'and is not blocked by them');
  // Alex's machine: own five without a flag, Sam's five marked
  const alexLocal = rows.filter((r) => r.user_id === U1).reduce((p, r) => markPosted(p, { vin: r.vin, name: r.name, price: r.price }, 'website', r.posted_at), {});
  const alex = mergeRegistry(alexLocal, { listings: rows }, { since: null, userId: U1 });
  assert.equal(Object.values(alex).filter((e) => e.mine === false).length, 5);
  assert.equal(Object.values(alex).filter((e) => 'mine' in e).length, 5, 'own entries carry no flag');
  assert.deepEqual(capStatus(alex, 10, now), { used: 5, cap: 10, remaining: 5, reached: false });
  // what goes up from Alex's machine stays Alex's own
  assert.deepEqual(Object.keys(syncPayload({ origin: 'https://www.example-motors.test', posted: alex, userId: U1 }).posted).sort(), rows.filter((r) => r.user_id === U1).map((r) => r.vin).sort());
  // Riley posts one car: a fresh own entry, counted
  const posted = markPosted(riley, { vin: VIN_A, name: 'Riley\'s car', price: 9000 }, 'website', today(30));
  assert.equal(capStatus(posted, 10, now).used, 1);
});

test('mergeRegistry without a caller id marks nothing (a machine that cannot tell whose is whose counts every entry, as before)', () => {
  const out = mergeRegistry({}, { listings: [row(VIN_A, U2)] });
  assert.deepEqual(out[VIN_A], { name: 'Car A1', price: 20000, postedAt: today(0), userId: U2 });
  assert.equal(postsToday(out, now), 1);
  // the same post on both sides: the server's user decides; a stale flag goes when the row is the caller's own
  const stale = { [VIN_A]: { name: 'A', price: 20000, postedAt: today(0), userId: U2, mine: false } };
  const own = mergeRegistry(stale, { listings: [row(VIN_A, U1)] }, { userId: U1 });
  assert.equal('mine' in own[VIN_A], false);
  assert.equal(own[VIN_A].userId, U1);
  const theirs = mergeRegistry({ [VIN_A]: { name: 'A', price: 20000, postedAt: today(0) } }, { listings: [row(VIN_A, U2)] }, { userId: U1 });
  assert.equal(theirs[VIN_A].mine, false);
  // a newer post of the same car by a colleague replaces the local entry, marked
  const replaced = mergeRegistry({ [VIN_A]: { name: 'A', price: 20000, postedAt: today(0) } }, { listings: [row(VIN_A, U2, { posted_at: today(5) })] }, { userId: U1 });
  assert.equal(replaced[VIN_A].mine, false);
  assert.equal(replaced[VIN_A].postedAt, today(5));
});

// The cap across the salesperson's machines: the sync function counts their
// posts in the local day the extension sent (sync:<origin>.postsToday, kept
// by src/sync.js nextSyncState as { count, from, to }); the cap takes the
// larger of that and this machine's own count while the range covers now.
test('the server\'s count of today\'s posts raises the cap\'s count when it is higher, never lowers it, and only for the day it covers', () => {
  const posted = {
    [VIN_A]: { name: 'A', price: 1, postedAt: today(1) },
    [VIN_C]: { name: 'C', price: 3, postedAt: today(3), userId: U2, mine: false }, // a colleague's: never this person's post
  };
  const day = { from: new Date(2026, 8, 26).toISOString(), to: new Date(2026, 8, 27).toISOString() };
  // higher wins: two more posts were made from the showroom desktop today
  assert.deepEqual(capStatus(posted, 3, now, { serverCount: { count: 3, ...day } }), { used: 3, cap: 3, remaining: 0, reached: true });
  assert.deepEqual(capStatus(posted, 10, now, { serverCount: { count: 4, ...day } }), { used: 4, cap: 10, remaining: 6, reached: false });
  // lower is ignored: this machine has a post the server has not received yet
  assert.equal(capStatus(posted, 10, now, { serverCount: { count: 0, ...day } }).used, 1);
  // yesterday's count says nothing about today
  const yesterday = { from: new Date(2026, 8, 25).toISOString(), to: new Date(2026, 8, 26).toISOString() };
  assert.equal(capStatus(posted, 10, now, { serverCount: { count: 9, ...yesterday } }).used, 1);
  assert.equal(serverPostsToday({ count: 9, ...yesterday }, now), 0);
  // the range is half-open: a day that ends exactly now is over; one that starts now has begun
  assert.equal(serverPostsToday({ count: 9, from: yesterday.from, to: now.toISOString() }, now), 0);
  assert.equal(serverPostsToday({ count: 9, from: now.toISOString(), to: day.to }, now), 9);
  // garbage is no count
  for (const bad of [null, undefined, {}, { count: 'many', ...day }, { count: -1, ...day }, { count: 2.5, ...day }, { count: 2, from: 'x', to: day.to }]) assert.equal(serverPostsToday(bad, now), 0, JSON.stringify(bad));
  // the old three-argument call still counts this machine alone, and a colleague's entry is still skipped either way
  assert.deepEqual(capStatus(posted, 10, now), { used: 1, cap: 10, remaining: 9, reached: false });
  assert.deepEqual(capStatus(posted, 10, now, undefined), capStatus(posted, 10, now));
  assert.deepEqual(capStatus(posted, 10, now, null), capStatus(posted, 10, now));
  assert.equal(capStatus(posted, 10, now, { serverCount: { count: 1, ...day } }).used, 1, 'the colleague\'s entry would make 2 if it counted');
});
