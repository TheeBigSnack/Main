// Lot Sync sync function (Milestone 4). One POST …/sync carries the
// salesperson's own posted registry, the pilot's post attempts and to-do
// flags that changed since the last sync, and this scan's counts; the
// function writes them for the caller's dealership (matched by the website
// origin) and answers with the dealership's whole current registry and
// open to-do items, so every machine of the dealership converges
// (extension/src/sync.js merges the answer).
//
//   POST …/sync  { origin, posted, pilot: { posts, flags }, scan | null, since | null }
//     -> { ok, serverTime, dealership: { id, name, websiteOrigin }, role, counts, listings, todoItems }
//
// Everything is written with the caller's own token, so row-level security
// (migrations/0002_rls.sql) is the guard: a salesperson can only ever write
// their own listings and attempts, and only inside their dealership. Rules
// the function adds on top of RLS:
//   - a listing row of another user, or one already taken down, is never
//     changed by an upload (a stale machine cannot relist a sold car);
//   - the caller's listed rows that are missing from their registry, among
//     those the server already held at `since` (created_at, the server's
//     stamp; the client's posted_at is never compared with since), are
//     marked taken down (a machine that never synced, since null, takes
//     nothing down);
//   - a to-do item is closed by an upload but never reopened.
// The rows are built the way extension/src/sync.js toServerRows() builds
// them; keep the two mappings the same.

import { json, preflight, readJson, routeOf, isRecord, errorMessage, sameOrigin } from '../_shared/http.ts';
import { requireUser, membershipsOf, type Membership } from '../_shared/auth.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const BODY_LIMIT = 2 * 1024 * 1024;
const TAKEN_DOWN_WINDOW_DAYS = 90; // how far back taken-down rows go to a machine that never synced
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
const intOrNull = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
  return null;
};
const httpsUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\//i.test(u.trim()) ? u.trim().slice(0, 500) : null);
const sameMoment = (a: unknown, b: unknown): boolean => {
  const x = ms(a);
  const y = ms(b);
  return x !== null && y !== null && Math.abs(x - y) < 1000;
};
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

async function selectByVin(client: SupabaseClient, table: string, columns: string, dealershipId: string, vins: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const part of chunk([...new Set(vins)], CHUNK)) {
    const res = await client.from(table).select(columns).eq('dealership_id', dealershipId).in('vin', part);
    out.push(...rowsOf(res, `could not read ${table}`));
  }
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

function must(res: DbResult, what: string): void {
  if (res.error) throw new DbError(what, res.error);
}

// ---------- the handler ----------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST' || routeOf(req) !== 'sync') return json(req, 404, { ok: false, error: 'not found' });

  const auth = await requireUser(req);
  if (!auth.ok) return json(req, auth.status, { ok: false, error: auth.error });
  const { client, user } = auth.caller;

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
  const since = isoOrNull(body.since);
  const pilot = isRecord(body.pilot) ? body.pilot : {};
  const counts = { listingsInserted: 0, listingsUpdated: 0, takenDown: 0, attempts: 0, todoItems: 0, scans: 0 };

  try {
    // 1. the registry: new posts go in; the caller's own listed rows take a
    //    newer price or a link they were missing; other users' rows and
    //    taken-down rows are left alone
    const incoming = listingRows(body.posted, dealershipId, me);
    const existing = incoming.length ? await selectByVin(client, 'listings', 'id, user_id, vin, posted_at, name, price, listing_url, salesperson, updated_at, status', dealershipId, incoming.map((r) => r.vin)) : [];
    const inserts: ListingRow[] = [];
    for (const row of incoming) {
      const have = existing.find((r) => String(r.vin) === row.vin && sameMoment(r.posted_at, row.posted_at));
      if (!have) {
        inserts.push(row);
        continue;
      }
      if (String(have.user_id) !== me || have.status !== 'listed') continue;
      const patch: Row = {};
      const newer = (ms(row.updated_at) ?? ms(row.posted_at) ?? 0) > (ms(have.updated_at) ?? ms(have.posted_at) ?? 0);
      if (newer) {
        patch.price = row.price;
        patch.updated_at = row.updated_at;
        if (row.listing_url) patch.listing_url = row.listing_url;
      }
      if (!have.listing_url && row.listing_url) patch.listing_url = row.listing_url;
      if (!have.name && row.name) patch.name = row.name;
      if (!have.salesperson && row.salesperson) patch.salesperson = row.salesperson;
      if (Object.keys(patch).length) {
        must(await client.from('listings').update(patch).eq('id', String(have.id)), 'could not update a listing');
        counts.listingsUpdated += 1;
      }
    }
    if (inserts.length) {
      must(await client.from('listings').insert(inserts), 'could not add listings');
      counts.listingsInserted = inserts.length;
    }

    // 2. take-downs: the caller's listed rows the registry no longer has,
    //    among those the server already held at the caller's last sync
    //    (created_at <= since: both stamps are the server's). The client's
    //    posted_at is never compared with since: a post uploaded late from
    //    another of the caller's machines, or stamped by a slow clock, looks
    //    older than the last sync although the caller never received it,
    //    and a row marked taken down is never relisted.
    if (since) {
      const mine = rowsOf(await client.from('listings').select('id, vin, posted_at').eq('dealership_id', dealershipId).eq('user_id', me).eq('status', 'listed').lte('created_at', since), 'could not read listings');
      const sent = new Set(incoming.map((r) => `${r.vin}@${ms(r.posted_at)}`));
      const gone = mine.filter((r) => !sent.has(`${vinOf(r.vin)}@${ms(r.posted_at)}`)).map((r) => String(r.id));
      if (gone.length) {
        must(await client.from('listings').update({ status: 'taken_down', taken_down_at: new Date().toISOString() }).in('id', gone), 'could not mark listings taken down');
        counts.takenDown = gone.length;
      }
    }

    // 3. post attempts: the caller's own, whole rows (an attempt only ever advances on the machine that ran it)
    const attempts = attemptRows(pilot.posts, dealershipId, me);
    for (const part of chunk(attempts, 500)) {
      must(await client.from('post_attempts').upsert(part, { onConflict: 'dealership_id,user_id,vin,started_at' }), 'could not record post attempts');
      counts.attempts += part.length;
    }

    // 4. to-do items: new ones go in; an open one is closed by an upload
    //    that closed it (or gets the price the website moved to); a closed
    //    one is never reopened
    const todos = todoRows(pilot.flags, dealershipId);
    if (todos.length) {
      const have = await selectByVin(client, 'todo_items', 'id, vin, kind, flagged_at, done_at, from_price, to_price', dealershipId, todos.map((t) => t.vin));
      const fresh: TodoRow[] = [];
      for (const t of todos) {
        const h = have.find((r) => vinOf(r.vin) === t.vin && r.kind === t.kind && sameMoment(r.flagged_at, t.flagged_at));
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
        if (Object.keys(patch).length) {
          must(await client.from('todo_items').update(patch).eq('id', String(h.id)), 'could not update a to-do item');
          counts.todoItems += 1;
        }
      }
      if (fresh.length) {
        must(await client.from('todo_items').insert(fresh), 'could not add to-do items');
        counts.todoItems += fresh.length;
      }
    }

    // 5. this scan's counts (the same scan sent twice is stored once)
    const scan = scanRow(body.scan, membership.dealership.website_origin, dealershipId);
    if (scan) {
      must(await client.from('scan_summaries').upsert(scan, { onConflict: 'dealership_id,website_origin,taken_at', ignoreDuplicates: true }), 'could not record the scan');
      counts.scans = 1;
    }

    // The next call's `since`: taken after the writes above, so a row this
    // call inserted has created_at <= serverTime and the caller's own
    // take-down of it counts at the very next sync, and before the reads
    // below, so nothing the caller receives now was stamped after it.
    const serverTime = new Date().toISOString();

    // 6. the dealership's current state: every listing that is up, the
    //    take-downs since the last sync (the last 90 days for a machine that
    //    never synced), every open to-do item and the ones closed since
    const cutoff = since ?? new Date(Date.now() - TAKEN_DOWN_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const listed = await selectAll('could not read listings', (from, to) => client.from('listings').select('*').eq('dealership_id', dealershipId).eq('status', 'listed').order('posted_at', { ascending: false }).range(from, to));
    const down = await selectAll('could not read listings', (from, to) => client.from('listings').select('*').eq('dealership_id', dealershipId).eq('status', 'taken_down').gte('taken_down_at', cutoff).order('taken_down_at', { ascending: false }).range(from, to));
    const open = await selectAll('could not read to-do items', (from, to) => client.from('todo_items').select('*').eq('dealership_id', dealershipId).is('done_at', null).order('flagged_at', { ascending: false }).range(from, to));
    const closed = await selectAll('could not read to-do items', (from, to) => client.from('todo_items').select('*').eq('dealership_id', dealershipId).not('done_at', 'is', null).gte('done_at', cutoff).order('done_at', { ascending: false }).range(from, to));

    return json(req, 200, {
      ok: true,
      serverTime,
      dealership: { id: dealershipId, name: membership.dealership.name, websiteOrigin: membership.dealership.website_origin },
      role: membership.role,
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
