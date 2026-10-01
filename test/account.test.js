// Accounts (Milestone 4): magic-link sign-in helpers against a fake fetch
// and a fake storage area, happy paths and a 401.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signInWithMagicLink, unanswerableChallenge, verifyOtp, sessionFromHash, exchangeTokenFromUrl, refreshSession, ensureFreshSession, isExpired,
  storeSession, loadSession, clearSession, authHeaders, redeemInvite, createInvite, signOut, decodeJwt, sessionFromTokenResponse, errorText,
  ACCOUNT_KEY, REFRESH_SKEW_MS,
} from '../extension/src/account.js';

const URL_ = 'https://abcdefgh.supabase.co/';
const ANON = 'anon-key-for-tests';
const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const iso = (t) => new Date(t).toISOString();
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.sig`;
const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'alex@example.test' };
const TOKEN = jwt({ sub: USER.id, email: USER.email, exp: Math.floor(NOW / 1000) + 3600, role: 'authenticated' });
const tokenBody = (over = {}) => ({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(NOW / 1000) + 3600, refresh_token: 'refresh-1', user: USER, ...over });
const session = () => sessionFromTokenResponse(tokenBody(), NOW);

// A fetch that answers from a queue and records every call.
function fakeFetch(answers) {
  const calls = [];
  const queue = [...answers];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const a = queue.shift() || { status: 500, body: { message: 'no answer queued' } };
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => (a.body === undefined ? JSON.parse('') : a.body) };
  };
  return { fetchImpl, calls };
}

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(obj) { Object.assign(data, obj); },
    async remove(key) { delete data[key]; },
  };
}

test('signInWithMagicLink posts the email to /auth/v1/otp with the anon key (a redirect asked for: no challenge, that page takes the tokens); a bad address never leaves the browser', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: {} }]);
  const r = await signInWithMagicLink('  Alex@Example.test ', { url: URL_, anonKey: ANON, redirectTo: 'chrome-extension://abc/signin.html', fetchImpl });
  assert.deepEqual(r, { ok: true, email: 'alex@example.test' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/otp?redirect_to=chrome-extension%3A%2F%2Fabc%2Fsignin.html');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.apikey, ANON);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { email: 'alex@example.test', create_user: true });

  const none = fakeFetch([]);
  assert.match((await signInWithMagicLink('not an email', { url: URL_, anonKey: ANON, fetchImpl: none.fetchImpl })).error, /valid email/);
  assert.match((await signInWithMagicLink('a@b.co', { url: '', anonKey: '', fetchImpl: none.fetchImpl })).error, /not set up/);
  assert.equal(none.calls.length, 0);
});

test('signInWithMagicLink with no redirect sends a PKCE challenge nobody can answer, so the emailed link brings no token to the page it lands on', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);
  assert.deepEqual(await signInWithMagicLink('alex@example.test', { url: URL_, anonKey: ANON, fetchImpl }), { ok: true, email: 'alex@example.test' });
  await signInWithMagicLink('alex@example.test', { url: URL_, anonKey: ANON, fetchImpl });
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/otp', 'no redirect_to: the link lands on the Site URL, the manager view');
  const [a, b] = calls.map((c) => c.body);
  assert.deepEqual(Object.keys(a).sort(), ['code_challenge', 'code_challenge_method', 'create_user', 'email']);
  assert.equal(a.email, 'alex@example.test');
  assert.equal(a.create_user, true);
  assert.equal(a.code_challenge_method, 's256', 'S256: the challenge is a hash, and no verifier hashing to it exists');
  assert.match(a.code_challenge, /^[A-Za-z0-9_-]{43}$/, 'base64url, inside the 43 to 128 characters the auth server takes');
  assert.notEqual(a.code_challenge, b.code_challenge, 'a fresh one for every email');
  // 32 bytes, base64url without padding; the verifier is never made, so nothing is kept
  assert.equal(unanswerableChallenge(() => new Uint8Array(32).fill(255)), '_'.repeat(42) + '8');
  assert.equal(unanswerableChallenge(() => new Uint8Array(32)), 'A'.repeat(43));
});

test('signInWithMagicLink passes the server\'s own words back on a rate limit', async () => {
  const { fetchImpl } = fakeFetch([{ status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 60 seconds.' } }]);
  const r = await signInWithMagicLink('alex@example.test', { url: URL_, anonKey: ANON, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.match(r.error, /60 seconds/);
  assert.equal(errorText(null, 401), 'not signed in');
  assert.equal(errorText({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }, 400), 'Invalid Refresh Token');
});

test('verifyOtp exchanges the emailed code for a session', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: tokenBody() }]);
  const r = await verifyOtp('alex@example.test', '123 456', { url: URL_, anonKey: ANON, fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/verify');
  assert.deepEqual(calls[0].body, { type: 'email', email: 'alex@example.test', token: '123456' });
  assert.equal(r.session.accessToken, TOKEN);
  assert.equal(r.session.refreshToken, 'refresh-1');
  assert.deepEqual(r.session.user, USER);
  assert.equal(r.session.expiresAt, iso(NOW + 3600 * 1000));
  const bad = fakeFetch([{ status: 403, body: { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' } }]);
  assert.match((await verifyOtp('alex@example.test', '000000', { url: URL_, anonKey: ANON, fetchImpl: bad.fetchImpl })).error, /expired/);
});

test('sessionFromHash reads the fragment the auth server appends and finds the user in the token', () => {
  const s = sessionFromHash(`chrome-extension://abc/signin.html#access_token=${TOKEN}&expires_in=3600&refresh_token=refresh-2&token_type=bearer&type=magiclink`, NOW);
  assert.equal(s.accessToken, TOKEN);
  assert.equal(s.refreshToken, 'refresh-2');
  assert.equal(s.expiresAt, iso(NOW + 3600 * 1000));
  assert.deepEqual(s.user, USER);
  assert.equal(sessionFromHash('chrome-extension://abc/signin.html#type=magiclink'), null);
  assert.equal(sessionFromHash(''), null);
  assert.deepEqual(decodeJwt('garbage'), null);
});

test('exchangeTokenFromUrl: a fragment needs no network, a token_hash link is verified, a bare address is an error', async () => {
  const none = fakeFetch([]);
  const fromHash = await exchangeTokenFromUrl(`chrome-extension://abc/signin.html#access_token=${TOKEN}&refresh_token=r&expires_in=60`, { url: URL_, anonKey: ANON, fetchImpl: none.fetchImpl, now: NOW });
  assert.equal(fromHash.ok, true);
  assert.equal(none.calls.length, 0);

  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: tokenBody({ refresh_token: 'refresh-3' }) }]);
  const fromLink = await exchangeTokenFromUrl('chrome-extension://abc/signin.html?token_hash=pkce_abc123&type=magiclink', { url: URL_, anonKey: ANON, fetchImpl, now: NOW });
  assert.equal(fromLink.ok, true);
  assert.equal(fromLink.session.refreshToken, 'refresh-3');
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/verify');
  assert.deepEqual(calls[0].body, { type: 'magiclink', token_hash: 'pkce_abc123' });

  const expired = await exchangeTokenFromUrl('chrome-extension://abc/signin.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { fetchImpl: none.fetchImpl });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /invalid or has expired/);
  assert.match((await exchangeTokenFromUrl('chrome-extension://abc/signin.html', { fetchImpl: none.fetchImpl })).error, /no sign-in token/);
});

test('refreshSession: new tokens on success; a 401 means signed out', async () => {
  const fresh = jwt({ sub: USER.id, email: USER.email, exp: Math.floor(NOW / 1000) + 7200 });
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: tokenBody({ access_token: fresh, refresh_token: 'refresh-9', expires_in: 7200, expires_at: Math.floor(NOW / 1000) + 7200 }) }]);
  const r = await refreshSession(session(), { url: URL_, anonKey: ANON, fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/token?grant_type=refresh_token');
  assert.deepEqual(calls[0].body, { refresh_token: 'refresh-1' });
  assert.equal(r.session.accessToken, fresh);
  assert.equal(r.session.refreshToken, 'refresh-9');
  assert.equal(r.session.expiresAt, iso(NOW + 7200 * 1000));

  const denied = fakeFetch([{ status: 401, body: { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' } }]);
  const d = await refreshSession(session(), { url: URL_, anonKey: ANON, fetchImpl: denied.fetchImpl });
  assert.deepEqual(d, { ok: false, status: 401, signedOut: true, error: 'invalid JWT' });
  const nothing = await refreshSession(null, { url: URL_, anonKey: ANON, fetchImpl: denied.fetchImpl });
  assert.equal(nothing.signedOut, true);
});

test('the session is kept in local storage under `account`, never in sync storage', async () => {
  const local = fakeStorage();
  const s = session();
  assert.equal(await storeSession(s, local), true);
  assert.deepEqual(local.data, { [ACCOUNT_KEY]: s });
  assert.deepEqual(await loadSession(local), s);
  assert.equal(await clearSession(local), true);
  assert.equal(await loadSession(local), null);
  assert.deepEqual(local.data, {});
  // garbage in storage is not a session
  local.data[ACCOUNT_KEY] = { hello: 'there' };
  assert.equal(await loadSession(local), null);
  // a storage that throws is an absent session, not a crash
  const broken = { get: async () => { throw new Error('boom'); }, set: async () => { throw new Error('boom'); }, remove: async () => { throw new Error('boom'); } };
  assert.equal(await loadSession(broken), null);
  assert.equal(await storeSession(s, broken), false);
  // the synced area is refused
  const sync = fakeStorage();
  globalThis.chrome = { storage: { sync, local } };
  try {
    assert.equal(await storeSession(s, sync), false);
    assert.deepEqual(sync.data, {});
    assert.equal(await loadSession(sync), null);
    assert.equal(await storeSession(s), true, 'no area given: chrome.storage.local');
    assert.deepEqual(local.data[ACCOUNT_KEY], s);
  } finally {
    delete globalThis.chrome;
  }
});

test('authHeaders carries the token, and the anon key when the database API wants it', () => {
  const s = session();
  assert.deepEqual(authHeaders(s), { Authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authHeaders(s, ANON), { Authorization: `Bearer ${TOKEN}`, apikey: ANON });
  assert.deepEqual(authHeaders(null), {});
});

test('ensureFreshSession refreshes and stores a session about to expire, leaves a fresh one alone, clears one the server rejects', async () => {
  const local = fakeStorage();
  const s = session();
  assert.equal(isExpired(s, NOW), false);
  assert.equal(isExpired(s, NOW + 3600 * 1000 - REFRESH_SKEW_MS), true);
  assert.equal(isExpired(null), true);
  const untouched = await ensureFreshSession({ session: s, url: URL_, anonKey: ANON, fetchImpl: fakeFetch([]).fetchImpl, storage: local, now: NOW });
  assert.deepEqual(untouched, { ok: true, session: s, refreshed: false });

  const later = NOW + 3599 * 1000;
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: tokenBody({ refresh_token: 'refresh-2', expires_in: 3600, expires_at: Math.floor(later / 1000) + 3600 }) }]);
  const refreshed = await ensureFreshSession({ session: s, url: URL_, anonKey: ANON, fetchImpl, storage: local, now: later });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.refreshed, true);
  assert.equal(calls.length, 1);
  assert.equal(local.data[ACCOUNT_KEY].refreshToken, 'refresh-2');

  const denied = fakeFetch([{ status: 401, body: { msg: 'invalid JWT' } }]);
  const gone = await ensureFreshSession({ session: s, url: URL_, anonKey: ANON, fetchImpl: denied.fetchImpl, storage: local, now: later });
  assert.equal(gone.ok, false);
  assert.equal(gone.signedOut, true);
  assert.equal(await loadSession(local), null, 'a rejected refresh clears the stored session');
});

test('redeemInvite calls the redeem_invite function with the token and the anon key and returns the membership', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { dealership_id: 'd-1', dealership_name: 'Example Motors', website_origin: 'https://www.example-motors.test', role: 'salesperson', name: 'Alex' } }]);
  const r = await redeemInvite(' ab12cd34ef56 ', 'Alex', { url: URL_, anonKey: ANON, session: session(), fetchImpl });
  assert.deepEqual(r, { ok: true, membership: { dealershipId: 'd-1', dealershipName: 'Example Motors', websiteOrigin: 'https://www.example-motors.test', role: 'salesperson', name: 'Alex' } });
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/rest/v1/rpc/redeem_invite');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers.apikey, ANON);
  assert.deepEqual(calls[0].body, { code: 'AB12CD34EF56', display_name: 'Alex' });
});

test('redeemInvite: a 401 says to sign in again; the database\'s own message comes through; no code, no call', async () => {
  const denied = fakeFetch([{ status: 401, body: { message: 'JWT expired' } }]);
  const r = await redeemInvite('AB12CD34EF56', 'Alex', { url: URL_, anonKey: ANON, session: session(), fetchImpl: denied.fetchImpl });
  assert.deepEqual(r, { ok: false, status: 401, signedOut: true, error: 'JWT expired' });
  const used = fakeFetch([{ status: 400, body: { code: 'P0003', message: 'that invite code was already used', details: null, hint: null } }]);
  assert.match((await redeemInvite('AB12CD34EF56', '', { url: URL_, anonKey: ANON, session: session(), fetchImpl: used.fetchImpl })).error, /already used/);
  const none = fakeFetch([]);
  assert.match((await redeemInvite('', 'Alex', { url: URL_, anonKey: ANON, session: session(), fetchImpl: none.fetchImpl })).error, /enter the invite code/);
  const out = await redeemInvite('X', 'Alex', { url: URL_, anonKey: ANON, session: null, fetchImpl: none.fetchImpl });
  assert.equal(out.signedOut, true);
  assert.equal(none.calls.length, 0);
});

test('createInvite and signOut', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { code: 'AB12CD34EF56', dealership_id: 'd-1', role: 'salesperson' } }]);
  const r = await createInvite('d-1', 'salesperson', { url: URL_, anonKey: ANON, session: session(), fetchImpl });
  assert.deepEqual(r, { ok: true, code: 'AB12CD34EF56', role: 'salesperson' });
  assert.equal(calls[0].url, 'https://abcdefgh.supabase.co/rest/v1/rpc/create_invite');
  assert.deepEqual(calls[0].body, { dealership_id: 'd-1', role: 'salesperson' });
  const refused = fakeFetch([{ status: 403, body: { code: '42501', message: 'only a manager of this dealership can create invites' } }]);
  assert.match((await createInvite('d-1', 'manager', { url: URL_, anonKey: ANON, session: session(), fetchImpl: refused.fetchImpl })).error, /only a manager/);

  const local = fakeStorage();
  await storeSession(session(), local);
  const out = fakeFetch([{ status: 204, body: undefined }]);
  assert.deepEqual(await signOut(session(), { url: URL_, anonKey: ANON, fetchImpl: out.fetchImpl, storage: local }), { ok: true });
  assert.equal(out.calls[0].url, 'https://abcdefgh.supabase.co/auth/v1/logout');
  assert.equal(await loadSession(local), null);
  // offline: the stored session goes anyway
  await storeSession(session(), local);
  const offline = async () => { throw new Error('offline'); };
  await signOut(session(), { url: URL_, anonKey: ANON, fetchImpl: offline, storage: local });
  assert.equal(await loadSession(local), null);
});
