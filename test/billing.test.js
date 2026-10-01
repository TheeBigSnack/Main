// Billing (Milestone 5): the pure parts of the Stripe function
// (supabase/functions/_shared/billing.mjs) run in Node: the state machine,
// the Checkout line items and parameters, Stripe's form encoding, what each
// webhook event does to the row, and the signature check against an
// independent HMAC from node:crypto. Then the migration and the function's
// source are held to the rules: the numbers match marketing/pricing.json,
// every policy has a comment, nobody but the service role writes, no SDK,
// the secret key only ever reaches the Authorization header. Who takes a
// seat (seatCount) is checked against the documents that price seats, and
// the manager page's copy of it is held to this one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  PRICING, STATUSES, STATES, HANDLED_EVENTS, MAX_SEATS, MIN_TRIAL_SECONDS,
  ms, subscriptionState, pilotAvailable, statusAnswer, SEAT_ROLE, seatCount,
  OPEN_STATUSES, OPEN_SUBSCRIPTION_CODE, OPEN_SUBSCRIPTION_MESSAGE, hasOpenSubscription, checkoutRefusal,
  planOf, lapsedAnswer, LAPSED_CODE, LAPSED_MESSAGE, todayRange, MAX_TODAY_HOURS,
  normalizeSeats, checkoutLineItems, parseAllowedOrigins, allowedReturnUrl, returnUrls, trialEndFor, checkoutSessionParams,
  automaticTaxOn, portalSessionParams,
  formEncode, applyStripeEvent, normalizeStatus,
  parseStripeSignature, hmacSha256Hex, timingSafeEqualHex, verifyStripeSignature,
} from '../supabase/functions/_shared/billing.mjs';
import * as page from '../manager/data.js';

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
  assert.deepEqual(none, { state: 'none', subscription: null, canStartPilot: true, canSubscribe: true, canManageBilling: false, pilotDays: pricing.pilotDays, includedSalespeople: pricing.includedSalespeople, salespeople: null });
  // the seat count the function passes in, as a whole number or not at all
  assert.equal(statusAnswer(null, { role: 'manager', now: NOW, salespeople: 7 }).salespeople, 7);
  assert.equal(statusAnswer(null, { role: 'manager', now: NOW, salespeople: 0 }).salespeople, 0, 'no salesperson yet is a count');
  for (const bad of [-1, 2.5, '7', NaN, undefined, null]) assert.equal(statusAnswer(null, { role: 'manager', now: NOW, salespeople: bad }).salespeople, null, String(bad));
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
  // a failed payment: Stripe still holds the subscription open, Checkout would refuse a second one, and the
  // portal is where it is renewed, so Subscribe is not offered
  const pastDue = statusAnswer(row({ status: 'past_due', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', seats: 5 }), { role: 'manager', now: NOW });
  assert.equal(pastDue.state, 'lapsed');
  assert.equal(pastDue.canSubscribe, false);
  assert.equal(pastDue.canManageBilling, true);
});

test('the manager page\'s copies of MAX_SEATS and the open-subscription rule are the billing function\'s', async () => {
  const page = await import('../manager/data.js');
  assert.equal(page.MAX_SEATS, MAX_SEATS);
  const shared = await import('../supabase/functions/_shared/billing.mjs');
  assert.deepEqual([...page.OPEN_STATUSES], [...shared.OPEN_STATUSES]);
  for (const status of [...STATUSES, 'pilot', null, '']) {
    for (const id of ['sub_1', '', null]) {
      const r = { status, stripe_subscription_id: id };
      assert.equal(page.hasOpenSubscription(r), shared.hasOpenSubscription(r), `${status} ${id}`);
    }
  }
  assert.equal(page.subscribeSeats({ role: 'manager', salespeople: 250, includedSalespeople: 5 }), MAX_SEATS, 'the card asks for no more seats than Checkout bills');
});

// Before billing opens the page offers Start the free pilot from the row it
// reads itself (manager/data.js closedBillingStatus); it must offer it exactly
// when the function would, and start_pilot() would start one.
test('before billing opens the manager page offers the free pilot on the billing function\'s own rule', async () => {
  const page = await import('../manager/data.js');
  const rows = [null, undefined, row(), row({ stripe_customer_id: 'cus_1' }), row({ status: 'pilot', pilot_ends_at: iso(NOW + DAY) }), row({ status: null, pilot_ends_at: iso(NOW - DAY) }), row({ status: 'canceled' }), row({ status: 'active', stripe_subscription_id: 'sub_1' }), { status: undefined }];
  for (const r of rows) {
    assert.equal(page.pilotAvailable(r), pilotAvailable(r), JSON.stringify(r));
    for (const role of ['manager', 'salesperson', '']) {
      const word = subscriptionState(r, NOW);
      assert.equal(page.closedBillingStatus(word, r, { role }).canStartPilot, statusAnswer(r, { role, now: NOW }).canStartPilot, `${role} ${JSON.stringify(r)}`);
    }
  }
});

// ---------- seats ----------

test('seatCount: a seat is a member with the salesperson role, each person once; managers and other dealerships do not count', () => {
  assert.equal(SEAT_ROLE, 'salesperson');
  const other = '00000000-0000-4000-8000-0000000000d2';
  const m = (user_id, role, dealership_id = DEALER) => ({ user_id, dealership_id, role });
  const team = [m('u1', 'salesperson'), m('u2', 'salesperson'), m('u3', 'manager'), m('u4', 'salesperson', other)];
  assert.equal(seatCount(team, DEALER), 2, 'the manager and the other store\'s salesperson are left out');
  assert.equal(seatCount(team), 3, 'without a dealership every salesperson row counts');
  assert.equal(seatCount([m('u1', 'salesperson'), m('u1', 'salesperson')], DEALER), 1, 'one person is one seat');
  assert.equal(seatCount([{ user_id: 'u1', role: 'salesperson' }], DEALER), 1, 'a row without its dealership id is the caller\'s own read, filtered already');
  assert.equal(seatCount([m('u1', 'Salesperson'), m('', 'salesperson'), { role: 'salesperson' }, null, 'x', 7], DEALER), 0, 'a role in another case, no user id, junk');
  for (const bad of [null, undefined, 'x', {}, 3]) assert.equal(seatCount(bad), 0, String(bad));
  // the rule is where the prices are written: salespeople included and each extra one priced, no price for a manager
  assert.ok(Number.isInteger(pricing.includedSalespeople) && Number.isFinite(pricing.extraSalespersonMonthly));
  assert.deepEqual(Object.keys(pricing).filter((k) => /manager/i.test(k)), [], 'marketing/pricing.json prices no manager');
  const agreement = read('../legal/dealer-subscription-agreement.md');
  assert.match(agreement, /`perRooftopMonthly` \(which includes `includedSalespeople` salespeople\) plus `extraSalespersonMonthly` for each extra seat/);
  assert.match(agreement, /\| Included salespeople \| Extra seats \|/);
  assert.match(read('../marketing/onboarding-store.md'), /\*\*\d+\. Seats\.\*\* The subscription includes \w+ salespeople; each one beyond that is /);
});

test('the manager page\'s copy of the seat rule is this one, word for word, and counts the same on every case', () => {
  const block = (src, file) => {
    const found = src.match(/export const SEAT_ROLE = [^\n]+\nexport function seatCount\([\s\S]*?\n\}\n/);
    assert.ok(found, `${file} has SEAT_ROLE and seatCount`);
    return found[0];
  };
  assert.equal(block(read('../manager/data.js'), 'manager/data.js'), block(read('../supabase/functions/_shared/billing.mjs'), '_shared/billing.mjs'));
  assert.equal(page.SEAT_ROLE, SEAT_ROLE);
  const cases = [
    [[]], [null], [[{ user_id: 'a', role: 'salesperson' }]], [[{ user_id: 'a', role: 'manager' }]],
    [[{ user_id: 'a', role: 'salesperson', dealership_id: 'd1' }, { user_id: 'b', role: 'salesperson', dealership_id: 'd2' }], 'd1'],
    [[{ user_id: 'a', role: 'salesperson' }, { user_id: 'a', role: 'salesperson' }, { user_id: 'b', role: 'salesperson' }]],
    [page.mockData('2026-11-16T15:00:00.000Z').memberships],
  ];
  for (const args of cases) assert.equal(page.seatCount(...args), seatCount(...args), JSON.stringify(args));
  assert.doesNotMatch(read('../manager/data.js'), /from ['"][^'"]*supabase/, 'the page does not import the function\'s file (it is hosted on its own)');
});

// ---------- the checkout gate ----------

test('checkoutRefusal: no second Checkout while Stripe still holds a subscription open; a canceled or expired one, or none, may pay again', () => {
  assert.deepEqual(OPEN_STATUSES, ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused']);
  assert.equal(OPEN_SUBSCRIPTION_CODE, 'open-subscription');
  assert.equal(OPEN_SUBSCRIPTION_MESSAGE, 'update the card in Manage billing; the subscription is still open');
  // nothing yet, a pilot, a customer shell: a Checkout may open
  assert.equal(checkoutRefusal(null, NOW), null);
  assert.equal(checkoutRefusal(row({ status: 'pilot', pilot_ends_at: iso(NOW + 10 * DAY) }), NOW), null);
  assert.equal(checkoutRefusal(row({ stripe_customer_id: 'cus_1' }), NOW), null);
  assert.equal(checkoutRefusal(row({ status: 'pilot', pilot_ends_at: iso(NOW - DAY), stripe_customer_id: 'cus_1' }), NOW), null, 'a pilot that ended unpaid');
  // over in Stripe: a new subscription is the way back
  for (const s of ['canceled', 'incomplete_expired']) {
    assert.equal(checkoutRefusal(row({ status: s, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }), NOW), null, s);
    assert.equal(hasOpenSubscription(row({ status: s, stripe_subscription_id: 'sub_1' })), false, s);
  }
  assert.equal(checkoutRefusal(row({ status: null, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }), NOW), null, 'a subscription id with no status');
  // open in Stripe: 409, and the manager goes to the portal (Stripe retries the open invoice once the card is changed)
  for (const s of OPEN_STATUSES) {
    const r = row({ status: s, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    assert.equal(hasOpenSubscription(r), true, s);
    const refusal = checkoutRefusal(r, NOW);
    assert.equal(refusal.status, 409, s);
    if (subscriptionState(r, NOW) === 'active') {
      assert.deepEqual(refusal, { status: 409, error: 'this dealership already has a subscription: Manage billing updates the card or cancels it; to change seats, ask your Lot Current contact' }, s + ': the active gate stays');
    } else {
      assert.deepEqual(refusal, { status: 409, error: OPEN_SUBSCRIPTION_MESSAGE, code: OPEN_SUBSCRIPTION_CODE }, s);
    }
  }
  // a first payment still pending while the pilot runs is open too: the state is pilot, the gate still holds
  const pending = row({ status: 'incomplete', pilot_ends_at: iso(NOW + 3 * DAY), stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
  assert.equal(subscriptionState(pending, NOW), 'pilot');
  assert.equal(checkoutRefusal(pending, NOW).code, OPEN_SUBSCRIPTION_CODE);
  // an open status without a subscription id is not a subscription Stripe holds (nothing to update in the portal)
  assert.equal(hasOpenSubscription(row({ status: 'past_due' })), false);
  assert.equal(checkoutRefusal(row({ status: 'past_due', stripe_customer_id: 'cus_1' }), NOW), null);
  assert.equal(checkoutRefusal(row({ status: 'past_due', stripe_subscription_id: '' }), NOW), null);
  assert.equal(hasOpenSubscription(null), false);
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

// ---------- the plan the product reads ----------

test('planOf: the state word plus the dates and the seats the extension shows, in one shape, for every state', () => {
  const none = { state: 'none', pilotEndsAt: null, currentPeriodEnd: null, seats: null };
  assert.deepEqual(planOf(null, NOW), none);
  assert.deepEqual(planOf(undefined, NOW), none);
  assert.deepEqual(planOf('nonsense', NOW), none);
  assert.deepEqual(planOf(row({ stripe_customer_id: 'cus_1' }), NOW), { ...none, seats: 5 }, 'a customer shell is still no plan; the row\'s seats come along');
  assert.deepEqual(planOf(row({ status: 'pilot', pilot_ends_at: '2026-12-06T15:00:00.123456+00:00' }), NOW), { state: 'pilot', pilotEndsAt: '2026-12-06T15:00:00.123Z', currentPeriodEnd: null, seats: 5 }, 'Postgres microseconds and an offset become one ISO shape');
  assert.deepEqual(planOf(row({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', current_period_end: iso(NOW + 20 * DAY), seats: 7 }), NOW), { state: 'active', pilotEndsAt: null, currentPeriodEnd: iso(NOW + 20 * DAY), seats: 7 });
  assert.deepEqual(planOf(row({ status: 'trialing', pilot_ends_at: iso(NOW + 12 * DAY), current_period_end: iso(NOW + 12 * DAY) }), NOW), { state: 'active', pilotEndsAt: iso(NOW + 12 * DAY), currentPeriodEnd: iso(NOW + 12 * DAY), seats: 5 }, 'a trial waiting for the pilot to end is active, and both dates travel');
  assert.deepEqual(planOf(row({ status: 'pilot', pilot_ends_at: iso(NOW - DAY) }), NOW), { state: 'lapsed', pilotEndsAt: iso(NOW - DAY), currentPeriodEnd: null, seats: 5 }, 'a lapsed plan keeps its dates, so the page can say since when');
  assert.deepEqual(planOf(row({ status: 'canceled', current_period_end: iso(NOW - 3 * DAY) }), NOW), { state: 'lapsed', pilotEndsAt: null, currentPeriodEnd: iso(NOW - 3 * DAY), seats: 5 });
  // the state is subscriptionState's, whatever the row says
  for (const s of STATUSES) {
    const r = row({ status: s, pilot_ends_at: s === 'pilot' ? iso(NOW + DAY) : null });
    assert.equal(planOf(r, NOW).state, subscriptionState(r, NOW), s);
    assert.ok(STATES.includes(planOf(r, NOW).state), s);
  }
  // seats: the row's integer, or null when it is not one
  assert.equal(planOf(row({ seats: 0 }), NOW).seats, null);
  assert.equal(planOf(row({ seats: '7' }), NOW).seats, null);
  assert.equal(planOf(row({ seats: undefined }), NOW).seats, null);
  // the clock is the caller's, as for subscriptionState (milliseconds or ISO)
  assert.equal(planOf(row({ status: 'pilot', pilot_ends_at: iso(NOW + DAY) }), NOW + 2 * DAY).state, 'lapsed');
  assert.equal(planOf(row({ status: 'pilot', pilot_ends_at: iso(NOW + DAY) }), iso(NOW)).state, 'pilot');
  assert.deepEqual(Object.keys(planOf(null)), ['state', 'pilotEndsAt', 'currentPeriodEnd', 'seats'], 'the shape the sync answer promises');
});

test('lapsedAnswer: what /sync and /rewrite answer with 402, with the plan for the extension', () => {
  assert.equal(LAPSED_CODE, 'lapsed');
  assert.equal(LAPSED_MESSAGE, "the dealership's Lot Current subscription has lapsed: a manager can renew it, and the manager view's Billing card says how");
  const plan = planOf(row({ status: 'canceled', stripe_customer_id: 'cus_1' }), NOW);
  assert.deepEqual(lapsedAnswer(plan), { ok: false, error: LAPSED_MESSAGE, code: 'lapsed', plan });
  assert.equal(lapsedAnswer(plan).plan, plan, 'the plan itself');
  assert.equal(lapsedAnswer(plan).plan.state, 'lapsed');
  // the sentence says who can fix it and where, and promises nothing else
  assert.match(LAPSED_MESSAGE, /a manager can renew it, and the manager view's Billing card says how$/);
  assert.doesNotMatch(LAPSED_MESSAGE, /\$|guarantee|Facebook|Meta/);
});

test('todayRange: the calendar day the extension sent, in one ISO shape, or null for anything that is not a day', () => {
  assert.equal(MAX_TODAY_HOURS, 48);
  const from = Date.UTC(2026, 10, 16, 5, 0, 0); // a US Eastern midnight, as the extension would send it
  const day = { from: iso(from), to: iso(from + DAY) };
  assert.deepEqual(todayRange(day), day);
  assert.deepEqual(todayRange({ from: '2026-11-16T05:00:00.000000+00:00', to: '2026-11-17T00:00:00-05:00' }), day, 'any parseable stamps become UTC ISO with milliseconds');
  assert.deepEqual(todayRange({ from: from, to: from + DAY }), day, 'milliseconds work too');
  assert.deepEqual(todayRange({ from: iso(from), to: iso(from + 25 * 3600 * 1000) }), { from: iso(from), to: iso(from + 25 * 3600 * 1000) }, 'a clock-change day has 25 hours');
  assert.deepEqual(todayRange({ from: iso(from), to: iso(from + 48 * 3600 * 1000) }), { from: iso(from), to: iso(from + 48 * 3600 * 1000) }, 'the limit itself passes');
  assert.equal(todayRange({ from: iso(from), to: iso(from + 48 * 3600 * 1000 + 1) }), null, 'longer than the limit is not a day');
  assert.equal(todayRange({ from: iso(from), to: iso(from) }), null, 'an empty range');
  assert.equal(todayRange({ from: iso(from + DAY), to: iso(from) }), null, 'backwards');
  assert.equal(todayRange({ from: 'yesterday', to: iso(from + DAY) }), null);
  assert.equal(todayRange({ from: iso(from), to: '' }), null);
  assert.equal(todayRange({ from: iso(from) }), null);
  assert.equal(todayRange({ from: null, to: null }), null);
  assert.equal(todayRange({}), null);
  assert.equal(todayRange(null), null);
  assert.equal(todayRange(undefined), null);
  assert.equal(todayRange('2026-11-16'), null);
  assert.equal(todayRange([iso(from), iso(from + DAY)]), null);
  assert.equal(todayRange(day).from < todayRange(day).to, true);
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

test('checkoutSessionParams with automatic tax; automaticTaxOn takes only the word true; portalSessionParams names a configuration only when one is set', () => {
  const lineItems = [{ price: 'price_rooftop', quantity: 1 }];
  const p = checkoutSessionParams({ customerId: 'cus_1', dealershipId: DEALER, lineItems, returnUrl: 'https://manager.example.com/', automaticTax: true });
  assert.deepEqual([p.automatic_tax, p.billing_address_collection, p.customer_update], [{ enabled: true }, 'required', { address: 'auto', name: 'auto' }]);
  assert.equal('automatic_tax' in checkoutSessionParams({ customerId: 'cus_1', dealershipId: DEALER, lineItems, returnUrl: 'https://manager.example.com/', automaticTax: 'true' }), false, 'only a real true');
  assert.deepEqual(['true', ' TRUE ', 'True'].map(automaticTaxOn), [true, true, true]);
  assert.deepEqual(['', 'false', 'yes', '1', null, undefined].map(automaticTaxOn), [false, false, false, false, false, false]);
  assert.deepEqual(portalSessionParams({ customerId: 'cus_1', returnUrl: 'https://m.example/' }), { customer: 'cus_1', return_url: 'https://m.example/' });
  assert.deepEqual(portalSessionParams({ customerId: 'cus_1', returnUrl: 'https://m.example/', configuration: ' bpc_1 ' }), { customer: 'cus_1', return_url: 'https://m.example/', configuration: 'bpc_1' });
  assert.throws(() => portalSessionParams({ customerId: '', returnUrl: 'https://m.example/' }), /customer/);
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

test('applyStripeEvent: a cancellation in the portal is copied while Stripe keeps the status, and a renewal clears it', () => {
  const paying = row({ status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', current_period_end: iso(NOW + 30 * DAY), updated_at: iso(NOW - DAY) });
  // the portal cancels at the end of the period: status stays active, cancel_at_period_end says it will not renew
  const atEnd = applyStripeEvent(paying, event('customer.subscription.updated', sub({ cancel_at_period_end: true, cancel_at: T + 30 * 86400, canceled_at: T })), opts);
  assert.equal(atEnd.status, 'active', 'Stripe keeps it active until the end');
  assert.equal(atEnd.cancel_at_period_end, true);
  assert.equal(atEnd.cancel_at, iso(NOW + 30 * DAY));
  assert.equal(subscriptionState({ ...paying, ...atEnd }, NOW), 'active', 'still served until the end');
  // newer API versions may schedule the end through cancel_at alone
  const byDate = applyStripeEvent(paying, event('customer.subscription.updated', sub({ cancel_at_period_end: false, cancel_at: T + 30 * 86400 })), opts);
  assert.deepEqual([byDate.cancel_at_period_end, byDate.cancel_at], [false, iso(NOW + 30 * DAY)]);
  // a trial cancelled before its first charge
  const trial = applyStripeEvent(paying, event('customer.subscription.updated', sub({ status: 'trialing', cancel_at_period_end: true })), opts);
  assert.deepEqual([trial.status, trial.cancel_at_period_end, trial.cancel_at], ['trialing', true, null]);
  // renewed in the portal: both go back, so the card says renews again
  const renewed = applyStripeEvent({ ...paying, ...atEnd }, event('customer.subscription.updated', sub({ cancel_at_period_end: false, cancel_at: null }), T + 60), opts);
  assert.deepEqual([renewed.cancel_at_period_end, renewed.cancel_at], [false, null]);
  // invoices never touch them
  const paid = applyStripeEvent({ ...paying, ...atEnd }, event('invoice.paid', { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', lines: { data: [] } }, T + 60), opts);
  assert.ok(paid && !('cancel_at_period_end' in paid) && !('cancel_at' in paid));
});

test('applyStripeEvent: subscription created and updated copy the status, ids, period end and seats', () => {
  assert.deepEqual(HANDLED_EVENTS, ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);
  const created = applyStripeEvent(null, event('customer.subscription.created', sub()), opts);
  assert.deepEqual(created, { updated_at: iso(NOW), stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', current_period_end: iso(NOW + 30 * DAY), seats: 5, cancel_at_period_end: false, cancel_at: null });
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
  // an event about another subscription than the row's is dropped while the row's is open, whatever its age
  for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
    assert.equal(applyStripeEvent(active, event(type, sub({ id: 'sub_2', status: 'active' }), T - 60), opts), null, type + ', older');
    assert.equal(applyStripeEvent(active, event(type, sub({ id: 'sub_2', status: 'active' }), T + 60), opts), null, type + ', newer');
  }
  // the new subscription after a cancel is adopted: created, newer than the row's last change, on a row whose subscription is over
  for (const status of ['canceled', 'incomplete_expired', null]) {
    const over = row({ status, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', updated_at: iso(NOW) });
    const other = applyStripeEvent(over, event('customer.subscription.created', sub({ id: 'sub_2', status: 'active' }), T + 60), opts);
    assert.equal(other.stripe_subscription_id, 'sub_2', String(status));
    assert.equal(other.status, 'active', String(status));
    assert.equal(subscriptionState({ ...over, ...other }, NOW + 60_000), 'active', String(status));
    // not by an update or a delete of it, and not by a created older than the row's last change
    assert.equal(applyStripeEvent(over, event('customer.subscription.updated', sub({ id: 'sub_2' }), T + 60), opts), null, String(status));
    assert.equal(applyStripeEvent(over, event('customer.subscription.deleted', sub({ id: 'sub_2' }), T + 60), opts), null, String(status));
    assert.equal(applyStripeEvent(over, event('customer.subscription.created', sub({ id: 'sub_2' }), T - 60), opts), null, String(status));
  }
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
  // an invoice must name the row's subscription: another one's, none, or a row without a subscription yet changes nothing
  assert.equal(applyStripeEvent(active, event('invoice.payment_failed', { ...oldShape, subscription: 'sub_2' }), opts), null);
  assert.equal(applyStripeEvent(active, event('invoice.paid', { ...newShape, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_2' } } }), opts), null);
  assert.equal(applyStripeEvent(active, event('invoice.payment_failed', { id: 'in_3', object: 'invoice', customer: 'cus_1' }), opts), null, 'a one-off invoice of the customer is not the subscription');
  assert.equal(applyStripeEvent({ ...active, stripe_subscription_id: null }, event('invoice.paid', oldShape), opts), null);
});

test('applyStripeEvent: after a new subscription replaces a canceled one, the old one\'s dunning and its final delete change nothing', () => {
  // sub_1 was canceled; the manager paid again and the row moved to sub_2
  const canceled = row({ status: 'canceled', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', updated_at: iso(NOW - 2 * DAY) });
  const adopted = applyStripeEvent(canceled, event('customer.subscription.created', sub({ id: 'sub_2', status: 'active' }), T - 86400), opts);
  const current = { ...canceled, ...adopted };
  assert.equal(current.stripe_subscription_id, 'sub_2');
  assert.equal(subscriptionState(current, NOW), 'active');
  // Stripe goes on about sub_1: a retried invoice fails, dunning gives up, the subscription is deleted
  const sub1Invoice = { id: 'in_9', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { start: T, end: T + 30 * 86400 } }] } };
  assert.equal(applyStripeEvent(current, event('invoice.payment_failed', sub1Invoice, T), opts), null);
  assert.equal(applyStripeEvent(current, event('customer.subscription.updated', sub({ id: 'sub_1', status: 'unpaid' }), T), opts), null);
  assert.equal(applyStripeEvent(current, event('customer.subscription.deleted', sub({ id: 'sub_1', status: 'canceled' }), T), opts), null);
  assert.equal(applyStripeEvent(current, event('invoice.paid', sub1Invoice, T), opts), null, 'a late success of the old one does not move the paid-through date either');
  assert.equal(subscriptionState(current, NOW), 'active', 'the store that just paid stays active');
  // sub_2's own events still land
  const paid = applyStripeEvent(current, event('invoice.paid', { ...sub1Invoice, id: 'in_10', subscription: 'sub_2' }, T), opts);
  assert.equal(paid.current_period_end, iso(NOW + 30 * DAY));
  assert.equal(applyStripeEvent(current, event('customer.subscription.updated', sub({ id: 'sub_2', status: 'past_due' }), T), opts).status, 'past_due');
  // and with the row on sub_2 and open, the checkout gate sends the manager to the portal instead of a third subscription
  assert.equal(checkoutRefusal({ ...current, status: 'past_due' }, NOW).code, OPEN_SUBSCRIPTION_CODE);
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
  // the checkout gate is the shared rule, before a customer or a session is made
  assert.match(src, /import \{[^}]*\bcheckoutRefusal\b[^}]*\} from '\.\.\/_shared\/billing\.mjs'/);
  const gate = src.indexOf('const refusal = checkoutRefusal(row);');
  assert.ok(gate > 0);
  assert.match(src, /if \(refusal\) return json\(req, refusal\.status, \{ ok: false, error: refusal\.error, \.\.\.\(refusal\.code \? \{ code: refusal\.code \} : \{\}\) \}\);/);
  assert.ok(gate < src.indexOf('await ensureCustomer(service, dealership, row, caller.user.email)'), 'before a customer is made');
  assert.ok(gate < src.indexOf("'/v1/checkout/sessions'"), 'before a Checkout is opened');
  assert.match(src, /if \(route === 'webhook'\) \{\s*if \(req\.method !== 'POST'\)[^]*?return webhook\(req\);/);
});
