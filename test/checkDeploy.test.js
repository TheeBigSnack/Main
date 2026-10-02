// scripts/check-deploy.mjs against a fake project: a correct deploy passes
// every check, and each way a deploy can go wrong is caught and named. A
// project at supabase/README.md step 6, before the Billing and Demo requests
// sections, passes with notes for those two functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runChecks, report, nothingRead, notDeployedYet, configFindings, keyKind, keyHeaders, isBrowserSafeKey, pageOrigin, TABLES, EXTENSION_ORIGIN, DEPLOYED_LATER, MANAGER_CORS_CHECK } from '../scripts/check-deploy.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const URL_ = 'https://abcd.supabase.co';
const KEY = 'sb_publishable_check-deploy-tests';
// the signed-in test account's access token (LOTSYNC_TEST_TOKEN)
const TOKEN = 'user-token-check-deploy-tests';
// what the printed checklist must never contain, by value, so a renamed constant cannot make the check vacuous
const printsNoKeyOrToken = (text, why = '') => {
  assert.equal(text.includes(KEY), false, `the key is printed${why}`);
  assert.equal(text.includes(TOKEN), false, `the token is printed${why}`);
};
const SITE = 'https://lotsync.example';
// the hosted manager view: ALLOWED_ORIGINS in the fake below, unless broken.noManagerOrigin
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
      const allowed = (origin === EXTENSION_ORIGIN && !broken.noCors) || (origin === MANAGER && !broken.noManagerOrigin);
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
  const findings = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, managerOrigin: MANAGER, configs });
  const failed = findings.filter((f) => !f.ok);
  assert.deepEqual(failed, []);
  assert.ok(findings.some((f) => f.check === "billing: answers the manager view's CORS preflight" && f.ok));
  for (const t of TABLES) assert.ok(findings.some((f) => f.check === `anon reads nothing from ${t}` && f.ok), t);
  assert.ok(findings.some((f) => /throttle answers P0005/.test(f.check) && f.ok));
  const { text, failed: n } = report(findings);
  assert.equal(n, 0);
  assert.match(text, /Every check passed\./);
  printsNoKeyOrToken(text);
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
    // the hosted manager view's origin missing from ALLOWED_ORIGINS: its Billing card cannot call the function
    [{ noManagerOrigin: true }, MANAGER_CORS_CHECK],
  ];
  for (const [broken, name] of cases) {
    const findings = await runChecks({ fetchImpl: fakeProject(broken), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, managerOrigin: MANAGER, configs });
    const f = findings.find((x) => x.check === name);
    assert.ok(f, name);
    assert.equal(f.ok, false, `${JSON.stringify(broken)} is caught by "${name}"`);
    assert.notEqual(f.warnOnly, true, `${JSON.stringify(broken)} is a failure, not a note`);
    assert.ok(report(findings).failed >= 1);
    printsNoKeyOrToken(report(findings).text, ` when ${JSON.stringify(broken)}`);
  }
  const missing = (await runChecks({ fetchImpl: fakeProject({ missingTable: 'demo_requests' }), url: URL_, anonKey: KEY })).find((f) => f.check === 'anon reads nothing from demo_requests');
  assert.match(missing.detail, /^404, table missing: is every migration pushed\?/);
});

// review 5 (G12): the README deploys billing and lead after step 6, so a correct
// deploy at step 6 must pass, with each of their lines a note saying where
test('at README step 6, before billing and lead are deployed, nothing fails and their lines are notes', async () => {
  const findings = await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing', 'lead'] }), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, managerOrigin: MANAGER, configs });
  const { text, failed, notes } = report(findings);
  assert.equal(failed, 0, text);
  const later = findings.filter((f) => /^(billing|lead): /.test(f.check));
  assert.equal(later.length, 6, 'billing: preflight, no token, webhook, the manager view\'s preflight; lead: stranger, preflight');
  for (const f of later) {
    assert.equal(f.ok, false, f.check);
    assert.equal(f.warnOnly, true, f.check);
    assert.equal(f.detail, `404, not deployed yet: ${DEPLOYED_LATER[f.check.split(':')[0]]}`);
  }
  assert.equal(notes, 6);
  assert.match(text, /^note {2}billing: refuses a call with no user token \(404, not deployed yet: supabase\/README\.md, Billing\)$/m);
  assert.match(text, /^note {2}lead: refuses a page that is not the landing page \(404, not deployed yet: supabase\/README\.md, Demo requests\)$/m);
  assert.match(text, /Nothing failed; 6 note\(s\) above\.$/);
  assert.doesNotMatch(text, /Every check passed/, 'notes are not passes');
  // everything the README has deployed by step 6 is still judged: sync and rewrite pass
  for (const name of ['sync', 'rewrite']) assert.ok(findings.filter((f) => f.check.startsWith(`${name}: `)).every((f) => f.ok), name);

  // billing deployed, Stripe not set up yet: the webhook says so in a note
  const noSecret = await runChecks({ fetchImpl: fakeProject({ noWebhookSecret: true }), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, managerOrigin: MANAGER, configs });
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
  const findings = await runChecks({ fetchImpl, url: URL_, anonKey: LEGACY, testToken: TOKEN, siteOrigin: SITE, managerOrigin: MANAGER });
  assert.deepEqual(findings.filter((f) => !f.ok), []);
});

test('with a publishable key no request carries it after Bearer, so a 401 is a real refusal and not "Invalid JWT"', async () => {
  const sent = [];
  const project = fakeProject();
  const fetchImpl = (url, init = {}) => { sent.push((init.headers || {}).Authorization || ''); return project(url, init); };
  await runChecks({ fetchImpl, url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE });
  assert.ok(sent.length > TABLES.length);
  assert.deepEqual(sent.filter((a) => a.includes(KEY)), []);
});

// The hosted manager view calls billing from its own origin, which the
// function lets through only when ALLOWED_ORIGINS lists it; the extension's
// preflight says nothing about that page. Unset, the run says the page was
// not checked rather than calling billing ok.
test('the manager view\'s origin: checked when given, a note when not, a failure when ALLOWED_ORIGINS leaves it out', async () => {
  assert.equal(pageOrigin('https://app.lotsync.example/'), 'https://app.lotsync.example', 'the address MANAGER_URL holds becomes its origin');
  assert.equal(pageOrigin('https://app.lotsync.example/billing?x=1'), 'https://app.lotsync.example');
  assert.equal(pageOrigin('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787', 'a page on this computer');
  for (const bad of ['', 'app.lotsync.example', 'http://app.lotsync.example', 'ftp://x.example']) assert.equal(pageOrigin(bad), '', bad);

  const sent = [];
  const project = fakeProject();
  const fetchImpl = (url, init = {}) => { sent.push([url, init.method || 'GET', (init.headers || {}).Origin || '']); return project(url, init); };
  const good = await runChecks({ fetchImpl, url: URL_, anonKey: KEY, managerOrigin: `${MANAGER}/` });
  const line = good.find((f) => f.check === MANAGER_CORS_CHECK);
  assert.equal(line.ok, true, line.detail);
  assert.deepEqual(sent.filter(([, , o]) => o === MANAGER), [[`${URL_}/functions/v1/billing/status`, 'OPTIONS', MANAGER]], 'one preflight, from the page\'s origin, to the route the card calls first');

  const left = (await runChecks({ fetchImpl: fakeProject({ noManagerOrigin: true }), url: URL_, anonKey: KEY, managerOrigin: MANAGER })).find((f) => f.check === MANAGER_CORS_CHECK);
  assert.equal(left.ok, false);
  assert.notEqual(left.warnOnly, true, 'a failure');
  assert.match(left.detail, /allow-origin none \(is https:\/\/app\.lotsync\.example in ALLOWED_ORIGINS\?\)/);

  const unset = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, configs });
  const note = unset.find((f) => f.check === MANAGER_CORS_CHECK);
  assert.equal(note.warnOnly, true);
  assert.match(note.detail, /LOTSYNC_MANAGER_ORIGIN/);
  assert.doesNotMatch(report(unset).text, /Every check passed/, 'billing is not called ok without the manager view\'s line');

  const wrong = (await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, managerOrigin: 'app.lotsync.example' })).find((f) => f.check === MANAGER_CORS_CHECK);
  assert.equal(wrong.ok, false);
  assert.notEqual(wrong.warnOnly, true);

  // the walk-through sets the secret, and the reference no longer calls it optional for the hosted page
  const stripe = read('docs/stripe-setup.md');
  const step5 = stripe.slice(stripe.indexOf('## 5. '), stripe.indexOf('## 6. '));
  assert.match(step5, /\| `ALLOWED_ORIGINS` \| `https:\/\/<the manager view's address>`/);
  assert.match(step5, /LOTSYNC_MANAGER_ORIGIN=https:\/\/<the manager view's address> npm run check-deploy/);
  assert.match(read('.github/workflows/supabase.yml'), /run: npm run check-deploy\n\s+env:\n\s+LOTSYNC_MANAGER_ORIGIN: \$\{\{ vars\.MANAGER_URL \}\}\n/, 'the workflow\'s check passes the address when the production environment has it');
  const env = read('supabase/README.md').split('\n').find((l) => l.startsWith('| `ALLOWED_ORIGINS` |'));
  assert.doesNotMatch(env, /optional/);
  assert.match(env, /manager view/);
});

// The manager view calls billing from its own origin: the extension's
// preflight passing says nothing about it, and a missing ALLOWED_ORIGINS
// shows up only there.
test('with the manager view\'s origin, billing\'s preflight from it is checked: ok when ALLOWED_ORIGINS names it, a failure when not, a note before billing is deployed', async () => {
  const name = 'billing: answers the manager view\'s CORS preflight';
  const good = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, managerOrigin: MANAGER, configs });
  assert.equal(good.find((f) => f.check === name).ok, true);
  assert.equal(report(good).failed, 0);
  const refused = await runChecks({ fetchImpl: fakeProject({ noManagerOrigin: true }), url: URL_, anonKey: KEY, managerOrigin: MANAGER, configs });
  const f = refused.find((x) => x.check === name);
  assert.deepEqual([f.ok, f.warnOnly], [false, undefined], 'a failure, not a note');
  assert.equal(f.detail, `204, allow-origin none (is ${MANAGER} in ALLOWED_ORIGINS?)`);
  assert.ok(refused.find((x) => x.check === "billing: answers the extension's CORS preflight").ok, 'the extension\'s line alone would read ok');
  const later = await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing'] }), url: URL_, anonKey: KEY, managerOrigin: MANAGER, configs });
  assert.equal(later.find((x) => x.check === name).warnOnly, true);
  // without the origin nothing is sent from it, and the line is a note, so the run never says every check passed
  const sent = [];
  const project = fakeProject();
  const unset = await runChecks({ fetchImpl: (u, init = {}) => { sent.push((init.headers || {}).Origin || ''); return project(u, init); }, url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, configs });
  assert.ok(!sent.includes(MANAGER));
  const u = unset.find((x) => x.check === name);
  assert.deepEqual([u.ok, u.warnOnly], [false, true]);
  assert.match(u.detail, /^not checked: set LOTSYNC_MANAGER_ORIGIN to the manager view's address; its Billing card works only once that origin is in ALLOWED_ORIGINS$/);
  assert.equal(report(unset).failed, 0, 'a note, not a failure');
  assert.doesNotMatch(report(unset).text, /Every check passed/);
  assert.match(report(good).text, /Every check passed/);
});

test('billing is judged from the manager view\'s address too: without it the line is a note, with a path it is the origin, before billing is deployed a note', async () => {
  const line = (findings) => findings.find((f) => f.check === "billing: answers the manager view's CORS preflight");
  const skipped = await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, testToken: TOKEN, siteOrigin: SITE, configs });
  assert.deepEqual([line(skipped).ok, line(skipped).warnOnly], [false, true], 'not checked is a note, never an ok');
  assert.match(line(skipped).detail, /LOTSYNC_MANAGER_ORIGIN.*ALLOWED_ORIGINS/);
  assert.doesNotMatch(report(skipped).text, /Every check passed/);
  const missing = line(await runChecks({ fetchImpl: fakeProject({ noManagerOrigin: true }), url: URL_, anonKey: KEY, managerOrigin: MANAGER + '/' }));
  assert.deepEqual([missing.ok, Boolean(missing.warnOnly)], [false, false]);
  assert.match(missing.detail, /allow-origin none \(is https:\/\/app\.lotsync\.example in ALLOWED_ORIGINS\?\)/);
  assert.equal(line(await runChecks({ fetchImpl: fakeProject(), url: URL_, anonKey: KEY, managerOrigin: `${MANAGER}/?view=billing` })).ok, true, 'an address with a path is checked as its origin');
  const early = line(await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing'] }), url: URL_, anonKey: KEY, managerOrigin: MANAGER }));
  assert.deepEqual([early.ok, early.warnOnly], [false, true]);
  assert.equal(line(await runChecks({ fetchImpl: fakeProject({ notDeployed: ['billing'] }), url: URL_, anonKey: KEY })), undefined, 'nothing to say about an address before billing is deployed');
  // the commands that deploy billing by hand set the manager view's address in ALLOWED_ORIGINS and check it
  // (on production the Dashboard's secrets table does: docs/stripe-setup.md step 5, tested above)
  const readme = read('supabase/README.md');
  const block = readme.split('Then the secrets and the function')[1].split('```')[1];
  assert.match(block, /^supabase secrets set ALLOWED_ORIGINS=https:\/\/</m, 'supabase/README.md: the billing commands set ALLOWED_ORIGINS');
  assert.match(block, /^supabase functions deploy billing/m, 'supabase/README.md: the block read is the billing one');
  assert.match(readme.split('Then the secrets and the function')[1], /\nThen `LOTSYNC_MANAGER_ORIGIN=https:\/\/<[^>]+> npm run check-deploy` again/);
  assert.doesNotMatch(readme, /`ALLOWED_ORIGINS` \| function secret, optional/, 'the hosted manager view needs it');
});
