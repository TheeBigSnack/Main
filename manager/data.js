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
// The Billing card (Milestone 5) is drawn from GET .../billing/status's
// answer instead of rows: { role, state 'none' | 'pilot' | 'active' |
// 'lapsed', subscription (the subscriptions row or null), canStartPilot,
// canSubscribe, canManageBilling, pilotDays, includedSalespeople,
// salespeople (the seat count now, for a manager; null for a salesperson) }.
// billingCard() turns it into one sentence, the seat line and the buttons a
// manager may press, and billingBody() is what Subscribe and Manage billing
// send; the numbers come from the answer (or, in tests, from
// marketing/pricing.json), never from this file.
//
// The Invite codes card is drawn from list_invites(), the dealership's open
// codes (unused, unexpired, made by a manager who still is one), plus the
// codes create_invite() answers on this page. The table itself has no read
// policy; the function checks the caller is a manager. inviteCard() gives a
// manager the two buttons and each open code with Copy and Revoke.
//
// Self-serve sign-up: websiteOrigin() is the origin create_dealership keeps
// for a typed website address, signupOriginNote() and signupProblem() are
// what the Start your dealership form says as the person types and before it
// sends, and signupRefusal() words the database's refusal. gettingStarted()
// is a manager's four first steps, from rows the page already reads.
//
// What the shape can and cannot say:
//   - "Sold cars still listed" are the open take-down items (todo_items, kind
//     takeDown, no done_at). A scan summary carries counts, not VINs, so
//     "listings the latest scan no longer has" cannot be derived here; the
//     extension's rescan decides that and writes the to-do item, and only
//     for the salesperson's own listings. So an empty list says only that
//     nothing is flagged, never that every sold car is off Marketplace:
//     clearLine() words it, with what it rests on (no scan yet, an old
//     scan, listings nobody's extension watches).
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
export const SCAN_STALE_HOURS = 6; // with automatic rescans allowed they run every 3 hours while Chrome is open; twice that and something is off
// What the stale pill says after the hours: why a scan can be that old.
export const SCAN_STALE_WHY = 'rescans run every 3 hours only while a salesperson\'s Chrome is open with automatic rescans allowed';

export const DEFINITIONS = Object.freeze([
  'Time per post runs from the click on Post to "It\'s posted", the salesperson\'s review and their own Publish click included; abandoned attempts are not in the median.',
  'Form fields count one entry per fill of the Marketplace form (a dry run is not a fill), by field name only: never the values or the description.',
  'A sold car\'s flag starts at the scan that first put the item on To do for the salesperson\'s own listing and ends when Lot Current sees the listing changed, the person ticks it off, or a clean scan no longer lists it, which counts as "cleared by the website".',
  'A price change\'s flag starts and ends the same way.',
  'Hours run from the flagging scan, and with automatic rescans allowed, rescans happen every 3 hours while Chrome is open.',
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
 *   wholeTeam: true when `memberships` is every member of the dealership (a
 *              manager reads them all; a salesperson reads only their own
 *              row), so a listing whose user is not among them belongs to
 *              someone no longer in the dealership
 *   now:      ISO time the ages count from (default: the clock)
 *   timeZone: IANA zone for the last-scan line (default: this computer's)
 */
export function summarize({ listings, todoItems, postAttempts, scans, memberships, wholeTeam = false, now = nowIso(), timeZone } = {}) {
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

  // ----- listings nobody's extension watches -----
  // up, and posted by someone who is no longer a member: their extension
  // stopped syncing when they were removed, and a rescan only flags its own
  // salesperson's listings, so nothing flags a sale or a price change on them
  const members = new Set(M.map((m) => m.user_id).filter(Boolean));
  const unwatched = !wholeTeam ? [] : L
    .filter((l) => isListed(l) && !(l.user_id && members.has(l.user_id)))
    .map((l) => ({ vin: vinOf(l), name: text(l.name, 80) || vinOf(l), salesperson: text(l.salesperson, 60), listingUrl: l.listing_url ? String(l.listing_url) : '', postedAt: l.posted_at || null, hoursUp: hoursBetween(l.posted_at, nowAt) }))
    .sort((a, b) => (b.hoursUp ?? -1) - (a.hoursUp ?? -1) || a.name.localeCompare(b.name));

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
    unwatched,
    clear: { sold: clearLine('sold', lastScan, unwatched.length), price: clearLine('price', lastScan, unwatched.length) },
    takeDowns: flagStats(T.filter((f) => f.kind === 'takeDown')),
    priceUpdates: flagStats(T.filter((f) => f.kind === 'price')),
  };
}

// What an empty "Sold cars still listed" or "Price changes not yet updated"
// says, and its pill's tone. Only what the rows support: nothing is flagged
// on a synced listing, each salesperson's extension checks only their own
// listings, and why that is worth less when there is no scan yet, the last
// one is old, or some listings are up with nobody watching them. 'good' only
// when none of those holds; 'warn' for an old scan or unwatched listings; ''
// when nothing has been scanned yet.
const CLEAR_WORDS = Object.freeze({
  sold: { none: 'No sold car is flagged on a synced listing.', since: 'a car sold since then' },
  price: { none: 'No price change is flagged on a synced listing.', since: 'a price that changed since then' },
});
export function clearLine(kind, lastScan, unwatchedCount = 0) {
  const w = CLEAR_WORDS[kind] || CLEAR_WORDS.sold;
  const parts = [w.none, 'Each salesperson\'s extension checks their own listings when it rescans.'];
  let tone = 'good';
  if (!lastScan) {
    parts.push('No scan is recorded yet, so nothing has been checked.');
    tone = '';
  } else if (lastScan.stale) {
    parts.push(`The last scan is ${typeof lastScan.hoursAgo === 'number' ? `${lastScan.hoursAgo} h` : 'hours'} old, so ${w.since} is not flagged yet.`);
    tone = 'warn';
  }
  const n = count(unwatchedCount) || 0;
  if (n) {
    parts.push(`${n === 1 ? 'One listing is' : `${n} listings are`} up from people no longer in the dealership, and nobody's extension watches ${n === 1 ? 'it' : 'them'} (below).`);
    tone = 'warn';
  }
  return { tone, line: parts.join(' ') };
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

// ---------- reading every row ----------

// The hosted API answers at most its "Max rows" per request (1,000 unless
// the owner changed it) and drops the rest without an error, and a
// dealership's listings, to-do items and post attempts are kept until the
// dealership is deleted, so a table read in one request would lose its
// oldest rows, and the numbers and the CSV with them. readAll() asks page
// after page: `page(from, to)` is one request for that range of rows,
// answering as supabase-js does ({ data, error, count }). It stops once it
// holds `count` rows (the first page asks for it) or a page comes back
// empty, so a server cap below PAGE_ROWS loses nothing either. A row with an
// id is kept once (a row added between two requests shifts the order by
// one). A failed page is an error, never a short list.
export const PAGE_ROWS = 1000;
export const MAX_PAGES = 1000;
export async function readAll(page, { pageRows = PAGE_ROWS, maxPages = MAX_PAGES } = {}) {
  const out = [];
  const seen = new Set();
  let total = null;
  let offset = 0;
  for (let n = 0; ; n += 1) {
    if (n >= maxPages) throw new Error(`more than ${maxPages} pages of rows; the page stops reading rather than show part of them`);
    const { data, error, count } = (await page(offset, offset + pageRows - 1)) || {};
    if (error) throw new Error((error && error.message) || String(error));
    const got = Array.isArray(data) ? data : [];
    if (typeof count === 'number' && count >= 0) total = count;
    for (const r of got) {
      const id = r && typeof r === 'object' && r.id !== null && r.id !== undefined ? String(r.id) : null;
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(r);
    }
    offset += got.length;
    if (!got.length || (total !== null && offset >= total)) return out;
  }
}

// ---------- a sign-in answer this page did not ask for ----------

// The page signs in with the PKCE flow: its own link comes back with a
// one-time ?code= that supabase-js exchanges with the verifier this browser
// kept. Two other answers can land here, because the project's Site URL is
// this page: #access_token=...&refresh_token=... from an implicit-flow link
// (an email asked for elsewhere without a PKCE challenge: an extension from
// before it sent one, or a call made by hand), and #error=... when the auth
// server refused a link. supabase-js would refuse either and, doing so,
// remove a session this browser already has, while the fragment stays in
// the address bar. authFragment() reads the fragment so the page can take
// it out of the address before supabase-js starts, end the session those
// tokens opened, and say one sentence. The sentences never quote the
// address: anyone can write words into a link.
export const STRAY_LINK_NOTE = 'That link was not asked for on this page, so it does not sign you in here. Asked from the Lot Current extension? Ask it for a new code: opening the link used this one up. To sign in here, send yourself a link below.';
export const FAILED_LINK_NOTE = 'That sign-in link did not work: it may have expired, been used already, or been replaced by a newer email. Send yourself a new one below.';
export const UNUSED_CODE_NOTE = 'That sign-in link did not sign you in here. A link asked for on this page works once, in the browser that asked for it. One asked for in the Lot Current extension never signs in here, and opening it used up its code: ask the extension for a new one. To sign in here, send yourself a link below.';

/**
 * @param {string} hash  location.hash, with or without the leading #
 * @returns {null | { accessToken: string, note: string }}  null when the
 *   fragment carries neither a token nor an auth error
 */
export function authFragment(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const accessToken = p.get('access_token') || '';
  const tokens = Boolean(accessToken || p.get('refresh_token') || p.get('provider_token'));
  const failed = Boolean(p.get('error') || p.get('error_code') || p.get('error_description'));
  if (!tokens && !failed) return null;
  return { accessToken, note: tokens ? STRAY_LINK_NOTE : FAILED_LINK_NOTE };
}

// A link the auth server refused (expired, used, replaced by a newer email)
// on this page's own PKCE flow comes back with the error in the query as
// well as in the fragment: ?error=...&error_code=...&error_description=...
// supabase-js reads the query too, takes an error_description there for a
// failed sign-in and removes a session this browser already has; and the
// words would stay in the address bar. authQueryError() names the error
// parameters the query carries, so the page takes them out before
// supabase-js starts, and says FAILED_LINK_NOTE.
export const AUTH_ERROR_PARAMS = Object.freeze(['error', 'error_code', 'error_description']);
/**
 * @param {string} search  location.search, with or without the leading ?
 * @returns {null | { params: string[], note: string }}  null when the query
 *   carries no auth error
 */
export function authQueryError(search) {
  const p = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  const params = AUTH_ERROR_PARAMS.filter((k) => p.has(k));
  return params.length ? { params, note: FAILED_LINK_NOTE } : null;
}

// ---------- billing ----------

export const DAY_MS = 24 * 3600 * 1000;
export const PLAN_STATES = Object.freeze(['none', 'pilot', 'active', 'lapsed']);
export const PILOT_WARN_DAYS = 3; // this close to the end the pilot pill turns amber

// The three buttons, with what each does in words: the page shows `does`
// as a note in sample-data mode instead of calling anything.
export const BILLING_BUTTONS = Object.freeze({
  pilot: Object.freeze({ action: 'pilot', label: 'Start the free pilot', does: 'starts the dealership\'s free pilot; no card is asked for' }),
  subscribe: Object.freeze({ action: 'subscribe', label: 'Subscribe', does: 'opens Stripe Checkout to pay by card, then comes back to this page' }),
  portal: Object.freeze({ action: 'portal', label: 'Manage billing', does: 'opens Stripe\'s billing portal to change the card, see invoices or cancel' }),
});

// Who takes a seat: a copy of supabase/functions/_shared/billing.mjs, word
// for word, because this page is hosted on its own and cannot import it
// (test/billing.test.js holds the two equal). The billing function counts
// with it for the status answer; the sample data counts its own members.
export const SEAT_ROLE = 'salesperson';
export function seatCount(memberships, dealershipId = '') {
  const people = new Set();
  for (const m of Array.isArray(memberships) ? memberships : []) {
    if (!m || typeof m !== 'object' || m.role !== SEAT_ROLE || typeof m.user_id !== 'string' || !m.user_id) continue;
    if (dealershipId && m.dealership_id && m.dealership_id !== dealershipId) continue;
    people.add(m.user_id);
  }
  return people.size;
}

// A count as the answer should carry it: a whole number, else null.
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// The seat count in a status answer, a manager's only: a salesperson's
// call is not counted (row-level security shows them their own row alone),
// so a number there would be wrong.
const salespeopleIn = (s) => (s.role === 'manager' ? count(s.salespeople) : null);

/**
 * The seats Subscribe asks Checkout for: one per salesperson now, never
 * fewer than the plan includes (the rooftop price covers those, and the
 * billing function bills only the seats above them). Null when the answer
 * has no count; Subscribe then sends none and the function keeps the
 * included count, or the seats the row already had.
 * @param {object} status   GET .../billing/status's answer
 * @param {object} options  pricing: { includedSalespeople } fallback, as billingCard takes it
 * @returns {number|null}
 */
export function subscribeSeats(status, { pricing } = {}) {
  const s = status && typeof status === 'object' ? status : {};
  const p = pricing && typeof pricing === 'object' ? pricing : {};
  const n = salespeopleIn(s);
  if (n === null) return null;
  const included = count(num(s.includedSalespeople) ?? num(p.includedSalespeople));
  const seats = Math.min(included === null ? n : Math.max(n, included), MAX_SEATS);
  return seats >= 1 ? seats : null;
}

// The most seats Checkout bills (MAX_SEATS in supabase/functions/_shared/
// billing.mjs, held equal by test/billing.test.js), so the card never
// promises more than the function will ask Stripe for.
export const MAX_SEATS = 200;

// A subscription Stripe still holds open (the billing function's
// hasOpenSubscription, held equal by test/billing.test.js): the function
// refuses a second Checkout next to it, and its seats are still the ones
// paid for, whatever the state says.
export const OPEN_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused']);
export function hasOpenSubscription(row) {
  return Boolean(row) && typeof row === 'object' && typeof row.stripe_subscription_id === 'string' && row.stripe_subscription_id !== '' && OPEN_STATUSES.includes(String(row.status));
}

/**
 * What Manage billing (route 'portal') and Subscribe (route 'checkout') POST
 * to the billing function: the page to come back to and the dealership, and
 * for Checkout the seats from subscribeSeats(), left out when there are none.
 * @param {string} route    'checkout' | 'portal'
 * @param {object} status   GET .../billing/status's answer
 * @param {object} options  returnUrl, dealershipId
 * @returns {{ returnUrl, dealershipId, seats? }}
 */
export function billingBody(route, status, { returnUrl = '', dealershipId = '' } = {}) {
  const body = { returnUrl, dealershipId };
  if (route !== 'checkout') return body;
  const seats = subscribeSeats(status);
  if (seats !== null) body.seats = seats;
  return body;
}

// Before billing opens (manager/config.js billing false: the billing
// function comes with Stripe, docs/stripe-setup.md step 5) the page does not
// call it. It reads the plan as row-level security lets a member, the row and
// subscription_state() (the word /sync serves by), and closedBillingStatus()
// shapes them like the function's answer with `open: false`. The free pilot
// needs no billing function (start_pilot() is the database's), so a manager
// of a dealership with no plan yet still gets Start the free pilot, on the
// function's own rule (pilotAvailable); Subscribe and Manage billing wait for
// billing. The card says paying by card is not open yet, a pilot the owner
// recorded by agreement shows with its end date, and a lapsed plan says whom
// to ask, since nothing on the page can renew it yet.
export const BILLING_CLOSED_NOTE = 'Paying by card is not open yet, so nothing is charged; to carry on after the free pilot, ask your Lot Current contact.';
export const BILLING_CLOSED_ASK = 'Billing is not open yet: ask your Lot Current contact.';
// While the billing function runs on a Stripe test-mode key (the status
// answer's testMode, docs/stripe-setup.md before the live switch), the card
// says so to everyone who reads it: Checkout takes only Stripe's test cards,
// and what test mode writes is reset when billing goes live.
export const BILLING_TEST_MODE_NOTE = 'Billing is in Stripe test mode: only Stripe\'s test cards work, nothing is charged, and a subscription started now does not carry over when real billing starts.';
// A pilot can start when there is no row, or only the shell of one (a Stripe
// customer from a checkout that never finished: no status, no pilot): the
// billing function's pilotAvailable(), word for word (test/billing.test.js
// holds the two equal), which start_pilot() applies in SQL too.
export function pilotAvailable(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  return (row.status === null || row.status === undefined) && (row.pilot_ends_at === null || row.pilot_ends_at === undefined);
}
export function closedBillingStatus(word, row, { role = '' } = {}) {
  const subscription = row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  return {
    state: PLAN_STATES.includes(word) ? word : 'unknown',
    open: false,
    role: typeof role === 'string' ? role : '',
    subscription,
    canStartPilot: role === 'manager' && pilotAvailable(subscription),
    canSubscribe: false,
    canManageBilling: false,
    pilotDays: null,
    includedSalespeople: null,
    salespeople: null,
  };
}

// Why a plan has lapsed, from the Stripe status on the row; a pilot that
// ran out is worded from its end date instead.
const LAPSED_WHY = Object.freeze({
  past_due: 'The last payment did not go through.',
  unpaid: 'The last payment did not go through.',
  incomplete: 'The first payment did not go through.',
  incomplete_expired: 'The first payment did not go through.',
  canceled: 'The subscription was cancelled.',
  paused: 'The subscription is paused.',
});

// What renews a lapsed plan that Stripe still holds open (hasOpenSubscription:
// a payment that did not go through, a first payment not finished, a pause).
// Subscribe is not it: the billing function refuses a second Checkout next to
// an open subscription and offers no Subscribe button. A failed renewal is
// fixed by the card in Manage billing; a pause or an unfinished first payment
// promises no retry. `card` follows the Billing card's why-line, `step` is the
// Getting started line; with no Manage billing to offer, both say whom to ask.
const LAPSED_OPEN = Object.freeze({
  past_due: Object.freeze({ card: 'Update the card with Manage billing; syncing starts again once Stripe takes the payment.', step: 'The last payment did not go through: update the card with Manage billing in the Billing card; syncing starts again once Stripe takes the payment.' }),
  unpaid: Object.freeze({ card: 'Update the card with Manage billing; syncing starts again once Stripe takes the payment.', step: 'The last payment did not go through: update the card with Manage billing in the Billing card; syncing starts again once Stripe takes the payment.' }),
  incomplete: Object.freeze({ card: 'Open Manage billing to check the card, or ask your Lot Current contact.', step: 'The first payment did not go through: open Manage billing in the Billing card, or ask your Lot Current contact.' }),
  paused: Object.freeze({ card: 'Ask your Lot Current contact, or open Manage billing.', step: 'The subscription is paused: ask your Lot Current contact, or open Manage billing in the Billing card.' }),
});
const LAPSED_ASK = Object.freeze({ card: 'Ask your Lot Current contact.', step: 'The plan has lapsed: ask your Lot Current contact.' });
// The renewal words for a lapsed status answer, or null when Subscribe is
// the way (the plan is not held open and the answer offers Subscribe).
function lapsedRenewal(s) {
  const sub = s.subscription && typeof s.subscription === 'object' ? s.subscription : {};
  if (hasOpenSubscription(sub)) return (s.canManageBilling && LAPSED_OPEN[sub.status]) || LAPSED_ASK;
  return s.canSubscribe ? null : LAPSED_ASK;
}

// The local calendar date alone (2026-12-05), for a plan line.
export function fmtLocalDate(iso, timeZone) {
  return fmtLocal(iso, timeZone).slice(0, 10);
}

/**
 * The Billing card from the status answer: the plan state in one sentence
 * a manager understands, a pill, a detail line, the seat line, and the
 * buttons the answer allows. Buttons are for managers only, whatever the
 * flags say; a salesperson gets the sentence and nothing to press. The
 * pilot length and the included seats are read from the answer (pilotDays,
 * includedSalespeople), else from `pricing` (marketing/pricing.json, which
 * the tests read); with neither the sentence leaves the numbers out.
 *
 * The seat line is a manager's: "N salespeople; the plan includes M." from
 * the answer's count. While subscribed the main line carries the seats paid
 * for (the row's seats), and when there are more salespeople than that,
 * seatNote says so and that Lot Current changes nothing on its own (seatTone
 * 'warn'). Otherwise, next to Subscribe, seatNote says how many seats
 * Subscribe asks for (subscribeSeats). No price: the answer carries none,
 * and Checkout shows it before the manager pays.
 * @param {object} status   GET .../billing/status's answer (or the sample's)
 * @param {object} options
 *   now:      ISO time the days left count from (default: the clock)
 *   timeZone: IANA zone for the dates (default: this computer's)
 *   pricing:  { pilotDays, includedSalespeople } fallback
 * modeNote is BILLING_TEST_MODE_NOTE while the answer says the billing
 * function runs on a Stripe test-mode key, else empty.
 * @returns {{ state, label, tone, line, detail, daysLeft, pilotDays, includedSalespeople, salespeople, seatsPaid, seatLine, seatNote, seatTone, subscribeSeats, modeNote, buttons: { action, label, does }[] }}
 */
export function billingCard(status, { now = nowIso(), timeZone, pricing } = {}) {
  const s = status && typeof status === 'object' ? status : {};
  const p = pricing && typeof pricing === 'object' ? pricing : {};
  const sub = s.subscription && typeof s.subscription === 'object' ? s.subscription : {};
  const t = ms(now) ?? Date.now();
  const zone = resolveTimeZone(timeZone);
  const date = (iso) => fmtLocalDate(iso, zone);
  const manager = s.role === 'manager';
  const state = PLAN_STATES.includes(s.state) ? s.state : 'unknown';
  const billingOpen = s.open !== false; // closedBillingStatus: billing not open yet
  const pilotDays = num(s.pilotDays) ?? num(p.pilotDays);
  const includedSalespeople = num(s.includedSalespeople) ?? num(p.includedSalespeople);
  const salespeople = salespeopleIn(s);

  // buttons only for a manager and a state this page knows: a word the page
  // cannot read is a page and a function that disagree, and nothing to press
  // (before billing opens only the pilot, which is the database's own call)
  const buttons = [];
  if (manager && state !== 'unknown') {
    if (s.canStartPilot) buttons.push({ ...BILLING_BUTTONS.pilot });
    if (billingOpen && s.canSubscribe) buttons.push({ ...BILLING_BUTTONS.subscribe });
    if (billingOpen && s.canManageBilling) buttons.push({ ...BILLING_BUTTONS.portal });
  }

  let label = 'Unknown';
  let tone = 'warn';
  let line = 'The plan could not be read.';
  let detail = '';
  let daysLeft = null;

  if (state === 'none') {
    label = 'No plan yet';
    tone = '';
    const terms = [
      pilotDays !== null ? plural(pilotDays, 'day') : '',
      includedSalespeople !== null ? `${plural(includedSalespeople, 'salesperson', 'salespeople')} included` : '',
      'no card',
    ].filter(Boolean).join(', ');
    line = `No plan yet. ${manager ? 'Start' : 'A manager can start'} the free pilot: ${terms}.`;
    if (manager && !billingOpen) detail = BILLING_CLOSED_NOTE;
  } else if (state === 'pilot') {
    label = 'Free pilot';
    const end = ms(sub.pilot_ends_at);
    daysLeft = end === null ? null : Math.max(0, Math.ceil((end - t) / DAY_MS));
    tone = daysLeft !== null && daysLeft <= PILOT_WARN_DAYS ? 'warn' : 'good';
    line = daysLeft === null ? 'Free pilot running.' : `Free pilot: ${plural(daysLeft, 'day')} left (ends ${date(sub.pilot_ends_at)}).`;
    // Checkout during a pilot with more than two days left starts the subscription as a trial to the pilot's end (the billing function)
    if (manager && !billingOpen) detail = BILLING_CLOSED_NOTE;
    else if (manager && s.canSubscribe) detail = 'Subscribe any time: with more than two days of pilot left, the card is first charged when the pilot ends.';
  } else if (state === 'active') {
    label = 'Subscribed';
    tone = 'good';
    const seats = seatsPaid(sub);
    const who = seats !== null ? `: ${plural(seats, 'seat')}` : '';
    const verb = sub.status === 'trialing' ? 'first charge' : 'renews';
    // cancelled in the portal: the date Stripe ends it (0009_cancel_at.sql), null while it renews
    const ends = ms(sub.cancel_at) !== null ? sub.cancel_at : null;
    const periodEnd = ms(sub.current_period_end);
    if (ends === null) {
      const when = sub.current_period_end ? `, ${verb} ${date(sub.current_period_end)}` : '';
      line = `Subscribed${who}${when}.`;
    } else if (periodEnd !== null && ms(ends) > periodEnd) {
      // cancelled from a date after this period: the period still renews (or the trial still ends in a charge) first
      label = 'Cancelled';
      tone = 'warn';
      line = `Subscribed${who}, ${verb} ${date(sub.current_period_end)}; cancelled from ${date(ends)}.`;
    } else {
      // cancelled in the portal: Stripe keeps the status until the end, and nothing renews or charges after it
      label = 'Cancelled';
      tone = 'warn';
      // the end can be past while Stripe's last event is still on its way (the row then still says active): it ended, and nothing runs until then
      const over = ms(ends) <= t;
      const until = `${over ? 'ended' : 'ends'} ${date(ends)}`;
      line = sub.status === 'trialing'
        ? `Cancelled${who}, ${until} before the first charge.`
        : `Cancelled${who}, ${until}${over ? '' : ' and does not renew'}.`;
      if (manager && s.canManageBilling && !over) detail = 'Everything works as it does now until then; Manage billing can renew it.';
    }
  } else if (state === 'lapsed') {
    label = 'Lapsed';
    tone = 'bad';
    line = 'The subscription has lapsed; salespeople can still post, but nothing syncs and the description writer is off until it is renewed.';
    const pilotEnd = ms(sub.pilot_ends_at);
    detail = LAPSED_WHY[sub.status] || (pilotEnd !== null && pilotEnd <= t ? `The free pilot ended ${date(sub.pilot_ends_at)}.` : '');
    if (!billingOpen) detail = [detail, BILLING_CLOSED_ASK].filter(Boolean).join(' '); // nothing here can renew it yet
    else if (manager && hasOpenSubscription(sub)) detail = [detail, lapsedRenewal(s).card].filter(Boolean).join(' '); // held open: Manage billing, never Subscribe
  }

  const open = hasOpenSubscription(sub);
  const seatInfo = seatLines({ state, salespeople, includedSalespeople, paid: state === 'active' || open ? seatsPaid(sub) : null, subscribing: !open && buttons.some((b) => b.action === 'subscribe'), toBuy: subscribeSeats(s, { pricing: p }) });
  const modeNote = billingOpen && s.testMode === true ? BILLING_TEST_MODE_NOTE : '';
  return { state, label, tone, line, detail, daysLeft, pilotDays, includedSalespeople, ...seatInfo, modeNote, buttons };
}

// What the card says when there are more salespeople than paid seats, in
// one place so docs/help.md can quote it word for word.
export const SEATS_NOT_ADDED = 'Lot Current never adds seats or changes what you pay on its own: to add seats, ask your Lot Current contact.';

// The seats the row says are paid for (the included count plus the seat
// price's quantity, copied from Stripe by the webhook), or null.
const seatsPaid = (sub) => {
  const n = count(num(sub.seats));
  return n !== null && n >= 1 ? n : null;
};

// The seat line and its note, for a manager whose answer carries the count
// and a state the page knows; empty otherwise.
function seatLines({ state, salespeople: n, includedSalespeople: m, paid, subscribing, toBuy }) {
  const none = { salespeople: n, seatsPaid: paid, seatLine: '', seatNote: '', seatTone: '', subscribeSeats: subscribing ? toBuy : null };
  if (n === null || state === 'unknown') return none;
  const included = count(m);
  const seatLine = `${plural(n, 'salesperson', 'salespeople')}${included !== null ? `; the plan includes ${included}` : ''}.`;
  if (paid !== null && n > paid) {
    // Adding a seat changes what the dealership pays, so a person asks for it; nothing here or in the billing function changes a subscription
    return { ...none, seatLine, seatTone: 'warn', seatNote: `${plural(n, 'salesperson', 'salespeople')} and ${plural(paid, 'seat')} paid for. ${SEATS_NOT_ADDED}` };
  }
  let seatNote = '';
  if (subscribing && toBuy !== null && included !== null) {
    seatNote = toBuy > included
      ? `Subscribe asks for ${plural(toBuy, 'seat')}, ${toBuy - included} more than the plan includes; Checkout shows the price before you pay.`
      : `Subscribe asks for the ${plural(toBuy, 'seat')} the plan includes.`;
  }
  return { ...none, seatLine, seatNote };
}

// The one line the page shows when Stripe sends the manager back with
// ?billing=success or ?billing=canceled; '' for anything else.
export function billingReturnNote(flag) {
  if (flag === 'success') return 'Checkout is done. The plan below updates when Stripe confirms the subscription, usually within a minute; reload the page if it still shows the old state.';
  if (flag === 'canceled') return 'Checkout was closed before paying. Nothing was charged.';
  return '';
}

// ---------- invite codes ----------

// The roles create_invite() accepts, and the two buttons with what each does
// in words: the page shows `does` as a note in sample-data mode instead of
// calling anything.
export const INVITE_ROLES = Object.freeze(['salesperson', 'manager']);
export const INVITE_BUTTONS = Object.freeze({
  salesperson: Object.freeze({ action: 'invite', role: 'salesperson', label: 'Invite a salesperson', does: 'asks the account server for a fresh single-use code that puts one salesperson into this dealership' }),
  manager: Object.freeze({ action: 'invite', role: 'manager', label: 'Invite a manager', does: 'asks the account server for a fresh single-use code that makes one person a manager of this dealership' }),
});
export const INVITE_DAYS = 7; // invites.expires_at's default in 0001_schema.sql
export const INVITE_LINE = `A code puts one person into this dealership, as a salesperson or as a manager. It works once and for ${INVITE_DAYS} days.`;
export const INVITE_HINT = 'These are the dealership\'s open codes: not used yet and not expired. Revoke one that went to the wrong person. A code stops working when the manager who made it leaves the dealership or stops being a manager. A code belongs to one person.';

// The signed-in person's role in the dealership, from the memberships rows
// the page read (a manager sees every row, a salesperson only their own).
export function memberRole(memberships, userId) {
  if (!userId) return '';
  const m = rows(memberships).find((r) => r.user_id === userId);
  return m && INVITE_ROLES.includes(m.role) ? m.role : '';
}

// One sentence on what the invited person does with the code, in the words
// the extension's Settings uses (Account, Invite code, Join).
export function inviteSentence(role) {
  return role === 'manager'
    ? 'The new manager enters it in the Lot Current extension under Settings, Account, Invite code, and clicks Join; the manager view then lets them in. It works once.'
    : 'The salesperson enters it in the Lot Current extension under Settings, Account, Invite code, and clicks Join. It works once.';
}

/**
 * The Invite codes card: the two buttons a manager may press and the
 * dealership's open codes, newest first, each as create_invite() typed it
 * (upper case), with when it expires and a Revoke. A salesperson gets no
 * buttons and no codes, so the page draws nothing. `invites` is what
 * list_invites() answered plus the codes made on this page since, { code,
 * role, dealership_id?, created_at, expires_at? }; a code without
 * expires_at expires INVITE_DAYS after created_at, and an expired one is
 * left out even when the server sent it. The sample data carries two.
 * @param {object[]} invites
 * @param {object} options
 *   role:         the signed-in person's role in the dealership
 *   dealershipId: when given, only that dealership's codes are listed
 *   now:          ISO time; a code without created_at is dated now
 *   timeZone:     IANA zone for the times (default: this computer's)
 * @returns {{ manager, buttons, codes: { code, role, createdAt, expiresAt, when, expires, line, sentence, copyText, revoke }[], line, hint }}
 */
export function inviteCard(invites, { role, dealershipId, now = nowIso(), timeZone } = {}) {
  const manager = role === 'manager';
  const zone = resolveTimeZone(timeZone);
  const nowAt = new Date(ms(now) ?? Date.now()).toISOString();
  const seen = new Set();
  const codes = !manager ? [] : rows(invites)
    .filter((i) => text(i.code, 64) && (!dealershipId || !i.dealership_id || i.dealership_id === dealershipId))
    .map((i) => {
      const code = text(i.code, 64).toUpperCase();
      const r = INVITE_ROLES.includes(i.role) ? i.role : 'salesperson';
      const createdAt = ms(i.created_at) === null ? nowAt : new Date(ms(i.created_at)).toISOString();
      const expiresAt = new Date(ms(i.expires_at) ?? ms(createdAt) + INVITE_DAYS * DAY_MS).toISOString();
      const when = fmtLocal(createdAt, zone);
      const expires = fmtLocalDate(expiresAt, zone);
      return { code, role: r, createdAt, expiresAt, when, expires, line: `${when} · for a ${r} · expires ${expires}`, sentence: inviteSentence(r), copyText: code, revoke: true };
    })
    .filter((c) => ms(c.expiresAt) > ms(nowAt) && !seen.has(c.code) && seen.add(c.code))
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  return {
    manager,
    buttons: manager ? [{ ...INVITE_BUTTONS.salesperson }, { ...INVITE_BUTTONS.manager }] : [],
    codes,
    line: INVITE_LINE,
    hint: INVITE_HINT,
  };
}

// ---------- the Team card ----------

export const TEAM_LINE = 'Everyone in this dealership\'s Lot Current account. A manager can invite, bill and change the team; a salesperson posts.';
export const TEAM_HINT = 'Removing someone stops their extension from syncing and cancels the invite codes they made; the cars they posted stay in the numbers. Making a manager a salesperson cancels the unused codes they made, too. A dealership always keeps at least one manager.';
export const TEAM_UNCHANGED = 'Nothing changed: the team was changed elsewhere.';

// The Team card's line after Make manager, Make salesperson or Remove, from
// the rows the database answered (the page asks for the changed row back).
// Row-level security answers a row this person may no longer touch (removed
// from another page, or they are no longer a manager) with no row and no
// error, so an empty answer claims nothing.
export function teamChangeNote(kind, who, to, changedRows) {
  if (!Array.isArray(changedRows) || !changedRows.length) return TEAM_UNCHANGED;
  const name = text(who, 80) || 'This person';
  return kind === 'remove' ? `${name} is no longer in the dealership.` : `${name} is now a ${to}.`;
}

/**
 * The Team card: every member of the dealership with their role, and what a
 * manager may do to each (the database enforces the same: managers change a
 * member's name and role or remove them, and the last manager can neither
 * step down nor leave, 0002_rls.sql keep_a_manager). A salesperson reads
 * only their own membership row, so the card is a manager's only.
 * @param {object[]} memberships  { user_id, dealership_id, role, name }
 * @param {object} options  role (the viewer's), userId (the viewer's), dealershipId, confirm (the user id whose Remove was clicked once)
 * @returns {{ manager, managers, members: { userId, name, role, you, roleAction, remove, note }[], line, hint }}
 */
export function teamCard(memberships, { role, userId = '', dealershipId = '', confirm = '' } = {}) {
  const manager = role === 'manager';
  const all = !manager ? [] : rows(memberships)
    .filter((m) => m && m.user_id && INVITE_ROLES.includes(m.role) && (!dealershipId || !m.dealership_id || m.dealership_id === dealershipId));
  const managers = all.filter((m) => m.role === 'manager').length;
  const members = all
    .map((m) => {
      const you = Boolean(userId) && m.user_id === userId;
      const name = text(m.name, 80) || 'No name yet';
      const last = m.role === 'manager' && managers <= 1;
      const roleAction = last ? null : m.role === 'manager'
        ? { to: 'salesperson', label: you ? 'Step down to salesperson' : 'Make salesperson' }
        : { to: 'manager', label: 'Make manager' };
      const armed = confirm === m.user_id;
      const remove = last ? null : { label: armed ? (you ? 'Click again to leave' : 'Click again to remove') : (you ? 'Leave the dealership' : 'Remove'), armed };
      return { userId: m.user_id, name, role: m.role, you, roleAction, remove, note: last ? 'The only manager: make someone else a manager first.' : '' };
    })
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'manager' ? -1 : 1));
  return { manager, managers, members, line: TEAM_LINE, hint: TEAM_HINT };
}

// ---------- self-serve sign-up ----------

// The origin Lot Current keeps for a typed website address: the key the
// extension syncs under (dealerships.website_origin), so it has to be what
// the browser shows on the dealership's inventory pages. The rule has two
// copies, create_dealership's SQL (supabase/migrations/0007_signup.sql) and
// this one, and test/fixtures/website-origins.json checks both. It is spelled
// out by hand rather than left to new URL(), which accepts IP addresses and
// turns a non-ASCII host into its xn-- form: the person would then read one
// address here while the extension sees another. '' when refused.
const DEFAULT_PORTS = Object.freeze({ http: 80, https: 443 });
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/; // 1 to 63 characters, no hyphen at either end
export function websiteOrigin(input) {
  let s = String(input ?? '').trim();
  let scheme = 'https'; // no scheme typed means https
  const typed = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (typed) {
    scheme = typed[1].toLowerCase();
    s = s.slice(typed[0].length);
  }
  if (!Object.hasOwn(DEFAULT_PORTS, scheme)) return '';
  const authority = s.split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return ''; // a user name or password in the address is refused
  const [hostPart, port = '', ...more] = authority.split(':');
  if (more.length) return ''; // more than one colon: an IPv6 address, or worse
  // the scheme's own port is dropped (an empty one is no port, as in a browser), any other refused
  if (port !== '' && !(/^0*\d{1,5}$/.test(port) && Number(port) === DEFAULT_PORTS[scheme])) return '';
  const host = hostPart.replace(/\.$/, '');
  // the characters are checked before the case is folded, so no character whose lower case happens to be ASCII gets through
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return '';
  const labels = host.toLowerCase().split('.');
  if (labels.length < 2 || labels[labels.length - 1] === 'localhost' || !labels.every((l) => HOST_LABEL.test(l))) return '';
  // an IP address: a browser reads a host whose last part is a number (or 0x...) as one
  if (/^(\d+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return '';
  return `${scheme}://${labels.join('.')}`;
}

// The form's words, in one place so the help doc and its test can name them.
export const SIGNUP_WORDS = Object.freeze({
  heading: 'Start your dealership',
  lead: 'Your account is not in a dealership yet. Start one here and you become its manager.',
  name: 'Dealership name',
  website: 'Website address',
  yourName: 'Your name',
  submit: 'Start the dealership',
  already: 'Does your store already use Lot Current? Then don\'t start another one: ask its manager for an invite code and enter it in the Lot Current extension under Settings, Account, Invite code.',
});
export const SIGNUP_EXAMPLE = 'www.yourdealership.com';

// The line under the address box, redrawn as the person types: the origin
// Lot Current will keep and why it matters, or why the address cannot be used.
export function signupOriginNote(input) {
  const origin = websiteOrigin(input);
  if (origin) return { usable: true, origin, keep: `Lot Current will keep ${origin}.`, line: 'It must match the address bar on the dealership\'s inventory pages, www included.' };
  if (!String(input ?? '').trim()) return { usable: false, origin: '', keep: '', line: 'Copy it from the address bar on the dealership\'s inventory pages, www included.' };
  return { usable: false, origin: '', keep: '', line: `That is not a website address Lot Current can use: type it as the address bar shows it, for example ${SIGNUP_EXAMPLE}.` };
}

// What stops the form before it calls anything: the first box that is empty
// or unusable, and one sentence for it; null when all three are filled in.
// create_dealership checks the same again, and its word is the one that counts.
export function signupProblem({ name = '', website = '', yourName = '' } = {}) {
  if (!String(name ?? '').trim()) return { field: 'name', message: 'Type the dealership\'s name.' };
  if (!String(website ?? '').trim()) return { field: 'website', message: 'Type the dealership\'s website address.' };
  const note = signupOriginNote(website);
  if (!note.usable) return { field: 'website', message: note.line };
  if (!String(yourName ?? '').trim()) return { field: 'your_name', message: 'Type your name.' };
  return null;
}

// The form's line when create_dealership refuses: the database's own
// sentence (error.message is written for the person: sign in first, sign-up
// is not open, too many attempts, a field is wrong, this account already
// started one, no more today, the website already has a dealership), after
// the same "Couldn't ..." the other cards use.
export function signupRefusal(error) {
  const e = error && typeof error === 'object' ? error : {};
  const said = text(e.message, 300) || (typeof error === 'string' ? text(error, 300) : '') || 'no answer from the server';
  return `Couldn't start the dealership: ${said}${/[.!?]$/.test(said) ? '' : '.'}`;
}

// ---------- getting started ----------

// The Getting started card (managers only): four steps from a new
// dealership to plan milestone M6's "at least two active salespeople", each
// done or not from rows the page already reads. The first two are done on
// this page, so each carries the id of the card that does it; the other two
// happen in the salespeople's extensions.
export const GETTING_STARTED = Object.freeze({
  plan: Object.freeze({ title: 'Start the free pilot or subscribe', target: 'billing', button: 'Go to Billing' }),
  invite: Object.freeze({ title: 'Invite your salespeople', target: 'invites', button: 'Go to Invite codes' }),
  firstCar: Object.freeze({ title: 'First car posted and synced', target: '', button: '' }),
  twoPosting: Object.freeze({ title: 'Two salespeople posting', target: '', button: '' }),
});
export const ACTIVE_SALESPEOPLE = 2; // PLAN.md M6: "at least two active salespeople"

const PLAN_STEP_LINES = Object.freeze({
  pilot: 'The free pilot is running.',
  active: 'The dealership is subscribed.',
  none: 'No plan yet: start the free pilot, or subscribe, in the Billing card.',
  lapsed: 'The plan has lapsed: subscribe in the Billing card and syncing starts again.',
  unknown: 'The plan could not be read just now; the Billing card says more.',
});
// Before billing opens the first step is the free pilot alone (start_pilot()
// needs no billing function), and a lapsed plan is renewed by asking.
export const PLAN_STEP_CLOSED_TITLE = 'Start the free pilot';
const PLAN_STEP_CLOSED_LINES = Object.freeze({
  none: 'No plan yet: start the free pilot in the Billing card.',
  lapsed: 'The plan has lapsed, and billing is not open yet: ask your Lot Current contact.',
});

/**
 * The Getting started card's four steps.
 *   1. a plan: the billing state is pilot or active;
 *   2. someone invited: an open invite code, or more than one member;
 *   3. a car posted and synced: any listing;
 *   4. two salespeople posting: at least two different people who hold the
 *      salesperson role in the dealership now, with a listing posted in the
 *      past 7 days (a manager, or someone who has left, does not count).
 * @param {object} input
 *   billing:      GET .../billing/status's answer (or the sample's); null when it could not be read
 *   invites:      the open codes the page holds (list_invites plus the ones made since)
 *   memberships:  the dealership's members (a manager reads every row)
 *   listings:     the dealership's listings
 *   dealershipId: the chosen dealership; rows of another one are left out
 *   now:          ISO time "the past 7 days" counts back from (default: the clock)
 *   billingOpen:  false before billing opens (manager/config.js billing):
 *                 step 1 is the free pilot alone, and a lapsed plan says
 *                 whom to ask
 * @returns {{ steps: { key, title, done, line, action: { target, label } | null }[], done, total, allDone, line }}
 */
export function gettingStarted({ billing, invites, memberships, listings, dealershipId = '', now = nowIso(), billingOpen = true } = {}) {
  const t = ms(now) ?? Date.now();
  const nowAt = new Date(t).toISOString();
  const ours = (r) => !dealershipId || !r.dealership_id || r.dealership_id === dealershipId;
  const M = rows(memberships).filter((m) => m.user_id && INVITE_ROLES.includes(m.role) && ours(m));
  const L = rows(listings).filter(ours);
  const step = (key, done, line) => {
    const s = GETTING_STARTED[key];
    return { key, title: s.title, done, line, action: !done && s.target ? { target: s.target, label: s.button } : null };
  };

  const plan = billing && typeof billing === 'object' && PLAN_STATES.includes(billing.state) ? billing.state : 'unknown';

  const open = inviteCard(invites, { role: 'manager', dealershipId, now: nowAt }).codes.length;
  const inviteLine = M.length > 1 ? `${M.length} people are in the dealership.`
    : open === 1 ? 'An invite code is open, waiting to be used.'
    : open > 1 ? `${open} invite codes are open, waiting to be used.`
    : 'Nobody else is in the dealership yet: make an invite code for each salesperson in the Invite codes card.';

  // who posted in the past 7 days, by account, else by the name the extension recorded. An account counts only
  // while it holds the salesperson role here, as usage_report's active_salespeople (0008_usage.sql): a manager's
  // own posts do not count, nor do those of someone no longer in the dealership (their cars stay on the page)
  const salespeople = new Set(M.filter((m) => m.role === 'salesperson').map((m) => m.user_id));
  const posting = new Set();
  for (const l of L) {
    const at = ms(l.posted_at);
    if (at === null || at < t - WEEK_MS || at > t) continue;
    if (l.user_id && !salespeople.has(l.user_id)) continue;
    posting.add(l.user_id ? `id:${l.user_id}` : `name:${text(l.salesperson, 60).toLowerCase() || NO_NAME}`);
  }
  const n = posting.size;
  const postingLine = n >= ACTIVE_SALESPEOPLE ? `${n} salespeople posted in the past 7 days.`
    : n === 1 ? `One salesperson posted in the past 7 days; this step needs ${ACTIVE_SALESPEOPLE}.`
    : 'No salesperson has posted in the past 7 days.';

  const closed = billingOpen === false;
  // a lapsed plan says "subscribe" only when the Billing card offers Subscribe; one Stripe holds open is renewed in Manage billing
  const renewal = !closed && plan === 'lapsed' ? lapsedRenewal(billing) : null;
  const planStep = step('plan', plan === 'pilot' || plan === 'active', (closed && PLAN_STEP_CLOSED_LINES[plan]) || renewal?.step || PLAN_STEP_LINES[plan]);
  if (closed) planStep.title = PLAN_STEP_CLOSED_TITLE;

  const steps = [
    planStep,
    step('invite', M.length > 1 || open > 0, inviteLine),
    step('firstCar', L.length > 0, L.length ? `${plural(L.length, 'car')} posted and synced so far.` : 'No car yet. Each car a signed-in salesperson posts shows here after their extension syncs.'),
    step('twoPosting', n >= ACTIVE_SALESPEOPLE, postingLine),
  ];
  const done = steps.filter((s) => s.done).length;
  const allDone = done === steps.length;
  return { steps, done, total: steps.length, allDone, line: allDone ? 'All four steps done' : `${done} of ${steps.length} done` };
}

// ---------- the spreadsheet ----------

const csvCell = (v) => {
  if (typeof v === 'number') return String(v);
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // a spreadsheet would otherwise run a typed name as a formula
  return /[",\n\r']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
  out.push(csvRow(['Lot Current manager numbers', dealer, `exported ${local(s.now)}`]));
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
  return `lot-current-manager-${slug(dealer)}-${fmtLocal(now, timeZone).slice(0, 10)}.csv`;
}

// ---------- sample data ----------

// A small made-up dealership for the demo and the tests: two salespeople,
// eight listings, three open to-do items, a week of post attempts, four
// scans, a free pilot with 19 days left, seen as its manager, and one
// unused invite code. Every time is relative to `now`. No real dealer,
// person or town.
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

  // What GET .../billing/status would answer: a running pilot, seen by a
  // manager (so "Subscribe" shows). The real answer also carries the pilot
  // length and the included seats from marketing/pricing.json; the sample
  // leaves them null rather than type a price into the page. Ending at 18.5
  // days keeps "19 days left" true for hours after the sample was built.
  const billing = {
    ok: true,
    dealership: { id: D, name: dealership.name, websiteOrigin: origin },
    role: 'manager',
    state: 'pilot',
    subscription: { dealership_id: D, stripe_customer_id: null, stripe_subscription_id: null, status: 'pilot', pilot_ends_at: ago(-18.5 * 24), current_period_end: null, updated_at: ago(24 * 11) },
    canStartPilot: false,
    canSubscribe: true,
    canManageBilling: false,
    pilotDays: null,
    includedSalespeople: null,
    salespeople: seatCount(memberships, D), // counted from the sample's members, as the function counts a real dealership's
  };

  // One unused code the manager made a quarter of an hour ago, in the shape
  // create_invite() answers (12 upper-case hex characters) plus the stamp
  // the page adds. Made up: redeeming it finds nothing.
  const invites = [
    { code: 'ABCDEF012345', dealership_id: D, role: 'salesperson', created_at: ago(0.25), expires_at: ago(0.25 - 7 * 24) },
    { code: '0123456789AB', dealership_id: D, role: 'manager', created_at: ago(26), expires_at: ago(26 - 7 * 24) },
  ];

  return { dealership, memberships, listings, todoItems, postAttempts, scans, billing, invites };
}

// ?mock=signup: the page's stand-in for create_dealership, answered the way
// supabase-js answers an rpc ({ data, error }). It refuses what the form's
// own checks refuse, as the database would (22023), and otherwise answers a
// made-up dealership id with the name, the origin websiteOrigin() keeps and
// the end of the free pilot, which create_dealership() starts with the
// dealership. SAMPLE_PILOT_DAYS is marketing/pricing.json's pilotDays (the
// length start_pilot() gives), held equal by test/manager.test.js.
export const SAMPLE_NEW_DEALERSHIP_ID = '00000000-0000-4000-8000-000000000002';
export const SAMPLE_PILOT_DAYS = 30;
export function mockCreateDealership(args = {}, { now = nowIso() } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const problem = signupProblem({ name: a.name, website: a.website, yourName: a.your_name });
  if (problem) return { data: null, error: { code: '22023', message: problem.message } };
  const pilotEndsAt = new Date((ms(now) ?? Date.now()) + SAMPLE_PILOT_DAYS * DAY_MS).toISOString();
  return { data: { dealership_id: SAMPLE_NEW_DEALERSHIP_ID, name: text(a.name), website_origin: websiteOrigin(a.website), pilot_ends_at: pilotEndsAt }, error: null };
}

// The new, empty sample dealership that answer lands in: the person as its
// only member and manager, its free pilot running from now, nothing posted
// or scanned and no invite code, so Getting started shows its first step
// done and the other three to do. Made up, like mockData(); no network.
export function mockNewDealership(answer, { yourName = '', now = nowIso() } = {}) {
  const a = answer && typeof answer === 'object' ? answer : {};
  const id = text(a.dealership_id) || SAMPLE_NEW_DEALERSHIP_ID;
  const createdAt = new Date(ms(now) ?? Date.now()).toISOString();
  const dealership = { id, name: text(a.name) || 'Your dealership', website_origin: text(a.website_origin, 300), created_at: createdAt };
  const YOU = '00000000-0000-4000-8000-000000000104';
  const memberships = [{ user_id: YOU, dealership_id: id, role: 'manager', name: text(yourName, 60) }];
  const pilotEndsAt = text(a.pilot_ends_at) || new Date(Date.parse(createdAt) + SAMPLE_PILOT_DAYS * DAY_MS).toISOString();
  const billing = {
    ok: true,
    dealership: { id, name: dealership.name, websiteOrigin: dealership.website_origin },
    role: 'manager',
    state: 'pilot',
    subscription: { dealership_id: id, stripe_customer_id: null, stripe_subscription_id: null, status: 'pilot', pilot_ends_at: pilotEndsAt, current_period_end: null, updated_at: createdAt },
    canStartPilot: false,
    canSubscribe: true,
    canManageBilling: false,
    pilotDays: null, // as in mockData(): the real answer carries these from marketing/pricing.json
    includedSalespeople: null,
    salespeople: seatCount(memberships, id), // nobody has joined yet: the person who started it is its manager
  };
  return {
    dealership,
    memberships,
    listings: [],
    todoItems: [],
    postAttempts: [],
    scans: [],
    billing,
    invites: [],
  };
}
