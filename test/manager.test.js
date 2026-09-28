// The manager view (Milestone 4): the numbers in manager/data.js on the
// sample dealership and on hand-built rows, the definitions kept equal to
// the pilot's, and the page free of pilot-dealer values and of anything
// that sounds like a Meta affiliation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, mockData, managerCsv, csvFileName, fmtLocal, median, hoursBetween, DEFINITIONS, OVERDUE_HOURS, WEEK_MS } from '../manager/data.js';
import { DEFINITIONS as PILOT_DEFINITIONS } from '../extension/src/pilot.js';
import { CONFIG } from '../manager/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const NOW = '2026-11-16T15:00:00.000Z';
const ago = (hours) => new Date(Date.parse(NOW) - hours * 3600 * 1000).toISOString();
const sample = () => ({ ...mockData(NOW), now: NOW, timeZone: 'UTC' });

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

test('config.js: three fields, empty means not configured, the client comes from the CDN', () => {
  assert.deepEqual(Object.keys(CONFIG).sort(), ['supabaseAnonKey', 'supabaseJs', 'supabaseUrl']);
  assert.equal(typeof CONFIG.supabaseUrl, 'string');
  assert.equal(typeof CONFIG.supabaseAnonKey, 'string');
  assert.match(CONFIG.supabaseJs, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/);
  const js = read('manager/manager.js');
  assert.match(js, /CONFIG\.supabaseUrl && CONFIG\.supabaseAnonKey/, 'an empty url means not configured');
});
