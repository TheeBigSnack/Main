// scripts/check-deploy.mjs against a fake project: a correct deploy passes
// every check, and each way a deploy can go wrong is caught and named.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, report, nothingRead, configFindings, TABLES, EXTENSION_ORIGIN } from '../scripts/check-deploy.mjs';

const URL_ = 'https://abcd.supabase.co';
const KEY = 'anon-key';
const SITE = 'https://lotsync.example';

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
    if (u.pathname === '/auth/v1/health') return reply(200, { name: 'GoTrue' });
    if (u.pathname.startsWith('/rest/v1/rpc/redeem_invite')) {
      if (auth === `Bearer ${KEY}`) return reply(broken.anonRedeem ? 400 : 401, { code: 'P0002', message: 'that invite code is not valid' });
      if (misses.n >= 10) return reply(400, { code: 'P0005', message: 'too many attempts; try again in an hour' });
      if (!broken.missesRolledBack) misses.n += 1;
      return reply(400, { code: 'P0002', message: 'that invite code is not valid' });
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.split('/').pop();
      if (broken.readable === table) return reply(200, [{ id: 1 }]);
      return reply(200, []);
    }
    if (u.pathname.startsWith('/functions/v1/lead')) {
      const ok = origin === SITE;
      if (method === 'OPTIONS') return reply(204, null, ok ? { 'access-control-allow-origin': origin } : {});
      return reply(ok || broken.leadOpen ? 400 : 403, { ok: false });
    }
    if (u.pathname.startsWith('/functions/v1/billing/webhook')) return reply(broken.noWebhookSecret ? 500 : 400, { ok: false });
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
    [{ noWebhookSecret: true }, 'billing: the webhook refuses an unsigned event'],
    [{ missesRolledBack: true }, 'redeem_invite: wrong codes are counted and the throttle answers P0005'],
  ];
  for (const [broken, name] of cases) {
    const findings = await runChecks({ fetchImpl: fakeProject(broken), url: URL_, anonKey: KEY, testToken: 'user-token', siteOrigin: SITE, configs });
    const f = findings.find((x) => x.check === name);
    assert.ok(f, name);
    assert.equal(f.ok, false, `${JSON.stringify(broken)} is caught by "${name}"`);
    assert.ok(report(findings).failed >= 1);
  }
  const noSecret = (await runChecks({ fetchImpl: fakeProject({ noWebhookSecret: true }), url: URL_, anonKey: KEY })).find((f) => /webhook/.test(f.check));
  assert.match(noSecret.detail, /STRIPE_WEBHOOK_SECRET/);
});

test('without a test token the signed-in checks are a note, and without a URL nothing is called', async () => {
  const findings = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY });
  const note = findings.find((f) => /signed-in checks/.test(f.check));
  assert.equal(note.warnOnly, true);
  assert.equal(report(findings).failed, 0);
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
