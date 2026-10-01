// Lot Current billing (Milestone 5): the pure parts of the billing function,
// as plain JavaScript so the Deno function (functions/billing/index.ts)
// imports it and test/billing.test.js runs the same code in Node. Nothing in
// here touches the network or a database: the state machine, the Checkout
// line items and session parameters, Stripe's form encoding, what each
// webhook event does to the subscription row, and the webhook signature
// check (HMAC-SHA256 through Web Crypto, which Deno and Node 22 both offer
// on globalThis.crypto.subtle), plus what /sync and /rewrite tell a member
// about the plan (planOf, and the 402 for a lapsed dealership), the
// calendar day the daily cap counts (todayRange) and who takes a seat
// (seatCount). No Stripe SDK anywhere.
//
// The row is public.subscriptions from migrations/0004_billing.sql, with
// cancel_at from 0009_cancel_at.sql:
//   dealership_id, stripe_customer_id, stripe_subscription_id, status,
//   pilot_ends_at, current_period_end, cancel_at, seats, updated_at
//
// The state a dealership is in, from the row (subscriptionState below and
// subscription_state() in SQL, kept equal by supabase/tests/billing.sql):
//   none    no row, or a row with no status and no pilot (a Stripe customer
//           was created for a checkout that never finished)
//   pilot   pilot_ends_at is in the future and nothing is paid: the free
//           period runs, no card needed, whatever Stripe says meanwhile
//   active  Stripe says trialing or active (trialing is a paid subscription
//           whose first charge waits for the pilot to end)
//   lapsed  everything else: the pilot ended unpaid, past_due, unpaid,
//           canceled, incomplete, incomplete_expired, paused

// From marketing/pricing.json, a hypothesis until a dealer agrees to a price
// in writing (docs/launch-checklist.md, "Pricing confirmed").
// test/billing.test.js keeps these equal to that file and to the numbers
// baked into migrations/0004_billing.sql (seats default, start_pilot).
export const PRICING = Object.freeze({ includedSalespeople: 5, pilotDays: 30 });

// 'pilot' is Lot Current's own (no Stripe object behind it); the rest are every
// status Stripe can put on a subscription, so a webhook never fails the
// row's check constraint.
export const STATUSES = Object.freeze(['pilot', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']);
export const STATES = Object.freeze(['none', 'pilot', 'active', 'lapsed']);
export const HANDLED_EVENTS = Object.freeze(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);
export const MAX_SEATS = 200;
export const MIN_TRIAL_SECONDS = 48 * 3600; // Stripe: a Checkout trial_end must be at least 48 hours away
export const SIGNATURE_TOLERANCE_SECONDS = 300; // Stripe's own default for replay protection

const isRecord = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

// A time as milliseconds: ISO text (Postgres keeps microseconds; Date.parse
// wants at most three digits), a Date, or a number of milliseconds.
export function ms(x) {
  if (x === null || x === undefined || x === '') return null;
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x.getTime();
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  const t = Date.parse(String(x).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : t;
}

const unixToIso = (seconds) => (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
const idOf = (x) => (typeof x === 'string' ? x : isRecord(x) && typeof x.id === 'string' ? x.id : '');

// ---------- the state machine ----------

// Stripe keeps a subscription open in these statuses (a trial or a paid
// period running, an invoice in dunning, a first payment not finished, a
// pause): the card is changed in the Billing Portal and Stripe retries the
// open invoice. Everything else (canceled, incomplete_expired, no
// subscription at all) is over, and a new Checkout is how to pay again.
export const OPEN_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused']);
export const OPEN_SUBSCRIPTION_CODE = 'open-subscription';
export const OPEN_SUBSCRIPTION_MESSAGE = 'update the card in Manage billing; the subscription is still open';

// The row (or null) and the moment to judge it at (milliseconds or ISO).
export function subscriptionState(row, now = Date.now()) {
  if (!isRecord(row)) return 'none';
  const at = ms(now) ?? Date.now();
  const status = typeof row.status === 'string' ? row.status : null;
  if (status === 'trialing' || status === 'active') return 'active';
  const pilotEnds = ms(row.pilot_ends_at);
  if (pilotEnds !== null && pilotEnds > at) return 'pilot';
  if (status === null && pilotEnds === null) return 'none';
  return 'lapsed';
}

// Whether Stripe still holds a subscription open for the row.
export function hasOpenSubscription(row) {
  return isRecord(row) && typeof row.stripe_subscription_id === 'string' && row.stripe_subscription_id !== '' && OPEN_STATUSES.includes(String(row.status));
}

// Why POST /billing/checkout must not open a new Checkout for this row, as
// { status, error, code? } for the answer, or null when it may. An active
// dealership changes its plan in the portal; one whose subscription Stripe
// still holds open updates the card there (a second Checkout would open a
// second subscription on the same customer, and the old one's dunning
// events would then keep flipping the row back to lapsed).
export function checkoutRefusal(row, now = Date.now()) {
  if (subscriptionState(row, now) === 'active') return { status: 409, error: 'this dealership already has a subscription: Manage billing updates the card or cancels it; to change seats, ask your Lot Current contact' };
  if (hasOpenSubscription(row)) return { status: 409, error: OPEN_SUBSCRIPTION_MESSAGE, code: OPEN_SUBSCRIPTION_CODE };
  return null;
}

// A pilot can start when there is no row, or only the shell of one (a Stripe
// customer from a checkout that never finished: no status, no pilot).
// start_pilot() in SQL applies the same rule.
export function pilotAvailable(row) {
  if (!isRecord(row)) return true;
  return (row.status === null || row.status === undefined) && (row.pilot_ends_at === null || row.pilot_ends_at === undefined);
}

// What GET /billing/status answers, from the row and the caller's role: the
// state, the row, which buttons the manager page may show, and the
// dealership's seat count now (`salespeople`, from seatCount below), which
// the function counts for a manager only and passes in; null when it was
// not counted.
export function statusAnswer(row, { role = '', now = Date.now(), pricing = PRICING, salespeople = null } = {}) {
  const state = subscriptionState(row, now);
  const manager = role === 'manager';
  return {
    state,
    subscription: isRecord(row) ? { ...row } : null,
    canStartPilot: manager && pilotAvailable(row),
    canSubscribe: manager && state !== 'active' && !hasOpenSubscription(row), // checkout refuses a second subscription; the portal renews the open one
    canManageBilling: manager && isRecord(row) && typeof row.stripe_customer_id === 'string' && row.stripe_customer_id !== '',
    pilotDays: pricing.pilotDays,
    includedSalespeople: pricing.includedSalespeople,
    salespeople: Number.isInteger(salespeople) && salespeople >= 0 ? salespeople : null,
  };
}

// ---------- seats ----------

// Who takes a seat. marketing/pricing.json prices a rooftop with
// includedSalespeople salespeople in it and extraSalespersonMonthly for each
// salesperson beyond them; the sales sheet, marketing/positioning.md, the
// Seats step of marketing/onboarding-store.md and Schedule A of
// legal/dealer-subscription-agreement.md ("Included salespeople", "Extra
// seats") say the same, and none of them prices a manager. So a seat is a
// membership with the salesperson role, each person once. The manager page
// cannot import this file (it is hosted on its own), so manager/data.js keeps
// a copy of these lines, word for word; test/billing.test.js holds the two
// equal.
export const SEAT_ROLE = 'salesperson';
export function seatCount(memberships, dealershipId = '') {
  const people = new Set();
  for (const m of Array.isArray(memberships) ? memberships : []) {
    if (!m || typeof m !== 'object' || m.role !== SEAT_ROLE || typeof m.user_id !== 'string' || !m.user_id) continue;
    if (dealershipId && m.dealership_id && m.dealership_id !== dealershipId) continue;
    people.add(m.user_id);
  }
  return people.size;
}

// ---------- the plan the product reads ----------

const isoOrNull = (x) => {
  const t = ms(x);
  return t === null ? null : new Date(t).toISOString();
};

// What a member's extension learns about the dealership's plan from /sync:
// the state word and, for the lines it shows, the pilot's end, the
// paid-through date and the seat count, from the row (or null for none).
// Dates go out as ISO text with milliseconds whatever shape Postgres gave
// them, so the extension parses one shape.
export function planOf(row, now = Date.now()) {
  const r = isRecord(row) ? row : null;
  return {
    state: subscriptionState(r, now),
    pilotEndsAt: r ? isoOrNull(r.pilot_ends_at) : null,
    currentPeriodEnd: r ? isoOrNull(r.current_period_end) : null,
    seats: r && Number.isInteger(r.seats) && r.seats >= 1 ? r.seats : null,
  };
}

// A lapsed dealership: /sync and /rewrite answer this with HTTP 402 and do
// nothing else (nothing written, nothing generated, nothing spent). The
// sentence is for the salesperson; `code` is what the extension branches
// on; `plan` lets it say since when. The billing function is never gated:
// a lapsed dealership must be able to renew.
export const LAPSED_CODE = 'lapsed';
export const LAPSED_MESSAGE = "the dealership's Lot Current subscription has lapsed: a manager can renew it in the manager view";
export function lapsedAnswer(plan) {
  return { ok: false, error: LAPSED_MESSAGE, code: LAPSED_CODE, plan };
}

// ---------- the day the daily cap counts ----------

// The extension sends its local calendar day with /sync as
// { today: { from, to } }, two ISO stamps, and the function counts the
// caller's posts in that half-open range (postsToday) so the per-salesperson
// cap holds across their machines. The range is taken only when it is a
// day: both stamps parse, from is before to, and the span is at most
// MAX_TODAY_HOURS (a 25-hour clock-change day fits; a week does not). Null
// otherwise, and then postsToday is null: a count over a made-up range
// would be a made-up number.
export const MAX_TODAY_HOURS = 48;
export function todayRange(today) {
  if (!isRecord(today)) return null;
  const from = ms(today.from);
  const to = ms(today.to);
  if (from === null || to === null || from >= to || to - from > MAX_TODAY_HOURS * 3600 * 1000) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

// ---------- Checkout ----------

// Seats a dealership pays for: never below the included count (the rooftop
// price covers those), never above MAX_SEATS, the included count when the
// request says nothing usable.
export function normalizeSeats(seats, included = PRICING.includedSalespeople) {
  const n = typeof seats === 'string' && seats.trim() !== '' ? Number(seats) : seats;
  if (!Number.isInteger(n) || n < 1) return included;
  return Math.min(Math.max(n, included), MAX_SEATS);
}

// One rooftop line, plus one seat line for whatever is above the included
// count. Throws when the price for a needed line is not configured, so the
// function answers 500 with the variable's name instead of billing wrong.
export function checkoutLineItems({ seats, included = PRICING.includedSalespeople, priceRooftop, priceSeat } = {}) {
  if (!priceRooftop) throw new Error('STRIPE_PRICE_ROOFTOP is not set on the function');
  const inc = Number.isInteger(included) && included >= 0 ? included : PRICING.includedSalespeople;
  const extra = normalizeSeats(seats, inc) - inc;
  const items = [{ price: priceRooftop, quantity: 1 }];
  if (extra > 0) {
    if (!priceSeat) throw new Error(`STRIPE_PRICE_SEAT is not set on the function, so seats above the included ${inc} cannot be billed`);
    items.push({ price: priceSeat, quantity: extra });
  }
  return items;
}

// The comma-separated ALLOWED_RETURN_ORIGINS secret as a list of origins.
export function parseAllowedOrigins(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const s = part.trim().replace(/\/+$/, '').toLowerCase();
    if (!s) continue;
    try {
      const u = new URL(s);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !out.includes(u.origin)) out.push(u.origin);
    } catch {
      /* not an origin; ignored */
    }
  }
  return out;
}

// The page Stripe sends the manager back to, only when it sits on one of the
// allowed origins (the manager page's own address); null otherwise. Stripe
// would happily redirect anywhere, so the allowlist is what keeps a stolen
// token from sending a manager to a look-alike page.
export function allowedReturnUrl(returnUrl, allowedOrigins) {
  let u;
  try {
    u = new URL(String(returnUrl || ''));
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : parseAllowedOrigins(allowedOrigins);
  if (!origins.includes(u.origin.toLowerCase())) return null;
  return u.toString();
}

// The success and cancel addresses: the page itself with ?billing=success
// or ?billing=canceled added, so it can say what happened when it reloads.
export function returnUrls(returnUrl) {
  const withFlag = (flag) => {
    const u = new URL(returnUrl);
    u.searchParams.set('billing', flag);
    return u.toString();
  };
  return { success_url: withFlag('success'), cancel_url: withFlag('canceled') };
}

// When a running pilot has more than 48 hours left, the subscription starts
// as a trial that ends when the pilot does, so the card is charged at the
// end of the free period and not at checkout. Under 48 hours (Stripe's
// minimum for a Checkout trial) the charge is immediate; null says so.
export function trialEndFor(pilotEndsAt, now = Date.now()) {
  const end = ms(pilotEndsAt);
  const at = ms(now) ?? Date.now();
  if (end === null || end - at < MIN_TRIAL_SECONDS * 1000) return null;
  return Math.floor(end / 1000);
}

// The Checkout Session as Stripe's form wants it. subscription_data.metadata
// carries the dealership id so a webhook can find the row even when the
// customer id is unknown; allow_promotion_codes lets the owner hand a
// founding dealer a code instead of a second price. automaticTax (the
// STRIPE_AUTOMATIC_TAX secret, off until the attorney has said what to
// collect) has Stripe add sales tax: Checkout then asks for the billing
// address and saves it on the customer, which Stripe needs to work tax out.
export function checkoutSessionParams({ customerId, dealershipId, lineItems, returnUrl, trialEnd = null, automaticTax = false }) {
  if (!customerId) throw new Error('a Stripe customer id is required');
  if (!dealershipId) throw new Error('a dealership id is required');
  if (!Array.isArray(lineItems) || !lineItems.length) throw new Error('line items are required');
  const params = {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: dealershipId,
    line_items: lineItems,
    ...returnUrls(returnUrl),
    allow_promotion_codes: true,
    subscription_data: { metadata: { dealership_id: dealershipId } },
  };
  if (typeof trialEnd === 'number' && trialEnd > 0) params.subscription_data.trial_end = trialEnd;
  if (automaticTax === true) {
    params.automatic_tax = { enabled: true };
    params.billing_address_collection = 'required';
    params.customer_update = { address: 'auto', name: 'auto' };
  }
  return params;
}

// The STRIPE_AUTOMATIC_TAX secret as a switch: only the word true (any case)
// turns it on, so a typo leaves tax off rather than half on.
export function automaticTaxOn(text) {
  return String(text || '').trim().toLowerCase() === 'true';
}

// The Billing Portal session. configuration is the STRIPE_PORTAL_CONFIGURATION
// secret (bpc_..., made by scripts/stripe-setup.mjs): without it Stripe uses
// the account's default portal settings, which exist only once someone has
// saved them in the Dashboard.
export function portalSessionParams({ customerId, returnUrl, configuration = '' }) {
  if (!customerId) throw new Error('a Stripe customer id is required');
  const params = { customer: customerId, return_url: returnUrl };
  const id = String(configuration || '').trim();
  if (id) params.configuration = id;
  return params;
}

// ---------- Stripe's form encoding ----------

// application/x-www-form-urlencoded with Stripe's bracket convention for
// nested objects and arrays: { line_items: [{ price: 'p' }] } becomes
// line_items[0][price]=p. null and undefined are left out; booleans are the
// words true and false. Brackets are kept literal, as Stripe's own
// libraries send them.
export function formEncode(obj) {
  const params = new URLSearchParams();
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => add(`${key}[${i}]`, v));
      return;
    }
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
      return;
    }
    params.append(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
  };
  for (const [k, v] of Object.entries(isRecord(obj) ? obj : {})) add(k, v);
  return params.toString().replace(/%5B/g, '[').replace(/%5D/g, ']');
}

// ---------- what a webhook event does to the row ----------

// The subscription's period end: on the subscription itself (API versions
// before 2025-03-31) or on its items (from that version on); the latest
// item wins when they differ.
function periodEndOf(sub) {
  const own = unixToIso(sub.current_period_end);
  if (own) return own;
  const items = isRecord(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  let best = 0;
  for (const it of items) if (isRecord(it) && typeof it.current_period_end === 'number' && it.current_period_end > best) best = it.current_period_end;
  return unixToIso(best);
}

// An invoice's subscription id: invoice.subscription (before 2025-03-31) or
// invoice.parent.subscription_details.subscription (from that version on).
function invoiceSubscriptionOf(inv) {
  const direct = idOf(inv.subscription);
  if (direct) return direct;
  const parent = isRecord(inv.parent) ? inv.parent : {};
  const details = isRecord(parent.subscription_details) ? parent.subscription_details : {};
  return idOf(details.subscription);
}

// The period an invoice pays for ends when its latest line's period ends.
function invoicePeriodEndOf(inv) {
  const lines = isRecord(inv.lines) && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  let best = 0;
  for (const line of lines) {
    const p = isRecord(line) && isRecord(line.period) ? line.period : {};
    if (typeof p.end === 'number' && p.end > best) best = p.end;
  }
  return unixToIso(best);
}

// The tag scripts/stripe-setup.mjs puts on each price it makes (metadata
// lotcurrent = 'rooftop' or 'seat'). A reprice makes a new price and moves
// the lookup key to it, but subscribers already paying stay on the old
// price, which keeps its tag; so the tag, not the configured id, says what
// an item is.
export const PRICE_TAG = 'lotcurrent';
const tagOf = (price) => (isRecord(price) && isRecord(price.metadata) && typeof price.metadata[PRICE_TAG] === 'string' ? price.metadata[PRICE_TAG] : '');

// Seats from the subscription's items: the included count plus the seat
// items' quantity. An item whose price is tagged 'seat' is seats and one
// tagged 'rooftop' is not, whatever the configured ids say now. An untagged
// price (made by hand in the Dashboard) falls back to the configured ids:
// the seat price's quantity, or, with no seat price configured, every item
// that is not the rooftop. null when the items say nothing, or when an
// untagged item cannot be placed because no price is configured.
function seatsOf(sub, included, priceRooftop, priceSeat) {
  const items = isRecord(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : null;
  if (!items) return null;
  let extra = 0;
  for (const it of items) {
    if (!isRecord(it)) continue;
    const qty = Number.isInteger(it.quantity) ? it.quantity : 0;
    const tag = tagOf(it.price) || tagOf(it.plan);
    if (tag === 'seat' || tag === 'rooftop') {
      if (tag === 'seat') extra += qty;
      continue;
    }
    if (!priceSeat && !priceRooftop) return null;
    const price = idOf(it.price) || idOf(it.plan);
    if (priceSeat ? price === priceSeat : price !== priceRooftop) extra += qty;
  }
  return Math.min(included + extra, MAX_SEATS);
}

// A status Stripe sent, or 'unpaid' for one this code does not know (the
// safe reading: not active).
export function normalizeStatus(status) {
  return typeof status === 'string' && status !== 'pilot' && STATUSES.includes(status) ? status : 'unpaid';
}

// Stripe does not deliver events in order, and a customer's old subscription
// goes on sending events (dunning retries, the final delete) after the row
// has moved to a new one. An event is stale, and must not win, when it is
// older than the row's last change for the same subscription, or when it is
// about another subscription than the row's; the one exception is
// customer.subscription.created, newer than the row's last change, on a row
// whose subscription is over (canceled, incomplete_expired) or that never
// had one: the replacement a manager just paid for.
const OVER_STATUSES = Object.freeze(['canceled', 'incomplete_expired']);
function isStale(row, subscriptionId, eventMs, eventType = '') {
  if (!isRecord(row)) return false;
  const last = ms(row.updated_at);
  const have = typeof row.stripe_subscription_id === 'string' && row.stripe_subscription_id !== '' ? row.stripe_subscription_id : '';
  if (!have) return false; // a row with no subscription yet (a pilot, a customer shell) takes the first one whatever its stamp
  if (subscriptionId !== have) {
    const over = row.status === null || row.status === undefined || OVER_STATUSES.includes(String(row.status));
    return !(eventType === 'customer.subscription.created' && over && (last === null || eventMs > last));
  }
  return last !== null && last > eventMs;
}

// The columns to set on the dealership's row for one event, or null when
// the event is not one of HANDLED_EVENTS, is stale, or has nothing to
// change. `row` is the current row or null. included and the two price ids
// are the function's configuration.
export function applyStripeEvent(row, event, { included = PRICING.includedSalespeople, priceRooftop = '', priceSeat = '' } = {}) {
  if (!isRecord(event) || !HANDLED_EVENTS.includes(event.type)) return null;
  const obj = isRecord(event.data) && isRecord(event.data.object) ? event.data.object : null;
  if (!obj) return null;
  const at = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created * 1000 : Date.now();
  const patch = { updated_at: new Date(at).toISOString() };
  const customer = idOf(obj.customer);
  if (customer) patch.stripe_customer_id = customer;

  if (event.type.startsWith('customer.subscription.')) {
    const subscriptionId = idOf(obj);
    if (isStale(row, subscriptionId, at, event.type)) return null;
    if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
    patch.status = event.type === 'customer.subscription.deleted' ? 'canceled' : normalizeStatus(obj.status);
    const end = periodEndOf(obj);
    if (end) patch.current_period_end = end;
    // A cancellation scheduled in the portal leaves the status trialing or
    // active until the period ends; the date it ends is kept, and written on
    // every subscription event, so undoing the cancellation clears it.
    patch.cancel_at = unixToIso(obj.cancel_at) || (obj.cancel_at_period_end === true ? end : null);
    const seats = seatsOf(obj, Number.isInteger(included) ? included : PRICING.includedSalespeople, priceRooftop, priceSeat);
    if (seats !== null) patch.seats = seats;
    return patch;
  }

  // invoices: only ever adjust a row the subscription events created, and
  // only when they name the row's own subscription
  if (!isRecord(row) || typeof row.stripe_subscription_id !== 'string' || row.stripe_subscription_id === '') return null;
  const subscriptionId = invoiceSubscriptionOf(obj);
  if (isStale(row, subscriptionId, at, event.type)) return null;
  if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
  if (event.type === 'invoice.payment_failed') {
    patch.status = 'past_due';
    return patch;
  }
  // invoice.paid: the period is paid for. The status is left to the
  // subscription events (a $0 trial invoice is paid while the subscription
  // is trialing), except that a paid-up row is no longer past due.
  const end = invoicePeriodEndOf(obj);
  if (end) patch.current_period_end = end;
  if (['past_due', 'unpaid', 'incomplete'].includes(String(row.status))) patch.status = 'active';
  return patch;
}

// ---------- the webhook signature ----------

// Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...] (several v1
// entries while a secret is being rolled; any one may match).
export function parseStripeSignature(header) {
  const out = { timestamp: null, signatures: [] };
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) out.timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) out.signatures.push(value.toLowerCase());
  }
  return out;
}

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret, message) {
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Same length and every character equal, looked at in full whatever the
// first difference, so timing says nothing about where they differ.
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe's check, as its docs describe it: the signed payload is
// "<t>.<raw body>", HMAC-SHA256 with the endpoint's signing secret, hex; the
// timestamp must be within the tolerance of now (a replayed event fails).
// `now` is in Unix seconds. The body must be the raw text exactly as it
// arrived; re-serialised JSON would not match.
export async function verifyStripeSignature(header, rawBody, secret, now = Date.now() / 1000, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS) {
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set on the function' };
  const { timestamp, signatures } = parseStripeSignature(header);
  if (timestamp === null || !signatures.length) return { ok: false, reason: 'the Stripe-Signature header is missing or malformed' };
  if (Math.abs(Math.floor(now) - timestamp) > toleranceSeconds) return { ok: false, reason: 'the event timestamp is outside the tolerance (a replay, or a clock that is off)' };
  const expected = await hmacSha256Hex(secret, `${timestamp}.${String(rawBody ?? '')}`);
  const ok = signatures.some((s) => timingSafeEqualHex(s, expected));
  return ok ? { ok: true, timestamp } : { ok: false, reason: 'the signature does not match (a different secret, or an altered body)' };
}
