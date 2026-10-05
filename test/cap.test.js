import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capStatus, postsToday, serverPostsToday, draftsToday, capCount, askWhenListed } from '../extension/src/cap.js';
import { createQueue } from '../extension/src/queue.js';
import { nextToPost } from '../extension/src/panelList.js';
import { draftRecord } from '../extension/src/drafts.js';
import { mergeRegistry, syncPayload } from '../extension/src/sync.js';
import { markPosted, markTakenDown } from '../extension/src/rescan.js';
import { noteTakenDown } from '../extension/src/takenDown.js';

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
  // a newer post of the same car by a colleague never takes over the caller's own entry (it would drop out of
  // their next upload and the server would take their row down): the entry stays as it is and still counts
  const kept = mergeRegistry({ [VIN_A]: { name: 'A', price: 20000, postedAt: today(0) } }, { listings: [row(VIN_A, U2, { posted_at: today(5) })] }, { userId: U1 });
  assert.deepEqual(kept[VIN_A], { name: 'A', price: 20000, postedAt: today(0) });
  assert.equal(postsToday(kept, now), 1);
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

// A post taken down later the same day was still a post that day (the sync
// function counts any status). A computer that recorded its posts before it
// kept the day's log (an install updated during the day) has them only in
// the posted list and, once taken down or unmarked, in the take-down record
// (takenDown:<origin>, src/takenDown.js): the cap carries those into the
// day's log when it reads it (dayLog), so a take-down never frees a slot
// there either.
test('a post taken down the same day still counts: Taken down never frees a slot, a re-post of the car is one more post', () => {
  let posted = {};
  for (let i = 0; i < 10; i += 1) posted = markPosted(posted, { vin: `TESTVIN0000000${String(i).padStart(2, '0')}X`, name: `Car ${i}`, price: 10000 + i }, 'website', today(i));
  assert.deepEqual(capStatus(posted, 10, now), { used: 10, cap: 10, remaining: 0, reached: true });
  // the salesperson clicks Taken down on one of today's posts
  const vin = 'TESTVIN000000003X';
  let takenDown = noteTakenDown(null, { vin, postedAt: posted[vin].postedAt, stillListed: true }, today(40), now);
  posted = markTakenDown(posted, vin);
  assert.equal(Object.keys(posted).length, 9);
  assert.deepEqual(capStatus(posted, 10, now, { takenDown }), { used: 10, cap: 10, remaining: 0, reached: true }, 'still 10 posts today');
  assert.equal(capStatus(posted, 10, now).used, 9, 'the posted list alone no longer has it');
  // posted again the same day: two posts of one car
  posted = markPosted(posted, { vin, name: 'Car 3', price: 10003 }, 'website', today(45));
  assert.equal(capStatus(posted, 20, now, { takenDown }).used, 11);
  // the same post written twice (the record before a failed posted-list write) counts once
  takenDown = noteTakenDown(takenDown, { vin: 'TESTVIN000000004X', postedAt: posted.TESTVIN000000004X.postedAt }, today(50), now);
  assert.equal(capStatus(posted, 20, now, { takenDown }).used, 11);
  // yesterday's take-downs count toward no day but their own
  const yesterday = new Date(2026, 8, 25, 12, 0).toISOString();
  assert.equal(capStatus({}, 10, now, { takenDown: noteTakenDown(null, { vin, postedAt: yesterday }, today(1), now) }).used, 0);
  // a record with no posting time counts toward no day
  assert.equal(capStatus({}, 10, now, { takenDown: noteTakenDown(null, { vin }, today(1), now) }).used, 0);
  // anything that is not a list is no record
  assert.equal(capStatus(posted, 20, now, { takenDown: { not: 'a list' } }).used, 10);
});

// One record of the day's posts: the day's log. The take-down record is
// read into it (dayLog), never counted beside it, so a post that is in both
// counts once, and a car on the log is never counted again from the record.
test('the take-down record is carried into the day\'s log on read: a post in both counts once, a listing made before that day never', () => {
  let posted = {};
  let log = [];
  for (let i = 0; i < 3; i += 1) {
    const v = `TESTVIN0000000${String(i).padStart(2, '0')}X`;
    posted = markPosted(posted, { vin: v, name: `Car ${i}`, price: 10000 + i }, 'website', today(i));
    log = logPost(log, v, today(i));
  }
  // Taken down (the popup writes the record first, then removes the entry): the log has the post already
  const down = 'TESTVIN000000001X';
  let takenDown = noteTakenDown(null, { vin: down, postedAt: posted[down].postedAt, stillListed: true }, today(30), now);
  posted = markTakenDown(posted, down);
  assert.deepEqual(dayLog(log, takenDown, now), log, 'nothing to carry: the log has that post');
  assert.equal(capStatus(posted, 10, now, { log, takenDown }).used, 3);
  // unmarked at 10:00 and marked posted again (the same listing: logPost alreadyLive), then taken down again: still one post
  const again = 'TESTVIN000000002X';
  takenDown = noteTakenDown(takenDown, { vin: again, postedAt: posted[again].postedAt }, today(40), now);
  posted = markTakenDown(posted, again);
  assert.deepEqual(logPost(log, again, today(50), now, { alreadyLive: true }), log);
  posted = markPosted(posted, { vin: again, name: 'Car 2', price: 10002 }, 'website', today(50));
  takenDown = noteTakenDown(takenDown, { vin: again, postedAt: posted[again].postedAt }, today(55), now);
  posted = markTakenDown(posted, again);
  assert.equal(capStatus(posted, 10, now, { log, takenDown }).used, 3, 'a car on the log is not counted again from the take-down record');
  // a post recorded before the log was kept (no log entry), taken down: carried into the log
  const early = 'TESTVIN000000077X';
  takenDown = noteTakenDown(takenDown, { vin: early, postedAt: today(5) }, today(20), now);
  assert.deepEqual(dayLog(log, takenDown, now), [...log, { vin: early, at: today(5) }]);
  assert.equal(capStatus(posted, 10, now, { log, takenDown }).used, 4);
  // a listing marked as made before that day and taken down is no post of that day
  const hand = 'HANDVIN0000000001';
  const handPosted = markPosted({}, { vin: hand, name: 'Hand', price: 1 }, 'website', today(7), { listedBefore: true });
  takenDown = noteTakenDown(takenDown, { vin: hand, postedAt: handPosted[hand].postedAt, listedBefore: handPosted[hand].listedBefore }, today(8), now);
  assert.equal(capStatus(posted, 10, now, { log, takenDown }).used, 4);
  // nothing is written: the log the caller holds is unchanged
  assert.equal(log.length, 3);
});

// A take-down removes the car from the posted list, but the post was made
// today: the day's log (postLog:<origin>, src/cap.js logPost) keeps counting
// it, as the sync function's count does. Unmarking does the same: the cap is
// a safety setting, and Posted ✓ clicked at the cap must not bring the Post
// buttons back. Marking the unmarked car posted again counts it once.
import { logPost, loggedToday, dayLog } from '../extension/src/cap.js';
import * as capModule from '../extension/src/cap.js';
import { readFileSync } from 'node:fs';

test('a listing taken down or unmarked the same day still counts against the day\'s cap', () => {
  let posted = {};
  let log = [];
  for (let i = 0; i < 10; i += 1) {
    const vin = `TESTVIN0000000${String(i).padStart(2, '0')}X`;
    const at = today(i);
    posted = markPosted(posted, { vin, name: `Car ${i}`, price: 10000 + i }, 'website', at);
    log = logPost(log, vin, at);
  }
  assert.deepEqual(capStatus(posted, 10, now, { log }), { used: 10, cap: 10, remaining: 0, reached: true });
  // car 3 sells at 3 pm and its listing is taken down
  const sold = 'TESTVIN000000003X';
  posted = markTakenDown(posted, sold);
  assert.equal(postsToday(posted, now), 9, 'the posted list forgets it');
  assert.deepEqual(capStatus(posted, 10, now, { log }), { used: 10, cap: 10, remaining: 0, reached: true }, 'the cap does not hand the post back');
  assert.equal(capStatus(posted, 10, now).used, 9, 'without the log it would (the old count)');
  // at the cap, a car unmarked (Posted ✓ clicked): the posted list forgets it, the log does not, and the cap stays reached
  const unmarked = 'TESTVIN000000004X';
  posted = markTakenDown(posted, unmarked);
  assert.equal(postsToday(posted, now), 8);
  assert.deepEqual(capStatus(posted, 10, now, { log }), { used: 10, cap: 10, remaining: 0, reached: true }, 'unmarking does not hand the post back');
  assert.equal(capModule.unlogPost, undefined, 'nothing takes a post off the day\'s log');
  // marked posted again the same day (Mark posted, a listing already live): the same post, counted once
  const again = logPost(log, unmarked, today(50), now, { alreadyLive: true });
  assert.deepEqual(again, log);
  posted = markPosted(posted, { vin: unmarked, name: 'Car 4', price: 10004 }, 'website', today(50));
  assert.deepEqual(capStatus(posted, 10, now, { log: again }), { used: 10, cap: 10, remaining: 0, reached: true });
  // a car not yet on today's log is a new post, Mark posted or not
  assert.equal(logPost(log, 'TESTVIN000000099X', today(51), now, { alreadyLive: true }).length, 11);
  // the server's count still raises it, and the largest count wins
  const day = { from: new Date(2026, 8, 26).toISOString(), to: new Date(2026, 8, 27).toISOString() };
  assert.equal(capStatus(posted, 20, now, { log, serverCount: { count: 12, ...day } }).used, 12);
});

test('the day\'s log keeps only that day, and ignores anything that is not an entry', () => {
  const yesterday = new Date(2026, 8, 25, 18, 0).toISOString();
  const log = logPost([{ vin: 'OLD', at: yesterday }, null, 'x', { vin: 1, at: today(0) }, { vin: 'A', at: today(1) }], 'B', today(2));
  assert.deepEqual(log, [{ vin: 'A', at: today(1) }, { vin: 'B', at: today(2) }]);
  assert.equal(loggedToday(log, now), 2);
  assert.equal(loggedToday(log, new Date(2026, 8, 27, 9, 0)), 0, 'tomorrow starts at nothing');
  for (const bad of [null, undefined, {}, 'log', [{ at: today(0) }]]) assert.equal(loggedToday(bad, now), 0);
  // two posts of the same car in one day through the side panel (posted, taken down, posted again) are two posts
  assert.equal(loggedToday(logPost(logPost([], 'A', today(1)), 'A', today(30)), now), 2);
  // Mark posted of a car on yesterday's log only is a post today
  assert.deepEqual(logPost([{ vin: 'A', at: yesterday }], 'A', today(3), now, { alreadyLive: true }), [{ vin: 'A', at: today(3) }]);
});

test('only recording a post writes the day\'s log; take-downs never touch it, and the cap reads it in the popup and the side panel', () => {
  const src = (rel) => readFileSync(new URL('../extension/' + rel, import.meta.url), 'utf8');
  const panel = src('sidepanel.js');
  const popup = src('popup.js');
  assert.match(panel, /updateKey\(siteKeys\(origin\)\.postLog, \(log\) => logPost\(log, vehicle\.vin, now\)/, 'the side panel logs the post it records');
  assert.match(popup, /update\('postLog', \(log\) => logPost\(log, vin, at, undefined, \{ alreadyLive: true \}\)\)/, 'Mark posted logs it, once for a car marked again');
  const unpost = popup.slice(popup.indexOf("case 'unpost': {"), popup.indexOf("case 'takenDown':"));
  assert.ok(unpost.length > 50 && !/postLog|unlogPost/.test(unpost), 'unmarking leaves the day\'s log alone');
  for (const s of [panel, popup]) assert.match(s, /capStatus\(state\.posted, state\.settings\??\.dailyCap, new Date\(\), \{ log: state\.postLog, takenDown: state\.takenDown, serverCount:[^}]*, drafts: state\.drafts \}\)/, 'the cap counts the day\'s log (the take-down record carried into it) and drafts in the popup and the side panel');
  // the take-down paths: upkeep's finish, and the popup's Taken down
  assert.doesNotMatch(src('upkeep.js'), /postLog/);
  const takenDown = popup.slice(popup.indexOf("case 'takenDown':"), popup.indexOf("case 'priceUpdated':"));
  assert.ok(takenDown.length > 50 && !/postLog/.test(takenDown));
  assert.equal((popup.match(/update\('postLog'/g) || []).length, 1, 'only Mark posted writes the log in the popup');
});

// Saved as draft, next car ends a car's form without publishing it, so a
// queue could fill any number of listings a day with the cap never moving.
// Each form saved as a draft today counts toward the day's cap until its car
// is marked posted; from then on it counts as that post, never twice.
test('forms saved as drafts today count toward the daily cap, once, until they are marked posted', () => {
  const drafts = {};
  const vins = Array.from({ length: 30 }, (_, i) => `TESTVIN0000000${String(i).padStart(2, '0')}`);
  for (const [i, vin] of vins.entries()) drafts[vin] = draftRecord({ name: `Car ${i}`, price: 20000 + i, basis: 'website', savedAt: today(i) });
  let cap = capStatus({}, 10, now, { log: [], drafts });
  assert.deepEqual(cap, { used: 30, cap: 10, remaining: 0, reached: true, drafts: 30 }, 'thirty drafts filled today: the cap is reached');
  assert.equal(capCount(cap), '30 of 10 today, 30 of them saved as drafts');

  // a queue: after ten drafts, nothing more is queued or filled today
  const ten = Object.fromEntries(Object.entries(drafts).slice(0, 10));
  cap = capStatus({}, 10, now, { log: [], drafts: ten });
  assert.equal(cap.reached, true);
  const rows = ['NEXTVIN000000001', 'NEXTVIN000000002'].map((vin) => ({ vin, draft: false }));
  assert.deepEqual(nextToPost(rows, cap.remaining), []);
  assert.equal(createQueue(rows.map((r) => r.vin), { remaining: cap.remaining }).ok, false);

  // one draft marked posted (Mark posted writes the posted list and the log): counted as the post, not twice
  const vin = vins[0];
  const one = { [vin]: drafts[vin] };
  const posted = markPosted({}, { vin, name: 'Car 0', price: 20000 }, 'website', today(40));
  const log = logPost([], vin, today(40), now);
  assert.deepEqual(capStatus(posted, 10, now, { log, drafts: one }), { used: 1, cap: 10, remaining: 9, reached: false });
  // taken down the same day: the log still has the post, and the draft is not counted again
  assert.equal(capStatus({}, 10, now, { log, drafts: one }).used, 1);
  // unmarked: the log still has the post, and the draft is not counted again
  assert.deepEqual(capStatus({}, 10, now, { log, drafts: one }), { used: 1, cap: 10, remaining: 9, reached: false });
  // with no log (a log that could not be written), the draft is back on the count
  assert.equal(capStatus({}, 10, now, { log: [], drafts: one }).used, 1);
  assert.equal(capCount(capStatus({}, 10, now, { log: [], drafts: one })), '1 of 10 today, one of them saved as a draft');

  // yesterday's drafts, and anything that is not a draft record, do not count today
  assert.equal(draftsToday({ [vin]: { ...drafts[vin], savedAt: new Date(2026, 8, 25, 18, 0).toISOString() } }, { now }), 0);
  for (const bad of [null, undefined, 'drafts', { X: null }, { X: { name: 'no date' } }]) assert.equal(draftsToday(bad, { now }), 0);
  // drafts add to the posts: two posts and one draft
  const two = { ...markPosted({}, { vin: VIN_A, name: 'A', price: 1 }, 'website', today(1)), ...markPosted({}, { vin: VIN_B, name: 'B', price: 1 }, 'website', today(2)) };
  assert.deepEqual(capStatus(two, 10, now, { drafts: one }), { used: 3, cap: 10, remaining: 7, reached: false, drafts: 1 });
  assert.equal(capCount({ used: 2, cap: 10 }), '2 of 10 today');
});

test('Mark posted always records a live listing, at the cap or not: only filling a form is capped', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const markPostedCase = popup.slice(popup.indexOf("case 'post':\n"), popup.indexOf("case 'openPost':"));
  assert.ok(markPostedCase.length > 100, 'the popup\'s Mark posted is found');
  assert.doesNotMatch(markPostedCase, /dailyCap|capStatus|reached/, 'Mark posted never looks at the cap');
});


// A salesperson's first day: they mark the listings they made by hand
// earlier, as the help tells them to. Those are watched like any other, but
// they are not posts of today: before, twelve of them used the whole cap of
// 10 and no new car could be posted that day.
test('listings marked as made by hand before today leave the day\'s cap alone; a listing marked as posted today counts', () => {
  const vins = Array.from({ length: 12 }, (_, i) => `HANDVIN000000${String(i).padStart(4, '0')}`);
  let posted = {};
  for (const [i, vin] of vins.entries()) posted = markPosted(posted, { vin, name: `Car ${i}`, price: 20000 + i }, 'website', today(i), { listedBefore: true });
  assert.equal(postsToday(posted, now), 0);
  assert.deepEqual(capStatus(posted, 10, now, { log: [], drafts: {} }), { used: 0, cap: 10, remaining: 10, reached: false }, 'twelve earlier listings marked: all ten posts of the day are left');
  // one marked "Posted today" is today's post (it is logged as well)
  const one = markPosted(posted, { vin: VIN_A, name: 'A', price: 1 }, 'website', today(30));
  assert.equal(capStatus(one, 10, now, { log: logPost([], VIN_A, today(30), now), drafts: {} }).used, 1);
  // the flag goes through a sync and back: the server's count leaves it out, and the merged entry keeps it
  const body = syncPayload({ origin: 'https://www.example-motors.test', posted, userId: U1, now });
  assert.equal(body.posted[vins[0]].listedBefore, true);
  assert.equal(body.posted[vins[0]].postedAt, today(0), 'posted at the moment of marking: the sync key');
  const merged = mergeRegistry({}, { listings: [row(vins[0], U1, { listed_before: true })] }, { userId: U1 });
  assert.equal(merged[vins[0]].listedBefore, true);
  assert.equal(postsToday(merged, now), 0);
  assert.equal(postsToday(mergeRegistry({}, { listings: [row(vins[0], U1)] }, { userId: U1 }), now), 1, 'a row without the flag is a post of its day');
});

// Mark posted asks "Today" or "Before today", except for a car whose form
// Lot Current filled and the person saved as a draft today: that listing
// went up today at the earliest. And a draft of today's stays on the count
// even if its car is marked as listed before today.
test('Mark posted asks when the listing went up, unless a draft saved today answers it; today\'s draft still counts', () => {
  assert.equal(askWhenListed(null, now), true);
  assert.equal(askWhenListed(undefined, now), true);
  assert.equal(askWhenListed(draftRecord({ name: 'A', price: 1, basis: 'website', savedAt: today(5) }), now), false, 'saved as a draft today: today\'s post');
  assert.equal(askWhenListed(draftRecord({ name: 'A', price: 1, basis: 'website', savedAt: new Date(2026, 8, 25, 18, 0).toISOString() }), now), true, 'a draft from yesterday may have gone up yesterday');
  const drafts = { [VIN_A]: draftRecord({ name: 'A', price: 1, basis: 'website', savedAt: today(5) }) };
  const before = markPosted({}, { vin: VIN_A, name: 'A', price: 1 }, 'website', today(9), { listedBefore: true });
  assert.equal(capStatus(before, 10, now, { log: [], drafts }).used, 1, 'the form filled today still counts');
  // the popup offers the choice and records the flag, and keeps such a listing off the day's log
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const markCase = popup.slice(popup.indexOf("case 'post':\n"), popup.indexOf("case 'openPost':"));
  assert.match(markCase, /askWhenListed\(draft\)/);
  assert.match(markCase, /before \? \{ listedBefore: true \} : \{\}/);
  assert.match(markCase, /if \(!before\) await update\('postLog'/);
  assert.match(popup, /data-action="markToday"[^>]*>Today<\/button>/);
  assert.match(popup, /data-action="markBefore"[^>]*>Before today<\/button>/);
});
