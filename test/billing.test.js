// Billing (Milestone 5): the pure parts of the Stripe function
// (supabase/functions/_shared/billing.mjs) run in Node: the state machine,
// the Checkout line items and parameters, Stripe's form encoding, what each
// webhook event does to the row, and the signature check against an
// independent HMAC from node:crypto. Then the migration and the function's
// source are held to the rules: the numbers match marketing/pricing.json,
// every policy has a comment, nobody but the service role writes, no SDK,
// the secret key only ever reaches the Authorization header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  PRICING, STATUSES, STATES, HANDLED_EVENTS, MAX_SEATS, MIN_TRIAL_SECONDS,
  ms, subscriptionState, pilotAvailable, statusAnswer,
  normalizeSeats, checkoutLineItems, parseAllowedOrigins, allowedReturnUrl, returnUrls, trialEndFor, checkoutSessionParams,
  formEncode, applyStripeEvent, normalizeStatus,
  parseStripeSignature, hmacSha256Hex, timingSafeEqualHex, verifyStripeSignature,
} from '../supabase/functions/_shared/billing.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pricing = JSON.parse(read('../marketing/pricing.json'));
const NOW = Date.UTC(2026, 10, 24, 15, 0, 0); // 2026-11-24T15:00:00Z
const DAY = 24 * 3600 * 1000;
const iso = (t) => new Date(t).toISOString();
const DEALER = '00000000-0000-4000-8000-0000000000d1';
const row = (over = {}) => ({ dealership_id: DEALER, stripe_customer_id: null, stripe_subscription_id: null, status: null, pilot_ends_at: null, current_period_end: null, seats: 5, updated_at: iso(NOW - 10 * DAY), ...over });

// ---------- the numbers ----------

test('the pricing constants and the migration carry the numbers from marketing/pricing.json', () => {
  assert.equal(PRICING.includedSalespeople, pricing.includedSalespeople);
  assert.equal(PRICING.pilotDays, pricing.pilotDays);
  const sql = read('../supabase/migrations/0004_billing.sql');
  assert.match(sql, new RegExp(`seats integer not null default ${pricing.includedSalespeople} `), 'the seats default is the included count');
  const pilots = [...sql.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]));
  assert.ok(pilots.length >= 2, 'start_pilot sets the pilot length on insert and on update');
  for (const days of pilots) assert.equal(days, pricing.pilotDays, 'start_pilot uses pilotDays');
  assert.match(sql, new RegExp(`values \\(start_pilot.dealership_id, 'pilot', now\\(\\) \\+ interval '${pricing.pilotDays} days', ${pricing.includedSalespeople}, now\\(\\)\\)`));
  assert.equal(pricing.hypothesis, true, 'pricing stays a hypothesis until a dealer pays');
});

// ---------- the state machine ----------

test('subscriptionState: none, pilot, active, lapsed from the row and the clock', () => {
  assert.deepEqual(STATES, ['none', 'pilot', 'active', 'lapsed']);
  assert.equal(subscriptionState(null, NOW), 'none');
  assert.equal(subscriptionState(undefined, NOW), 'none');
  assert.equal(subscriptionState('nonsense', NOW), 'none');
  // a customer id alone (a checkout opened and not finished) is still nothing
  assert.equal(subscriptionState(row({ stripe_customer_id: 'cus_1' }), NOW), 'none');
  // the free period runs while pilot_ends_at is ahead
  assert.equal(subscriptionState(row({ status: 'pilot', pilot_ends_at: iso(NOW + 12 * DAY) }), NOW), 'pilot');
  assert.equal(subscriptionState(row({ status: 'pilot', pilot_ends_at: iso(NOW + 1000) }), NOW), 'pilot');
  assert.equal(subscriptionState(row({ status: 'pilot', pilot_ends_at: iso(NOW) }), NOW), 'lapsed', 'the pilot ends at the moment it says');
  assert.equal(subscriptionState(row({ status: 'pilot', pilot_ends_at: iso(NOW - 1) }), NOW), 'lapsed');
  assert.equal(subscriptionState(row({ status: 'pilot', pilot_ends_at: null }), NOW), 'lapsed', 'a pilot with no end is not a running pilot');
  // ISO or milliseconds for now; Postgres microseconds are fine
  assert.equal(subscriptionState(row({ status: 'pilot', pilot_ends_at: '2026-12-24T15:00:00.123456+00:00' }), iso(NOW)), 'pilot');
  // paid
  assert.equal(subscriptionState(row({ status: 'active', current_period_end: iso(NOW + 20 * DAY) }), NOW), 'active');
  assert.equal(subscriptionState(row({ status: 'trialing', pilot_ends_at: iso(NOW + 12 * DAY) }), NOW), 'active', 'a subscription whose trial waits for the pilot is active');
  // a running pilot outranks a Stripe status that is not paid (the free period was promised)
  assert.equal(subscriptionState(row({ status: 'canceled', pilot_ends_at: iso(NOW + 3 * DAY) }), NOW), 'pilot');
  assert.equal(subscriptionState(row({ status: 'incomplete', pilot_ends_at: iso(NOW + 3 * DAY) }), NOW), 'pilot');
  // everything else has lapsed
  for (const s of ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(subscriptionState(row({ status: s }), NOW), 'lapsed', s);
    assert.equal(subscriptionState(row({ status: s, pilot_ends_at: iso(NOW - DAY) }), NOW), 'lapsed', s + ' after a pilot');
  }
  assert.equal(subscriptionState(row({ status: 'something-new' }), NOW), 'lapsed', 'an unknown status is never active');
  // every status the row may carry is one the machine knows
  for (const s of STATUSES) assert.ok(['pilot', 'active', 'lapsed'].includes(subscriptionState(row({ status: s, pilot_ends_at: s === 'pilot' ? iso(NOW + DAY) : null }), NOW)), s);
});

test('pilotAvailable and statusAnswer: what the manager page may offer', () => {
  assert.equal(pilotAvailable(null), true);
  assert.equal(pilotAvailable(row({ stripe_customer_id: 'cus_1' })), true, 'a customer shell does not block the pilot');
  assert.equal(pilotAvailable(row({ status: 'pilot', pilot_ends_at: iso(NOW + DAY) })), false);
  assert.equal(pilotAvailable(row({ status: 'canceled' })), false);
  assert.equal(pilotAvailable(row({ status: null, pilot_ends_at: iso(NOW - DAY) })), false, 'a pilot never restarts');

  const none = statusAnswer(null, { role: 'manager', now: NOW });
  assert.deepEqual(none, { state: 'none', subscription: null, canStartPilot: true, canSubscribe: true, canManageBilling: false, pilotDays: pricing.pilotDays, includedSalespeople: pricing.includedSalespeople });
  const salesperson = statusAnswer(row({ status: 'pilot', pilot_ends_at: iso(NOW + DAY) }), { role: 'salesperson', now: NOW });
  assert.equal(salesperson.state, 'pilot');
  assert.equal(salesperson.canStartPilot, false);
  assert.equal(salesperson.canSubscribe, false);
  assert.equal(salesperson.canManageBilling, false);
  const active = statusAnswer(row({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }), { role: 'manager', now: NOW });
  assert.equal(active.state, 'active');
  assert.equal(active.canSubscribe, false, 'an active dealership changes its plan in the portal, not through a second checkout');
  assert.equal(active.canManageBilling, true);
  assert.equal(active.subscription.stripe_subscription_id, 'sub_1');
  const lapsed = statusAnswer(row({ status: 'canceled', stripe_customer_id: 'cus_1' }), { role: 'manager', now: NOW });
  assert.equal(lapsed.state, 'lapsed');
  assert.equal(lapsed.canSubscribe, true);
  assert.equal(lapsed.canStartPilot, false);
  assert.equal(lapsed.canManageBilling, true);
});

test('ms reads ISO text, Postgres microseconds, Dates and numbers', () => {
  assert.equal(ms('2026-11-24T15:00:00.000Z'), NOW);
  assert.equal(ms('2026-11-24T15:00:00.123456+00:00'), NOW + 123);
  assert.equal(ms(new Date(NOW)), NOW);
  assert.equal(ms(NOW), NOW);
  assert.equal(ms(''), null);
  assert.equal(ms(null), null);
  assert.equal(ms('not a date'), null);
  assert.equal(ms(NaN), null);
});

// ---------- Checkout ----------

test('normalizeSeats: never below the included count, never above the cap, the included count when unusable', () => {
  assert.equal(normalizeSeats(undefined, 5), 5);
  assert.equal(normalizeSeats(null, 5), 5);
  assert.equal(normalizeSeats('', 5), 5);
  assert.equal(normalizeSeats(0, 5), 5);
  assert.equal(normalizeSeats(-3, 5), 5);
  assert.equal(normalizeSeats(2.5, 5), 5);
  assert.equal(normalizeSeats('abc', 5), 5);
  assert.equal(normalizeSeats(3, 5), 5, 'a 3-person store still has the 5 included seats');
  assert.equal(normalizeSeats(7, 5), 7);
  assert.equal(normalizeSeats('12', 5), 12, 'a form field sends text');
  assert.equal(normalizeSeats(10_000, 5), MAX_SEATS);
});

test('checkoutLineItems: the rooftop always, the seat line only above the included count', () => {
  const prices = { priceRooftop: 'price_rooftop', priceSeat: 'price_seat' };
  assert.deepEqual(checkoutLineItems({ seats: 5, included: 5, ...prices }), [{ price: 'price_rooftop', quantity: 1 }]);
  assert.deepEqual(checkoutLineItems({ seats: 2, included: 5, ...prices }), [{ price: 'price_rooftop', quantity: 1 }]);
  assert.deepEqual(checkoutLineItems({ included: 5, ...prices }), [{ price: 'price_rooftop', quantity: 1 }], 'no seats given: the included count');
  assert.deepEqual(checkoutLineItems({ seats: 8, included: 5, ...prices }), [{ price: 'price_rooftop', quantity: 1 }, { price: 'price_seat', quantity: 3 }]);
  assert.deepEqual(checkoutLineItems({ seats: 8, ...prices }), [{ price: 'price_rooftop', quantity: 1 }, { price: 'price_seat', quantity: 8 - pricing.includedSalespeople }], 'the default included count is the config');
  // a missing price is a configuration error, named, never a wrong bill
  assert.throws(() => checkoutLineItems({ seats: 5, included: 5, priceRooftop: '', priceSeat: 'price_seat' }), /STRIPE_PRICE_ROOFTOP/);
  assert.throws(() => checkoutLineItems({ seats: 6, included: 5, priceRooftop: 'price_rooftop', priceSeat: '' }), /STRIPE_PRICE_SEAT/);
  assert.doesNotThrow(() => checkoutLineItems({ seats: 5, included: 5, priceRooftop: 'price_rooftop', priceSeat: '' }), 'no seat price is fine while nobody needs extra seats');
});

test('return URLs: only pages on the allowed origins, with the billing flag added', () => {
  assert.deepEqual(parseAllowedOrigins('https://manager.example.com/, http://localhost:3000 ,, not-a-url, ftp://x.test'), ['https://manager.example.com', 'http://localhost:3000']);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins('HTTPS://Manager.Example.com/index.html'), ['https://manager.example.com'], 'an address is reduced to its origin');
  const allowed = parseAllowedOrigins('https://manager.example.com');
  assert.equal(allowedReturnUrl('https://manager.example.com/manager/index.html?x=1', allowed), 'https://manager.example.com/manager/index.html?x=1');
  assert.equal(allowedReturnUrl('https://MANAGER.example.com/', allowed), 'https://manager.example.com/');
  assert.equal(allowedReturnUrl('https://evil.example.com/manager/index.html', allowed), null);
  assert.equal(allowedReturnUrl('https://manager.example.com.evil.test/', allowed), null);
  assert.equal(allowedReturnUrl('http://manager.example.com/', allowed), null, 'the scheme is part of the origin');
  assert.equal(allowedReturnUrl('https://user:pw@manager.example.com/', allowed), null, 'no credentials in a redirect');
  assert.equal(allowedReturnUrl('javascript:alert(1)', allowed), null);
  assert.equal(allowedReturnUrl('', allowed), null);
  assert.equal(allowedReturnUrl(undefined, allowed), null);
  assert.equal(allowedReturnUrl('https://manager.example.com/', []), null, 'nothing allowed until ALLOWED_RETURN_ORIGINS is set');
  assert.equal(allowedReturnUrl('https://manager.example.com/', 'https://manager.example.com'), 'https://manager.example.com/', 'the raw secret text works too');
  assert.deepEqual(returnUrls('https://manager.example.com/manager/index.html'), { success_url: 'https://manager.example.com/manager/index.html?billing=success', cancel_url: 'https://manager.example.com/manager/index.html?billing=canceled' });
  assert.deepEqual(returnUrls('https://manager.example.com/m/?dealer=abc&billing=old#top'), { success_url: 'https://manager.example.com/m/?dealer=abc&billing=success#top', cancel_url: 'https://manager.example.com/m/?dealer=abc&billing=canceled#top' }, 'an existing query survives and an old flag is replaced');
});

test('trialEndFor: the card is charged when the pilot ends, unless that is under 48 hours away', () => {
  assert.equal(MIN_TRIAL_SECONDS, 48 * 3600);
  assert.equal(trialEndFor(iso(NOW + 12 * DAY), NOW), Math.floor((NOW + 12 * DAY) / 1000));
  assert.equal(trialEndFor(iso(NOW + 2 * DAY + 1000), NOW), Math.floor((NOW + 2 * DAY + 1000) / 1000));
  assert.equal(trialEndFor(iso(NOW + 2 * DAY - 1000), NOW), null, "under Stripe's minimum: no trial, charged now");
  assert.equal(trialEndFor(iso(NOW - DAY), NOW), null, 'a pilot that ended');
  assert.equal(trialEndFor(null, NOW), null);
  assert.equal(trialEndFor('garbage', NOW), null);
});

test('checkoutSessionParams: subscription mode, the customer, the dealership in metadata, the trial only when given', () => {
  const lineItems = [{ price: 'price_rooftop', quantity: 1 }, { price: 'price_seat', quantity: 2 }];
  const p = checkoutSessionParams({ customerId: 'cus_1', dealershipId: DEALER, lineItems, returnUrl: 'https://manager.example.com/' });
  assert.deepEqual(p, {
    mode: 'subscription',
    customer: 'cus_1',
    client_reference_id: DEALER,
    line_items: lineItems,
    success_url: 'https://manager.example.com/?billing=success',
    cancel_url: 'https://manager.example.com/?billing=canceled',
    allow_promotion_codes: true,
    subscription_data: { metadata: { dealership_id: DEALER } },
  });
  const t = checkoutSessionParams({ customerId: 'cus_1', dealershipId: DEALER, lineItems, returnUrl: 'https://manager.example.com/', trialEnd: 1800000000 });
  assert.equal(t.subscription_data.trial_end, 1800000000);
  assert.throws(() => checkoutSessionParams({ customerId: '', dealershipId: DEALER, lineItems, returnUrl: 'https://manager.example.com/' }), /customer/);
  assert.throws(() => checkoutSessionParams({ customerId: 'cus_1', dealershipId: '', lineItems, returnUrl: 'https://manager.example.com/' }), /dealership/);
  assert.throws(() => checkoutSessionParams({ customerId: 'cus_1', dealershipId: DEALER, lineItems: [], returnUrl: 'https://manager.example.com/' }), /line items/);
});

// ---------- the form encoding ----------

test('formEncode writes nested keys the way Stripe reads them', () => {
  assert.equal(formEncode({ mode: 'subscription', customer: 'cus_1' }), 'mode=subscription&customer=cus_1');
  assert.equal(
    formEncode({ line_items: [{ price: 'price_a', quantity: 1 }, { price: 'price_b', quantity: 3 }] }),
    'line_items[0][price]=price_a&line_items[0][quantity]=1&line_items[1][price]=price_b&line_items[1][quantity]=3',
  );
  assert.equal(formEncode({ subscription_data: { metadata: { dealership_id: DEALER }, trial_end: 1800000000 } }), `subscription_data[metadata][dealership_id]=${DEALER}&subscription_data[trial_end]=1800000000`);
  assert.equal(formEncode({ allow_promotion_codes: true, off: false }), 'allow_promotion_codes=true&off=false');
  assert.equal(formEncode({ email: undefined, name: null, keep: 'x' }), 'keep=x', 'null and undefined are left out');
  assert.equal(formEncode({ name: 'Example Motors & Sons', return_url: 'https://m.example.com/?a=1&b=2' }), 'name=Example+Motors+%26+Sons&return_url=https%3A%2F%2Fm.example.com%2F%3Fa%3D1%26b%3D2');
  assert.equal(formEncode({}), '');
  assert.equal(formEncode(null), '');
  const full = formEncode(checkoutSessionParams({ customerId: 'cus_1', dealershipId: DEALER, lineItems: [{ price: 'price_rooftop', quantity: 1 }], returnUrl: 'https://manager.example.com/' }));
  assert.ok(full.includes('success_url=https%3A%2F%2Fmanager.example.com%2F%3Fbilling%3Dsuccess'));
  assert.ok(full.includes('line_items[0][price]=price_rooftop'));
  assert.doesNotMatch(full, /%5B|%5D/, 'brackets stay literal');
});

// ---------- what an event does to the row ----------

const T = Math.floor(NOW / 1000);
const sub = (over = {}) => ({
  id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', current_period_end: T + 30 * 86400,
  items: { data: [{ price: { id: 'price_rooftop' }, quantity: 1 }] }, metadata: { dealership_id: DEALER }, ...over,
});
const event = (type, object, created = T) => ({ id: 'evt_' + type.replace(/\W/g, '_'), object: 'event', type, created, data: { object } });
const opts = { included: 5, priceRooftop: 'price_rooftop', priceSeat: 'price_seat' };

test('applyStripeEvent: subscription created and updated copy the status, ids, period end and seats', () => {
  assert.deepEqual(HANDLED_EVENTS, ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);
  const created = applyStripeEvent(null, event('customer.subscription.created', sub()), opts);
  assert.deepEqual(created, { updated_at: iso(NOW), stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', current_period_end: iso(NOW + 30 * DAY), seats: 5 });
  // a pilot row becomes a trialing subscription when the checkout finished with a trial
  const pilot = row({ status: 'pilot', pilot_ends_at: iso(NOW + 10 * DAY), stripe_customer_id: 'cus_1' });
  const trial = applyStripeEvent(pilot, event('customer.subscription.created', sub({ status: 'trialing' })), opts);
  assert.equal(trial.status, 'trialing');
  assert.equal(subscriptionState({ ...pilot, ...trial }, NOW), 'active');
  assert.equal(trial.pilot_ends_at, undefined, 'the pilot end date is left alone');
  // extra seats come from the seat price's quantity
  const seven = applyStripeEvent(null, event('customer.subscription.updated', sub({ items: { data: [{ price: { id: 'price_rooftop' }, quantity: 1 }, { price: { id: 'price_seat' }, quantity: 2 }] } })), opts);
  assert.equal(seven.seats, 7);
  // with no seat price configured, anything that is not the rooftop counts as seats
  const noSeatPrice = applyStripeEvent(null, event('customer.subscription.updated', sub({ items: { data: [{ price: { id: 'price_rooftop' }, quantity: 1 }, { price: { id: 'price_other' }, quantity: 4 }] } })), { included: 5, priceRooftop: 'price_rooftop', priceSeat: '' });
  assert.equal(noSeatPrice.seats, 9);
  // no prices configured at all: the seats column is left alone
  const noPrices = applyStripeEvent(null, event('customer.subscription.updated', sub()), { included: 5 });
  assert.equal(noPrices.seats, undefined);
  // the period end from the items (API versions from 2025-03-31 carry it there, not on the subscription)
  const basil = applyStripeEvent(null, event('customer.subscription.updated', sub({ current_period_end: undefined, items: { data: [{ price: { id: 'price_rooftop' }, quantity: 1, current_period_end: T + 20 * 86400 }, { price: { id: 'price_seat' }, quantity: 1, current_period_end: T + 25 * 86400 }] } })), opts);
  assert.equal(basil.current_period_end, iso(NOW + 25 * DAY));
  assert.equal(basil.seats, 6);
  // an expanded customer object works like an id
  const expanded = applyStripeEvent(null, event('customer.subscription.updated', sub({ customer: { id: 'cus_9', object: 'customer' } })), opts);
  assert.equal(expanded.stripe_customer_id, 'cus_9');
  // statuses: every Stripe status passes through; an unknown one is read as unpaid
  for (const s of ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(applyStripeEvent(null, event('customer.subscription.updated', sub({ status: s })), opts).status, s);
  }
  assert.equal(applyStripeEvent(null, event('customer.subscription.updated', sub({ status: 'brand_new_status' })), opts).status, 'unpaid');
  assert.equal(normalizeStatus('pilot'), 'unpaid', 'Stripe cannot put a row into the pilot');
  assert.equal(normalizeStatus(undefined), 'unpaid');
});

test('applyStripeEvent: deleted is canceled; a stale event never wins; unrelated events change nothing', () => {
  const active = row({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', updated_at: iso(NOW) });
  const deleted = applyStripeEvent(active, event('customer.subscription.deleted', sub({ status: 'canceled' }), T + 60), opts);
  assert.equal(deleted.status, 'canceled');
  assert.equal(deleted.updated_at, iso(NOW + 60_000));
  assert.equal(subscriptionState({ ...active, ...deleted }, NOW + 60_000), 'lapsed');
  // Stripe delivers out of order: an older event for the same subscription is dropped
  assert.equal(applyStripeEvent(active, event('customer.subscription.updated', sub({ status: 'past_due' }), T - 60), opts), null);
  // but an older event for another subscription (a new one after a cancel) is applied
  const other = applyStripeEvent(active, event('customer.subscription.created', sub({ id: 'sub_2', status: 'active' }), T - 60), opts);
  assert.equal(other.stripe_subscription_id, 'sub_2');
  // and a row that never had a subscription (a pilot) takes whatever comes
  const pilot = row({ status: 'pilot', pilot_ends_at: iso(NOW + 5 * DAY), updated_at: iso(NOW) });
  assert.equal(applyStripeEvent(pilot, event('customer.subscription.created', sub(), T - 60), opts).status, 'active');
  // an event with the same second is not stale
  assert.equal(applyStripeEvent(active, event('customer.subscription.updated', sub({ status: 'past_due' }), T), opts).status, 'past_due');
  // unhandled and malformed
  assert.equal(applyStripeEvent(active, event('checkout.session.completed', { id: 'cs_1' }), opts), null);
  assert.equal(applyStripeEvent(active, event('customer.created', { id: 'cus_1' }), opts), null);
  assert.equal(applyStripeEvent(active, { id: 'evt_x', type: 'customer.subscription.updated' }, opts), null, 'no data.object');
  assert.equal(applyStripeEvent(active, null, opts), null);
  assert.equal(applyStripeEvent(active, 'text', opts), null);
});

test('applyStripeEvent: invoices mark a failed payment past due and a paid one paid up, in both API shapes', () => {
  const active = row({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', current_period_end: iso(NOW), updated_at: iso(NOW - DAY) });
  const oldShape = { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { start: T, end: T + 30 * 86400 } }] } };
  const newShape = { id: 'in_2', object: 'invoice', customer: 'cus_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { start: T, end: T + 30 * 86400 } }, { period: { start: T, end: T + 31 * 86400 } }] } };

  const failed = applyStripeEvent(active, event('invoice.payment_failed', oldShape), opts);
  assert.deepEqual(failed, { updated_at: iso(NOW), stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'past_due' });
  assert.equal(subscriptionState({ ...active, ...failed }, NOW), 'lapsed');

  // paid while active: only the paid-through date moves; the status is the subscription events' business
  const paid = applyStripeEvent(active, event('invoice.paid', oldShape), opts);
  assert.deepEqual(paid, { updated_at: iso(NOW), stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', current_period_end: iso(NOW + 30 * DAY) });
  // paid after a failure: back to active
  const recovered = applyStripeEvent({ ...active, status: 'past_due' }, event('invoice.paid', newShape), opts);
  assert.equal(recovered.status, 'active');
  assert.equal(recovered.current_period_end, iso(NOW + 31 * DAY), "the latest line's period end, from the new invoice shape");
  assert.equal(recovered.stripe_subscription_id, 'sub_1', 'the subscription id from invoice.parent');
  for (const s of ['unpaid', 'incomplete']) assert.equal(applyStripeEvent({ ...active, status: s }, event('invoice.paid', oldShape), opts).status, 'active', s);
  // a $0 trial invoice does not turn a trialing row active
  const trialing = applyStripeEvent({ ...active, status: 'trialing' }, event('invoice.paid', { ...oldShape, amount_paid: 0 }), opts);
  assert.equal(trialing.status, undefined);
  // a canceled row is not revived by a late invoice.paid
  assert.equal(applyStripeEvent({ ...active, status: 'canceled' }, event('invoice.paid', oldShape), opts).status, undefined);
  // invoices never create a row: without one there is nothing to adjust
  assert.equal(applyStripeEvent(null, event('invoice.paid', oldShape), opts), null);
  // a stale invoice event is dropped like a stale subscription event
  assert.equal(applyStripeEvent({ ...active, updated_at: iso(NOW + DAY) }, event('invoice.payment_failed', oldShape), opts), null);
});

// ---------- the signature ----------

const SECRET = 'whsec_test_secret_for_the_unit_tests';
const BODY = '{"id":"evt_1","object":"event","type":"invoice.paid","created":' + T + ',"data":{"object":{"id":"in_1"}}}';
const sign = (t, body, secret = SECRET) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

test('parseStripeSignature reads the timestamp and every v1 entry', () => {
  const h = parseStripeSignature(`t=${T},v1=${'a'.repeat(64)},v0=ignored,v1=${'B'.repeat(64)}`);
  assert.deepEqual(h, { timestamp: T, signatures: ['a'.repeat(64), 'b'.repeat(64)] });
  assert.deepEqual(parseStripeSignature(''), { timestamp: null, signatures: [] });
  assert.deepEqual(parseStripeSignature(null), { timestamp: null, signatures: [] });
  assert.deepEqual(parseStripeSignature('t=abc,v1=short'), { timestamp: null, signatures: [] });
});

test('hmacSha256Hex and timingSafeEqualHex match node:crypto', async () => {
  assert.equal(await hmacSha256Hex(SECRET, `${T}.${BODY}`), sign(T, BODY));
  assert.equal(timingSafeEqualHex('abc', 'abc'), true);
  assert.equal(timingSafeEqualHex('abc', 'abd'), false);
  assert.equal(timingSafeEqualHex('abc', 'abcd'), false);
  assert.equal(timingSafeEqualHex('abc', undefined), false);
});

test('verifyStripeSignature: a valid signature passes', async () => {
  const header = `t=${T},v1=${sign(T, BODY)}`;
  assert.deepEqual(await verifyStripeSignature(header, BODY, SECRET, T + 10), { ok: true, timestamp: T });
  // Stripe sends two v1 entries while a secret is being rolled; either matches
  const rolled = `t=${T},v1=${sign(T, BODY, 'whsec_old')},v1=${sign(T, BODY)}`;
  assert.equal((await verifyStripeSignature(rolled, BODY, SECRET, T + 10)).ok, true);
  // the default tolerance is Stripe's five minutes
  assert.equal((await verifyStripeSignature(header, BODY, SECRET, T + 299)).ok, true);
  assert.equal((await verifyStripeSignature(header, BODY, SECRET, T + 300)).ok, true);
});

test('verifyStripeSignature: a tampered body, a wrong secret, a missing header fail', async () => {
  const header = `t=${T},v1=${sign(T, BODY)}`;
  const tampered = await verifyStripeSignature(header, BODY.replace('invoice.paid', 'invoice.payment_failed'), SECRET, T);
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /does not match/);
  const wrongSecret = await verifyStripeSignature(header, BODY, 'whsec_other', T);
  assert.equal(wrongSecret.ok, false);
  assert.match(wrongSecret.reason, /does not match/);
  // the timestamp is part of what is signed: moving it invalidates the signature
  const movedT = await verifyStripeSignature(`t=${T + 1},v1=${sign(T, BODY)}`, BODY, SECRET, T);
  assert.equal(movedT.ok, false);
  const missing = await verifyStripeSignature(null, BODY, SECRET, T);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /missing or malformed/);
  assert.match((await verifyStripeSignature(`t=${T}`, BODY, SECRET, T)).reason, /missing or malformed/);
  assert.match((await verifyStripeSignature(`v1=${sign(T, BODY)}`, BODY, SECRET, T)).reason, /missing or malformed/);
  const noSecret = await verifyStripeSignature(header, BODY, '', T);
  assert.equal(noSecret.ok, false);
  assert.match(noSecret.reason, /STRIPE_WEBHOOK_SECRET/);
});

test('verifyStripeSignature: a stale or future-dated event fails, and the tolerance is adjustable', async () => {
  const header = `t=${T},v1=${sign(T, BODY)}`;
  const stale = await verifyStripeSignature(header, BODY, SECRET, T + 301);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /tolerance/);
  const future = await verifyStripeSignature(header, BODY, SECRET, T - 301);
  assert.equal(future.ok, false);
  assert.equal((await verifyStripeSignature(header, BODY, SECRET, T + 3600, 7200)).ok, true, 'a wider tolerance');
  assert.equal((await verifyStripeSignature(header, BODY, SECRET, T + 2, 1)).ok, false, 'a narrower one');
  assert.equal((await verifyStripeSignature(header, BODY, SECRET, T + 0.9)).ok, true, 'fractional seconds are floored');
});

// ---------- the migration ----------

test('0004_billing.sql: RLS on, members read, nobody but the service role writes, every policy has a comment', () => {
  const sql = read('../supabase/migrations/0004_billing.sql');
  assert.match(sql, /create table public\.subscriptions \(/);
  assert.match(sql, /create table public\.billing_events \(/);
  assert.match(sql, /dealership_id uuid primary key references public\.dealerships \(id\) on delete cascade/);
  assert.match(sql, /stripe_customer_id text unique/);
  assert.match(sql, /stripe_subscription_id text unique/);
  assert.match(sql, /stripe_event_id text not null unique/);
  for (const s of STATUSES) assert.ok(sql.includes(`'${s}'`), `the status check allows ${s}`);
  assert.match(sql, /alter table public\.subscriptions enable row level security;/);
  assert.match(sql, /alter table public\.billing_events enable row level security;/);
  assert.match(sql, /grant select on public\.subscriptions to authenticated;/);
  assert.doesNotMatch(sql, /grant [^;]*on public\.billing_events to (anon|authenticated)/);
  assert.doesNotMatch(sql, /grant [^;]*(insert|update|delete)[^;]*on public\.subscriptions to authenticated/);
  // policies: only a select policy on subscriptions, none at all on billing_events, and a comment on each
  const policies = [...sql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+)/g)].map((m) => ({ name: m[1], table: m[2], op: m[3] }));
  assert.deepEqual(policies, [{ name: "members read their dealership's subscription", table: 'subscriptions', op: 'select' }]);
  for (const p of policies) assert.ok(sql.includes(`comment on policy "${p.name}" on public.${p.table} is`), `policy "${p.name}" has no comment`);
  // the helpers
  assert.match(sql, /create or replace function public\.subscription_state\(dealership_id uuid\)/);
  assert.match(sql, /security invoker/, "subscription_state runs under the caller's RLS");
  assert.match(sql, /create or replace function public\.start_pilot\(dealership_id uuid\)/);
  assert.match(sql, /not public\.is_manager\(start_pilot\.dealership_id\)/, 'start_pilot is for managers');
  assert.match(sql, /where s\.status is null and s\.pilot_ends_at is null/, 'start_pilot never restarts a pilot');
  assert.match(sql, /revoke execute on function public\.start_pilot\(uuid\) from public, anon;/);
  // the SQL state machine reads like the JS one
  assert.match(sql, /when s\.status in \('trialing', 'active'\) then 'active'/);
  assert.match(sql, /when s\.pilot_ends_at is not null and s\.pilot_ends_at > now\(\) then 'pilot'/);
  assert.match(sql, /when s\.status is null and s\.pilot_ends_at is null then 'none'/);
  assert.match(sql, /else 'lapsed'/);
});

// ---------- the function ----------

test('billing/index.ts: the four routes, fetch not an SDK, the secret key only in the Authorization header', () => {
  const src = read('../supabase/functions/billing/index.ts');
  for (const r of ['checkout', 'portal', 'status', 'webhook']) assert.ok(src.includes(`'${r}'`), `route ${r}`);
  assert.doesNotMatch(src, /from ['"]npm:stripe|from ['"]https:\/\/esm\.sh\/stripe|from ['"]stripe['"]/, 'no Stripe SDK');
  assert.match(src, /https:\/\/api\.stripe\.com/);
  assert.match(src, /application\/x-www-form-urlencoded/);
  assert.match(src, /Idempotency-Key/);
  assert.match(src, /verifyStripeSignature\(req\.headers\.get\('stripe-signature'\), raw, config\.webhookSecret/);
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ROOFTOP', 'STRIPE_PRICE_SEAT', 'ALLOWED_RETURN_ORIGINS']) assert.ok(src.includes(`env('${name}')`), `${name} comes from the environment`);
  // the secret key: read from env, checked for presence, sent as the bearer, nowhere else
  const lines = src.split('\n').filter((l) => /secretKey/.test(l));
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /secretKey: env\('STRIPE_SECRET_KEY'\)/);
  assert.match(lines[1], /if \(!config\.secretKey\)/);
  assert.match(lines[2], /Authorization: `Bearer \$\{config\.secretKey\}`/);
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*(secretKey|webhookSecret)/, 'never logged');
  // the pure module is the one under test here
  assert.match(src, /from '\.\.\/_shared\/billing\.mjs'/);
  // managers only for checkout and portal; the webhook needs no user token
  assert.match(src, /pick\(caller\.client, caller\.user\.id, wanted, !isStatus\)/);
  assert.match(src, /if \(route === 'webhook'\) \{\s*if \(req\.method !== 'POST'\)[^]*?return webhook\(req\);/);
});
