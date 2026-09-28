// Sync (Milestone 4): the pure half of keeping the posted registry and the
// pilot numbers the same on every machine of a dealership. Nothing here
// touches the network or chrome.storage. The caller (the popup, the side
// panel or the worker, wired in with the Settings UI) does:
//
//   const body = syncPayload({ origin, posted, pilot, scan, since, userId });
//   POST <project>/functions/v1/sync with authHeaders(session) (account.js)
//   posted = mergeRegistry(posted, response, { since, userId });
//   pilot  = mergeFlags(pilot, response);
//   state  = nextSyncState(state, response, { today: body.today })
//            // since, dealership id and role, the plan, the server's count of today's posts
//
// The state is per website; the wiring keeps it under a `sync` entry added
// to SITE_KEY_NAMES in src/storageKeys.js, so clearing a website removes it.
//
// A colleague's entry that the merge writes into posted:<origin> carries
// their userId and `mine: false`; the person's own entries carry no flag, so
// a machine that never synced is unchanged. cap.js and rescan.js read the
// flag: a colleague's car never counts toward this salesperson's daily cap
// and is never flagged as theirs to take down or update.
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

import { withPilotDefaults, hoursBetween, FLAG_KINDS, FLAG_HOWS } from './pilot.js';

export const SYNC_VERSION = 1;

// A taken-down listing older than this is not sent back to a machine that
// has never synced (it cannot have the entry anyway).
export const TAKEN_DOWN_WINDOW_DAYS = 90;

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
// An entry merged in from a colleague carries their userId and `mine: false`; it is theirs to sync.
const isOwn = (entry, userId) => entry.mine !== false && (!entry.userId || !userId || entry.userId === userId);

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
 *   posted: the salesperson's own entries, whole (the function tells a
 *           take-down by an entry that is missing and was known before `since`)
 *   pilot:  posts and flags that changed after `since` (all of them the first time)
 *   scan:   this scan's counts, or null when nothing was scanned
 *   since:  the serverTime of the last answer, or null
 *   today:  the caller's local calendar day ({ from, to }, localDayRange), so
 *           the function can count their posts in it (postsToday); `now` is
 *           the moment, a parameter for the tests
 */
export function syncPayload({ origin = '', posted = {}, pilot = null, scan = null, since = null, userId = '', now = new Date() } = {}) {
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
  const posts = p.posts.filter((a) => changedAfter(since, a.startedAt, a.endedAt, a.reviewedAt, a.formOpenedAt, a.filledAt));
  const flags = p.flags.filter((f) => changedAfter(since, f.flaggedAt, f.doneAt));
  return { version: SYNC_VERSION, origin: String(origin || ''), posted: own, pilot: { posts, flags }, scan: scanSummary(scan), since: isoOrNull(since), today: localDayRange(now) };
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
 * Every entry the server knows gets its row's userId; with the caller's
 * `userId` given, a colleague's entry also gets `mine: false` (own entries
 * carry no flag). `remote` is the sync answer ({ listings: [...] }) or a
 * plain array of rows.
 */
export function mergeRegistry(local, remote, { since = null, userId = '' } = {}) {
  void since; // the newest-change rule covers it; kept in the signature so callers can say when they last synced
  const base = isObject(local) ? local : {};
  const current = new Map(); // vin -> the latest post the server knows for it
  for (const r of rowsOf(remote, 'listings')) {
    if (!isObject(r)) continue;
    const vin = vinOf(r.vin);
    const at = ms(r.posted_at);
    if (!vin || at === null) continue;
    const have = current.get(vin);
    if (!have || at > ms(have.posted_at)) current.set(vin, r);
  }
  const out = {};
  const seen = new Set();
  for (const [key, e] of Object.entries(base)) {
    const vin = vinOf(key);
    seen.add(vin);
    if (!isObject(e)) continue;
    const r = current.get(vin);
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
    out[vin] = entryFromRow(r, {}, userId);
  }
  return out;
}

/**
 * Closes local to-do flags that were closed on another machine (the same
 * VIN, kind and flagging time, done on the server). Nothing is added or
 * reopened: a flag belongs to the salesperson's own listing and only their
 * machines carry it. Returns the pilot record (unchanged when nothing matched).
 * `remote` is the sync answer ({ todoItems: [...] }) or a plain array.
 */
export function mergeFlags(pilot, remote) {
  const p = withPilotDefaults(pilot);
  const done = rowsOf(remote, 'todoItems').filter((t) => isObject(t) && t.done_at);
  if (!done.length || !p.flags.length) return p;
  let touched = false;
  const flags = p.flags.map((f) => {
    if (f.doneAt) return f;
    const t = done.find((d) => vinOf(d.vin) === vinOf(f.vin) && d.kind === f.kind && sameMoment(d.flagged_at, f.flaggedAt));
    if (!t) return f;
    touched = true;
    const at = isoOrNull(t.done_at);
    return { ...f, doneAt: at, how: FLAG_HOWS.includes(t.how) ? t.how : 'manual', hours: hoursBetween(f.flaggedAt, at) };
  });
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
export function nextSyncState(previous, response, { today = null } = {}) {
  const prev = isObject(previous) ? previous : {};
  const r = isObject(response) ? response : {};
  const d = isObject(r.dealership) ? r.dealership : {};
  const day = isObject(today) && isoOrNull(today.from) && isoOrNull(today.to) ? { from: isoOrNull(today.from), to: isoOrNull(today.to) } : null;
  return {
    version: SYNC_VERSION,
    since: isoOrNull(r.serverTime) || prev.since || null,
    dealershipId: d.id || prev.dealershipId || null,
    dealershipName: d.name || prev.dealershipName || '',
    role: r.role || prev.role || '',
    lastSyncAt: isoOrNull(r.serverTime) || prev.lastSyncAt || null,
    plan: planFrom(r.plan) || planFrom(prev.plan),
    postsToday: day && Number.isInteger(r.postsToday) && r.postsToday >= 0 ? { count: r.postsToday, ...day } : null,
  };
}
