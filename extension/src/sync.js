// Sync (Milestone 4): the pure half of keeping the posted registry and the
// pilot numbers the same on every machine of a dealership. Nothing here
// touches the network or chrome.storage. The caller (the popup, the side
// panel or the worker, wired in with the Settings UI) does:
//
//   const localSince = new Date().toISOString(); // this machine's clock, before reading storage
//   const body = syncPayload({ origin, posted, pilot, scan, since, localSince: state.localSince, known: state.known, userId });
//   POST <project>/functions/v1/sync with authHeaders(session) (account.js)
//   posted = mergeRegistry(posted, response, { since, userId, sent: body.posted });
//   pilot  = mergeFlags(pilot, response, posted); // the merged registry: a flag of a fix made elsewhere goes
//   state  = nextSyncState(state, response, { today: body.today, sent: body.posted, userId, localSince })
//            // since, localSince, known, dealership id and role, the plan, the server's count of today's posts
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

import { withPilotDefaults, hoursBetween, FLAG_KINDS, FLAG_HOWS } from './pilot.js';

export const SYNC_VERSION = 1;

// A taken-down listing older than this is not sent back to a machine that
// has never synced (it cannot have the entry anyway).
export const TAKEN_DOWN_WINDOW_DAYS = 90;

// The pilot's post attempts and closed flags go up when one of their stamps
// is later than this long before `localSince`: the machine's own clock when
// its last successful sync began, so the stamps and the cutoff come from one
// clock however far it is from the server's. The margin covers an entry
// stamped just before that sync read storage and written just after, and a
// clock set back a little between two syncs. Sending one again is harmless:
// attempts are upserted on their key and a closed item is never reopened.
export const UPLOAD_MARGIN_MS = 10 * 60 * 1000;

// At most this many keys in `known`: the sync function's cap on the rows of
// one request (MAX_ROWS), which a registry that syncs at all stays under. A
// key left out only means its take-down is missed and can be repeated.
export const MAX_KNOWN = 2000;

// How far ahead of the server's clock a stamp may be: the sync function's
// FUTURE_SKEW_MS. A price change stamped further ahead than this comes from a
// clock that runs ahead; the function writes it as made at its own time, and
// mergeRegistry takes the server's stamp for it (below).
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

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
// A whole number for an integer column (Postgres integer, 4 bytes), or
// null: the sync function's intOrNull, which stores a number outside that
// range as unknown rather than fail every sync of this machine.
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const intOrNull = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= INT_MIN && r <= INT_MAX ? r : null;
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
 *   pilot:  every open flag, and the posts and closed flags with a stamp
 *           later than UPLOAD_MARGIN_MS before `localSince` (all of them
 *           when there is none: the first sync, or the first one after an
 *           update from a build that kept no `localSince`)
 *   scan:   this scan's counts, or null when nothing was scanned
 *   since:  the serverTime of the last answer, or null; it only picks what
 *           comes back down, never what goes up, since the stamps above are
 *           this machine's clock and the server's clock is another
 *   localSince: this machine's clock when its last successful sync began
 *   today:  the caller's local calendar day ({ from, to }, localDayRange), so
 *           the function can count their posts in it (postsToday); `now` is
 *           the moment, a parameter for the tests
 */
export function syncPayload({ origin = '', posted = {}, known = null, pilot = null, scan = null, since = null, localSince = null, userId = '', now = new Date() } = {}) {
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
  const last = ms(localSince);
  const cutoff = last === null ? null : last - UPLOAD_MARGIN_MS;
  const posts = p.posts.filter((a) => changedAfter(cutoff, a.startedAt, a.endedAt, a.reviewedAt, a.formOpenedAt, a.filledAt));
  // An open flag goes up on every sync: its prices change in place when the
  // website price moves again while it is open (noteFlags), with no new
  // stamp, and the function's step 4 applies the new prices to the open item
  // or changes nothing. A closed flag goes up again after it closed.
  const flags = p.flags.filter((f) => !f.doneAt || changedAfter(cutoff, f.flaggedAt, f.doneAt));
  return { version: SYNC_VERSION, origin: String(origin || ''), posted: own, known: keyList(known), pilot: { posts, flags }, scan: scanSummary(scan), since: isoOrNull(since), today: localDayRange(now) };
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
 *     name that is missing on one side is filled from the other. A stamp
 *     more than FUTURE_SKEW_MS ahead of the answer's serverTime comes from a
 *     clock that runs ahead: the server's row wins over a local change that
 *     the request carried as it stands (the function wrote it as made at its
 *     own time, so the row holds it with a true stamp), and a server stamp
 *     that far ahead counts as no change time (the posting time stands in).
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
  // the server's clock, and each sent entry's change stamp as the request carried it (VIN@postedAt -> ISO or null)
  const serverNow = isObject(remote) ? ms(remote.serverTime) : null;
  const tooLate = (t) => serverNow !== null && t !== null && t > serverNow + FUTURE_SKEW_MS;
  const sentChange = new Map(Object.entries(isObject(sent) ? sent : {}).filter(([, e]) => isObject(e)).map(([key, e]) => [postKey(e.vin || key, e.postedAt), isoOrNull(e.updatedAt)]));
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
    const rStamp = (tooLate(ms(r.updated_at)) ? null : ms(r.updated_at)) ?? remotePosted;
    // a change made here on a clock that runs ahead, which this request carried as it stands: the server took it as made at its own time
    const aheadHere = tooLate(ms(e.updatedAt)) && sentChange.get(postKey(e.vin || key, e.postedAt)) === isoOrNull(e.updatedAt);
    const remoteNewer = aheadHere || rStamp > lStamp;
    const merged = { ...e };
    if (remoteNewer) {
      merged.price = intOrNull(r.price);
      if (r.updated_at) merged.updatedAt = isoOrNull(r.updated_at);
      else if (aheadHere) delete merged.updatedAt;
      if (httpsUrl(r.listing_url)) merged.listingUrl = httpsUrl(r.listing_url);
    }
    if (!merged.listingUrl && httpsUrl(r.listing_url)) merged.listingUrl = httpsUrl(r.listing_url);
    if (isTheirs(r, userId)) {
      // a colleague's post: the server's name stands, an empty one too, so a
      // name the owner cleared there (forget_person, 0006_privacy.sql) or
      // corrected leaves this copy at its next sync
      if (text(r.salesperson, 60)) merged.salesperson = text(r.salesperson, 60);
      else delete merged.salesperson;
    } else if (!merged.salesperson && text(r.salesperson, 60)) merged.salesperson = text(r.salesperson, 60);
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
 * Follows the server's to-do items for the local open flags. Each of a
 * salesperson's machines flags the same sold car or price change at its own
 * scan time, and the server keeps one item per car and kind (the sync
 * function's step 4), so a local open flag is the same item as a server row
 * of its VIN and kind that is open, or that closed after the flag was
 * raised:
 *   - closed there (its own row, the same VIN, kind and flagging time, or
 *     that later-closed row): closed here too, with the server's time and
 *     how, so a fix ticked off on one machine is off the other's list;
 *   - open there with another flagging time (the other machine's sighting):
 *     the flag takes that row's time (the earliest, if there are several),
 *     so both machines carry one key and the hours count from it.
 * With neither, and with `registry` (the registry this sync merged) showing
 * the change already (the salesperson's own entry for the car is at the
 * flag's new price, or, for a take-down, there is no own entry for it any
 * more), the flag was raised from a registry that had not yet heard of a
 * fix made on another machine (a rescan that ran before this sync), and the
 * sync function filed no item for it: it is dropped, so it is never closed
 * later as cleared by the website, and the item stays as the machine that
 * fixed it closed it. Nothing is added or reopened: a flag belongs to the
 * salesperson's own listing and only their machines carry it. Returns the
 * pilot record (unchanged when nothing matched). `remote` is the sync answer
 * ({ todoItems: [...] }) or a plain array.
 */
export function mergeFlags(pilot, remote, registry = null) {
  const p = withPilotDefaults(pilot);
  const rows = rowsOf(remote, 'todoItems').filter((t) => isObject(t) && ms(t.flagged_at) !== null);
  const shown = isObject(registry) ? showsChange(registry) : null;
  if ((!rows.length && !shown) || !p.flags.length) return p;
  let touched = false;
  const flags = [];
  for (const f of p.flags) {
    if (f.doneAt) {
      flags.push(f);
      continue;
    }
    const item = rows.filter((t) => vinOf(t.vin) === vinOf(f.vin) && t.kind === f.kind);
    const t = item.find((d) => d.done_at && (sameMoment(d.flagged_at, f.flaggedAt) || (ms(d.done_at) ?? -Infinity) >= (ms(f.flaggedAt) ?? Infinity)));
    if (t) {
      touched = true;
      const at = isoOrNull(t.done_at);
      flags.push({ ...f, doneAt: at, how: FLAG_HOWS.includes(t.how) ? t.how : 'manual', hours: hoursBetween(f.flaggedAt, at) });
      continue;
    }
    const open = item.filter((d) => !d.done_at);
    if (open.length) {
      if (open.some((d) => sameMoment(d.flagged_at, f.flaggedAt))) {
        flags.push(f);
        continue;
      }
      const first = open.reduce((a, b) => (ms(b.flagged_at) < ms(a.flagged_at) ? b : a));
      touched = true;
      flags.push({ ...f, flaggedAt: isoOrNull(first.flagged_at) });
      continue;
    }
    if (shown && shown(f)) {
      touched = true; // a late sighting of a change already made: dropped
      continue;
    }
    flags.push(f);
  }
  return touched ? { ...p, flags } : p;
}

// Whether a registry already shows a flag's change, as the sync function
// judges it from the listing rows (step 4): the salesperson's own entry for
// the car is at the flag's new price, or, for a take-down, there is no own
// entry for the car.
function showsChange(registry) {
  const own = new Map();
  for (const [key, e] of Object.entries(registry)) if (isObject(e) && e.mine !== false) own.set(vinOf(e.vin || key), e);
  return (f) => {
    const e = own.get(vinOf(f.vin));
    if (f.kind === 'takeDown') return !e;
    const to = intOrNull(f.to);
    return Boolean(e) && to !== null && intOrNull(e.price) === to;
  };
}

// The plan words the sync function answers (planOf() on the server, the same rule as subscription_state() in SQL).
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
// `localSince` is this machine's clock when the sync began (before it read
// storage); only an answer that synced keeps it, for the next syncPayload.
export function nextSyncState(previous, response, { today = null, sent = null, userId = '', held = null, localSince = null } = {}) {
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
    localSince: (synced && isoOrNull(localSince)) || isoOrNull(prev.localSince) || null,
    known: synced ? keyList([...sentKeys(sent), ...received]) : keyList(prev.known),
    dealershipId: d.id || prev.dealershipId || null,
    dealershipName: d.name || prev.dealershipName || '',
    role: r.role || prev.role || '',
    lastSyncAt: isoOrNull(r.serverTime) || prev.lastSyncAt || null,
    plan: planFrom(r.plan) || planFrom(prev.plan),
    postsToday: day && Number.isInteger(r.postsToday) && r.postsToday >= 0 ? { count: r.postsToday, ...day } : null,
  };
}
