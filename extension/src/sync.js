// Sync (Milestone 4): the pure half of keeping the posted registry and the
// pilot numbers the same on every machine of a dealership. Nothing here
// touches the network or chrome.storage. The caller (the popup, the side
// panel or the worker, wired in with the Settings UI) does:
//
//   const body = syncPayload({ origin, posted, pilot, scan, since, known: state.known, userId });
//   POST <project>/functions/v1/sync with authHeaders(session) (account.js)
//   posted = mergeRegistry(posted, response, { since, userId, sent: body.posted });
//   pilot  = mergeFlags(pilot, response, { posted, userId }); // posted: the merged registry
//   state  = nextSyncState(state, response, { today: body.today, sent: body.posted, userId })
//            // since, known, dealership id and role, the plan, the server's count of today's posts
//
// The state is per website; the wiring keeps it under a `sync` entry added
// to SITE_KEY_NAMES in src/storageKeys.js, so clearing a website removes it.
//
// A colleague's entry that the merge writes into posted:<origin> carries
// their userId and `mine: false`; the person's own entries carry no flag, so
// a machine that never synced is unchanged. cap.js and rescan.js read the
// flag: a colleague's car never counts toward this salesperson's daily cap
// and is never flagged as theirs to take down or update. The other way
// round, a colleague's row never takes over an entry this person owns: their
// own entry stays theirs, goes up again whole, and the sync function keeps
// their row listed (it refuses a colleague's post of a VIN they have up).
//
// Take-downs are told by keys, never by time. `known` in the state is the
// list of this person's own posts (VIN@postedAt) the machine sent or received
// at its last sync; the next request carries it, and the function takes down
// only the person's listed rows that are in it and missing from `posted`.
// A post that reached the server from another machine during or after that
// sync was never received here, so it is not in `known` and stays up; the
// machine receives it on this sync and knows it from then on. Two clocks
// (the function's and the database's) and two transactions never decide it.
//
// What travels: the salesperson's own entries of posted:<origin> (VIN, name,
// price, times, the listing link they saved, their name), the post attempts
// and to-do flags from pilot.js, and one scan summary (counts only). Never a
// description, a photo, a buyer or anything from the Facebook account. The
// fill records (which form fields could not be filled) stay in the browser.
//
// The rows are built here (toServerRows) exactly as the sync function
// writes them, so the mapping is unit-tested in Node; the function's own copy
// of it (supabase/functions/sync/index.ts) must stay the same.

import { withPilotDefaults, hoursBetween, clearNumbers, FLAG_KINDS, FLAG_HOWS } from './pilot.js';

export const SYNC_VERSION = 1;

// A taken-down listing older than this is not sent back to a machine that
// has never synced (it cannot have the entry anyway).
export const TAKEN_DOWN_WINDOW_DAYS = 90;

// At most this many keys in `known`: the sync function's cap on the rows of
// one request (MAX_ROWS), which a registry that syncs at all stays under. A
// key left out only means its take-down is missed and can be repeated.
export const MAX_KNOWN = 2000;

// How far before `since` the pilot entries that go up are picked from. `since`
// is the server's clock and the entries carry this machine's, so a machine
// a few minutes slow stamps a post made just after a sync before `since`;
// without the look-back that post attempt, or a to-do item ticked off then,
// would never go up. The sync function looks back as far for the same reason
// (CUTOFF_MARGIN_MS); an entry sent twice changes nothing there (attempts
// are upserted, a closed item is never reopened).
export const PILOT_LOOKBACK_MS = 10 * 60 * 1000;

const ms = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const t = typeof x === 'number' ? x : Date.parse(x);
  return Number.isNaN(t) ? null : t;
};
const isoOrNull = (x) => {
  const t = ms(x);
  return t === null ? null : new Date(t).toISOString();
};
const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const text = (s, max) => String(s ?? '').trim().slice(0, max);
const vinOf = (v) => text(v, 17).toUpperCase();
const intOrNull = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
  return null;
};
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u.trim()) ? u.trim().slice(0, 500) : null);
const sameMoment = (a, b) => {
  const x = ms(a);
  const y = ms(b);
  return x !== null && y !== null && Math.abs(x - y) < 1000;
};
const latest = (...stamps) => stamps.map(ms).filter((t) => t !== null).reduce((a, b) => (b > a ? b : a), null);
const changedAfter = (since, ...stamps) => {
  const s = ms(since);
  if (s === null) return true;
  const l = latest(...stamps);
  return l === null || l > s;
};
// A to-do flag that changed after `from` (a time in ms, or null for all):
// the ones a sync picks to send.
const flagChangedAfter = (from) => (f) => changedAfter(from, f.flaggedAt, f.doneAt);

// An entry merged in from a colleague carries their userId and `mine: false`; it is theirs to sync.
const isOwn = (entry, userId) => entry.mine !== false && (!entry.userId || !userId || entry.userId === userId);
// A server row of somebody else than the caller (with both known).
const isTheirs = (r, userId) => Boolean(r.user_id && userId && String(r.user_id) !== String(userId));

// One post's key, the way the sync function matches a row: the VIN and the
// posting time, to the millisecond. '' when either is missing.
export function postKey(vin, postedAt) {
  const v = vinOf(vin);
  const at = isoOrNull(postedAt);
  return v && at ? `${v}@${at}` : '';
}

// The keys of the entries a request's `posted` carried ({ [vin]: { postedAt } }).
const sentKeys = (sent) => new Set(Object.entries(isObject(sent) ? sent : {}).map(([key, e]) => (isObject(e) ? postKey(e.vin || key, e.postedAt) : '')).filter(Boolean));

// A list of keys as it goes up and is kept: each one well formed, once, at most MAX_KNOWN.
function keyList(keys) {
  const out = new Set();
  for (const k of Array.isArray(keys) ? keys : []) {
    if (out.size >= MAX_KNOWN) break;
    const at = typeof k === 'string' ? k.lastIndexOf('@') : -1;
    const key = at > 0 ? postKey(k.slice(0, at), k.slice(at + 1)) : '';
    if (key) out.add(key);
  }
  return [...out];
}

// ---------- the day the cap counts ----------

// The machine's local calendar day holding `now`, as two ISO stamps, [from,
// to): the same day cap.js counts (the machine's own year, month and date),
// so the sync function's postsToday and the local count speak of one day.
// A clock-change day is 23 or 25 hours; the function accepts up to 48.
export function localDayRange(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(d.getTime())) return null;
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

// ---------- what goes up ----------

/**
 * The rows the sync function writes, from the local registry and pilot lists.
 * @param {object} args
 *   origin:       the dealer website's origin (posted:<origin>)
 *   posted:       the registry { [vin]: { name, price, postedAt, listingUrl?, salesperson?, updatedAt?, userId? } }
 *   pilot:        { posts, flags } from pilot.js (fills are never sent)
 *   dealershipId: the dealership's id (the function fills it in from the membership; here for the tests)
 *   userId:       the signed-in user's id; entries of other users are left out
 * @returns {{ listings: object[], postAttempts: object[], todoItems: object[] }}
 */
export function toServerRows({ origin = '', posted = {}, pilot = null, dealershipId = null, userId = null } = {}) {
  void origin; // the origin picks the dealership on the server; the rows themselves carry its id
  const listings = [];
  for (const [key, e] of Object.entries(isObject(posted) ? posted : {})) {
    if (!isObject(e) || !isOwn(e, userId)) continue;
    const vin = vinOf(e.vin || key);
    const postedAt = isoOrNull(e.postedAt);
    if (!vin || !postedAt) continue;
    listings.push({
      dealership_id: dealershipId,
      user_id: userId,
      vin,
      name: text(e.name, 80) || null,
      price: intOrNull(e.price),
      posted_at: postedAt,
      listing_url: httpsUrl(e.listingUrl),
      salesperson: text(e.salesperson, 60) || null,
      updated_at: isoOrNull(e.updatedAt),
      status: 'listed',
      taken_down_at: null,
    });
  }
  const p = withPilotDefaults(pilot);
  const postAttempts = [];
  for (const a of p.posts) {
    const vin = vinOf(a.vin);
    const startedAt = isoOrNull(a.startedAt);
    if (!vin || !startedAt) continue;
    postAttempts.push({
      dealership_id: dealershipId,
      user_id: userId,
      vin,
      name: text(a.name, 80) || null,
      salesperson: text(a.salesperson, 60) || null,
      queue: Boolean(a.queue),
      started_at: startedAt,
      ended_at: isoOrNull(a.endedAt),
      outcome: a.outcome ? text(a.outcome, 20) : null,
      seconds: intOrNull(a.seconds),
      reason: a.reason ? text(a.reason, 120) : null,
    });
  }
  const todoItems = [];
  for (const f of p.flags) {
    const vin = vinOf(f.vin);
    const flaggedAt = isoOrNull(f.flaggedAt);
    if (!vin || !flaggedAt || !FLAG_KINDS.includes(f.kind)) continue;
    const doneAt = isoOrNull(f.doneAt);
    todoItems.push({
      dealership_id: dealershipId,
      vin,
      kind: f.kind,
      name: text(f.name, 80) || null,
      flagged_at: flaggedAt,
      done_at: doneAt,
      how: doneAt && FLAG_HOWS.includes(f.how) ? f.how : null,
      from_price: intOrNull(f.from),
      to_price: intOrNull(f.to),
    });
  }
  return { listings, postAttempts, todoItems };
}

// One scan's counts (the popup's diff plus the snapshot's size), or null.
export function scanSummary(scan) {
  if (!isObject(scan)) return null;
  const takenAt = isoOrNull(scan.takenAt);
  if (!takenAt) return null;
  return { takenAt, cars: intOrNull(scan.cars), ready: intOrNull(scan.ready), takeDownCount: intOrNull(scan.takeDownCount), priceUpdateCount: intOrNull(scan.priceUpdateCount) };
}

export function scanRow(scan, { origin = '', dealershipId = null } = {}) {
  const s = scanSummary(scan);
  if (!s) return null;
  return { dealership_id: dealershipId, website_origin: String(origin || ''), taken_at: s.takenAt, cars: s.cars, ready: s.ready, take_down_count: s.takeDownCount, price_update_count: s.priceUpdateCount };
}

/**
 * The body of one POST to the sync function.
 *   posted: the salesperson's own entries, whole
 *   known:  the keys (VIN@postedAt) of their own posts this machine sent or
 *           received at its last sync (the state's `known`, nextSyncState);
 *           the function takes down only those missing from `posted`, so a
 *           machine that never synced takes nothing down
 *   pilot:  posts and flags that changed after `since`, less PILOT_LOOKBACK_MS
 *           for a slow clock here (all of them the first time)
 *   scan:   this scan's counts, or null when nothing was scanned
 *   since:  the serverTime of the last answer, or null
 *   today:  the caller's local calendar day ({ from, to }, localDayRange), so
 *           the function can count their posts in it (postsToday); `now` is
 *           the moment, a parameter for the tests
 */
export function syncPayload({ origin = '', posted = {}, known = null, pilot = null, scan = null, since = null, userId = '', now = new Date() } = {}) {
  const own = {};
  for (const [key, e] of Object.entries(isObject(posted) ? posted : {})) {
    if (!isObject(e) || !isOwn(e, userId)) continue;
    const vin = vinOf(e.vin || key);
    if (!vin) continue;
    own[vin] = {
      name: text(e.name, 80),
      price: intOrNull(e.price),
      postedAt: isoOrNull(e.postedAt),
      ...(httpsUrl(e.listingUrl) ? { listingUrl: httpsUrl(e.listingUrl) } : {}),
      ...(text(e.salesperson, 60) ? { salesperson: text(e.salesperson, 60) } : {}),
      ...(isoOrNull(e.updatedAt) ? { updatedAt: isoOrNull(e.updatedAt) } : {}),
    };
  }
  const p = withPilotDefaults(pilot);
  const s = ms(since);
  const from = s === null ? null : s - PILOT_LOOKBACK_MS;
  const posts = p.posts.filter((a) => changedAfter(from, a.startedAt, a.endedAt, a.reviewedAt, a.formOpenedAt, a.filledAt));
  const flags = p.flags.filter(flagChangedAfter(from));
  return { version: SYNC_VERSION, origin: String(origin || ''), posted: own, known: keyList(known), pilot: { posts, flags }, scan: scanSummary(scan), since: isoOrNull(since), today: localDayRange(now) };
}

/**
 * The closed to-do flags the next sync still has to send: closed after the
 * last sync (the state's `since`, less PILOT_LOOKBACK_MS), as syncPayload
 * picks them. Once synced, the dealership's copy of an item closes only when
 * an upload carries this flag closed, so a flag closed here (Taken down,
 * Updated, or seen on the listing) and dropped before that upload would
 * leave the item open on the manager's list for good. With no sync state
 * (this website never synced, or Sign out forgot it) there is no last sync
 * to measure from, and none is held for one.
 */
export function flagsAwaitingSync(pilot, syncState) {
  const since = isObject(syncState) ? ms(syncState.since) : null;
  if (since === null) return [];
  return withPilotDefaults(pilot).flags.filter((f) => f.doneAt).filter(flagChangedAfter(since - PILOT_LOOKBACK_MS));
}

// "Clear the numbers" for a website with this sync state: clearNumbers
// (src/pilot.js), which keeps the open to-do items and a post under way, also
// keeping the closed items the next sync still has to send.
export function clearNumbersKeepingUnsynced(pilot, syncState) {
  return clearNumbers(pilot, { keep: flagsAwaitingSync(pilot, syncState) });
}

// ---------- what comes down ----------

// Whose entry a row is: its user's id, plus `mine: false` when the caller
// (userId) is known and the row is a colleague's. Own entries carry no flag.
function ownership(r, userId) {
  if (!r.user_id) return {};
  const id = String(r.user_id);
  return userId && id !== String(userId) ? { userId: id, mine: false } : { userId: id };
}

// A server row as a registry entry. Only the keys markPosted() would set
// are written; postedWith (which build posted it) is kept from the local
// entry when there is one.
function entryFromRow(r, prev = {}, userId = '') {
  return {
    name: text(r.name, 80) || text(prev.name, 80),
    price: intOrNull(r.price),
    postedAt: isoOrNull(r.posted_at),
    ...(httpsUrl(r.listing_url) ? { listingUrl: httpsUrl(r.listing_url) } : {}),
    ...(text(r.salesperson, 60) ? { salesperson: text(r.salesperson, 60) } : {}),
    ...(isoOrNull(r.updated_at) ? { updatedAt: isoOrNull(r.updated_at) } : {}),
    ...(prev.postedWith ? { postedWith: prev.postedWith } : {}),
    ...ownership(r, userId),
  };
}

const rowsOf = (remote, key) => (Array.isArray(remote) ? remote : isObject(remote) && Array.isArray(remote[key]) ? remote[key] : []);

/**
 * Merges the server's listings into the local registry and returns the new
 * registry (the input is not changed). Rules, in order, per VIN:
 *   - only on the server, listed: added, with its listing link and who posted;
 *   - the local entry is a newer post than the server's: kept (it goes up next);
 *   - the server's post is newer than the local one: the server's replaces it,
 *     or the entry goes when that newer post was taken down;
 *   - the same post, taken down on the server: removed here too;
 *   - the same post on both sides: the newest change (updatedAt, else
 *     postedAt) wins for the price; a change made here after `since` is
 *     therefore kept unless the server's is newer still; a listing link or a
 *     name that is missing on one side is filled from the other.
 * Before all of that, with the caller's `userId` given: a colleague's newer
 * post is never the row an entry the caller owns is judged by. The caller's
 * own latest row for the VIN stands in for it (so their own take-down
 * elsewhere still removes the entry), and with none the entry is kept as it
 * is and goes up again, so the server never marks the caller's row taken
 * down over a colleague's post of the same car. The same post (VIN and
 * posting time) is one row on the server, so for it the server's user
 * decides, as the same-post rule says.
 * Every entry the server knows gets its row's userId; with the caller's
 * `userId` given, a colleague's entry also gets `mine: false` (own entries
 * carry no flag). `remote` is the sync answer ({ listings: [...] }) or a
 * plain array of rows.
 * `sent` is the request's `posted`: a listed row of the caller's that the
 * request carried and `local` no longer has was removed here while the
 * request was out (Taken down clicked during the sync), so it is not added
 * back; the next sync takes it down, as the request's keys become `known`.
 * The same post twice in one answer (read listed, then taken down, while a
 * take-down landed between the function's reads) counts as taken down: a
 * taken-down row is never listed again.
 * A take-down of another post of the same car never removes one of the
 * caller's own posts the server holds as listed: the answer looks back 10
 * minutes (the function's margin), so it can carry a take-down whose
 * posted_at is later than a re-post from a machine with a slow clock.
 */
export function mergeRegistry(local, remote, { since = null, userId = '', sent = null } = {}) {
  void since; // the newest-change rule covers it; kept in the signature so callers can say when they last synced
  const base = isObject(local) ? local : {};
  const removedHere = sentKeys(sent);
  const current = new Map(); // vin -> the latest post the server knows for it
  const own = new Map(); // vin -> the caller's own latest post there
  const later = (r, have) => !have || ms(r.posted_at) > ms(have.posted_at) || (ms(r.posted_at) === ms(have.posted_at) && r.status !== 'listed');
  for (const r of rowsOf(remote, 'listings')) {
    if (!isObject(r)) continue;
    const vin = vinOf(r.vin);
    const at = ms(r.posted_at);
    if (!vin || at === null) continue;
    if (later(r, current.get(vin))) current.set(vin, r);
    if (userId && r.user_id && String(r.user_id) === String(userId) && later(r, own.get(vin))) own.set(vin, r);
  }
  const listedOwn = new Set(rowsOf(remote, 'listings').filter((r) => isObject(r) && r.status === 'listed' && !isTheirs(r, userId)).map((r) => postKey(r.vin, r.posted_at)));
  const out = {};
  const seen = new Set();
  for (const [key, e] of Object.entries(base)) {
    const vin = vinOf(key);
    seen.add(vin);
    if (!isObject(e)) continue;
    let r = current.get(vin);
    if (r && isTheirs(r, userId) && isOwn(e, userId) && !sameMoment(e.postedAt, r.posted_at)) {
      // a colleague's newer post never takes over the caller's own entry:
      // their own row decides, and with none the entry stays as it is (every
      // rule below then sees a row of the caller's, so ownership is never
      // reassigned to a colleague over a different post)
      r = own.get(vin);
      if (!r) {
        out[key] = e;
        continue;
      }
    }
    if (!r) {
      out[key] = e;
      continue;
    }
    const localPosted = ms(e.postedAt);
    const remotePosted = ms(r.posted_at);
    if (localPosted !== null && localPosted > remotePosted + 999) {
      out[key] = e; // posted again here since the server last heard
      continue;
    }
    if (localPosted === null || remotePosted > localPosted + 999) {
      // the server knows a newer post of this car (from another machine)
      if (r.status === 'listed') out[key] = entryFromRow(r, e, userId);
      else if (isOwn(e, userId) && listedOwn.has(postKey(e.vin || key, e.postedAt))) out[key] = e; // still listed on the server: a take-down of another post of the car does not remove it
      continue;
    }
    if (r.status !== 'listed') continue; // taken down elsewhere
    const lStamp = ms(e.updatedAt) ?? localPosted;
    const rStamp = ms(r.updated_at) ?? remotePosted;
    const remoteNewer = rStamp > lStamp;
    const merged = { ...e };
    if (remoteNewer) {
      merged.price = intOrNull(r.price);
      if (r.updated_at) merged.updatedAt = isoOrNull(r.updated_at);
      if (httpsUrl(r.listing_url)) merged.listingUrl = httpsUrl(r.listing_url);
    }
    if (!merged.listingUrl && httpsUrl(r.listing_url)) merged.listingUrl = httpsUrl(r.listing_url);
    if (!merged.salesperson && text(r.salesperson, 60)) merged.salesperson = text(r.salesperson, 60);
    if (!merged.name && text(r.name, 80)) merged.name = text(r.name, 80);
    if (r.user_id) {
      delete merged.mine; // the server says whose it is
      Object.assign(merged, ownership(r, userId));
    }
    out[key] = merged;
  }
  for (const [vin, r] of current) {
    if (seen.has(vin) || r.status !== 'listed') continue;
    if (!isTheirs(r, userId) && removedHere.has(postKey(r.vin, r.posted_at))) continue; // removed here during the sync
    out[vin] = entryFromRow(r, {}, userId);
  }
  return out;
}

/**
 * Closes local to-do flags that were closed on another machine (the same
 * VIN, kind and flagging time, done on the server). Nothing is reopened: a
 * flag belongs to the salesperson's own listing and only their machines
 * carry it. With `posted` (the registry after mergeRegistry) and the
 * caller's `userId`, an open item on one of the caller's own listings that
 * this machine does not hold (it was cleared here, with Clear everything for
 * this website, or this machine never had it) is taken in with its flagging
 * time: the server closes an item only when an upload closes that flag, so
 * without it the item would stay open on the manager's list for good while
 * the next scan here opened a second one. Returns the pilot record
 * (unchanged when nothing matched).
 * `remote` is the sync answer ({ todoItems: [...] }) or a plain array.
 */
export function mergeFlags(pilot, remote, { posted = null, userId = '' } = {}) {
  const p = withPilotDefaults(pilot);
  const rows = rowsOf(remote, 'todoItems').filter((t) => isObject(t));
  const done = rows.filter((t) => t.done_at);
  let touched = false;
  const flags = p.flags.map((f) => {
    if (f.doneAt) return f;
    const t = done.find((d) => vinOf(d.vin) === vinOf(f.vin) && d.kind === f.kind && sameMoment(d.flagged_at, f.flaggedAt));
    if (!t) return f;
    touched = true;
    const at = isoOrNull(t.done_at);
    return { ...f, doneAt: at, how: FLAG_HOWS.includes(t.how) ? t.how : 'manual', hours: hoursBetween(f.flaggedAt, at) };
  });
  // the caller's own listings, by VIN, with when each was posted: an item
  // flagged before that post was made belongs to an earlier listing of the car
  const own = new Map(Object.entries(isObject(posted) ? posted : {}).filter(([, e]) => isObject(e) && isOwn(e, userId)).map(([key, e]) => [vinOf(e.vin || key), ms(e.postedAt)]));
  for (const t of rows) {
    const vin = vinOf(t.vin);
    const flaggedAt = isoOrNull(t.flagged_at);
    if (t.done_at || !own.has(vin) || !flaggedAt || !FLAG_KINDS.includes(t.kind)) continue;
    if (own.get(vin) !== null && ms(flaggedAt) < own.get(vin)) continue;
    if (flags.some((f) => vinOf(f.vin) === vin && f.kind === t.kind && sameMoment(f.flaggedAt, flaggedAt))) continue;
    touched = true;
    flags.push({
      vin,
      kind: t.kind,
      name: text(t.name, 80),
      flaggedAt,
      ...(t.kind === 'price' ? { from: intOrNull(t.from_price), to: intOrNull(t.to_price) } : {}),
    });
  }
  return touched ? { ...p, flags } : p;
}

// The plan words the sync function answers (subscription_state() on the server).
export const PLAN_STATES = Object.freeze(['none', 'pilot', 'active', 'lapsed']);

// The dealership's plan as the function answers it ({ state, pilotEndsAt,
// currentPeriodEnd, seats }, planOf in supabase/functions/_shared/billing.mjs),
// in one shape; null when the answer carries none. A state word this build
// does not know reads as 'none': the server, not this word, does the gating.
export function planFrom(plan) {
  if (!isObject(plan)) return null;
  return {
    state: PLAN_STATES.includes(plan.state) ? plan.state : 'none',
    pilotEndsAt: isoOrNull(plan.pilotEndsAt),
    currentPeriodEnd: isoOrNull(plan.currentPeriodEnd),
    seats: Number.isInteger(plan.seats) && plan.seats >= 1 ? plan.seats : null,
  };
}

// What to keep for the website after an answer: for the next call, and for
// what Settings and the cap show. `plan` is the last one learned (a 402
// carries one too). `postsToday` is the function's count of the caller's
// posts in `today`, the day the request sent, and only from this answer: a
// count is good for the day and the moment it was made, so an answer
// without one leaves null rather than an old number.
// `known` is the keys of the caller's own posts this sync sent (`sent`, the
// request's `posted`) and those the machine holds after the merge (`held`,
// the registry mergeRegistry wrote), for the next request (syncPayload). A
// row the answer carried but the merge did not keep (a colleague's newer
// take-down of the same car shadowed it) is not held here, so it is not
// known and never taken down from here. Without `held` (direct callers), the
// caller's own listed rows in the answer stand in. Only an answer that
// synced (it carries a serverTime) replaces it; a 402 keeps the last one.
export function nextSyncState(previous, response, { today = null, sent = null, userId = '', held = null } = {}) {
  const prev = isObject(previous) ? previous : {};
  const r = isObject(response) ? response : {};
  const d = isObject(r.dealership) ? r.dealership : {};
  const day = isObject(today) && isoOrNull(today.from) && isoOrNull(today.to) ? { from: isoOrNull(today.from), to: isoOrNull(today.to) } : null;
  const synced = Boolean(isoOrNull(r.serverTime));
  const received = isObject(held)
    ? [...sentKeys(Object.fromEntries(Object.entries(held).filter(([, e]) => isObject(e) && isOwn(e, userId))))]
    : rowsOf(r, 'listings').filter((row) => isObject(row) && row.status === 'listed' && userId && String(row.user_id) === String(userId)).map((row) => postKey(row.vin, row.posted_at));
  return {
    version: SYNC_VERSION,
    since: isoOrNull(r.serverTime) || prev.since || null,
    known: synced ? keyList([...sentKeys(sent), ...received]) : keyList(prev.known),
    dealershipId: d.id || prev.dealershipId || null,
    dealershipName: d.name || prev.dealershipName || '',
    role: r.role || prev.role || '',
    lastSyncAt: isoOrNull(r.serverTime) || prev.lastSyncAt || null,
    plan: planFrom(r.plan) || planFrom(prev.plan),
    postsToday: day && Number.isInteger(r.postsToday) && r.postsToday >= 0 ? { count: r.postsToday, ...day } : null,
  };
}
