// The manager view (Milestone 4): the numbers in manager/data.js on the
// sample dealership and on hand-built rows, the definitions kept equal to
// the pilot's, the Billing card (Milestone 5) in each plan state with its
// seat line (under, at and over the included count, short of the seats paid
// for) and what Subscribe sends, the Invite
// codes card (a manager's two buttons, the codes as create_invite types
// them, the sample's one code), self-serve sign-up (the website origin rule
// on every case of test/fixtures/website-origins.json, the form's lines, the
// ?mock=signup stand-in) and the Getting started card, and the page free of
// pilot-dealer values, of typed prices and of anything that sounds like a
// Meta affiliation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { summarize, mockData, managerCsv, csvFileName, fmtLocal, fmtLocalDate, median, hoursBetween, billingCard, billingBody, subscribeSeats, seatCount, SEATS_NOT_ADDED, billingReturnNote, inviteCard, inviteSentence, memberRole, teamCard, teamChangeNote, TEAM_HINT, TEAM_UNCHANGED, INVITE_DAYS, DEFINITIONS, OVERDUE_HOURS, WEEK_MS, DAY_MS, PLAN_STATES, BILLING_BUTTONS, INVITE_BUTTONS, INVITE_ROLES, INVITE_HINT, websiteOrigin, signupOriginNote, signupProblem, signupRefusal, gettingStarted, GETTING_STARTED, PLAN_STEP_CLOSED_TITLE, ACTIVE_SALESPEOPLE, closedBillingStatus, pilotAvailable, BILLING_CLOSED_NOTE, BILLING_CLOSED_ASK, BILLING_TEST_MODE_NOTE, SCAN_STALE_WHY, SIGNUP_WORDS, mockCreateDealership, mockNewDealership, SAMPLE_NEW_DEALERSHIP_ID, SAMPLE_PILOT_DAYS, readAll, PAGE_ROWS, clearLine, EMPTY_TAKE_DOWNS, EMPTY_PRICE_ITEMS, NOT_ON_TEAM_TITLE, NOT_ON_TEAM_HINT, NOT_ON_TEAM_UNKNOWN, FUTURE_SKEW_MS } from '../manager/data.js';
import { DEFINITIONS as PILOT_DEFINITIONS } from '../extension/src/pilot.js';
import { CONFIG } from '../manager/config.js';
import { AFFILIATION } from './honesty.js';
import { lastDefinition } from './migrations.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const NOW = '2026-11-16T15:00:00.000Z';
const ago = (hours) => new Date(Date.parse(NOW) - hours * 3600 * 1000).toISOString();
const sample = () => ({ ...mockData(NOW), now: NOW, timeZone: 'UTC' });
const pricing = JSON.parse(read('marketing/pricing.json'));

// ---------- the definitions ----------

// The manager view never receives the records of which form fields filled
// (they stay on each salesperson's Numbers tab, extension/src/sync.js), so
// its CSV carries every pilot definition but the one about form fields.
test('the definitions are the pilot\'s, sentence for sentence, less the form-fields one the manager has no numbers for (both files read as text, and both modules)', () => {
  const block = (src, file) => {
    const m = src.match(/export const DEFINITIONS = Object\.freeze\(\[([\s\S]*?)\]\);/);
    assert.ok(m, `${file} has a DEFINITIONS list`);
    return m[1].trim().split('\n').map((l) => l.trim()).filter(Boolean);
  };
  const aboutFields = (d) => /form fields?|\bfields?\b/i.test(d);
  const manager = block(read('manager/data.js'), 'manager/data.js');
  const pilot = block(read('extension/src/pilot.js'), 'extension/src/pilot.js');
  assert.equal(pilot.filter(aboutFields).length, 1, 'the pilot has its one form-fields sentence');
  assert.deepEqual(manager, pilot.filter((d) => !aboutFields(d)), 'the sentences in manager/data.js must stay equal to extension/src/pilot.js, less the form-fields one');
  assert.deepEqual([...DEFINITIONS], PILOT_DEFINITIONS.filter((d) => !aboutFields(d)));
  assert.equal(DEFINITIONS.length, 4);
  assert.ok(!DEFINITIONS.some(aboutFields), 'nothing in the manager\'s definitions speaks of form fields');
  assert.doesNotMatch(read('manager/data.js'), /from ['"]\.\.\/extension/, 'data.js does not import the extension (the page is hosted on its own)');
});

// Background rescans run only for a website whose permission the salesperson
// granted, with automatic rescans on in Settings: a stale scan can mean
// either, not only that nobody had Chrome open. The website and the
// onboarding email say so; the manager view and its CSV say so too.
test('every rescan line on the manager view names the condition: automatic rescans allowed', () => {
  assert.equal(SCAN_STALE_WHY, 'rescans run every 3 hours only while a salesperson\'s Chrome is open with automatic rescans allowed, and one that looks like a website hiccup (most of the lot gone at once) is not recorded here');
  assert.match(read('manager/manager.js'), /pill\('warn', `\$\{hrs\(s\.lastScan\.hoursAgo\)\} ago; \$\{SCAN_STALE_WHY\}`\)/);
  assert.equal(DEFINITIONS.at(-1), 'Hours run from the flagging scan, and with automatic rescans allowed, rescans happen every 3 hours while Chrome is open.');
  for (const file of ['manager/manager.js', 'manager/data.js', 'extension/src/pilot.js']) {
    for (const line of read(file).split('\n').filter((l) => /every 3 hours/.test(l) && !/^\s*\/\//.test(l))) {
      assert.match(line, /automatic rescans allowed/, `${file}: ${line.trim()}`);
    }
  }
  assert.match(managerCsv(mockData(NOW), { now: NOW, timeZone: 'UTC' }), /with automatic rescans allowed, rescans happen every 3 hours/);
});

// ---------- the sample dealership ----------

test('mockData is a small made-up dealership with nothing real in it', () => {
  const d = mockData(NOW);
  assert.equal(d.dealership.name, 'Example Motors');
  assert.equal(d.memberships.filter((m) => m.role === 'salesperson').length, 2);
  assert.deepEqual(d.memberships.filter((m) => m.role === 'salesperson').map((m) => m.name), ['Alex', 'Sam']);
  assert.equal(d.listings.length, 8);
  assert.equal(d.todoItems.length, 3);
  assert.ok(d.scans.length >= 2);
  const week = Date.parse(NOW) - WEEK_MS;
  assert.ok(d.postAttempts.length >= 6);
  for (const a of d.postAttempts) assert.ok(Date.parse(a.started_at) >= week && Date.parse(a.started_at) <= Date.parse(NOW), 'attempts are from the last week');
  for (const l of d.listings) {
    assert.equal(l.vin.length, 17);
    assert.equal(l.dealership_id, d.dealership.id);
    assert.ok(['listed', 'taken_down'].includes(l.status));
    assert.equal(Boolean(l.taken_down_at), l.status === 'taken_down');
  }
  const ids = [...d.listings, ...d.todoItems, ...d.postAttempts, ...d.scans].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are distinct');
  assert.doesNotMatch(JSON.stringify(d), /Waynesburg|Ron Lewis|15370|\bRoger\b/i);
  // relative to now: the same shape a day later, a day older
  const later = mockData('2026-11-17T15:00:00.000Z');
  assert.equal(later.listings[0].posted_at, new Date(Date.parse(d.listings[0].posted_at) + 24 * 3600 * 1000).toISOString());
});

test('summarize on the sample: posts per salesperson, medians, listings up', () => {
  const s = summarize(sample());
  assert.equal(s.now, NOW);
  assert.deepEqual(s.salespeople.map((p) => p.name), ['Alex', 'Sam'], 'most posted this week first');
  const [alex, sam] = s.salespeople;
  assert.deepEqual({ ...alex, userId: undefined }, { name: 'Alex', userId: undefined, postedThisWeek: 3, postedAllTime: 5, listed: 4, takenDown: 1, postedAttempts: 3, medianSeconds: 47 });
  assert.deepEqual({ ...sam, userId: undefined }, { name: 'Sam', userId: undefined, postedThisWeek: 2, postedAllTime: 3, listed: 3, takenDown: 0, postedAttempts: 2, medianSeconds: 57.5 });
  assert.deepEqual(s.totals, { salespeople: 2, postedThisWeek: 5, postedAllTime: 8, listed: 7, takenDown: 1, postedAttempts: 5, medianSeconds: 49 });
  assert.equal(s.week.from, ago(7 * 24));
});

// A salesperson who starts with Lot Current marks the listings they made by
// hand earlier (Mark posted, "Before today"): those rows carry listed_before,
// and posted_at is the moment of marking. They are their listings (all time,
// listings up), not posts of this week.
test('summarize: listings marked as made by hand before that day are not counted as posted this week', () => {
  const base = sample();
  const alexId = base.listings.find((l) => l.salesperson === 'Alex').user_id;
  const marked = Array.from({ length: 12 }, (_, i) => ({ id: `hand-${i}`, dealership_id: base.listings[0].dealership_id, user_id: alexId, vin: `1HGHAND0${String(i).padStart(2, '0')}0000000`.slice(0, 17), name: 'Earlier listing', price: 20000 + i, posted_at: ago(2), listing_url: null, salesperson: 'Alex', updated_at: null, taken_down_at: null, status: 'listed', listed_before: true }));
  const before = summarize(base);
  const after = summarize({ ...base, listings: [...base.listings, ...marked] });
  const alex = (s) => s.salespeople.find((p) => p.name === 'Alex');
  assert.equal(alex(after).postedThisWeek, alex(before).postedThisWeek, 'the hand-made listings are not this week\'s posts');
  assert.equal(after.totals.postedThisWeek, before.totals.postedThisWeek);
  assert.equal(alex(after).postedAllTime, alex(before).postedAllTime + 12, 'they are still the salesperson\'s listings');
  assert.equal(alex(after).listed, alex(before).listed + 12);
  // a listing marked "Posted today" (listed_before false) counts as before
  const today = summarize({ ...base, listings: [...base.listings, { ...marked[0], id: 'today', listed_before: false }] });
  assert.equal(alex(today).postedThisWeek, alex(before).postedThisWeek + 1);
});

test('summarize on the sample: sold cars still listed, longest first, red past 24 h', () => {
  const s = summarize(sample());
  assert.equal(OVERDUE_HOURS, 24);
  assert.equal(s.soldStillListed.length, 2);
  assert.deepEqual(s.soldStillListed.map((o) => o.hoursOpen), [30, 5]);
  assert.deepEqual(s.soldStillListed.map((o) => o.overdue), [true, false]);
  assert.deepEqual(s.soldStillListed.map((o) => o.salesperson), ['Alex', 'Sam'], 'joined to the listing with the same VIN');
  assert.equal(s.soldStillListed[0].name, '2021 Jeep Grand Cherokee Limited');
  assert.match(s.soldStillListed[0].listingUrl, /^https:\/\//);
  assert.equal(s.soldStillListed[0].flaggedAt, ago(30));
  assert.deepEqual(s.takeDowns, { flagged: 2, done: 0, detected: 0, cleared: 0, open: 2, medianHours: null, longestHours: null });
});

test('summarize on the sample: price changes not yet updated, with both prices', () => {
  const s = summarize(sample());
  assert.equal(s.priceMismatches.length, 1);
  const o = s.priceMismatches[0];
  assert.equal(o.name, '2018 Honda CR-V EX');
  assert.equal(o.fromPrice, 21495);
  assert.equal(o.toPrice, 20995);
  assert.equal(o.listedPrice, 21495, 'the listing still shows the old price');
  assert.equal(o.hoursOpen, 8);
  assert.equal(o.overdue, false);
  assert.equal(o.salesperson, 'Alex');
  assert.deepEqual(s.priceUpdates, { flagged: 1, done: 0, detected: 0, cleared: 0, open: 1, medianHours: null, longestHours: null });
});

test('summarize on the sample: the last scan line', () => {
  const s = summarize(sample());
  assert.equal(s.scans, 4);
  assert.equal(s.lastScan.takenAt, ago(2));
  assert.equal(s.lastScan.hoursAgo, 2);
  assert.equal(s.lastScan.stale, false);
  assert.equal(s.lastScan.line, 'Last scan 2026-11-16 13:00: 41 cars on the website, 29 ready to post, 2 to take down, 1 price change');
  assert.equal(s.lastScan.websiteOrigin, 'https://www.example-motors-springfield.test');
  const stale = summarize({ ...sample(), scans: [{ taken_at: ago(9), cars: 1, ready: 0, take_down_count: 0, price_update_count: 0 }] });
  assert.equal(stale.lastScan.stale, true);
  assert.equal(stale.lastScan.line, 'Last scan 2026-11-16 06:00: 1 car on the website, 0 ready to post, 0 to take down, 0 price changes');
  // a stale scan's note gives both reasons: no rescan ran, or the ones that ran looked like a website hiccup and were never sent
  assert.match(SCAN_STALE_WHY, /every 3 hours only while a salesperson's Chrome is open/);
  assert.match(SCAN_STALE_WHY, /website hiccup .* not recorded here/);
  assert.match(read('manager/manager.js'), /pill\('warn', `\$\{hrs\(s\.lastScan\.hoursAgo\)\} ago; \$\{SCAN_STALE_WHY\}`\)/);
});

test('summarize: a scan stamped more than 5 minutes ahead of now (a machine whose clock ran ahead) does not pin the last scan line or hide its stale warning', () => {
  const later = (hours) => ago(-hours);
  const real = { taken_at: ago(9), cars: 1, ready: 0, take_down_count: 0, price_update_count: 0 };
  const fromTheFuture = { taken_at: later(24 * 365), cars: 99, ready: 99, take_down_count: 0, price_update_count: 0 };
  const s = summarize({ ...sample(), scans: [fromTheFuture, real] });
  assert.equal(s.lastScan.takenAt, real.taken_at, 'the newest scan that ran by now');
  assert.equal(s.lastScan.stale, true, 'nine hours without a real scan is still stale');
  assert.equal(s.scans, 2, 'the row is still counted as read');
  // a few minutes ahead is ordinary clock drift and still counts
  const drift = { taken_at: later(4 / 60), cars: 2, ready: 1, take_down_count: 0, price_update_count: 0 };
  assert.equal(summarize({ ...sample(), scans: [drift, real] }).lastScan.takenAt, drift.taken_at);
  // only scans from the future: no last scan at all, rather than a wrong one
  assert.equal(summarize({ ...sample(), scans: [fromTheFuture] }).lastScan, null);
  assert.equal(FUTURE_SKEW_MS, 5 * 60 * 1000, 'the same margin /sync gives a scan');
});

// ---------- hand-built rows ----------

test('done items give the medians; cleared ones are counted but not in the median', () => {
  const todoItems = [
    { vin: 'A', kind: 'takeDown', name: 'A', flagged_at: ago(50), done_at: ago(40), how: 'detected' },
    { vin: 'B', kind: 'takeDown', name: 'B', flagged_at: ago(30), done_at: ago(6), how: 'manual' },
    { vin: 'C', kind: 'takeDown', name: 'C', flagged_at: ago(20), done_at: ago(19), how: 'cleared' },
    { vin: 'D', kind: 'takeDown', name: 'D', flagged_at: ago(3), done_at: null },
    { vin: 'E', kind: 'price', name: 'E', flagged_at: ago(12), done_at: ago(2), how: 'manual', from_price: 10000, to_price: 9500 },
  ];
  const s = summarize({ todoItems, now: NOW, timeZone: 'UTC' });
  assert.deepEqual(s.takeDowns, { flagged: 4, done: 2, detected: 1, cleared: 1, open: 1, medianHours: 17, longestHours: 24 });
  assert.deepEqual(s.priceUpdates, { flagged: 1, done: 1, detected: 0, cleared: 0, open: 0, medianHours: 10, longestHours: 10 });
  assert.equal(s.soldStillListed.length, 1);
  assert.equal(s.soldStillListed[0].salesperson, '', 'no listing with that VIN: no salesperson on record');
  assert.equal(s.soldStillListed[0].listingUrl, '');
  assert.equal(s.priceMismatches.length, 0);
});

test('people: memberships name the account, a salesperson with nothing posted still appears, a manager does not', () => {
  const memberships = [
    { user_id: 'u1', role: 'salesperson', name: 'Alex' },
    { user_id: 'u2', role: 'salesperson', name: 'Sam' },
    { user_id: 'u3', role: 'manager', name: 'Jamie' },
  ];
  const listings = [
    { user_id: 'u1', vin: 'V1', name: 'Car 1', posted_at: ago(2), salesperson: 'alex (old spelling)', status: 'listed' },
    { user_id: null, vin: 'V2', name: 'Car 2', posted_at: ago(200), salesperson: 'Pat', taken_down_at: ago(100) }, // no account, no status column
    { user_id: null, vin: 'V3', name: 'Car 3', posted_at: ago(3), salesperson: 'pat' },
  ];
  const postAttempts = [
    { user_id: 'u1', vin: 'V1', outcome: 'posted', seconds: 40 },
    { user_id: 'u1', vin: 'V9', outcome: 'abandoned', seconds: 400 },
    { user_id: null, salesperson: 'Pat', vin: 'V3', outcome: 'posted', seconds: '55' },
    { user_id: null, salesperson: 'Pat', vin: 'V3', outcome: 'posted', seconds: null },
  ];
  const s = summarize({ memberships, listings, postAttempts, now: NOW });
  // the same count this week: more posts all time first, then by name
  assert.deepEqual(s.salespeople.map((p) => [p.name, p.postedThisWeek, p.postedAllTime, p.listed, p.takenDown, p.medianSeconds]), [
    ['Pat', 1, 2, 1, 1, 55],
    ['Alex', 1, 1, 1, 0, 40],
    ['Sam', 0, 0, 0, 0, null],
  ]);
  assert.ok(!s.salespeople.some((p) => p.name === 'Jamie'));
  assert.equal(s.totals.postedAllTime, 3);
  assert.equal(s.totals.medianSeconds, 47.5);
});

test('a to-do item joins to the listing that is up, and the ages sort longest first across kinds', () => {
  const listings = [
    { user_id: 'u1', vin: 'V1', name: 'Old', posted_at: ago(300), salesperson: 'Alex', status: 'taken_down', taken_down_at: ago(250), listing_url: 'https://example.test/old' },
    { user_id: 'u2', vin: 'v1', name: 'New', posted_at: ago(20), salesperson: 'Sam', status: 'listed', listing_url: 'https://example.test/new' },
  ];
  const todoItems = [
    { vin: 'V1', kind: 'takeDown', flagged_at: ago(4) },
    { vin: 'V1', kind: 'price', flagged_at: ago(25), from_price: 100, to_price: 90 },
    { vin: 'V2', kind: 'price', flagged_at: ago(1), from_price: 100, to_price: 95 },
  ];
  const s = summarize({ listings, todoItems, now: NOW });
  assert.equal(s.soldStillListed[0].salesperson, 'Sam');
  assert.equal(s.soldStillListed[0].listingUrl, 'https://example.test/new');
  assert.equal(s.soldStillListed[0].name, 'New', 'no name on the item: the listing\'s');
  assert.deepEqual(s.priceMismatches.map((o) => [o.hoursOpen, o.overdue, o.toPrice]), [[25, true, 90], [1, false, 95]]);
});

test('a car with two open items of one kind (two machines of one salesperson that each filed the same sighting) is listed and counted once, from the first sighting', () => {
  const listings = [{ user_id: 'u1', vin: 'V1', name: 'Car', posted_at: ago(100), salesperson: 'Sam', status: 'listed' }];
  const todoItems = [
    { vin: 'V1', kind: 'price', flagged_at: ago(3), from_price: 100, to_price: 90 },
    { vin: 'v1', kind: 'price', flagged_at: ago(30), from_price: 100, to_price: 90 },
    { vin: 'V1', kind: 'takeDown', flagged_at: ago(2) },
    { vin: 'V1', kind: 'takeDown', flagged_at: ago(26) },
  ];
  const s = summarize({ listings, todoItems, now: NOW });
  assert.deepEqual(s.priceMismatches.map((o) => [o.vin, o.hoursOpen, o.overdue]), [['V1', 30, true]]);
  assert.deepEqual(s.soldStillListed.map((o) => [o.vin, o.hoursOpen, o.overdue]), [['V1', 26, true]]);
  assert.equal(s.priceUpdates.open, 1);
  assert.equal(s.takeDowns.open, 1);
  // and flagged = done + still open + cleared, as the CSV says
  assert.deepEqual([s.priceUpdates.flagged, s.takeDowns.flagged], [1, 1]);
  const closed = summarize({ listings, todoItems: [...todoItems, { vin: 'V1', kind: 'price', flagged_at: ago(50), done_at: ago(40), how: 'manual' }, { vin: 'V1', kind: 'price', flagged_at: ago(60), done_at: ago(55), how: 'cleared' }], now: NOW });
  const p = closed.priceUpdates;
  assert.deepEqual([p.flagged, p.done, p.open, p.cleared], [3, 1, 1, 1]);
});

test('closed rows of one sighting (two machines\' uploads raced in) count as one item too, so flagged, done, open and cleared all count items', () => {
  const todoItems = [
    // one sold car flagged on two machines, both rows closed when it came down: one item, taken down after 10 hours from the first sighting
    { vin: 'V1', kind: 'takeDown', flagged_at: ago(30), done_at: ago(20), how: 'detected' },
    { vin: 'V1', kind: 'takeDown', flagged_at: ago(28), done_at: ago(19), how: 'manual' },
    // one sighting left as an open row and a cleared row: one item, still open, as the list shows it
    { vin: 'V2', kind: 'takeDown', flagged_at: ago(10), done_at: null },
    { vin: 'V2', kind: 'takeDown', flagged_at: ago(9), done_at: ago(5), how: 'cleared' },
    // one sighting cleared on one machine and fixed on the other: one item, done
    { vin: 'V3', kind: 'takeDown', flagged_at: ago(60), done_at: ago(55), how: 'cleared' },
    { vin: 'V3', kind: 'takeDown', flagged_at: ago(59), done_at: ago(52), how: 'manual' },
    // two price changes of one car, one after the other closed: two items
    { vin: 'V4', kind: 'price', flagged_at: ago(100), done_at: ago(90), how: 'manual' },
    { vin: 'V4', kind: 'price', flagged_at: ago(50), done_at: ago(45), how: 'detected' },
  ];
  const s = summarize({ listings: [], todoItems, now: NOW });
  assert.deepEqual(s.takeDowns, { flagged: 3, done: 2, detected: 1, cleared: 0, open: 1, medianHours: 9, longestHours: 10 });
  assert.deepEqual(s.priceUpdates, { flagged: 2, done: 2, detected: 1, cleared: 0, open: 0, medianHours: 7.5, longestHours: 10 });
  for (const k of ['takeDowns', 'priceUpdates']) assert.equal(s[k].flagged, s[k].done + s[k].open + s[k].cleared, k);
  assert.deepEqual(s.soldStillListed.map((o) => o.vin), ['V2']);
});

test('a car still listed by someone no longer on the team is listed for the manager, since no rescan looks after it; the empty to-do cards claim only what the items show', () => {
  const memberships = [{ user_id: 'u1', role: 'salesperson', name: 'Alex' }, { user_id: 'u3', role: 'manager', name: 'Jamie' }];
  const listings = [
    { user_id: 'u1', vin: 'V1', name: 'Alex car', posted_at: ago(5), salesperson: 'Alex', status: 'listed' },
    { user_id: 'u9', vin: 'V9', name: 'Left behind', posted_at: ago(72), salesperson: 'Pat', status: 'listed', price: 18995, listing_url: 'https://example.test/v9' },
    { user_id: 'u9', vin: 'V8', name: 'Taken down', posted_at: ago(90), salesperson: 'Pat', status: 'taken_down', taken_down_at: ago(80) },
    { user_id: 'u9', vin: 'V7', name: 'Newer', posted_at: ago(10), salesperson: 'Pat', status: 'listed' },
  ];
  const s = summarize({ memberships, listings, todoItems: [], role: 'manager', now: NOW });
  assert.deepEqual(s.notOnTeam.map((o) => [o.vin, o.salesperson, o.hoursListed, o.listedPrice, o.listingUrl]), [['V9', 'Pat', 72, 18995, 'https://example.test/v9'], ['V7', 'Pat', 10, null, '']], 'listed ones only, longest listed first');
  assert.deepEqual(s.soldStillListed, [], 'no item ever opens for them');
  assert.equal(summarize({ listings, role: 'manager', now: NOW }).notOnTeam, null, 'without the memberships nobody can be told apart');
  assert.deepEqual(summarize({ memberships, listings: listings.slice(0, 1), role: 'manager', now: NOW }).notOnTeam, []);
  // the CSV carries them too
  const lines = managerCsv({ memberships, listings }, { role: 'manager', now: NOW, timeZone: 'UTC' }).split('\r\n');
  assert.ok(lines.includes(`${NOT_ON_TEAM_TITLE},2`));
  const at = lines.indexOf(NOT_ON_TEAM_TITLE);
  assert.equal(lines[at + 1], 'Posted,Car,VIN,Salesperson,Hours listed,Price,Listing link');
  assert.equal(lines[at + 2], '2026-11-13 15:00,Left behind,V9,Pat,72,18995,https://example.test/v9');
  // the page shows them with the reason, and its empty cards say what an item is, never that every sold car is down
  const page = read('manager/manager.js');
  assert.doesNotMatch(page, /Every sold car is off Marketplace|Every listing shows the website price/);
  // an empty card's line starts with what an item is (clearLine), and the page shows that line
  assert.equal(s.clear.sold.line.startsWith(EMPTY_TAKE_DOWNS), true);
  assert.equal(s.clear.price.line.startsWith(EMPTY_PRICE_ITEMS), true);
  assert.match(page, /esc\(s\.clear\.sold\.line\)/);
  assert.match(page, /esc\(s\.clear\.price\.line\)/);
  assert.match(page, /id="notOnTeam"/);
  // a 0 there is no all-clear, so its pill takes clearLine's tone, which is never the green one
  for (const [list, kind] of [['soldStillListed', 'sold'], ['priceMismatches', 'price']]) {
    assert.match(page, new RegExp(`pill\\(s\\.${list}\\.length \\? \\(.*?\\) : s\\.clear\\.${kind}\\.tone, String\\(s\\.${list}\\.length\\)\\)`), list);
    assert.notEqual(s.clear[kind].tone, 'good');
  }
  for (const line of [EMPTY_TAKE_DOWNS, EMPTY_PRICE_ITEMS]) {
    assert.doesNotMatch(line, /\bevery\b|\ball\b/i, line);
    assert.match(line, /poster's own computer/);
  }
  assert.match(NOT_ON_TEAM_HINT, /nobody is told when these cars sell or change price/);
  assert.match(TEAM_HINT, /show under "Listed by people no longer on the team"/);
});

// a CSV cell as managerCsv writes it
const csvQuote = (s) => (/[",\n\r']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

test('a salesperson who opens the manager view reads only their own membership, so no colleague\'s car is put under "no longer on the team", on the page or in the CSV', () => {
  // what row-level security gives a salesperson (0002_rls.sql): their own membership row, and every listing of the dealership
  const memberships = [{ user_id: 'u1', dealership_id: 'd1', role: 'salesperson', name: 'Alex' }];
  const listings = [
    { user_id: 'u1', vin: 'V1', name: 'Own car', posted_at: ago(5), salesperson: 'Alex', status: 'listed' },
    { user_id: 'u2', vin: 'V2', name: 'Colleague car', posted_at: ago(30), salesperson: 'Pat', status: 'listed', price: 18995 },
  ];
  for (const role of ['salesperson', '', undefined]) {
    assert.equal(summarize({ memberships, listings, role, now: NOW }).notOnTeam, null, `not known for a viewer whose role is ${JSON.stringify(role)}`);
  }
  assert.equal(summarize({ memberships, listings, now: NOW }).notOnTeam, null, 'no role given: not known');
  // the CSV claims no count and lists no car under that heading
  const lines = managerCsv({ memberships, listings }, { role: 'salesperson', now: NOW, timeZone: 'UTC' }).split('\r\n');
  assert.ok(lines.includes(`${NOT_ON_TEAM_TITLE},`), 'the summary row is blank, not 0 or 1');
  const at = lines.indexOf(NOT_ON_TEAM_TITLE);
  assert.ok(at > 0);
  assert.equal(lines[at + 1], csvQuote(NOT_ON_TEAM_UNKNOWN));
  assert.equal(lines[at + 2], '', 'and nothing else in the section');
  assert.match(NOT_ON_TEAM_UNKNOWN, /manager/);
  // the same data seen by a manager, who reads every membership, lists nobody either: Pat is on the team
  const team = [...memberships, { user_id: 'u2', dealership_id: 'd1', role: 'salesperson', name: 'Pat' }];
  assert.deepEqual(summarize({ memberships: team, listings, role: 'manager', now: NOW }).notOnTeam, []);
  // the page hands the viewer's role to both, and draws the card only for a list
  const page = read('manager/manager.js');
  assert.match(page, /summarize\(\{ \.\.\.d, role: myRole\(\),/);
  assert.match(page, /managerCsv\(state\.data, \{ role: myRole\(\),/);
  assert.match(page, /const gone = s\.notOnTeam && s\.notOnTeam\.length/);
});

test('empty or broken input gives zeros, not an exception', () => {
  const s = summarize({ now: NOW, timeZone: 'UTC' });
  assert.deepEqual(s.salespeople, []);
  assert.deepEqual(s.totals, { salespeople: 0, postedThisWeek: 0, postedAllTime: 0, listed: 0, takenDown: 0, postedAttempts: 0, medianSeconds: null });
  assert.equal(s.lastScan, null);
  assert.deepEqual(s.soldStillListed, []);
  const junk = summarize({ listings: 'nope', todoItems: [null, 3, { kind: 'takeDown', flagged_at: 'garbage' }], postAttempts: {}, scans: [{ taken_at: 'never' }], now: 'not a time' });
  assert.equal(junk.soldStillListed.length, 1);
  assert.equal(junk.soldStillListed[0].hoursOpen, null);
  assert.equal(junk.soldStillListed[0].overdue, false);
  assert.equal(junk.lastScan, null);
  assert.equal(summarize().totals.postedAllTime, 0);
  assert.equal(median([]), null);
  assert.equal(hoursBetween(ago(3), NOW), 3);
  assert.equal(fmtLocal(NOW, 'UTC'), '2026-11-16 15:00');
  assert.equal(fmtLocal(NOW, 'Not/AZone').length, 16, 'an unknown zone falls back to this computer\'s');
});

// ---------- the spreadsheet ----------

test('the CSV: header rows, the summary, the definitions and one section per table', () => {
  const d = mockData(NOW);
  const csv = managerCsv(d, { now: NOW, dealer: d.dealership.name, origin: d.dealership.website_origin, timeZone: 'UTC' });
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Lot Current manager numbers,Example Motors,exported 2026-11-16 15:00');
  assert.equal(lines[1], 'Website,https://www.example-motors-springfield.test');
  assert.equal(lines[2], 'Time zone,UTC');
  assert.equal(lines[3], '');
  assert.equal(lines[4], 'Summary,Value');
  const row = (label) => lines.find((l) => l.startsWith(label + ','));
  assert.equal(row('Posted'), 'Posted,8');
  assert.equal(row('Posted in the last 7 days'), 'Posted in the last 7 days,5');
  assert.equal(row('Listings up'), 'Listings up,7');
  assert.equal(row('Median seconds per post'), 'Median seconds per post,49');
  assert.equal(row('Sold cars still listed'), 'Sold cars still listed,2');
  assert.equal(row('Price changes still open'), 'Price changes still open,1');
  assert.equal(row('Median hours from the flagging scan until taken down'), 'Median hours from the flagging scan until taken down,');
  // the definitions, each as one quoted cell (commas inside), the same four
  const at = lines.indexOf('Definitions');
  assert.ok(at > 0);
  const unquote = (l) => (l.startsWith('"') ? l.slice(1, -1).replace(/""/g, '"') : l);
  assert.deepEqual(lines.slice(at + 1, at + 1 + DEFINITIONS.length).map(unquote), [...DEFINITIONS]);
  assert.equal(lines[at + 1 + DEFINITIONS.length], '');
  assert.doesNotMatch(csv, /form fields?/i, 'the manager\'s CSV has no form-field numbers and says nothing of them');
  // the sections and their header rows
  const after = (title) => lines[lines.indexOf(title) + 1];
  assert.equal(after('Salespeople'), 'Salesperson,Posted in the last 7 days,Posted,Listings up,Taken down,Median seconds per post');
  assert.equal(lines[lines.indexOf('Salespeople') + 2], 'Alex,3,5,4,1,47');
  assert.equal(lines[lines.indexOf('Salespeople') + 3], 'Sam,2,3,3,0,57.5');
  assert.equal(after('Sold cars still listed'), 'Flagged,Car,VIN,Salesperson,Hours open,Listing link');
  assert.match(lines[lines.indexOf('Sold cars still listed') + 2], /^2026-11-15 09:00,2021 Jeep Grand Cherokee Limited,SAMPLE00000000002,Alex,30,https:/);
  assert.equal(after('Price changes not yet updated'), 'Flagged,Car,VIN,Salesperson,Hours open,Price from,Price to,Listing link');
  assert.match(lines[lines.indexOf('Price changes not yet updated') + 2], /,21495,20995,/);
  assert.equal(after('Listings'), 'Posted,Salesperson,Car,VIN,Price,Status,Taken down,Listing link');
  assert.equal(lines.filter((l) => /,(listed|taken down),/.test(l)).length, 8, 'every listing is a row');
  assert.equal(after('To-do items'), 'Flagged,Kind,Car,VIN,Salesperson,Done,How,Hours,Price from,Price to');
  assert.equal(after('Post attempts'), 'Post started,Salesperson,Car,VIN,Outcome,Seconds,In a queue,Reason');
  assert.equal(lines.filter((l) => /,(posted|draft|abandoned|blocked),/.test(l)).length, 8, 'every attempt is a row');
  assert.match(csv, /,not-on-website\r\n/);
  // a cell with a comma or a quote is quoted
  const quoted = managerCsv({ listings: [{ vin: 'V', name: 'Car, with "quotes"', posted_at: NOW, salesperson: 'A' }] }, { now: NOW, timeZone: 'UTC' });
  assert.match(quoted, /"Car, with ""quotes"""/);
  assert.equal(csvFileName(NOW, { dealer: 'Example Motors', timeZone: 'UTC' }), 'lot-current-manager-example-motors-2026-11-16.csv');
});

// The website's /for-managers/ page tells a dealership what the manager view's
// CSV carries. Every column of every table in the CSV is either a count, a
// time or a status word, or a detail about a car, a person, a price or a
// link, and each of those details must be named on the page next to its
// "Never buyers, messages ..." line (the page once said only the numbers and
// left out the VINs, the names and the prices). A new column has to be put in
// one list or the other. The CSV is a manager's download, the one with every
// table (a salesperson's has a sentence in place of the cars listed by people
// no longer on the team).
test('the managers page names every car, person, price and link detail the CSV carries', () => {
  const d = mockData(NOW);
  const csv = managerCsv(d, { role: 'manager', now: NOW, dealer: d.dealership.name, origin: d.dealership.website_origin, timeZone: 'UTC' });
  const blocks = csv.split('\r\n\r\n').map((b) => b.split('\r\n'));
  const defs = blocks.findIndex((b) => b[0] === 'Definitions');
  assert.ok(defs > 0, 'the CSV has its Definitions block');
  const notOnTeam = blocks.find((b) => b[0] === NOT_ON_TEAM_TITLE);
  assert.ok(notOnTeam && notOnTeam[1].startsWith('Posted,'), "a manager's download has the table of cars listed by people no longer on the team");
  const columns = new Set(blocks.slice(defs + 1).filter((b) => b.length > 1).flatMap((b) => b[1].split(',')));
  assert.ok(columns.has('VIN') && columns.has('Salesperson') && columns.has('Hours listed'), [...columns].join(', '));
  const NUMBERS = new Set(['Posted in the last 7 days', 'Posted', 'Listings up', 'Taken down', 'Median seconds per post', 'Flagged', 'Hours open', 'Hours listed', 'Status', 'Kind', 'Done', 'How', 'Hours', 'Post started', 'Outcome', 'Seconds', 'In a queue', 'Reason']);
  const DETAILS = {
    Car: /\bthe car's name\b/,
    VIN: /\bVIN\b/,
    Salesperson: /\bwho posted it\b/,
    Price: /\beach listing's price\b/,
    'Price from': /\bthe website's old and new price\b/,
    'Price to': /\bthe website's old and new price\b/,
    'Listing link': /\blisting link\b/,
  };
  const page = read('site-src/pages/for-managers.html');
  const said = page.split('\n').find((l) => l.includes('Never buyers, messages'));
  assert.ok(said, 'site-src/pages/for-managers.html no longer has its "Never buyers, messages" line');
  for (const col of columns) {
    if (NUMBERS.has(col)) continue;
    assert.ok(DETAILS[col], `the manager CSV has a "${col}" column: add it to NUMBERS or DETAILS here, and say it on /for-managers/ if it is a detail`);
    assert.match(said, DETAILS[col], `/for-managers/ does not say the CSV carries the "${col}" column`);
  }
});

// ---------- the Billing card ----------

const inDays = (days) => new Date(Date.parse(NOW) + days * DAY_MS).toISOString();
const DEALER = '00000000-0000-4000-8000-0000000000d1';
// GET .../billing/status's answer, as the function builds it from the row and the role
const status = (over = {}) => ({ ok: true, dealership: { id: DEALER, name: 'Example Motors', websiteOrigin: 'https://www.example-motors-springfield.test' }, role: 'manager', state: 'none', subscription: null, canStartPilot: false, canSubscribe: false, canManageBilling: false, pilotDays: pricing.pilotDays, includedSalespeople: pricing.includedSalespeople, ...over });
const subRow = (over = {}) => ({ dealership_id: DEALER, stripe_customer_id: null, stripe_subscription_id: null, status: null, pilot_ends_at: null, current_period_end: null, seats: pricing.includedSalespeople, updated_at: NOW, ...over });
const card = (st, opts = {}) => billingCard(st, { now: NOW, timeZone: 'UTC', ...opts });

test('billingCard: no plan yet quotes the pilot length and the included seats from the answer, never its own', () => {
  assert.deepEqual(PLAN_STATES, ['none', 'pilot', 'active', 'lapsed']);
  const c = card(status({ state: 'none', canStartPilot: true, canSubscribe: true }));
  assert.equal(c.state, 'none');
  assert.equal(c.label, 'No plan yet');
  assert.equal(c.tone, '');
  assert.equal(c.line, `No plan yet. Start the free pilot: ${pricing.pilotDays} days, ${pricing.includedSalespeople} salespeople included, no card.`);
  assert.equal(c.detail, '');
  assert.equal(c.daysLeft, null);
  assert.deepEqual(c.buttons.map((b) => b.label), ['Start the free pilot', 'Subscribe']);
  assert.deepEqual(c.buttons.map((b) => b.action), ['pilot', 'subscribe']);
  for (const b of c.buttons) assert.ok(b.does.length > 10, 'each button says what it does');
  // the answer's numbers win over the fallback; the fallback fills in when the answer has none; with neither the numbers are left out
  assert.match(card(status({ state: 'none', pilotDays: 14, includedSalespeople: 1 })).line, /: 14 days, 1 salesperson included, no card\.$/);
  assert.equal(card(status({ state: 'none', pilotDays: null, includedSalespeople: null }), { pricing }).line, `No plan yet. Start the free pilot: ${pricing.pilotDays} days, ${pricing.includedSalespeople} salespeople included, no card.`);
  assert.equal(card(status({ state: 'none', pilotDays: null, includedSalespeople: undefined })).line, 'No plan yet. Start the free pilot: no card.');
  // a salesperson is told a manager can start it, and gets nothing to press
  const sp = card(status({ state: 'none', role: 'salesperson' }));
  assert.equal(sp.line, `No plan yet. A manager can start the free pilot: ${pricing.pilotDays} days, ${pricing.includedSalespeople} salespeople included, no card.`);
  assert.deepEqual(sp.buttons, []);
});

test('billingCard: the pilot counts the days left (rounded up) and shows its end as a local date', () => {
  const st = status({ state: 'pilot', canSubscribe: true, subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(18.5) }) });
  const c = card(st);
  assert.equal(c.state, 'pilot');
  assert.equal(c.label, 'Free pilot');
  assert.equal(c.tone, 'good');
  assert.equal(c.daysLeft, 19, '18.5 days left reads as 19');
  assert.equal(c.line, 'Free pilot: 19 days left (ends 2026-12-05).');
  assert.match(c.detail, /first charged when the pilot ends/);
  assert.deepEqual(c.buttons.map((b) => b.label), ['Subscribe']);
  // the same instant is 2026-12-04 in the evening on the US west coast
  assert.equal(card(st, { timeZone: 'America/Los_Angeles' }).line, 'Free pilot: 19 days left (ends 2026-12-04).');
  assert.equal(fmtLocalDate(inDays(18.5), 'UTC'), '2026-12-05');
  // whole days, the last day, and the pill turning amber near the end
  assert.equal(card(status({ state: 'pilot', subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(30) }) })).line, 'Free pilot: 30 days left (ends 2026-12-16).');
  const last = card(status({ state: 'pilot', subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(0.4) }) }));
  assert.equal(last.line, 'Free pilot: 1 day left (ends 2026-11-17).');
  assert.equal(last.tone, 'warn');
  // a salesperson sees the line, no detail about subscribing, no buttons
  const sp = card(status({ state: 'pilot', role: 'salesperson', subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(18.5) }) }));
  assert.equal(sp.line, 'Free pilot: 19 days left (ends 2026-12-05).');
  assert.equal(sp.detail, '');
  assert.deepEqual(sp.buttons, []);
});

test('billingCard: subscribed shows the seats and the renewal date; a trial says when the first charge is', () => {
  const c = card(status({ state: 'active', canManageBilling: true, subscription: subRow({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', seats: 7, current_period_end: inDays(30) }) }));
  assert.equal(c.state, 'active');
  assert.equal(c.label, 'Subscribed');
  assert.equal(c.tone, 'good');
  assert.equal(c.line, 'Subscribed: 7 seats, renews 2026-12-16.');
  assert.deepEqual(c.buttons.map((b) => b.label), ['Manage billing']);
  assert.equal(c.buttons[0].action, 'portal');
  const trial = card(status({ state: 'active', canManageBilling: true, subscription: subRow({ status: 'trialing', stripe_customer_id: 'cus_1', seats: 1, current_period_end: inDays(12), pilot_ends_at: inDays(12) }) }));
  assert.equal(trial.line, 'Subscribed: 1 seat, first charge 2026-11-28.');
  assert.equal(card(status({ state: 'active', subscription: subRow({ status: 'active', seats: null, current_period_end: null }) })).line, 'Subscribed.');
  assert.deepEqual(card(status({ state: 'active', role: 'salesperson', canManageBilling: true, subscription: subRow({ status: 'active' }) })).buttons, [], 'a salesperson never gets a button, whatever the flags say');
});

test('billingCard: a subscription cancelled in the portal never says renews or first charge; it says when it ends', () => {
  const paying = (over) => status({ state: 'active', canManageBilling: true, subscription: subRow({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', seats: 5, current_period_end: inDays(20), ...over }) });
  // Stripe keeps it active until the period ends; the webhook records the date it ends in cancel_at (0009_cancel_at.sql)
  const c = card(paying({ cancel_at: inDays(20) }));
  assert.equal(c.state, 'active', 'still served until then');
  assert.equal(c.label, 'Cancelled');
  assert.equal(c.tone, 'warn');
  assert.equal(c.line, 'Cancelled: 5 seats, ends 2026-12-06 and does not renew.');
  assert.doesNotMatch(c.line, /renews|first charge/);
  assert.equal(c.detail, 'Everything works as it does now until then; Manage billing can renew it.');
  assert.deepEqual(c.buttons.map((b) => b.action), ['portal']);
  // the row has no other cancellation column: a Stripe field the database never stores changes nothing
  assert.equal(card(paying({ cancel_at_period_end: true })).line, 'Subscribed: 5 seats, renews 2026-12-06.', 'only cancel_at, the column the database has, says it is cancelled');
  assert.equal(card(paying({ cancel_at: inDays(20), current_period_end: null })).line, 'Cancelled: 5 seats, ends 2026-12-06 and does not renew.');
  // a trial cancelled before the pilot ends is never charged
  const trial = card(paying({ status: 'trialing', pilot_ends_at: inDays(12), current_period_end: inDays(12), cancel_at: inDays(12) }));
  assert.equal(trial.line, 'Cancelled: 5 seats, ends 2026-11-28 before the first charge.');
  assert.doesNotMatch(trial.line, /first charge 2026/);
  // cancelled from a date after this period: the renewal before it still happens, and the card says both
  const later = card(paying({ cancel_at: inDays(50) }));
  assert.equal(later.label, 'Cancelled');
  assert.equal(later.line, 'Subscribed: 5 seats, renews 2026-12-06; cancelled from 2027-01-05.');
  // a salesperson reads the same line, with nothing to press and no portal hint
  const sp = card(status({ state: 'active', role: 'salesperson', subscription: subRow({ status: 'active', seats: 5, current_period_end: inDays(20), cancel_at: inDays(20) }) }));
  assert.equal(sp.line, 'Cancelled: 5 seats, ends 2026-12-06 and does not renew.');
  assert.equal(sp.detail, '');
  assert.deepEqual(sp.buttons, []);
  // renewed in the portal: the webhook writes cancel_at null, and the line is the renewal again
  for (const undone of [null, undefined, '']) assert.equal(card(paying({ cancel_at: undone })).line, 'Subscribed: 5 seats, renews 2026-12-06.', String(undone));
  // the end has passed and Stripe's last event has not arrived yet (the row still says active): ended, never "ends" on a past day
  const past = card(paying({ current_period_end: inDays(-2), cancel_at: inDays(-2) }));
  assert.equal(past.line, 'Cancelled: 5 seats, ended 2026-11-14.');
  assert.equal(past.detail, '', 'no "until then" for a day that has passed');
  assert.equal(card(paying({ status: 'trialing', cancel_at: inDays(-2) })).line, 'Cancelled: 5 seats, ended 2026-11-14 before the first charge.');
});

test('billingCard: lapsed says so in the agreed words, why, and offers Subscribe (and Manage billing once a customer exists)', () => {
  const words = 'The subscription has lapsed; salespeople can still post, but nothing syncs and the description writer is off until it is renewed.';
  const pilotOver = card(status({ state: 'lapsed', canSubscribe: true, subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(-2) }) }));
  assert.equal(pilotOver.state, 'lapsed');
  assert.equal(pilotOver.label, 'Lapsed');
  assert.equal(pilotOver.tone, 'bad');
  assert.equal(pilotOver.line, words);
  assert.equal(pilotOver.detail, 'The free pilot ended 2026-11-14.');
  assert.deepEqual(pilotOver.buttons.map((b) => b.label), ['Subscribe']);
  const unpaid = card(status({ state: 'lapsed', canSubscribe: true, canManageBilling: true, subscription: subRow({ status: 'past_due', stripe_customer_id: 'cus_1', current_period_end: inDays(3) }) }));
  assert.equal(unpaid.line, words);
  assert.equal(unpaid.detail, 'The last payment did not go through.');
  assert.deepEqual(unpaid.buttons.map((b) => b.label), ['Subscribe', 'Manage billing']);
  assert.equal(card(status({ state: 'lapsed', subscription: subRow({ status: 'canceled' }) })).detail, 'The subscription was cancelled.');
  assert.equal(card(status({ state: 'lapsed', subscription: subRow({ status: 'paused' }) })).detail, 'The subscription is paused.');
  const sp = card(status({ state: 'lapsed', role: 'salesperson', canSubscribe: true, subscription: subRow({ status: 'unpaid' }) }));
  assert.equal(sp.line, words);
  assert.deepEqual(sp.buttons, []);
});

test('billingCard: while the billing function runs on a Stripe test-mode key, the card says so to everyone, whatever the plan', () => {
  assert.equal(BILLING_TEST_MODE_NOTE, 'Billing is in Stripe test mode: only Stripe\'s test cards work, nothing is charged, and a subscription started now does not carry over when real billing starts.');
  for (const st of [
    status({ state: 'none', canStartPilot: true, canSubscribe: true }),
    status({ state: 'pilot', canSubscribe: true, subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(10) }) }),
    status({ state: 'active', canManageBilling: true, subscription: subRow({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', current_period_end: inDays(30) }) }),
    status({ state: 'lapsed', role: 'salesperson', subscription: subRow({ status: 'canceled' }) }),
  ]) {
    assert.equal(card({ ...st, testMode: true }).modeNote, BILLING_TEST_MODE_NOTE, st.state);
    assert.equal(card(st).modeNote, '', `${st.state}: no flag, no note`);
    assert.equal(card({ ...st, testMode: 'true' }).modeNote, '', `${st.state}: only the answer's true`);
  }
  // before billing opens nothing reaches Stripe at all, so there is no mode to speak of
  assert.equal(card({ ...closedBillingStatus('none', null, { role: 'manager' }), testMode: true }).modeNote, '');
  // the page shows it above the plan, and not over a status that could not be read
  const js = read('manager/manager.js');
  assert.match(js, /const mode = !error && card\.modeNote \? `<p class="banner warn">\$\{esc\(card\.modeNote\)\}<\/p>` : '';/);
  assert.match(js, /\$\{note\}\$\{mode\}\$\{body\}/);
});

test('billingCard: no answer, a broken one, or an unknown state gives a card that says so, and never a button', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { ok: false, error: 'x' }, { state: 'gold', role: 'manager', canStartPilot: true }]) {
    const c = card(bad);
    assert.equal(c.state, 'unknown', String(bad));
    assert.equal(c.line, 'The plan could not be read.');
    assert.equal(c.tone, 'warn');
    assert.deepEqual(c.buttons, []);
  }
  assert.doesNotThrow(() => billingCard(status({ state: 'pilot', subscription: subRow({ status: 'pilot', pilot_ends_at: 'garbage' }) }), { now: 'not a time', timeZone: 'Not/AZone' }));
  assert.equal(card(status({ state: 'pilot', subscription: subRow({ status: 'pilot', pilot_ends_at: 'garbage' }) })).line, 'Free pilot running.');
  // the button texts are one list, frozen, with no price in them
  assert.deepEqual(Object.keys(BILLING_BUTTONS), ['pilot', 'subscribe', 'portal']);
  assert.ok(Object.isFrozen(BILLING_BUTTONS.pilot));
  assert.doesNotMatch(JSON.stringify(BILLING_BUTTONS), /\$|\d/);
});

// Before billing opens (manager/config.js billing false) the page reads the
// plan from the database and shapes it with closedBillingStatus(). The free
// pilot is the database's start_pilot(), so a manager still gets it; the
// buttons that need the billing function do not show, and the card says
// whom to ask, so the runbook's "the manager starts the standard pilot with
// Start the free pilot" holds before Stripe exists.
test('billingCard before billing opens: a manager with no plan can start the free pilot and nothing else; a pilot and a lapsed plan say whom to ask', () => {
  const none = card(closedBillingStatus('none', null, { role: 'manager' }), { pricing });
  assert.deepEqual([none.state, none.label, none.tone], ['none', 'No plan yet', '']);
  assert.equal(none.line, `No plan yet. Start the free pilot: ${pricing.pilotDays} days, ${pricing.includedSalespeople} salespeople included, no card.`);
  assert.equal(none.detail, BILLING_CLOSED_NOTE);
  assert.deepEqual(none.buttons.map((b) => b.action), ['pilot']);
  // flags the function would set never bring Subscribe or Manage billing back while it is not there
  assert.deepEqual(card({ ...closedBillingStatus('none', null, { role: 'manager' }), canSubscribe: true, canManageBilling: true }).buttons.map((b) => b.action), ['pilot']);
  // the shell of a row (a customer id, no status, no pilot) still allows the pilot, as start_pilot() does; a pilot or a status never
  assert.equal(closedBillingStatus('none', subRow({ stripe_customer_id: 'cus_1' }), { role: 'manager' }).canStartPilot, true);
  assert.equal(closedBillingStatus('lapsed', subRow({ status: 'pilot', pilot_ends_at: inDays(-2) }), { role: 'manager' }).canStartPilot, false);
  assert.equal(closedBillingStatus('lapsed', subRow({ status: 'canceled' }), { role: 'manager' }).canStartPilot, false);
  // a salesperson: the sentence, nothing to press, no note meant for a manager; no role known: nothing to press
  const sp = card(closedBillingStatus('none', null, { role: 'salesperson' }));
  assert.equal(sp.line, 'No plan yet. A manager can start the free pilot: no card.');
  assert.deepEqual([sp.buttons, sp.detail], [[], '']);
  assert.deepEqual(card(closedBillingStatus('none', null)).buttons, []);
  assert.equal(closedBillingStatus('none', null, { role: 42 }).role, '');
  // a pilot running, started here or recorded by the owner by agreement: its end, and whom to ask about what comes after
  const pilot = card(closedBillingStatus('pilot', subRow({ status: 'pilot', pilot_ends_at: inDays(18.5) }), { role: 'manager' }));
  assert.equal(pilot.line, 'Free pilot: 19 days left (ends 2026-12-05).');
  assert.equal(pilot.detail, BILLING_CLOSED_NOTE, 'not "Subscribe any time"');
  assert.deepEqual(pilot.buttons, [], 'the pilot never restarts, and Subscribe waits for billing');
  // lapsed: why, and whom to ask, since nothing here can renew it yet
  const lapsed = card(closedBillingStatus('lapsed', subRow({ status: 'pilot', pilot_ends_at: inDays(-2) }), { role: 'manager' }));
  assert.equal(lapsed.detail, `The free pilot ended 2026-11-14. ${BILLING_CLOSED_ASK}`);
  assert.deepEqual(lapsed.buttons, []);
  assert.match(BILLING_CLOSED_NOTE, /not open yet[^]*nothing is charged[^]*ask your Lot Current contact/);
  assert.doesNotMatch(BILLING_CLOSED_NOTE + BILLING_CLOSED_ASK, /\$|\d/, 'no price and no number');
  // the page's rule for the pilot is the billing function's (test/billing.test.js holds the two equal)
  assert.deepEqual([pilotAvailable(null), pilotAvailable(subRow()), pilotAvailable(subRow({ status: 'pilot', pilot_ends_at: inDays(3) }))], [true, true, false]);
});

// ---------- the seat line ----------

const INC = pricing.includedSalespeople;

test('billingCard: the seat line reads "N salespeople; the plan includes M" under, at and over the included count, and says what Subscribe asks for', () => {
  const pilot = (n, over = {}) => card(status({ state: 'pilot', canSubscribe: true, salespeople: n, subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(10) }), ...over }));
  const under = pilot(INC - 2);
  assert.equal(under.seatLine, `${INC - 2} salespeople; the plan includes ${INC}.`);
  assert.equal(under.seatNote, `Subscribe asks for the ${INC} seats the plan includes.`);
  assert.deepEqual([under.salespeople, under.subscribeSeats, under.seatTone, under.seatsPaid], [INC - 2, INC, '', null]);
  const at = pilot(INC);
  assert.equal(at.seatLine, `${INC} salespeople; the plan includes ${INC}.`);
  assert.equal(at.seatNote, `Subscribe asks for the ${INC} seats the plan includes.`);
  assert.equal(at.subscribeSeats, INC);
  const over = pilot(INC + 2);
  assert.equal(over.seatLine, `${INC + 2} salespeople; the plan includes ${INC}.`);
  assert.equal(over.seatNote, `Subscribe asks for ${INC + 2} seats, 2 more than the plan includes; Checkout shows the price before you pay.`);
  assert.equal(over.subscribeSeats, INC + 2);
  assert.equal(over.seatTone, '', 'nothing is wrong before a subscription');
  assert.equal(over.line, 'Free pilot: 10 days left (ends 2026-11-26).', 'the plan line is unchanged');
  // one salesperson, none yet; the same line with no plan and after a lapse
  assert.equal(pilot(1).seatLine, `1 salesperson; the plan includes ${INC}.`);
  assert.equal(pilot(0).seatLine, `0 salespeople; the plan includes ${INC}.`);
  assert.equal(card(status({ state: 'none', canStartPilot: true, canSubscribe: true, salespeople: INC + 1 })).seatNote, `Subscribe asks for ${INC + 1} seats, 1 more than the plan includes; Checkout shows the price before you pay.`);
  assert.equal(card(status({ state: 'lapsed', canSubscribe: true, salespeople: INC + 1, subscription: subRow({ status: 'canceled', seats: INC }) })).seatLine, `${INC + 1} salespeople; the plan includes ${INC}.`);
  // M only from the answer (or the tests' pricing): with neither, the line gives N alone and makes no claim about Subscribe
  const noM = pilot(3, { includedSalespeople: null });
  assert.deepEqual([noM.seatLine, noM.seatNote], ['3 salespeople.', '']);
  assert.equal(pilot(3, { includedSalespeople: null }).includedSalespeople, null);
  assert.equal(card(status({ state: 'pilot', canSubscribe: true, salespeople: 3, includedSalespeople: null, subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(10) }) }), { pricing }).seatLine, `3 salespeople; the plan includes ${INC}.`);
  // no price anywhere: the answer carries none
  for (const c of [under, at, over]) assert.doesNotMatch(c.seatLine + c.seatNote, /\$|\d+\s*(a|per)\s*month/);
});

test('billingCard: a failed payment (Stripe still holds the subscription open) shows the seats paid for, and no Subscribe note', () => {
  const pastDue = card(status({ state: 'lapsed', canSubscribe: false, canManageBilling: true, salespeople: INC + 3, subscription: subRow({ status: 'past_due', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', seats: INC }) }));
  assert.equal(pastDue.seatsPaid, INC, 'the open subscription still pays for its seats');
  assert.equal(pastDue.subscribeSeats, null, 'no Subscribe note: Checkout refuses a second subscription');
  assert.equal(pastDue.seatTone, 'warn');
  assert.match(pastDue.seatNote, new RegExp(`^${INC + 3} salespeople and ${INC} seats paid for\\.`));
  assert.ok(!pastDue.buttons.some((b) => b.action === 'subscribe'));
  // a canceled one has ended: Subscribe is offered again, and nothing is paid for
  const canceled = card(status({ state: 'lapsed', canSubscribe: true, salespeople: INC + 1, subscription: subRow({ status: 'canceled', stripe_subscription_id: 'sub_1', seats: INC }) }));
  assert.equal(canceled.seatsPaid, null);
  assert.equal(canceled.subscribeSeats, INC + 1);
});

test('billingCard: no seat line without a manager\'s count, for a salesperson, or for a plan the page cannot read', () => {
  for (const n of [null, undefined, -1, 2.5, '7']) {
    const c = card(status({ state: 'pilot', canSubscribe: true, salespeople: n, subscription: subRow({ status: 'pilot', pilot_ends_at: inDays(10) }) }));
    assert.deepEqual([c.seatLine, c.seatNote, c.salespeople, c.subscribeSeats], ['', '', null, null], String(n));
  }
  // a salesperson's answer has null; a number there would be their own row alone, so it is never shown
  const sp = card(status({ state: 'active', role: 'salesperson', salespeople: 1, subscription: subRow({ status: 'active', seats: INC }) }));
  assert.deepEqual([sp.seatLine, sp.seatNote, sp.salespeople], ['', '', null]);
  assert.equal(card({ state: 'gold', role: 'manager', salespeople: 3, includedSalespeople: INC }).seatLine, '');
});

test('billingCard: subscribed with fewer seats paid for than salespeople says so, and that Lot Current adds none on its own; at or under the seats paid for it says nothing more', () => {
  const active = (n, seats) => card(status({ state: 'active', canManageBilling: true, salespeople: n, subscription: subRow({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', seats, current_period_end: inDays(30) }) }));
  const short = active(INC + 3, INC + 1);
  assert.equal(short.line, `Subscribed: ${INC + 1} seats, renews 2026-12-16.`, 'the seats paid for, from subscriptions.seats');
  assert.equal(short.seatLine, `${INC + 3} salespeople; the plan includes ${INC}.`);
  assert.equal(short.seatNote, `${INC + 3} salespeople and ${INC + 1} seats paid for. ${SEATS_NOT_ADDED}`);
  assert.equal(SEATS_NOT_ADDED, 'Lot Current never adds seats or changes what you pay on its own: to add seats, ask your Lot Current contact.');
  assert.deepEqual([short.seatTone, short.seatsPaid, short.salespeople, short.subscribeSeats], ['warn', INC + 1, INC + 3, null]);
  assert.deepEqual(short.buttons.map((b) => b.action), ['portal'], 'nothing on the card buys a seat');
  assert.equal(active(2, 1).seatNote, `2 salespeople and 1 seat paid for. ${SEATS_NOT_ADDED}`);
  for (const [n, seats] of [[INC + 1, INC + 1], [INC - 1, INC], [0, INC]]) {
    const c = active(n, seats);
    assert.deepEqual([c.seatNote, c.seatTone], ['', ''], `${n} of ${seats}`);
    assert.equal(c.seatLine, `${n} ${n === 1 ? 'salesperson' : 'salespeople'}; the plan includes ${INC}.`);
  }
  // a row without a usable seat count compares nothing
  const unknown = active(INC + 3, null);
  assert.deepEqual([unknown.line, unknown.seatNote, unknown.seatsPaid], ['Subscribed, renews 2026-12-16.', '', null]);
});

test('billingBody: Subscribe sends a seat per salesperson, never fewer than included; Manage billing sends no seats; no count sends none', () => {
  const at = { returnUrl: 'https://manage.example.test/', dealershipId: DEALER };
  const answer = (over) => status({ state: 'pilot', canSubscribe: true, ...over });
  assert.deepEqual(billingBody('checkout', answer({ salespeople: INC + 4 }), at), { ...at, seats: INC + 4 });
  assert.deepEqual(billingBody('checkout', answer({ salespeople: INC }), at), { ...at, seats: INC });
  assert.deepEqual(billingBody('checkout', answer({ salespeople: 2 }), at), { ...at, seats: INC }, 'never fewer than the plan includes');
  assert.deepEqual(billingBody('checkout', answer({ salespeople: 0 }), at), { ...at, seats: INC });
  assert.deepEqual(billingBody('portal', answer({ salespeople: INC + 4 }), at), at);
  assert.deepEqual(billingBody('checkout', answer({ salespeople: null }), at), at, 'no count: the function keeps the row\'s seats or the included count');
  assert.deepEqual(billingBody('checkout', null, at), at);
  assert.deepEqual(billingBody('checkout', answer({ salespeople: 3, role: 'salesperson' }), at), at);
  assert.deepEqual(billingBody('checkout', answer({ salespeople: 3, includedSalespeople: null }), at), { ...at, seats: 3 }, 'no included count in the answer: the count as it is (the function still bills at least the included seats)');
  assert.deepEqual(billingBody('checkout', answer({ salespeople: 0, includedSalespeople: null }), at), at);
  // the card's number and the one sent are the same function
  assert.equal(subscribeSeats(answer({ salespeople: INC + 4 })), card(answer({ salespeople: INC + 4 })).subscribeSeats);
  // the page posts billingBody's answer to billing/checkout or billing/portal, and draws the seat line and its note
  const js = read('manager/manager.js');
  assert.match(js, /callFunction\('POST', `billing\/\$\{route\}`, billingBody\(route, state\.billing\?\.status, \{ returnUrl: returnUrl\(state\.dealershipId\), dealershipId: state\.dealershipId \}\)\)/, 'the return address names the dealership (test/managerPage.test.js runs it)');
  assert.match(js, /card\.seatLine \? `<p class="plan">\$\{esc\(card\.seatLine\)\}<\/p>`/);
  assert.match(js, /card\.seatTone === 'warn' \? 'banner warn' : 'hint'/);
  assert.match(js, /`<p class="plan">\$\{esc\(card\.line\)\}<\/p>\$\{seatLine\}\$\{card\.detail \? [^`]*`<p class="hint">\$\{esc\(card\.detail\)\}<\/p>` : ''\}\$\{seatNote\}`/, 'the card draws the seat line under the plan line, and its note after the detail');
});

test('the sample counts its own salespeople with the seat rule; a new sample dealership has none', () => {
  const d = mockData(NOW);
  assert.equal(d.billing.salespeople, seatCount(d.memberships, d.dealership.id));
  assert.equal(d.billing.salespeople, 2, 'Alex and Sam; Jamie is the manager');
  const c = card(d.billing);
  assert.deepEqual([c.seatLine, c.seatNote], ['2 salespeople.', ''], 'the sample types no included count, so the line gives the count alone');
  const fresh = mockNewDealership({ dealership_id: SAMPLE_NEW_DEALERSHIP_ID, name: 'New Motors', website_origin: 'https://www.new-motors.test' }, { yourName: 'Pat', now: NOW });
  assert.equal(fresh.billing.salespeople, 0);
  assert.equal(card(fresh.billing).seatLine, '0 salespeople.');
});

test('billingReturnNote: one honest line back from Stripe, nothing for anything else', () => {
  assert.match(billingReturnNote('success'), /^Checkout is done\. The plan below updates when Stripe confirms/);
  assert.match(billingReturnNote('success'), /reload/i);
  assert.equal(billingReturnNote('canceled'), 'Checkout was closed before paying. Nothing was charged.');
  assert.equal(billingReturnNote('other'), '');
  assert.equal(billingReturnNote(''), '');
  assert.equal(billingReturnNote(null), '');
});

test('the sample dealership is in a free pilot with 19 days left, seen by a manager, with no price typed into it', () => {
  const b = mockData(NOW).billing;
  assert.equal(b.role, 'manager');
  assert.equal(b.state, 'pilot');
  assert.equal(b.subscription.status, 'pilot');
  assert.equal(b.canStartPilot, false);
  assert.equal(b.canSubscribe, true);
  assert.equal(b.canManageBilling, false);
  assert.equal(b.pilotDays, null, 'the sample does not type the pilot length');
  assert.equal(b.includedSalespeople, null, 'the sample does not type the included seats');
  const c = card(b);
  assert.equal(c.daysLeft, 19);
  assert.equal(c.line, 'Free pilot: 19 days left (ends 2026-12-05).');
  assert.deepEqual(c.buttons.map((x) => x.label), ['Subscribe']);
  // still 19 hours later, as the page re-renders through the day
  assert.equal(billingCard(b, { now: new Date(Date.parse(NOW) + 8 * 3600 * 1000).toISOString(), timeZone: 'UTC' }).daysLeft, 19);
  // the sample's numbers feed summarize and the CSV as before
  assert.equal(summarize(sample()).totals.postedAllTime, 8);
});

// ---------- the Invite codes card ----------

test('inviteCard: a manager gets the two buttons in the SQL\'s two roles; a salesperson, or nobody, gets no button and no code', () => {
  assert.deepEqual(INVITE_ROLES, ['salesperson', 'manager']);
  const c = inviteCard([], { role: 'manager', now: NOW, timeZone: 'UTC' });
  assert.equal(c.manager, true);
  assert.deepEqual(c.buttons.map((b) => b.label), ['Invite a salesperson', 'Invite a manager']);
  assert.deepEqual(c.buttons.map((b) => b.role), ['salesperson', 'manager']);
  for (const b of c.buttons) {
    assert.equal(b.action, 'invite');
    assert.ok(b.does.length > 10, 'each button says what it does');
  }
  assert.deepEqual(c.codes, []);
  assert.equal(c.line, 'A code puts one person into this dealership, as a salesperson or as a manager. It works once and for 7 days.');
  assert.equal(c.hint, INVITE_HINT);
  assert.match(c.hint, /open codes: not used yet and not expired/);
  assert.match(c.hint, /stops working when the manager who made it leaves the dealership or stops being a manager\./, 'the rule redeem_invite and the trigger enforce');
  assert.match(lastDefinition('redeem_invite').sql, /m\.user_id = inv\.created_by[\s\S]{0,160}m\.role = 'manager'/, 'redeem_invite refuses a code whose maker is no longer a manager, not only one who left');
  assert.match(read('supabase/migrations/0001_schema.sql'), new RegExp(`expires_at timestamptz not null default \\(now\\(\\) \\+ interval '${INVITE_DAYS} days'\\)`), 'INVITE_DAYS is the schema\'s');
  const invites = [{ code: 'ABCDEF012345', role: 'salesperson', created_at: NOW }];
  for (const role of ['salesperson', '', undefined, 'owner']) {
    const sp = inviteCard(invites, { role, now: NOW, timeZone: 'UTC' });
    assert.equal(sp.manager, false, String(role));
    assert.deepEqual(sp.buttons, []);
    assert.deepEqual(sp.codes, [], 'a salesperson never sees a code, whatever the list holds');
  }
  // the button texts are one list, frozen, with no number in them
  assert.deepEqual(Object.keys(INVITE_BUTTONS), ['salesperson', 'manager']);
  assert.ok(Object.isFrozen(INVITE_BUTTONS.salesperson) && Object.isFrozen(INVITE_BUTTONS.manager));
  assert.doesNotMatch(JSON.stringify(INVITE_BUTTONS), /\$|\d/);
});

test('inviteCard: codes render as create_invite typed them (upper case, trimmed), newest first, with the local time, the role, the sentence and the copy text', () => {
  const invites = [
    { code: 'abcdef012345', role: 'salesperson', dealership_id: DEALER, created_at: ago(2) },
    { code: ' 0123456789AB ', role: 'manager', dealership_id: DEALER, created_at: ago(0.5) },
    { code: 'FEDCBA987654', dealership_id: DEALER }, // no role, no time: the SQL's default role, dated now
    { code: 'AAAAAAAAAAAA', role: 'salesperson', dealership_id: 'another-dealership' },
    { code: '', role: 'salesperson' }, null, 'junk', { role: 'salesperson' },
  ];
  const c = inviteCard(invites, { role: 'manager', dealershipId: DEALER, now: NOW, timeZone: 'UTC' });
  assert.deepEqual(c.codes.map((x) => x.code), ['FEDCBA987654', '0123456789AB', 'ABCDEF012345']);
  assert.deepEqual(c.codes.map((x) => x.role), ['salesperson', 'manager', 'salesperson']);
  assert.deepEqual(c.codes.map((x) => x.when), ['2026-11-16 15:00', '2026-11-16 14:30', '2026-11-16 13:00']);
  assert.equal(c.codes[0].createdAt, NOW, 'a code without a time is dated now');
  assert.equal(c.codes[1].line, '2026-11-16 14:30 · for a manager · expires 2026-11-23');
  assert.ok(c.codes.every((x) => x.revoke === true), 'every open code has Revoke');
  for (const x of c.codes) {
    assert.match(x.code, /^[0-9A-F]{12}$/, 'as the function types it: 12 upper-case hex characters');
    assert.equal(x.copyText, x.code, 'Copy puts the code alone on the clipboard');
    assert.equal(x.sentence, inviteSentence(x.role));
  }
  // the other dealership's code is listed only when no dealership is asked for
  assert.equal(inviteCard(invites, { role: 'manager', now: NOW, timeZone: 'UTC' }).codes.length, 4);
  assert.equal(inviteCard('nope', { role: 'manager' }).codes.length, 0);
  assert.doesNotThrow(() => inviteCard([{ code: 'x', created_at: 'garbage' }], { role: 'manager', now: 'not a time', timeZone: 'Not/AZone' }));
  assert.equal(inviteCard([{ code: 'x', created_at: 'garbage' }], { role: 'manager', now: NOW, timeZone: 'UTC' }).codes[0].createdAt, NOW);
});

test('inviteCard: the server\'s expiry is shown, an expired code is left out even when sent, and a code made here expires in 7 days', () => {
  const invites = [
    { code: 'AAAAAAAAAAA1', role: 'salesperson', created_at: ago(24), expires_at: ago(-6 * 24) },
    { code: 'AAAAAAAAAAA2', role: 'salesperson', created_at: ago(8 * 24), expires_at: ago(24) }, // expired yesterday
    { code: 'AAAAAAAAAAA3', role: 'manager', created_at: ago(8 * 24) }, // no expiry sent: 7 days after it was made, so gone
    { code: 'AAAAAAAAAAA4', role: 'manager', created_at: ago(1) }, // made on this page an hour ago
    { code: 'aaaaaaaaaaa4', role: 'manager', created_at: ago(1) }, // the same code twice (listed, then made): shown once
  ];
  const c = inviteCard(invites, { role: 'manager', now: NOW, timeZone: 'UTC' });
  assert.deepEqual(c.codes.map((x) => x.code), ['AAAAAAAAAAA4', 'AAAAAAAAAAA1']);
  assert.equal(c.codes[0].expiresAt, new Date(Date.parse(ago(1)) + INVITE_DAYS * DAY_MS).toISOString());
  assert.equal(c.codes[1].expires, '2026-11-22');
});

test('inviteSentence: what the invited person does, in the words the extension\'s Settings uses', () => {
  for (const role of ['salesperson', 'manager']) {
    const s = inviteSentence(role);
    for (const word of ['Settings', 'Account', 'Invite code', 'Join']) assert.ok(s.includes(word), `${role}: "${word}"`);
    assert.match(s, /It works once\.$/);
  }
  const popup = read('extension/popup.js');
  assert.ok(popup.includes('Invite code') && popup.includes('>Join<'), 'the popup still labels the field and the button that way: update inviteSentence and this test together');
  assert.match(inviteSentence('manager'), /the manager view then lets them in/);
  assert.doesNotMatch(inviteSentence('salesperson'), /manager view/);
  assert.equal(inviteSentence(undefined), inviteSentence('salesperson'));
});

test('memberRole: the signed-in person\'s role from the memberships rows, nothing for a stranger or a role the SQL does not know', () => {
  const memberships = [{ user_id: 'u1', role: 'salesperson' }, { user_id: 'u3', role: 'manager' }, { user_id: 'u4', role: 'owner' }];
  assert.equal(memberRole(memberships, 'u3'), 'manager');
  assert.equal(memberRole(memberships, 'u1'), 'salesperson');
  assert.equal(memberRole(memberships, 'u4'), '');
  assert.equal(memberRole(memberships, 'u9'), '');
  assert.equal(memberRole(memberships, ''), '');
  assert.equal(memberRole(undefined, 'u1'), '');
});

test('the sample dealership carries two made-up open invite codes, shown to its manager with the same layout', () => {
  const d = mockData(NOW);
  assert.equal(d.invites.length, 2);
  for (const inv of d.invites) {
    assert.match(inv.code, /^[0-9A-F]{12}$/, 'shaped as create_invite types a code');
    assert.equal(inv.dealership_id, d.dealership.id);
    assert.ok(Date.parse(inv.expires_at) > Date.parse(NOW), 'still open');
  }
  const c = inviteCard(d.invites, { role: d.billing.role, dealershipId: d.dealership.id, now: NOW, timeZone: 'UTC' });
  assert.deepEqual(c.buttons.map((b) => b.label), ['Invite a salesperson', 'Invite a manager']);
  assert.deepEqual(c.codes.map((x) => [x.code, x.when, x.copyText, x.role]), [['ABCDEF012345', '2026-11-16 14:45', 'ABCDEF012345', 'salesperson'], ['0123456789AB', '2026-11-15 13:00', '0123456789AB', 'manager']]);
});

// ---------- the page ----------

const MANAGER_FILES = readdirSync(join(root, 'manager')).filter((f) => /\.(html|js|mjs|css)$/.test(f));

test('the manager page carries no pilot-dealer value and no Meta-affiliation wording', () => {
  assert.ok(MANAGER_FILES.includes('index.html') && MANAGER_FILES.includes('manager.js') && MANAGER_FILES.includes('data.js') && MANAGER_FILES.includes('config.js'));
  for (const name of MANAGER_FILES) {
    const src = read(join('manager', name));
    const hit = src.match(/Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\bRoger\b|ronlewis/i);
    assert.equal(hit, null, `manager/${name} contains "${hit && hit[0]}"`);
    // "not affiliated with Meta Platforms, Inc." is the one allowed mention
    const rest = src.replace(/not affiliated with Meta Platforms, Inc\./g, '');
    for (const re of AFFILIATION) assert.doesNotMatch(rest, re, `manager/${name} matches ${re}`);
    assert.doesNotMatch(src, /service_role/, `manager/${name} must never hold a service key`);
  }
  assert.match(read('manager/index.html'), /Lot Current is not affiliated with Meta Platforms, Inc\./);
});

// Any address gets an account from the sign-in form (sign-up is on, and the
// extension's own sign-in creates the account before an invite is redeemed),
// so the hint says what row-level security actually limits: who sees the
// numbers, not who can sign in.
test('the sign-in hint says any address can get a link and only people a dealership added see its numbers', () => {
  const js = read('manager/manager.js');
  assert.match(js, /<p class="hint">Any email address can get a link, but only people a dealership has added see its numbers\. If the link does not arrive, check the spam folder, then ask whoever set Lot Current up for your store\.<\/p>/);
  assert.doesNotMatch(js, /can sign in\./, 'no claim that the form is closed to outsiders');
  // the claim rests on the link request creating the account, as the extension's does
  assert.match(js, /signInWithOtp\(\{ email, options: \{ emailRedirectTo: pageUrl\(\) \} \}\)/);
  assert.doesNotMatch(js, /shouldCreateUser/);
  assert.match(read('extension/src/account.js'), /create_user: true/);
});

test('the page is relative, mobile-friendly, and offers what the brief names', () => {
  const html = read('manager/index.html');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<link rel="stylesheet" href="manager\.css">/);
  assert.match(html, /<script type="module" src="manager\.js"><\/script>/);
  assert.doesNotMatch(html, /(href|src)="\//, 'no absolute paths: the folder opens from disk');
  const js = read('manager/manager.js');
  assert.match(js, /Download CSV/);
  assert.match(js, /Sign out/);
  // Sign out ends this page's session only: supabase-js's default is global,
  // which would also sign the same person out of the extension on every computer
  assert.match(js, /auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.doesNotMatch(js, /auth\.signOut\(\)/, 'no sign-out with the global default');
  assert.match(js, /Try with sample data/);
  assert.match(js, /signInWithOtp/);
  assert.match(js, /mock=1|get\('mock'\)/);
  assert.match(js, /from '\.\/config\.js'/);
  assert.match(js, /from '\.\/data\.js'/);
  // the Billing card: the three routes, the pilot function, the token pair, the way back from Stripe
  assert.match(js, /billingCard/);
  assert.match(js, /billing\/status\?dealershipId=/);
  assert.match(js, /`billing\/\$\{route\}`/, 'checkout and portal are one POST');
  assert.match(js, /kind === 'portal' \? 'portal' : 'checkout'/);
  assert.match(js, /rpc\('start_pilot', \{ dealership_id: /);
  assert.match(js, /Authorization: `Bearer \$\{await freshToken\(\)\}`/);
  assert.match(js, /apikey: CONFIG\.supabaseAnonKey/);
  assert.match(js, /returnUrl: returnUrl\(state\.dealershipId\)/);
  assert.match(js, /location\.assign\(answer\.url\)/);
  assert.match(js, /billingReturnNote\(params\.get\('billing'\)\)/);
  assert.match(js, /setParam\('billing', null\)/);
  assert.match(js, /history\.replaceState/);
  assert.match(js, /Nothing is called here/, 'sample-data buttons only explain themselves');
  assert.doesNotMatch(js, /\/rest\/v1\/rpc/, 'start_pilot goes through the client, not a hand-built REST call');
  assert.match(read('manager/manager.css'), /\.card \{/);
  const css = read('manager/manager.css');
  assert.match(css, /system-ui/);
  assert.match(css, /@media \(min-width: 700px\)/, 'single column under 700px');
  // the colour variables are the popup's
  const vars = (src) => Object.fromEntries([...src.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const popup = vars(read('extension/popup.css'));
  const page = vars(css);
  for (const k of ['--bg', '--surface', '--text', '--muted', '--line', '--accent', '--accent-text', '--good', '--good-bg', '--warn', '--warn-bg', '--bad', '--bad-bg', '--info-bg', '--radius']) {
    assert.ok(k in page, `${k} is defined`);
    assert.equal(page[k], popup[k], `${k} matches popup.css`);
  }
  // the light and the dark blocks both
  assert.equal((css.match(/--accent:/g) || []).length, 2);
});

test('the page makes invite codes through the client, for managers only, and never reads the invites table', () => {
  const js = read('manager/manager.js');
  assert.match(js, /rpc\('create_invite', \{ dealership_id: /, 'the database function, through the client');
  assert.match(js, /inviteCard\(state\.invites, \{ role: myRole\(\)/);
  assert.match(js, /memberRole\(state\.data\?\.memberships, state\.session\?\.user\?\.id\)/, 'the role comes from the memberships rows');
  assert.match(js, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(js, />Copy</);
  assert.match(js, /Invite codes/);
  assert.doesNotMatch(js, /from\('invites'\)/, 'the page never selects invites: 0002_rls.sql gives the table no read policy');
  assert.match(js, /state\.inviteNote = `Sample data: /, 'sample-data buttons only explain themselves');
  // the SQL the card relies on: the function's parameters and answer, the two roles, upper-case codes, and the table's silence
  const rls = read('supabase/migrations/0002_rls.sql');
  assert.match(rls, /create or replace function public\.create_invite\(dealership_id uuid, role text default 'salesperson'\)/);
  assert.match(rls, /return jsonb_build_object\('code', new_code, 'dealership_id', create_invite\.dealership_id, 'role', wanted\)/);
  assert.match(rls, /if wanted not in \('salesperson', 'manager'\)/);
  assert.match(rls, /new_code := upper\(substr\(md5\(/, 'codes are typed in upper case, as the card renders them');
  assert.doesNotMatch(rls, /on public\.invites for/, 'no policy on invites: the list comes from list_invites()');
  assert.match(read('manager/manager.css'), /\.codes \{/);
  // the open codes and Revoke, through the two manager-only functions
  assert.match(js, /rpc\('list_invites', \{ dealership_id: dealershipId \}\)/);
  assert.match(js, /if \(role !== 'manager'\) return \{ invites: \[\], error: '' \};/, 'a salesperson never calls list_invites');
  assert.match(js, /rpc\('revoke_invite', \{ code \}\)/);
  assert.match(js, />Revoke</);
  assert.match(js, /state\.inviteNote = `Sample data: "Revoke" would cancel/);
  assert.match(rls, /create or replace function public\.list_invites\(dealership_id uuid\)\s+returns table \(code text, role text, created_at timestamptz, expires_at timestamptz\)/);
  assert.match(rls, /create or replace function public\.revoke_invite\(code text\)\s+returns boolean/);
});

test('sign-in comes back as a PKCE code to the page\'s own address, and the page runs under a Content-Security-Policy', () => {
  const js = read('manager/manager.js');
  assert.match(js, /createClient\(CONFIG\.supabaseUrl, CONFIG\.supabaseAnonKey, \{ auth: \{ flowType: 'pkce' \} \}\)/);
  assert.match(js, /emailRedirectTo: pageUrl\(\)/);
  assert.match(js, /url\.search = '';\s+url\.hash = '';/, 'the redirect carries no query and no fragment');
  const html = read('manager/index.html');
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert.ok(csp, 'index.html carries a CSP');
  const script = (csp.match(/script-src ([^;]+)/) || [])[1] || '';
  // scripts from this origin alone: any other host that serves code of anyone's choosing (a CDN of every npm
  // package and GitHub file) would let one missed esc() load an attacker's script with the manager's session
  assert.equal(script.trim(), "'self'", 'scripts from the page\'s own origin only');
  assert.match(CONFIG.supabaseJs, /^\.\/vendor\//, 'the client is served next to the page, so \'self\' covers it');
  assert.equal((csp.match(/connect-src ([^;]+)/) || [])[1], "'self' https://*.supabase.co", 'calls only to this origin and Supabase');
  assert.doesNotMatch(csp, /jsdelivr|unpkg|esm\.sh|cdnjs|skypack/i);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(read('manager/manager.js') + read('manager/data.js'), /style="/, 'no inline style: style-src is \'self\'');
});

test('config.js: six fields, empty means not configured, the client is served next to the page, the functions default to the project\'s own', () => {
  assert.deepEqual(Object.keys(CONFIG).sort(), ['billing', 'functionsUrl', 'selfServeSignup', 'supabaseAnonKey', 'supabaseJs', 'supabaseUrl']);
  assert.equal(CONFIG.selfServeSignup, false, 'the form stays hidden until the owner opens sign-up');
  // billing is off until docs/stripe-setup.md step 5 deploys the function, and that step is what turns it on
  assert.equal(CONFIG.billing, false, 'no billing function is deployed yet (docs/production-setup.md step 3: it comes with Stripe)');
  assert.match(read('manager/config.js'), /docs\/stripe-setup\.md step 5/);
  assert.match(read('docs/stripe-setup.md'), /`billing: true` in `manager\/config\.js`/, 'the step that deploys billing turns the card on');
  assert.match(read('manager/manager.js'), /const billingOpen = \(\) => CONFIG\.billing === true;/, 'only a true turns the calls on');
  assert.match(read('manager/config.js'), /signup_settings\.open[\s\S]*"Self-serve sign-up"/, 'the comment names the switch in the database that is the real gate');
  assert.equal(typeof CONFIG.supabaseUrl, 'string');
  assert.equal(typeof CONFIG.supabaseAnonKey, 'string');
  assert.equal(CONFIG.functionsUrl, '', 'empty: the project\'s own /functions/v1');
  assert.equal(CONFIG.supabaseJs, `./vendor/${SUPABASE_JS.file}`);
  const js = read('manager/manager.js');
  assert.match(js, /CONFIG\.supabaseUrl && CONFIG\.supabaseAnonKey/, 'an empty url means not configured');
  assert.match(js, /trimSlash\(CONFIG\.functionsUrl\) \|\| trimSlash\(CONFIG\.supabaseUrl\) \+ '\/functions\/v1'/, 'the function base is the configured one, else the project URL plus /functions/v1');
});

// The supabase-js the page runs: the npm package's own one-file build
// (package/dist/umd/supabase.js of @supabase/supabase-js@2.117.2, whose
// tarball matched the registry's integrity value), byte for byte, then one
// line that makes it an ES module. A changed byte is a different client
// running with the manager's session, so it fails here until the hash is
// moved on purpose (manager/config.js says how).
const SUPABASE_JS = Object.freeze({
  file: 'supabase-js-2.117.2.js',
  upstreamSha256: '59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd',
  tail: '\n// Lot Current: the build above is a script that defines `supabase`; this line makes it the ES module manager.js imports.\nexport const { createClient } = supabase;\n',
});

test('the vendored supabase-js is the npm build unchanged plus one export line, loads as the module the page imports, and carries its licenses', async () => {
  const bytes = readFileSync(join(root, 'manager/vendor', SUPABASE_JS.file));
  const text = bytes.toString('utf8');
  assert.ok(text.endsWith(SUPABASE_JS.tail), 'the one added line is the last');
  const upstream = bytes.subarray(0, bytes.length - Buffer.byteLength(SUPABASE_JS.tail));
  assert.equal(createHash('sha256').update(upstream).digest('hex'), SUPABASE_JS.upstreamSha256, 'the build itself is unchanged');
  assert.doesNotMatch(text, /\bimport\s*\(|^\s*import\s/m, 'one file: it fetches no other module');
  assert.deepEqual(readdirSync(join(root, 'manager/vendor')).sort(), ['LICENSES.txt', SUPABASE_JS.file], 'nothing else is served from vendor/');
  // the page's import(), and the client it makes, here with a fetch that never leaves the test
  const mod = await import(pathToFileURL(join(root, 'manager/vendor', SUPABASE_JS.file)).href);
  assert.deepEqual(Object.keys(mod), ['createClient']);
  const calls = [];
  const client = mod.createClient('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_test', { auth: { flowType: 'pkce', persistSession: false }, global: { fetch: async (url) => { calls.push(String(url)); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } } });
  const { error } = await client.auth.signInWithOtp({ email: 'manager@example.test', options: { emailRedirectTo: 'https://manage.example.test/' } });
  assert.equal(error, null);
  assert.deepEqual(calls.map((u) => new URL(u).pathname), ['/auth/v1/otp']);
  assert.equal(typeof globalThis.supabase, 'undefined', 'it leaves no global behind');
  // the licenses of what the build bundles travel with it
  const licenses = readFileSync(join(root, 'manager/vendor/LICENSES.txt'), 'utf8');
  for (const name of ['@supabase/supabase-js', '@supabase/auth-js', '@supabase/postgrest-js', '@supabase/realtime-js', '@supabase/storage-js', '@supabase/functions-js', '@supabase/phoenix', 'iceberg-js', 'tslib']) assert.ok(licenses.includes(name), name);
  assert.match(licenses, /Copyright \(c\) 2020 Supabase/);
  assert.match(licenses, /Copyright \(c\) 2014 Chris McCord/);
  assert.match(licenses, /Copyright \(c\) Microsoft Corporation\./);
});

test('the page types no price: the pilot length and the included seats come from the status answer', () => {
  for (const name of MANAGER_FILES) {
    const src = read(join('manager', name));
    assert.doesNotMatch(src, new RegExp(`\\b${pricing.pilotDays}[ -]day`), `manager/${name} types the pilot length`);
    assert.doesNotMatch(src, new RegExp(`\\b${pricing.includedSalespeople} salesp`), `manager/${name} types the included seats`);
    assert.doesNotMatch(src, /\$\s?\d+\s*(a|per)\s*month/i, `manager/${name} quotes a price`);
    assert.doesNotMatch(src, /pilotDays: \d|includedSalespeople: \d/, `manager/${name} sets a pricing number`);
  }
});

test('the CSV never hands a spreadsheet a formula typed as a name', () => {
  const now = '2026-11-16T13:00:00.000Z';
  const data = mockData(now);
  for (const m of data.memberships) m.name = '=HYPERLINK("https://x.test";"' + m.name + '")';
  for (const l of data.listings) { l.salesperson = '=HYPERLINK("https://x.test";"x")'; l.name = '@SUM(1)'; }
  const csv = managerCsv(data, { now, dealer: 'Example Motors', origin: 'https://www.example-motors-springfield.test', timeZone: 'America/New_York' });
  assert.ok(/(^|,)"'=HYPERLINK\(""https:\/\/x\.test"";""/m.test(csv), 'a typed formula is neutralised with a leading apostrophe');
  assert.ok(/(^|,)"'@SUM\(1\)"/m.test(csv));
  assert.ok(!/(^|,)[=@+\-][^,\r\n]*HYPERLINK|(^|,)@SUM/m.test(csv), 'no cell starts with a formula character');
});

test('teamCard: a manager sees everyone with the right actions, the last manager can neither step down nor leave, a salesperson sees nothing', () => {
  const D = 'd1';
  const ms = [
    { user_id: 'u1', dealership_id: D, role: 'salesperson', name: 'Sam' },
    { user_id: 'u2', dealership_id: D, role: 'manager', name: 'Jamie' },
    { user_id: 'u3', dealership_id: D, role: 'salesperson', name: '' },
    { user_id: 'u9', dealership_id: 'other', role: 'manager', name: 'Elsewhere' },
    { user_id: 'u4', dealership_id: D, role: 'owner', name: 'Not a role the SQL knows' },
  ];
  const c = teamCard(ms, { role: 'manager', userId: 'u2', dealershipId: D });
  assert.equal(c.manager, true);
  assert.equal(c.managers, 1);
  assert.deepEqual(c.members.map((m) => [m.name, m.role, m.you]), [['Jamie', 'manager', true], ['No name yet', 'salesperson', false], ['Sam', 'salesperson', false]]);
  const [jamie, , sam] = c.members;
  assert.equal(jamie.roleAction, null, 'the only manager cannot step down');
  assert.equal(jamie.remove, null, 'the only manager cannot leave');
  assert.match(jamie.note, /only manager/);
  assert.deepEqual(sam.roleAction, { to: 'manager', label: 'Make manager' });
  assert.deepEqual(sam.remove, { label: 'Remove', armed: false });
  // the first Remove click arms the button
  assert.deepEqual(teamCard(ms, { role: 'manager', userId: 'u2', dealershipId: D, confirm: 'u1' }).members.find((m) => m.userId === 'u1').remove, { label: 'Click again to remove', armed: true });
  // with two managers, either may step down or leave, in their own words
  const two = teamCard([...ms, { user_id: 'u5', dealership_id: D, role: 'manager', name: 'Riley' }], { role: 'manager', userId: 'u2', dealershipId: D });
  const me = two.members.find((m) => m.userId === 'u2');
  assert.deepEqual(me.roleAction, { to: 'salesperson', label: 'Step down to salesperson' });
  assert.equal(me.remove.label, 'Leave the dealership');
  assert.equal(two.members.find((m) => m.userId === 'u5').roleAction.label, 'Make salesperson');
  // a salesperson reads only their own row: no card
  assert.deepEqual(teamCard(ms, { role: 'salesperson', userId: 'u1' }).members, []);
  assert.equal(teamCard(ms, { role: 'salesperson' }).manager, false);
  assert.doesNotThrow(() => teamCard('junk', { role: 'manager' }));
  assert.match(TEAM_HINT, /always keeps at least one manager/);
  assert.match(TEAM_HINT, /Making a manager a salesperson cancels the unused codes they made, too\./, 'Make salesperson says what it does to their codes (the memberships_forget_invites_on_demote trigger)');
});

test('teamChangeNote: the Team card claims a change only when the database answered the changed row', () => {
  const row = [{ user_id: 'u1' }];
  assert.equal(teamChangeNote('role', 'Sam', 'manager', row), 'Sam is now a manager.');
  assert.equal(teamChangeNote('role', 'Jamie', 'salesperson', row), 'Jamie is now a salesperson.');
  assert.equal(teamChangeNote('remove', 'Sam', undefined, row), 'Sam is no longer in the dealership.');
  assert.equal(teamChangeNote('remove', '', undefined, row), 'This person is no longer in the dealership.');
  // row-level security answers a row this person may no longer touch with no row and no error
  for (const none of [[], null, undefined, {}, 'junk']) {
    assert.equal(teamChangeNote('role', 'Sam', 'manager', none), TEAM_UNCHANGED);
    assert.equal(teamChangeNote('remove', 'Sam', undefined, none), TEAM_UNCHANGED);
  }
  assert.equal(TEAM_UNCHANGED, 'Nothing changed: the team was changed elsewhere.');
});

test('the Team card changes only a member\'s role or removes them, through the rows RLS lets a manager touch', () => {
  const js = read('manager/manager.js');
  assert.match(js, /from\('memberships'\)/);
  assert.match(js, /q\.update\(\{ role: to \}\)\.eq\('user_id', userId\)\.eq\('dealership_id', dealershipId\)\.select\('user_id'\)/, 'the update answers the changed row');
  assert.match(js, /q\.delete\(\)\.eq\('user_id', userId\)\.eq\('dealership_id', dealershipId\)\.select\('user_id'\)/, 'the delete answers the removed row');
  assert.match(js, /const \{ data, error \} = kind === 'remove'/);
  assert.match(js, /state\.teamNote = teamChangeNote\(kind, member && member\.name, to, data\);/, 'the sentence follows the rows that came back');
  // the reload after a change is outside the change's try: a failed read has its own sentence
  const onTeam = js.slice(js.indexOf('async function onTeam('), js.indexOf('\nfunction renderInvites('));
  assert.match(onTeam, /const dealershipId = state\.dealershipId;/, 'the change is for the dealership on screen when it was pressed');
  const failed = onTeam.indexOf("const said = `Couldn't change the team:");
  const reload = onTeam.indexOf('await loadLive(dealershipId);');
  assert.ok(failed > 0 && reload > failed, 'loadLive runs after the change\'s catch, not inside its try');
  assert.match(onTeam.slice(failed, reload), /return renderTeam\(\);\n {2}\}\n {2}try \{\n {4}$/, 'a refused change returns; the reload has a try of its own');
  assert.match(onTeam.slice(reload), /catch \(e\) \{[\s\S]*state\.teamError = `Couldn't refresh the page afterwards: /);
  assert.equal(onTeam.split("Couldn't change the team").length, 2, 'one place says the change failed');
  assert.match(js, /if \(kind === 'remove' && state\.teamConfirm !== userId\)/, 'Remove takes two clicks');
  assert.match(js, /state\.teamNote = kind === 'remove' \? `Sample data: /, 'sample data calls nothing');
  const rls = read('supabase/migrations/0002_rls.sql');
  assert.match(rls, /grant update \(name, role\) on public\.memberships to authenticated;/);
  assert.doesNotMatch(rls, /grant select, update, delete on public\.memberships/);
  assert.match(rls, /create trigger memberships_keep_a_manager\s+before update or delete on public\.memberships/);
  assert.match(rls, /errcode = 'P0006'/);
});

// ---------- self-serve sign-up ----------

const ORIGINS = JSON.parse(read('test/fixtures/website-origins.json'));

test('websiteOrigin: every case of test/fixtures/website-origins.json, the table create_dealership\'s SQL is checked against too', () => {
  assert.ok(ORIGINS.cases.length >= 30, 'the fixture has its cases');
  for (const { input, origin } of ORIGINS.cases) {
    assert.equal(websiteOrigin(input), origin ?? '', `websiteOrigin(${JSON.stringify(input)})`);
  }
  // what it keeps is an origin a browser writes the same way, so the extension sees exactly this string
  for (const { origin } of ORIGINS.cases.filter((c) => c.origin)) assert.equal(new URL(origin).origin, origin);
  // why the rule is written out: new URL() takes these, and the extension would see an IP or an xn-- host
  for (const input of ['https://192.168.1.10', 'https://bücher.de', 'https://[::1]/']) {
    assert.doesNotThrow(() => new URL(input));
    assert.equal(websiteOrigin(input), '', input);
  }
  // beyond the fixture, as create_dealership's SQL answers them today (0007_signup.sql website_origin_of)
  assert.equal(websiteOrigin('https://0x7f.0x1'), '', 'a host a browser reads as an IP address in hex');
  assert.equal(websiteOrigin('https://www.smithford.com:0443'), 'https://www.smithford.com', 'the default port, however it is written');
  assert.equal(websiteOrigin('https://www.smithford.com:/used'), 'https://www.smithford.com', 'an empty port is no port');
  assert.equal(websiteOrigin('https://app.localhost'), '', 'a localhost name');
  assert.equal(websiteOrigin('https://\u212Aia.com'), '', 'a Kelvin sign, whose lower case is an ASCII k, is not a letter here');
  assert.equal(new URL('https://\u212Aia.com').host, 'kia.com', 'while new URL() folds it into one');
  assert.equal(websiteOrigin('\u00a0www.smithford.com\n'), 'https://www.smithford.com', 'trimmed as JavaScript trims');
  assert.equal(websiteOrigin(undefined), '');
  assert.equal(websiteOrigin(null), '');
});

test('signupOriginNote: the origin kept and the address-bar sentence, or the not-usable sentence, as the person types', () => {
  const ok = signupOriginNote('WWW.SmithFord.com/used-inventory/');
  assert.deepEqual(ok, { usable: true, origin: 'https://www.smithford.com', keep: 'Lot Current will keep https://www.smithford.com.', line: 'It must match the address bar on the dealership\'s inventory pages, www included.' });
  const empty = signupOriginNote('   ');
  assert.equal(empty.usable, false);
  assert.equal(empty.keep, '');
  assert.match(empty.line, /address bar on the dealership's inventory pages, www included/);
  const bad = signupOriginNote('192.168.1.10');
  assert.equal(bad.usable, false);
  assert.equal(bad.origin, '');
  assert.match(bad.line, /^That is not a website address Lot Current can use/);
  assert.match(bad.line, /www\.yourdealership\.com/, 'an example with no dealer in it');
});

test('signupProblem: the first empty or unusable box, in the form\'s order, and nothing when all three are filled in', () => {
  const good = { name: 'Example Motors', website: 'www.example-motors.test', yourName: 'Jamie' };
  assert.equal(signupProblem(good), null);
  assert.deepEqual(signupProblem({ ...good, name: '  ' }), { field: 'name', message: 'Type the dealership\'s name.' });
  assert.deepEqual(signupProblem({ ...good, website: '' }), { field: 'website', message: 'Type the dealership\'s website address.' });
  assert.deepEqual(signupProblem({ ...good, website: 'localhost' }), { field: 'website', message: signupOriginNote('localhost').line });
  assert.deepEqual(signupProblem({ ...good, yourName: '' }), { field: 'your_name', message: 'Type your name.' });
  assert.equal(signupProblem({}).field, 'name');
  assert.equal(signupProblem().field, 'name');
});

test('signupRefusal: create_dealership\'s own sentence for every refusal the contract names, after "Couldn\'t start the dealership"', () => {
  const refusals = [
    ['42501', 'sign in first'],
    ['P0008', 'sign-up is not open yet'],
    ['P0005', 'too many attempts; try again in an hour'],
    ['22023', 'the website address is not usable'],
    ['P0010', 'this account already started a dealership'],
    ['P0011', 'no more new dealerships today; try again tomorrow'],
    ['P0009', 'that website already has a dealership: ask its manager for an invite code.'],
  ];
  for (const [code, message] of refusals) {
    const line = signupRefusal({ code, message, details: null, hint: null });
    assert.ok(line.startsWith('Couldn\'t start the dealership: '), code);
    assert.ok(line.includes(message), `${code}: the database's words, as they come`);
    assert.match(line, /[.!?]$/);
  }
  assert.equal(signupRefusal({ message: 'That website already has a dealership.' }), 'Couldn\'t start the dealership: That website already has a dealership.');
  assert.equal(signupRefusal(null), 'Couldn\'t start the dealership: no answer from the server.');
  assert.equal(signupRefusal({ code: 'P0008' }), 'Couldn\'t start the dealership: no answer from the server.');
  assert.equal(signupRefusal('TypeError: Failed to fetch'), 'Couldn\'t start the dealership: TypeError: Failed to fetch.');
});

test('?mock=signup: create_dealership answered in the page, into a new, empty dealership on its free pilot', () => {
  const ok = mockCreateDealership({ name: ' Example Motors ', website: 'HTTPS://www.Example-Motors.test/used/', your_name: 'Jamie' }, { now: NOW });
  assert.equal(ok.error, null);
  const pilotEnds = new Date(Date.parse(NOW) + SAMPLE_PILOT_DAYS * DAY_MS).toISOString();
  assert.deepEqual(ok.data, { dealership_id: SAMPLE_NEW_DEALERSHIP_ID, name: 'Example Motors', website_origin: 'https://www.example-motors.test', pilot_ends_at: pilotEnds }, 'the shape create_dealership answers: the pilot starts with the dealership');
  const pricing = JSON.parse(readFileSync(new URL('../marketing/pricing.json', import.meta.url), 'utf8'));
  assert.equal(SAMPLE_PILOT_DAYS, pricing.pilotDays, 'the sample pilot is as long as the real one (start_pilot() gives pricing.json\'s pilotDays)');
  const refused = mockCreateDealership({ name: 'Example Motors', website: 'https://10.0.0.1/', your_name: 'Jamie' });
  assert.equal(refused.data, null);
  assert.equal(refused.error.code, '22023');
  assert.match(refused.error.message, /not a website address/);
  assert.equal(mockCreateDealership().error.code, '22023');
  assert.notEqual(SAMPLE_NEW_DEALERSHIP_ID, mockData(NOW).dealership.id, 'not the ?mock=1 dealership');

  const d = mockNewDealership(ok.data, { yourName: 'Jamie', now: NOW });
  assert.deepEqual(d.dealership, { id: SAMPLE_NEW_DEALERSHIP_ID, name: 'Example Motors', website_origin: 'https://www.example-motors.test', created_at: NOW });
  assert.deepEqual(d.memberships, [{ user_id: d.memberships[0].user_id, dealership_id: SAMPLE_NEW_DEALERSHIP_ID, role: 'manager', name: 'Jamie' }], 'the person, as its only manager');
  for (const k of ['listings', 'todoItems', 'postAttempts', 'scans', 'invites']) assert.deepEqual(d[k], [], `${k} is empty`);
  assert.equal(d.billing.role, 'manager');
  assert.equal(d.billing.state, 'pilot', 'a self-serve dealership is on its pilot from the first day');
  assert.equal(d.billing.subscription.pilot_ends_at, pilotEnds);
  assert.equal(d.billing.canStartPilot, false);
  assert.equal(d.billing.pilotDays, null, 'no price typed into the sample');
  assert.deepEqual(billingCard(d.billing, { now: NOW, timeZone: 'UTC' }).buttons.map((b) => b.label), ['Subscribe']);
  const g = gettingStarted({ ...d, dealershipId: d.dealership.id, now: NOW });
  assert.deepEqual(g.steps.map((s) => s.done), [true, false, false, false]);
  assert.equal(g.line, '1 of 4 done');
  assert.equal(summarize({ ...d, now: NOW }).totals.postedAllTime, 0);
  assert.doesNotMatch(JSON.stringify(d), /Waynesburg|Ron Lewis|15370|\bRoger\b/i);
});

// ---------- the Getting started card ----------

const D1 = 'd-1';
const member = (id, role, name = id) => ({ user_id: id, dealership_id: D1, role, name });
const listing = (who, hoursAgo, extra = {}) => ({ dealership_id: D1, user_id: who, vin: `V${who}${hoursAgo}`, posted_at: ago(hoursAgo), status: 'listed', ...extra });
const started = (over = {}) => gettingStarted({ billing: { state: 'none', role: 'manager' }, invites: [], memberships: [member('m1', 'manager')], listings: [], dealershipId: D1, now: NOW, ...over });

test('gettingStarted: a new dealership has four steps to do, the first two with a button to the card that does them', () => {
  const g = started();
  assert.deepEqual(g.steps.map((s) => s.key), ['plan', 'invite', 'firstCar', 'twoPosting']);
  assert.deepEqual(g.steps.map((s) => s.title), ['Start the free pilot or subscribe', 'Invite your salespeople', 'First car posted and synced', 'Two salespeople posting']);
  assert.deepEqual(g.steps.map((s) => s.done), [false, false, false, false]);
  assert.deepEqual(g.steps.map((s) => s.action), [{ target: 'billing', label: 'Go to Billing' }, { target: 'invites', label: 'Go to Invite codes' }, null, null]);
  for (const s of g.steps) assert.match(s.line, /^[A-Z][^]*\.$/, `${s.key}: one sentence`);
  assert.equal(g.done, 0);
  assert.equal(g.total, 4);
  assert.equal(g.allDone, false);
  assert.equal(g.line, '0 of 4 done');
  assert.equal(ACTIVE_SALESPEOPLE, 2);
  assert.ok(Object.isFrozen(GETTING_STARTED.plan));
  // the buttons point at the ids the page gives the Billing and Invite codes cards
  const js = read('manager/manager.js');
  assert.match(js, /<section class="card" id="billing">/);
  assert.match(js, /<section class="card" id="invites">/);
});

test('gettingStarted step 1: the free pilot or a subscription; none, lapsed or an unread plan is not done, each in its own words', () => {
  const plan = (state) => started({ billing: state === undefined ? null : { state } }).steps[0];
  assert.deepEqual([plan('pilot').done, plan('active').done], [true, true]);
  assert.equal(plan('pilot').line, 'The free pilot is running.');
  assert.equal(plan('active').line, 'The dealership is subscribed.');
  assert.equal(plan('pilot').action, null, 'a done step has no button');
  for (const s of ['none', 'lapsed', 'gold', undefined]) assert.equal(plan(s).done, false, String(s));
  assert.match(plan('none').line, /start the free pilot, or subscribe, in the Billing card/);
  assert.match(plan('lapsed').line, /lapsed/);
  assert.match(plan(undefined).line, /could not be read/, 'a status that failed to load is not called "no plan"');
  assert.match(plan('gold').line, /could not be read/);
});

test('a lapsed plan Stripe still holds open says what renews it, Manage billing, never Subscribe, in Getting started and on the Billing card', async () => {
  const { statusAnswer } = await import('../supabase/functions/_shared/billing.mjs');
  const answer = (row) => ({ ...status(), ...statusAnswer(row, { role: 'manager', now: NOW }), role: 'manager' });
  const open = (st) => answer(subRow({ status: st, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }));
  const failed = 'Update the card with Manage billing; syncing starts again once Stripe takes the payment.';
  const expect = {
    past_due: ['The last payment did not go through: update the card with Manage billing in the Billing card; syncing starts again once Stripe takes the payment.', `The last payment did not go through. ${failed}`],
    unpaid: ['The last payment did not go through: update the card with Manage billing in the Billing card; syncing starts again once Stripe takes the payment.', `The last payment did not go through. ${failed}`],
    incomplete: ['The first payment did not go through: open Manage billing in the Billing card, or ask your Lot Current contact.', 'The first payment did not go through. Open Manage billing to check the card, or ask your Lot Current contact.'],
    paused: ['The subscription is paused: ask your Lot Current contact, or open Manage billing in the Billing card.', 'The subscription is paused. Ask your Lot Current contact, or open Manage billing.'],
  };
  for (const [st, [stepLine, detail]] of Object.entries(expect)) {
    const s = open(st);
    const c = card(s);
    assert.equal(c.state, 'lapsed', st);
    assert.deepEqual(c.buttons.map((b) => b.label), ['Manage billing'], `${st}: the card offers Manage billing alone`);
    assert.equal(c.detail, detail, `${st}: the card says what Manage billing is for`);
    const step = started({ billing: s }).steps[0];
    assert.deepEqual([step.done, step.line, step.action], [false, stepLine, { target: 'billing', label: 'Go to Billing' }], st);
    assert.doesNotMatch(step.line, /subscribe/i, `${st}: no Subscribe to press`);
    if (st !== 'past_due' && st !== 'unpaid') assert.doesNotMatch(`${step.line} ${c.detail}`, /retr|starts again/, `${st}: no retry promised`);
  }
  // with no customer to open the portal for, both say whom to ask
  const noPortal = { ...open('past_due'), canManageBilling: false };
  assert.equal(card(noPortal).detail, 'The last payment did not go through. Ask your Lot Current contact.');
  assert.equal(started({ billing: noPortal }).steps[0].line, 'The plan has lapsed: ask your Lot Current contact.');
  // a subscription that is over (cancelled, a pilot that ran out) is renewed by Subscribe, as before
  for (const row of [subRow({ status: 'canceled', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }), subRow({ status: 'pilot', pilot_ends_at: inDays(-2) })]) {
    const s = answer(row);
    assert.equal(s.canSubscribe, true);
    assert.equal(started({ billing: s }).steps[0].line, 'The plan has lapsed: subscribe in the Billing card and syncing starts again.');
    assert.ok(card(s).buttons.some((b) => b.action === 'subscribe'));
    assert.doesNotMatch(card(s).detail, /Manage billing|contact/);
  }
  // an answer that offers neither never asks for Subscribe
  assert.equal(started({ billing: { state: 'lapsed', role: 'manager', canSubscribe: false } }).steps[0].line, 'The plan has lapsed: ask your Lot Current contact.');
  // a salesperson's card names no button
  assert.equal(card({ ...open('past_due'), role: 'salesperson' }).detail, 'The last payment did not go through.');
});

test('gettingStarted step 2: an open invite code of this dealership, or a second member', () => {
  const invite = (over) => started(over).steps[1];
  assert.equal(invite({ invites: [{ code: 'ABCDEF012345', role: 'salesperson', dealership_id: D1, created_at: ago(1) }] }).done, true);
  assert.equal(invite({ invites: [{ code: 'ABCDEF012345', role: 'salesperson', dealership_id: D1, created_at: ago(1) }] }).line, 'An invite code is open, waiting to be used.');
  assert.equal(invite({ invites: [{ code: 'AAAAAAAAAAA1', dealership_id: D1, created_at: ago(1) }, { code: 'AAAAAAAAAAA2', dealership_id: D1, created_at: ago(2) }] }).line, '2 invite codes are open, waiting to be used.');
  assert.equal(invite({ memberships: [member('m1', 'manager'), member('s1', 'salesperson')] }).done, true);
  assert.equal(invite({ memberships: [member('m1', 'manager'), member('s1', 'salesperson'), member('s2', 'salesperson')] }).line, '3 people are in the dealership.');
  // not done: an expired code, another dealership's code, another dealership's member, a row with no account
  assert.equal(invite({ invites: [{ code: 'ABCDEF012345', dealership_id: D1, created_at: ago(8 * 24) }] }).done, false);
  assert.equal(invite({ invites: [{ code: 'ABCDEF012345', dealership_id: 'd-2', created_at: ago(1) }] }).done, false);
  assert.equal(invite({ memberships: [member('m1', 'manager'), { ...member('s1', 'salesperson'), dealership_id: 'd-2' }] }).done, false);
  assert.equal(invite({ memberships: [member('m1', 'manager'), { role: 'salesperson', dealership_id: D1 }] }).done, false);
  assert.match(invite({}).line, /Invite codes card/);
});

test('gettingStarted step 3: any listing of this dealership, taken down or not', () => {
  assert.equal(started({ listings: [listing('s1', 500, { status: 'taken_down', taken_down_at: ago(400) })] }).steps[2].done, true);
  assert.equal(started({ listings: [listing('s1', 500)] }).steps[2].line, '1 car posted and synced so far.');
  assert.equal(started({ listings: [listing('s1', 5), listing('s2', 6)] }).steps[2].line, '2 cars posted and synced so far.');
  assert.equal(started({ listings: [{ ...listing('s1', 5), dealership_id: 'd-2' }] }).steps[2].done, false, 'another dealership\'s row');
  assert.match(started().steps[2].line, /^No car yet\./);
});

test('gettingStarted step 4: two different salespeople with a post in the past 7 days; a manager\'s own posts do not count', () => {
  const people = [member('m1', 'manager'), member('s1', 'salesperson'), member('s2', 'salesperson')];
  const four = (list) => started({ memberships: people, listings: list }).steps[3];
  assert.equal(four([listing('s1', 5), listing('s2', 6 * 24)]).done, true);
  assert.equal(four([listing('s1', 5), listing('s2', 6 * 24)]).line, '2 salespeople posted in the past 7 days.');
  assert.equal(four([listing('s1', 5), listing('s1', 6)]).done, false, 'one person twice is one salesperson');
  assert.equal(four([listing('s1', 5), listing('s1', 6)]).line, 'One salesperson posted in the past 7 days; this step needs 2.');
  assert.equal(four([listing('s1', 5), listing('m1', 6)]).done, false, 'the manager posting is not a second salesperson');
  assert.equal(four([listing('s1', 5), listing('s2', 7 * 24 + 1)]).done, false, 'older than 7 days');
  assert.equal(four([listing('s1', 5), listing('s2', -2)]).done, false, 'stamped in the future');
  assert.equal(four([]).line, 'No salesperson has posted in the past 7 days.');
  // someone removed from the dealership is not one of its salespeople posting, as in usage_report's active_salespeople
  const afterRemoval = started({ memberships: [member('m1', 'manager'), member('s1', 'salesperson')], listings: [listing('s1', 5), listing('s2', 30)] });
  assert.deepEqual([afterRemoval.steps[3].done, afterRemoval.steps[3].line], [false, 'One salesperson posted in the past 7 days; this step needs 2.'], 'a removed salesperson\'s post still counted');
  assert.notEqual(afterRemoval.line, 'All four steps done');
  assert.equal(four([listing('s1', 5), listing('x9', 6)]).done, false, 'an account that is not a member');
  for (const f of ['docs/help.md', 'site-src/pages/for-managers.html']) assert.ok(read(f).includes('two different salespeople of the dealership posted in the past 7 days; a manager\'s own posts don\'t count, nor do those of someone no longer in the dealership'), `${f} defines the step as the card counts it`);
  assert.match(lastDefinition('usage_report').sql, /join public\.memberships m on m\.dealership_id = l\.dealership_id and m\.user_id = l\.user_id and m\.role = 'salesperson'/, 'the owner\'s measure (usage_report as the database runs it) counts members with the salesperson role');
  // a row with no account counts by the name the extension recorded, as the Salespeople table does
  assert.equal(four([listing('s1', 5), listing(null, 6, { salesperson: 'Pat' })]).done, true);
  assert.equal(four([listing(null, 6, { salesperson: 'Pat' }), listing(null, 7, { salesperson: 'pat ' })]).done, false, 'the same name twice');
});

test('gettingStarted on the ?mock=1 sample: all four done, so the card is one line', () => {
  const d = mockData(NOW);
  const g = gettingStarted({ ...d, dealershipId: d.dealership.id, now: NOW });
  assert.deepEqual(g.steps.map((s) => s.done), [true, true, true, true]);
  assert.equal(g.allDone, true);
  assert.equal(g.line, 'All four steps done');
  assert.ok(g.steps.every((s) => s.action === null));
  // and without a dealership id, or with junk, it neither throws nor counts anything
  assert.doesNotThrow(() => gettingStarted());
  assert.equal(gettingStarted({ billing: 'x', invites: 'x', memberships: 'x', listings: 'x', now: 'not a time' }).done, 0);
});

test('gettingStarted before billing opens: step 1 is the free pilot alone, which the Billing card can still do, and a lapsed plan says whom to ask', () => {
  const d = mockData(NOW);
  const closed = (billing) => gettingStarted({ ...d, billing, dealershipId: d.dealership.id, now: NOW, billingOpen: false });
  assert.deepEqual(closed(null).steps.map((s) => s.key), ['plan', 'invite', 'firstCar', 'twoPosting']);
  const none = closed(closedBillingStatus('none', null, { role: 'manager' })).steps[0];
  assert.deepEqual([none.title, none.done, none.line, none.action], [PLAN_STEP_CLOSED_TITLE, false, 'No plan yet: start the free pilot in the Billing card.', { target: 'billing', label: 'Go to Billing' }]);
  assert.equal(PLAN_STEP_CLOSED_TITLE, 'Start the free pilot');
  const pilot = closed(closedBillingStatus('pilot', { status: 'pilot', pilot_ends_at: inDays(10) }, { role: 'manager' }));
  assert.deepEqual([pilot.steps[0].done, pilot.steps[0].line, pilot.line], [true, 'The free pilot is running.', 'All four steps done']);
  const lapsed = closed(closedBillingStatus('lapsed', { status: 'pilot', pilot_ends_at: inDays(-2) }, { role: 'manager' })).steps[0];
  assert.deepEqual([lapsed.done, lapsed.line], [false, 'The plan has lapsed, and billing is not open yet: ask your Lot Current contact.']);
  assert.doesNotMatch(JSON.stringify([none, lapsed]), /subscribe/i, 'nothing asks for what the page cannot do yet');
  // once billing is open, the step is as before
  assert.equal(gettingStarted({ ...d, billing: closedBillingStatus('none', null), dealershipId: d.dealership.id, now: NOW }).steps[0].title, GETTING_STARTED.plan.title);
});

test('the page: the Start your dealership form behind the flag, the rpc with the three fields, a live region, and every box labelled', () => {
  const js = read('manager/manager.js');
  assert.match(js, /client\.rpc\('create_dealership', \{ name, website, your_name: yourName \}\)/, 'the database function, through the client, with the contract\'s three parameters');
  assert.match(js, /if \(CONFIG\.selfServeSignup\) return viewSignup\(\);/, 'the flag only decides whether the form shows');
  assert.match(js, /Your account is not a member of any dealership yet\. If you were given an invite code: in the Lot Current extension, sign in under Settings, Account with this same email, enter the code under Invite code and click Join, then reload this page\. Otherwise ask whoever set Lot Current up for your store to add you\./, 'with the flag off the page says where an invite code goes, then whom to ask');
  const view = js.slice(js.indexOf('function viewSignup()'), js.indexOf('function originNoteHtml('));
  assert.ok(view.length > 500, 'viewSignup moved: update this test');
  for (const [id, words] of [['suName', 'W.name'], ['suWebsite', 'W.website'], ['suYou', 'W.yourName']]) {
    assert.ok(view.includes(`<label for="${id}">\${esc(${words})}</label>`), `${id} has a label`);
    assert.match(view, new RegExp(`<input type="text" id="${id}" name="[a-z_]+" required`), `${id} is a text box`);
  }
  assert.match(view, /aria-describedby="suOrigin"/, 'the address box is described by the origin line');
  assert.match(view, /<p class="banner warn error" id="signupError" role="alert"><\/p>/, 'the live region is on the page, empty, from the start');
  assert.match(view, /\$\{esc\(W\.already\)\}/, 'the line for a store that already uses Lot Current');
  assert.match(SIGNUP_WORDS.already, /ask its manager for an invite code and enter it in the Lot Current extension/);
  // a refusal keeps what was typed: onSignup never redraws the form
  const submit = js.slice(js.indexOf('async function onSignup('), js.indexOf('\nfunction downloadCsv('));
  assert.ok(submit.length > 500, 'onSignup moved: update this test');
  assert.doesNotMatch(submit, /viewSignup\(\)|\.reset\(\)/, 'nothing clears the boxes');
  assert.match(submit, /return signupSay\(signupRefusal\(answer && answer\.error\)\);/);
  assert.match(submit, /try \{\s+await loadLive\(made\.dealership_id \|\| null\);/, 'success reads the page again into the new dealership');
  assert.match(read('manager/manager.css'), /\.signup \.banner\.error:empty \{ padding: 0; margin: 0; \}/, 'the empty live region stays in the page');
});

test('?mock=signup: the form whatever the flag says, create_dealership answered in the page, and no network', () => {
  const js = read('manager/manager.js');
  assert.match(js, /if \(params\.get\('mock'\) === 'signup'\) return showMockSignup\(\);/);
  const mock = js.slice(js.indexOf('function showMockSignup()'), js.indexOf('// One line in the form\'s live region.'));
  assert.ok(mock.length > 200, 'showMockSignup moved: update this test');
  assert.match(mock, /viewSignup\(\);/);
  assert.doesNotMatch(mock, /CONFIG\.selfServeSignup/, 'the sample shows the form whatever the flag says');
  assert.doesNotMatch(mock, /connect\(|loadLive\(|fetch\(|import\(/, 'no network in sample-data mode');
  assert.match(mock, /fn === 'create_dealership' \? mockCreateDealership\(args\)/);
  assert.match(js, /const client = state\.mock \? mockClient : state\.supabase;/);
  assert.match(js, /state\.data = mockNewDealership\(made, \{ yourName, now: new Date\(\)\.toISOString\(\) \}\);/);
  // ?mock=1 still opens the sample dealership as before
  assert.match(js, /if \(params\.get\('mock'\) === '1'\) return showMock\(\);/);
  assert.match(js, /state\.data = mockData\(new Date\(\)\.toISOString\(\)\);/);
});

test('the page: Getting started first, for managers only, redrawn with the cards it reads, and its buttons move the focus', () => {
  const js = read('manager/manager.js');
  assert.match(js, /\$\('main'\)\.innerHTML = gettingStartedHtml\(\) \+ scan \+ billingHtml\(\)/, 'above the other cards');
  assert.match(js, /if \(!state\.data \|\| myRole\(\) !== 'manager'\) return '';/);
  assert.match(js, /billing: state\.mock \? state\.data\.billing : state\.billing\?\.status,/, 'the plan the Billing card shows');
  assert.match(js, /invites: state\.invites,/, 'the open codes the Invite codes card shows');
  assert.match(js, /data-action="goto" data-target="\$\{esc\(s\.action\.target\)\}"/);
  assert.match(js, /case 'goto': goToCard\(btn\.dataset\.target\); break;/);
  assert.match(js, /el\.focus\(\{ preventScroll: true \}\);/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  for (const fn of ['renderBilling', 'renderInvites']) {
    const body = js.slice(js.indexOf(`function ${fn}()`), js.indexOf('\n}\n', js.indexOf(`function ${fn}()`)));
    assert.match(body, /renderGettingStarted\(\);/, `${fn} redraws Getting started too`);
  }
  // no query was added for it: the page reads the same tables as before
  const reads = [...js.matchAll(/(?:read|latest)\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(reads, ['dealerships', 'memberships', 'listings', 'todo_items', 'post_attempts', 'scan_summaries']);
  assert.match(read('manager/manager.css'), /\.steps \{/);
});

test('help.md names the Start your dealership form and the Getting started card as the page labels them', () => {
  const help = read('docs/help.md');
  const section = help.slice(help.indexOf('## The manager view'), help.indexOf('## What Lot Current never does'));
  assert.ok(section.length > 200, 'docs/help.md has a manager view section');
  for (const words of [SIGNUP_WORDS.heading, SIGNUP_WORDS.submit, SIGNUP_WORDS.name, SIGNUP_WORDS.website, SIGNUP_WORDS.yourName, 'Getting started', ...Object.values(GETTING_STARTED).map((s) => s.title)]) {
    assert.ok(section.includes(words), `the manager view section does not name "${words}"`);
  }
  assert.match(section, /www included/, 'the address must match the address bar');
  // the Billing card's seat line and the sentence it shows when there are more salespeople than paid seats
  assert.ok(section.includes('the plan includes'), 'the manager view section does not quote the seat line');
  assert.ok(section.includes(SEATS_NOT_ADDED), 'the manager view section does not quote SEATS_NOT_ADDED word for word');
  assert.match(section, /managers don't/i, 'it says who takes a seat');
  assert.match(section, /invite code/i, 'a store that already uses Lot Current asks its manager for a code');
});

// ---------- reading every row ----------

// A table as the hosted API serves it: rows in order, at most `cap` per
// request whatever the range asks, and the total when it is asked for.
function servedTable(rows, { cap = 1000, count = true } = {}) {
  const calls = [];
  const page = async (from, to) => {
    calls.push([from, to]);
    const end = Math.min(to, from + cap - 1);
    return { data: rows.slice(from, end + 1), error: null, count: count && from === 0 ? rows.length : null };
  };
  return { page, calls };
}

test('readAll: every row of a table bigger than the API\'s row cap, in order, the oldest open item included', async () => {
  assert.equal(PAGE_ROWS, 1000, 'Supabase\'s default "Max rows"');
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: `r${i}`, n: i }));
  const t = servedTable(rows);
  const got = await readAll(t.page);
  assert.equal(got.length, 2345);
  assert.deepEqual(got.map((r) => r.n), rows.map((r) => r.n));
  assert.deepEqual(t.calls, [[0, 999], [1000, 1999], [2000, 2999]], 'it stops once it holds the count');

  // the summary on the newest 1,000 of 1,200 to-do items would miss the oldest open take-down
  const items = Array.from({ length: 1200 }, (_, i) => ({ id: `t${i}`, vin: `TESTVIN${String(i).padStart(10, '0')}`, kind: 'takeDown', flagged_at: ago(i + 1), done_at: i === 1199 ? null : ago(i), how: i === 1199 ? null : 'detected', name: i === 1199 ? 'Oldest open' : `Car ${i}` }));
  const cut = summarize({ todoItems: items.slice(0, 1000), now: NOW, timeZone: 'UTC' });
  assert.equal(cut.soldStillListed.length, 0, 'one request\'s worth loses it');
  const whole = summarize({ todoItems: await readAll(servedTable(items).page), now: NOW, timeZone: 'UTC' });
  assert.deepEqual(whole.soldStillListed.map((o) => o.name), ['Oldest open']);
  assert.equal(whole.takeDowns.flagged, 1200);
});

test('readAll: a server cap below the page size, or no count in the answer, still gets every row', async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => ({ id: i }));
  const low = servedTable(rows, { cap: 500 });
  assert.equal((await readAll(low.page)).length, 1234);
  assert.deepEqual(low.calls.map((c) => c[0]), [0, 500, 1000], 'each page starts where the last one ended, not a page size on');
  const blind = servedTable(rows, { count: false });
  assert.equal((await readAll(blind.page)).length, 1234);
  assert.deepEqual(blind.calls.map((c) => c[0]), [0, 1000, 1234], 'without a count it reads until a page comes back empty');
  assert.deepEqual(await readAll(servedTable([]).page), []);
});

test('readAll: a failed page is an error, never a short list; a row seen twice is kept once; it stops at maxPages', async () => {
  let n = 0;
  const failing = async (from) => (n++ === 0 ? { data: Array.from({ length: 1000 }, (_, i) => ({ id: from + i })), error: null, count: 1500 } : { data: null, error: { message: 'canceling statement due to statement timeout' } });
  await assert.rejects(readAll(failing), /statement timeout/);
  // a row added between two requests pushes the last row of page 1 onto page 2
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}` }));
  const shifted = async (from, to) => (from === 0 ? { data: rows.slice(0, 1000), error: null, count: 1500 } : { data: [rows[999], ...rows.slice(1000, to)], error: null, count: null });
  const got = await readAll(shifted);
  assert.equal(new Set(got.map((r) => r.id)).size, got.length, 'no row twice');
  assert.equal(got.length, 1500);
  const endless = async (from) => ({ data: [{ id: `x${from}` }], error: null, count: null });
  await assert.rejects(readAll(endless, { pageRows: 1, maxPages: 5 }), /more than 5 pages/);
});

// ---------- what an empty list may say ----------

test('an empty sold or price list says only that nothing is flagged, and why that is worth less: no scan, an old scan, cars listed by people no longer on the team', () => {
  const D = 'd1';
  const members = [{ user_id: 'u-sam', dealership_id: D, role: 'salesperson', name: 'Sam' }, { user_id: 'u-jamie', dealership_id: D, role: 'manager', name: 'Jamie' }];
  const car = (n, user, over = {}) => ({ id: `l${n}`, dealership_id: D, user_id: user, vin: `TESTVIN${String(n).padStart(10, '0')}`, name: `Car ${n}`, price: 20000, posted_at: ago(100 + n), status: 'listed', salesperson: user === 'u-sam' ? 'Sam' : 'Riley', listing_url: `https://www.facebook.com/marketplace/item/${n}/`, ...over });
  const scan = (hoursAgo) => [{ taken_at: ago(hoursAgo), cars: 40, ready: 30, take_down_count: 0, price_update_count: 0 }];
  const listings = [car(1, 'u-sam'), car(2, 'u-sam'), car(3, 'u-riley'), car(4, 'u-riley'), car(5, 'u-riley', { status: 'taken_down', taken_down_at: ago(5) })];
  const never = ['Every sold car is off Marketplace', 'Every listing shows the website price'];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // no scan yet: no all-clear, and the pill is the plain one
  const none = summarize({ listings: listings.slice(0, 2), memberships: members, role: 'manager', now: NOW, timeZone: 'UTC' });
  assert.equal(none.lastScan, null);
  assert.equal(none.clear.sold.tone, '');
  assert.match(none.clear.sold.line, new RegExp(`^${esc(EMPTY_TAKE_DOWNS)} No scan is recorded yet, so nothing has been checked\\.$`));
  assert.equal(none.clear.price.tone, '');
  assert.match(none.clear.price.line, new RegExp(`^${esc(EMPTY_PRICE_ITEMS)} `));

  // an old scan: amber, with how old
  const old = summarize({ listings: listings.slice(0, 2), memberships: members, scans: scan(60), role: 'manager', now: NOW, timeZone: 'UTC' });
  assert.equal(old.lastScan.stale, true);
  assert.equal(old.clear.sold.tone, 'warn');
  assert.match(old.clear.sold.line, /The last scan is 60 h old, so a car sold since then is not flagged yet\./);
  assert.match(old.clear.price.line, /so a price that changed since then is not flagged yet\./);

  // a removed salesperson's cars that are listed: named, amber, even with a fresh scan; a taken-down one is not
  const gone = summarize({ listings, memberships: members, scans: scan(1), role: 'manager', now: NOW, timeZone: 'UTC' });
  assert.deepEqual(gone.notOnTeam.map((o) => [o.name, o.salesperson]), [['Car 4', 'Riley'], ['Car 3', 'Riley']], 'longest listed first');
  assert.equal(gone.notOnTeam[0].listingUrl, 'https://www.facebook.com/marketplace/item/4/');
  assert.equal(gone.clear.sold.tone, 'warn');
  assert.match(gone.clear.sold.line, /2 cars are still listed by people no longer on the team, and no rescan checks them \(below\)\./);
  assert.match(clearLine('sold', { stale: false, hoursAgo: 1 }, 1).line, /One car is still listed by people no longer on the team, and no rescan checks it \(below\)\./);
  // a salesperson reads only their own membership row: nobody else's car is put on that list for them
  assert.equal(summarize({ listings, memberships: [members[0]], scans: scan(1), role: 'salesperson', now: NOW }).notOnTeam, null);

  // a fresh scan, every listed car a member's: still no all-clear, so still the plain pill, saying only what is known
  const fine = summarize({ listings: listings.slice(0, 2), memberships: members, scans: scan(1), role: 'manager', now: NOW, timeZone: 'UTC' });
  assert.deepEqual(fine.notOnTeam, []);
  assert.deepEqual(fine.clear.sold, { tone: '', line: EMPTY_TAKE_DOWNS });
  assert.deepEqual(fine.clear.price, { tone: '', line: EMPTY_PRICE_ITEMS });
  for (const s of [none, old, gone, fine]) {
    for (const k of ['sold', 'price']) {
      assert.notEqual(s.clear[k].tone, 'good', 'an empty card is never green');
      for (const w of never) assert.ok(!s.clear[k].line.includes(w));
    }
  }
  const js = read('manager/manager.js');
  for (const w of never) assert.ok(!js.includes(w), `manager.js no longer says "${w}"`);
  assert.match(js, /summarize\(\{ \.\.\.d, role: myRole\(\),/, 'only a manager\'s read of the memberships is the whole team');
});
