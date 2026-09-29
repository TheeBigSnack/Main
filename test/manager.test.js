// The manager view (Milestone 4): the numbers in manager/data.js on the
// sample dealership and on hand-built rows, the definitions kept equal to
// the pilot's, the Billing card (Milestone 5) in each plan state, the Invite
// codes card (a manager's two buttons, the codes as create_invite types
// them, the sample's one code), and the page free of pilot-dealer values, of
// typed prices and of anything that sounds like a Meta affiliation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, mockData, managerCsv, csvFileName, fmtLocal, fmtLocalDate, median, hoursBetween, billingCard, billingReturnNote, inviteCard, inviteSentence, memberRole, INVITE_DAYS, DEFINITIONS, OVERDUE_HOURS, WEEK_MS, DAY_MS, PLAN_STATES, BILLING_BUTTONS, INVITE_BUTTONS, INVITE_ROLES, INVITE_HINT } from '../manager/data.js';
import { DEFINITIONS as PILOT_DEFINITIONS } from '../extension/src/pilot.js';
import { CONFIG } from '../manager/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const NOW = '2026-11-16T15:00:00.000Z';
const ago = (hours) => new Date(Date.parse(NOW) - hours * 3600 * 1000).toISOString();
const sample = () => ({ ...mockData(NOW), now: NOW, timeZone: 'UTC' });
const pricing = JSON.parse(read('marketing/pricing.json'));

// ---------- the definitions ----------

test('the definitions are the pilot\'s, sentence for sentence (both files read as text, and both modules)', () => {
  const block = (src, file) => {
    const m = src.match(/export const DEFINITIONS = Object\.freeze\(\[([\s\S]*?)\]\);/);
    assert.ok(m, `${file} has a DEFINITIONS list`);
    return m[1].trim().split('\n').map((l) => l.trim()).filter(Boolean);
  };
  const manager = block(read('manager/data.js'), 'manager/data.js');
  const pilot = block(read('extension/src/pilot.js'), 'extension/src/pilot.js');
  assert.deepEqual(manager, pilot, 'the sentences in manager/data.js must stay equal to extension/src/pilot.js');
  assert.deepEqual([...DEFINITIONS], [...PILOT_DEFINITIONS]);
  assert.equal(DEFINITIONS.length, 5);
  assert.doesNotMatch(read('manager/data.js'), /from ['"]\.\.\/extension/, 'data.js does not import the extension (the page is hosted on its own)');
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
    { vin: 'V1', kind: 'price', flagged_at: ago(1), from_price: 100, to_price: 95 },
  ];
  const s = summarize({ listings, todoItems, now: NOW });
  assert.equal(s.soldStillListed[0].salesperson, 'Sam');
  assert.equal(s.soldStillListed[0].listingUrl, 'https://example.test/new');
  assert.equal(s.soldStillListed[0].name, 'New', 'no name on the item: the listing\'s');
  assert.deepEqual(s.priceMismatches.map((o) => [o.hoursOpen, o.overdue, o.toPrice]), [[25, true, 90], [1, false, 95]]);
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
  assert.equal(lines[0], 'Lot Sync manager numbers,Example Motors,exported 2026-11-16 15:00');
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
  // the definitions, each as one quoted cell (commas inside), the same five
  const at = lines.indexOf('Definitions');
  assert.ok(at > 0);
  const unquote = (l) => (l.startsWith('"') ? l.slice(1, -1).replace(/""/g, '"') : l);
  assert.deepEqual(lines.slice(at + 1, at + 6).map(unquote), [...DEFINITIONS]);
  assert.equal(lines[at + 6], '');
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
  assert.equal(csvFileName(NOW, { dealer: 'Example Motors', timeZone: 'UTC' }), 'lot-sync-manager-example-motors-2026-11-16.csv');
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
  assert.equal(c.line, 'Subscribed: 7 salespeople, renews 2026-12-16.');
  assert.deepEqual(c.buttons.map((b) => b.label), ['Manage billing']);
  assert.equal(c.buttons[0].action, 'portal');
  const trial = card(status({ state: 'active', canManageBilling: true, subscription: subRow({ status: 'trialing', stripe_customer_id: 'cus_1', seats: 1, current_period_end: inDays(12), pilot_ends_at: inDays(12) }) }));
  assert.equal(trial.line, 'Subscribed: 1 salesperson, first charge 2026-11-28.');
  assert.equal(card(status({ state: 'active', subscription: subRow({ status: 'active', seats: null, current_period_end: null }) })).line, 'Subscribed.');
  assert.deepEqual(card(status({ state: 'active', role: 'salesperson', canManageBilling: true, subscription: subRow({ status: 'active' }) })).buttons, [], 'a salesperson never gets a button, whatever the flags say');
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
  assert.match(c.hint, /stops working when the manager who made it leaves/, 'the rule redeem_invite and the trigger enforce');
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
  const never = [/approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i, /compliant with (meta|facebook)/i, /endorsed by (meta|facebook)/i, /affiliated with (meta|facebook)(?! Platforms, Inc\.)/i];
  for (const name of MANAGER_FILES) {
    const src = read(join('manager', name));
    const hit = src.match(/Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\bRoger\b|ronlewis/i);
    assert.equal(hit, null, `manager/${name} contains "${hit && hit[0]}"`);
    // "not affiliated with Meta Platforms, Inc." is the one allowed mention
    const rest = src.replace(/not affiliated with Meta Platforms, Inc\./g, '');
    for (const re of never) assert.doesNotMatch(rest, re, `manager/${name} matches ${re}`);
    assert.doesNotMatch(src, /service_role/, `manager/${name} must never hold a service key`);
  }
  assert.match(read('manager/index.html'), /Lot Sync is not affiliated with Meta Platforms, Inc\./);
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
  assert.match(js, /returnUrl: pageUrl\(\)/);
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
  assert.match(js, /if \(role !== 'manager'\) return \[\];/, 'a salesperson never calls list_invites');
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
  assert.match(script, /'self'/);
  assert.doesNotMatch(script, /\*|'unsafe-inline'|'unsafe-eval'|data:/, 'no wildcard or inline script source');
  assert.ok(script.includes(new URL(CONFIG.supabaseJs).origin), 'the CDN the client loads from is the one script host allowed');
  assert.match(csp, /connect-src 'self' https:\/\/\*\.supabase\.co/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(read('manager/manager.js') + read('manager/data.js'), /style="/, 'no inline style: style-src is \'self\'');
});

test('config.js: four fields, empty means not configured, the client comes from the CDN, the functions default to the project\'s own', () => {
  assert.deepEqual(Object.keys(CONFIG).sort(), ['functionsUrl', 'supabaseAnonKey', 'supabaseJs', 'supabaseUrl']);
  assert.equal(typeof CONFIG.supabaseUrl, 'string');
  assert.equal(typeof CONFIG.supabaseAnonKey, 'string');
  assert.equal(CONFIG.functionsUrl, '', 'empty: the project\'s own /functions/v1');
  assert.match(CONFIG.supabaseJs, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/);
  const js = read('manager/manager.js');
  assert.match(js, /CONFIG\.supabaseUrl && CONFIG\.supabaseAnonKey/, 'an empty url means not configured');
  assert.match(js, /trimSlash\(CONFIG\.functionsUrl\) \|\| trimSlash\(CONFIG\.supabaseUrl\) \+ '\/functions\/v1'/, 'the function base is the configured one, else the project URL plus /functions/v1');
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
