// Accounts (Milestone 4): sign-in by an emailed code against the owner's
// Supabase project, with no UI of its own and without supabase-js. Every
// function takes the project's address and public key (src/accountConfig.js
// holds them, written by npm run set-project; nobody types them in), the
// fetch to call and the storage area to keep the session in, so the tests
// run in Node. The anon key is meant to be public; what the
// database lets a signed-in person see is decided by row-level security.
//
// The session (access token, refresh token, expiry, the user's id and email)
// lives in chrome.storage.local under `account` (GLOBAL_KEYS.account in
// src/storageKeys.js), never in sync storage: a token is for this computer
// only. No password is ever asked for or stored.
//
// Two ways the sign-in email can complete, both handled here:
//   - a 6-digit code typed into the extension: verifyOtp(email, code);
//   - a link to the extension's own page with ?token_hash=...&type=...,
//     or one that lands with #access_token=...: exchangeTokenFromUrl(url).

import { GLOBAL_KEYS } from './storageKeys.js';

export const ACCOUNT_KEY = GLOBAL_KEYS.account;
export const REFRESH_SKEW_MS = 60 * 1000; // refresh this long before the token expires
export const DEFAULT_OTP_TYPE = 'email';

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s) => EMAIL.test(String(s || '').trim());

function missingConfig({ url, anonKey }) {
  return trimSlash(url) && String(anonKey || '').trim() ? '' : 'the account server is not set up in this copy of Lot Current';
}

const jsonHeaders = (anonKey, extra = {}) => ({ 'Content-Type': 'application/json', apikey: String(anonKey || ''), ...extra });

async function call(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

// The auth server and the database API word their errors differently; this
// picks the sentence to show.
export function errorText(body, status = 0) {
  const b = body && typeof body === 'object' ? body : {};
  const text = b.msg || b.message || b.error_description || (typeof b.error === 'string' ? b.error : '') || '';
  if (text) return String(text);
  if (status === 401) return 'not signed in';
  if (status === 403) return 'not allowed';
  if (status === 429) return 'too many requests; wait a minute and try again';
  return status ? `the server answered ${status}` : 'no answer from the server';
}

// The claims inside a token, unverified: enough to show who is signed in.
// The server verifies every token it gets.
export function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// The session as it is stored, from the auth server's token answer.
export function sessionFromTokenResponse(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || !body.access_token) return null;
  const claims = decodeJwt(body.access_token) || {};
  const expiresAt =
    typeof body.expires_at === 'number' ? body.expires_at * 1000 :
    typeof body.expires_in === 'number' ? now + body.expires_in * 1000 :
    typeof claims.exp === 'number' ? claims.exp * 1000 :
    now + 3600 * 1000;
  const u = body.user && typeof body.user === 'object' ? body.user : {};
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token || ''),
    tokenType: 'bearer',
    expiresAt: new Date(expiresAt).toISOString(),
    user: { id: String(u.id || claims.sub || ''), email: String(u.email || claims.email || '') },
    signedInAt: new Date(now).toISOString(),
  };
}

// ---------- signing in ----------

// A PKCE challenge nobody can answer: 32 random bytes in base64url (43
// characters), sent as an S256 challenge whose verifier is never made, so no
// one holds a value that hashes to it. With it, the link in the sign-in
// email brings back only a one-time ?code= that no page can exchange,
// instead of #access_token=...&refresh_token=... in the address of the page
// it lands on (the project's Site URL, which is the manager view). The
// six-digit code the extension signs in with works the same either way.
export function unanswerableChallenge(randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let s = '';
  for (const b of randomBytes(32)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Asks the auth server to email a sign-in code (and link) to this address.
 * POST /auth/v1/otp. redirectTo, when given, is where the link lands; it
 * must be on the project's redirect allow-list, and that page takes the
 * #access_token the link brings (exchangeTokenFromUrl). Without one the link
 * lands on the project's Site URL (the manager view), which cannot sign the
 * extension in, so the request carries unanswerableChallenge() and the link
 * brings no token there: the code is the way in.
 */
export async function signInWithMagicLink(email, { url = '', anonKey = '', redirectTo = '', fetchImpl = globalThis.fetch } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!isEmail(e)) return { ok: false, error: 'enter a valid email address' };
  const missing = missingConfig({ url, anonKey });
  if (missing) return { ok: false, error: missing };
  const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
  const body = { email: e, create_user: true };
  if (!redirectTo) Object.assign(body, { code_challenge: unanswerableChallenge(), code_challenge_method: 's256' });
  const r = await call(fetchImpl, `${trimSlash(url)}/auth/v1/otp${query}`, {
    method: 'POST',
    headers: jsonHeaders(anonKey),
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, status: r.status, error: errorText(r.body, r.status) };
  return { ok: true, email: e };
}

// The 6-digit code from the sign-in email. POST /auth/v1/verify.
export async function verifyOtp(email, code, { url = '', anonKey = '', type = DEFAULT_OTP_TYPE, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const e = String(email || '').trim().toLowerCase();
  const token = String(code || '').replace(/\s+/g, '');
  if (!isEmail(e)) return { ok: false, error: 'enter a valid email address' };
  if (!token) return { ok: false, error: 'enter the code from the email' };
  const missing = missingConfig({ url, anonKey });
  if (missing) return { ok: false, error: missing };
  const r = await call(fetchImpl, `${trimSlash(url)}/auth/v1/verify`, {
    method: 'POST',
    headers: jsonHeaders(anonKey),
    body: JSON.stringify({ type, email: e, token }),
  });
  if (!r.ok) return { ok: false, status: r.status, error: errorText(r.body, r.status) };
  const session = sessionFromTokenResponse(r.body, now);
  return session ? { ok: true, session } : { ok: false, error: 'the server did not return a session' };
}

// A session from the #access_token=... fragment the auth server appends to
// the redirect address, or null when there is none.
export function sessionFromHash(input, now = Date.now()) {
  const s = String(input || '');
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
  const params = new URLSearchParams(hash);
  if (!params.get('access_token')) return null;
  const num = (k) => (params.get(k) !== null && params.get(k) !== '' && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : undefined);
  return sessionFromTokenResponse({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token') || '', expires_in: num('expires_in'), expires_at: num('expires_at') }, now);
}

/**
 * Turns the address the sign-in link landed on into a session: a
 * #access_token fragment needs no network; a ?token_hash=...&type=... query
 * (the email template's {{ .TokenHash }} link to the extension's own page)
 * is exchanged at POST /auth/v1/verify.
 */
export async function exchangeTokenFromUrl(pageUrl, { url = '', anonKey = '', fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const s = String(pageUrl || '');
  const fromHash = sessionFromHash(s, now);
  if (fromHash) return { ok: true, session: fromHash };
  let query = new URLSearchParams();
  try {
    query = new URL(s).searchParams;
  } catch {
    query = new URLSearchParams(s.includes('?') ? s.slice(s.indexOf('?') + 1).split('#')[0] : '');
  }
  const hashParams = new URLSearchParams(s.includes('#') ? s.slice(s.indexOf('#') + 1) : '');
  const failure = query.get('error_description') || hashParams.get('error_description') || query.get('error') || hashParams.get('error');
  if (failure) return { ok: false, error: failure };
  const tokenHash = query.get('token_hash');
  if (!tokenHash) return { ok: false, error: 'no sign-in token in this address' };
  const missing = missingConfig({ url, anonKey });
  if (missing) return { ok: false, error: missing };
  const r = await call(fetchImpl, `${trimSlash(url)}/auth/v1/verify`, {
    method: 'POST',
    headers: jsonHeaders(anonKey),
    body: JSON.stringify({ type: query.get('type') || DEFAULT_OTP_TYPE, token_hash: tokenHash }),
  });
  if (!r.ok) return { ok: false, status: r.status, error: errorText(r.body, r.status) };
  const session = sessionFromTokenResponse(r.body, now);
  return session ? { ok: true, session } : { ok: false, error: 'the server did not return a session' };
}

// ---------- keeping it fresh ----------

export function isExpired(session, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!session || !session.accessToken) return true;
  const t = Date.parse(session.expiresAt || '');
  return Number.isNaN(t) || t - skewMs <= now;
}

// POST /auth/v1/token?grant_type=refresh_token. A rejected refresh token
// means the person has to sign in again (signedOut: true).
export async function refreshSession(session, { url = '', anonKey = '', fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const missing = missingConfig({ url, anonKey });
  if (missing) return { ok: false, error: missing };
  if (!session || !session.refreshToken) return { ok: false, signedOut: true, error: 'not signed in' };
  const r = await call(fetchImpl, `${trimSlash(url)}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: jsonHeaders(anonKey),
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!r.ok) return { ok: false, status: r.status, signedOut: [400, 401, 403].includes(r.status), error: errorText(r.body, r.status) };
  const next = sessionFromTokenResponse(r.body, now);
  if (!next) return { ok: false, error: 'the server did not return a session' };
  if (!next.user.id && session.user) next.user = { ...session.user };
  return { ok: true, session: next };
}

// The session to use right now: the stored one, refreshed and stored again
// when it is about to expire; cleared when the refresh is rejected.
export async function ensureFreshSession({ session, url = '', anonKey = '', fetchImpl = globalThis.fetch, storage, now = Date.now() } = {}) {
  if (!session || !session.accessToken) return { ok: false, signedOut: true, error: 'not signed in' };
  if (!isExpired(session, now)) return { ok: true, session, refreshed: false };
  const r = await refreshSession(session, { url, anonKey, fetchImpl, now });
  if (r.ok) {
    await storeSession(r.session, storage);
    return { ok: true, session: r.session, refreshed: true };
  }
  if (r.signedOut) await clearSession(storage);
  return r;
}

// ---------- storage ----------

// chrome.storage.local only. An injected area (tests) is used as given; the
// synced area is refused so a token never follows a Chrome sign-in around.
function area(storage) {
  const chromeStorage = globalThis.chrome && globalThis.chrome.storage;
  if (storage) {
    if (chromeStorage && storage === chromeStorage.sync) return null;
    return storage;
  }
  return chromeStorage ? chromeStorage.local : null;
}

export async function storeSession(session, storage) {
  try {
    const a = area(storage);
    if (!a) return false;
    if (!session) {
      await a.remove(ACCOUNT_KEY);
      return true;
    }
    await a.set({ [ACCOUNT_KEY]: session });
    return true;
  } catch {
    return false;
  }
}

export async function loadSession(storage) {
  try {
    const a = area(storage);
    if (!a) return null;
    const got = await a.get(ACCOUNT_KEY);
    const s = got && got[ACCOUNT_KEY];
    return s && typeof s === 'object' && s.accessToken ? s : null;
  } catch {
    return null;
  }
}

export const clearSession = (storage) => storeSession(null, storage);

// ---------- talking to the project ----------

// Headers for the Edge Functions (the token) and the database API (the token
// plus the anon key, which the API gateway wants as apikey).
export function authHeaders(session, anonKey = '') {
  const h = {};
  if (session && session.accessToken) h.Authorization = `Bearer ${session.accessToken}`;
  if (anonKey) h.apikey = String(anonKey);
  return h;
}

async function rpc(fetchImpl, { url, anonKey, session }, name, args) {
  return call(fetchImpl, `${trimSlash(url)}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: jsonHeaders(anonKey, authHeaders(session)),
    body: JSON.stringify(args),
  });
}

/**
 * Joins the dealership an invite code is for (the redeem_invite function in
 * the database). Returns the membership the extension stores: the
 * dealership's id, name and website origin, and the role.
 */
export async function redeemInvite(code, name, { url = '', anonKey = '', session = null, fetchImpl = globalThis.fetch } = {}) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { ok: false, error: 'enter the invite code' };
  const missing = missingConfig({ url, anonKey });
  if (missing) return { ok: false, error: missing };
  if (!session || !session.accessToken) return { ok: false, status: 401, signedOut: true, error: 'sign in first' };
  const r = await rpc(fetchImpl, { url, anonKey, session }, 'redeem_invite', { code: c, display_name: String(name || '').trim() || null });
  if (!r.ok) return { ok: false, status: r.status, signedOut: r.status === 401, error: errorText(r.body, r.status) };
  const m = r.body && typeof r.body === 'object' ? r.body : {};
  return {
    ok: true,
    membership: {
      dealershipId: String(m.dealership_id || ''),
      dealershipName: String(m.dealership_name || ''),
      websiteOrigin: String(m.website_origin || ''),
      role: String(m.role || ''),
      name: String(m.name || ''),
    },
  };
}

// A manager gets a fresh single-use code for their dealership (create_invite).
export async function createInvite(dealershipId, role = 'salesperson', { url = '', anonKey = '', session = null, fetchImpl = globalThis.fetch } = {}) {
  const missing = missingConfig({ url, anonKey });
  if (missing) return { ok: false, error: missing };
  if (!session || !session.accessToken) return { ok: false, status: 401, signedOut: true, error: 'sign in first' };
  if (!dealershipId) return { ok: false, error: 'no dealership chosen' };
  const r = await rpc(fetchImpl, { url, anonKey, session }, 'create_invite', { dealership_id: dealershipId, role });
  if (!r.ok) return { ok: false, status: r.status, signedOut: r.status === 401, error: errorText(r.body, r.status) };
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  return { ok: true, code: String(b.code || ''), role: String(b.role || role) };
}

// Tells the auth server the token is done with (best effort) and forgets it
// here. scope=local ends this session alone: without it the auth server ends
// every session of the person's, so signing out of one browser would sign
// them out of the manager view and their extension on every other machine.
export async function signOut(session, { url = '', anonKey = '', fetchImpl = globalThis.fetch, storage } = {}) {
  if (session && session.accessToken && !missingConfig({ url, anonKey })) {
    try {
      await fetchImpl(`${trimSlash(url)}/auth/v1/logout?scope=local`, { method: 'POST', headers: jsonHeaders(anonKey, authHeaders(session)) });
    } catch {
      /* offline: the stored session goes anyway */
    }
  }
  await clearSession(storage);
  return { ok: true };
}
