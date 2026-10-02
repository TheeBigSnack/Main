// The sync function's real handler (supabase/functions/sync/index.ts) under
// Node, against the fake database (test/functions/): the order of its checks
// (401, the per-user brake, the body, 403, 402), the upload rules
// supabase/README.md states (another member's row and a taken-down row are
// never changed, a VIN a colleague has up is theirs, take-downs are the
// posts in `known` missing from the registry, take-downs and closed to-do
// items come back from a margin before `since`, postsToday counts the
// caller's own rows in their day), the answer's shape, every read paged
// past the API's 1,000 rows, and the extension's own syncOnce
// (extension/src/accountFlow.js) run against it end to end. The races
// between two requests are in test/fn-sync-race.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadFunction, invoke, fake, hermetic, functionsFetch, uuid, keysOf, SUPABASE_URL, ANON_KEY, EXTENSION_ORIGIN } from './functions/harness.mjs';
import { pgTime, MODELLED_TABLES } from './functions/fake-supabase.mjs';
import { LAPSED_MESSAGE } from '../supabase/functions/_shared/billing.mjs';
import { syncOnce, LAPSED_MESSAGE as EXTENSION_LAPSED_MESSAGE } from '../extension/src/accountFlow.js';
import { sessionFromTokenResponse, storeSession, ACCOUNT_KEY } from '../extension/src/account.js';
import { siteKeys } from '../extension/src/storageKeys.js';
import { runChecks } from '../scripts/check-deploy.mjs';

hermetic();

const ORIGIN = 'https://www.example-motors.test';
const OTHER_ORIGIN = 'https://www.other-motors.test';
const D1 = uuid(1);
const D2 = uuid(2);
const U1 = uuid(11); // salesperson at D1
const U2 = uuid(12); // manager at D1
const U3 = uuid(13); // salesperson at D2 only
const U4 = uuid(14); // signed in, in no dealership
const TOKEN = { u1: 'token-of-u1', u2: 'token-of-u2', u3: 'token-of-u3', u4: 'token-of-u4' };
const USERS = {
  [TOKEN.u1]: { id: U1, email: 'sam@example-motors.test' },
  [TOKEN.u2]: { id: U2, email: 'max@example-motors.test' },
  [TOKEN.u3]: { id: U3, email: 'kim@other-motors.test' },
  [TOKEN.u4]: { id: U4, email: 'new@example.test' },
};
const LISTING_COLUMNS = ['created_at', 'dealership_id', 'id', 'listed_before', 'listing_url', 'name', 'posted_at', 'price', 'salesperson', 'status', 'taken_down_at', 'updated_at', 'user_id', 'vin'];
const VIN = (n) => `TESTVIN0000000${String(n).padStart(3, '0')}`;
const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

// Two dealerships, their members, and whatever rows a test adds.
function world({ subscription = null, rows = {} } = {}) {
  fake.reset({
    users: USERS,
    rows: {
      dealerships: [{ id: D1, name: 'Example Motors', website_origin: ORIGIN }, { id: D2, name: 'Other Motors', website_origin: OTHER_ORIGIN }],
      memberships: [
        { user_id: U1, dealership_id: D1, role: 'salesperson', name: 'Sam' },
        { user_id: U2, dealership_id: D1, role: 'manager', name: 'Max' },
        { user_id: U3, dealership_id: D2, role: 'salesperson', name: 'Kim' },
      ],
      ...(subscription ? { subscriptions: [{ dealership_id: D1, ...subscription }] } : {}),
      ...rows,
    },
  });
}

const listing = (over) => ({ dealership_id: D1, user_id: U1, name: 'A car', price: 20000, posted_at: at(-3000), created_at: at(-3000), status: 'listed', ...over });
const sync = (handler, token, body = {}, extra = {}) => invoke(handler, { path: 'sync', token, body: { origin: ORIGIN, posted: {}, pilot: { posts: [], flags: [] }, scan: null, since: null, ...body }, ...extra });
const load = () => loadFunction('sync');

test('sync: the preflight answers the extension\'s origin; another method or route is 404 before any sign-in check', async () => {
  world();
  const handler = await load();
  const pre = await invoke(handler, { method: 'OPTIONS', path: 'sync', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  const page = await invoke(handler, { method: 'OPTIONS', path: 'sync', origin: 'https://some-page.example.test' });
  assert.equal(page.headers.get('access-control-allow-origin'), null, 'a page not in ALLOWED_ORIGINS gets no CORS header');
  for (const [method, path] of [['GET', 'sync'], ['POST', 'sync/other'], ['PUT', 'sync']]) {
    const r = await invoke(handler, { method, path, token: TOKEN.u1, body: method === 'GET' ? undefined : {} });
    assert.deepEqual([r.status, r.body], [404, { ok: false, error: 'not found' }], `${method} ${path}`);
  }
  assert.equal(fake.calls.length, 0);
});

test('sync: no token and a rejected token are 401; the token is checked with the auth server on a client that carries it', async () => {
  world();
  const handler = await load();
  const none = await sync(handler, '');
  assert.deepEqual([none.status, none.body], [401, { ok: false, error: 'sign in to use this (no token was sent)' }]);
  const basic = await invoke(handler, { path: 'sync', headers: { Authorization: 'Basic abc' }, body: {} });
  assert.equal(basic.status, 401);
  assert.equal(fake.calls.length, 0, 'no token, no call');
  const bad = await sync(handler, 'a-revoked-token');
  assert.deepEqual([bad.status, bad.body], [401, { ok: false, error: 'sign in again (the token was rejected or has expired)' }]);
  const [check] = fake.calls;
  assert.deepEqual([check.kind, check.op, check.jwt, check.key, check.token], ['auth', 'getUser', 'a-revoked-token', ANON_KEY, 'a-revoked-token']);
  assert.equal(fake.calls.length, 1, 'nothing read after the refusal');
  const unset = await loadFunction('sync', { SUPABASE_ANON_KEY: undefined });
  const r = await sync(unset, TOKEN.u1);
  assert.deepEqual([r.status, r.body.error], [500, 'the function is missing SUPABASE_URL or a publishable key (SUPABASE_PUBLISHABLE_KEYS or SUPABASE_ANON_KEY)']);
});

test('sync: a person in no dealership, or in another one, is 403; the origin is matched without case or a trailing slash; none is 400', async () => {
  world();
  const handler = await load();
  const stranger = await sync(handler, TOKEN.u4);
  assert.deepEqual([stranger.status, stranger.body], [403, { ok: false, error: 'your account is not in a dealership yet: redeem an invite code first' }]);
  const elsewhere = await sync(handler, TOKEN.u3);
  assert.deepEqual([elsewhere.status, elsewhere.body], [403, { ok: false, error: `your account is not a member of the dealership for ${ORIGIN}` }]);
  const missing = await sync(handler, TOKEN.u1, { origin: '  ' });
  assert.deepEqual([missing.status, missing.body], [400, { ok: false, error: 'origin is missing (the dealer website the registry belongs to)' }]);
  assert.equal(fake.writes().length, 0);
  const folded = await sync(handler, TOKEN.u1, { origin: 'HTTPS://WWW.Example-Motors.test/' });
  assert.equal(folded.status, 200);
  assert.equal(folded.body.dealership.websiteOrigin, ORIGIN);
});

test('sync: a lapsed plan is 402 with code lapsed and the plan, read with the caller\'s own client, and nothing is written', async () => {
  const handler = await load();
  world({ subscription: { status: 'canceled', stripe_subscription_id: 'sub_old', current_period_end: '2026-09-01T00:00:00Z', seats: 7 } });
  const car = { [VIN(1)]: { name: 'A car', price: 20000, postedAt: at(-60) } };
  const r = await sync(handler, TOKEN.u1, { posted: car, scan: { takenAt: at(-1), cars: 3, ready: 2 } });
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, { ok: false, error: LAPSED_MESSAGE, code: 'lapsed', plan: { state: 'lapsed', pilotEndsAt: null, currentPeriodEnd: '2026-09-01T00:00:00.000Z', seats: 7 } });
  assert.equal(r.body.error, EXTENSION_LAPSED_MESSAGE, 'the sentence the extension recognises');
  assert.equal(fake.writes().length, 0, 'nothing written');
  const [read] = fake.queries('subscriptions');
  assert.deepEqual([read.key, read.token, read.single], [ANON_KEY, TOKEN.u1, true], 'the row is read with the caller\'s own token, no service key');
  assert.equal(fake.queries('listings').length, 0, 'the registry is not even read');

  // a pilot that ran out unpaid is lapsed too, and says since when
  world({ subscription: { status: 'pilot', pilot_ends_at: '2026-09-20T12:00:00.5Z' } });
  const ended = await sync(handler, TOKEN.u1);
  assert.equal(ended.status, 402);
  assert.equal(ended.body.plan.pilotEndsAt, '2026-09-20T12:00:00.500Z');
  // a running pilot or no plan at all is served
  world({ subscription: { status: 'pilot', pilot_ends_at: at(60 * 24 * 10) } });
  assert.equal((await sync(handler, TOKEN.u1)).body.plan.state, 'pilot');
  world();
  assert.deepEqual((await sync(handler, TOKEN.u1)).body.plan, { state: 'none', pilotEndsAt: null, currentPeriodEnd: null, seats: null });
});

test('sync: the checks come in their order: the body before the membership, the membership before the plan, the plan before the row limits', async () => {
  world({ subscription: { status: 'canceled', stripe_subscription_id: 'sub_1' } });
  const handler = await load();
  assert.equal((await sync(handler, TOKEN.u4, {}, { raw: 'not JSON' })).status, 400, 'a stranger\'s bad body is a bad body');
  assert.equal((await sync(handler, TOKEN.u4, { origin: '' })).status, 400, 'and so is a missing origin');
  assert.equal((await sync(handler, TOKEN.u3)).status, 403, 'a member elsewhere, whatever the plan here');
  const flood = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [VIN(i), { postedAt: at(-60) }]));
  assert.equal((await sync(handler, TOKEN.u1, { posted: flood })).status, 402, 'a lapsed store hears about its plan first');
  assert.equal(fake.writes().length, 0);
});

test('sync: 12 calls a minute per user; the 13th is 429 before the body or the database are read, and other users are not held back', async () => {
  world();
  const handler = await load();
  for (let i = 0; i < 12; i += 1) assert.equal((await sync(handler, TOKEN.u1)).status, 200, `call ${i + 1}`);
  const before = fake.calls.length;
  const r = await sync(handler, TOKEN.u1, {}, { raw: 'not even JSON' });
  assert.deepEqual([r.status, r.body], [429, { ok: false, error: 'too many syncs; try again in a minute' }]);
  assert.deepEqual(fake.calls.slice(before).map((c) => c.op), ['getUser'], 'only the token was checked');
  assert.equal((await sync(handler, TOKEN.u2)).status, 200);
});

test('sync: a body over 512 KiB, bad JSON, or more than 2,000 listings, attempts or flags is 400 and nothing is written', async () => {
  world();
  const tooMany = 'too many entries in one request (at most 2000 listings, post attempts or to-do flags)';
  const cases = [
    [{ posted: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [VIN(i), { postedAt: at(-60) }])) }, tooMany],
    [{ pilot: { posts: Array.from({ length: 2001 }, (_, i) => ({ vin: VIN(i), startedAt: at(-60) })), flags: [] } }, tooMany],
    [{ pilot: { posts: [], flags: Array.from({ length: 2001 }, (_, i) => ({ vin: VIN(i), kind: 'price', flaggedAt: at(-60) })) } }, tooMany],
    [{ scan: { note: 'x'.repeat(512 * 1024) } }, 'request too large'],
  ];
  for (const [body, error] of cases) {
    const handler = await load();
    const r = await sync(handler, TOKEN.u1, body);
    assert.deepEqual([r.status, r.body], [400, { ok: false, error }]);
  }
  const handler = await load();
  // a small body declared too large is refused on the declaration, before it is read
  const declared = await sync(handler, TOKEN.u1, {}, { headers: { 'content-length': String(512 * 1024 + 1) }, raw: '{}' });
  assert.deepEqual([declared.status, declared.body.error], [400, 'request too large']);
  const notJson = await sync(handler, TOKEN.u1, {}, { raw: '{"origin":' });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /^bad JSON: /);
  assert.equal(fake.writes().length, 0);
  // exactly 2,000 of each is taken
  const full = await sync(handler, TOKEN.u1, { posted: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [VIN(i), { postedAt: at(-60 - i) }])) });
  assert.equal(full.status, 200);
  assert.equal(full.body.counts.listingsInserted, 2000);
});

test('sync: a first sync writes the registry, the attempts, the flags and the scan with the caller\'s token, and answers the documented shape', async () => {
  world();
  const handler = await load();
  const today = { from: at(-6 * 60), to: at(6 * 60) };
  const posted = {
    [VIN(1)]: { name: '2021 Example Sedan', price: 20986, postedAt: at(-30), listingUrl: 'https://www.facebook.com/marketplace/item/1/', salesperson: 'Sam' },
    [VIN(2).toLowerCase()]: { vin: VIN(2), name: '2020 Example Truck', price: '31500', postedAt: at(-20), listingUrl: 'http://not-https.example.test/' },
  };
  const pilot = {
    posts: [{ vin: VIN(1), name: '2021 Example Sedan', startedAt: at(-31), endedAt: at(-30), outcome: 'posted', seconds: 42, queue: false }],
    flags: [{ vin: VIN(3), kind: 'takeDown', name: 'Sold car', flaggedAt: at(-10) }],
  };
  const scan = { takenAt: at(-5), cars: 12, ready: 9, takeDownCount: 1, priceUpdateCount: 0 };
  const r = await sync(handler, TOKEN.u1, { origin: 'HTTPS://WWW.Example-Motors.test/', posted, pilot, scan, today });
  assert.equal(r.status, 200);
  const a = r.body;
  assert.deepEqual(keysOf(a), ['counts', 'dealership', 'listings', 'ok', 'plan', 'postsToday', 'role', 'serverTime', 'todoItems']);
  assert.equal(a.ok, true);
  assert.deepEqual(a.dealership, { id: D1, name: 'Example Motors', websiteOrigin: ORIGIN });
  assert.equal(a.role, 'salesperson');
  assert.deepEqual(keysOf(a.plan), ['currentPeriodEnd', 'pilotEndsAt', 'seats', 'state']);
  assert.equal(a.postsToday, 2);
  assert.deepEqual(a.counts, { listingsInserted: 2, listingsUpdated: 0, takenDown: 0, rejected: 0, conflicts: 0, attempts: 1, todoItems: 1, scans: 1 });
  assert.equal(a.listings.length, 2);
  for (const l of a.listings) assert.deepEqual(keysOf(l), LISTING_COLUMNS);
  assert.deepEqual(a.listings.map((l) => l.vin), [VIN(2), VIN(1)], 'newest post first');
  const two = a.listings[0];
  assert.deepEqual([two.user_id, two.dealership_id, two.price, two.listing_url, two.status], [U1, D1, 31500, null, 'listed'], 'a price given as text is a number; an http link is dropped');
  assert.equal(a.todoItems.length, 1);
  assert.match(a.serverTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const [attempt] = fake.rows('post_attempts');
  assert.deepEqual([attempt.user_id, attempt.vin, attempt.outcome, attempt.seconds], [U1, VIN(1), 'posted', 42]);
  const [flag] = fake.rows('todo_items');
  assert.deepEqual([flag.vin, flag.kind, flag.done_at], [VIN(3), 'takeDown', null]);
  const [scanRow] = fake.rows('scan_summaries');
  assert.equal(scanRow.website_origin, ORIGIN, 'the scan is stored under the dealership\'s own origin, not the text the request sent');
  for (const w of fake.writes()) assert.deepEqual([w.key, w.token], [ANON_KEY, TOKEN.u1], `${w.op} ${w.table} goes through the caller's token, so row-level security applies`);
  assert.ok(fake.clients.every((c) => c.key === ANON_KEY), 'no service-role client is made');

  // the same scan again is stored once
  const again = await sync(handler, TOKEN.u1, { posted, scan, since: a.serverTime });
  assert.deepEqual([again.body.counts.listingsInserted, again.body.counts.scans], [0, 1]);
  assert.equal(fake.rows('scan_summaries').length, 1);
});

test('sync: an upload never changes another member\'s row or a taken-down row, and a VIN a colleague has up is theirs until they take it down', async () => {
  const theirs = listing({ vin: VIN(1), user_id: U2, price: 20000, posted_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z' });
  const soldMine = listing({ vin: VIN(2), price: 25000, posted_at: '2026-09-02T10:00:00.000Z', status: 'taken_down', taken_down_at: '2026-09-10T10:00:00.000Z' });
  const upTheirs = listing({ vin: VIN(3), user_id: U2, posted_at: '2026-09-03T10:00:00.000Z' });
  world({ rows: { listings: [theirs, soldMine, upTheirs] } });
  const before = fake.rows('listings');
  const handler = await load();
  const newer = at(-1);
  const r = await sync(handler, TOKEN.u1, {
    posted: {
      [VIN(1)]: { price: 1, postedAt: theirs.posted_at, updatedAt: newer, listingUrl: 'https://www.facebook.com/marketplace/item/9/', salesperson: 'Sam' },
      [VIN(2)]: { price: 1, postedAt: soldMine.posted_at, updatedAt: newer },
      [VIN(3)]: { price: 30000, postedAt: at(-2) },
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.counts, { listingsInserted: 0, listingsUpdated: 0, takenDown: 0, rejected: 0, conflicts: 1, attempts: 0, todoItems: 0, scans: 0 });
  assert.deepEqual(fake.rows('listings'), before, 'every row as it was');
  assert.deepEqual(fake.writes('listings'), []);

  // once the colleague's row is down, the VIN is free to post again
  world({ rows: { listings: [{ ...upTheirs, status: 'taken_down', taken_down_at: at(-10) }] } });
  const freed = await sync(handler, TOKEN.u1, { posted: { [VIN(3)]: { price: 30000, postedAt: at(-2) } } });
  assert.deepEqual([freed.body.counts.listingsInserted, freed.body.counts.conflicts], [1, 0]);
});

test('sync: the caller\'s own row takes a newer price and stamp, and a link, name or salesperson it was missing; an older upload changes only what was missing', async () => {
  const mine = listing({ vin: VIN(1), price: 20000, posted_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z', name: null, listing_url: null, salesperson: null });
  world({ rows: { listings: [mine] } });
  const handler = await load();
  const older = await sync(handler, TOKEN.u1, { posted: { [VIN(1)]: { price: 1, postedAt: mine.posted_at, updatedAt: '2026-09-04T10:00:00.000Z', name: 'A car', salesperson: 'Sam' } } });
  assert.equal(older.body.counts.listingsUpdated, 1);
  let [row] = fake.rows('listings');
  assert.deepEqual([row.price, row.name, row.salesperson, row.listing_url], [20000, 'A car', 'Sam', null], 'the older price is not taken');
  const newer = await sync(handler, TOKEN.u1, { posted: { [VIN(1)]: { price: 19500, postedAt: mine.posted_at, updatedAt: '2026-09-06T10:00:00.000Z', listingUrl: 'https://www.facebook.com/marketplace/item/1/' } } });
  assert.equal(newer.body.counts.listingsUpdated, 1);
  [row] = fake.rows('listings');
  assert.deepEqual([row.price, row.updated_at, row.listing_url], [19500, pgTime('2026-09-06T10:00:00.000Z'), 'https://www.facebook.com/marketplace/item/1/']);
  const [update] = fake.writes('listings').slice(-1);
  assert.deepEqual([update.op, update.filters], ['update', [{ op: 'eq', column: 'id', value: row.id }]], 'one row, by its id');
  const same = await sync(handler, TOKEN.u1, { posted: { [VIN(1)]: { price: 19500, postedAt: mine.posted_at, updatedAt: '2026-09-06T10:00:00.000Z' } } });
  assert.equal(same.body.counts.listingsUpdated, 0, 'nothing new, nothing written');
});

test('sync: take-downs are the caller\'s listed rows in `known` and missing from the registry, whatever their times; without `known` nothing is taken down', async () => {
  const since = at(-60);
  const rows = [
    listing({ vin: VIN(1), posted_at: at(-3000), created_at: at(-3000) }), // known, gone from the registry: down
    listing({ vin: VIN(2), posted_at: at(-4000), created_at: at(-4000) }), // gone but never known here (another machine's post): kept
    listing({ vin: VIN(3), posted_at: at(-2000), created_at: at(-2000) }), // known, still in the registry: kept
    listing({ vin: VIN(4), user_id: U2, posted_at: at(-3000) }), // a colleague's: never the caller's to take down
    listing({ vin: VIN(5), posted_at: at(-1000), created_at: at(10) }), // known, gone, stamped after since by the database's clock: down all the same
    listing({ vin: VIN(6), posted_at: at(-3000), status: 'taken_down', taken_down_at: at(-2000) }), // already down: left as it was
    listing({ vin: VIN(7), posted_at: at(-500) }), // its VIN known under another posting time: another post, kept
    listing({ vin: VIN(8), posted_at: at(24 * 60) }), // known and still in the registry, though set aside as stamped in the future: kept
  ];
  world({ rows: { listings: rows } });
  const before = fake.rows('listings');
  const handler = await load();
  const registry = { [VIN(3)]: { price: 20000, postedAt: rows[2].posted_at }, [VIN(8)]: { price: 1, postedAt: rows[7].posted_at } };
  const known = [VIN(1), VIN(3), VIN(4), VIN(5), VIN(6), VIN(8)].map((v) => `${v}@${rows.find((r) => r.vin === v).posted_at}`).concat(`${VIN(7)}@${at(-400)}`);
  const r = await sync(handler, TOKEN.u1, { posted: registry, known, since });
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.takenDown, 2);
  assert.equal(r.body.counts.rejected, 1, 'the entry from the future was not written');
  const byVin = Object.fromEntries(fake.rows('listings').map((l) => [l.vin, l]));
  assert.deepEqual(Object.values(byVin).map((l) => [l.vin, l.status]), [[VIN(1), 'taken_down'], [VIN(2), 'listed'], [VIN(3), 'listed'], [VIN(4), 'listed'], [VIN(5), 'taken_down'], [VIN(6), 'taken_down'], [VIN(7), 'listed'], [VIN(8), 'listed']]);
  assert.ok(Date.parse(byVin[VIN(1)].taken_down_at) >= Date.parse(since), 'stamped now');
  assert.equal(byVin[VIN(6)].taken_down_at, before[5].taken_down_at, 'an old take-down keeps its time');
  const [lookup] = fake.queries('listings', 'select').filter((c) => c.filters.some((f) => f.column === 'user_id'));
  assert.deepEqual(lookup.filters.map((f) => [f.op, f.column]), [['eq', 'dealership_id'], ['eq', 'user_id'], ['eq', 'status'], ['in', 'vin']], 'only the caller\'s listed rows, only for the VINs of the keys to drop, and no time filter');
  // the answer carries the dealership's listed rows and the take-downs since `since`, less the margin
  assert.deepEqual(r.body.listings.map((l) => [l.vin, l.status]).sort(), [[VIN(1), 'taken_down'], [VIN(2), 'listed'], [VIN(3), 'listed'], [VIN(4), 'listed'], [VIN(5), 'taken_down'], [VIN(7), 'listed'], [VIN(8), 'listed']]);

  // no `known`, or one that is not a list, takes nothing down, `since` or not: a missed take-down
  // comes back in the registry and can be done again, a wrong one could not be undone
  for (const none of [undefined, null, 'a key', { [VIN(1)]: true }]) {
    world({ rows: { listings: rows } });
    const n = await sync(handler, TOKEN.u1, { posted: registry, since, known: none });
    assert.equal(n.body.counts.takenDown, 0, JSON.stringify(none));
    assert.deepEqual(fake.writes('listings'), []);
  }
});

test('sync: `known` holds at most 2,000 keys; a key is VIN@time, in any case, and anything else in the list is left out', async () => {
  world({ rows: { listings: [listing({ vin: VIN(1), posted_at: '2026-09-01T10:00:00.000Z' }), listing({ vin: VIN(2), posted_at: '2026-09-02T10:00:00.000Z' })] } });
  const handler = await load();
  const tooMany = await sync(handler, TOKEN.u1, { known: Array.from({ length: 2001 }, (_, i) => `${VIN(i)}@${at(-60)}`) });
  assert.deepEqual([tooMany.status, tooMany.body], [400, { ok: false, error: 'too many entries in one request (at most 2000 listings, post attempts or to-do flags)' }]);
  assert.equal(fake.writes().length, 0);
  const odd = [`${VIN(1).toLowerCase()}@2026-09-01T10:00:00+00:00`, `${VIN(2)}@not a time`, 'no key at all', 42, null, '@2026-09-02T10:00:00.000Z', `${VIN(2)}@2026-09-02T10:00:00.000Z${' '.repeat(80)}`];
  const r = await sync(handler, TOKEN.u1, { known: odd });
  assert.equal(r.body.counts.takenDown, 1);
  assert.deepEqual(fake.rows('listings').map((l) => [l.vin, l.status]), [[VIN(1), 'taken_down'], [VIN(2), 'listed']]);
  const full = await sync(handler, TOKEN.u1, { known: Array.from({ length: 2000 }, (_, i) => `${VIN(i)}@${at(-60)}`) });
  assert.equal(full.status, 200, 'exactly 2,000 is taken');
});

test('sync: dropping more than 100 known posts looks them up and takes them down 100 at a time', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => listing({ vin: VIN(i), posted_at: at(-100 - i) }));
  world({ rows: { listings: rows } });
  const handler = await load();
  const r = await sync(handler, TOKEN.u1, { known: rows.map((l) => `${l.vin}@${l.posted_at}`) });
  assert.equal(r.body.counts.takenDown, 150);
  assert.ok(fake.rows('listings').every((l) => l.status === 'taken_down'));
  const lookups = fake.queries('listings', 'select').filter((c) => c.filters.some((f) => f.column === 'user_id'));
  assert.deepEqual(lookups.map((c) => c.filters.find((f) => f.op === 'in').value.length), [100, 50]);
  assert.deepEqual(fake.writes('listings').map((w) => w.filters.find((f) => f.op === 'in').value.length), [100, 50]);
});

test('sync: take-downs and closed to-do items come back from 10 minutes before `since`, so one that committed after the last sync\'s reads still arrives', async () => {
  const since = at(-60);
  world({
    rows: {
      listings: [
        listing({ vin: VIN(1), user_id: U2, status: 'taken_down', taken_down_at: at(-55) }), // after since
        listing({ vin: VIN(2), user_id: U2, status: 'taken_down', taken_down_at: at(-65) }), // 5 minutes before: sent again
        listing({ vin: VIN(3), user_id: U2, status: 'taken_down', taken_down_at: at(-75) }), // 15 minutes before: the last sync had it
      ],
      todo_items: [
        { dealership_id: D1, vin: VIN(4), kind: 'takeDown', flagged_at: at(-200), done_at: at(-65), how: 'manual' },
        { dealership_id: D1, vin: VIN(5), kind: 'takeDown', flagged_at: at(-200), done_at: at(-75), how: 'manual' },
      ],
    },
  });
  const handler = await load();
  const r = await sync(handler, TOKEN.u1, { since });
  assert.deepEqual(r.body.listings.map((l) => l.vin).sort(), [VIN(1), VIN(2)]);
  assert.deepEqual(r.body.todoItems.map((t) => t.vin), [VIN(4)]);
  const cutoff = new Date(Date.parse(since) - 10 * 60 * 1000).toISOString();
  const down = fake.queries('listings', 'select').find((c) => c.filters.some((f) => f.value === 'taken_down'));
  assert.deepEqual(down.filters.find((f) => f.op === 'gte'), { op: 'gte', column: 'taken_down_at', value: cutoff });
  const closed = fake.queries('todo_items', 'select').find((c) => c.filters.some((f) => f.op === 'not.is'));
  assert.deepEqual(closed.filters.find((f) => f.op === 'gte'), { op: 'gte', column: 'done_at', value: cutoff });
  // a first sync gets the last 90 days
  world({ rows: { listings: [listing({ vin: VIN(1), user_id: U2, status: 'taken_down', taken_down_at: at(-89 * 24 * 60) }), listing({ vin: VIN(2), user_id: U2, status: 'taken_down', taken_down_at: at(-91 * 24 * 60) })] } });
  assert.deepEqual((await sync(handler, TOKEN.u1)).body.listings.map((l) => l.vin), [VIN(1)]);
});

test('sync: a listing stamped more than 5 minutes ahead of the server is not written and is counted; 4 minutes ahead is taken', async () => {
  world();
  const handler = await load();
  const r = await sync(handler, TOKEN.u1, { posted: { [VIN(1)]: { postedAt: at(10) }, [VIN(2)]: { postedAt: at(4) } } });
  assert.deepEqual([r.body.counts.rejected, r.body.counts.listingsInserted], [1, 1]);
  assert.deepEqual(fake.rows('listings').map((l) => l.vin), [VIN(2)]);
});

test('sync: postsToday counts the caller\'s own rows posted inside the day they sent, any status, after the upload; no usable day gives null', async () => {
  const today = { from: at(-6 * 60), to: at(6 * 60) };
  const hourAgo = at(-60);
  world({
    rows: {
      listings: [
        listing({ vin: VIN(1), posted_at: hourAgo }),
        listing({ vin: VIN(2), posted_at: at(-120), status: 'taken_down', taken_down_at: at(-30) }), // a post that day, taken down since
        listing({ vin: VIN(3), posted_at: at(-7 * 60) }), // before the day
        listing({ vin: VIN(4), posted_at: today.to }), // the day's end is not in it
        listing({ vin: VIN(5), user_id: U2, posted_at: at(-60) }), // a colleague's
      ],
    },
  });
  const handler = await load();
  const registry = { [VIN(1)]: { postedAt: hourAgo }, [VIN(6)]: { postedAt: at(-1) } };
  const r = await sync(handler, TOKEN.u1, { posted: registry, today });
  assert.equal(r.body.postsToday, 3, 'two already there and the one this call brought');
  const [count] = fake.queries('listings', 'select').filter((c) => c.head);
  assert.deepEqual([count.count, count.token], ['exact', TOKEN.u1]);
  for (const bad of [undefined, null, { from: today.from }, { from: today.to, to: today.from }, { from: at(-49 * 60), to: at(0) }, { from: 'yesterday', to: 'today' }]) {
    const n = await sync(handler, TOKEN.u1, { posted: registry, today: bad });
    assert.equal(n.body.postsToday, null, JSON.stringify(bad));
  }
});

// Listings the salesperson marked posted but had made by hand before that
// day (Mark posted, "Before today") are stored with listed_before and are
// not posts of that day: on a first day, a dozen of them used up the cap.
test('sync: a listing marked as made by hand before that day is stored as such and left out of postsToday; the flag never changes afterwards', async () => {
  const today = { from: at(-6 * 60), to: at(6 * 60) };
  const hourAgo = at(-60);
  world({ rows: { listings: [listing({ vin: VIN(1), posted_at: hourAgo, listed_before: false })] } });
  const handler = await load();
  const registry = { [VIN(1)]: { postedAt: hourAgo } };
  for (let i = 2; i < 14; i += 1) registry[VIN(i)] = { name: `Earlier ${i}`, price: 20000 + i, postedAt: at(-30 + i), listedBefore: true };
  const r = await sync(handler, TOKEN.u1, { posted: registry, today });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.listingsInserted, 12);
  assert.equal(r.body.postsToday, 1, 'the twelve earlier listings are not posts of today; the one posted today is');
  const rows = fake.rows('listings');
  assert.equal(rows.filter((l) => l.listed_before === true).length, 12);
  assert.equal(rows.find((l) => l.vin === VIN(1)).listed_before, false, 'a row without the flag is a post of its day');
  assert.ok(r.body.listings.filter((l) => l.listed_before === true).length === 12, 'the answer carries the flag, so other machines leave them out too');
  // a later upload of the same post cannot change it either way
  const again = await sync(handler, TOKEN.u1, { posted: { ...registry, [VIN(1)]: { postedAt: hourAgo, listedBefore: true, price: 1, updatedAt: at(-1) }, [VIN(2)]: { ...registry[VIN(2)], listedBefore: false, price: 2, updatedAt: at(-1) } }, today });
  assert.equal(again.body.postsToday, 1);
  assert.equal(fake.rows('listings').find((l) => l.vin === VIN(1)).listed_before, false);
  assert.equal(fake.rows('listings').find((l) => l.vin === VIN(2)).listed_before, true);
});

test('sync: to-do items: a new flag goes in, an upload closes an open one, a closed one is never reopened, an open price flag takes the new prices', async () => {
  const flags = [
    { dealership_id: D1, vin: VIN(1), kind: 'takeDown', flagged_at: '2026-09-20T10:00:00.000Z' },
    { dealership_id: D1, vin: VIN(2), kind: 'price', flagged_at: '2026-09-21T10:00:00.000Z', done_at: '2026-09-22T10:00:00.000Z', how: 'detected', from_price: 20000, to_price: 19000 },
    { dealership_id: D1, vin: VIN(3), kind: 'price', flagged_at: '2026-09-23T10:00:00.000Z', from_price: 30000, to_price: 29000 },
  ];
  world({ rows: { todo_items: flags } });
  const handler = await load();
  const r = await sync(handler, TOKEN.u1, {
    since: at(-60 * 24 * 30),
    pilot: {
      posts: [],
      flags: [
        { vin: VIN(1), kind: 'takeDown', flaggedAt: flags[0].flagged_at, doneAt: at(-5), how: 'manual' },
        { vin: VIN(2), kind: 'price', flaggedAt: flags[1].flagged_at, doneAt: null, from: 20000, to: 18000 },
        { vin: VIN(3), kind: 'price', flaggedAt: flags[2].flagged_at, from: 30000, to: 28500 },
        { vin: VIN(4), kind: 'price', flaggedAt: at(-3), from: 15000, to: 14500 },
        { vin: VIN(5), kind: 'nonsense', flaggedAt: at(-3) },
      ],
    },
  });
  assert.equal(r.body.counts.todoItems, 3);
  const byVin = Object.fromEntries(fake.rows('todo_items').map((t) => [t.vin, t]));
  assert.deepEqual([byVin[VIN(1)].how, Boolean(byVin[VIN(1)].done_at)], ['manual', true]);
  assert.deepEqual([byVin[VIN(2)].done_at, byVin[VIN(2)].to_price], [pgTime(flags[1].done_at), 19000], 'closed stays closed, prices and all');
  assert.equal(byVin[VIN(3)].to_price, 28500);
  assert.equal(byVin[VIN(4)].done_at, null);
  assert.equal(byVin[VIN(5)], undefined, 'an unknown kind is not stored');
  assert.deepEqual(r.body.todoItems.map((t) => t.vin).sort(), [VIN(1), VIN(2), VIN(3), VIN(4)]);
});

// The API answers at most 1,000 rows a request (the fake too: fake.maxRows),
// so a read that does not page loses rows without an error.
const ranges = (table, match) => fake.queries(table, 'select').filter((c) => c.columns === '*' && c.filters.some(match)).map((c) => c.range);

test('sync: every listed row and every page comes back past 1,000 rows; VINs are looked up 100 at a time and found again on the next upload', async () => {
  world({ rows: { listings: Array.from({ length: 1001 }, (_, i) => listing({ vin: `OTHER${String(i).padStart(12, '0')}`, user_id: U2 })) } });
  const handler = await load();
  const posted = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [VIN(i), { price: 1000 + i, postedAt: at(-100 - i) }]));
  const r = await sync(handler, TOKEN.u1, { posted });
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.listingsInserted, 150);
  assert.equal(r.body.listings.length, 1151);
  assert.deepEqual(ranges('listings', (f) => f.value === 'listed'), [[0, 999], [1000, 1999]], 'two pages of listed rows');
  const lookups = fake.queries('listings', 'select').filter((c) => c.filters.some((f) => f.op === 'in'));
  assert.deepEqual(lookups.map((c) => c.filters.find((f) => f.op === 'in').value.length), [100, 50]);
  const again = await sync(handler, TOKEN.u1, { posted });
  assert.deepEqual([again.status, again.body.counts.listingsInserted], [200, 0], 'every VIN was found, none inserted twice');
});

test('sync: take-downs, open and closed to-do items past 1,000 rows come back whole, page by page', async () => {
  const id = (prefix, i) => `${prefix}${String(i).padStart(13, '0')}`;
  const down = Array.from({ length: 1001 }, (_, i) => listing({ vin: id('DOWN', i), user_id: U2, status: 'taken_down', taken_down_at: at(-30) }));
  const open = Array.from({ length: 1001 }, (_, i) => ({ dealership_id: D1, vin: id('OPEN', i), kind: 'price', flagged_at: at(-30), from_price: 2, to_price: 1 }));
  const closed = Array.from({ length: 1001 }, (_, i) => ({ dealership_id: D1, vin: id('DONE', i), kind: 'takeDown', flagged_at: at(-40), done_at: at(-30), how: 'manual' }));
  world({ rows: { listings: down, todo_items: [...open, ...closed] } });
  const handler = await load();
  const r = await sync(handler, TOKEN.u1, { since: at(-35) });
  assert.equal(r.status, 200);
  assert.equal(r.body.listings.length, 1001);
  assert.equal(r.body.todoItems.length, 2002);
  assert.deepEqual(ranges('listings', (f) => f.value === 'taken_down'), [[0, 999], [1000, 1999]]);
  assert.deepEqual(ranges('todo_items', (f) => f.op === 'is'), [[0, 999], [1000, 1999]]);
  assert.deepEqual(ranges('todo_items', (f) => f.op === 'not.is'), [[0, 999], [1000, 1999]]);
});

test('sync: 100 VINs with more than 1,000 to-do rows between them are all found, so an upload of every flag adds none twice', async () => {
  // a car whose price the website moved week after week has a flag each time
  const flags = Array.from({ length: 1100 }, (_, i) => ({ vin: VIN(i % 100), kind: 'price', flaggedAt: at(-1000 - i), from: 2, to: 1 }));
  world({ rows: { todo_items: flags.map((f) => ({ dealership_id: D1, vin: f.vin, kind: f.kind, flagged_at: f.flaggedAt, from_price: 2, to_price: 1 })) } });
  const handler = await load();
  const r = await sync(handler, TOKEN.u1, { pilot: { posts: [], flags } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.counts.todoItems, 0, 'every flag was found and none changed');
  assert.equal(fake.rows('todo_items').length, 1100);
  const lookups = fake.queries('todo_items', 'select').filter((c) => c.filters.some((f) => f.op === 'in'));
  assert.deepEqual(lookups.map((c) => c.range), [[0, 999], [1000, 1999]], 'one chunk of 100 VINs, two pages');
});

test('sync: a refusal from row-level security (42501) is 403 with the reason; any other database error is 500', async () => {
  world();
  const handler = await load();
  const posted = { [VIN(1)]: { postedAt: at(-5) } };
  fake.script = (c) => (c.table === 'listings' && c.op === 'insert' ? { error: { message: 'new row violates row-level security policy for table "listings"', code: '42501' } } : undefined);
  const denied = await sync(handler, TOKEN.u1, { posted });
  assert.deepEqual([denied.status, denied.body], [403, { ok: false, error: 'not allowed: could not add listings: new row violates row-level security policy for table "listings"' }]);
  fake.script = (c) => (c.table === 'memberships' ? { error: { message: 'connection reset', code: '08006' } } : undefined);
  const down = await sync(handler, TOKEN.u1, { posted });
  assert.deepEqual([down.status, down.body], [500, { ok: false, error: 'could not read memberships: connection reset' }]);
});

// ---------- the extension against the handler ----------

// chrome.storage.local's shape, in memory.
function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

async function signedIn(token, userId) {
  const storage = memoryStorage();
  const session = sessionFromTokenResponse({ access_token: token, expires_in: 3600, refresh_token: 'refresh', user: { id: userId, email: USERS[token].email } }, Date.now());
  assert.equal(await storeSession(session, storage), true);
  return storage;
}

test('sync: the extension\'s syncOnce against the real handler: the registry goes up, a colleague\'s listing comes down marked theirs, and the state is kept', async () => {
  const now = Date.now();
  world({ rows: { listings: [listing({ vin: VIN(9), user_id: U2, name: 'Their car', posted_at: at(-100), salesperson: 'Max' })] } });
  const sync = await load();
  const config = { url: SUPABASE_URL, anonKey: ANON_KEY, functionsUrl: '' };
  const fetchImpl = functionsFetch({ sync });
  const K = siteKeys(ORIGIN);
  const storage = await signedIn(TOKEN.u1, U1);
  storage.data[K.posted] = { [VIN(1)]: { name: 'My car', price: 20000, postedAt: new Date(now).toISOString() }, [VIN(2)]: { name: 'Another', price: 25000, postedAt: at(-3 * 24 * 60) } };
  const r = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage, now } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.dealership, { id: D1, name: 'Example Motors', websiteOrigin: ORIGIN });
  assert.equal(r.counts.listingsInserted, 2);
  const registry = storage.data[K.posted];
  assert.deepEqual(Object.keys(registry).sort(), [VIN(1), VIN(2), VIN(9)]);
  assert.deepEqual([registry[VIN(9)].mine, registry[VIN(9)].userId], [false, U2], 'the colleague\'s car is theirs');
  const state = storage.data[K.sync];
  assert.equal(state.since, r.serverTime);
  assert.deepEqual([state.dealershipId, state.role, state.plan.state], [D1, 'salesperson', 'none']);
  assert.equal(state.postsToday.count, 1, 'the server counted the post made today');

  // the next round takes down what the registry dropped
  delete storage.data[K.posted][VIN(2)];
  const r2 = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage, now: Date.now() } });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.counts.takenDown, 1);
  assert.equal(fake.rows('listings').find((l) => l.vin === VIN(2)).status, 'taken_down');
});

test('sync: the extension reads the handler\'s 402, 403 and 401 the way it is written to: lapsed keeps the session, a stranger is told, a rejected token signs out', async () => {
  const config = { url: SUPABASE_URL, anonKey: ANON_KEY, functionsUrl: '' };
  const K = siteKeys(ORIGIN);
  world({ subscription: { status: 'past_due', stripe_subscription_id: 'sub_1' } });
  const sync = await load();
  const fetchImpl = functionsFetch({ sync });
  const storage = await signedIn(TOKEN.u1, U1);
  const lapsed = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage } });
  assert.deepEqual([lapsed.ok, lapsed.status, lapsed.code, lapsed.lapsed, lapsed.error], [false, 402, 'lapsed', true, LAPSED_MESSAGE]);
  assert.equal(storage.data[K.sync].plan.state, 'lapsed', 'the plan is kept for Settings');
  assert.ok(storage.data[ACCOUNT_KEY], 'still signed in');

  const stranger = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage: await signedIn(TOKEN.u4, U4) } });
  assert.deepEqual([stranger.ok, stranger.status, stranger.notMember], [false, 403, true]);
  assert.equal(stranger.error, 'your account is not in a dealership yet: redeem an invite code first');

  fake.users.delete(TOKEN.u1); // the auth server no longer knows the token
  const out = await syncOnce({ origin: ORIGIN, deps: { config, fetchImpl, storage } });
  assert.deepEqual([out.ok, out.status, out.signedOut], [false, 401, true]);
  assert.equal(storage.data[ACCOUNT_KEY], undefined, 'the session is gone');
});

test('sync: scripts/check-deploy.mjs reads its sync lines as ok against the real handler, the signed-in stranger\'s 403 included', async () => {
  world();
  const sync = await load();
  const findings = await runChecks({ fetchImpl: functionsFetch({ sync }), url: SUPABASE_URL, anonKey: ANON_KEY, testToken: TOKEN.u4 });
  const mine = findings.filter((f) => f.check.startsWith('sync:'));
  assert.deepEqual(mine.map((f) => f.check), ['sync: answers the extension\'s CORS preflight', 'sync: refuses a call with no user token', 'sync: a signed-in stranger gets 403']);
  for (const f of mine) assert.equal(f.ok, true, `${f.check}: ${f.detail}`);
});

// ---------- the fake itself ----------

// The fake database is only as good as its copy of the schema: every table
// it models has the migrations' columns, types, NOT NULLs and unique keys.
test('the fake database models the migrations\' tables: the same columns, types, NOT NULLs and unique keys', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const TYPES = { uuid: 'uuid', text: 'text', integer: 'int', timestamptz: 'ts', boolean: 'bool', numeric: 'num', bigserial: 'serial', bigint: 'serial', jsonb: 'json' };
  const keyText = (cols) => cols.map((c) => c.trim()).sort().join(',');
  for (const [table, spec] of Object.entries(MODELLED_TABLES)) {
    const m = new RegExp(`create table public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`).exec(sql);
    assert.ok(m, `the migrations create ${table}`);
    const columns = {};
    const keys = [];
    for (const raw of m[1].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
      if (!line) continue;
      const key = /^(?:constraint \w+ )?(?:primary key|unique) \(([^)]+)\)/.exec(line);
      if (key) keys.push(keyText(key[1].split(',')));
      if (key || /^(constraint|check)\b/.test(line)) continue;
      const [name, type] = line.split(/\s+/);
      const identity = /generated (always|by default) as identity/.test(line) || type === 'bigserial';
      columns[name] = TYPES[type.replace(/\(.*$/, '')] + (/not null|primary key/.test(line) || identity ? '!' : '');
      if (/\bprimary key\b|\bunique\b/.test(line)) keys.push(name);
    }
    // a column a later migration adds (alter table ... add column)
    for (const a of sql.matchAll(new RegExp(`^alter table public\\.${table} add column (?:if not exists )?(\\w+) (\\w+)([^;]*);`, 'gm'))) {
      columns[a[1]] = TYPES[a[2]] + (/not null/.test(a[3]) ? '!' : '');
    }
    assert.deepEqual(spec.columns, columns, `${table}: columns`);
    assert.deepEqual(spec.keys.map(keyText).sort(), keys.sort(), `${table}: unique keys`);
  }
});
