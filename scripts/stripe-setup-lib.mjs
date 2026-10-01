// The Stripe objects billing needs, checked or created from
// marketing/pricing.json: what scripts/stripe-setup.mjs runs, kept apart so
// test/stripeSetup.test.js runs it against a fake Stripe with no network.
//
// What it looks after, each found again on every run by a fixed name, so a
// second run creates nothing new:
//
//   product   the subscription product, found by metadata lotcurrent=plan
//   prices    the rooftop and extra-salesperson monthly prices, found by
//             their lookup keys; the amounts must equal pricing.json
//   coupon    the founding-dealer discount (id FOUNDING_COUPON_ID): the
//             rooftop price less foundingDealerMonthly, for
//             foundingDealerMonths months, at most foundingDealerCount
//             dealerships. Not a third price: Checkout takes promotion codes,
//             and the owner makes a code on this coupon when handing it out
//   portal    a Billing Portal configuration (metadata lotcurrent=portal):
//             update the card, see invoices, cancel at the period end, edit
//             the billing email and address; never change the subscription,
//             so seats are changed only by a person (supabase/README.md)
//   webhook   the endpoint at the billing function's /webhook, subscribed to
//             exactly HANDLED_EVENTS
//
// Without apply it only reads, and a missing or different object is a FAIL
// line saying what --apply would do. With apply it creates what is missing
// and fixes what it safely can (the portal's features, the webhook's events).
// A price whose amount differs from pricing.json is never changed quietly:
// that is a price change for every new subscriber, so it fails unless
// reprice is also given, and then a new price takes over the lookup key
// (existing subscriptions keep the price they were sold).
//
// A live key (sk_live_, rk_live_) is refused unless live is given. The key
// goes out only as the bearer on calls to api.stripe.com and is never
// printed. The webhook's signing secret is printed once, when the endpoint
// is created, because Stripe shows it only then.

import { HANDLED_EVENTS, formEncode, keyMode } from '../supabase/functions/_shared/billing.mjs';

export const STRIPE_API = 'https://api.stripe.com';
export const TAG = 'lotcurrent';
export const FOUNDING_COUPON_ID = 'lotcurrent-founding';
// Stripe's tax code for software as a service sold to businesses; it only
// matters once automatic tax is turned on (STRIPE_AUTOMATIC_TAX).
export const SAAS_TAX_CODE = 'txcd_10103001';
export const LOOKUP_KEYS = Object.freeze({ rooftop: 'lotcurrent_rooftop_monthly', seat: 'lotcurrent_seat_monthly' });
// Sales tax, when STRIPE_AUTOMATIC_TAX turns it on, is added on top of the
// listed price, as US software is usually sold, so the price on the website
// stays the price before tax. Stripe refuses automatic tax on a price with no
// tax behavior, and lets an unspecified one be set once and never changed.
export const TAX_BEHAVIOR = 'exclusive';

const isRecord = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const cents = (dollars) => Math.round(Number(dollars) * 100);

// 'test', 'live', or null for something that is not a Stripe secret or
// restricted key: the billing function's own reading of a key.
export { keyMode };

// The webhook address: an https URL whose path ends in /billing/webhook (the
// function's route), or a bare Supabase project ref, which becomes
// https://<ref>.supabase.co/functions/v1/billing/webhook. null otherwise.
export function webhookUrlFor(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z0-9]{20}$/.test(s)) return `https://${s}.supabase.co/functions/v1/billing/webhook`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (!/\/billing\/webhook$/.test(u.pathname)) return null;
  return u.toString();
}

// What should exist, from pricing.json. siteUrl (https origin, may be '')
// gives the portal the Terms and Privacy addresses the website serves.
export function wantedObjects(pricing, { productName = 'Lot Current', siteUrl = '' } = {}) {
  if (!isRecord(pricing)) throw new Error('pricing.json did not parse to an object');
  const currency = String(pricing.currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('pricing.json has no three-letter currency');
  for (const k of ['perRooftopMonthly', 'extraSalespersonMonthly', 'foundingDealerMonthly', 'foundingDealerMonths', 'foundingDealerCount']) {
    if (!(typeof pricing[k] === 'number' && pricing[k] > 0)) throw new Error(`pricing.json has no positive ${k}`);
  }
  if (pricing.foundingDealerMonthly >= pricing.perRooftopMonthly) throw new Error('pricing.json: the founding-dealer rate is not below the rooftop price');
  const site = String(siteUrl || '').replace(/\/+$/, '');
  const legal = /^https:\/\/[^/]+$/.test(site) ? { terms_of_service_url: `${site}/legal/terms/`, privacy_policy_url: `${site}/legal/privacy/` } : null;
  return {
    product: { name: productName, tax_code: SAAS_TAX_CODE, metadata: { [TAG]: 'plan' } },
    prices: [
      { key: 'rooftop', lookup_key: LOOKUP_KEYS.rooftop, nickname: `Rooftop, monthly (includes ${pricing.includedSalespeople} salespeople)`, unit_amount: cents(pricing.perRooftopMonthly), currency, secret: 'STRIPE_PRICE_ROOFTOP' },
      { key: 'seat', lookup_key: LOOKUP_KEYS.seat, nickname: 'Extra salesperson, monthly', unit_amount: cents(pricing.extraSalespersonMonthly), currency, secret: 'STRIPE_PRICE_SEAT' },
    ],
    coupon: {
      id: FOUNDING_COUPON_ID,
      name: 'Founding dealer',
      amount_off: cents(pricing.perRooftopMonthly - pricing.foundingDealerMonthly),
      currency,
      duration: 'repeating',
      duration_in_months: pricing.foundingDealerMonths,
      max_redemptions: pricing.foundingDealerCount,
    },
    portal: {
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: { enabled: false },
        customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      },
      business_profile: { headline: productName, ...(legal || {}) },
      metadata: { [TAG]: 'portal' },
    },
    webhookEvents: [...HANDLED_EVENTS],
  };
}

// ---------- Stripe, by fetch ----------

export class StripeCallError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function stripeClient(key, fetchImpl = globalThis.fetch) {
  return async function call(method, path, params) {
    const headers = { Authorization: `Bearer ${key}` };
    let url = STRIPE_API + path;
    let body;
    if (method === 'GET') {
      if (params) url += '?' + formEncode(params);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formEncode(params || {});
    }
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body });
    } catch (e) {
      throw new StripeCallError(0, `could not reach Stripe (${e && e.message ? e.message : e})`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      if (res.status === 401) throw new StripeCallError(401, 'Stripe rejected the key');
      const msg = isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string' ? data.error.message : `Stripe answered ${res.status}`;
      throw new StripeCallError(res.status, msg);
    }
    return isRecord(data) ? data : {};
  };
}

const listOf = (page) => (isRecord(page) && Array.isArray(page.data) ? page.data : []);
const tagged = (obj, value) => isRecord(obj) && isRecord(obj.metadata) && obj.metadata[TAG] === value;

// ---------- the comparisons ----------

// Why an existing price does not match the wanted one ('' when it does).
export function priceMismatch(price, want, productId) {
  const r = isRecord(price.recurring) ? price.recurring : {};
  const wrong = [];
  if (price.unit_amount !== want.unit_amount) wrong.push(`amount ${price.unit_amount} cents, pricing.json says ${want.unit_amount}`);
  if (String(price.currency || '').toLowerCase() !== want.currency) wrong.push(`currency ${price.currency}, pricing.json says ${want.currency}`);
  if (r.interval !== 'month' || (r.interval_count ?? 1) !== 1) wrong.push(`billed every ${r.interval_count ?? 1} ${r.interval || 'once'}, not monthly`);
  if (r.usage_type && r.usage_type !== 'licensed') wrong.push(`usage type ${r.usage_type}, not per seat`);
  const prod = isRecord(price.product) ? price.product.id : price.product;
  if (productId && prod !== productId) wrong.push(`on product ${prod}, not ${productId}`);
  if (price.tax_behavior && price.tax_behavior !== 'unspecified' && price.tax_behavior !== TAX_BEHAVIOR) wrong.push(`tax ${price.tax_behavior}, not ${TAX_BEHAVIOR}`);
  return wrong.join('; ');
}

export function couponMismatch(coupon, want) {
  const wrong = [];
  for (const k of ['amount_off', 'duration', 'duration_in_months', 'max_redemptions']) if (coupon[k] !== want[k]) wrong.push(`${k} ${coupon[k]}, wanted ${want[k]}`);
  if (String(coupon.currency || '').toLowerCase() !== want.currency) wrong.push(`currency ${coupon.currency}, wanted ${want.currency}`);
  if (coupon.valid === false) wrong.push('no longer valid');
  return wrong.join('; ');
}

// The portal features that differ from the wanted ones, as a list of names.
export function portalMismatch(config, want) {
  const have = isRecord(config.features) ? config.features : {};
  const wrong = [];
  for (const [name, w] of Object.entries(want.features)) {
    const h = isRecord(have[name]) ? have[name] : {};
    if (Boolean(h.enabled) !== w.enabled) wrong.push(`${name} ${h.enabled ? 'on' : 'off'}`);
    else if (w.mode && h.mode !== w.mode) wrong.push(`${name} mode ${h.mode}`);
    else if (w.allowed_updates && [...(h.allowed_updates || [])].sort().join() !== [...w.allowed_updates].sort().join()) wrong.push(`${name} allows ${(h.allowed_updates || []).join(', ') || 'nothing'}`);
  }
  if (config.active === false) wrong.push('inactive');
  return wrong;
}

export function webhookMismatch(endpoint, events) {
  const have = Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : [];
  const missing = events.filter((e) => !have.includes(e));
  const extra = have.filter((e) => !events.includes(e));
  const wrong = [];
  if (missing.length) wrong.push(`missing ${missing.join(', ')}`);
  if (extra.length) wrong.push(`also sends ${extra.join(', ')}`);
  if (endpoint.status && endpoint.status !== 'enabled') wrong.push(`status ${endpoint.status}`);
  return wrong.join('; ');
}

// ---------- the run ----------

// { key, apply, live, reprice, webhookUrl, pricing, productName, siteUrl, fetchImpl }
// -> { ok, mode, lines: [{ check, ok, note?, detail }], secrets: { NAME: value }, webhookSecret }
// A line is ok, FAIL (ok false) or a note (ok false, note true; does not fail
// the run). secrets holds the ids the function needs; webhookSecret is set
// only when this run created the endpoint.
export async function runSetup(opts) {
  const { key, apply = false, live = false, reprice = false, pricing, productName, siteUrl = '', fetchImpl } = opts;
  const lines = [];
  const secrets = {};
  let webhookSecret = '';
  const ok = (check, detail = '') => lines.push({ check, ok: true, detail });
  const fail = (check, detail) => lines.push({ check, ok: false, detail });
  const note = (check, detail) => lines.push({ check, ok: false, note: true, detail });
  const done = () => ({ ok: lines.every((l) => l.ok || l.note), mode, lines, secrets, webhookSecret });

  const mode = keyMode(key);
  if (!mode) {
    fail('the Stripe key', 'set STRIPE_SECRET_KEY to a secret key (sk_test_... in test mode); it is read from the environment and never printed');
    return done();
  }
  if (mode === 'live' && !live) {
    fail('the Stripe key', 'this is a live key: nothing was read or changed. Run in test mode first; add --live only when switching billing to live mode');
    return done();
  }
  ok('the Stripe key', `${mode} mode${apply ? ', creating what is missing' : ', reading only'}`);

  let want;
  try {
    want = wantedObjects(pricing, { productName, siteUrl });
  } catch (e) {
    fail('marketing/pricing.json', e.message);
    return done();
  }
  const stripe = stripeClient(key, fetchImpl);
  const wouldOr = (what) => (apply ? what : `missing: run again with --apply to ${what.replace(/^created/, 'create')}`);

  try {
    // the product
    let product = listOf(await stripe('GET', '/v1/products', { active: true, limit: 100 })).find((p) => tagged(p, 'plan')) || null;
    if (product) ok('product', `${product.name} (${product.id})`);
    else if (apply) {
      product = await stripe('POST', '/v1/products', want.product);
      ok('product', `created: ${product.name} (${product.id})`);
    } else fail('product', wouldOr(`create "${want.product.name}"`));

    // the two prices
    const found = listOf(await stripe('GET', '/v1/prices', { lookup_keys: want.prices.map((p) => p.lookup_key), active: true, limit: 10 }));
    for (const w of want.prices) {
      const check = `price: ${w.nickname}`;
      let price = found.find((p) => p.lookup_key === w.lookup_key) || null;
      const wrong = price ? priceMismatch(price, w, product && product.id) : '';
      if (price && !wrong && (!price.tax_behavior || price.tax_behavior === 'unspecified')) {
        if (!apply) {
          fail(check, `${price.id} has no tax behavior, so Checkout would refuse automatic tax; run with --apply to set it to ${TAX_BEHAVIOR} (tax added on top)`);
          continue;
        }
        price = await stripe('POST', `/v1/prices/${price.id}`, { tax_behavior: TAX_BEHAVIOR });
        ok(check, `${w.unit_amount / 100} ${w.currency.toUpperCase()} a month (${price.id}); tax behavior set to ${TAX_BEHAVIOR}`);
        secrets[w.secret] = price.id;
        continue;
      }
      if (price && !wrong) {
        ok(check, `${w.unit_amount / 100} ${w.currency.toUpperCase()} a month (${price.id})`);
        secrets[w.secret] = price.id;
        continue;
      }
      if (price && !(apply && reprice)) {
        fail(check, `${price.id} differs from marketing/pricing.json: ${wrong}. Nothing was changed; run with --apply --reprice to make a new price that takes over the lookup key (existing subscriptions keep theirs), then set ${w.secret} again`);
        continue;
      }
      if (!product) {
        fail(check, wouldOr('create it once the product exists'));
        continue;
      }
      if (!apply) {
        fail(check, wouldOr(`create ${w.unit_amount / 100} ${w.currency.toUpperCase()} a month`));
        continue;
      }
      price = await stripe('POST', '/v1/prices', {
        product: product.id, currency: w.currency, unit_amount: w.unit_amount, recurring: { interval: 'month' },
        lookup_key: w.lookup_key, nickname: w.nickname, tax_behavior: TAX_BEHAVIOR, metadata: { [TAG]: w.key }, ...(price ? { transfer_lookup_key: true } : {}),
      });
      ok(check, `created: ${w.unit_amount / 100} ${w.currency.toUpperCase()} a month (${price.id})`);
      secrets[w.secret] = price.id;
    }

    // the founding-dealer coupon
    let coupon = null;
    try {
      coupon = await stripe('GET', `/v1/coupons/${FOUNDING_COUPON_ID}`);
    } catch (e) {
      if (!(e instanceof StripeCallError && e.status === 404)) throw e;
    }
    const c = want.coupon;
    const couponText = `${c.amount_off / 100} ${c.currency.toUpperCase()} off for ${c.duration_in_months} months, at most ${c.max_redemptions} dealerships`;
    if (coupon) {
      const wrong = couponMismatch(coupon, c);
      // a coupon's amount cannot be edited in Stripe: a different one is a person's call
      if (wrong) fail('founding-dealer coupon', `${FOUNDING_COUPON_ID} differs from marketing/pricing.json: ${wrong}. Delete it in the Dashboard and run --apply again if the new terms are meant`);
      else ok('founding-dealer coupon', `${couponText} (${FOUNDING_COUPON_ID})`);
    } else if (apply) {
      await stripe('POST', '/v1/coupons', { ...c, ...(product ? { applies_to: { products: [product.id] } } : {}), metadata: { [TAG]: 'founding' } });
      ok('founding-dealer coupon', `created: ${couponText} (${FOUNDING_COUPON_ID})`);
    } else {
      fail('founding-dealer coupon', wouldOr(`create ${couponText}`));
    }

    // the Billing Portal configuration
    let portal = listOf(await stripe('GET', '/v1/billing_portal/configurations', { active: true, limit: 100 })).find((p) => tagged(p, 'portal')) || null;
    if (!portal && apply) {
      portal = await stripe('POST', '/v1/billing_portal/configurations', want.portal);
      ok('billing portal', `created (${portal.id})`);
    } else if (portal) {
      const wrong = portalMismatch(portal, want.portal);
      const bp = want.portal.business_profile;
      const have = portal.business_profile || {};
      if (bp.terms_of_service_url && (have.terms_of_service_url !== bp.terms_of_service_url || have.privacy_policy_url !== bp.privacy_policy_url)) wrong.push('legal links differ from --site-url');
      if (wrong.length && apply) {
        portal = await stripe('POST', `/v1/billing_portal/configurations/${portal.id}`, { features: want.portal.features, business_profile: want.portal.business_profile });
        ok('billing portal', `updated (${portal.id}): was ${wrong.join(', ')}`);
      } else if (wrong.length) {
        fail('billing portal', `${portal.id}: ${wrong.join(', ')}; run with --apply to set it back`);
      } else {
        ok('billing portal', `card, invoices, cancel at period end; no plan changes (${portal.id})`);
      }
    } else {
      fail('billing portal', wouldOr('create the portal configuration'));
    }
    if (portal) secrets.STRIPE_PORTAL_CONFIGURATION = portal.id;
    if (!want.portal.business_profile.terms_of_service_url) note('billing portal: legal links', 'no --site-url given, so the portal shows no Terms or Privacy link; add it once the legal pages are final, and run --apply again');

    // the webhook endpoint
    const url = webhookUrlFor(opts.webhookUrl);
    if (!opts.webhookUrl) {
      note('webhook', 'not checked: pass --webhook-url <your project ref> once the billing function is deployed');
    } else if (!url) {
      fail('webhook', `${opts.webhookUrl} is neither a Supabase project ref nor an https address ending in /billing/webhook`);
    } else {
      const endpoint = listOf(await stripe('GET', '/v1/webhook_endpoints', { limit: 100 })).find((e) => e.url === url) || null;
      if (endpoint) {
        const wrong = webhookMismatch(endpoint, want.webhookEvents);
        if (wrong && apply) {
          await stripe('POST', `/v1/webhook_endpoints/${endpoint.id}`, { enabled_events: want.webhookEvents, disabled: false });
          ok('webhook', `updated ${endpoint.id}: was ${wrong}. Its signing secret is unchanged`);
        } else if (wrong) {
          fail('webhook', `${endpoint.id}: ${wrong}; run with --apply to set its events`);
        } else {
          ok('webhook', `${url}, the ${want.webhookEvents.length} events billing handles (${endpoint.id})`);
        }
      } else if (apply) {
        const made = await stripe('POST', '/v1/webhook_endpoints', { url, enabled_events: want.webhookEvents, description: 'Billing function', metadata: { [TAG]: 'webhook' } });
        webhookSecret = typeof made.secret === 'string' ? made.secret : '';
        ok('webhook', `created ${made.id} for ${url}`);
      } else {
        fail('webhook', wouldOr(`create an endpoint at ${url}`));
      }
    }
  } catch (e) {
    fail('Stripe', e instanceof StripeCallError ? e.message : String(e && e.message ? e.message : e));
  }
  return done();
}

// The commands that put the ids into the function's secrets. The secret key
// itself is never echoed: the owner types it.
export function secretsCommands({ secrets, webhookSecret }) {
  const out = [];
  const ids = Object.entries(secrets).map(([k, v]) => `${k}=${v}`);
  if (ids.length) out.push(`supabase secrets set ${ids.join(' ')}`);
  if (webhookSecret) out.push(`supabase secrets set STRIPE_WEBHOOK_SECRET=${webhookSecret}`);
  return out;
}
