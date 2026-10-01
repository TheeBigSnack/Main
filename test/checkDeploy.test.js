// scripts/check-deploy.mjs against a fake project: a correct deploy passes
// every check, and each way a deploy can go wrong is caught and named. A
// project at supabase/README.md step 6, before the Billing and Demo requests
// sections, passes with notes for those two functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runChecks, report, nothingRead, notDeployedYet, configFindings, keyKind, keyHeaders, isBrowserSafeKey, TABLES, EXTENSION_ORIGIN, DEPLOYED_LATER } from '../scripts/check-deploy.mjs';

const URL_ = 'https://abcd.supabase.co';
const KEY = 'sb_publishable_check-deploy-tests';
const SITE = 'https://lotsync.example';
const MANAGER = 'https://app.lotsync.example';

// A fake Supabase that behaves like a correct deploy, with switches to break it.
function fakeProject(broken = {}) {
  const misses = { n: 0 };
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const origin = headers.Origin || '';
    const auth = headers.Authorization || '';
    const anonCall = !auth || auth === `Bearer ${KEY}`;
    const reply = (status, body, h = {}) => ({ status, headers: new Map(Object.entries(h)), text: async () => (body === null ? '' : JSON.stringify(body)) });
    // the platform reads whatever follows Bearer as a JWT: a publishable key there is refused before anything else
    if (/^Bearer sb_/.test(auth)) return reply(401, { message: 'Invalid JWT' });
    // a function that is not deployed: the gateway's own 404, preflight included
    const fn = u.pathname.startsWith('/functions/v1/') ? u.pathname.split('/')[3] : '';
    if ((broken.notDeployed || []).includes(fn)) return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
    if (u.pathname === '/auth/v1/health') return reply(200, { name: 'GoTrue' });
    if (u.pathname.startsWith('/rest/v1/rpc/redeem_invite')) {
      if (anonCall) return reply(broken.anonRedeem ? 400 : 401, { code: 'P0002', message: 'that invite code is not valid' });
      if (misses.n >= 10) return reply(400, { code: 'P0005', message: 'too many attempts; try again in an hour' });
      if (!broken.missesRolledBack) misses.n += 1;
      return reply(400, { code: 'P0002', message: 'that invite code is not valid' });
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.split('/').pop();
      if (broken.missingTable === table) return reply(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
      if (broken.readable === table) return reply(200, [{ id: 1 }]);
      return reply(200, []);
    }
    if (u.pathname.startsWith('/functions/v1/lead')) {
      const ok = origin === SITE;
      if (method === 'OPTIONS') return reply(204, null, ok ? { 'access-control-allow-origin': origin } : {});
      return reply(ok || broken.leadOpen ? 400 : 403, { ok: false });
    }
    if (u.pathname.startsWith('/functions/v1/billing/webhook')) {
      // billing/index.ts answers this before it reads the event when the secret is missing
      if (broken.noWebhookSecret) return reply(500, { ok: false, error: 'STRIPE_WEBHOOK_SECRET is not set on the function' });
      if (broken.webhookCrash) return reply(500, { ok: false, error: 'something else went wrong' });
      return reply(400, { ok: false, error: 'the Stripe signature does not match' });
    }
    if (u.pathname.startsWith('/functions/v1/')) {
      // ALLOWED_ORIGINS lists the manager view's address unless broken.managerOriginMissing
      const allowed = (origin === EXTENSION_ORIGIN && !broken.noCors) || (origin === MANAGER && !broken.managerOriginMissing);
      if (method === 'OPTIONS') return reply(204, null, allowed ? { 'access-control-allow-origin': origin } : {});
      if (anonCall) return reply(broken.gatewayOpen ? 200 : 401, { ok: false });
      return reply(403, { ok: false, error: 'not a member' });
    }
    return reply(404, null);
  };
}

const configs = {
  account: { url: URL_, anonKey: KEY },
  manager: { supabaseUrl: URL_, supabaseAnonKey: KEY },
  site: { demoEndpoint: `${URL_}/functions/v1/lead` },
};

test('a correct deploy passes every check, the signed-in ones included', async () => {
  const findings = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, managerOrigin: MANAGER, configs });
  const failed = findings.filter((f) => !f.ok);
  assert.deepEqual(failed, []);
  assert.ok(findings.some((f) => f.check === "billing: answers the manager view's CORS preflight" && f.ok));
  for (const t of TABLES) assert.ok(findings.some((f) => f.check === `anon reads nothing from ${t}` && f.ok), t);
  assert.ok(findings.some((f) => /throttle answers P0005/.test(f.check) && f.ok));
  const { text, failed: n } = report(findings);
  assert.equal(n, 0);
  assert.match(text, /Every check passed\./);
  assert.doesNotMatch(text, /anon-key|user-token/, 'no key or token is printed');
});

test('each broken deploy is caught and named', async () => {
  const cases = [
    [{ readable: 'listings' }, 'anon reads nothing from listings'],
    [{ readable: 'demo_requests' }, 'anon reads nothing from demo_requests'],
    [{ anonRedeem: true }, 'anon cannot call redeem_invite'],
    [{ noCors: true }, "sync: answers the extension's CORS preflight"],
    [{ gatewayOpen: true }, 'rewrite: refuses a call with no user token'],
    [{ leadOpen: true }, 'lead: refuses a page that is not the landing page'],
    [{ webhookCrash: true }, 'billing: the webhook refuses an unsigned event'],
    [{ missesRolledBack: true }, 'redeem_invite: wrong codes are counted and the throttle answers P0005'],
    // review 5 (G18): a table the API does not know is a missing migration, never "reads nothing"
    [{ missingTable: 'demo_requests' }, 'anon reads nothing from demo_requests'],
    [{ missingTable: 'listings' }, 'anon reads nothing from listings'],
    // the two functions step 4 deploys are never a note: a 404 there is a failure
    [{ notDeployed: ['sync'] }, "sync: answers the extension's CORS preflight"],
    [{ notDeployed: ['rewrite'] }, 'rewrite: refuses a call with no user token'],
    // the manager view's address missing from ALLOWED_ORIGINS: the Billing card cannot reach billing
    [{ managerOriginMissing: true }, "billing: answers the manager view's CORS preflight"],
  ];
  for (const [broken, name] of cases) {
    const findings = await runChecks({ fetchImpl: fakeProject(broken), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, managerOrigin: MANAGER, configs });
    const f = findings.find((x) => x.check === name);
    assert.ok(f, name);
    assert.equal(f.ok, false, `${JSON.stringify(broken)} is caught by "${name}"`);
    assert.notEqual(f.warnOnly, true, `${JSON.stringify(broken)} is a failure, not a note`);
    assert.ok(report(findings).failed >= 1);
  }
  const missing = (await runChecks({ fetchImpl: fakeProject({ missingTable: 'demo_requests' }), url: URL_, anonKey: KEY })).find((f) => f.check === 'anon reads nothing from demo_requests');
  assert.match(missing.detail, /^404, table missing: is every migration pushed\?/);
});

// review 5 (G12): the README deploys billing and lead after step 6, so a correct
// deploy at step 6 must pass, with each of their lines a note saying where
test('at README step 6, before billing and lead are deployed, nothing fails and their lines are notes', async () => {
  const findings = await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing', 'lead'] }), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, configs });
  const { text, failed, notes } = report(findings);
  assert.equal(failed, 0, text);
  const later = findings.filter((f) => /^(billing|lead): /.test(f.check));
  assert.equal(later.length, 5, 'billing: preflight, no token, webhook; lead: stranger, preflight');
  for (const f of later) {
    assert.equal(f.ok, false, f.check);
    assert.equal(f.warnOnly, true, f.check);
    assert.equal(f.detail, `404, not deployed yet: ${DEPLOYED_LATER[f.check.split(':')[0]]}`);
  }
  assert.equal(notes, 5);
  assert.match(text, /^note {2}billing: refuses a call with no user token \(404, not deployed yet: supabase\/README\.md, Billing\)$/m);
  assert.match(text, /^note {2}lead: refuses a page that is not the landing page \(404, not deployed yet: supabase\/README\.md, Demo requests\)$/m);
  assert.match(text, /Nothing failed; 5 note\(s\) above\.$/);
  assert.doesNotMatch(text, /Every check passed/, 'notes are not passes');
  // everything the README has deployed by step 6 is still judged: sync and rewrite pass
  for (const name of ['sync', 'rewrite']) assert.ok(findings.filter((f) => f.check.startsWith(`${name}: `)).every((f) => f.ok), name);

  // billing deployed, Stripe not set up yet: the webhook says so in a note
  const noSecret = await runChecks({ fetchImpl: fakeProject({ noWebhookSecret: true }), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, managerOrigin: MANAGER, configs });
  const webhook = noSecret.find((f) => f.check === 'billing: the webhook refuses an unsigned event');
  assert.equal(webhook.warnOnly, true);
  assert.match(webhook.detail, /^500, STRIPE_WEBHOOK_SECRET is not set yet: supabase\/README\.md, Billing$/);
  assert.equal(report(noSecret).failed, 0);
  assert.equal(report(noSecret).notes, 1);

  // only billing and lead can be "not deployed yet"
  const f = { check: 'x', ok: false, detail: '404' };
  assert.deepEqual(notDeployedYet('sync', 404, f), f);
  assert.deepEqual(notDeployedYet('billing', 401, f), f);
  assert.equal(notDeployedYet('lead', 404, f).warnOnly, true);
});

test('without a test token the signed-in checks are a note, and without a URL nothing is called', async () => {
  const findings = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY });
  const note = findings.find((f) => /signed-in checks/.test(f.check));
  assert.equal(note.warnOnly, true);
  assert.equal(note.ok, false, 'a skipped check is a note, not an ok');
  assert.equal(report(findings).failed, 0);
  assert.match(report(findings).text, /^note {2}the signed-in checks/m);
  let called = 0;
  const none = await runChecks({ fetchImpl: async () => { called += 1; }, url: '', anonKey: '' });
  assert.equal(called, 0);
  assert.equal(report(none).failed, 1);
  // a network failure is a failed check, never a crash
  const down = await runChecks({ fetchImpl: async () => { throw new Error('offline'); }, url: URL_, anonKey: KEY });
  assert.ok(report(down).failed > 5);
});

test('the config files must name one project; an empty demo endpoint is only a note', () => {
  assert.equal(nothingRead(200, []), true);
  assert.equal(nothingRead(401, null), true);
  assert.equal(nothingRead(404, null), false, 'a 404 is a missing table, not a refusal');
  assert.equal(nothingRead(200, [{}]), false);
  assert.equal(nothingRead(500, null), false);
  const mismatch = configFindings({ account: { url: URL_, anonKey: KEY }, manager: { supabaseUrl: 'https://other.supabase.co', supabaseAnonKey: KEY }, site: {} });
  assert.equal(mismatch.find((f) => /same project/.test(f.check)).ok, false);
  const site = mismatch.find((f) => /site\/config\.js/.test(f.check));
  assert.equal(site.ok, false);
  assert.equal(site.warnOnly, true);
  const empty = configFindings({});
  assert.equal(empty.filter((f) => !f.ok && !f.warnOnly).length, 3);
  const local = configFindings({ account: { url: 'http://127.0.0.1:54321', anonKey: KEY }, manager: { supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: KEY }, site: {} });
  assert.equal(local.find((f) => /hosted/.test(f.check)).ok, false);
});

// A legacy key as Supabase made them: a JWT whose payload names the role (the signature is not checked here).
const jwt = (role) => ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify({ iss: 'supabase', ref: 'abcd', role })).toString('base64url'), 'signature'].join('.');

test('keyKind tells the browser-safe keys from the secret ones, the legacy JWTs included', () => {
  assert.equal(keyKind('sb_publishable_abc'), 'publishable');
  assert.equal(keyKind('  sb_publishable_abc  '), 'publishable');
  assert.equal(keyKind('sb_secret_abc'), 'secret');
  assert.equal(keyKind(jwt('anon')), 'anon');
  assert.equal(keyKind(jwt('service_role')), 'service_role');
  assert.equal(keyKind(jwt('authenticated')), 'unknown', 'a user\'s token is not a project key');
  for (const k of ['', null, undefined]) assert.equal(keyKind(k), 'none');
  for (const k of ['anon-key', 'a.b.c', 'eyJ.notbase64!.x']) assert.equal(keyKind(k), 'unknown', k);
  assert.deepEqual(['sb_publishable_a', jwt('anon'), 'sb_secret_a', jwt('service_role'), 'x'].map(isBrowserSafeKey), [true, true, false, false, false]);
});

test('keyHeaders: a publishable key goes on apikey only, never after Bearer; a legacy anon JWT on both', () => {
  assert.deepEqual(keyHeaders('sb_publishable_a'), { apikey: 'sb_publishable_a' });
  assert.deepEqual(keyHeaders(jwt('anon')), { apikey: jwt('anon'), Authorization: `Bearer ${jwt('anon')}` });
});

test('a secret key in a config file fails the run and says to roll it; the legacy anon key is a note', () => {
  for (const secret of ['sb_secret_leaked', jwt('service_role')]) {
    const f = configFindings({ account: { url: URL_, anonKey: secret }, manager: { supabaseUrl: URL_, supabaseAnonKey: KEY }, site: {} });
    const bad = f.find((x) => x.check === 'extension/src/accountConfig.js holds a key a browser may see');
    assert.equal(bad.ok, false);
    assert.ok(!bad.warnOnly, 'a failure, not a note');
    assert.match(bad.detail, /roll that key/);
    assert.doesNotMatch(bad.detail, /sb_secret_leaked|signature/, 'the key itself is never printed');
  }
  const legacy = configFindings({ account: { url: URL_, anonKey: jwt('anon') }, manager: { supabaseUrl: URL_, supabaseAnonKey: jwt('anon') }, site: {} });
  const note = legacy.filter((x) => /uses the publishable key/.test(x.check));
  assert.equal(note.length, 2);
  assert.ok(note.every((x) => !x.ok && x.warnOnly && /end of 2026/.test(x.detail)));
  const fine = configFindings({ account: { url: URL_, anonKey: KEY }, manager: { supabaseUrl: URL_, supabaseAnonKey: KEY }, site: {} });
  assert.deepEqual(fine.filter((x) => /key a browser may see/.test(x.check)).map((x) => x.ok), [true, true]);
});

test('runChecks refuses to test with a secret key (it skips row-level security) and calls nothing', async () => {
  let called = 0;
  for (const key of ['sb_secret_x', jwt('service_role'), 'not-a-key']) {
    const findings = await runChecks({ fetchImpl: async () => { called += 1; }, url: URL_, anonKey: key });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ok, false);
    assert.doesNotMatch(findings[0].detail, /sb_secret_x|signature/);
  }
  assert.equal(called, 0);
});

test('a legacy anon key still gets every line ok against a correct project', async () => {
  const LEGACY = jwt('anon');
  const project = fakeProject();
  // the fake knows KEY; a call carrying the legacy JWT on both headers is the same anonymous call
  const fetchImpl = (url, init = {}) => {
    const h = { ...(init.headers || {}) };
    if (h.Authorization === `Bearer ${LEGACY}`) delete h.Authorization;
    if (h.apikey === LEGACY) h.apikey = KEY;
    return project(url, { ...init, headers: h });
  };
  const findings = await runChecks({ fetchImpl, url: URL_, anonKey: LEGACY, testToken: 'user-token', siteOrigin: SITE, managerOrigin: MANAGER });
  assert.deepEqual(findings.filter((f) => !f.ok), []);
});

test('with a publishable key no request carries it after Bearer, so a 401 is a real refusal and not "Invalid JWT"', async () => {
  const sent = [];
  const project = fakeProject();
  const fetchImpl = (url, init = {}) => { sent.push((init.headers || {}).Authorization || ''); return project(url, init); };
  await runChecks({ fetchImpl, url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE });
  assert.ok(sent.length > TABLES.length);
  assert.deepEqual(sent.filter((a) => a.includes(KEY)), []);
});

test('billing is judged from the manager view\'s address too: without it the line is a note, with a path it is the origin, before billing is deployed a note', async () => {
  const line = (findings) => findings.find((f) => f.check === "billing: answers the manager view's CORS preflight");
  const skipped = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, configs });
  assert.deepEqual([line(skipped).ok, line(skipped).warnOnly], [false, true], 'not checked is a note, never an ok');
  assert.match(line(skipped).detail, /LOTSYNC_MANAGER_ORIGIN.*ALLOWED_ORIGINS/);
  assert.doesNotMatch(report(skipped).text, /Every check passed/);
  const missing = line(await runChecks({ fetchImpl: fakeProject({ managerOriginMissing: true }), url: URL_, anonKey: KEY, managerOrigin: MANAGER + '/' }));
  assert.deepEqual([missing.ok, Boolean(missing.warnOnly)], [false, false]);
  assert.match(missing.detail, /allow-origin none \(is https:\/\/app\.lotsync\.example in the ALLOWED_ORIGINS secret\?\)/);
  assert.equal(line(await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, managerOrigin: `${MANAGER}/?view=billing` })).ok, true, 'an address with a path is checked as its origin');
  const early = line(await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing'] }), url: URL_, anonKey: KEY, managerOrigin: MANAGER }));
  assert.deepEqual([early.ok, early.warnOnly], [false, true]);
  assert.equal(line(await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing'] }), url: URL_, anonKey: KEY })), undefined, 'nothing to say about an address before billing is deployed');
  // the commands that deploy billing set the manager view's address in ALLOWED_ORIGINS and check it
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const blocks = { 'docs/stripe-setup.md': read('docs/stripe-setup.md').split('## 5.')[1].split('```')[1], 'supabase/README.md': read('supabase/README.md').split('Then the secrets and the function:')[1].split('```')[1] };
  for (const [file, block] of Object.entries(blocks)) {
    assert.match(block, /^supabase secrets set ALLOWED_ORIGINS=https:\/\/</m, `${file}: the billing commands set ALLOWED_ORIGINS`);
    assert.match(block, /^supabase functions deploy billing/m, `${file}: the block read is the billing one`);
  }
  assert.match(blocks['docs/stripe-setup.md'], /^LOTSYNC_MANAGER_ORIGIN=https:\/\/<[^>]+> npm run check-deploy$/m);
  assert.doesNotMatch(read('supabase/README.md'), /`ALLOWED_ORIGINS` \| function secret, optional/, 'the hosted manager view needs it');
});
