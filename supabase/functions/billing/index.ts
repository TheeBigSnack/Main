// Lot Sync billing on Stripe as a Supabase Edge Function (Milestone 5). A
// dealership is billed per rooftop per month; a manager starts a free pilot
// period without a card (start_pilot() in SQL), subscribes from the manager
// page through Stripe Checkout, and changes the card or cancels in Stripe's
// Billing Portal. Stripe tells this function what happened through a
// webhook, and the function copies the status into public.subscriptions.
//
//   POST …/billing/checkout  { returnUrl, seats?, dealershipId? | origin? } -> { ok, url }   (managers)
//                            -> 409 { ok: false, error, code: 'open-subscription' } while Stripe still holds the
//                               dealership's subscription open (checkoutRefusal): the card is changed in the portal
//   POST …/billing/portal    { returnUrl, dealershipId? | origin? }         -> { ok, url }   (managers)
//   GET  …/billing/status    ?dealershipId= | ?origin=                       -> { ok, dealership, role, state, subscription, canStartPilot, canSubscribe, canManageBilling, pilotDays, includedSalespeople, salespeople }   (members)
//                            salespeople is the seat count now (seatCount), for a manager's call; null for anyone else's
//   POST …/billing/webhook   Stripe's event with its Stripe-Signature header -> { ok }        (Stripe)
//
// Stripe is called with fetch against its REST API (form-encoded, bearer
// secret key): no SDK, so the function has no dependency to keep current.
// The secret key, the webhook signing secret and the two price ids live in
// function secrets only. A browser sends the anon key and the person's own
// token, nothing else; Stripe's redirect addresses are taken from the
// request only when they sit on an origin in ALLOWED_RETURN_ORIGINS.
//
// The pure parts (the state machine, the line items, the form encoding,
// what each event does to the row, the signature check) are in
// ../_shared/billing.mjs and unit-tested in Node (test/billing.test.js).
//
// config.toml needs `[functions.billing] verify_jwt = false` (or deploy
// with --no-verify-jwt): Stripe's webhook carries no Supabase token, and
// the function checks the caller's token itself on the other three routes.

import { json, preflight, readJson, routeOf, isRecord, errorMessage, sameOrigin } from '../_shared/http.ts';
import { requireUser, membershipsOf, serviceClient, env, type Membership, type Dealership } from '../_shared/auth.ts';
import {
  PRICING, HANDLED_EVENTS,
  subscriptionState, statusAnswer, seatCount, checkoutRefusal, normalizeSeats, checkoutLineItems, checkoutSessionParams, trialEndFor,
  allowedReturnUrl, parseAllowedOrigins, formEncode, applyStripeEvent, verifyStripeSignature,
} from '../_shared/billing.mjs';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const config = {
  secretKey: env('STRIPE_SECRET_KEY'),
  webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  priceRooftop: env('STRIPE_PRICE_ROOFTOP'),
  priceSeat: env('STRIPE_PRICE_SEAT'),
  allowedReturnOrigins: parseAllowedOrigins(env('ALLOWED_RETURN_ORIGINS')),
  stripeUrl: 'https://api.stripe.com',
  timeoutMs: 20_000,
  bodyLimit: 16 * 1024,
  webhookLimit: 1024 * 1024,
  perMinute: 10, // checkout and portal sessions per manager per minute; a brake, not a ledger
};

type Row = Record<string, unknown>;

// ---------- per-user rate limit (this instance only), as in rewrite ----------

const recent = new Map<string, number[]>();
function allow(who: string): boolean {
  const now = Date.now();
  const list = (recent.get(who) || []).filter((t) => now - t < 60_000);
  if (list.length >= config.perMinute) return false;
  list.push(now);
  recent.set(who, list);
  if (recent.size > 5000) {
    for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  }
  return true;
}

// ---------- the Stripe REST API, by fetch ----------

class StripeError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One call. POST bodies are form-encoded the way Stripe wants them; GET
// parameters go in the query. Stripe's own error sentence comes back for
// the manager to read (it never contains a key); a rejected secret key is
// reported without echoing anything.
async function stripe(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<Row> {
  if (!config.secretKey) throw new StripeError(500, 'STRIPE_SECRET_KEY is not set on the function');
  const headers: Record<string, string> = { Authorization: `Bearer ${config.secretKey}` };
  let url = config.stripeUrl + path;
  let body: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = formEncode(params || {});
  } else if (params) {
    url += '?' + formEncode(params);
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch {
    throw new StripeError(502, 'could not reach Stripe; try again in a moment');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no readable body */
  }
  if (!res.ok) {
    if (res.status === 401) throw new StripeError(502, 'Stripe rejected the secret key set on the function');
    const err = isRecord(data) && isRecord(data.error) ? data.error : {};
    const message = typeof err.message === 'string' ? err.message : `Stripe answered ${res.status}`;
    throw new StripeError(res.status === 404 ? 404 : 502, message, typeof err.code === 'string' ? err.code : '');
  }
  return isRecord(data) ? data : {};
}

// ---------- the row ----------

async function readRow(service: SupabaseClient, dealershipId: string): Promise<Row | null> {
  const { data, error } = await service.from('subscriptions').select('*').eq('dealership_id', dealershipId).maybeSingle();
  if (error) throw new Error('could not read subscriptions: ' + error.message);
  return isRecord(data) ? data : null;
}

async function findRow(service: SupabaseClient, column: 'stripe_customer_id' | 'stripe_subscription_id', value: string): Promise<Row | null> {
  if (!value) return null;
  const { data, error } = await service.from('subscriptions').select('*').eq(column, value).maybeSingle();
  if (error) throw new Error('could not read subscriptions: ' + error.message);
  return isRecord(data) ? data : null;
}

async function writeRow(service: SupabaseClient, dealershipId: string, patch: Row): Promise<void> {
  const { error } = await service.from('subscriptions').upsert({ ...patch, dealership_id: dealershipId }, { onConflict: 'dealership_id' });
  if (error) throw new Error('could not write subscriptions: ' + error.message);
}

// The Stripe customer for a dealership: the one on the row when it still
// exists, else a new one carrying the dealership id in its metadata (how a
// webhook finds the row when nothing else does). The idempotency key makes
// two clicks in the same moment one customer.
async function ensureCustomer(service: SupabaseClient, dealership: Dealership, row: Row | null, email: string | null): Promise<string> {
  const have = row && typeof row.stripe_customer_id === 'string' ? row.stripe_customer_id : '';
  if (have) {
    try {
      const c = await stripe('GET', `/v1/customers/${encodeURIComponent(have)}`);
      if (c.deleted !== true) return have;
    } catch (e) {
      if (!(e instanceof StripeError && e.status === 404)) throw e;
    }
  }
  const created = await stripe('POST', '/v1/customers', {
    name: dealership.name,
    email: email || undefined,
    metadata: { dealership_id: dealership.id, website_origin: dealership.website_origin },
  }, `lotsync-customer-${dealership.id}-${have || 'first'}`);
  const id = typeof created.id === 'string' ? created.id : '';
  if (!id) throw new StripeError(502, 'Stripe did not return a customer id');
  await writeRow(service, dealership.id, { stripe_customer_id: id, updated_at: new Date().toISOString() });
  return id;
}

// ---------- who and which dealership ----------


// The membership the request is about: by dealership id, by the dealer
// website's origin, else the first one (a person in one dealership needs
// to say nothing).
function pickMembership(memberships: Membership[], wanted: { dealershipId: string; origin: string }): Membership | null {
  if (wanted.dealershipId) return memberships.find((m) => m.dealership_id === wanted.dealershipId) || null;
  if (wanted.origin) return memberships.find((m) => m.dealership !== null && sameOrigin(m.dealership.website_origin, wanted.origin)) || null;
  return memberships[0] || null;
}

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

type Picked = { ok: true; membership: Membership; dealership: Dealership; service: SupabaseClient } | { ok: false; status: number; error: string };

async function pick(client: SupabaseClient, userId: string, wanted: { dealershipId: string; origin: string }, needManager: boolean): Promise<Picked> {
  const memberships = await membershipsOf(client, userId);
  if (!memberships.length) return { ok: false, status: 403, error: 'your account is not in a dealership yet: redeem an invite code first' };
  const membership = pickMembership(memberships, wanted);
  if (!membership || !membership.dealership) return { ok: false, status: 403, error: 'your account is not a member of that dealership' };
  if (needManager && membership.role !== 'manager') return { ok: false, status: 403, error: 'only a manager of the dealership can do this' };
  return { ok: true, membership, dealership: membership.dealership, service: serviceClient() };
}

// ---------- the seat count ----------

// How many of the dealership's members take a seat now (seatCount in
// ../_shared/billing.mjs), read with the caller's own client, so row-level
// security decides what it sees: a manager reads every membership of their
// dealership (0002_rls.sql, "managers read their dealership's memberships"),
// while a salesperson reads only their own row and would count themselves
// alone, so a salesperson's call is not counted and gets null. A failed
// read is null too: the rest of the status does not depend on it.
async function salespeopleOf(client: SupabaseClient, dealershipId: string, role: string): Promise<number | null> {
  if (role !== 'manager') return null;
  const { data, error } = await client.from('memberships').select('user_id, dealership_id, role').eq('dealership_id', dealershipId);
  if (error) {
    console.error('could not count the seats: ' + error.message);
    return null;
  }
  return seatCount(Array.isArray(data) ? data : [], dealershipId);
}

// ---------- the webhook ----------

// Which dealership a Stripe object belongs to: the row that already carries
// its customer or subscription id, else the dealership id Checkout put in
// the subscription's metadata, else the customer's metadata, fetched. Null
// when Stripe is talking about something that is not a Lot Sync dealership.
async function dealershipFor(service: SupabaseClient, obj: Row): Promise<{ id: string; row: Row | null } | null> {
  const customer = typeof obj.customer === 'string' ? obj.customer : isRecord(obj.customer) && typeof obj.customer.id === 'string' ? obj.customer.id : '';
  const byCustomer = await findRow(service, 'stripe_customer_id', customer);
  if (byCustomer) return { id: String(byCustomer.dealership_id), row: byCustomer };
  const subscriptionId = obj.object === 'subscription' && typeof obj.id === 'string' ? obj.id : '';
  const bySubscription = await findRow(service, 'stripe_subscription_id', subscriptionId);
  if (bySubscription) return { id: String(bySubscription.dealership_id), row: bySubscription };

  let dealershipId = isRecord(obj.metadata) ? str(obj.metadata.dealership_id) : '';
  if (!dealershipId && customer) {
    try {
      const c = await stripe('GET', `/v1/customers/${encodeURIComponent(customer)}`);
      dealershipId = isRecord(c.metadata) ? str(c.metadata.dealership_id) : '';
    } catch (e) {
      console.error('could not read the Stripe customer: ' + errorMessage(e));
    }
  }
  if (!/^[0-9a-f-]{36}$/i.test(dealershipId)) return null;
  const { data, error } = await service.from('dealerships').select('id').eq('id', dealershipId).maybeSingle();
  if (error) throw new Error('could not read dealerships: ' + error.message);
  if (!isRecord(data)) return null;
  return { id: dealershipId, row: await readRow(service, dealershipId) };
}

async function webhook(req: Request): Promise<Response> {
  if (!config.webhookSecret) return json(req, 500, { ok: false, error: 'STRIPE_WEBHOOK_SECRET is not set on the function' });
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > config.webhookLimit) return json(req, 413, { ok: false, error: 'request too large' });
  let raw = '';
  try {
    raw = await req.text();
  } catch {
    return json(req, 400, { ok: false, error: 'could not read the request' });
  }
  if (raw.length > config.webhookLimit) return json(req, 413, { ok: false, error: 'request too large' });

  const check = await verifyStripeSignature(req.headers.get('stripe-signature'), raw, config.webhookSecret, Date.now() / 1000);
  if (!check.ok) return json(req, 400, { ok: false, error: check.reason });

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(req, 400, { ok: false, error: 'the event is not JSON' });
  }
  if (!isRecord(event) || typeof event.id !== 'string' || typeof event.type !== 'string') return json(req, 400, { ok: false, error: 'the event has no id or type' });
  const eventId = event.id;
  const type = event.type;

  let service: SupabaseClient;
  try {
    service = serviceClient();
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }

  try {
    // seen before: acknowledged, not applied again
    const { data: seen, error: seenError } = await service.from('billing_events').select('id').eq('stripe_event_id', eventId).maybeSingle();
    if (seenError) throw new Error('could not read billing_events: ' + seenError.message);
    if (isRecord(seen)) return json(req, 200, { ok: true, duplicate: true });

    let applied = false;
    let attached = true;
    if (HANDLED_EVENTS.includes(type)) {
      const obj = isRecord(event.data) && isRecord(event.data.object) ? event.data.object : {};
      const target = await dealershipFor(service, obj);
      if (!target) {
        attached = false;
        console.log(`${new Date().toISOString()} ${type} ${eventId}: no Lot Sync dealership for this customer; recorded, not applied`);
      } else {
        const patch = applyStripeEvent(target.row, event, { included: PRICING.includedSalespeople, priceRooftop: config.priceRooftop, priceSeat: config.priceSeat });
        if (patch) {
          await writeRow(service, target.id, patch);
          applied = true;
        }
        console.log(`${new Date().toISOString()} ${type} ${eventId}: dealership ${target.id} ${applied ? '-> ' + String(patch && patch.status ? patch.status : 'period updated') : 'unchanged (stale or nothing to change)'}`);
      }
    }

    // recorded once it has been handled, so a failure above leaves it for Stripe to redeliver
    const { error: insertError } = await service.from('billing_events').upsert({ stripe_event_id: eventId, type, payload: event }, { onConflict: 'stripe_event_id', ignoreDuplicates: true });
    if (insertError) throw new Error('could not record the event: ' + insertError.message);
    return json(req, 200, { ok: true, applied, attached });
  } catch (e) {
    console.error(e);
    // 500 makes Stripe retry with backoff for up to three days
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
}

// ---------- the handler ----------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight(req);
  const route = routeOf(req);

  if (route === 'webhook') {
    if (req.method !== 'POST') return json(req, 404, { ok: false, error: 'not found' });
    return webhook(req);
  }
  const isStatus = req.method === 'GET' && route === 'status';
  if (!isStatus && (req.method !== 'POST' || !['checkout', 'portal'].includes(route))) return json(req, 404, { ok: false, error: 'not found' });

  const auth = await requireUser(req);
  if (!auth.ok) return json(req, auth.status, { ok: false, error: auth.error });
  const { caller } = auth;

  let body: Row = {};
  if (!isStatus) {
    const read = await readJson(req, config.bodyLimit);
    if (!read.ok) return json(req, 400, { ok: false, error: read.error });
    body = isRecord(read.body) ? read.body : {};
  } else {
    const q = new URL(req.url).searchParams;
    body = { dealershipId: q.get('dealershipId') || '', origin: q.get('origin') || '' };
  }
  const wanted = { dealershipId: str(body.dealershipId), origin: str(body.origin) };

  let picked: Picked;
  try {
    picked = await pick(caller.client, caller.user.id, wanted, !isStatus);
  } catch (e) {
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
  if (!picked.ok) return json(req, picked.status, { ok: false, error: picked.error });
  const { membership, dealership, service } = picked;

  try {
    const row = await readRow(service, dealership.id);

    if (isStatus) {
      const salespeople = await salespeopleOf(caller.client, dealership.id, membership.role);
      return json(req, 200, {
        ok: true,
        dealership: { id: dealership.id, name: dealership.name, websiteOrigin: dealership.website_origin },
        role: membership.role,
        ...statusAnswer(row, { role: membership.role, salespeople }),
      });
    }

    if (!allow(caller.user.id)) return json(req, 429, { ok: false, error: 'too many requests; slow down' });
    const returnUrl = allowedReturnUrl(body.returnUrl, config.allowedReturnOrigins);
    if (!returnUrl) return json(req, 400, { ok: false, error: 'returnUrl must be a page on one of the origins in ALLOWED_RETURN_ORIGINS' });

    if (route === 'portal') {
      const customer = row && typeof row.stripe_customer_id === 'string' ? row.stripe_customer_id : '';
      if (!customer) return json(req, 404, { ok: false, error: 'this dealership has no billing account yet: subscribe first' });
      const session = await stripe('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl }, crypto.randomUUID());
      return json(req, 200, { ok: true, url: String(session.url || '') });
    }

    // checkout: never a second subscription next to one Stripe still holds
    // open (a lapsed card is updated in the portal, and Stripe retries)
    const refusal = checkoutRefusal(row);
    if (refusal) return json(req, refusal.status, { ok: false, error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) });
    const state = subscriptionState(row);
    // the manager page sends a seat for every salesperson it showed the
    // manager (manager/data.js billingBody); a request without seats gets
    // the included count, never the row's old one: a subscription still open
    // was refused above, so the row's count belongs to one that has ended
    const seats = normalizeSeats(body.seats, PRICING.includedSalespeople);
    const lineItems = checkoutLineItems({ seats, included: PRICING.includedSalespeople, priceRooftop: config.priceRooftop, priceSeat: config.priceSeat });
    const customerId = await ensureCustomer(service, dealership, row, caller.user.email);
    const trialEnd = state === 'pilot' && row ? trialEndFor(row.pilot_ends_at) : null;
    const params = checkoutSessionParams({ customerId, dealershipId: dealership.id, lineItems, returnUrl, trialEnd });
    const session = await stripe('POST', '/v1/checkout/sessions', params, crypto.randomUUID());
    console.log(`${new Date().toISOString()} checkout ${dealership.id} seats ${seats}${trialEnd ? ' trial to ' + new Date(trialEnd * 1000).toISOString() : ''}`);
    return json(req, 200, { ok: true, url: String(session.url || '') });
  } catch (e) {
    if (e instanceof StripeError) return json(req, e.status, { ok: false, error: e.message });
    if (e instanceof Error && /STRIPE_PRICE_/.test(e.message)) return json(req, 500, { ok: false, error: e.message });
    console.error(e);
    return json(req, 500, { ok: false, error: errorMessage(e) });
  }
});
