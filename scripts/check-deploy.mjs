#!/usr/bin/env node
// Lot Current deploy smoke test: run it once the Supabase project is deployed
// (supabase/README.md, "Check the deploy"). It looks at the live project from
// the outside, the way a browser or a stranger would, and prints a checklist:
//
//   - the three config files name the same project and anon key;
//   - with the anon key alone, every table reads as empty or refused (a 404
//     is a failure: the table is missing), and redeem_invite is refused;
//   - each function answers a CORS preflight from the extension, refuses a
//     call with no token (401), and the lead function refuses a page that is
//     not the landing page (403). The README deploys billing and lead after
//     step 6 (its Billing and Demo requests sections), so a 404 from either is
//     a note, not a failure, and so is the webhook's 500 that says
//     STRIPE_WEBHOOK_SECRET is not set yet; rerun it after those sections and
//     their lines read ok;
//   - with LOTSYNC_TEST_TOKEN (the access token of a signed-in test account
//     that belongs to no dealership), /sync answers 403, and eleven wrong
//     invite codes end in the throttle's P0005, which proves the misses are
//     counted on the real PostgREST (the one rule the local SQL test cannot).
//
//   LOTSYNC_URL=https://<ref>.supabase.co LOTSYNC_ANON_KEY=... node scripts/check-deploy.mjs
//   (both default to extension/src/accountConfig.js)
//   optional: LOTSYNC_TEST_TOKEN=<a non-member's access token>
//             LOTSYNC_SITE_ORIGIN=https://<where site/ is hosted>
//
// It reads and never writes: the only thing it changes is the test
// account's own invite-miss count (only with LOTSYNC_TEST_TOKEN). It keeps
// nothing and prints no key. Exit code 0 when nothing failed (notes do not
// fail the run).

import { pathToFileURL } from 'node:url';

// Every table the API could expose. With the anon key alone each must read as
// nothing: an empty list, or a refusal.
export const TABLES = Object.freeze([
  'dealerships', 'memberships', 'listings', 'todo_items', 'scan_summaries', 'post_attempts',
  'rewrite_usage', 'invites', 'invite_misses', 'subscriptions', 'billing_events', 'demo_requests', 'signup_settings', 'signup_attempts',
]);
export const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const FUNCTIONS = Object.freeze([
  { name: 'sync', method: 'POST', path: 'sync', body: {} },
  { name: 'rewrite', method: 'POST', path: 'rewrite/rewrite', body: {} },
  { name: 'billing', method: 'GET', path: 'billing/status', body: null },
]);

// The functions supabase/README.md deploys after step 6, and the section that
// deploys each. Until then the gateway answers 404, which is a note.
export const DEPLOYED_LATER = Object.freeze({
  billing: 'supabase/README.md, Billing',
  lead: 'supabase/README.md, Demo requests',
});

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

// What kind of API key a string is. Supabase's new keys are plain strings
// (sb_publishable_..., sb_secret_...); the legacy anon and service_role keys
// are JWTs whose payload names the role. Only a publishable or anon key may
// sit in a file a browser reads; a secret or service_role key there bypasses
// row-level security for anyone who opens the extension or the page.
export function keyKind(key) {
  const k = String(key || '').trim();
  if (!k) return 'none';
  if (k.startsWith('sb_publishable_')) return 'publishable';
  if (k.startsWith('sb_secret_')) return 'secret';
  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload && payload.role === 'anon') return 'anon';
      if (payload && payload.role === 'service_role') return 'service_role';
    } catch { /* not a JWT */ }
  }
  return 'unknown';
}
export const isBrowserSafeKey = (key) => ['publishable', 'anon'].includes(keyKind(key));

// The headers that call the API with a key and no user. A publishable key
// goes on apikey only: the platform reads anything after Bearer as a JWT and
// would answer 401 "Invalid JWT", which every "anon reads nothing" line would
// then count as a pass for the wrong reason. A legacy anon key is a JWT and
// goes on both, as supabase-js sends it.
export function keyHeaders(key) {
  return keyKind(key) === 'anon' ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

// A key in a config file: browser-safe, or a failure that says what to do.
function keyFinding(file, key) {
  const kind = keyKind(key);
  if (kind === 'none') return null;
  if (kind === 'secret' || kind === 'service_role') return { check: `${file} holds a key a browser may see`, ok: false, detail: `it holds the ${kind} key: take it out now, roll that key in the Dashboard (Project settings, API keys) and put the publishable key in its place` };
  if (kind === 'anon') return { check: `${file} uses the publishable key`, ok: false, warnOnly: true, detail: 'it holds the legacy anon key, which Supabase retires by the end of 2026: switch to the publishable key (npm run set-project)' };
  if (kind === 'unknown') return { check: `${file} holds a key a browser may see`, ok: false, detail: 'not a publishable key (sb_publishable_...) or an anon key' };
  return { check: `${file} holds a key a browser may see`, ok: true, detail: 'publishable' };
}

// A read the anon key must not get anything from: refused (401, 403) or an
// empty list. Never a 404: every name in TABLES is a table in the schema the
// API exposes, so a 404 means the table is missing (a migration not pushed),
// and whatever needs it fails on its first real request.
export function nothingRead(status, body) {
  if ([401, 403].includes(status)) return true;
  return status === 200 && Array.isArray(body) && body.length === 0;
}

// A 404 from a function in DEPLOYED_LATER turns its finding into a note that
// says which section deploys it; anything else, and any other function, is
// judged as it stands.
export function notDeployedYet(name, status, finding) {
  if (status !== 404 || !DEPLOYED_LATER[name]) return finding;
  return { ...finding, ok: false, warnOnly: true, detail: `404, not deployed yet: ${DEPLOYED_LATER[name]}` };
}

// The three config files: filled, and naming the same project and key.
export function configFindings({ account = {}, manager = {}, site = {} } = {}) {
  const out = [];
  const url = trimUrl(account.url);
  const mgr = trimUrl(manager.supabaseUrl);
  out.push({ check: 'extension/src/accountConfig.js is filled in', ok: Boolean(url && account.anonKey), detail: url ? url : 'url and anonKey are empty' });
  out.push({ check: 'manager/config.js is filled in', ok: Boolean(mgr && manager.supabaseAnonKey), detail: mgr || 'supabaseUrl and supabaseAnonKey are empty' });
  for (const f of [keyFinding('extension/src/accountConfig.js', account.anonKey), keyFinding('manager/config.js', manager.supabaseAnonKey)]) if (f) out.push(f);
  out.push({ check: 'the extension and the manager view name the same project and key', ok: Boolean(url) && url === mgr && account.anonKey === manager.supabaseAnonKey, detail: url === mgr ? '' : `${url || '(empty)'} vs ${mgr || '(empty)'}` });
  const lead = String(site.demoEndpoint || '');
  out.push({ check: 'site/config.js sends demo requests to this project\'s lead function', ok: Boolean(url) && lead === `${url}/functions/v1/lead`, detail: lead || 'demoEndpoint is empty: the form opens the mail app' , warnOnly: true });
  if (/^http:\/\/(localhost|127\.)/.test(url)) out.push({ check: 'the project is a hosted one', ok: false, detail: 'accountConfig.js points at a local stack' });
  return out;
}

async function call(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, init);
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  } catch (e) {
    return { status: 0, body: String((e && e.message) || e), headers: new Map() };
  }
}
const header = (h, name) => (h && typeof h.get === 'function' ? h.get(name) : null);

/**
 * Runs every check against the live project and returns the findings.
 * @param {object} deps  { fetchImpl, url, anonKey, testToken?, siteOrigin?, configs? }
 * @returns {Promise<{ check, ok, detail, warnOnly? }[]>}
 */
export async function runChecks({ fetchImpl = globalThis.fetch, url, anonKey, testToken = '', siteOrigin = '', configs = null } = {}) {
  const base = trimUrl(url);
  const out = configs ? configFindings(configs) : [];
  if (!base || !anonKey) {
    out.push({ check: 'a project URL and anon key to test with', ok: false, detail: 'set LOTSYNC_URL and LOTSYNC_ANON_KEY, or fill extension/src/accountConfig.js' });
    return out;
  }
  if (!isBrowserSafeKey(anonKey)) {
    out.push({ check: 'the key to test with is a publishable or anon key', ok: false, detail: `it is ${keyKind(anonKey) === 'unknown' ? 'neither' : `the ${keyKind(anonKey)} key, which skips row-level security, so the checks below would prove nothing`}` });
    return out;
  }
  const anon = keyHeaders(anonKey);

  // the API answers at all
  const health = await call(fetchImpl, `${base}/auth/v1/health`, { headers: { apikey: anonKey } });
  out.push({ check: 'the project answers', ok: health.status === 200, detail: `auth health ${health.status}` });

  // the anon key reads nothing
  for (const table of TABLES) {
    const r = await call(fetchImpl, `${base}/rest/v1/${table}?select=*&limit=1`, { headers: anon });
    const detail = r.status === 404 ? '404, table missing: is every migration pushed? (supabase db push)' : `${r.status}${Array.isArray(r.body) ? `, ${r.body.length} row(s)` : ''}`;
    out.push({ check: `anon reads nothing from ${table}`, ok: nothingRead(r.status, r.body), detail });
  }
  const redeem = await call(fetchImpl, `${base}/rest/v1/rpc/redeem_invite`, { method: 'POST', headers: { ...anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'CHECKDEPLOY0', display_name: null }) });
  out.push({ check: 'anon cannot call redeem_invite', ok: [401, 403, 404].includes(redeem.status), detail: String(redeem.status) });

  // the functions: CORS for the extension, 401 without a token (billing: a
  // note until the README's Billing section has deployed it)
  for (const f of FUNCTIONS) {
    const pre = await call(fetchImpl, `${base}/functions/v1/${f.path}`, { method: 'OPTIONS', headers: { Origin: EXTENSION_ORIGIN, 'Access-Control-Request-Method': f.method, 'Access-Control-Request-Headers': 'authorization, apikey, content-type' } });
    out.push(notDeployedYet(f.name, pre.status, { check: `${f.name}: answers the extension's CORS preflight`, ok: pre.status >= 200 && pre.status < 300 && header(pre.headers, 'access-control-allow-origin') === EXTENSION_ORIGIN, detail: `${pre.status}, allow-origin ${header(pre.headers, 'access-control-allow-origin') || 'none'}` }));
    const bare = await call(fetchImpl, `${base}/functions/v1/${f.path}`, { method: f.method, headers: { apikey: anonKey, 'Content-Type': 'application/json', Origin: EXTENSION_ORIGIN }, body: f.body ? JSON.stringify(f.body) : undefined });
    out.push(notDeployedYet(f.name, bare.status, { check: `${f.name}: refuses a call with no user token`, ok: bare.status === 401, detail: String(bare.status) }));
  }
  // An unsigned event gets 400 once the signing secret is set. Before that the
  // function itself answers 500 naming STRIPE_WEBHOOK_SECRET (billing is
  // deployed, Stripe is not set up yet): a note. Any other 500 is a failure.
  const webhook = await call(fetchImpl, `${base}/functions/v1/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const webhookCheck = 'billing: the webhook refuses an unsigned event';
  const noSecretYet = webhook.status === 500 && /STRIPE_WEBHOOK_SECRET/.test(String((webhook.body && webhook.body.error) || ''));
  out.push(notDeployedYet('billing', webhook.status, noSecretYet
    ? { check: webhookCheck, ok: false, warnOnly: true, detail: `500, STRIPE_WEBHOOK_SECRET is not set yet: ${DEPLOYED_LATER.billing}` }
    : { check: webhookCheck, ok: webhook.status === 400, detail: String(webhook.status) }));

  // the lead function: only the landing page (a note until the README's Demo
  // requests section has deployed it)
  const stranger = await call(fetchImpl, `${base}/functions/v1/lead`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://not-the-landing-page.example' }, body: '{}' });
  out.push(notDeployedYet('lead', stranger.status, { check: 'lead: refuses a page that is not the landing page', ok: stranger.status === 403, detail: String(stranger.status) }));
  if (siteOrigin) {
    const pre = await call(fetchImpl, `${base}/functions/v1/lead`, { method: 'OPTIONS', headers: { Origin: siteOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    out.push(notDeployedYet('lead', pre.status, { check: 'lead: answers the landing page\'s CORS preflight', ok: header(pre.headers, 'access-control-allow-origin') === siteOrigin, detail: `allow-origin ${header(pre.headers, 'access-control-allow-origin') || 'none'} (is LEAD_ORIGINS set to ${siteOrigin}?)` }));
  }

  // with a signed-in test account that belongs to no dealership
  if (testToken) {
    const user = { apikey: anonKey, Authorization: `Bearer ${testToken}` };
    const sync = await call(fetchImpl, `${base}/functions/v1/sync`, { method: 'POST', headers: { ...user, 'Content-Type': 'application/json', Origin: EXTENSION_ORIGIN }, body: JSON.stringify({ origin: 'https://www.check-deploy.example', posted: {}, pilot: {}, scan: null, since: null }) });
    out.push({ check: 'sync: a signed-in stranger gets 403', ok: sync.status === 403, detail: String(sync.status) });
    const listings = await call(fetchImpl, `${base}/rest/v1/listings?select=id&limit=1`, { headers: user });
    out.push({ check: 'a signed-in stranger reads no listing', ok: nothingRead(listings.status, listings.body), detail: String(listings.status) });
    let last = null;
    for (let i = 0; i < 11; i += 1) {
      last = await call(fetchImpl, `${base}/rest/v1/rpc/redeem_invite`, { method: 'POST', headers: { ...user, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: `CHECKDEPLOY${i}`, display_name: null }) });
      if (last.body && last.body.code === 'P0005') break;
    }
    const throttled = last && last.body && last.body.code === 'P0005';
    out.push({ check: 'redeem_invite: wrong codes are counted and the throttle answers P0005', ok: Boolean(throttled), detail: throttled ? 'the misses survive the call (PostgREST commits the 400 answer)' : `last answer ${last && last.status} ${JSON.stringify(last && last.body)}: the misses may be rolled back; see supabase/README.md step 5` });
  } else {
    out.push({ check: 'the signed-in checks (sync 403, the invite throttle)', ok: false, detail: 'skipped: set LOTSYNC_TEST_TOKEN to run them', warnOnly: true });
  }
  return out;
}

// A note is a check that did not pass and does not fail the run: a function
// not deployed yet, a skipped check, a config line that is optional. The last
// line says "Every check passed." only when there is neither.
export function report(findings) {
  const lines = findings.map((f) => `${f.ok ? 'ok  ' : f.warnOnly ? 'note' : 'FAIL'}  ${f.check}${f.detail ? ` (${f.detail})` : ''}`);
  const failed = findings.filter((f) => !f.ok && !f.warnOnly).length;
  const notes = findings.filter((f) => !f.ok && f.warnOnly).length;
  lines.push('', failed ? `${failed} check(s) failed.` : notes ? `Nothing failed; ${notes} note(s) above.` : 'Every check passed.');
  return { text: lines.join('\n'), failed, notes };
}

async function main() {
  const { ACCOUNT } = await import('../extension/src/accountConfig.js');
  const { CONFIG } = await import('../manager/config.js');
  const { SITE } = await import('../site/config.js');
  const findings = await runChecks({
    url: process.env.LOTSYNC_URL || ACCOUNT.url,
    anonKey: process.env.LOTSYNC_ANON_KEY || ACCOUNT.anonKey,
    testToken: process.env.LOTSYNC_TEST_TOKEN || '',
    siteOrigin: trimUrl(process.env.LOTSYNC_SITE_ORIGIN || ''),
    configs: { account: ACCOUNT, manager: CONFIG, site: SITE },
  });
  const { text, failed } = report(findings);
  console.log(text);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
