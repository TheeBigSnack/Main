// Lot Current sync function (Milestone 4). One POST …/sync carries the
// salesperson's own posted registry, the pilot's post attempts that changed
// since the last sync and its open or newly closed to-do flags, and this
// scan's counts; the
// function writes them for the caller's dealership (matched by the website
// origin) and answers with the dealership's whole current registry and
// open to-do items, so every machine of the dealership converges
// (extension/src/sync.js merges the answer).
//
//   POST …/sync  { origin, posted, known, pilot: { posts, flags }, scan | null, since | null, today: { from, to } | null }
//     -> { ok, serverTime, dealership: { id, name, websiteOrigin }, role, plan, postsToday, counts, listings, todoItems }
//     -> 402 { ok: false, error, code: 'lapsed', plan } when the dealership's plan has lapsed; nothing is written
//     -> 429 { ok: false, error } beyond PER_MINUTE requests by one user in a minute; nothing is read or written
//     -> 400 { ok: false, error } for a body over BODY_LIMIT, or more than MAX_ROWS listings, known keys, post attempts or to-do flags
//
// Everything is written with the caller's own token, so row-level security
// (migrations/0002_rls.sql) is the guard: a salesperson can only ever write
// their own listings and attempts, and only inside their dealership. Rules
// the function adds on top of RLS:
//   - the dealership's plan (its subscriptions row, read with the caller's
//     client; planOf in _shared/billing.mjs) goes back as `plan`, and a
//     lapsed dealership is refused with 402 before anything is written;
//   - a listing whose posted_at is more than FUTURE_SKEW_MS ahead of the
//     server's clock is rejected (counts.rejected): a stamp from the future
//     would win every merge for ever. So is a scan whose takenAt is that far
//     ahead (also counted in counts.rejected): it would stay the newest scan
//     in the manager view and the owner's usage report until its date came. A price change (updated_at) stamped
//     that far ahead is written as made at the server's time, and a stored
//     one that far ahead counts as no change time at all (the posting time
//     stands in), so a machine whose clock runs ahead cannot outrank a
//     later change made on a machine with a right clock;
//   - a VIN that another member currently has listed is theirs: an upload of
//     it by anyone else is skipped (counts.conflicts), so a car is re-posted
//     only by the person who has it up, or after their row is taken down;
//   - `today` is the caller's local calendar day; `postsToday` counts their
//     own rows posted in it (any status), less the listings they marked
//     posted but had made by hand before that day (listed_before, written
//     on insert from the entry's listedBefore and never changed by an
//     upload), so the per-salesperson daily cap
//     (extension/src/cap.js) can take the larger of its local count and
//     the server's. No `today`, or one that is not a day, gives null;
//   - a listing's price basis (basis, migration 0015: which of the
//     website's two prices it was posted at) is written on insert, and
//     later only into a row that has none, never over one already there;
//   - a scan held back as a likely website hiccup (scan.withheld, migration
//     0016) is stored marked withheld; the manager's page shows it as held
//     back, never as the last scan (manager/data.js);
//   - a listing row of another user, or one already taken down, is never
//     changed by an upload (a stale machine cannot relist a sold car);
//   - the caller's listed rows whose key (VIN@postedAt) is in `known` (the
//     keys of their own posts that machine sent or received at its last
//     sync) and missing from `posted` are marked taken down. No time decides
//     it: a row that machine never received is never in `known`. A request
//     without `known` (a machine that never synced) takes nothing down;
//   - a to-do item is closed by an upload but never reopened, and a car
//     has one item per kind at a time: the same sold car or price change
//     flagged on two of the salesperson's machines is one row, and a
//     sighting of a change the caller's listing already shows (a machine
//     that rescanned before it heard of the fix) adds none, whether it comes
//     up open or ticked off, or arrived before the fix did (step 4);
//   - take-downs and closed to-do items come back from CUTOFF_MARGIN_MS
//     before `since`, not from `since` itself (below, step 6).
// The rows are built the way extension/src/sync.js toServerRows() builds
// them; keep the two mappings the same. The per-user brake and the row caps
// are for one member flooding the dealership's tables (a real registry is a
// few hundred rows and a few tens of KiB): a brake, not a ledger.

import { json, preflight, readJson, routeOf, isRecord, errorMessage, sameOrigin } from '../_shared/http.ts';
import { requireUser, membershipsOf, subscriptionRowOf, type Membership } from '../_shared/auth.ts';
import { planOf, lapsedAnswer, todayRange } from '../_shared/billing.mjs';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const BODY_LIMIT = 512 * 1024; // a registry of a whole lot is a few tens of KiB
const PER_MINUTE = 12; // syncs per user per minute (the extension syncs after a scan, a post, a price update or a take-down)
const MAX_ROWS = 2000; // listings, known keys, post attempts or to-do flags in one request
const FUTURE_SKEW_MS = 5 * 60 * 1000; // how far ahead of the server's clock a posted_at, updated_at or scan's takenAt may be (extension/src/sync.js, manager/data.js and usage_report keep the same)
const TAKEN_DOWN_WINDOW_DAYS = 90; // how far back taken-down rows go to a machine that never synced
const CUTOFF_MARGIN_MS = 10 * 60 * 1000; // take-downs and closed to-do items this long before `since` come back again (step 6)
const KEY_MAX = 80; // a known key is a VIN, an @ and a time; anything longer is not one
const CHUNK = 100; // VINs per `in` filter, to keep the request URL short
const PAGE = 1000; // the API answers at most this many rows per request
const FLAG_KINDS = ['takeDown', 'price'];
const FLAG_HOWS = ['detected', 'manual', 'cleared'];

type Row = Record<string, unknown>;

interface ListingRow {
  dealership_id: string;
  user_id: string;
  vin: string;
  name: string | null;
  price: number | null;
  posted_at: string;
  listing_url: string | null;
  salesperson: string | null;
  updated_at: string | null;
  status: 'listed';
  taken_down_at: null;
  listed_before: boolean;
  basis: 'website' | 'beforeFees' | null;
}

interface AttemptRow {
  dealership_id: string;
  user_id: string;
  vin: string;
  name: string | null;
  salesperson: string | null;
  queue: boolean;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  seconds: number | null;
  reason: string | null;
}

interface TodoRow {
  dealership_id: string;
  vin: string;
  kind: string;
  name: string | null;
  flagged_at: string;
  done_at: string | null;
  how: string | null;
  from_price: number | null;
  to_price: number | null;
}

interface ScanRow {
  dealership_id: string;
  website_origin: string;
  taken_at: string;
  cars: number | null;
  ready: number | null;
  take_down_count: number | null;
  price_update_count: number | null;
  withheld: boolean;
}

// ---------- the same normalisers as extension/src/sync.js ----------

// Postgres keeps microseconds; Date.parse wants at most milliseconds.
const ms = (x: unknown): number | null => {
  if (x === null || x === undefined || x === '') return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  const t = Date.parse(String(x).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : t;
};
const isoOrNull = (x: unknown): string | null => {
  const t = ms(x);
  return t === null ? null : new Date(t).toISOString();
};
const text = (s: unknown, max: number): string => String(s ?? '').trim().slice(0, max);
const vinOf = (v: unknown): string => text(v, 17).toUpperCase();
// A whole number for an integer column (Postgres integer, 4 bytes), or
// null. A number outside that range (two website prices run together by a
// parse slip, say) would fail the whole request with 22003 on every sync of
// that machine, so it is stored as unknown instead.
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= INT_MIN && r <= INT_MAX ? r : null;
};
const httpsUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\//i.test(u.trim()) ? u.trim().slice(0, 500) : null);
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function listingRows(posted: unknown, dealershipId: string, userId: string): ListingRow[] {
  const out: ListingRow[] = [];
  if (!isRecord(posted)) return out;
  for (const [key, e] of Object.entries(posted)) {
    if (!isRecord(e)) continue;
    const vin = vinOf(e.vin || key);
    const postedAt = isoOrNull(e.postedAt);
    if (!vin || !postedAt) continue;
    out.push({
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
      listed_before: e.listedBefore === true,
      basis: e.basis === 'website' || e.basis === 'beforeFees' ? e.basis : null,
    });
  }
  return out;
}

function attemptRows(posts: unknown, dealershipId: string, userId: string): AttemptRow[] {
  const out: AttemptRow[] = [];
  for (const a of Array.isArray(posts) ? posts : []) {
    if (!isRecord(a)) continue;
    const vin = vinOf(a.vin);
    const startedAt = isoOrNull(a.startedAt);
    if (!vin || !startedAt) continue;
    out.push({
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
  return out;
}

// `known` as the set of keys step 2 compares: vin@ms(posted_at), the same
// form byPost uses. A key that does not parse is left out, which can only
// miss a take-down, never make one. Not a list: no keys at all.
function knownKeys(known: unknown): { keys: Set<string>; count: number } {
  const list = Array.isArray(known) ? known : [];
  const keys = new Set<string>();
  for (const k of list) {
    if (typeof k !== 'string' || k.length > KEY_MAX) continue;
    const at = k.lastIndexOf('@');
    const vin = at > 0 ? vinOf(k.slice(0, at)) : '';
    const t = at > 0 ? ms(k.slice(at + 1)) : null;
    if (vin && t !== null) keys.add(`${vin}@${t}`);
  }
  return { keys, count: list.length };
}

function todoRows(flags: unknown, dealershipId: string): TodoRow[] {
  const out: TodoRow[] = [];
  for (const f of Array.isArray(flags) ? flags : []) {
    if (!isRecord(f)) continue;
    const vin = vinOf(f.vin);
    const flaggedAt = isoOrNull(f.flaggedAt);
    const kind = String(f.kind ?? '');
    if (!vin || !flaggedAt || !FLAG_KINDS.includes(kind)) continue;
    const doneAt = isoOrNull(f.doneAt);
    const how = String(f.how ?? '');
    out.push({
      dealership_id: dealershipId,
      vin,
      kind,
      name: text(f.name, 80) || null,
      flagged_at: flaggedAt,
      done_at: doneAt,
      how: doneAt && FLAG_HOWS.includes(how) ? how : null,
      from_price: intOrNull(f.from),
      to_price: intOrNull(f.to),
    });
  }
  return out;
}

function scanRow(scan: unknown, origin: string, dealershipId: string): ScanRow | null {
  if (!isRecord(scan)) return null;
  const takenAt = isoOrNull(scan.takenAt);
  if (!takenAt) return null;
  return {
    dealership_id: dealershipId,
    website_origin: origin,
    taken_at: takenAt,
    cars: intOrNull(scan.cars),
    ready: intOrNull(scan.ready),
    take_down_count: intOrNull(scan.takeDownCount),
    price_update_count: intOrNull(scan.priceUpdateCount),
    withheld: scan.withheld === true,
  };
}

// ---------- database helpers ----------

interface DbResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

class DbError extends Error {
  code: string;
  constructor(what: string, error: { message: string; code?: string }) {
    super(`${what}: ${error.message}`);
    this.code = error.code || '';
  }
}

function rowsOf(res: DbResult, what: string): Row[] {
  if (res.error) throw new DbError(what, res.error);
  const out: Row[] = [];
  for (const r of Array.isArray(res.data) ? res.data : []) if (isRecord(r)) out.push(r);
  return out;
}

// Every row of a query, page by page.
async function selectAll(what: string, query: (from: number, to: number) => PromiseLike<DbResult>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = rowsOf(await query(from, from + PAGE - 1), what);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Every row for these VINs, CHUNK VINs a request and paged: a car posted
// again and again, or flagged week after week, has a row each time, so a
// chunk can hold more rows than one answer carries.
async function selectByVin(client: SupabaseClient, table: string, columns: string, dealershipId: string, vins: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const part of chunk([...new Set(vins)], CHUNK)) {
    out.push(...(await selectAll(`could not read ${table}`, (from, to) => client.from(table).select(columns).eq('dealership_id', dealershipId).in('vin', part).order('id').range(from, to))));
  }
  return out;
}

function must(res: DbResult, what: string): void {
  if (res.error) throw new DbError(what, res.error);
}

interface CountResult {
  count: number | null;
  error: { message: string; code?: string } | null;
}

// A head-only count: the number of matching rows, none of them travelling.
async function countOf(query: PromiseLike<CountResult>, what: string): Promise<number> {
  const res = await query;
  if (res.error) throw new DbError(what, res.error);
  return typeof res.count === 'number' ? res.count : 0;
}

// ---------- per-user rate limit (this instance only), as in rewrite ----------

const recent = new Map<string, number[]>();
function allow(who: string): boolean {
  const now = Date.now();
  const list = (recent.get(who) || []).filter((t) => now - t < 60_000);
  if (list.length >= PER_MINUTE) return false;
  list.push(now);
  recent.set(who, list);
  if (recent.size > 5000) {
    for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  }
  return true;
}

// ---------- the handler ----------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST' || routeOf(req) !== 'sync') return json(req, 404, { ok: false, error: 'not found' });

  const auth = await requireUser(req);
  if (!auth.ok) return json(req, auth.status, { ok: false, error: auth.error });
  const { client, user } = auth.caller;
  if (!allow(user.id)) return json(req, 429, { ok: false, error: 'too many syncs; try again in a minute' });

  const read = await readJson(req, BODY_LIMIT);
  if (!read.ok) return json(req, 400, { ok: false, error: read.error });
  const body = isRecord(read.body) ? read.body : {};
  const origin = typeof body.origin === 'string' ? body.origin.trim().replace(/\/+$/, '') : '';
  if (!origin) return json(req, 400, { ok: false, error: 'origin is missing (the dealer website the registry belongs to)' });

  let memberships: Membership[];
  try {
    memberships = await membershipsOf(client, user.id);
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
  const membership = memberships.find((m) => m.dealership !== null && sameOrigin(m.dealership.website_origin, origin));
  if (!membership || !membership.dealership) {
    return json(req, 403, { ok: false, error: memberships.length ? `your account is not a member of the dealership for ${origin}` : 'your account is not in a dealership yet: redeem an invite code first' });
  }
  const dealershipId = membership.dealership_id;
  const me = user.id;

  // The plan before anything else: a lapsed dealership is refused with 402
  // and nothing below runs. The row is read with the caller's own client
  // (a member may read their dealership's row; no service-role key here).
  let plan: ReturnType<typeof planOf>;
  try {
    plan = planOf(await subscriptionRowOf(client, dealershipId));
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
  if (plan.state === 'lapsed') return json(req, 402, lapsedAnswer(plan));

  const since = isoOrNull(body.since);
  const today = todayRange(body.today); // the caller's local calendar day, or null
  const pilot = isRecord(body.pilot) ? body.pilot : {};

  // The rows, before anything is written: a request carrying more than
  // MAX_ROWS of any kind is refused whole, and a listing stamped further
  // ahead of this clock than FUTURE_SKEW_MS is set aside and counted.
  const sentListings = listingRows(body.posted, dealershipId, me);
  const known = knownKeys(body.known);
  const attempts = attemptRows(pilot.posts, dealershipId, me);
  const todos = todoRows(pilot.flags, dealershipId);
  if (sentListings.length > MAX_ROWS || known.count > MAX_ROWS || attempts.length > MAX_ROWS || todos.length > MAX_ROWS) {
    return json(req, 400, { ok: false, error: `too many entries in one request (at most ${MAX_ROWS} listings, post attempts or to-do flags)` });
  }
  const now = Date.now();
  const latest = now + FUTURE_SKEW_MS;
  const incoming = sentListings.filter((r) => (ms(r.posted_at) ?? 0) <= latest);
  // a price change from a clock that runs ahead is taken as made now: its
  // price goes in, and a later change from any other machine still wins
  for (const r of incoming) if ((ms(r.updated_at) ?? 0) > latest) r.updated_at = new Date(now).toISOString();
  // when a row last changed: its updated_at, unless that is from the future, else its posting time
  const changedAt = (r: Row | ListingRow): number => {
    const u = ms(r.updated_at);
    return (u !== null && u <= latest ? u : ms(r.posted_at)) ?? 0;
  };
  const counts = { listingsInserted: 0, listingsUpdated: 0, takenDown: 0, rejected: sentListings.length - incoming.length, conflicts: 0, attempts: 0, todoItems: 0, scans: 0 };

  try {
    // 1. the registry: new posts go in, unless another member has the VIN
    //    up; the caller's own listed rows take a newer price or a link they
    //    were missing; other users' rows and taken-down rows are left alone
    const existing = incoming.length ? await selectByVin(client, 'listings', 'id, user_id, vin, posted_at, name, price, listing_url, salesperson, updated_at, status, basis', dealershipId, incoming.map((r) => r.vin)) : [];
    const byPost = new Map<string, Row>(); // vin@ms(posted_at) -> the row
    const listedByOthers = new Set<string>(); // VINs another member currently has up
    for (const r of existing) {
      byPost.set(`${vinOf(r.vin)}@${ms(r.posted_at)}`, r);
      if (r.status === 'listed' && String(r.user_id) !== me) listedByOthers.add(vinOf(r.vin));
    }
    const inserts: ListingRow[] = [];
    const changedHere = new Set<string>(); // VINs whose listing this request changed: a new post, a new price or a take-down (step 4)
    for (const row of incoming) {
      const have = byPost.get(`${row.vin}@${ms(row.posted_at)}`);
      if (!have) {
        if (listedByOthers.has(row.vin)) {
          counts.conflicts += 1;
          continue;
        }
        inserts.push(row);
        changedHere.add(row.vin);
        continue;
      }
      if (String(have.user_id) !== me || have.status !== 'listed') continue;
      const patch: Row = {};
      const newer = changedAt(row) > changedAt(have);
      if (newer) {
        if (intOrNull(have.price) !== row.price) changedHere.add(row.vin);
        patch.price = row.price;
        patch.updated_at = row.updated_at;
        if (row.listing_url) patch.listing_url = row.listing_url;
      }
      if (!have.listing_url && row.listing_url) patch.listing_url = row.listing_url;
      if (!have.name && row.name) patch.name = row.name;
      if (!have.salesperson && row.salesperson) patch.salesperson = row.salesperson;
      if (!have.basis && row.basis) patch.basis = row.basis; // the price the listing was posted at: into a row that has none, never over one
      if (Object.keys(patch).length) {
        must(await client.from('listings').update(patch).eq('id', String(have.id)), 'could not update a listing');
        counts.listingsUpdated += 1;
      }
    }
    if (inserts.length) {
      must(await client.from('listings').insert(inserts), 'could not add listings');
      counts.listingsInserted = inserts.length;
    }

    // 2. take-downs: the caller's listed rows that this machine knew at its
    //    last sync (`known`: the keys it sent or received then) and that its
    //    registry no longer has. Knowing is what counts, not time: a post
    //    that reached the server from the caller's other machine during or
    //    after that sync was never received here, so it is not in `known`
    //    and stays up, whatever its created_at or posted_at say. A request
    //    without `known` takes nothing down: a missed take-down shows up
    //    again in the registry and can be done again, while a wrong one is
    //    final (a row marked taken down is never relisted). An entry still in
    //    the registry is never taken down, even one set aside above as
    //    stamped in the future.
    const inRegistry = new Set(sentListings.map((r) => `${r.vin}@${ms(r.posted_at)}`));
    const dropped = [...known.keys].filter((k) => !inRegistry.has(k));
    if (dropped.length) {
      const wanted = new Set(dropped);
      const vins = [...new Set(dropped.map((k) => k.slice(0, k.lastIndexOf('@'))))];
      const gone: string[] = [];
      for (const part of chunk(vins, CHUNK)) {
        const mine = await selectAll('could not read listings', (from, to) => client.from('listings').select('id, vin, posted_at').eq('dealership_id', dealershipId).eq('user_id', me).eq('status', 'listed').in('vin', part).order('id').range(from, to));
        for (const r of mine) {
          if (!wanted.has(`${vinOf(r.vin)}@${ms(r.posted_at)}`)) continue;
          gone.push(String(r.id));
          changedHere.add(vinOf(r.vin));
        }
      }
      for (const part of chunk(gone, CHUNK)) {
        must(await client.from('listings').update({ status: 'taken_down', taken_down_at: new Date().toISOString() }).in('id', part), 'could not mark listings taken down');
        counts.takenDown += part.length;
      }
    }

    // 3. post attempts: the caller's own, whole rows (an attempt only ever advances on the machine that ran it)
    for (const part of chunk(attempts, 500)) {
      must(await client.from('post_attempts').upsert(part, { onConflict: 'dealership_id,user_id,vin,started_at' }), 'could not record post attempts');
      counts.attempts += part.length;
    }

    // 4. to-do items: new ones go in; an open one is closed by an upload
    //    that closed it (or gets the price the website moved to); a closed
    //    one is never reopened. One item per car and kind: each of a
    //    salesperson's machines flags the same sold car or price change at
    //    its own scan time, so an upload with no row of its own (the same
    //    VIN, kind and flagging time) is the same item as a row of that VIN
    //    and kind whose time overlaps it (flagged before the upload closed,
    //    and closed, if it is, after the upload was flagged). That row takes
    //    the upload instead of a second row going in, and an open one keeps
    //    the earlier flagging time, so its hours count from the first
    //    sighting; mergeFlags in extension/src/sync.js moves the other
    //    machine's flag onto it.
    //    A machine that rescans before it has heard of a fix made on
    //    another (the laptop shut while the desktop updated the price or
    //    took the car down) flags the change again, after that item closed.
    //    Such an open upload, with no row of its own and none it overlaps,
    //    is a late sighting, not a new item, when the caller's own listing
    //    already shows the change (`shows`): every listed row of theirs for
    //    the VIN is at the flag's new price, or they have rows for it and
    //    none is up. No row goes in for it, and mergeFlags drops that
    //    machine's flag once its registry has the fix.
    //    A closed upload with no row of its own and none it overlaps is an
    //    item (a flag raised and fixed on one machine between two syncs),
    //    except in the two orders that make it the same item as a row:
    //    - the fix reached the server after another machine's sighting of
    //      it (the fixing machine's sync after the fix did not get
    //      through): the first row of the VIN and kind flagged after the
    //      upload closed, counting this request's other uploads, is of the
    //      same change (for a price, the same new price), the listing now
    //      shows it, and the car was not posted since the upload was
    //      flagged. That row may still be open, or the other machine may
    //      have closed it since (upkeep found the listing already changed,
    //      the salesperson ticked it off, or the website went back and its
    //      rescan closed it as cleared). It takes the upload (its earlier
    //      flagging time, its close and how), so the item counts from the
    //      first sighting and is not left closed as cleared; the other
    //      machine's flag is then a late sighting. A different change
    //      first in between (the price moved on and back) means the row is
    //      a change of its own, and nothing merges;
    //    - a machine sighted the change on an old registry and ticked it
    //      off before its first sync: the newest row of the VIN and kind is
    //      closed (not as cleared) before the upload was flagged, with the
    //      same change, and the listing showed it before this request (it
    //      shows it, and this request changed nothing of it). No row goes in.
    //    A change that really happened again (the website price back and
    //    down again, a new price, the car posted again) is never either.
    if (todos.length) {
      const have = await selectByVin(client, 'todo_items', 'id, vin, kind, flagged_at, done_at, how, from_price, to_price', dealershipId, todos.map((t) => t.vin));
      const byFlag = new Map<string, Row>(); // vin@kind@ms(flagged_at) -> the row
      const byItem = new Map<string, Row[]>(); // vin@kind -> its rows
      for (const r of have) {
        byFlag.set(`${vinOf(r.vin)}@${String(r.kind)}@${ms(r.flagged_at)}`, r);
        const item = `${vinOf(r.vin)}@${String(r.kind)}`;
        byItem.set(item, [...(byItem.get(item) || []), r]);
      }
      const overlaps = (r: Row, t: TodoRow): boolean => {
        const rDone = ms(r.done_at);
        const tDone = ms(t.done_at);
        return (tDone === null || (ms(r.flagged_at) ?? 0) <= tDone) && (rDone === null || (ms(t.flagged_at) ?? 0) <= rDone);
      };
      const fresh: TodoRow[] = [];
      for (const t of todos) {
        let h = byFlag.get(`${t.vin}@${t.kind}@${ms(t.flagged_at)}`);
        const own = Boolean(h);
        if (!h) {
          const same = (byItem.get(`${t.vin}@${t.kind}`) || []).filter((r) => overlaps(r, t));
          h = same.find((r) => !r.done_at) || same[0];
        }
        if (!h) {
          fresh.push(t);
          continue;
        }
        const patch: Row = {};
        if (!h.done_at && t.done_at) {
          patch.done_at = t.done_at;
          patch.how = t.how;
        } else if (!h.done_at && !t.done_at && t.kind === 'price' && (intOrNull(h.from_price) !== t.from_price || intOrNull(h.to_price) !== t.to_price)) {
          patch.from_price = t.from_price;
          patch.to_price = t.to_price;
        }
        if (!own && !h.done_at && (ms(t.flagged_at) ?? 0) < (ms(h.flagged_at) ?? 0)) patch.flagged_at = t.flagged_at;
        if (Object.keys(patch).length) {
          must(await client.from('todo_items').update(patch).eq('id', String(h.id)), 'could not update a to-do item');
          Object.assign(h, patch);
          counts.todoItems += 1;
        }
      }
      // the caller's own listing rows for the new items' VINs, as steps 1-2 left them
      const mine = fresh.length ? (await selectByVin(client, 'listings', 'vin, user_id, price, status, posted_at', dealershipId, fresh.map((t) => t.vin))).filter((r) => String(r.user_id) === me) : [];
      const rowsOf = (vin: string): Row[] => mine.filter((r) => vinOf(r.vin) === vin);
      // whether the caller's listing shows a change of this kind to this price
      const shows = (vin: string, kind: string, to: number | null): boolean => {
        const rows = rowsOf(vin);
        const up = rows.filter((r) => r.status === 'listed');
        if (kind === 'takeDown') return rows.length > 0 && up.length === 0;
        return to !== null && up.length > 0 && up.every((r) => intOrNull(r.price) === to);
      };
      // no posting of the car by the caller after this moment: the same listing
      const sameListing = (vin: string, at: number): boolean => rowsOf(vin).every((r) => (ms(r.posted_at) ?? 0) <= at);
      const sameChange = (r: Row, t: TodoRow): boolean => t.kind === 'takeDown' || (t.to_price !== null && intOrNull(r.to_price) === t.to_price);
      // in flagging order, each new item joining its car's rows as it is
      // taken, so "the newest row" also counts a change this request brings
      const taken = new Set<TodoRow>();
      for (const t of [...fresh].sort((a, b) => (ms(a.flagged_at) ?? 0) - (ms(b.flagged_at) ?? 0))) {
        const key = `${t.vin}@${t.kind}`;
        const item = byItem.get(key) || [];
        const take = () => {
          taken.add(t);
          byItem.set(key, [...item, { ...t }]);
        };
        if (!t.done_at) {
          if (!shows(t.vin, t.kind, t.to_price)) take();
          continue;
        }
        const flagged = ms(t.flagged_at) ?? 0;
        const done = ms(t.done_at) ?? 0;
        if (t.how !== 'cleared' && sameListing(t.vin, flagged) && shows(t.vin, t.kind, t.to_price)) {
          // the first sighting of the car and kind after the fix, among its
          // rows and this request's other uploads: a row of the same change
          // takes the upload, whether it is still open or the other machine
          // has closed it since; anything else first means the change moved
          // on in between, and nothing merges
          const after: Row[] = [...item, ...fresh.filter((f) => f !== t && f.vin === t.vin && f.kind === t.kind).map((f) => ({ ...f }))];
          const next = after.filter((r) => (ms(r.flagged_at) ?? 0) > done).sort((a, b) => (ms(a.flagged_at) ?? 0) - (ms(b.flagged_at) ?? 0))[0];
          const later = next && next.id && sameChange(next, t) ? next : null;
          if (later) {
            const patch: Row = { flagged_at: t.flagged_at, done_at: t.done_at, how: t.how, from_price: t.from_price, to_price: t.to_price };
            must(await client.from('todo_items').update(patch).eq('id', String(later.id)), 'could not update a to-do item');
            Object.assign(later, patch);
            counts.todoItems += 1;
            continue;
          }
        }
        const newest = item.reduce<Row | null>((a, r) => (!a || (ms(r.flagged_at) ?? 0) > (ms(a.flagged_at) ?? 0) ? r : a), null);
        if (newest && newest.done_at && newest.how !== 'cleared' && (ms(newest.done_at) ?? 0) <= flagged && sameChange(newest, t)
            && sameListing(t.vin, ms(newest.flagged_at) ?? 0) && shows(t.vin, t.kind, t.to_price) && !changedHere.has(t.vin)) continue;
        take();
      }
      const adding = fresh.filter((t) => taken.has(t));
      if (adding.length) {
        must(await client.from('todo_items').insert(adding), 'could not add to-do items');
        counts.todoItems += adding.length;
      }
    }

    // 5. this scan's counts (the same scan sent twice is stored once); one
    //    stamped further ahead of this clock than FUTURE_SKEW_MS is set
    //    aside and counted, like a listing. A scan held back as a likely
    //    website hiccup comes marked withheld and keeps that mark (scanRow).
    //    A scan already stored is never changed, so when the salesperson
    //    later accepts a held-back read and it comes again unmarked with the
    //    same time, the stored row stays marked withheld until a newer scan
    const scan = scanRow(body.scan, membership.dealership.website_origin, dealershipId);
    if (scan && (ms(scan.taken_at) ?? 0) > latest) counts.rejected += 1;
    else if (scan) {
      must(await client.from('scan_summaries').upsert(scan, { onConflict: 'dealership_id,website_origin,taken_at', ignoreDuplicates: true }), 'could not record the scan');
      counts.scans = 1;
    }

    // The next call's `since`, which only picks the take-downs and closed
    // to-do items it gets back (step 6); take-downs are decided by `known`.
    // It is this function's clock, taken before the reads below, but those
    // reads are separate requests and other calls write in between: a
    // take-down stamped just before this moment (by another call's clock)
    // can commit only after the reads, and a closed to-do item carries the
    // closing machine's clock. So the next call looks back from
    // CUTOFF_MARGIN_MS before `since`, well past any request's run and any
    // host's clock error; a take-down or a closed item sent twice changes
    // nothing on the machine (mergeRegistry, mergeFlags).
    const serverTime = new Date().toISOString();

    // 6. the dealership's current state: every listing that is up, the
    //    take-downs since the last sync, less the margin (the last 90 days
    //    for a machine that never synced), every open to-do item and the
    //    ones closed since then; each read ends its order with the
    //    id, so the pages of one read fit together: rows that tie on the
    //    stamp (a chunk of take-downs shares one) would otherwise come back
    //    in a different order on each page, some twice and some not at all
    const cutoff = since ? new Date(Date.parse(since) - CUTOFF_MARGIN_MS).toISOString() : new Date(Date.now() - TAKEN_DOWN_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const listed = await selectAll('could not read listings', (from, to) => client.from('listings').select('*').eq('dealership_id', dealershipId).eq('status', 'listed').order('posted_at', { ascending: false }).order('id').range(from, to));
    const down = await selectAll('could not read listings', (from, to) => client.from('listings').select('*').eq('dealership_id', dealershipId).eq('status', 'taken_down').gte('taken_down_at', cutoff).order('taken_down_at', { ascending: false }).order('id').range(from, to));
    const open = await selectAll('could not read to-do items', (from, to) => client.from('todo_items').select('*').eq('dealership_id', dealershipId).is('done_at', null).order('flagged_at', { ascending: false }).order('id').range(from, to));
    const closed = await selectAll('could not read to-do items', (from, to) => client.from('todo_items').select('*').eq('dealership_id', dealershipId).not('done_at', 'is', null).gte('done_at', cutoff).order('done_at', { ascending: false }).order('id').range(from, to));

    // 7. the caller's posts in the calendar day they sent, for the daily
    //    cap: their own rows only (the cap is per salesperson), any status
    //    (a post taken down later was still a post that day). A listing they
    //    marked posted that day but had made by hand before it
    //    (listed_before, migration 0012) is not a post of that day. Counted
    //    after the writes so the posts this call brought are in it; null
    //    when the request sent no day, and the cap then counts locally alone.
    const postsToday = today ? await countOf(client.from('listings').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('user_id', me).eq('listed_before', false).gte('posted_at', today.from).lt('posted_at', today.to), 'could not count listings') : null;

    return json(req, 200, {
      ok: true,
      serverTime,
      dealership: { id: dealershipId, name: membership.dealership.name, websiteOrigin: membership.dealership.website_origin },
      role: membership.role,
      plan,
      postsToday,
      counts,
      listings: [...listed, ...down],
      todoItems: [...open, ...closed],
    });
  } catch (e) {
    if (e instanceof DbError && e.code === '42501') return json(req, 403, { ok: false, error: 'not allowed: ' + e.message });
    console.error(e);
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
});
