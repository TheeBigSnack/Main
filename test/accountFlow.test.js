// Accounts wired in (Milestone 4): the sign-in, session, sign-out and sync
// flows in src/accountFlow.js against a fake fetch, a fake chrome.storage
// area and a small model of the sync function; plus the guards that keep
// the extension inert while src/accountConfig.js is empty and the access
// token out of the settings and the synced profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  functionsUrlFor, rewriteEndpointFor, syncUrlFor, signInStart, signInFinish, currentSession, signOutAll, syncOnce,
  rewriteKeyFor, scanFromStored, describeSync, NOT_CONFIGURED, NOT_SIGNED_IN,
} from '../extension/src/accountFlow.js';
import { ACCOUNT, accountsConfigured } from '../extension/src/accountConfig.js';
import { sessionFromTokenResponse, ACCOUNT_KEY } from '../extension/src/account.js';
import { siteKeys, GLOBAL_KEYS } from '../extension/src/storageKeys.js';
import { markPosted } from '../extension/src/rescan.js';
import { beginPost, endPost, noteFlags } from '../extension/src/pilot.js';
import { toServerRows } from '../extension/src/sync.js';

const CONFIG = Object.freeze({ url: 'https://abcdefgh.supabase.co/', anonKey: 'anon-key-for-tests', functionsUrl: '' });
const ORIGIN = 'https://www.example-motors.test';
const K = siteKeys(ORIGIN);
const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const T = (min, sec = 0) => new Date(Date.UTC(2026, 10, 16, 9, min, sec)).toISOString();
const D = '00000000-0000-4000-8000-00000000000d';
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const VIN_A = 'TESTVIN00000000A1';
const VIN_B = 'TESTVIN00000000B2';
const VIN_C = 'TESTVIN00000000C3';

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.sig`;
const USER = { id: U1, email: 'alex@example.test' };
const tokenBody = (over = {}) => ({ access_token: jwt({ sub: U1, email: USER.email, exp: Math.floor(NOW / 1000) + 3600 }), token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-1', user: USER, ...over });
const freshSession = () => sessionFromTokenResponse(tokenBody(), NOW);
const expiredSession = () => sessionFromTokenResponse(tokenBody({ expires_in: 30 }), NOW); // inside the refresh skew

// A fetch that answers by route (the last path segment plus the query) and records every call.
function fakeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const route = u.pathname.replace(/\/+$/, '').split('/').pop() + u.search;
    const call = { url, route, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handler = routes[route] || routes[u.pathname.replace(/\/+$/, '').split('/').pop()];
    if (!handler) return { status: 404, ok: false, json: async () => ({ ok: false, error: `no route for ${route}` }) };
    if (typeof handler === 'function') {
      const a = await handler(call);
      return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
    }
    return { status: handler.status, ok: handler.status >= 200 && handler.status < 300, json: async () => handler.body };
  };
  return { fetchImpl, calls };
}

// chrome.storage.local's shape: get(key | keys) -> { key: value }, set(obj), remove(key | keys).
function fakeStorage(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map((k) => [k, data[k]]));
    },
    async set(obj) {
      writes.push(Object.keys(obj));
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

const deps = (over = {}) => ({ config: CONFIG, now: NOW, ...over });

// ---------- addresses ----------

test('the functions live under the project URL unless functionsUrl says otherwise; nothing without a project', () => {
  assert.equal(functionsUrlFor(CONFIG), 'https://abcdefgh.supabase.co/functions/v1');
  assert.equal(rewriteEndpointFor(CONFIG), 'https://abcdefgh.supabase.co/functions/v1/rewrite');
  assert.equal(syncUrlFor(CONFIG), 'https://abcdefgh.supabase.co/functions/v1/sync');
  const elsewhere = { ...CONFIG, functionsUrl: 'https://functions.example.test/v1/' };
  assert.equal(rewriteEndpointFor(elsewhere), 'https://functions.example.test/v1/rewrite');
  assert.equal(syncUrlFor(elsewhere), 'https://functions.example.test/v1/sync');
  assert.equal(functionsUrlFor({ url: '', anonKey: '', functionsUrl: '' }), '');
  assert.equal(rewriteEndpointFor({ url: '', anonKey: '' }), '');
  assert.equal(functionsUrlFor(null), '');
});

// ---------- an empty config stays inert ----------

test('with an empty config every flow answers notConfigured and nothing leaves the browser or touches storage', async () => {
  assert.equal(accountsConfigured({ url: '', anonKey: '' }), false);
  assert.equal(accountsConfigured({ url: 'https://x.supabase.co', anonKey: '' }), false);
  assert.equal(accountsConfigured(CONFIG), true);
  assert.ok(Object.isFrozen(ACCOUNT));
  assert.deepEqual(Object.keys(ACCOUNT), ['url', 'anonKey', 'functionsUrl']);
  const { fetchImpl, calls } = fakeFetch({});
  const storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: { [VIN_A]: { postedAt: T(0) } } });
  const empty = { config: { url: '', anonKey: '', functionsUrl: '' }, fetchImpl, storage, now: NOW };
  for (const r of [
    await signInStart('alex@example.test', empty),
    await signInFinish('alex@example.test', '123456', empty),
    await currentSession(empty),
    await syncOnce({ origin: ORIGIN, deps: empty }),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.notConfigured, true);
    assert.equal(r.error, NOT_CONFIGURED);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(storage.writes, []);
  assert.equal(describeSync(await syncOnce({ origin: ORIGIN, deps: empty })), NOT_CONFIGURED);
});

// ---------- signing in ----------

test('signInStart asks for a code by email (no redirect: the code is the way in) and tells the person where it went', async () => {
  const { fetchImpl, calls } = fakeFetch({ otp: { status: 200, body: {} } });
  const r = await signInStart('  Alex@Example.test ', deps({ fetchImpl }));
  assert.deepEqual(r, { ok: true, email: 'alex@example.test', message: 'A six-digit sign-in code is on its way to alex@example.test. Enter it below.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/otp', 'no redirect_to: the email carries the code');
  assert.equal(calls[0].headers.apikey, CONFIG.anonKey);
  assert.deepEqual(calls[0].body, { email: 'alex@example.test', create_user: true });

  const none = fakeFetch({});
  const bad = await signInStart('not an email', deps({ fetchImpl: none.fetchImpl }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /valid email/);
  assert.equal(none.calls.length, 0);

  const limited = fakeFetch({ otp: { status: 429, body: { msg: 'For security purposes, you can only request this after 60 seconds.' } } });
  const r2 = await signInStart('alex@example.test', deps({ fetchImpl: limited.fetchImpl }));
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 429);
  assert.match(r2.error, /60 seconds/);

  const offline = await signInStart('alex@example.test', deps({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }));
  assert.equal(offline.ok, false);
  assert.match(offline.error, /couldn't reach the account server \(Failed to fetch\)/);
});

test('signInFinish exchanges the code and keeps the session in local storage under `account`; a wrong code stores nothing', async () => {
  const { fetchImpl, calls } = fakeFetch({ verify: { status: 200, body: tokenBody() } });
  const storage = fakeStorage();
  const r = await signInFinish('alex@example.test', '123 456', deps({ fetchImpl, storage }));
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].body, { type: 'email', email: 'alex@example.test', token: '123456' });
  assert.equal(r.session.user.email, 'alex@example.test');
  assert.equal(storage.data[ACCOUNT_KEY].accessToken, r.session.accessToken);
  assert.equal(ACCOUNT_KEY, GLOBAL_KEYS.account);

  const wrong = fakeFetch({ verify: { status: 403, body: { msg: 'Token has expired or is invalid' } } });
  const empty = fakeStorage();
  const r2 = await signInFinish('alex@example.test', '000000', deps({ fetchImpl: wrong.fetchImpl, storage: empty }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /expired or is invalid/);
  assert.equal(ACCOUNT_KEY in empty.data, false);

  const nocode = await signInFinish('alex@example.test', '', deps({ fetchImpl: wrong.fetchImpl, storage: empty }));
  assert.match(nocode.error, /enter the code/);
  assert.equal(wrong.calls.length, 1);
});

test('currentSession: none stored is signed out; a fresh one needs no network; one about to expire is refreshed and stored; a rejected refresh clears it', async () => {
  const none = fakeFetch({});
  const r0 = await currentSession(deps({ fetchImpl: none.fetchImpl, storage: fakeStorage() }));
  assert.deepEqual(r0, { ok: false, signedOut: true, error: NOT_SIGNED_IN });

  const fresh = fakeStorage({ [ACCOUNT_KEY]: freshSession() });
  const r1 = await currentSession(deps({ fetchImpl: none.fetchImpl, storage: fresh }));
  assert.equal(r1.ok, true);
  assert.equal(r1.refreshed, false);
  assert.equal(none.calls.length, 0);

  const newToken = jwt({ sub: U1, email: USER.email, exp: Math.floor(NOW / 1000) + 7200 });
  const refreshing = fakeFetch({ 'token?grant_type=refresh_token': { status: 200, body: tokenBody({ access_token: newToken, refresh_token: 'refresh-2', expires_in: 7200 }) } });
  const stale = fakeStorage({ [ACCOUNT_KEY]: expiredSession() });
  const r2 = await currentSession(deps({ fetchImpl: refreshing.fetchImpl, storage: stale }));
  assert.equal(r2.ok, true);
  assert.equal(r2.refreshed, true);
  assert.equal(r2.session.accessToken, newToken);
  assert.equal(stale.data[ACCOUNT_KEY].refreshToken, 'refresh-2', 'the refreshed session is stored');
  assert.deepEqual(refreshing.calls[0].body, { refresh_token: 'refresh-1' });

  const rejected = fakeFetch({ 'token?grant_type=refresh_token': { status: 401, body: { error: 'invalid_grant', error_description: 'Invalid Refresh Token' } } });
  const gone = fakeStorage({ [ACCOUNT_KEY]: expiredSession() });
  const r3 = await currentSession(deps({ fetchImpl: rejected.fetchImpl, storage: gone }));
  assert.equal(r3.ok, false);
  assert.equal(r3.signedOut, true);
  assert.equal(ACCOUNT_KEY in gone.data, false, 'a rejected refresh token means signing in again');

  const offline = fakeStorage({ [ACCOUNT_KEY]: expiredSession() });
  const r4 = await currentSession(deps({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, storage: offline }));
  assert.equal(r4.ok, false);
  assert.equal(r4.offline, true);
  assert.equal(ACCOUNT_KEY in offline.data, true, 'being offline is not being signed out');
});

test('signOutAll tells the auth server, forgets the session and the named websites\' sync state, and works offline', async () => {
  const { fetchImpl, calls } = fakeFetch({ logout: { status: 204, body: null } });
  const session = freshSession();
  const storage = fakeStorage({ [ACCOUNT_KEY]: session, [K.sync]: { since: T(1), role: 'salesperson' }, [K.posted]: { [VIN_A]: { postedAt: T(0) } } });
  assert.deepEqual(await signOutAll(deps({ fetchImpl, storage, origins: [ORIGIN, ''] })), { ok: true });
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/logout');
  assert.equal(calls[0].headers.Authorization, `Bearer ${session.accessToken}`);
  assert.equal(ACCOUNT_KEY in storage.data, false);
  assert.equal(K.sync in storage.data, false, 'the next sign-in starts with a first sync');
  assert.ok(storage.data[K.posted], 'the posted list stays: it is the salesperson\'s own record');

  const offline = fakeStorage({ [ACCOUNT_KEY]: freshSession() });
  assert.deepEqual(await signOutAll(deps({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, storage: offline })), { ok: true });
  assert.equal(ACCOUNT_KEY in offline.data, false);
  assert.deepEqual(await signOutAll(deps({ fetchImpl, storage: fakeStorage() })), { ok: true }, 'nothing stored is fine too');
});

// ---------- the rewrite service's key ----------

test('rewriteKeyFor: the session\'s token only for the account\'s own rewrite function; the typed key for any other address', () => {
  const session = freshSession();
  const own = rewriteEndpointFor(CONFIG);
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own, key: 'typed' }, session, config: CONFIG }), session.accessToken);
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own.toUpperCase() + '/', key: '' }, session, config: CONFIG }), session.accessToken, 'case and a trailing slash do not matter');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: 'http://localhost:8787', key: 'shared-key' }, session, config: CONFIG }), 'shared-key', 'a self-hosted backend keeps its key');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own, key: 'typed' }, session: null, config: CONFIG }), 'typed', 'signed out: the typed key');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own, key: '' }, session: null, config: CONFIG }), '');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own, key: 'typed' }, session, config: { url: '', anonKey: '' } }), 'typed', 'no project: never the token');
  assert.equal(rewriteKeyFor(), '');
});

// ---------- sync ----------

test('scanFromStored turns the stored snapshot and diff into the sync function\'s scan counts', () => {
  const snapshot = { takenAt: T(0), vehicles: { A: { decision: 'ready' }, B: { decision: 'not-ready' }, C: { decision: 'ready' } } };
  const diff = { takenAt: T(1), takeDown: [{ vin: 'X' }], priceUpdates: [{ vin: 'Y' }, { vin: 'Z' }] };
  assert.deepEqual(scanFromStored({ snapshot, diff }), { takenAt: T(1), cars: 3, ready: 2, takeDownCount: 1, priceUpdateCount: 2 });
  assert.deepEqual(scanFromStored({ snapshot, diff: null }), { takenAt: T(0), cars: 3, ready: 2, takeDownCount: 0, priceUpdateCount: 0 });
  assert.equal(scanFromStored({ snapshot: null, diff: null }), null);
  assert.equal(scanFromStored(), null);
});

// A small model of the sync function (supabase/functions/sync/index.ts):
// the caller's rows are upserted, the caller's listed rows missing from the
// registry and posted before `since` are taken down, a to-do item is closed
// by an upload, and the dealership's whole current state comes back.
function fakeSyncServer({ users = { [jwt({ sub: U1, email: USER.email, exp: Math.floor(NOW / 1000) + 3600 })]: U1 } } = {}) {
  const listings = [];
  const todoItems = [];
  const clock = { t: NOW + 60 * 60 * 1000 };
  const tick = () => new Date((clock.t += 1000)).toISOString();
  const requests = [];
  const handler = async (call) => {
    requests.push(call);
    const m = /^Bearer (.+)$/.exec(call.headers.Authorization || '');
    const userId = m && users[m[1]];
    if (!userId) return { status: 401, body: { ok: false, error: 'sign in again (the token was rejected or has expired)' } };
    const body = call.body;
    if (body.origin !== ORIGIN) return { status: 403, body: { ok: false, error: `your account is not a member of the dealership for ${body.origin}` } };
    const now = tick();
    const rows = toServerRows({ origin: body.origin, posted: body.posted, pilot: body.pilot, dealershipId: D, userId });
    const counts = { listingsInserted: 0, listingsUpdated: 0, takenDown: 0, attempts: rows.postAttempts.length, todoItems: 0, scans: body.scan ? 1 : 0 };
    const sent = new Set(rows.listings.map((r) => `${r.vin}@${r.posted_at}`));
    for (const r of listings) {
      if (r.user_id === userId && r.status === 'listed' && !sent.has(`${r.vin}@${r.posted_at}`) && body.since && Date.parse(r.posted_at) <= Date.parse(body.since)) {
        r.status = 'taken_down';
        r.taken_down_at = now;
        counts.takenDown += 1;
      }
    }
    for (const incoming of rows.listings) {
      const have = listings.find((r) => r.vin === incoming.vin && r.posted_at === incoming.posted_at);
      if (!have) {
        listings.push({ id: `${incoming.vin}@${incoming.posted_at}`, ...incoming });
        counts.listingsInserted += 1;
        continue;
      }
      if (have.user_id !== userId || have.status !== 'listed') continue;
      if (Date.parse(incoming.updated_at || incoming.posted_at) > Date.parse(have.updated_at || have.posted_at)) {
        Object.assign(have, { price: incoming.price, updated_at: incoming.updated_at });
        counts.listingsUpdated += 1;
      }
    }
    for (const t of rows.todoItems) {
      const have = todoItems.find((x) => x.vin === t.vin && x.kind === t.kind && x.flagged_at === t.flagged_at);
      if (!have) todoItems.push({ ...t });
      else if (!have.done_at && t.done_at) Object.assign(have, { done_at: t.done_at, how: t.how });
      counts.todoItems += 1;
    }
    return { status: 200, body: { ok: true, serverTime: now, dealership: { id: D, name: 'Example Motors', websiteOrigin: ORIGIN }, role: 'salesperson', counts, listings: listings.map((r) => ({ ...r })), todoItems: todoItems.map((t) => ({ ...t })) } };
  };
  return { listings, todoItems, requests, handler };
}

test('syncOnce: signed out means no request; a first sync sends the whole registry without `since` and merges a colleague\'s listing, a closed flag and the state', async () => {
  const server = fakeSyncServer();
  // a colleague already synced the Honda, and closed a flag Alex still has open
  server.listings.push({ id: 'c', dealership_id: D, user_id: U2, vin: VIN_C, name: '2018 Honda', price: 21495, posted_at: T(2), listing_url: 'https://www.facebook.com/marketplace/item/3/', salesperson: 'Sam', updated_at: null, status: 'listed', taken_down_at: null });
  server.todoItems.push({ dealership_id: D, vin: VIN_A, kind: 'price', name: '2019 Ram 1500', flagged_at: T(10), done_at: T(40), how: 'detected', from_price: 28995, to_price: 27995 });
  const { fetchImpl, calls } = fakeFetch({ sync: server.handler });

  const signedOut = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage: fakeStorage() }) });
  assert.deepEqual(signedOut, { ok: false, signedOut: true, error: NOT_SIGNED_IN });
  assert.equal(calls.length, 0);
  assert.match(describeSync(signedOut), /sign in first/);

  const posted = markPosted({}, { vin: VIN_A, name: '2019 Ram 1500', price: 28995 }, 'website', T(0), { salesperson: 'Alex', postedWith: 'lotsync' });
  let pilot = beginPost(null, { vin: VIN_A, name: '2019 Ram 1500', salesperson: 'Alex', at: T(0) });
  pilot = endPost(pilot, VIN_A, 'posted', { at: T(1) });
  pilot = noteFlags(pilot, { takeDown: [], priceUpdates: [{ vin: VIN_A, name: '2019 Ram 1500', yours: true, from: 28995, to: 27995 }], warnings: [] }, { at: T(10) });
  const snapshot = { takenAt: T(5), vehicles: { [VIN_A]: { decision: 'ready' }, [VIN_B]: { decision: 'skip' } } };
  const diff = { takenAt: T(5), takeDown: [], priceUpdates: [{ vin: VIN_A }] };
  const storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted, [K.pilot]: pilot, [K.snapshot]: snapshot, [K.diff]: diff });

  const r = await syncOnce({ origin: ORIGIN + '/', deps: deps({ fetchImpl, storage }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/functions/v1/sync');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, `Bearer ${freshSession().accessToken}`);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  const body = calls[0].body;
  assert.equal(body.origin, ORIGIN, 'the trailing slash is dropped');
  assert.equal(body.since, null, 'a first sync');
  assert.deepEqual(Object.keys(body.posted), [VIN_A]);
  assert.deepEqual(body.posted[VIN_A], { name: '2019 Ram 1500', price: 28995, postedAt: T(0), salesperson: 'Alex' }, 'postedWith stays in the browser');
  assert.equal(body.pilot.posts.length, 1);
  assert.equal(body.pilot.flags.length, 1);
  assert.deepEqual(body.scan, { takenAt: T(5), cars: 2, ready: 1, takeDownCount: 0, priceUpdateCount: 1 }, 'the stored scan\'s counts when none are passed');
  // what came back
  assert.deepEqual(r.dealership, { id: D, name: 'Example Motors', websiteOrigin: ORIGIN });
  assert.equal(r.role, 'salesperson');
  assert.equal(r.counts.listingsInserted, 1);
  assert.equal(r.listed, 2);
  assert.equal(r.serverTime, r.state.since);
  assert.equal(describeSync(r), 'Synced with Example Motors as salesperson: 2 listings shared, 1 of yours sent.');
  // merged into storage
  const merged = storage.data[K.posted];
  assert.deepEqual(Object.keys(merged).sort(), [VIN_A, VIN_C].sort(), 'the colleague\'s Honda arrived');
  assert.equal(merged[VIN_C].salesperson, 'Sam');
  assert.equal(merged[VIN_C].userId, U2);
  assert.equal(merged[VIN_C].listingUrl, 'https://www.facebook.com/marketplace/item/3/');
  assert.equal(merged[VIN_A].postedWith, 'lotsync', 'the local entry keeps what the server does not carry');
  assert.equal(merged[VIN_A].userId, U1, 'the server says whose it is');
  const flag = storage.data[K.pilot].flags[0];
  assert.equal(flag.doneAt, T(40), 'the flag closed on the colleague\'s machine is closed here');
  assert.equal(flag.how, 'detected');
  assert.deepEqual(storage.data[K.sync], { version: 1, since: r.serverTime, dealershipId: D, dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: r.serverTime });
  assert.equal(storage.data[ACCOUNT_KEY].accessToken, freshSession().accessToken, 'the session is untouched');

  // the second sync carries `since`, sends only pilot changes after it, and writes nothing that did not change
  const writesBefore = storage.writes.length;
  const r2 = await syncOnce({ origin: ORIGIN, scan: { takenAt: T(50), cars: 2, ready: 1, takeDownCount: 0, priceUpdateCount: 0 }, deps: deps({ fetchImpl, storage }) });
  assert.equal(r2.ok, true);
  assert.equal(calls[1].body.since, r.serverTime);
  assert.deepEqual(calls[1].body.pilot, { posts: [], flags: [] }, 'nothing in the pilot changed since');
  assert.deepEqual(calls[1].body.scan, { takenAt: T(50), cars: 2, ready: 1, takeDownCount: 0, priceUpdateCount: 0 }, 'the counts passed in win');
  assert.deepEqual(storage.writes.slice(writesBefore), [[K.sync]], 'only the state was written');
  assert.equal(r2.counts.listingsInserted, 0);
  assert.equal(server.listings.length, 2, 'the same post twice is one row');
});

test('syncOnce: a token the function rejects signs the person out; not a member and a network failure write nothing', async () => {
  const server = fakeSyncServer();
  const { fetchImpl } = fakeFetch({ sync: server.handler });
  const posted = markPosted({}, { vin: VIN_A, name: '2019 Ram 1500', price: 28995 }, 'website', T(0));

  const stranger = fakeStorage({ [ACCOUNT_KEY]: sessionFromTokenResponse(tokenBody({ access_token: jwt({ sub: U2, exp: Math.floor(NOW / 1000) + 3600 }) }), NOW), [K.posted]: posted });
  const r1 = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage: stranger }) });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 401);
  assert.equal(r1.signedOut, true);
  assert.match(r1.error, /sign in again/);
  assert.equal(ACCOUNT_KEY in stranger.data, false, 'a rejected token is forgotten');
  assert.deepEqual(stranger.data[K.posted], posted);

  const elsewhere = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  const r2 = await syncOnce({ origin: 'https://www.other-dealer.test', deps: deps({ fetchImpl, storage: elsewhere }) });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 403);
  assert.equal(r2.notMember, true);
  assert.match(r2.error, /not a member of the dealership for https:\/\/www\.other-dealer\.test/);
  assert.equal(ACCOUNT_KEY in elsewhere.data, true, 'not a member is not signed out');
  assert.equal(elsewhere.writes.length, 0);
  assert.equal(describeSync(r2), `Sync failed: ${r2.error}`);

  const offline = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  const r3 = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, storage: offline }) });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /couldn't reach the sync service \(Failed to fetch\)/);
  assert.equal(offline.writes.length, 0);

  const noOrigin = await syncOnce({ origin: '', deps: deps({ fetchImpl, storage: offline }) });
  assert.equal(noOrigin.ok, false);
  assert.match(noOrigin.error, /no website to sync/);
});

test('syncOnce: two machines converge through the flows, and a take-down on one reaches the other', async () => {
  const alexToken = jwt({ sub: U1, email: USER.email, exp: Math.floor(NOW / 1000) + 3600 });
  const samToken = jwt({ sub: U2, email: 'sam@example.test', exp: Math.floor(NOW / 1000) + 3600 });
  const server = fakeSyncServer({ users: { [alexToken]: U1, [samToken]: U2 } });
  const { fetchImpl } = fakeFetch({ sync: server.handler });
  const sessionFor = (token, id, email) => sessionFromTokenResponse(tokenBody({ access_token: token, user: { id, email } }), NOW);
  const alex = fakeStorage({ [ACCOUNT_KEY]: sessionFor(alexToken, U1, USER.email), [K.posted]: markPosted(markPosted({}, { vin: VIN_A, name: '2019 Ram 1500', price: 28995 }, 'website', T(0), { salesperson: 'Alex' }), { vin: VIN_B, name: '2020 Jeep', price: 34995 }, 'website', T(1), { salesperson: 'Alex' }) });
  const sam = fakeStorage({ [ACCOUNT_KEY]: sessionFor(samToken, U2, 'sam@example.test'), [K.posted]: markPosted({}, { vin: VIN_C, name: '2018 Honda', price: 21495 }, 'website', T(2), { salesperson: 'Sam' }) });
  const sync = (storage) => syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  const prices = (storage) => Object.fromEntries(Object.entries(storage.data[K.posted]).map(([vin, e]) => [vin, e.price]));

  assert.equal((await sync(alex)).ok, true);
  assert.equal((await sync(sam)).ok, true);
  assert.deepEqual(Object.keys(sam.data[K.posted]).sort(), [VIN_A, VIN_B, VIN_C].sort());
  assert.equal((await sync(alex)).ok, true);
  assert.deepEqual(prices(alex), prices(sam));

  // Alex takes the Ram down (the popup's "Taken down" removes the entry); Sam's machine drops it on its next sync
  delete alex.data[K.posted][VIN_A];
  const r = await sync(alex);
  assert.equal(r.counts.takenDown, 1);
  assert.equal((await sync(sam)).ok, true);
  assert.equal(VIN_A in sam.data[K.posted], false);
  assert.deepEqual(prices(alex), prices(sam));
  assert.equal(server.listings.find((x) => x.vin === VIN_B).user_id, U1, 'Sam\'s sync never claims Alex\'s row');
});

// ---------- the wiring stays inert without a config, and the token stays where it is ----------

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the popup, the side panel and the worker gate every account call on accountsConfigured() and never handle the access token themselves', () => {
  for (const rel of ['../extension/popup.js', '../extension/sidepanel.js', '../extension/background.js']) {
    const src = read(rel);
    assert.match(src, /from '\.\/src\/accountConfig\.js'/, `${rel} imports the config`);
    assert.match(src, /accountsConfigured\(\)/, `${rel} checks the config before doing anything with accounts`);
    assert.doesNotMatch(src, /accessToken|refreshToken/, `${rel} must not touch the token: src/accountFlow.js reads it where it is used`);
  }
  // the token never enters the settings or the synced profile: the panel asks accountFlow for the key at call time
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /rewriteKeyFor\(/);
  assert.match(panel, /type: 'syncNow'/, 'a confirmed post asks the worker to sync');
  const worker = read('../extension/background.js');
  assert.match(worker, /msg\.type === 'syncNow'/);
  assert.match(worker, /lastSyncError/);
  const popup = read('../extension/popup.js');
  assert.equal(NOT_CONFIGURED, 'Accounts are not set up yet (Milestone 4).');
  assert.match(popup, /\$\{esc\(NOT_CONFIGURED\)\}/, 'the one line Settings shows with an empty config');
  for (const label of ['Send me a sign-in code', 'Sign in', 'Sync now', 'Sign out', 'Join a dealership with an invite code']) assert.ok(popup.includes(label), `Settings has "${label}"`);
  // the config file holds nothing but the three public values (the service key never belongs there; its comment may say so)
  const config = read('../extension/src/accountConfig.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(config, /service_role|serviceKey|eyJ[A-Za-z0-9_-]{20,}\.eyJ/, 'no service key and no token in src/accountConfig.js');
  assert.match(config, /export const ACCOUNT = Object\.freeze\(\{/);
});
