// scripts/check-deploy.mjs against a fake project: a correct deploy passes
// every check, and each way a deploy can go wrong is caught and named. A
// project at supabase/README.md step 6, before the Billing and Demo requests
// sections, passes with notes for those two functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, report, nothingRead, notDeployedYet, configFindings, TABLES, EXTENSION_ORIGIN, DEPLOYED_LATER } from '../scripts/check-deploy.mjs';

const URL_ = 'https://abcd.supabase.co';
const KEY = 'anon-key';
const SITE = 'https://lotcurrent.example';

// A fake Supabase that behaves like a correct deploy, with switches to break it.
function fakeProject(broken = {}) {
  const misses = { n: 0 };
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const origin = headers.Origin || '';
    const auth = headers.Authorization || '';
    const reply = (status, body, h = {}) => ({ status, headers: new Map(Object.entries(h)), text: async () => (body === null ? '' : JSON.stringify(body)) });
    // a function that is not deployed: the gateway's own 404, preflight included
    const fn = u.pathname.startsWith('/functions/v1/') ? u.pathname.split('/')[3] : '';
    if ((broken.notDeployed || []).includes(fn)) return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
    if (u.pathname === '/auth/v1/health') return reply(200, { name: 'GoTrue' });
    if (u.pathname.startsWith('/rest/v1/rpc/redeem_invite')) {
      if (auth === `Bearer ${KEY}`) return reply(broken.anonRedeem ? 400 : 401, { code: 'P0002', message: 'that invite code is not valid' });
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
      if (method === 'OPTIONS') return reply(204, null, origin === EXTENSION_ORIGIN && !broken.noCors ? { 'access-control-allow-origin': origin } : {});
      if (!auth.startsWith('Bearer ') || auth === `Bearer ${KEY}`) return reply(broken.gatewayOpen ? 200 : 401, { ok: false });
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
  const findings = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, configs });
  const failed = findings.filter((f) => !f.ok);
  assert.deepEqual(failed, []);
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
  ];
  for (const [broken, name] of cases) {
    const findings = await runChecks({ fetchImpl: fakeProject(broken), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, configs });
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
  const noSecret = await runChecks({ fetchImpl: fakeProject({ noWebhookSecret: true }), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, configs });
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
