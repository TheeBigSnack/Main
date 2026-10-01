// The account flows the popup, the side panel and the service worker run
// (Milestone 4), with no UI: sign in with the emailed six-digit code, keep
// the session fresh, sign out, and one round of sync for one dealer website.
// Everything the network or chrome.storage is reached through is injected
// (deps: config, fetchImpl, storage, now), so the whole file runs in Node.
//
//   signInStart(email, deps)          -> the auth server emails a code
//   signInFinish(email, code, deps)   -> the code becomes a stored session
//   currentSession(deps)              -> the stored session, refreshed when due
//   signOutAll(deps)                  -> the token is revoked and forgotten
//   syncOnce({ origin, scan, deps })  -> POST .../sync, merge the answer
//   rewriteEndpointFor(config)        -> the rewrite function's address
//   rewriteKeyFor({ rewrite, session, config }) -> what goes in Authorization
//   planText(plan)                    -> one line about the dealership's plan
//
// With an empty config (src/accountConfig.js) every entry point answers
// { ok: false, notConfigured: true } without touching the network or storage,
// so an extension without accounts behaves as before.
//
// What a sync writes, all under the key's lock (src/storage.js): the merged
// registry to posted:<origin> (colleagues' entries marked `mine: false`, so
// the cap and the rescan flags stay the salesperson's own), closed flags to
// pilot:<origin>, and the state for the next call (since, the keys of the
// salesperson's own posts it sent or received, dealership, role, the plan,
// the server's count of today's posts) to sync:<origin>. The access token is
// only ever read from the session in chrome.storage.local; it is never
// copied into the settings or the synced profile.

import { ACCOUNT, accountsConfigured } from './accountConfig.js';
import { signInWithMagicLink, verifyOtp, ensureFreshSession, loadSession, storeSession, clearSession, signOut, authHeaders, errorText, DEFAULT_OTP_TYPE } from './account.js';
import { syncPayload, mergeRegistry, mergeFlags, nextSyncState, scanSummary, SYNC_VERSION } from './sync.js';
import { withPilotDefaults } from './pilot.js';
import { siteKeys } from './storageKeys.js';
import { updateKey, storageErrorText, withLock } from './storage.js';
import { DECISION } from './classify.js';

export const SYNC_TIMEOUT_MS = 20000;
export const NOT_CONFIGURED = 'Accounts are not set up yet (Milestone 4).';
export const NOT_SIGNED_IN = 'not signed in';

// The sync and rewrite functions' answer for a dealership whose plan has
// lapsed: HTTP 402 with this code and this sentence (lapsedAnswer in
// supabase/functions/_shared/billing.mjs). The sentence is the function's,
// repeated here so the side panel can tell that answer from any other
// failure of the rewrite service, and so Settings can say it after a sync.
export const LAPSED_CODE = 'lapsed';
export const LAPSED_MESSAGE = "the dealership's Lot Current subscription has lapsed: a manager can renew it, and the manager view's Billing card says how";
export const LAPSED_SENTENCE = LAPSED_MESSAGE[0].toUpperCase() + LAPSED_MESSAGE.slice(1);

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- addresses ----------

// Where the Edge Functions answer: the configured functionsUrl, else the
// project URL plus Supabase's own /functions/v1; '' with no project at all.
export function functionsUrlFor(config = ACCOUNT) {
  const c = config && typeof config === 'object' ? config : {};
  if (trimSlash(c.functionsUrl)) return trimSlash(c.functionsUrl);
  return trimSlash(c.url) ? trimSlash(c.url) + '/functions/v1' : '';
}

// The Settings value for the rewrite service once a person is signed in
// (src/rewriter.js appends /rewrite and /color to it).
export function rewriteEndpointFor(config = ACCOUNT) {
  const f = functionsUrlFor(config);
  return f ? f + '/rewrite' : '';
}

export function syncUrlFor(config = ACCOUNT) {
  const f = functionsUrlFor(config);
  return f ? f + '/sync' : '';
}

// ---------- the injected pieces ----------

function withDeps(deps = {}) {
  const chromeStorage = globalThis.chrome && globalThis.chrome.storage;
  return {
    config: deps.config || ACCOUNT,
    fetchImpl: deps.fetchImpl || globalThis.fetch,
    storage: deps.storage || (chromeStorage ? chromeStorage.local : null),
    now: typeof deps.now === 'number' ? deps.now : Date.now(),
    timeoutMs: deps.timeoutMs || SYNC_TIMEOUT_MS,
  };
}

const readKey = async (storage, key) => (await storage.get(key))[key];
const unreachable = (e) => `couldn't reach the account server (${(e && e.message) || e})`;

// ---------- signing in and out ----------

/**
 * Asks the auth server to email a sign-in code to this address. No
 * redirect is asked for, so the email's code is the way in (the template
 * carries {{ .Token }}, supabase/README.md step 3), and the request carries
 * a PKCE challenge nobody can answer, so the email's link brings no token
 * to the manager view it lands on (account.js unanswerableChallenge).
 * @returns {{ ok: true, email, message } | { ok: false, error, notConfigured? }}
 */
export async function signInStart(email, deps = {}) {
  const { config, fetchImpl } = withDeps(deps);
  if (!accountsConfigured(config)) return { ok: false, notConfigured: true, error: NOT_CONFIGURED };
  let r;
  try {
    r = await signInWithMagicLink(email, { url: config.url, anonKey: config.anonKey, fetchImpl });
  } catch (e) {
    return { ok: false, error: unreachable(e) };
  }
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, email: r.email, message: `A six-digit sign-in code is on its way to ${r.email}. Enter it below.` };
}

/**
 * The code from the email becomes a session, kept in chrome.storage.local
 * under `account` (never the sync area).
 * @returns {{ ok: true, session } | { ok: false, error }}
 */
export async function signInFinish(email, code, deps = {}) {
  const { config, fetchImpl, storage, now } = withDeps(deps);
  if (!accountsConfigured(config)) return { ok: false, notConfigured: true, error: NOT_CONFIGURED };
  let r;
  try {
    r = await verifyOtp(email, code, { url: config.url, anonKey: config.anonKey, type: DEFAULT_OTP_TYPE, fetchImpl, now });
  } catch (e) {
    return { ok: false, error: unreachable(e) };
  }
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  if (!(await storeSession(r.session, storage))) return { ok: false, error: "signed in, but the session couldn't be kept on this computer (Chrome's storage refused it)" };
  return { ok: true, session: r.session };
}

/**
 * The session to use right now: the stored one, refreshed and stored again
 * when it is about to expire, cleared when the refresh is rejected.
 * @returns {{ ok: true, session, refreshed } | { ok: false, error, signedOut?, notConfigured?, offline? }}
 */
export async function currentSession(deps = {}) {
  const { config, fetchImpl, storage, now } = withDeps(deps);
  if (!accountsConfigured(config)) return { ok: false, notConfigured: true, error: NOT_CONFIGURED };
  const session = await loadSession(storage);
  if (!session) return { ok: false, signedOut: true, error: NOT_SIGNED_IN };
  try {
    return await ensureFreshSession({ session, url: config.url, anonKey: config.anonKey, fetchImpl, storage, now });
  } catch (e) {
    return { ok: false, offline: true, error: unreachable(e) };
  }
}

/**
 * Revokes the token (best effort) and forgets the session. The sync state of
 * the websites named in deps.origins goes too, so the next sign-in starts
 * with a first sync, which takes nothing down.
 */
export async function signOutAll(deps = {}) {
  const { config, fetchImpl, storage } = withDeps(deps);
  const session = await loadSession(storage);
  await signOut(session, { url: config.url, anonKey: config.anonKey, fetchImpl, storage });
  const keys = (Array.isArray(deps.origins) ? deps.origins : []).filter(Boolean).map((o) => siteKeys(o).sync);
  if (keys.length && storage) {
    try {
      await storage.remove(keys);
    } catch {
      /* the session is gone; a stale sync state only makes the next sync a full one */
    }
  }
  return { ok: true };
}

// ---------- the rewrite service ----------

/**
 * What goes after "Bearer" when the panel calls the rewrite service: for the
 * account's own rewrite function, the signed-in session's access token, and
 * nothing when signed out (the key typed in Settings belongs to a
 * self-hosted service and is never sent to the account's function; the
 * function then answers 401 and the panel keeps its template); for any
 * other address, the key typed in Settings (a self-hosted backend/ keeps
 * working, signed in or not).
 */
export function rewriteKeyFor({ rewrite = {}, session = null, config = ACCOUNT } = {}) {
  const rw = rewrite && typeof rewrite === 'object' ? rewrite : {};
  const own = rewriteEndpointFor(config).toLowerCase();
  const endpoint = trimSlash(rw.endpoint).toLowerCase();
  if (own && endpoint === own) return session && session.accessToken ? String(session.accessToken) : '';
  return String(rw.key || '');
}

// ---------- sync ----------

// This scan's counts from what a scan leaves behind (the snapshot and the
// diff), for the sync function's scan summary; null when nothing was scanned.
export function scanFromStored({ snapshot = null, diff = null } = {}) {
  const takenAt = (diff && diff.takenAt) || (snapshot && snapshot.takenAt) || null;
  if (!takenAt) return null;
  const vehicles = snapshot && snapshot.vehicles && typeof snapshot.vehicles === 'object' ? Object.values(snapshot.vehicles) : [];
  const count = (list) => (Array.isArray(list) ? list.length : 0);
  return scanSummary({
    takenAt,
    cars: vehicles.length,
    ready: vehicles.filter((v) => v && v.decision === DECISION.READY).length,
    takeDownCount: count(diff && diff.takeDown),
    priceUpdateCount: count(diff && diff.priceUpdates),
  });
}

async function postJson(fetchImpl, url, body, headers, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    return { status: res.status, ok: res.ok, body: answer && typeof answer === 'object' ? answer : {} };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One round of sync for one dealer website: the salesperson's registry and
 * the pilot's changes go up, the dealership's registry comes down and is
 * merged into posted:<origin>, closed flags into pilot:<origin>, and the
 * state for the next call into sync:<origin>.
 * @param {object} args
 *   origin: the dealer website's origin
 *   scan:   this scan's counts ({ takenAt, cars, ready, takeDownCount, priceUpdateCount }),
 *           or null to send the counts of the stored scan
 *   deps:   { config, fetchImpl, storage, now, timeoutMs }
 * @returns {{ ok: true, serverTime, dealership: { id, name, websiteOrigin }, role, counts, listed, state }
 *   | { ok: false, error, code: 'lapsed', lapsed: true, plan, status: 402 }   (the plan is stored; the session stays)
 *   | { ok: false, error, signedOut?, notConfigured?, notMember?, status? }}
 */
export async function syncOnce({ origin = '', scan = null, deps = {} } = {}) {
  const { config, fetchImpl, storage, now, timeoutMs } = withDeps(deps);
  if (!accountsConfigured(config)) return { ok: false, notConfigured: true, error: NOT_CONFIGURED };
  const o = trimSlash(origin);
  if (!o) return { ok: false, error: "no website to sync: open your dealership's website first" };
  if (!storage) return { ok: false, error: 'no storage to sync from' };
  const s = await currentSession({ config, fetchImpl, storage, now });
  if (!s.ok) return { ok: false, signedOut: Boolean(s.signedOut), error: s.error };
  const session = s.session;
  const k = siteKeys(o);
  let posted;
  let pilot;
  let state;
  let summary;
  try {
    posted = (await readKey(storage, k.posted)) || {};
    pilot = await readKey(storage, k.pilot);
    state = (await readKey(storage, k.sync)) || null;
    summary = scanSummary(scan) || scanFromStored({ snapshot: await readKey(storage, k.snapshot), diff: await readKey(storage, k.diff) });
  } catch (e) {
    return { ok: false, error: storageErrorText(e) };
  }
  const since = state && state.since ? state.since : null;
  const userId = (session.user && session.user.id) || '';
  const body = syncPayload({ origin: o, posted, known: state && state.known, pilot, scan: summary, since, userId, now: new Date(now) }); // `today` is built from this clock
  // A clear while the request is out (Clear everything for this website)
  // removes the sync state, and a sync state missing when the answer comes
  // back is how that clear is seen: nothing the request carried is then
  // treated as known. A first sync has no state to remove, so it writes a
  // placeholder (pending, no since, nothing known) that a clear removes like
  // any state; a sync that fails removes it again, so a failure leaves the
  // website as it found it.
  let placeholder = false;
  if (!state) {
    try {
      placeholder = Boolean(await updateKey(k.sync, (prev) => (prev ? undefined : { version: SYNC_VERSION, since: null, known: [], pending: true }), storage));
    } catch (e) {
      return { ok: false, error: storageErrorText(e) };
    }
  }
  const dropPlaceholder = async () => {
    if (!placeholder) return;
    const drop = async () => {
      const current = await readKey(storage, k.sync);
      if (current && current.pending) await storage.remove(k.sync);
    };
    try {
      await (typeof storage.lock === 'function' ? storage.lock(k.sync, drop) : withLock(k.sync, drop));
    } catch {
      /* a placeholder left behind reads as no state: the next sync is a first sync */
    }
  };
  let res;
  try {
    res = await postJson(fetchImpl, syncUrlFor(config), body, authHeaders(session, config.anonKey), timeoutMs);
  } catch (e) {
    await dropPlaceholder();
    return { ok: false, error: `couldn't reach the sync service (${(e && e.message) || e})` };
  }
  const answer = res.body;
  if (!res.ok || !answer.ok) {
    const error = errorText(answer, res.status);
    if (res.status === 401) {
      await dropPlaceholder();
      await clearSession(storage); // the token was rejected outright: the person signs in again
      return { ok: false, status: 401, signedOut: true, error };
    }
    if (res.status === 402 || answer.code === LAPSED_CODE) {
      // The dealership's plan has lapsed: nothing was synced. The plan is
      // kept so Settings can say so; the session stays, since renewing is a
      // manager's job in the manager view, not a matter of signing in again.
      let plan = null;
      try {
        const next = await updateKey(k.sync, (prev) => (prev ? nextSyncState(prev, answer, { today: body.today }) : undefined), storage);
        plan = (next && next.plan) || null;
      } catch {
        /* the state could not be written; the answer still says what happened */
      }
      const lapsedError = typeof answer.error === 'string' && answer.error ? answer.error : LAPSED_MESSAGE;
      return { ok: false, status: res.status, code: LAPSED_CODE, lapsed: true, error: lapsedError, plan: plan || (answer.plan && typeof answer.plan === 'object' ? answer.plan : null) };
    }
    await dropPlaceholder();
    return { ok: false, status: res.status, notMember: res.status === 403, error };
  }
  let next;
  let held = null;
  try {
    // The registry as it is stored now, which the popup may have changed
    // while the request was out: an entry the request carried and Taken down
    // removed meanwhile is not put back from the answer (`sent`), and the
    // next sync takes it down. When the website's registry or its sync
    // state is gone (Clear everything for this website, or Sign out, while
    // the request was out), everything comes back from the server whole, as
    // after any clear, so a clear is never taken for a take-down.
    await updateKey(k.posted, async (current) => {
      const cleared = !current || !(await readKey(storage, k.sync));
      const merged = mergeRegistry(current || {}, answer, { since, userId, sent: cleared ? null : body.posted });
      held = merged;
      return same(merged, current || {}) ? undefined : merged;
    }, storage);
    await updateKey(k.pilot, (current) => {
      const before = withPilotDefaults(current);
      const merged = mergeFlags(before, answer);
      return same(merged, before) ? undefined : merged;
    }, storage);
    // A state gone by now means a clear landed after the merge: nothing is
    // written back, and the next sync is a first sync, which takes nothing
    // down and refills the registry from the server.
    next = await updateKey(k.sync, (prev) => (prev ? nextSyncState(prev, answer, { today: body.today, sent: body.posted, userId, held }) : undefined), storage);
  } catch (e) {
    return { ok: false, error: storageErrorText(e) };
  }
  const rows = Array.isArray(answer.listings) ? answer.listings : [];
  const d = answer.dealership && typeof answer.dealership === 'object' ? answer.dealership : {};
  return {
    ok: true,
    serverTime: answer.serverTime || null,
    dealership: { id: d.id || null, name: String(d.name || ''), websiteOrigin: String(d.websiteOrigin || '') },
    role: String(answer.role || ''),
    counts: answer.counts && typeof answer.counts === 'object' ? answer.counts : {},
    listed: rows.filter((r) => r && r.status === 'listed').length,
    state: next,
  };
}

// One sentence about a sync result, for the status line.
export function describeSync(r) {
  if (!r || typeof r !== 'object') return 'Sync failed: no answer.';
  if (r.ok) {
    const c = r.counts || {};
    const sent = (c.listingsInserted || 0) + (c.listingsUpdated || 0);
    const who = r.dealership && r.dealership.name ? ` with ${r.dealership.name}` : '';
    const role = r.role ? ` as ${r.role}` : '';
    const down = c.takenDown ? `, ${c.takenDown} taken down` : '';
    return `Synced${who}${role}: ${r.listed} listing${r.listed === 1 ? '' : 's'} shared, ${sent} of yours sent${down}.`;
  }
  if (r.notConfigured) return r.error || NOT_CONFIGURED;
  if (r.code === LAPSED_CODE || r.lapsed) return `Not synced: ${r.error || LAPSED_MESSAGE}.`;
  if (r.signedOut) return `Not synced: sign in first (${r.error || NOT_SIGNED_IN}).`;
  return `Sync failed: ${r.error || 'unknown error'}`;
}

// One line about the dealership's plan for the Account section, from the
// plan kept in sync:<origin> (src/sync.js planFrom); '' when none has been
// learned yet, since there is nothing to say before the first sync.
export function planText(plan, now = Date.now()) {
  if (!plan || typeof plan !== 'object') return '';
  if (plan.state === 'active') return 'Subscribed';
  if (plan.state === 'lapsed') return LAPSED_SENTENCE;
  if (plan.state === 'pilot') {
    const end = Date.parse(plan.pilotEndsAt);
    const at = new Date(now).getTime();
    if (Number.isNaN(end) || Number.isNaN(at)) return 'Free pilot';
    const days = Math.max(0, Math.ceil((end - at) / 86400000)); // a part of a day is still a day to use
    return `Free pilot: ${days} day${days === 1 ? '' : 's'} left`;
  }
  return 'No plan yet: a manager starts the free pilot in the manager view';
}
