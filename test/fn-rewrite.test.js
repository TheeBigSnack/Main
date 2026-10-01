// The rewrite function's real handler (supabase/functions/rewrite/index.ts)
// under Node, against the fake database (test/functions/) and a fake
// Anthropic API: the order of its checks (401, the per-user brake, the body,
// 403, 402, the monthly cap), a draft the guardrails refuse twice, a model
// that declines, the upstream errors, the usage log, and the extension's own
// rewriter (extension/src/rewriter.js) run against it end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, invoke, fake, net, logs, hermetic, functionsFetch, uuid, keysOf, NETWORK_ERROR, SUPABASE_URL, ANON_KEY, SERVICE_KEY, EXTENSION_ORIGIN } from './functions/harness.mjs';
import { LAPSED_MESSAGE } from '../supabase/functions/_shared/billing.mjs';
import { generateDescription, rewriteWithBackend, guessColorsWithBackend, rewriteFacts } from '../extension/src/rewriter.js';
import { runChecks } from '../scripts/check-deploy.mjs';

hermetic();

const ANTHROPIC = 'api.anthropic.com';
const API_KEY = 'anthropic-key-for-the-function-tests';
const MODEL = 'test-model'; // not in the function's price table: priced at its high default, $10 in and $50 out per million tokens
const ENV = { ANTHROPIC_API_KEY: API_KEY, REWRITE_MODEL: MODEL, MONTHLY_COST_CAP_USD: '25', RATE_LIMIT_PER_MINUTE: '20' };
const ORIGIN = 'https://www.example-motors.test';
const SISTER = 'https://www.sister-motors.test';
const D1 = uuid(1);
const D2 = uuid(2);
const U1 = uuid(11); // salesperson at D1
const U3 = uuid(13); // salesperson at both stores
const U4 = uuid(14); // in no dealership
const TOKEN = { u1: 'token-of-u1', u3: 'token-of-u3', u4: 'token-of-u4' };
const ENDPOINT = `${SUPABASE_URL}/functions/v1/rewrite`;

const VEHICLE = {
  vin: '1TESTVEH0NA000123', year: 2021, make: 'Example', model: 'Sedan', trim: 'LX', mileage: 34567, stock: 'A123', price: 20986,
  features: ['Heated seats', 'Backup camera', 'Bluetooth'], carfaxOneOwner: false, carfaxUrl: null, exteriorColor: 'Gray', interiorColor: 'Black',
  bodyType: 'Sedan', engine: '2.0L I4', transmission: 'Automatic', drivetrain: 'FWD', fuelType: 'Gasoline', descriptionRaw: '',
};
const DEALER = { name: 'Example Motors', city: 'Springfield' };
const SALESPERSON = { name: 'Sam', title: 'sales consultant' };
const FACTS = rewriteFacts({ vehicle: VEHICLE, dealer: DEALER, salesperson: SALESPERSON, narrative: [] });
const GOOD = "This 2021 Example Sedan LX is ready for its next driver. It shows 34,567 miles and has a gray exterior with a black interior. You get heated seats, a backup camera and Bluetooth, with a smooth automatic transmission and front-wheel drive. It is a comfortable, easy car for daily errands and longer weekend drives alike. Stop by for a look and a test drive whenever it suits you, and I will have it pulled up and ready. Send me a message with any questions about it. I'm Sam, sales consultant at Example Motors.";
const BAD = 'This 2021 Example Sedan is in perfect condition and has 99,999 miles.';

function world({ subscription = null, usage = [] } = {}) {
  fake.reset({
    users: { [TOKEN.u1]: { id: U1, email: 'sam@example-motors.test' }, [TOKEN.u3]: { id: U3, email: 'kim@example-motors.test' }, [TOKEN.u4]: { id: U4, email: 'new@example.test' } },
    rows: {
      dealerships: [{ id: D1, name: 'Example Motors', website_origin: ORIGIN }, { id: D2, name: 'Sister Motors', website_origin: SISTER }],
      // U3's sister-store row comes first on purpose: it is what the handler
      // falls back to, so only an origin can bill U3's work to D1
      memberships: [
        { user_id: U1, dealership_id: D1, role: 'salesperson' },
        { user_id: U3, dealership_id: D2, role: 'salesperson' },
        { user_id: U3, dealership_id: D1, role: 'salesperson' },
      ],
      ...(subscription ? { subscriptions: [{ dealership_id: D1, ...subscription }] } : {}),
      rewrite_usage: usage,
    },
  });
}

// The Anthropic API: each call takes the next answer from `answers` (the last one repeats).
function anthropic(...answers) {
  let i = 0;
  net.route(ANTHROPIC, () => answers[Math.min(i++, answers.length - 1)]);
}
const says = (text, { stop = 'end_turn', input = 1000, output = 200 } = {}) => ({ status: 200, body: { model: MODEL, stop_reason: stop, content: text === null ? [] : [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output } } });
const requests = () => net.to(ANTHROPIC).map((c) => ({ ...c, json: JSON.parse(c.body) }));

const rewrite = (handler, token, body = { ...FACTS, origin: ORIGIN }, extra = {}) => invoke(handler, { path: 'rewrite/rewrite', token, body, ...extra });
const load = (vars = {}) => loadFunction('rewrite', { ...ENV, ...vars });

test('rewrite: the preflight answers the extension; an unknown route or method is 404; the bare /rewrite is the rewrite route', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  const pre = await invoke(handler, { method: 'OPTIONS', path: 'rewrite/rewrite' });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [204, EXTENSION_ORIGIN]);
  for (const [method, path] of [['GET', 'rewrite/rewrite'], ['POST', 'rewrite/health'], ['POST', 'rewrite/other'], ['GET', 'rewrite/color']]) {
    const r = await invoke(handler, { method, path, token: TOKEN.u1, body: method === 'GET' ? undefined : FACTS });
    assert.deepEqual([r.status, r.body], [404, { ok: false, error: 'not found' }], `${method} ${path}`);
  }
  assert.equal(fake.calls.length, 0);
  const bare = await invoke(handler, { path: 'rewrite', token: TOKEN.u1, body: { ...FACTS, origin: ORIGIN } });
  assert.deepEqual([bare.status, bare.body.ok], [200, true]);
});

test('rewrite: no token and a rejected token are 401, on every route, before anything is spent', async () => {
  world();
  const handler = await load();
  for (const [method, path] of [['POST', 'rewrite/rewrite'], ['POST', 'rewrite/color'], ['GET', 'rewrite/health']]) {
    const none = await invoke(handler, { method, path, body: method === 'GET' ? undefined : FACTS });
    assert.deepEqual([none.status, none.body], [401, { ok: false, error: 'sign in to use this (no token was sent)' }]);
    const bad = await invoke(handler, { method, path, token: 'expired', body: method === 'GET' ? undefined : FACTS });
    assert.deepEqual([bad.status, bad.body.error], [401, 'sign in again (the token was rejected or has expired)']);
  }
  assert.equal(net.calls.length, 0);
  assert.deepEqual(fake.calls.map((c) => c.op), ['getUser', 'getUser', 'getUser']);
});

test('rewrite: a person in no dealership is 403; an origin none of their dealerships has is 403; the origin picks the store for a person in two, on /rewrite and /color, and never reaches Anthropic', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  const stranger = await rewrite(handler, TOKEN.u4);
  assert.deepEqual([stranger.status, stranger.body], [403, { ok: false, error: 'your account is not in a dealership yet: redeem an invite code first' }]);
  const elsewhere = await rewrite(handler, TOKEN.u1, { ...FACTS, origin: SISTER });
  assert.deepEqual([elsewhere.status, elsewhere.body], [403, { ok: false, error: `your account is not a member of the dealership for ${SISTER}` }]);
  assert.equal(net.calls.length, 0);
  // U3's first membership is the sister store (see world()), so a row below
  // that lands on D1 got there by its origin, not by the fallback.
  // A person in both stores is billed to the store whose origin came with the facts, however it is written.
  const both = await rewrite(handler, TOKEN.u3, { ...FACTS, origin: 'HTTPS://WWW.Example-Motors.test/' });
  assert.equal(both.status, 200);
  // /color takes an origin the same way
  const photos = ['https://img.example.test/1.jpg'];
  const color = await invoke(handler, { path: 'rewrite/color', token: TOKEN.u3, body: { photos, origin: ORIGIN } });
  assert.equal(color.status, 200);
  // and the extension's own colour guess sends it
  const ext = await guessColorsWithBackend({ endpoint: ENDPOINT, key: TOKEN.u3, photos, options: ['Gray'], origin: ORIGIN, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.equal(ext.ok, true, ext.error);
  // with no origin (an older extension) the first membership pays: the sister store here
  const older = await invoke(handler, { path: 'rewrite/color', token: TOKEN.u3, body: { photos } });
  assert.equal(older.status, 200);
  assert.deepEqual(fake.rows('rewrite_usage').map((u) => [u.dealership_id, u.user_id, u.kind]), [[D1, U3, 'rewrite'], [D1, U3, 'color'], [D1, U3, 'color'], [D2, U3, 'color']]);
  const calls = requests();
  assert.equal(calls.length, 4);
  for (const call of calls) assert.doesNotMatch(call.body, /example-motors\.test/i, 'the origin picks the store; it is not sent to Anthropic');
});

test('rewrite: the checks come in their order: the body (400) before the membership (403), the membership before the plan (402), the plan before the cap (429)', async () => {
  const full = [{ dealership_id: D1, user_id: U1, model: MODEL, cost_usd: 30, kind: 'rewrite' }];
  world({ subscription: { status: 'canceled', stripe_subscription_id: 'sub_1' }, usage: full });
  anthropic(says(GOOD));
  const handler = await load();
  assert.equal((await rewrite(handler, TOKEN.u4, undefined, { raw: 'not JSON' })).status, 400, 'a stranger\'s bad body is a bad body');
  assert.equal((await rewrite(handler, TOKEN.u4)).status, 403);
  assert.equal((await rewrite(handler, TOKEN.u1, { ...FACTS, origin: SISTER })).status, 403, 'an origin not theirs, even for a lapsed store');
  assert.equal((await rewrite(handler, TOKEN.u1)).status, 402, 'lapsed and over the cap: the plan is what they are told');
  world({ usage: full });
  const capped = await rewrite(handler, TOKEN.u1);
  assert.deepEqual([capped.status, capped.body.error.startsWith('monthly cost cap of $25 reached')], [429, true]);
  assert.equal(net.calls.length, 0);
});

test('rewrite: a lapsed plan is 402 with code lapsed and the plan on every route, read with the caller\'s token, and nothing is spent', async () => {
  world({ subscription: { status: 'past_due', stripe_subscription_id: 'sub_1', seats: 5 } });
  anthropic(says(GOOD));
  const handler = await load();
  const expected = { ok: false, error: LAPSED_MESSAGE, code: 'lapsed', plan: { state: 'lapsed', pilotEndsAt: null, currentPeriodEnd: null, seats: 5 } };
  for (const [method, path, body] of [['POST', 'rewrite/rewrite', { ...FACTS, origin: ORIGIN }], ['POST', 'rewrite/color', { photos: ['https://img.example.test/1.jpg'] }], ['GET', 'rewrite/health', undefined]]) {
    const r = await invoke(handler, { method, path, token: TOKEN.u1, body });
    assert.deepEqual([r.status, r.body], [402, expected], path);
  }
  assert.equal(net.calls.length, 0, 'no model call');
  assert.equal(fake.queries('rewrite_usage').length, 0, 'the cap is not even read');
  assert.ok(fake.clients.every((c) => c.key === ANON_KEY), 'no service-role client is made for a lapsed store');
  for (const read of fake.queries('subscriptions')) assert.deepEqual([read.key, read.token], [ANON_KEY, TOKEN.u1]);

  // the extension turns it into the note the side panel recognises
  const d = await generateDescription({ vehicle: VEHICLE, dealer: DEALER, salesperson: SALESPERSON, settings: { rewrite: { enabled: true, endpoint: ENDPOINT, key: TOKEN.u1 } }, origin: ORIGIN, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.equal(d.source, 'template');
  assert.ok(d.note.includes(LAPSED_MESSAGE), d.note);
});

test('rewrite: the per-user brake counts /rewrite and /color, comes before the membership and the body, and leaves /health alone', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load({ RATE_LIMIT_PER_MINUTE: '2' });
  assert.equal((await rewrite(handler, TOKEN.u1)).status, 200);
  assert.equal((await invoke(handler, { path: 'rewrite/color', token: TOKEN.u1, body: { photos: [] } })).status, 400, 'a refused body still counts');
  const third = await rewrite(handler, TOKEN.u1);
  assert.deepEqual([third.status, third.body], [429, { ok: false, error: 'too many requests; slow down' }]);
  assert.equal((await invoke(handler, { method: 'GET', path: 'rewrite/health', token: TOKEN.u1 })).status, 200);
  // a stranger meets the brake before the membership check
  assert.equal((await rewrite(handler, TOKEN.u4)).status, 403);
  assert.equal((await rewrite(handler, TOKEN.u4)).status, 403);
  assert.equal((await rewrite(handler, TOKEN.u4)).status, 429);
  assert.equal(requests().length, 1);
});

test('rewrite: bad bodies are 400 with the function\'s sentence: over 64 KiB, not JSON, facts without a make or model, color without an https photo', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  const big = await rewrite(handler, TOKEN.u1, { ...FACTS, origin: ORIGIN, narrative: ['x'.repeat(64 * 1024)] });
  assert.deepEqual([big.status, big.body], [400, { ok: false, error: 'request too large' }]);
  const notJson = await rewrite(handler, TOKEN.u1, undefined, { raw: '{"make":' });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /^bad JSON: /);
  const noModel = await rewrite(handler, TOKEN.u1, { ...FACTS, model: '', origin: ORIGIN });
  assert.deepEqual([noModel.status, noModel.body], [400, { ok: false, error: 'facts are missing (year, make, model, ...)' }]);
  const noPhotos = await invoke(handler, { path: 'rewrite/color', token: TOKEN.u1, body: { photos: ['http://img.example.test/1.jpg', 42] } });
  assert.deepEqual([noPhotos.status, noPhotos.body], [400, { ok: false, error: 'photos are missing (1 to 4 https addresses)' }]);
  assert.equal(net.calls.length, 0);
});

test('rewrite: facts with no dealership name are 400 before the model is asked, since no draft can name it; nothing is spent, and the extension shows its template with the reason', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  for (const dealer of [{ name: '' }, { name: '   ', city: 'Springfield' }, {}, undefined]) {
    const r = await rewrite(handler, TOKEN.u1, { ...FACTS, dealer, origin: ORIGIN });
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: "the dealership's name is missing: add it in Settings" }], JSON.stringify(dealer));
  }
  assert.equal(net.to(ANTHROPIC).length, 0, 'no model call');
  assert.equal(fake.rows('rewrite_usage').length, 0, 'nothing logged or paid for');
  // an older extension that still asks gets its template and this reason
  const facts = { ...FACTS, dealer: { name: '' }, origin: ORIGIN };
  const direct = await rewriteWithBackend({ endpoint: ENDPOINT, key: TOKEN.u1, facts, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.deepEqual([direct.ok, direct.error], [false, "the dealership's name is missing: add it in Settings"]);
});

test('rewrite: a draft that passes answers the documented shape, logs its cost with the service role, and never sends the origin or a VIN', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  const r = await rewrite(handler, TOKEN.u1, { ...FACTS, origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.deepEqual(keysOf(r.body), ['costUsd', 'error', 'guardrails', 'model', 'ok', 'text']);
  assert.deepEqual(r.body, { ok: true, text: GOOD, model: MODEL, guardrails: { ok: true, problems: [], words: 93 }, costUsd: 0.02, error: '' });
  const [call] = requests();
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual([call.headers['x-api-key'], call.headers['anthropic-version']], [API_KEY, '2023-06-01']);
  assert.deepEqual([call.json.model, call.json.max_tokens, typeof call.json.system], [MODEL, 600, 'string']);
  assert.doesNotMatch(call.body, /example-motors\.test/, 'the origin is the function\'s, not a fact for the prompt');
  assert.doesNotMatch(call.body, new RegExp(VEHICLE.vin), 'no VIN goes up');
  const [row] = fake.rows('rewrite_usage');
  assert.deepEqual({ ...row, id: undefined, at: undefined }, { id: undefined, at: undefined, dealership_id: D1, user_id: U1, model: MODEL, input_tokens: 1000, output_tokens: 200, cost_usd: 0.02, kind: 'rewrite' });
  for (const q of fake.queries('rewrite_usage')) assert.equal(q.key, SERVICE_KEY, `${q.op} rewrite_usage with the service role`);
  assert.doesNotMatch(r.text + logs.join('\n'), new RegExp(API_KEY), 'the API key is never answered or logged');
});

test('rewrite: the extension\'s own rewriter against the real handler: the draft comes back, gets its VIN line and is shown', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  const d = await generateDescription({ vehicle: VEHICLE, dealer: DEALER, salesperson: SALESPERSON, settings: { rewrite: { enabled: true, endpoint: ENDPOINT, key: TOKEN.u1 } }, origin: ORIGIN, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.notEqual(d.source, 'template', d.note); // the service's draft, not the fallback
  assert.equal(d.text, `${GOOD}\nVIN ${VEHICLE.vin}.`);
  assert.equal(d.model, MODEL);
  const direct = await rewriteWithBackend({ endpoint: ENDPOINT, key: TOKEN.u1, facts: { ...FACTS, origin: ORIGIN }, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.deepEqual([direct.ok, direct.problems], [true, []]);
});

test('rewrite: a draft the guardrails refuse is written once more with the problems spelled out, then given up on; both calls are logged and paid for', async () => {
  world();
  anthropic(says(BAD), says(BAD, { input: 1200, output: 100 }));
  const handler = await load();
  const r = await rewrite(handler, TOKEN.u1);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.text, r.body.error], [false, BAD, 'the draft failed the checks twice']);
  assert.deepEqual(r.body.guardrails.problems.map((p) => p.code).sort(), ['banned-phrase', 'no-dealer', 'no-role', 'too-short', 'unknown-number']);
  assert.equal(r.body.costUsd, 0.037, '$0.02 and $0.017');
  const [first, second] = requests();
  assert.doesNotMatch(first.json.messages[0].content, /previous draft failed/);
  const fixes = second.json.messages[0].content.split('Your previous draft failed these checks')[1] || '';
  for (const problem of r.body.guardrails.problems) assert.ok(fixes.includes(problem.text), `the second prompt names: ${problem.text}`);
  assert.equal(fake.rows('rewrite_usage').length, 2);
  // the extension shows its template and says why
  const d = await generateDescription({ vehicle: VEHICLE, dealer: DEALER, salesperson: SALESPERSON, settings: { rewrite: { enabled: true, endpoint: ENDPOINT, key: TOKEN.u1 } }, origin: ORIGIN, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.equal(d.source, 'template');
  assert.match(d.note, /the draft failed the checks twice/);
});

test('rewrite: a draft that names the dealership but not the salesperson\'s role is refused and asked for again; their own title is the role checked', async () => {
  world();
  const noRole = GOOD.replace("I'm Sam, sales consultant at Example Motors.", 'Ask for Sam at Example Motors.');
  assert.doesNotMatch(noRole, /sales consultant/);
  anthropic(says(noRole), says(noRole));
  const handler = await load();
  const r = await rewrite(handler, TOKEN.u1);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.guardrails.problems.map((p) => p.code), ['no-role']);
  const fixes = requests()[1].json.messages[0].content.split('Your previous draft failed these checks')[1] || '';
  assert.match(fixes, /Doesn't give your role \(sales consultant\)/, 'the second prompt asks for the role');
  // the salesperson's own title is the role checked
  world();
  anthropic(says(GOOD));
  const manager = await rewrite(handler, TOKEN.u1, { ...FACTS, salesperson: { name: 'Sam', title: 'sales manager' } });
  assert.deepEqual(manager.body.guardrails.problems.map((p) => p.code), ['no-role']);
});

test('rewrite: a model that declines is not asked again; the answer says so', async () => {
  world();
  anthropic(says(null, { stop: 'refusal' }));
  const handler = await load();
  const r = await rewrite(handler, TOKEN.u1);
  assert.deepEqual([r.status, r.body.ok, r.body.text, r.body.error], [200, false, '', 'the model declined this request']);
  assert.equal(requests().length, 1);
  assert.equal(fake.rows('rewrite_usage').length, 1, 'the declined call is still paid for, so it counts toward the cap');
});

test('rewrite: upstream errors: a rejected key is 502 at once; 429 and 5xx are tried once more after a second, then 503 or 502; a network failure is retried, then 502', async (t) => {
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    waits.push(ms);
    fn();
    return 0;
  });
  const cases = [
    [[{ status: 401, body: { error: { message: 'invalid x-api-key' } } }], 502, 'the Anthropic API key was rejected', 1, []],
    [[{ status: 400, body: { error: { message: 'max_tokens is too large' } } }], 502, 'Anthropic API error 400: max_tokens is too large', 1, []],
    [[{ status: 529, body: {} }], 503, 'the Anthropic API is rate limiting; try again shortly', 2, [1000]],
    [[{ status: 500, body: { error: { message: 'overloaded' } } }], 502, 'Anthropic API error 500: overloaded', 2, [1000]],
    [[NETWORK_ERROR], 502, 'could not reach the Anthropic API', 2, []],
    [[{ status: 503, body: {} }, says(GOOD)], 200, '', 2, [1000]],
  ];
  for (const [answers, status, error, calls, expectedWaits] of cases) {
    world();
    net.calls = [];
    waits.length = 0;
    anthropic(...answers);
    const handler = await load();
    const r = await rewrite(handler, TOKEN.u1);
    assert.equal(r.status, status, error);
    if (status !== 200) assert.deepEqual(r.body, { ok: false, error });
    assert.equal(requests().length, calls, `${error}: calls`);
    assert.deepEqual(waits.filter((ms) => ms === 1000), expectedWaits, `${error}: waits`);
    assert.doesNotMatch(r.text, new RegExp(API_KEY));
  }
});

test('rewrite: the monthly cap sums this month\'s rows of the caller\'s dealership, page by page, and refuses with 429 before the model is asked', async () => {
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).toISOString();
  const row = (dealership_id, cost_usd, extra = {}) => ({ dealership_id, user_id: U1, model: MODEL, cost_usd, kind: 'rewrite', ...extra });
  // other stores' spend and last month's do not count
  world({ usage: [row(D2, 5), row(D1, 5, { at: lastMonth }), row(D1, 0.5)] });
  anthropic(says(GOOD));
  let handler = await load({ MONTHLY_COST_CAP_USD: '1' });
  assert.equal((await rewrite(handler, TOKEN.u1)).status, 200);
  // reaching the cap exactly is the cap
  world({ usage: [row(D1, 0.25), row(D1, 0.75)] });
  assert.equal((await rewrite(handler, TOKEN.u1)).status, 429);

  // 1,001 rows of $0.001: only a sum over both pages reaches a $1.0005 cap
  world({ usage: Array.from({ length: 1001 }, () => row(D1, 0.001)) });
  handler = await load({ MONTHLY_COST_CAP_USD: '1.0005' });
  net.calls = [];
  const capped = await rewrite(handler, TOKEN.u1);
  assert.deepEqual([capped.status, capped.body], [429, { ok: false, error: 'monthly cost cap of $1.0005 reached for your dealership; descriptions come from the built-in template until next month' }]);
  assert.equal(net.calls.length, 0, 'no model call at the cap');
  assert.deepEqual(fake.queries('rewrite_usage', 'select').map((q) => q.range), [[0, 999], [1000, 1999]]);
  const color = await invoke(handler, { path: 'rewrite/color', token: TOKEN.u1, body: { photos: ['https://img.example.test/1.jpg'] } });
  assert.equal(color.status, 429, '/color is capped too');
  const health = await invoke(handler, { method: 'GET', path: 'rewrite/health', token: TOKEN.u1 });
  assert.deepEqual([health.status, health.body.usd], [200, 1.001], 'the health route still answers, with the month\'s spend');
});

test('rewrite: /health answers the documented shape for the caller\'s dealership without an API key; /rewrite then says the key is missing', async () => {
  world({ usage: [{ dealership_id: D1, user_id: U1, model: MODEL, cost_usd: 1.23456, kind: 'rewrite' }] });
  const handler = await load({ ANTHROPIC_API_KEY: undefined, MONTHLY_COST_CAP_USD: '30', RATE_LIMIT_PER_MINUTE: '7' });
  const h = await invoke(handler, { method: 'GET', path: 'rewrite/health', token: TOKEN.u1 });
  assert.equal(h.status, 200);
  assert.deepEqual(keysOf(h.body), ['capUsd', 'dealership', 'model', 'month', 'ok', 'perMinute', 'usd']);
  assert.deepEqual(h.body, { ok: true, model: MODEL, month: new Date().toISOString().slice(0, 7), usd: 1.2346, capUsd: 30, perMinute: 7, dealership: 'Example Motors' });
  const r = await rewrite(handler, TOKEN.u1);
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: 'ANTHROPIC_API_KEY is not set on the function' }]);
});

test('rewrite: /color picks from the offered words only, sends at most four https photos, and answers the documented shape; the extension reads it', async () => {
  world();
  anthropic(says('Here you go: {"exterior":"gray","interior":"Plaid","confidence":"high"}', { input: 3000, output: 20 }));
  const handler = await load();
  const photos = ['https://img.example.test/1.jpg', 'http://img.example.test/2.jpg', 'https://img.example.test/3.jpg', 'https://img.example.test/4.jpg', 'https://img.example.test/5.jpg', 'https://img.example.test/6.jpg'];
  const options = ['Black', 'Gray', 'White'];
  const r = await invoke(handler, { path: 'rewrite/color', token: TOKEN.u1, body: { photos, options } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, exterior: 'Gray', interior: '', confidence: 'high', model: MODEL, costUsd: 0.031 });
  const [call] = requests();
  const images = call.json.messages[0].content.filter((b) => b.type === 'image').map((b) => b.source.url);
  assert.deepEqual(images, [photos[0], photos[2], photos[3], photos[4]]);
  assert.equal(fake.rows('rewrite_usage')[0].kind, 'color');
  const ext = await guessColorsWithBackend({ endpoint: ENDPOINT, key: TOKEN.u1, photos, options, fetchImpl: functionsFetch({ rewrite: handler }) });
  assert.deepEqual([ext.ok, ext.exterior, ext.interior, ext.confidence], [true, 'Gray', '', 'high']);
  // an answer that is not the JSON asked for
  anthropic(says('I cannot tell.'));
  const vague = await invoke(handler, { path: 'rewrite/color', token: TOKEN.u1, body: { photos } });
  assert.deepEqual([vague.status, vague.body.ok, vague.body.exterior, vague.body.confidence], [200, true, '', 'low']);
});

test('rewrite: a failed usage write is logged and the answer still goes back', async () => {
  world();
  anthropic(says(GOOD));
  const handler = await load();
  fake.script = (c) => (c.table === 'rewrite_usage' && c.op === 'insert' ? { error: { message: 'disk full', code: '53100' } } : undefined);
  const r = await rewrite(handler, TOKEN.u1);
  assert.deepEqual([r.status, r.body.ok], [200, true]);
  assert.ok(logs.some((l) => l.includes('rewrite_usage insert failed: disk full')), logs.join('\n'));
});

test('rewrite: scripts/check-deploy.mjs reads its rewrite lines as ok against the real handler', async () => {
  world();
  const rewrite = await load();
  const findings = await runChecks({ fetchImpl: functionsFetch({ rewrite }), url: SUPABASE_URL, anonKey: ANON_KEY });
  const mine = findings.filter((f) => f.check.startsWith('rewrite:'));
  assert.deepEqual(mine.map((f) => f.check), ['rewrite: answers the extension\'s CORS preflight', 'rewrite: refuses a call with no user token']);
  for (const f of mine) assert.equal(f.ok, true, `${f.check}: ${f.detail}`);
});
