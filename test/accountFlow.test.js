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
  rewriteKeyFor, scanFromStored, describeSync, planText, NOT_CONFIGURED, NOT_SIGNED_IN, LAPSED_CODE, LAPSED_MESSAGE, LAPSED_SENTENCE,
} from '../extension/src/accountFlow.js';
import { ACCOUNT, accountsConfigured } from '../extension/src/accountConfig.js';
import { sessionFromTokenResponse, ACCOUNT_KEY } from '../extension/src/account.js';
import { siteKeys, GLOBAL_KEYS } from '../extension/src/storageKeys.js';
import { markPosted, markTakenDown } from '../extension/src/rescan.js';
import { postsToday, capStatus } from '../extension/src/cap.js';
import { beginPost, endPost, noteFlags } from '../extension/src/pilot.js';
import { toServerRows, localDayRange, postKey } from '../extension/src/sync.js';

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
      if (keys === null || keys === undefined) return { ...data }; // everything, as chrome.storage answers get(null)
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

test('signInStart asks for a code by email (no redirect and a challenge nobody can answer: the code is the way in) and tells the person where it went', async () => {
  const { fetchImpl, calls } = fakeFetch({ otp: { status: 200, body: {} } });
  const r = await signInStart('  Alex@Example.test ', deps({ fetchImpl }));
  assert.deepEqual(r, { ok: true, email: 'alex@example.test', message: 'A six-digit sign-in code is on its way to alex@example.test. Enter it below.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/otp', 'no redirect_to: the email carries the code');
  assert.equal(calls[0].headers.apikey, CONFIG.anonKey);
  const { code_challenge: challenge, ...rest } = calls[0].body;
  assert.deepEqual(rest, { email: 'alex@example.test', create_user: true, code_challenge_method: 's256' });
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, 'a PKCE challenge nobody can answer: the email\'s link brings no token to the manager view');

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
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/logout?scope=local', 'this machine\'s session only, never the person\'s others');
  assert.equal(calls[0].headers.Authorization, `Bearer ${session.accessToken}`);
  assert.equal(ACCOUNT_KEY in storage.data, false);
  assert.equal(K.sync in storage.data, false, 'the next sign-in starts with a first sync');
  assert.ok(storage.data[K.posted], 'the posted list stays: it is the salesperson\'s own record');

  const offline = fakeStorage({ [ACCOUNT_KEY]: freshSession() });
  assert.deepEqual(await signOutAll(deps({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, storage: offline })), { ok: true });
  assert.equal(ACCOUNT_KEY in offline.data, false);
  assert.deepEqual(await signOutAll(deps({ fetchImpl, storage: fakeStorage() })), { ok: true }, 'nothing stored is fine too');
});

// Signing out from one website (or from a Facebook tab, which names none)
// must not leave another website showing the last account's dealership,
// role and plan, or counting its posts today in the daily cap.
test('signOutAll forgets every website\'s sync state on this computer, not only the website open, and nothing else', async () => {
  const OTHER = 'https://www.example-sister-store.test';
  const O = siteKeys(OTHER);
  const stored = () => ({
    [ACCOUNT_KEY]: freshSession(),
    [K.sync]: { since: T(1), dealershipName: 'Example Motors', role: 'manager', postsToday: 3 },
    [O.sync]: { since: T(2), dealershipName: 'Example Motors', role: 'manager', postsToday: 3, plan: { state: 'lapsed' } },
    [K.posted]: { [VIN_A]: { postedAt: T(0) } },
    [O.posted]: { [VIN_B]: { postedAt: T(0) } },
    [O.settings]: { dailyCap: 10 },
    [GLOBAL_KEYS.sites]: { [ORIGIN]: { name: 'Example Motors' } },
  });
  const { fetchImpl } = fakeFetch({ logout: { status: 204, body: null } });
  const left = (storage) => Object.keys(storage.data).sort();
  const kept = [K.posted, O.posted, O.settings, GLOBAL_KEYS.sites].sort();

  // the popup open on one website: the other website's state goes too
  const one = fakeStorage(stored());
  assert.deepEqual(await signOutAll(deps({ fetchImpl, storage: one, origins: [ORIGIN] })), { ok: true });
  assert.deepEqual(left(one), kept, 'both websites\' sync state and the session go; the posted lists, settings and registry stay');

  // the popup open on Facebook names no website: every website's state goes all the same
  const none = fakeStorage(stored());
  await signOutAll(deps({ fetchImpl, storage: none, origins: [] }));
  assert.deepEqual(left(none), kept);

  // where Chrome has getKeys(), it is used instead of reading everything
  const listed = fakeStorage(stored());
  let readAll = false;
  const get = listed.get;
  listed.get = async (keys) => { if (keys === null) readAll = true; return get(keys); };
  listed.getKeys = async () => Object.keys(listed.data);
  await signOutAll(deps({ fetchImpl, storage: listed }));
  assert.deepEqual(left(listed), kept);
  assert.equal(readAll, false, 'the key list is enough');

  // the keys cannot be listed: the website named still goes
  const blind = fakeStorage(stored());
  const blindGet = blind.get;
  blind.get = async (keys) => { if (keys === null) throw new Error('not available'); return blindGet(keys); };
  assert.deepEqual(await signOutAll(deps({ fetchImpl, storage: blind, origins: [ORIGIN] })), { ok: true });
  assert.equal(K.sync in blind.data, false);
  assert.equal(ACCOUNT_KEY in blind.data, false);
});

// The registry entry of each website also records the last sync (when it
// was tried, when it answered, its error, a retry due): the last account's,
// which the next account's Settings would otherwise show as its own, such as
// "the last attempt failed: your account is not a member of …".
test('signOutAll forgets the last account\'s sync times and error on every website\'s registry entry, and keeps the rest of it', async () => {
  const OTHER = 'https://www.example-sister-store.test';
  const { fetchImpl } = fakeFetch({ logout: { status: 204, body: null } });
  const storage = fakeStorage({
    [ACCOUNT_KEY]: freshSession(),
    [GLOBAL_KEYS.sites]: {
      [ORIGIN]: { name: 'Example Motors', auto: true, lastScan: T(0), lastSync: T(1), lastSyncAttempt: T(2), lastSyncError: `your account is not a member of the dealership for ${ORIGIN}`, lastSyncRetry: T(3) },
      [OTHER]: { name: 'Example Sister Store', auto: false, lastScan: T(0), lastSyncAttempt: T(2), lastSyncError: 'too many syncs; try again in a minute' },
    },
  });
  assert.deepEqual(await signOutAll(deps({ fetchImpl, storage, origins: [] })), { ok: true });
  assert.deepEqual(storage.data[GLOBAL_KEYS.sites], {
    [ORIGIN]: { name: 'Example Motors', auto: true, lastScan: T(0) },
    [OTHER]: { name: 'Example Sister Store', auto: false, lastScan: T(0) },
  }, 'the rescan settings and scan times stay');

  const untouched = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [GLOBAL_KEYS.sites]: { [ORIGIN]: { name: 'Example Motors' } } });
  await signOutAll(deps({ fetchImpl, storage: untouched }));
  assert.deepEqual(untouched.writes, [], 'a registry with no sync record is not rewritten');
});

// ---------- the rewrite service's key ----------

test('rewriteKeyFor: the session\'s token only for the account\'s own rewrite function, nothing there when signed out; the typed key for any other address', () => {
  const session = freshSession();
  const own = rewriteEndpointFor(CONFIG);
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own, key: 'typed' }, session, config: CONFIG }), session.accessToken);
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own.toUpperCase() + '/', key: '' }, session, config: CONFIG }), session.accessToken, 'case and a trailing slash do not matter');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: 'http://localhost:8787', key: 'shared-key' }, session, config: CONFIG }), 'shared-key', 'a self-hosted backend keeps its key');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: 'http://localhost:8787', key: 'shared-key' }, session: null, config: CONFIG }), 'shared-key', 'signed in or not');
  // the key typed for a self-hosted service stays in Settings after sign-in points the address at the account's
  // function; signed out (or with the session refused), it is never sent there (legal/privacy-policy.md: only to its own service)
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own, key: 'typed' }, session: null, config: CONFIG }), '', 'signed out: no key for the account\'s function');
  assert.equal(rewriteKeyFor({ rewrite: { endpoint: own + '/', key: 'typed' }, session: { accessToken: '' }, config: CONFIG }), '', 'a session with no token is no session');
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

test('scanFromStored sends no counts for a scan judged a website hiccup, from the worker or from storage', () => {
  // the hiccup scan read 8 of a 20-car lot; its snapshot was not saved
  const hiccup = { takenAt: T(9), vehicles: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`V${i}`, { decision: 'ready' }])) };
  const saved = { takenAt: T(0), vehicles: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`V${i}`, { decision: 'ready' }])) };
  const diff = { takenAt: T(9), unreliable: true, warnings: ['12 of 20 cars disappeared at once.'], takeDown: [], priceUpdates: [] };
  assert.equal(scanFromStored({ snapshot: hiccup, diff }), null, 'the worker\'s own scan: never the short count');
  assert.equal(scanFromStored({ snapshot: saved, diff }), null, 'the stored pair: never the old count under the hiccup\'s time');
  assert.equal(scanFromStored({ snapshot: saved, diff: { ...diff, unreliable: false } }).cars, 20);
});

// A small model of the sync function (supabase/functions/sync/index.ts):
// a lapsed plan is refused with 402 before anything else; the caller's rows
// are upserted; the caller's listed rows whose key is in `known` (the posts
// that machine sent or received at its last sync) and missing from the
// registry are taken down, no time compared; a to-do item is closed by an
// upload; and the dealership's whole current state comes back with the plan
// and the caller's posts in the day they sent. `onRequest(call)`, when set,
// runs while the request is out, before the model answers.
// `plan` overrides the default (a pilot with 30 days to run, the included 5
// seats); { state: 'lapsed' } makes every call answer 402 like the function.
function fakeSyncServer({ users = { [jwt({ sub: U1, email: USER.email, exp: Math.floor(NOW / 1000) + 3600 })]: U1 }, plan = null, onRequest = null } = {}) {
  const listings = [];
  const todoItems = [];
  const clock = { t: NOW + 60 * 60 * 1000 };
  const tick = () => new Date((clock.t += 1000)).toISOString();
  const requests = [];
  const thePlan = { state: 'pilot', pilotEndsAt: new Date(clock.t + 30 * 24 * 3600 * 1000).toISOString(), currentPeriodEnd: null, seats: 5, ...(plan || {}) };
  const handler = async (call) => {
    requests.push(call);
    if (onRequest) await onRequest(call);
    const m = /^Bearer (.+)$/.exec(call.headers.Authorization || '');
    const userId = m && users[m[1]];
    if (!userId) return { status: 401, body: { ok: false, error: 'sign in again (the token was rejected or has expired)' } };
    const body = call.body;
    if (body.origin !== ORIGIN) return { status: 403, body: { ok: false, error: `your account is not a member of the dealership for ${body.origin}` } };
    if (thePlan.state === 'lapsed') return { status: 402, body: { ok: false, error: "the dealership's Lot Current subscription has lapsed: a manager can renew it, and the manager view's Billing card says how", code: 'lapsed', plan: { ...thePlan } } };
    const now = tick();
    const rows = toServerRows({ origin: body.origin, posted: body.posted, pilot: body.pilot, dealershipId: D, userId });
    // a listing stamped more than five minutes ahead of the server's clock is rejected, not written
    const accepted = rows.listings.filter((r) => Date.parse(r.posted_at) <= clock.t + 5 * 60 * 1000);
    const counts = { listingsInserted: 0, listingsUpdated: 0, takenDown: 0, rejected: rows.listings.length - accepted.length, conflicts: 0, attempts: rows.postAttempts.length, todoItems: 0, scans: body.scan ? 1 : 0 };
    const sent = new Set(rows.listings.map((r) => postKey(r.vin, r.posted_at)));
    const known = new Set(Array.isArray(body.known) ? body.known : []);
    for (const r of listings) {
      const key = postKey(r.vin, r.posted_at);
      if (r.user_id === userId && r.status === 'listed' && known.has(key) && !sent.has(key)) {
        r.status = 'taken_down';
        r.taken_down_at = now;
        counts.takenDown += 1;
      }
    }
    const listedByOthers = new Set(listings.filter((r) => r.status === 'listed' && r.user_id !== userId).map((r) => r.vin));
    for (const incoming of accepted) {
      const have = listings.find((r) => r.vin === incoming.vin && r.posted_at === incoming.posted_at);
      if (!have) {
        if (listedByOthers.has(incoming.vin)) {
          counts.conflicts += 1; // a VIN another member has up is theirs until their row is taken down
          continue;
        }
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
    // the caller's own rows, any status, in the day the request sent; null
    // for no day or one that is not a day (the function's todayRange rule)
    const day = body.today && typeof body.today === 'object' ? [Date.parse(body.today.from), Date.parse(body.today.to)] : [NaN, NaN];
    const isDay = Number.isFinite(day[0]) && Number.isFinite(day[1]) && day[0] < day[1] && day[1] - day[0] <= 48 * 3600 * 1000;
    const postsToday = isDay ? listings.filter((r) => r.user_id === userId && Date.parse(r.posted_at) >= day[0] && Date.parse(r.posted_at) < day[1]).length : null;
    return { status: 200, body: { ok: true, serverTime: now, dealership: { id: D, name: 'Example Motors', websiteOrigin: ORIGIN }, role: 'salesperson', plan: { ...thePlan }, postsToday, counts, listings: listings.map((r) => ({ ...r })), todoItems: todoItems.map((t) => ({ ...t })) } };
  };
  return { listings, todoItems, requests, handler, plan: thePlan };
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
  assert.deepEqual(body.known, [], 'knowing nothing, it can take nothing down');
  const today = localDayRange(new Date(NOW));
  assert.deepEqual(body.today, today, 'the caller\'s local day goes up, for the server\'s count of their posts in it');
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
  // a post the function would not share is named, never passed over
  assert.equal(describeSync({ ...r, counts: { ...r.counts, conflicts: 1 } }), 'Synced with Example Motors as salesperson: 2 listings shared, 1 of yours sent. 1 of your posts was not shared with your dealership: a colleague already has that car listed (My listings shows which).');
  assert.equal(describeSync({ ...r, counts: { ...r.counts, conflicts: 2, rejected: 1 } }), "Synced with Example Motors as salesperson: 2 listings shared, 1 of yours sent. 2 of your posts were not shared with your dealership: a colleague already has those cars listed (My listings shows which). 1 of your posts was not shared with your dealership: its posting time is ahead of the server's clock, so check this computer's date and time.");
  // merged into storage
  const merged = storage.data[K.posted];
  assert.deepEqual(Object.keys(merged).sort(), [VIN_A, VIN_C].sort(), 'the colleague\'s Honda arrived');
  assert.equal(merged[VIN_C].salesperson, 'Sam');
  assert.equal(merged[VIN_C].userId, U2);
  assert.equal(merged[VIN_C].mine, false, 'a colleague\'s entry is marked as not this salesperson\'s');
  assert.equal(merged[VIN_C].listingUrl, 'https://www.facebook.com/marketplace/item/3/');
  assert.equal(merged[VIN_A].postedWith, 'lotsync', 'the local entry keeps what the server does not carry');
  assert.equal(merged[VIN_A].userId, U1, 'the server says whose it is');
  assert.equal('mine' in merged[VIN_A], false, 'an own entry carries no flag');
  assert.equal(postsToday(merged, new Date(T(2))), 1, 'the colleague\'s post does not count toward the cap');
  const flag = storage.data[K.pilot].flags[0];
  assert.equal(flag.doneAt, T(40), 'the flag closed on the colleague\'s machine is closed here');
  assert.equal(flag.how, 'detected');
  assert.deepEqual(storage.data[K.sync], { version: 1, since: r.serverTime, localSince: new Date(NOW).toISOString(), known: [postKey(VIN_A, T(0))], dealershipId: D, dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: r.serverTime, plan: server.plan, postsToday: { count: 1, ...today }, notShared: [] }, 'the plan and the server\'s count of today\'s posts (the Ram, counted after the upload) are kept for Settings and the cap; the Ram, sent, is known, the colleague\'s Honda is not; every post of the person\'s is shared');
  assert.equal(storage.data[ACCOUNT_KEY].accessToken, freshSession().accessToken, 'the session is untouched');

  // the second sync carries `since` and writes nothing that did not change;
  // the pilot entries stamped after the first sync began, by this machine's
  // clock (NOW), go up again: sending one twice changes nothing
  const writesBefore = storage.writes.length;
  const r2 = await syncOnce({ origin: ORIGIN, scan: { takenAt: T(50), cars: 2, ready: 1, takeDownCount: 0, priceUpdateCount: 0 }, deps: deps({ fetchImpl, storage, now: Date.parse(T(55)) }) });
  assert.equal(r2.ok, true);
  assert.equal(calls[1].body.since, r.serverTime);
  assert.deepEqual(calls[1].body.known, [postKey(VIN_A, T(0))], 'what the last sync sent goes up as known');
  assert.deepEqual([calls[1].body.pilot.posts.map((a) => a.vin), calls[1].body.pilot.flags.map((f) => f.vin)], [[VIN_A], [VIN_A]]);
  assert.equal(storage.data[K.sync].localSince, T(55));
  assert.deepEqual(calls[1].body.scan, { takenAt: T(50), cars: 2, ready: 1, takeDownCount: 0, priceUpdateCount: 0 }, 'the counts passed in win');
  assert.deepEqual(storage.writes.slice(writesBefore), [[K.sync]], 'only the state was written');
  assert.equal(r2.counts.listingsInserted, 0);
  assert.equal(server.listings.length, 2, 'the same post twice is one row');
  // the third sends only pilot changes after the second began, less the margin: none
  const r3 = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage, now: Date.parse(T(57)) }) });
  assert.equal(r3.ok, true);
  assert.deepEqual(calls[2].body.pilot, { posts: [], flags: [] }, 'nothing in the pilot changed since');
});

test('syncOnce: after a scan judged a website hiccup, no scan counts go up, so the manager keeps the last trusted scan', async () => {
  const server = fakeSyncServer();
  const { fetchImpl, calls } = fakeFetch({ sync: server.handler });
  const saved = { takenAt: T(0), vehicles: { [VIN_A]: { decision: 'ready' }, [VIN_B]: { decision: 'ready' } } };
  const hiccup = { takenAt: T(9), unreliable: true, warnings: ['That\'s usually a website hiccup'], takeDown: [], priceUpdates: [] };
  const storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.snapshot]: saved, [K.diff]: hiccup });
  const r = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls[0].body.scan, null);
  assert.equal(r.counts.scans, 0);
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
  const before2 = structuredClone(elsewhere.data);
  const r2 = await syncOnce({ origin: 'https://www.other-dealer.test', deps: deps({ fetchImpl, storage: elsewhere }) });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 403);
  assert.equal(r2.notMember, true);
  assert.match(r2.error, /not a member of the dealership for https:\/\/www\.other-dealer\.test/);
  assert.equal(ACCOUNT_KEY in elsewhere.data, true, 'not a member is not signed out');
  assert.deepEqual(elsewhere.data, before2, 'a refused sync leaves the storage as it found it (its first-sync placeholder removed)');
  assert.equal(describeSync(r2), `Sync failed: ${r2.error}`);

  // the server's brake (a dozen syncs a minute): a 429 with the server's own words, which the worker retries
  const busy = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl: fakeFetch({ sync: { status: 429, body: { ok: false, error: 'too many syncs; try again in a minute' } } }).fetchImpl, storage: fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted }) }) });
  assert.equal(busy.status, 429, 'the worker sets its retry from the status');
  assert.equal(describeSync(busy), 'Sync failed: too many syncs; try again in a minute');
  assert.equal(describeSync({ ...busy, retryAt: '2026-10-01T10:01:00.000Z' }), 'Sync failed: too many syncs; try again in a minute. Lot Current tries again on its own in a minute.');

  const offline = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  const before3 = structuredClone(offline.data);
  const r3 = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, storage: offline }) });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /couldn't reach the sync service \(Failed to fetch\)/);
  assert.deepEqual(offline.data, before3, 'a sync that never reached the service leaves the storage as it found it');
  assert.equal(K.sync in offline.data, false);

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
  // the cap stays per salesperson: each machine counts only its own person's posts
  assert.equal(postsToday(alex.data[K.posted], new Date(T(2))), 2);
  assert.equal(postsToday(sam.data[K.posted], new Date(T(2))), 1);
  assert.equal(sam.data[K.posted][VIN_A].mine, false);
  assert.equal('mine' in alex.data[K.posted][VIN_A], false);

  // Alex takes the Ram down (the popup's "Taken down" removes the entry); Sam's machine drops it on its next sync
  delete alex.data[K.posted][VIN_A];
  const r = await sync(alex);
  assert.equal(r.counts.takenDown, 1);
  assert.equal((await sync(sam)).ok, true);
  assert.equal(VIN_A in sam.data[K.posted], false);
  assert.deepEqual(prices(alex), prices(sam));
  assert.equal(server.listings.find((x) => x.vin === VIN_B).user_id, U1, 'Sam\'s sync never claims Alex\'s row');
});

// Round H review: the popup's Taken down writes posted:<origin> while a sync
// the worker or the side panel started is out; that sync's answer still
// lists the car, since the request carried it.
test('syncOnce: Taken down clicked while the request is out stays down, and the next sync takes it down on the server', async () => {
  let storage;
  let takeDown = false;
  const server = fakeSyncServer({
    onRequest: async () => {
      if (!takeDown) return;
      takeDown = false;
      storage.data[K.posted] = markTakenDown(storage.data[K.posted], VIN_A); // the popup's Taken down
    },
  });
  const { fetchImpl, calls } = fakeFetch({ sync: server.handler });
  const posted = markPosted(markPosted({}, { vin: VIN_A, name: '2019 Ram 1500', price: 28995 }, 'website', T(0)), { vin: VIN_B, name: '2020 Jeep', price: 34995 }, 'website', T(1));
  storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  assert.equal((await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) })).ok, true);
  takeDown = true;
  const during = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  assert.equal(during.ok, true, during.error);
  assert.equal(during.counts.takenDown, 0, 'the request carried the Ram, so it is still up on the server');
  assert.deepEqual(Object.keys(storage.data[K.posted]), [VIN_B], 'the answer does not put the Ram back');
  assert.ok(storage.data[K.sync].known.includes(postKey(VIN_A, T(0))), 'it was sent, so it is known');
  const next = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  assert.equal(next.counts.takenDown, 1);
  assert.equal(server.listings.find((x) => x.vin === VIN_A).status, 'taken_down');
  assert.deepEqual(Object.keys(storage.data[K.posted]), [VIN_B]);
  assert.equal(calls.length, 3);
});

test('syncOnce: Clear everything for this website while the request is out is no take-down: the registry comes back from the server whole', async () => {
  let storage;
  let duringRequest = null; // what the popup does while the request is out
  const server = fakeSyncServer({
    onRequest: async () => {
      const act = duringRequest;
      duringRequest = null;
      if (act) act();
    },
  });
  const { fetchImpl } = fakeFetch({ sync: server.handler });
  const sync = () => syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  const clearAll = () => {
    for (const key of Object.values(K)) delete storage.data[key]; // the popup's ownRemove of every key of the website
  };
  const posted = markPosted(markPosted({}, { vin: VIN_A, name: '2019 Ram 1500', price: 28995 }, 'website', T(0)), { vin: VIN_B, name: '2020 Jeep', price: 34995 }, 'website', T(1));
  storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  assert.equal((await sync()).ok, true);

  duringRequest = clearAll;
  assert.equal((await sync()).ok, true);
  assert.deepEqual(Object.keys(storage.data[K.posted]).sort(), [VIN_A, VIN_B], 'both cars are back, as after any clear and sync');
  assert.equal((await sync()).counts.takenDown, 0);

  // cleared, and a car marked posted right after, while the request is out: the sync state is gone, so it is a clear too
  duringRequest = () => {
    clearAll();
    storage.data[K.posted] = markPosted({}, { vin: VIN_C, name: '2018 Honda', price: 21495 }, 'website', T(2));
  };
  assert.equal((await sync()).ok, true);
  assert.deepEqual(Object.keys(storage.data[K.posted]).sort(), [VIN_A, VIN_B, VIN_C]);
  assert.equal((await sync()).counts.takenDown, 0);
  assert.deepEqual(server.listings.map((x) => [x.vin, x.status]), [[VIN_A, 'listed'], [VIN_B, 'listed'], [VIN_C, 'listed']]);
});

// ---------- the plan and the cap across machines (Milestone 5) ----------

test('syncOnce: a lapsed dealership (402) syncs nothing, keeps the session, stores the plan so Settings can say so, and describeSync says it in one sentence', async () => {
  const server = fakeSyncServer({ plan: { state: 'lapsed', pilotEndsAt: T(-60), currentPeriodEnd: null, seats: null } });
  const { fetchImpl, calls } = fakeFetch({ sync: server.handler });
  const posted = markPosted({}, { vin: VIN_A, name: '2019 Ram 1500', price: 28995 }, 'website', T(0));
  const before = { version: 1, since: T(1), dealershipId: D, dealershipName: 'Example Motors', role: 'salesperson', lastSyncAt: T(1), plan: { state: 'pilot', pilotEndsAt: T(2), currentPeriodEnd: null, seats: 5 }, postsToday: { count: 4, ...localDayRange(new Date(NOW)) } };
  const storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted, [K.sync]: before });
  const r = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
  assert.equal(r.code, LAPSED_CODE);
  assert.equal(r.lapsed, true);
  assert.equal(r.error, LAPSED_MESSAGE);
  assert.equal(r.plan.state, 'lapsed');
  assert.equal(r.signedOut, undefined);
  assert.equal(r.notMember, undefined);
  assert.equal(calls.length, 1);
  assert.equal(server.listings.length, 0, 'nothing was written on the server');
  assert.equal(ACCOUNT_KEY in storage.data, true, 'the session stays: renewing is a manager\'s job, not a sign-in');
  assert.deepEqual(storage.data[K.posted], posted, 'the registry is untouched');
  assert.deepEqual(storage.writes, [[K.sync]], 'only the sync state was written');
  const s = storage.data[K.sync];
  assert.equal(s.plan.state, 'lapsed');
  assert.equal(s.since, T(1), 'since is kept: nothing new was synced');
  assert.equal(s.lastSyncAt, T(1));
  assert.equal(s.postsToday, null, 'a 402 counted nothing, so no number lingers');
  assert.equal(s.dealershipName, 'Example Motors');
  assert.equal(describeSync(r), `Not synced: ${LAPSED_MESSAGE}.`);
  assert.equal(planText(s.plan), LAPSED_SENTENCE);
  // the cap falls back to this machine's count
  assert.equal(capStatus(storage.data[K.posted], 10, new Date(NOW), { serverCount: s.postsToday }).used, 1);
  // a machine that never synced this website gets the plan too, with nothing else invented
  const fresh = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  const r2 = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage: fresh }) });
  assert.equal(r2.code, LAPSED_CODE);
  assert.equal(fresh.data[K.sync].plan.state, 'lapsed');
  assert.equal(fresh.data[K.sync].since, null);
  assert.equal(ACCOUNT_KEY in fresh.data, true);
});

test('syncOnce: the server\'s count of today\'s posts comes down with the plan, and the cap takes the larger of it and this machine\'s count', async () => {
  const server = fakeSyncServer();
  const { fetchImpl, calls } = fakeFetch({ sync: server.handler });
  const today = localDayRange(new Date(NOW));
  // the showroom desktop already synced three of Alex's posts today
  for (const [vin, min] of [[VIN_A, 0], [VIN_B, 1], [VIN_C, 2]]) server.listings.push({ id: vin, dealership_id: D, user_id: U1, vin, name: `Car ${vin.slice(-2)}`, price: 20000, posted_at: T(min), listing_url: null, salesperson: 'Alex', updated_at: null, status: 'listed', taken_down_at: null, created_at: T(3) });
  // the laptop has one post of its own that the server has not seen
  const posted = markPosted({}, { vin: 'TESTVIN00000000D4', name: '2017 Ford', price: 15995 }, 'website', T(5));
  const storage = fakeStorage({ [ACCOUNT_KEY]: freshSession(), [K.posted]: posted });
  const r = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl, storage }) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(calls[0].body.today, today);
  const s = storage.data[K.sync];
  assert.deepEqual(s.plan, server.plan);
  assert.deepEqual(s.postsToday, { count: 4, ...today }, 'the four rows the server holds for Alex today, counted after the upload');
  assert.deepEqual(r.state, s);
  assert.match(planText(s.plan, NOW), /^Free pilot: 3[01] days left$/);
  // what the popup's cap does with it: after the merge the registry has all four as Alex's own
  const merged = storage.data[K.posted];
  assert.equal(postsToday(merged, new Date(NOW)), 4);
  assert.deepEqual(capStatus(merged, 5, new Date(NOW), { serverCount: s.postsToday }), { used: 4, cap: 5, remaining: 1, reached: false });
  // a machine holding fewer rows still gets the server's number, so the cap holds across Alex's machines
  assert.equal(postsToday(posted, new Date(NOW)), 1);
  assert.deepEqual(capStatus(posted, 5, new Date(NOW), { serverCount: s.postsToday }), { used: 4, cap: 5, remaining: 1, reached: false });
  assert.equal(capStatus(posted, 4, new Date(NOW), { serverCount: s.postsToday }).reached, true);
  // tomorrow the count is stale and only this machine's posts count
  const tomorrow = new Date(Date.parse(today.to) + 3600 * 1000);
  assert.equal(capStatus(merged, 5, tomorrow, { serverCount: s.postsToday }).used, postsToday(merged, tomorrow));
  // a colleague's posts never enter the count: Sam syncs and sees Alex's four, counted as none of Sam's
  const samToken = jwt({ sub: U2, email: 'sam@example.test', exp: Math.floor(NOW / 1000) + 3600 });
  const shared = fakeSyncServer({ users: { [samToken]: U2 } });
  shared.listings.push(...server.listings.map((row) => ({ ...row })));
  const samFetch = fakeFetch({ sync: shared.handler });
  const sam = fakeStorage({ [ACCOUNT_KEY]: sessionFromTokenResponse(tokenBody({ access_token: samToken, user: { id: U2, email: 'sam@example.test' } }), NOW), [K.posted]: {} });
  const rs = await syncOnce({ origin: ORIGIN, deps: deps({ fetchImpl: samFetch.fetchImpl, storage: sam }) });
  assert.equal(rs.ok, true, rs.error);
  assert.deepEqual(sam.data[K.sync].postsToday, { count: 0, ...today });
  assert.equal(Object.keys(sam.data[K.posted]).length, 4, 'Sam sees the dealership\'s listings');
  assert.deepEqual(capStatus(sam.data[K.posted], 5, new Date(NOW), { serverCount: sam.data[K.sync].postsToday }), { used: 0, cap: 5, remaining: 5, reached: false });
});

test('planText: one line per plan state for the Account section', () => {
  const day = 24 * 3600 * 1000;
  assert.equal(planText(null), '', 'nothing to say before the first sync');
  assert.equal(planText(undefined), '');
  assert.equal(planText({ state: 'none', pilotEndsAt: null, currentPeriodEnd: null, seats: null }), 'No plan yet: a manager starts the free pilot in the manager view');
  assert.equal(planText({ state: 'pilot', pilotEndsAt: new Date(NOW + 12 * day).toISOString(), currentPeriodEnd: null, seats: 5 }, NOW), 'Free pilot: 12 days left');
  assert.equal(planText({ state: 'pilot', pilotEndsAt: new Date(NOW + day / 2).toISOString() }, NOW), 'Free pilot: 1 day left', 'a part of a day is a day');
  assert.equal(planText({ state: 'pilot', pilotEndsAt: new Date(NOW - day).toISOString() }, NOW), 'Free pilot: 0 days left', 'never negative (the server would say lapsed anyway)');
  assert.equal(planText({ state: 'pilot', pilotEndsAt: null }, NOW), 'Free pilot');
  assert.equal(planText({ state: 'active', pilotEndsAt: null, currentPeriodEnd: new Date(NOW + 20 * day).toISOString(), seats: 5 }, NOW), 'Subscribed');
  assert.equal(planText({ state: 'lapsed' }), LAPSED_SENTENCE);
  assert.equal(LAPSED_SENTENCE, "The dealership's Lot Current subscription has lapsed: a manager can renew it, and the manager view's Billing card says how");
  assert.equal(LAPSED_MESSAGE, "the dealership's Lot Current subscription has lapsed: a manager can renew it, and the manager view's Billing card says how", 'the sentence the functions answer with (supabase/functions/_shared/billing.mjs)');
  assert.equal(LAPSED_CODE, 'lapsed');
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
  // the cap takes the server's count of today's posts from sync:<origin> wherever it is drawn or enforced (non-negotiable 7, across machines)
  for (const [rel, src] of [['../extension/popup.js', popup], ['../extension/sidepanel.js', panel]]) {
    assert.doesNotMatch(src, /capStatus\(state\.posted, state\.settings\??\.dailyCap\)/, `${rel}: every cap reading goes through dailyCap(), which passes the server count`);
    assert.equal((src.match(/capStatus\(/g) || []).length, 1, `${rel}: capStatus is called in one place only, the dailyCap() helper`);
    assert.ok((src.match(/dailyCap\(\)/g) || []).length >= 3, `${rel}: the cap readings call dailyCap()`);
    assert.match(src, /serverCount: state\.syncState && state\.syncState\.postsToday/, `${rel} passes the server count to the cap`);
  }
  assert.match(popup, /planText\(/, 'Settings shows the plan');
  assert.match(popup, /plan: \$\{state\.syncState && state\.syncState\.plan \? state\.syncState\.plan\.state : 'unknown'\}/, 'the problem report names the plan state');
  assert.match(panel, /r\.note\.includes\(LAPSED_MESSAGE\) \? `\$\{LAPSED_SENTENCE\}\. The template is shown instead\.`/, 'the panel turns the rewrite function\'s lapsed answer into its own sentence and falls back to the template');
  assert.equal(NOT_CONFIGURED, 'Accounts are not set up yet (Milestone 4).');
  assert.match(popup, /\$\{esc\(NOT_CONFIGURED\)\}/, 'the one line Settings shows with an empty config');
  for (const label of ['Send me a sign-in code', 'Sign in', 'Sync now', 'Sign out', 'Join a dealership with an invite code']) assert.ok(popup.includes(label), `Settings has "${label}"`);
  // the config file holds nothing but the three public values (the service key never belongs there; its comment may say so)
  const config = read('../extension/src/accountConfig.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(config, /service_role|serviceKey|eyJ[A-Za-z0-9_-]{20,}\.eyJ/, 'no service key and no token in src/accountConfig.js');
  assert.match(config, /export const ACCOUNT = Object\.freeze\(\{/);
});
