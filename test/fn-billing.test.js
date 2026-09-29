// The billing function's real handler (supabase/functions/billing/index.ts)
// under Node, against the fake database (test/functions/) and a fake Stripe:
// the signed-in routes (401, 403, who may do what, checkout's refusals and
// the trial rule, the portal, the status the manager page's Billing card
// reads) and the webhook, with a real HMAC signature over the raw body (a bad
// or stale one refused, an event applied and stored once, a redelivery
// ignored, the row it lands on). The pure parts are in test/billing.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadFunction, invoke, fake, net, logs, hermetic, functionsFetch, uuid, keysOf, NETWORK_ERROR, SUPABASE_URL, ANON_KEY, SERVICE_KEY, EXTENSION_ORIGIN } from './functions/harness.mjs';
import { pgTime } from './functions/fake-supabase.mjs';
import { PRICING, OPEN_SUBSCRIPTION_MESSAGE, OPEN_SUBSCRIPTION_CODE } from '../supabase/functions/_shared/billing.mjs';
import { billingCard } from '../manager/data.js';
import { runChecks } from '../scripts/check-deploy.mjs';

hermetic();

const STRIPE = 'api.stripe.com';
const SECRET_KEY = 'stripe-secret-key-for-the-function-tests';
const WEBHOOK_SECRET = 'webhook-signing-secret-for-the-function-tests';
const MANAGER_PAGE = 'https://manage.example.test';
const ENV = {
  STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_ROOFTOP: 'price_rooftop_test', STRIPE_PRICE_SEAT: 'price_seat_test',
  ALLOWED_RETURN_ORIGINS: MANAGER_PAGE, ALLOWED_ORIGINS: MANAGER_PAGE,
};
const ORIGIN = 'https://www.example-motors.test';
const SISTER = 'https://www.sister-motors.test';
const D1 = uuid(1);
const D2 = uuid(2);
const U1 = uuid(11); // salesperson at D1
const U2 = uuid(12); // manager at D1
const U4 = uuid(14); // in no dealership
const U5 = uuid(15); // manager at both stores
const TOKEN = { u1: 'token-of-u1', u2: 'token-of-u2', u4: 'token-of-u4', u5: 'token-of-u5' };
const RETURN_URL = `${MANAGER_PAGE}/?view=billing`;
const DAY = 24 * 3600 * 1000;
const iso = (t) => new Date(t).toISOString();

function world({ subscriptions = [] } = {}) {
  fake.reset({
    users: {
      [TOKEN.u1]: { id: U1, email: 'sam@example-motors.test' },
      [TOKEN.u2]: { id: U2, email: 'max@example-motors.test' },
      [TOKEN.u4]: { id: U4, email: 'new@example.test' },
      [TOKEN.u5]: { id: U5, email: 'lee@example-motors.test' },
    },
    rows: {
      dealerships: [{ id: D1, name: 'Example Motors', website_origin: ORIGIN }, { id: D2, name: 'Sister Motors', website_origin: SISTER }],
      memberships: [
        { user_id: U1, dealership_id: D1, role: 'salesperson' },
        { user_id: U2, dealership_id: D1, role: 'manager' },
        { user_id: U5, dealership_id: D1, role: 'manager' },
        { user_id: U5, dealership_id: D2, role: 'manager' },
      ],
      subscriptions,
    },
  });
}

// A small Stripe: customers (some deleted), Checkout and portal sessions. Every call is in net.calls.
function stripe({ customers = {}, fail = null } = {}) {
  net.route(STRIPE, (call) => {
    if (fail) return fail(call);
    const form = new URLSearchParams(call.body);
    const m = /^\/v1\/customers\/([^/]+)$/.exec(call.path);
    if (call.method === 'GET' && m) {
      const c = customers[decodeURIComponent(m[1])];
      return c ? { status: 200, body: { id: m[1], object: 'customer', ...c } } : { status: 404, body: { error: { message: `No such customer: '${m[1]}'`, code: 'resource_missing' } } };
    }
    if (call.method === 'POST' && call.path === '/v1/customers') return { status: 200, body: { id: 'cus_new', object: 'customer', name: form.get('name') } };
    if (call.method === 'POST' && call.path === '/v1/checkout/sessions') return { status: 200, body: { id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } };
    if (call.method === 'POST' && call.path === '/v1/billing_portal/sessions') return { status: 200, body: { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/bps_1' } };
    return { status: 404, body: { error: { message: `Unrecognized request URL (${call.method}: ${call.path})` } } };
  });
}
const stripeCalls = () => net.to(STRIPE).map((c) => ({ ...c, form: Object.fromEntries(new URLSearchParams(c.body)) }));

const load = (vars = {}) => loadFunction('billing', { ...ENV, ...vars });
const status = (handler, token, query = '') => invoke(handler, { method: 'GET', path: `billing/status${query}`, token });
const post = (handler, route, token, body = {}) => invoke(handler, { path: `billing/${route}`, token, body: { returnUrl: RETURN_URL, ...body } });

// ---------- the webhook's signature, made the way Stripe makes it ----------

const sign = (raw, { t = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET } = {}) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
const deliver = (handler, raw, signature = sign(raw), extra = {}) => invoke(handler, { path: 'billing/webhook', origin: '', raw, headers: { 'Content-Type': 'application/json', ...(signature ? { 'Stripe-Signature': signature } : {}), ...extra } });
const subscriptionEvent = (over = {}, object = {}) => ({
  id: 'evt_1', object: 'event', type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000),
  ...over,
  data: {
    object: {
      id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'trialing', metadata: {},
      items: { data: [{ price: { id: 'price_rooftop_test' }, quantity: 1, current_period_end: 1790000000 }, { price: { id: 'price_seat_test' }, quantity: 2, current_period_end: 1790000000 }] },
      ...object,
    },
  },
});

// ---------- the routes ----------

test('billing: the preflight answers the extension and the manager page; unknown routes and methods are 404, the webhook\'s GET included', async () => {
  world();
  const handler = await load();
  for (const origin of [EXTENSION_ORIGIN, MANAGER_PAGE]) {
    const pre = await invoke(handler, { method: 'OPTIONS', path: 'billing/checkout', origin });
    assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [204, origin]);
  }
  for (const [method, path] of [['GET', 'billing/checkout'], ['POST', 'billing/status'], ['GET', 'billing/webhook'], ['POST', 'billing'], ['POST', 'billing/refund']]) {
    const r = await invoke(handler, { method, path, token: TOKEN.u2, body: method === 'GET' ? undefined : {} });
    assert.deepEqual([r.status, r.body], [404, { ok: false, error: 'not found' }], `${method} ${path}`);
  }
  assert.equal(fake.calls.length, 0);
});

test('billing: status, checkout and portal are 401 without a token or with a rejected one', async () => {
  world();
  const handler = await load();
  for (const call of [() => status(handler, ''), () => post(handler, 'checkout', ''), () => post(handler, 'portal', ''), () => status(handler, 'expired'), () => post(handler, 'checkout', 'expired')]) {
    const r = await call();
    assert.equal(r.status, 401);
    assert.match(r.body.error, /^sign in /);
  }
  assert.equal(net.calls.length, 0);
});

test('billing: 403 for a person in no dealership or asking about one they are not in; a salesperson reads the status but cannot open Checkout or the portal', async () => {
  world();
  stripe();
  const handler = await load();
  const stranger = await status(handler, TOKEN.u4);
  assert.deepEqual([stranger.status, stranger.body], [403, { ok: false, error: 'your account is not in a dealership yet: redeem an invite code first' }]);
  for (const query of [`?dealershipId=${D2}`, `?origin=${encodeURIComponent(SISTER)}`]) {
    const r = await status(handler, TOKEN.u1, query);
    assert.deepEqual([r.status, r.body], [403, { ok: false, error: 'your account is not a member of that dealership' }], query);
  }
  const seller = await status(handler, TOKEN.u1);
  assert.equal(seller.status, 200);
  assert.deepEqual([seller.body.role, seller.body.canStartPilot, seller.body.canSubscribe, seller.body.canManageBilling], ['salesperson', false, false, false]);
  for (const route of ['checkout', 'portal']) {
    const r = await post(handler, route, TOKEN.u1, { dealershipId: D1 });
    assert.deepEqual([r.status, r.body], [403, { ok: false, error: 'only a manager of the dealership can do this' }], route);
  }
  assert.equal(net.calls.length, 0);
});

test('billing: status answers the documented shape for the dealership asked for, by id, by origin or the only one; the manager page\'s Billing card reads it', async () => {
  world({ subscriptions: [{ dealership_id: D2, status: 'active', stripe_customer_id: 'cus_2', stripe_subscription_id: 'sub_2', current_period_end: '2026-10-29T00:00:00Z', seats: 7 }] });
  const handler = await load();
  const none = await status(handler, TOKEN.u2);
  assert.equal(none.status, 200);
  assert.deepEqual(keysOf(none.body), ['canManageBilling', 'canStartPilot', 'canSubscribe', 'dealership', 'includedSalespeople', 'ok', 'pilotDays', 'role', 'state', 'subscription']);
  assert.deepEqual(none.body, { ok: true, dealership: { id: D1, name: 'Example Motors', websiteOrigin: ORIGIN }, role: 'manager', state: 'none', subscription: null, canStartPilot: true, canSubscribe: true, canManageBilling: false, pilotDays: PRICING.pilotDays, includedSalespeople: PRICING.includedSalespeople });
  const card = billingCard(none.body);
  assert.deepEqual([card.label, card.buttons.map((b) => b.action)], ['No plan yet', ['pilot', 'subscribe']]);

  for (const query of [`?dealershipId=${D2}`, `?origin=${encodeURIComponent(SISTER + '/')}`]) {
    const paid = await status(handler, TOKEN.u5, query);
    assert.deepEqual([paid.status, paid.body.dealership.id, paid.body.state, paid.body.canManageBilling, paid.body.canSubscribe], [200, D2, 'active', true, false], query);
    assert.equal(paid.body.subscription.stripe_customer_id, 'cus_2');
    const c = billingCard(paid.body, { now: iso(Date.now()) });
    assert.deepEqual([c.label, c.buttons.map((b) => b.action)], ['Subscribed', ['portal']]);
    assert.match(c.line, /^Subscribed: 7 salespeople, renews /);
  }
  for (const read of fake.queries('subscriptions')) assert.equal(read.key, SERVICE_KEY, 'the billing function reads the row with the service role');
  // no brake on the status
  for (let i = 0; i < 15; i += 1) assert.equal((await status(handler, TOKEN.u2)).status, 200);
});

test('billing: checkout for a store with no plan makes a Stripe customer carrying the dealership id, keeps it on the row, and answers the Checkout address', async () => {
  world();
  stripe();
  const handler = await load();
  const r = await post(handler, 'checkout', TOKEN.u2, { dealershipId: D1 });
  assert.deepEqual([r.status, r.body], [200, { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_1' }]);
  const [customer, session] = stripeCalls();
  assert.deepEqual([customer.method, customer.path], ['POST', '/v1/customers']);
  assert.deepEqual(customer.form, { name: 'Example Motors', email: 'max@example-motors.test', 'metadata[dealership_id]': D1, 'metadata[website_origin]': ORIGIN });
  assert.equal(customer.headers['idempotency-key'], `lotsync-customer-${D1}-first`, 'two clicks make one customer');
  for (const c of [customer, session]) {
    assert.equal(c.headers.authorization, `Bearer ${SECRET_KEY}`);
    assert.equal(c.headers['content-type'], 'application/x-www-form-urlencoded');
  }
  assert.equal(fake.rows('subscriptions')[0].stripe_customer_id, 'cus_new');
  assert.deepEqual([session.method, session.path], ['POST', '/v1/checkout/sessions']);
  assert.deepEqual(session.form, {
    mode: 'subscription', customer: 'cus_new', client_reference_id: D1,
    'line_items[0][price]': 'price_rooftop_test', 'line_items[0][quantity]': '1',
    success_url: `${MANAGER_PAGE}/?view=billing&billing=success`, cancel_url: `${MANAGER_PAGE}/?view=billing&billing=canceled`,
    allow_promotion_codes: 'true', 'subscription_data[metadata][dealership_id]': D1,
  });
  assert.match(session.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  for (const w of fake.writes()) assert.equal(w.key, SERVICE_KEY);
  assert.doesNotMatch(r.text + logs.join('\n'), new RegExp(SECRET_KEY), 'the secret key is never answered or logged');
});

test('billing: checkout bills seats above the included count on the seat price, and picks the store by origin for a manager of two', async () => {
  world();
  stripe();
  const handler = await load();
  const r = await post(handler, 'checkout', TOKEN.u5, { origin: SISTER, seats: 7 });
  assert.equal(r.status, 200);
  const session = stripeCalls().find((c) => c.path === '/v1/checkout/sessions');
  assert.deepEqual([session.form.client_reference_id, session.form['line_items[1][price]'], session.form['line_items[1][quantity]']], [D2, 'price_seat_test', '2']);
});

test('billing: during a pilot with more than 48 hours left the subscription starts as a trial that ends with the pilot; under 48 hours it is charged at once', async () => {
  const pilotEnds = Date.now() + 10 * DAY;
  world({ subscriptions: [{ dealership_id: D1, status: 'pilot', pilot_ends_at: iso(pilotEnds), stripe_customer_id: 'cus_1' }] });
  stripe({ customers: { cus_1: { metadata: { dealership_id: D1 } } } });
  const handler = await load();
  assert.equal((await post(handler, 'checkout', TOKEN.u2)).status, 200);
  const calls = stripeCalls();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/customers/cus_1', 'POST /v1/checkout/sessions'], 'the row\'s live customer is used, no new one');
  assert.equal(calls[1].form['subscription_data[trial_end]'], String(Math.floor(pilotEnds / 1000)));

  world({ subscriptions: [{ dealership_id: D1, status: 'pilot', pilot_ends_at: iso(Date.now() + DAY), stripe_customer_id: 'cus_1' }] });
  net.calls = [];
  assert.equal((await post(handler, 'checkout', TOKEN.u2)).status, 200);
  assert.equal(stripeCalls()[1].form['subscription_data[trial_end]'], undefined);
});

test('billing: a customer deleted in Stripe is replaced, under an idempotency key naming the old one', async () => {
  world({ subscriptions: [{ dealership_id: D1, status: 'canceled', stripe_customer_id: 'cus_old', stripe_subscription_id: 'sub_old' }] });
  stripe({ customers: { cus_old: { deleted: true } } });
  const handler = await load();
  assert.equal((await post(handler, 'checkout', TOKEN.u2)).status, 200);
  const [, created] = stripeCalls();
  assert.deepEqual([created.path, created.headers['idempotency-key']], ['/v1/customers', `lotsync-customer-${D1}-cus_old`]);
  assert.equal(fake.rows('subscriptions')[0].stripe_customer_id, 'cus_new');
});

test('billing: checkout refuses a store that pays with 409, and one Stripe still holds open with 409 and code open-subscription; a canceled one may pay again', async () => {
  stripe({ customers: { cus_1: {} } });
  const handler = await load();
  world({ subscriptions: [{ dealership_id: D1, status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }] });
  const active = await post(handler, 'checkout', TOKEN.u2);
  assert.deepEqual([active.status, active.body], [409, { ok: false, error: 'this dealership already has a subscription; use the billing portal to change it' }]);
  for (const s of ['past_due', 'unpaid', 'incomplete', 'paused']) {
    world({ subscriptions: [{ dealership_id: D1, status: s, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }] });
    const open = await post(handler, 'checkout', TOKEN.u2);
    assert.deepEqual([open.status, open.body], [409, { ok: false, error: OPEN_SUBSCRIPTION_MESSAGE, code: OPEN_SUBSCRIPTION_CODE }], s);
  }
  assert.equal(net.calls.length, 0, 'Stripe is not asked for a second subscription');
  world({ subscriptions: [{ dealership_id: D1, status: 'canceled', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }] });
  assert.equal((await post(handler, 'checkout', TOKEN.u2)).status, 200);
});

test('billing: a body over 16 KiB or not JSON is 400; a returnUrl off ALLOWED_RETURN_ORIGINS is 400; a missing price or key is 500 naming it; Stripe\'s refusals come back as 502 with its sentence', async () => {
  world();
  stripe();
  let handler = await load();
  const big = await post(handler, 'checkout', TOKEN.u2, { note: 'x'.repeat(16 * 1024) });
  assert.deepEqual([big.status, big.body], [400, { ok: false, error: 'request too large' }]);
  const notJson = await invoke(handler, { path: 'billing/portal', token: TOKEN.u2, raw: '{"returnUrl":' });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /^bad JSON: /);
  for (const returnUrl of ['https://evil.example.test/', `https://user:pw@${MANAGER_PAGE.slice(8)}/`, 'javascript:alert(1)', '']) {
    const r = await post(handler, 'checkout', TOKEN.u2, { returnUrl });
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'returnUrl must be a page on one of the origins in ALLOWED_RETURN_ORIGINS' }], returnUrl);
  }
  handler = await load({ STRIPE_PRICE_ROOFTOP: undefined });
  assert.deepEqual((await post(handler, 'checkout', TOKEN.u2)).body, { ok: false, error: 'STRIPE_PRICE_ROOFTOP is not set on the function' });
  handler = await load({ STRIPE_PRICE_SEAT: undefined });
  const seats = await post(handler, 'checkout', TOKEN.u2, { seats: 6 });
  assert.deepEqual([seats.status, seats.body.error], [500, `STRIPE_PRICE_SEAT is not set on the function, so seats above the included ${PRICING.includedSalespeople} cannot be billed`]);
  assert.equal(net.calls.length, 0, 'nothing is created in Stripe before the line items are known');
  handler = await load({ STRIPE_SECRET_KEY: undefined });
  assert.deepEqual((await post(handler, 'checkout', TOKEN.u2)).body, { ok: false, error: 'STRIPE_SECRET_KEY is not set on the function' });

  handler = await load();
  stripe({ fail: () => ({ status: 401, body: { error: { message: `Invalid API Key provided: ${SECRET_KEY}` } } }) });
  const rejected = await post(handler, 'checkout', TOKEN.u2);
  assert.deepEqual([rejected.status, rejected.body], [502, { ok: false, error: 'Stripe rejected the secret key set on the function' }]);
  stripe({ fail: () => ({ status: 400, body: { error: { message: 'No such price: \'price_rooftop_test\'', code: 'resource_missing' } } }) });
  const refused = await post(handler, 'checkout', TOKEN.u2);
  assert.deepEqual([refused.status, refused.body], [502, { ok: false, error: 'No such price: \'price_rooftop_test\'' }]);
  stripe({ fail: () => NETWORK_ERROR });
  assert.deepEqual((await post(handler, 'checkout', TOKEN.u2)).body, { ok: false, error: 'could not reach Stripe; try again in a moment' });
});

test('billing: the portal is 404 until a customer exists, then a portal session for it that returns to the page', async () => {
  world();
  stripe();
  const handler = await load();
  const early = await post(handler, 'portal', TOKEN.u2);
  assert.deepEqual([early.status, early.body], [404, { ok: false, error: 'this dealership has no billing account yet: subscribe first' }]);
  world({ subscriptions: [{ dealership_id: D1, status: 'past_due', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }] });
  const r = await post(handler, 'portal', TOKEN.u2, { dealershipId: D1 });
  assert.deepEqual([r.status, r.body], [200, { ok: true, url: 'https://billing.stripe.com/p/session/bps_1' }]);
  const [call] = stripeCalls();
  assert.deepEqual([call.path, call.form], ['/v1/billing_portal/sessions', { customer: 'cus_1', return_url: RETURN_URL }]);
  assert.match(call.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
});

test('billing: checkout and the portal are braked at 10 a minute per manager; the status is not', async () => {
  world({ subscriptions: [{ dealership_id: D1, stripe_customer_id: 'cus_1' }] });
  stripe({ customers: { cus_1: {} } });
  const handler = await load();
  for (let i = 0; i < 10; i += 1) assert.equal((await post(handler, i % 2 ? 'portal' : 'checkout', TOKEN.u2)).status, 200, `call ${i + 1}`);
  const r = await post(handler, 'portal', TOKEN.u2);
  assert.deepEqual([r.status, r.body], [429, { ok: false, error: 'too many requests; slow down' }]);
  assert.equal((await status(handler, TOKEN.u2)).status, 200);
  assert.equal((await post(handler, 'checkout', TOKEN.u5, { dealershipId: D2 })).status, 200, 'another manager is not held back');
});

// ---------- the webhook ----------

test('billing: an event signed over its raw body is applied to the dealership\'s row once and stored once; a redelivery is acknowledged and not applied again', async () => {
  world({ subscriptions: [{ dealership_id: D1, stripe_customer_id: 'cus_1' }] });
  const handler = await load();
  const event = subscriptionEvent();
  const raw = JSON.stringify(event, null, 2); // Stripe's own spacing: the signature is over these bytes
  const r = await deliver(handler, raw);
  assert.deepEqual([r.status, r.body], [200, { ok: true, applied: true, attached: true }]);
  const [row] = fake.rows('subscriptions');
  assert.deepEqual(
    [row.status, row.stripe_subscription_id, row.seats, row.current_period_end, row.updated_at],
    ['trialing', 'sub_1', PRICING.includedSalespeople + 2, pgTime(iso(1790000000 * 1000)), pgTime(iso(event.created * 1000))],
  );
  const events = fake.rows('billing_events');
  assert.deepEqual(events.map((e) => [e.stripe_event_id, e.type]), [['evt_1', 'customer.subscription.created']]);
  assert.deepEqual(events[0].payload, event);
  assert.ok(fake.calls.every((c) => c.kind === 'query' && c.key === SERVICE_KEY && c.token === ''), 'no user token: the service role, and no sign-in check');

  const writes = fake.writes().length;
  const again = await deliver(handler, raw);
  assert.deepEqual([again.status, again.body], [200, { ok: true, duplicate: true }]);
  assert.equal(fake.writes().length, writes, 'nothing written the second time');
  assert.equal(fake.rows('billing_events').length, 1);
});

test('billing: a missing, malformed, altered, stale or wrongly keyed signature is 400 and nothing is read; a rolled secret\'s second v1 is accepted', async () => {
  world({ subscriptions: [{ dealership_id: D1, stripe_customer_id: 'cus_1' }] });
  const handler = await load();
  const raw = JSON.stringify(subscriptionEvent());
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [null, 'the Stripe-Signature header is missing or malformed'],
    ['t=abc,v1=xyz', 'the Stripe-Signature header is missing or malformed'],
    [sign(raw, { secret: 'another-secret' }), 'the signature does not match (a different secret, or an altered body)'],
    [sign(raw, { t: now - 301 }), 'the event timestamp is outside the tolerance (a replay, or a clock that is off)'],
    [sign(raw, { t: now + 301 }), 'the event timestamp is outside the tolerance (a replay, or a clock that is off)'],
  ];
  for (const [signature, error] of cases) {
    const r = await deliver(handler, raw, signature);
    assert.deepEqual([r.status, r.body], [400, { ok: false, error }], String(signature));
  }
  // the same event, re-serialised after it was signed
  const altered = await deliver(handler, JSON.stringify(JSON.parse(raw), null, 1), sign(raw));
  assert.deepEqual([altered.status, altered.body.error], [400, 'the signature does not match (a different secret, or an altered body)']);
  assert.equal(fake.calls.length, 0, 'nothing read before the signature holds');
  const good = sign(raw);
  const rolled = `t=${now},v1=${'0'.repeat(64)},${good.split(',')[1]}`;
  assert.equal((await deliver(handler, raw, rolled)).status, 200);
});

test('billing: the webhook without its secret is 500 naming it; a body over 1 MiB is 413 by its declared length or its real one', async () => {
  world();
  const raw = JSON.stringify(subscriptionEvent());
  const unset = await load({ STRIPE_WEBHOOK_SECRET: undefined });
  const r = await deliver(unset, raw);
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: 'STRIPE_WEBHOOK_SECRET is not set on the function' }]);
  const handler = await load();
  const huge = raw.padEnd(1024 * 1024 + 1, ' ');
  assert.deepEqual([(await deliver(handler, huge, sign(huge))).status, (await deliver(handler, huge, sign(huge))).body.error], [413, 'request too large']);
  const declared = await deliver(handler, raw, sign(raw), { 'content-length': String(1024 * 1024 + 1) });
  assert.equal(declared.status, 413);
  assert.equal(fake.calls.length, 0);
});

test('billing: which row an event lands on: the customer\'s, the subscription\'s, the metadata\'s dealership, the Stripe customer\'s metadata; a stranger\'s event is stored and not applied', async () => {
  const handler = await load();
  // by the subscription's metadata, on a dealership with no row yet
  world();
  stripe({ customers: {} });
  let r = await deliver(handler, JSON.stringify(subscriptionEvent({ id: 'evt_meta' }, { customer: 'cus_9', metadata: { dealership_id: D1 } })));
  assert.deepEqual(r.body, { ok: true, applied: true, attached: true });
  assert.deepEqual(fake.rows('subscriptions').map((s) => [s.dealership_id, s.stripe_customer_id, s.status]), [[D1, 'cus_9', 'trialing']]);

  // by the customer's metadata, fetched from Stripe
  world();
  stripe({ customers: { cus_7: { metadata: { dealership_id: D2 } } } });
  r = await deliver(handler, JSON.stringify(subscriptionEvent({ id: 'evt_cust' }, { customer: 'cus_7' })));
  assert.deepEqual(r.body, { ok: true, applied: true, attached: true });
  assert.deepEqual(stripeCalls().map((c) => `${c.method} ${c.path}`), ['GET /v1/customers/cus_7']);
  assert.equal(fake.rows('subscriptions')[0].dealership_id, D2);

  // by the row that already carries the subscription id
  world({ subscriptions: [{ dealership_id: D2, stripe_subscription_id: 'sub_1', status: 'active', updated_at: iso(Date.now() - DAY) }] });
  net.calls = [];
  r = await deliver(handler, JSON.stringify(subscriptionEvent({ id: 'evt_sub', type: 'customer.subscription.updated' }, { customer: 'cus_unknown', status: 'past_due' })));
  assert.deepEqual(r.body, { ok: true, applied: true, attached: true });
  assert.deepEqual([fake.rows('subscriptions')[0].status, net.calls.length], ['past_due', 0]);

  // no Lot Sync dealership: a customer without one, a dealership id that is no uuid, one that does not exist
  for (const [id, customers, metadata] of [['evt_none', { cus_8: { metadata: {} } }, {}], ['evt_bad', {}, { dealership_id: 'not-a-uuid' }], ['evt_gone', {}, { dealership_id: uuid(99) }]]) {
    world();
    stripe({ customers });
    r = await deliver(handler, JSON.stringify(subscriptionEvent({ id }, { customer: 'cus_8', metadata })));
    assert.deepEqual([r.status, r.body], [200, { ok: true, applied: false, attached: false }], id);
    assert.deepEqual(fake.rows('subscriptions'), []);
    assert.deepEqual(fake.rows('billing_events').map((e) => e.stripe_event_id), [id], 'recorded, so it is not delivered for ever');
  }
  // an event type the function does not handle is stored and nothing else
  world();
  r = await deliver(handler, JSON.stringify({ id: 'evt_other', type: 'charge.succeeded', created: 1, data: { object: { customer: 'cus_1' } } }));
  assert.deepEqual(r.body, { ok: true, applied: false, attached: true });
  assert.deepEqual([fake.queries('subscriptions').length, fake.rows('billing_events').length], [0, 1]);
});

test('billing: an event older than the row\'s last change is stored and not applied; an invoice about another subscription is ignored', async () => {
  const handler = await load();
  const recent = Math.floor(Date.now() / 1000);
  world({ subscriptions: [{ dealership_id: D1, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', updated_at: iso(recent * 1000) }] });
  const before = fake.rows('subscriptions');
  let r = await deliver(handler, JSON.stringify(subscriptionEvent({ id: 'evt_old', type: 'customer.subscription.updated', created: recent - 3600 }, { status: 'past_due' })));
  assert.deepEqual(r.body, { ok: true, applied: false, attached: true });
  r = await deliver(handler, JSON.stringify({ id: 'evt_inv', type: 'invoice.payment_failed', created: recent + 60, data: { object: { object: 'invoice', customer: 'cus_1', subscription: 'sub_other' } } }));
  assert.deepEqual(r.body, { ok: true, applied: false, attached: true });
  assert.deepEqual(fake.rows('subscriptions'), before);
  assert.deepEqual(fake.rows('billing_events').map((e) => e.stripe_event_id), ['evt_old', 'evt_inv']);
  r = await deliver(handler, JSON.stringify({ id: 'evt_inv2', type: 'invoice.payment_failed', created: recent + 60, data: { object: { object: 'invoice', customer: 'cus_1', subscription: 'sub_1' } } }));
  assert.deepEqual([r.body.applied, fake.rows('subscriptions')[0].status], [true, 'past_due']);
});

test('billing: a database failure answers 500 so Stripe retries, and the event is not recorded, so the retry applies it', async () => {
  world({ subscriptions: [{ dealership_id: D1, stripe_customer_id: 'cus_1' }] });
  const handler = await load();
  const raw = JSON.stringify(subscriptionEvent());
  fake.script = (c) => (c.table === 'subscriptions' && c.op === 'upsert' ? { error: { message: 'deadlock detected', code: '40P01' } } : undefined);
  const failed = await deliver(handler, raw);
  assert.deepEqual([failed.status, failed.body], [500, { ok: false, error: 'could not write subscriptions: deadlock detected' }]);
  assert.deepEqual(fake.rows('billing_events'), []);
  fake.script = null;
  const retried = await deliver(handler, raw);
  assert.deepEqual(retried.body, { ok: true, applied: true, attached: true });
  assert.equal(fake.rows('subscriptions')[0].status, 'trialing');
});

test('billing: scripts/check-deploy.mjs reads its billing lines as ok against the real handler, and the webhook line as a note until the secret is set', async () => {
  world();
  let billing = await load();
  let findings = (await runChecks({ fetchImpl: functionsFetch({ billing }), url: SUPABASE_URL, anonKey: ANON_KEY })).filter((f) => f.check.startsWith('billing:'));
  assert.deepEqual(findings.map((f) => f.check), ['billing: answers the extension\'s CORS preflight', 'billing: refuses a call with no user token', 'billing: the webhook refuses an unsigned event']);
  for (const f of findings) assert.equal(f.ok, true, `${f.check}: ${f.detail}`);
  billing = await load({ STRIPE_WEBHOOK_SECRET: undefined });
  findings = (await runChecks({ fetchImpl: functionsFetch({ billing }), url: SUPABASE_URL, anonKey: ANON_KEY })).filter((f) => f.check === 'billing: the webhook refuses an unsigned event');
  assert.deepEqual(findings.map((f) => [f.ok, f.warnOnly]), [[false, true]]);
  assert.match(findings[0].detail, /STRIPE_WEBHOOK_SECRET is not set yet/);
});
