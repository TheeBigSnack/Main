// The manager view's numbers (Milestone 4): pure functions, no DOM, no
// Supabase, so test/manager.test.js runs them in Node and index.html runs the
// same code on the rows it reads. summarize() turns plain rows of the
// Milestone 4 tables into what the page shows, managerCsv() is the
// spreadsheet, mockData() is a made-up dealership for the demo and the tests.
//
// The rows, as the accounts task creates them (row-level security keeps a
// member inside their own dealership; this file trusts what it is given):
//   listings        id, dealership_id, user_id, vin, name, price, posted_at,
//                   listing_url, salesperson, updated_at, taken_down_at,
//                   status 'listed' | 'taken_down'
//   todo_items      id, dealership_id, vin, kind 'takeDown' | 'price', name,
//                   flagged_at, done_at, how 'detected' | 'manual' | 'cleared',
//                   from_price, to_price
//   post_attempts   id, dealership_id, user_id, vin, name, salesperson, queue,
//                   started_at, ended_at, outcome, seconds, reason
//   scan_summaries  id, dealership_id, website_origin, taken_at, cars, ready,
//                   take_down_count, price_update_count
//   memberships     user_id, dealership_id, role 'salesperson' | 'manager', name
//
// What the shape can and cannot say:
//   - "Sold cars still listed" are the open take-down items (todo_items, kind
//     takeDown, no done_at). A scan summary carries counts, not VINs, so
//     "listings the latest scan no longer has" cannot be derived here; the
//     extension's rescan decides that and writes the to-do item.
//   - A to-do item names no salesperson; the listing with the same VIN does,
//     so each item is joined to its listing for the name and the link.
//   - Posts are counted from listings (the posted registry: one row per
//     post). Seconds per post come from post_attempts with outcome 'posted'.
//
// The definitions are the pilot's (extension/src/pilot.js, DEFINITIONS).
// The two lists must stay word for word equal; the file is not imported so
// the page can be hosted on its own, and test/manager.test.js reads both
// files and compares them.

export const WEEK_MS = 7 * 24 * 3600 * 1000; // "this week" is the last 7 days
export const OVERDUE_HOURS = 24; // an open item past this is shown in red
export const SCAN_STALE_HOURS = 6; // rescans run every 3 hours while Chrome is open; twice that and something is off

export const DEFINITIONS = Object.freeze([
  'Time per post runs from the click on Post to "It\'s posted", the salesperson\'s review and their own Publish click included; abandoned attempts are not in the median.',
  'Form fields count one entry per fill of the Marketplace form (a dry run is not a fill), by field name only: never the values or the description.',
  'A sold car\'s flag starts at the scan that first put the item on To do for the salesperson\'s own listing and ends when Lot Sync sees the listing changed, the person ticks it off, or a clean scan no longer lists it, which counts as "cleared by the website".',
  'A price change\'s flag starts and ends the same way.',
  'Hours run from the flagging scan, and rescans happen every 3 hours while Chrome is open.',
]);

// ---------- time ----------

const nowIso = () => new Date().toISOString();
const ms = (iso) => {
  if (iso === null || iso === undefined || iso === '') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function secondsBetween(fromIso, toIso) {
  const a = ms(fromIso);
  const b = ms(toIso);
  return a === null || b === null ? null : Math.max(0, Math.round((b - a) / 1000));
}

export function hoursBetween(fromIso, toIso) {
  const s = secondsBetween(fromIso, toIso);
  return s === null ? null : Math.round(s / 360) / 10;
}

export function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round(((nums[mid - 1] + nums[mid]) / 2) * 10) / 10;
}

// Local time for the page and the spreadsheet (the rows keep ISO). The sv-SE
// locale is the one whose short style reads 2026-11-16 09:15.
const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' });
    formatters.set(timeZone, f);
  }
  return f;
}
export function resolveTimeZone(timeZone) {
  if (timeZone) {
    try { formatterFor(timeZone); return timeZone; } catch { /* not a zone Intl knows */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export function fmtLocal(iso, timeZone) {
  if (!iso) return '';
  const t = ms(iso);
  return t === null ? String(iso) : formatterFor(resolveTimeZone(timeZone)).format(t);
}

// ---------- rows ----------

const rows = (x) => (Array.isArray(x) ? x.filter((r) => r && typeof r === 'object') : []);
const text = (s, max = 120) => String(s ?? '').trim().slice(0, max);
const vinOf = (r) => text(r.vin, 17).toUpperCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const isTakenDown = (l) => (l.status ? l.status === 'taken_down' : Boolean(l.taken_down_at));
const isListed = (l) => !isTakenDown(l);
const isOpen = (t) => !t.done_at;
const NO_NAME = '(no name)';

// One entry per person: by account when the row carries one, else by the
// name the extension recorded. Memberships come first so their names win.
function peopleOf(memberships, listings, attempts) {
  const people = new Map();
  const keyOf = (r) => (r.user_id ? `id:${r.user_id}` : `name:${text(r.salesperson, 60).toLowerCase() || NO_NAME}`);
  const get = (r) => {
    const key = keyOf(r);
    let p = people.get(key);
    if (!p) {
      p = { key, userId: r.user_id || null, name: '', postedThisWeek: 0, postedAllTime: 0, listed: 0, takenDown: 0, postedAttempts: 0, seconds: [] };
      people.set(key, p);
    }
    if (!p.name && r.salesperson) p.name = text(r.salesperson, 60);
    return p;
  };
  for (const m of memberships) {
    if (m.role !== 'salesperson' || !m.user_id) continue; // a manager who never posts is not a row in the table
    const p = get({ user_id: m.user_id, salesperson: m.name });
    if (m.name) p.name = text(m.name, 60);
  }
  return { people, get };
}

/**
 * @param {object} input
 *   listings, todoItems, postAttempts, scans, memberships: rows as above
 *   now:      ISO time the ages count from (default: the clock)
 *   timeZone: IANA zone for the last-scan line (default: this computer's)
 */
export function summarize({ listings, todoItems, postAttempts, scans, memberships, now = nowIso(), timeZone } = {}) {
  const zone = resolveTimeZone(timeZone);
  const t = ms(now) ?? Date.now();
  const nowAt = new Date(t).toISOString();
  const weekFrom = new Date(t - WEEK_MS).toISOString();
  const L = rows(listings);
  const T = rows(todoItems);
  const A = rows(postAttempts);
  const S = rows(scans);
  const M = rows(memberships);

  // ----- salespeople -----
  const { people, get } = peopleOf(M, L, A);
  for (const l of L) {
    const p = get(l);
    p.postedAllTime += 1;
    const at = ms(l.posted_at);
    if (at !== null && at >= t - WEEK_MS && at <= t) p.postedThisWeek += 1;
    if (isTakenDown(l)) p.takenDown += 1; else p.listed += 1;
  }
  const posted = A.filter((a) => a.outcome === 'posted');
  for (const a of posted) {
    const p = get(a);
    p.postedAttempts += 1;
    const s = num(a.seconds);
    if (s !== null) p.seconds.push(s);
  }
  const salespeople = [...people.values()]
    .map((p) => ({ name: p.name || NO_NAME, userId: p.userId, postedThisWeek: p.postedThisWeek, postedAllTime: p.postedAllTime, listed: p.listed, takenDown: p.takenDown, postedAttempts: p.postedAttempts, medianSeconds: median(p.seconds) }))
    .sort((a, b) => b.postedThisWeek - a.postedThisWeek || b.postedAllTime - a.postedAllTime || a.name.localeCompare(b.name));
  const totals = {
    salespeople: salespeople.length,
    postedThisWeek: salespeople.reduce((n, p) => n + p.postedThisWeek, 0),
    postedAllTime: L.length,
    listed: L.filter(isListed).length,
    takenDown: L.filter(isTakenDown).length,
    postedAttempts: posted.length,
    medianSeconds: median(posted.map((a) => num(a.seconds))),
  };

  // ----- to-do items, joined to the listing with the same VIN -----
  const byVin = new Map();
  for (const l of L) {
    const vin = vinOf(l);
    if (!vin) continue;
    const have = byVin.get(vin);
    // the listing that is up wins; among several, the latest posted
    if (!have || (isListed(l) && !isListed(have)) || (isListed(l) === isListed(have) && (ms(l.posted_at) ?? 0) > (ms(have.posted_at) ?? 0))) byVin.set(vin, l);
  }
  const nameOf = (l) => (l ? get(l).name || text(l.salesperson, 60) || NO_NAME : '');
  const item = (f) => {
    const vin = vinOf(f);
    const l = byVin.get(vin) || null;
    const hoursOpen = hoursBetween(f.flagged_at, nowAt);
    return {
      id: f.id ?? null,
      vin,
      name: text(f.name, 80) || (l && text(l.name, 80)) || vin,
      salesperson: nameOf(l),
      listingUrl: l && l.listing_url ? String(l.listing_url) : '',
      listedPrice: l ? num(l.price) : null,
      flaggedAt: f.flagged_at || null,
      hoursOpen,
      overdue: typeof hoursOpen === 'number' && hoursOpen > OVERDUE_HOURS,
    };
  };
  const longestFirst = (a, b) => (b.hoursOpen ?? -1) - (a.hoursOpen ?? -1) || a.name.localeCompare(b.name);
  const soldStillListed = T.filter((f) => f.kind === 'takeDown' && isOpen(f)).map(item).sort(longestFirst);
  const priceMismatches = T.filter((f) => f.kind === 'price' && isOpen(f)).map((f) => ({ ...item(f), fromPrice: num(f.from_price), toPrice: num(f.to_price) })).sort(longestFirst);

  const flagStats = (flags) => {
    const done = flags.filter((f) => f.done_at && f.how !== 'cleared');
    const hours = done.map((f) => hoursBetween(f.flagged_at, f.done_at)).filter((h) => typeof h === 'number');
    return {
      flagged: flags.length,
      done: done.length,
      detected: done.filter((f) => f.how === 'detected').length,
      cleared: flags.filter((f) => f.how === 'cleared').length,
      open: flags.filter(isOpen).length,
      medianHours: median(hours),
      longestHours: hours.length ? Math.max(...hours) : null,
    };
  };

  // ----- the last scan -----
  let last = null;
  for (const s of S) if (ms(s.taken_at) !== null && (!last || ms(s.taken_at) > ms(last.taken_at))) last = s;
  const lastScan = last ? scanLine(last, nowAt, zone) : null;

  return {
    now: nowAt,
    timeZone: zone,
    week: { from: weekFrom, to: nowAt },
    lastScan,
    scans: S.length,
    salespeople,
    totals,
    soldStillListed,
    priceMismatches,
    takeDowns: flagStats(T.filter((f) => f.kind === 'takeDown')),
    priceUpdates: flagStats(T.filter((f) => f.kind === 'price')),
  };
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function scanLine(s, nowAt, zone) {
  const cars = num(s.cars) ?? 0;
  const ready = num(s.ready) ?? 0;
  const takeDown = num(s.take_down_count) ?? 0;
  const price = num(s.price_update_count) ?? 0;
  const hoursAgo = hoursBetween(s.taken_at, nowAt);
  return {
    takenAt: s.taken_at,
    websiteOrigin: s.website_origin || '',
    cars, ready, takeDownCount: takeDown, priceUpdateCount: price,
    hoursAgo,
    stale: typeof hoursAgo === 'number' && hoursAgo > SCAN_STALE_HOURS,
    line: `Last scan ${fmtLocal(s.taken_at, zone)}: ${plural(cars, 'car')} on the website, ${ready} ready to post, ${takeDown} to take down, ${plural(price, 'price change')}`,
  };
}

// ---------- the spreadsheet ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');
const kindLabel = (k) => (k === 'price' ? 'price change' : 'sold / take down');

// The same numbers as the page, then every listing, every to-do item and
// every post attempt as a row, in the given time zone. Nothing from Facebook
// beyond the listing link the salesperson saved.
/**
 * @param {object} input   listings, todoItems, postAttempts, scans, memberships
 * @param {object} options
 *   now:      ISO time of the export
 *   dealer:   the dealership's name
 *   origin:   the dealership's website origin
 *   timeZone: IANA zone for every time in the file; default: this computer's
 */
export function managerCsv(input = {}, { now = nowIso(), dealer = '', origin = '', timeZone } = {}) {
  const zone = resolveTimeZone(timeZone);
  const local = (iso) => fmtLocal(iso, zone);
  const s = summarize({ ...input, now, timeZone: zone });
  const L = rows(input.listings);
  const T = rows(input.todoItems);
  const A = rows(input.postAttempts);
  const nameFor = new Map(s.salespeople.filter((p) => p.userId).map((p) => [p.userId, p.name]));
  const who = (r) => (r.user_id && nameFor.get(r.user_id)) || text(r.salesperson, 60);
  const listingByVin = new Map(L.map((l) => [vinOf(l), l]));
  const out = [];
  out.push(csvRow(['Lot Sync manager numbers', dealer, `exported ${local(s.now)}`]));
  out.push(csvRow(['Website', origin]));
  out.push(csvRow(['Time zone', zone]));
  out.push('');
  out.push(csvRow(['Summary', 'Value']));
  out.push(csvRow(['Salespeople', s.totals.salespeople]));
  out.push(csvRow(['Posted', s.totals.postedAllTime]));
  out.push(csvRow(['Posted in the last 7 days', s.totals.postedThisWeek]));
  out.push(csvRow(['Listings up', s.totals.listed]));
  out.push(csvRow(['Taken down', s.totals.takenDown]));
  out.push(csvRow(['Median seconds per post', s.totals.medianSeconds]));
  out.push(csvRow(['Sold cars flagged', s.takeDowns.flagged])); // = taken down + still listed + cleared
  out.push(csvRow(['Sold cars taken down', s.takeDowns.done]));
  out.push(csvRow(['Sold cars still listed', s.takeDowns.open]));
  out.push(csvRow(['Sold cars cleared by the website', s.takeDowns.cleared]));
  out.push(csvRow(['Median hours from the flagging scan until taken down', s.takeDowns.medianHours]));
  out.push(csvRow(['Price changes flagged', s.priceUpdates.flagged])); // = updated + still open + cleared
  out.push(csvRow(['Price changes updated', s.priceUpdates.done]));
  out.push(csvRow(['Price changes still open', s.priceUpdates.open]));
  out.push(csvRow(['Price changes cleared by the website', s.priceUpdates.cleared]));
  out.push(csvRow(['Median hours from the flagging scan until updated', s.priceUpdates.medianHours]));
  out.push(csvRow(['Last scan', s.lastScan ? s.lastScan.line : 'none yet']));
  out.push('');
  out.push(csvRow(['Definitions']));
  for (const d of DEFINITIONS) out.push(csvRow([d]));
  out.push('');
  out.push(csvRow(['Salespeople']));
  out.push(csvRow(['Salesperson', 'Posted in the last 7 days', 'Posted', 'Listings up', 'Taken down', 'Median seconds per post']));
  for (const p of s.salespeople) out.push(csvRow([p.name, p.postedThisWeek, p.postedAllTime, p.listed, p.takenDown, p.medianSeconds]));
  out.push('');
  out.push(csvRow(['Sold cars still listed']));
  out.push(csvRow(['Flagged', 'Car', 'VIN', 'Salesperson', 'Hours open', 'Listing link']));
  for (const o of s.soldStillListed) out.push(csvRow([local(o.flaggedAt), o.name, o.vin, o.salesperson, o.hoursOpen, o.listingUrl]));
  out.push('');
  out.push(csvRow(['Price changes not yet updated']));
  out.push(csvRow(['Flagged', 'Car', 'VIN', 'Salesperson', 'Hours open', 'Price from', 'Price to', 'Listing link']));
  for (const o of s.priceMismatches) out.push(csvRow([local(o.flaggedAt), o.name, o.vin, o.salesperson, o.hoursOpen, o.fromPrice, o.toPrice, o.listingUrl]));
  out.push('');
  out.push(csvRow(['Listings']));
  out.push(csvRow(['Posted', 'Salesperson', 'Car', 'VIN', 'Price', 'Status', 'Taken down', 'Listing link']));
  for (const l of [...L].sort((a, b) => (ms(b.posted_at) ?? 0) - (ms(a.posted_at) ?? 0))) {
    out.push(csvRow([local(l.posted_at), who(l), l.name, vinOf(l), num(l.price), isTakenDown(l) ? 'taken down' : 'listed', local(l.taken_down_at), l.listing_url || '']));
  }
  out.push('');
  out.push(csvRow(['To-do items']));
  out.push(csvRow(['Flagged', 'Kind', 'Car', 'VIN', 'Salesperson', 'Done', 'How', 'Hours', 'Price from', 'Price to']));
  for (const f of [...T].sort((a, b) => (ms(b.flagged_at) ?? 0) - (ms(a.flagged_at) ?? 0))) {
    const l = listingByVin.get(vinOf(f));
    out.push(csvRow([local(f.flagged_at), kindLabel(f.kind), f.name || (l && l.name) || '', vinOf(f), l ? who(l) : '', local(f.done_at), f.done_at ? f.how : 'open', f.done_at ? hoursBetween(f.flagged_at, f.done_at) : hoursBetween(f.flagged_at, s.now), num(f.from_price), num(f.to_price)]));
  }
  out.push('');
  out.push(csvRow(['Post attempts']));
  out.push(csvRow(['Post started', 'Salesperson', 'Car', 'VIN', 'Outcome', 'Seconds', 'In a queue', 'Reason']));
  for (const a of [...A].sort((a, b) => (ms(b.started_at) ?? 0) - (ms(a.started_at) ?? 0))) {
    out.push(csvRow([local(a.started_at), who(a), a.name, vinOf(a), a.outcome || 'in progress', num(a.seconds), a.queue ? 'yes' : 'no', a.reason || '']));
  }
  return out.join('\r\n') + '\r\n';
}

const slug = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
export function csvFileName(now = nowIso(), { dealer = '', timeZone } = {}) {
  return `lot-sync-manager-${slug(dealer)}-${fmtLocal(now, timeZone).slice(0, 10)}.csv`;
}

// ---------- sample data ----------

// A small made-up dealership for the demo and the tests: two salespeople,
// eight listings, three open to-do items, a week of post attempts, four
// scans. Every time is relative to `now`. No real dealer, person or town.
export function mockData(now = nowIso()) {
  const t = ms(now) ?? Date.now();
  const ago = (hours) => new Date(t - hours * 3600 * 1000).toISOString();
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const vin = (n) => `SAMPLE${String(n).padStart(11, '0')}`;
  const link = (n) => `https://www.facebook.com/marketplace/item/10000000000000${String(n).padStart(2, '0')}/`;
  const D = uuid(1);
  const ALEX = uuid(101);
  const SAM = uuid(102);
  const JAMIE = uuid(103);
  const origin = 'https://www.example-motors-springfield.test';

  const dealership = { id: D, name: 'Example Motors', website_origin: origin, created_at: ago(24 * 30) };
  const memberships = [
    { user_id: ALEX, dealership_id: D, role: 'salesperson', name: 'Alex' },
    { user_id: SAM, dealership_id: D, role: 'salesperson', name: 'Sam' },
    { user_id: JAMIE, dealership_id: D, role: 'manager', name: 'Jamie' },
  ];

  // [n, who, name, price, posted hours ago, taken down hours ago]
  const cars = [
    [1, ALEX, '2019 Ram 1500 Big Horn', 28995, 288, 144],
    [2, ALEX, '2021 Jeep Grand Cherokee Limited', 34995, 216, null],
    [3, ALEX, '2018 Honda CR-V EX', 21495, 72, null],
    [4, ALEX, '2020 Ford F-150 XLT', 32995, 48, null],
    [5, ALEX, '2017 Toyota Camry SE', 15995, 26, null],
    [6, SAM, '2022 Chevrolet Equinox LT', 24495, 264, null],
    [7, SAM, '2016 Subaru Outback 2.5i', 16995, 96, null],
    [8, SAM, '2020 Dodge Durango GT', 29995, 50, null],
  ];
  const nameOf = { [ALEX]: 'Alex', [SAM]: 'Sam' };
  const listings = cars.map(([n, who, name, price, postedAgo, downAgo]) => ({
    id: uuid(200 + n),
    dealership_id: D,
    user_id: who,
    vin: vin(n),
    name,
    price,
    posted_at: ago(postedAgo),
    listing_url: link(n),
    salesperson: nameOf[who],
    updated_at: ago(downAgo ?? postedAgo),
    taken_down_at: downAgo === null ? null : ago(downAgo),
    status: downAgo === null ? 'listed' : 'taken_down',
  }));

  const todoItems = [
    { id: uuid(301), dealership_id: D, vin: vin(2), kind: 'takeDown', name: cars[1][2], flagged_at: ago(30), done_at: null, how: null, from_price: null, to_price: null },
    { id: uuid(302), dealership_id: D, vin: vin(6), kind: 'takeDown', name: cars[5][2], flagged_at: ago(5), done_at: null, how: null, from_price: null, to_price: null },
    { id: uuid(303), dealership_id: D, vin: vin(3), kind: 'price', name: cars[2][2], flagged_at: ago(8), done_at: null, how: null, from_price: 21495, to_price: 20995 },
  ];

  // [n, who, car index or a name, queue, started hours ago, outcome, seconds, reason]
  const tries = [
    [1, ALEX, 3, false, 72, 'posted', 41, null],
    [2, ALEX, '2015 GMC Sierra 1500 SLE', true, 49, 'abandoned', 25, null],
    [3, ALEX, 4, false, 48, 'posted', 58, null],
    [4, ALEX, '2019 Nissan Rogue SV', false, 30, 'draft', 95, null],
    [5, ALEX, 5, false, 26, 'posted', 47, null],
    [6, SAM, 7, true, 96, 'posted', 49, null],
    [7, SAM, 8, true, 50, 'posted', 66, null],
    [8, SAM, '2018 Kia Sorento LX', false, 20, 'blocked', 4, 'not-on-website'],
  ];
  const postAttempts = tries.map(([n, who, car, queue, startedAgo, outcome, seconds, reason]) => ({
    id: uuid(400 + n),
    dealership_id: D,
    user_id: who,
    vin: typeof car === 'number' ? vin(car) : vin(90 + n),
    name: typeof car === 'number' ? cars[car - 1][2] : car,
    salesperson: nameOf[who],
    queue,
    started_at: ago(startedAgo),
    ended_at: new Date(t - startedAgo * 3600 * 1000 + seconds * 1000).toISOString(),
    outcome,
    seconds,
    reason,
  }));

  const scans = [
    [1, 30, 43, 31, 1, 0],
    [2, 8, 42, 30, 1, 0],
    [3, 5, 41, 29, 2, 0],
    [4, 2, 41, 29, 2, 1],
  ].map(([n, hoursAgo, cars, ready, takeDown, price]) => ({
    id: uuid(500 + n),
    dealership_id: D,
    website_origin: origin,
    taken_at: ago(hoursAgo),
    cars, ready,
    take_down_count: takeDown,
    price_update_count: price,
  }));

  return { dealership, memberships, listings, todoItems, postAttempts, scans };
}
