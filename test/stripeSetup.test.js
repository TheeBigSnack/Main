// scripts/stripe-setup-lib.mjs against a small in-memory Stripe: what a read
// reports, what --apply creates, that a second run creates nothing, that a
// live key and a changed price are refused, that the key never leaves as
// anything but the bearer, and that the numbers come from pricing.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  keyMode, webhookUrlFor, wantedObjects, runSetup, secretsCommands, priceMismatch, portalMismatch, webhookMismatch,
  LOOKUP_KEYS, FOUNDING_COUPON_ID, TAG,
} from '../scripts/stripe-setup-lib.mjs';
import { parseArgs } from '../scripts/stripe-setup.mjs';
import { HANDLED_EVENTS } from '../supabase/functions/_shared/billing.mjs';

const pricing = JSON.parse(readFileSync(new URL('../marketing/pricing.json', import.meta.url), 'utf8'));
const KEY = 'sk_test_abc123';
const REF = 'abcdefghijklmnopqrst';
const HOOK = `https://${REF}.supabase.co/functions/v1/billing/webhook`;

// Parses Stripe's bracketed form back into an object (a[b][0]=x -> { a: { b: { 0: 'x' } } }).
function unform(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const parts = k.split(/\[|\]\[|\]/).filter(Boolean);
    let o = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) o[p] = v;
      else o = o[p] ??= {};
    });
  }
  return out;
}
const arr = (o) => (Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : []);
const bool = (v) => v === true || v === 'true';

function fakeStripe() {
  const db = { products: [], prices: [], coupons: [], portals: [], hooks: [] };
  const calls = [];
  let n = 0;
  const id = (p) => `${p}_${++n}`;
  const send = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const missing = (what) => send(404, { error: { message: `No such ${what}` } });
  async function fetchImpl(url, init) {
    const u = new URL(url);
    const q = unform(u.search.slice(1));
    const f = init.body ? unform(init.body) : {};
    calls.push({ method: init.method, path: u.pathname, query: q, form: f, headers: init.headers, url });
    if (init.headers.Authorization !== `Bearer ${KEY}` && !/live/.test(init.headers.Authorization)) return send(401, { error: { message: 'Invalid API Key' } });
    const p = u.pathname;
    const M = init.method;
    if (M === 'GET' && p === '/v1/products') return send(200, { data: db.products.filter((x) => x.active) });
    if (M === 'POST' && p === '/v1/products') {
      const x = { id: id('prod'), object: 'product', active: true, ...f };
      db.products.push(x);
      return send(200, x);
    }
    if (M === 'GET' && p === '/v1/prices') {
      const keys = arr(q.lookup_keys);
      return send(200, { data: db.prices.filter((x) => x.active && keys.includes(x.lookup_key)) });
    }
    if (M === 'POST' && p === '/v1/prices') {
      const holder = db.prices.find((o) => o.lookup_key === f.lookup_key);
      if (holder && f.transfer_lookup_key !== 'true') return send(400, { error: { message: 'lookup key in use' } });
      if (holder) holder.lookup_key = null;
      const x = { id: id('price'), object: 'price', active: true, tax_behavior: f.tax_behavior || 'unspecified', product: f.product, currency: f.currency, unit_amount: Number(f.unit_amount), lookup_key: f.lookup_key, nickname: f.nickname, recurring: { interval: f.recurring.interval, interval_count: 1, usage_type: 'licensed' }, metadata: f.metadata };
      db.prices.push(x);
      return send(200, x);
    }
    const priceId = /^\/v1\/prices\/(.+)$/.exec(p);
    if (M === 'POST' && priceId) {
      const x = db.prices.find((o) => o.id === priceId[1]);
      if (f.tax_behavior && x.tax_behavior !== 'unspecified') return send(400, { error: { message: 'tax_behavior cannot be changed' } });
      if (f.tax_behavior) x.tax_behavior = f.tax_behavior;
      return send(200, x);
    }
    const coupon = /^\/v1\/coupons\/(.+)$/.exec(p);
    if (M === 'GET' && coupon) return db.coupons.find((x) => x.id === coupon[1]) ? send(200, db.coupons.find((x) => x.id === coupon[1])) : missing('coupon');
    if (M === 'POST' && p === '/v1/coupons') {
      const x = { object: 'coupon', valid: true, ...f, amount_off: Number(f.amount_off), duration_in_months: Number(f.duration_in_months), max_redemptions: Number(f.max_redemptions) };
      db.coupons.push(x);
      return send(200, x);
    }
    const toFeatures = (features) => Object.fromEntries(Object.entries(features).map(([k, v]) => [k, { ...v, enabled: bool(v.enabled), ...(v.allowed_updates ? { allowed_updates: arr(v.allowed_updates) } : {}) }]));
    if (M === 'GET' && p === '/v1/billing_portal/configurations') return send(200, { data: db.portals.filter((x) => x.active) });
    if (M === 'POST' && p === '/v1/billing_portal/configurations') {
      const x = { id: id('bpc'), object: 'billing_portal.configuration', active: true, features: toFeatures(f.features), business_profile: f.business_profile || {}, metadata: f.metadata };
      db.portals.push(x);
      return send(200, x);
    }
    const portal = /^\/v1\/billing_portal\/configurations\/(.+)$/.exec(p);
    if (M === 'POST' && portal) {
      const x = db.portals.find((o) => o.id === portal[1]);
      x.features = { ...x.features, ...toFeatures(f.features) };
      if (f.business_profile) x.business_profile = { ...x.business_profile, ...f.business_profile };
      return send(200, x);
    }
    if (M === 'GET' && p === '/v1/webhook_endpoints') return send(200, { data: db.hooks });
    if (M === 'POST' && p === '/v1/webhook_endpoints') {
      const x = { id: id('we'), object: 'webhook_endpoint', url: f.url, enabled_events: arr(f.enabled_events), status: 'enabled', secret: 'whsec_madeup' };
      db.hooks.push(x);
      return send(200, x);
    }
    const hook = /^\/v1\/webhook_endpoints\/(.+)$/.exec(p);
    if (M === 'POST' && hook) {
      const x = db.hooks.find((o) => o.id === hook[1]);
      x.enabled_events = arr(f.enabled_events);
      x.status = 'enabled';
      return send(200, { ...x, secret: undefined });
    }
    return send(404, { error: { message: `Unrecognized request URL (${M}: ${p})` } });
  }
  return { db, calls, fetchImpl, writes: () => calls.filter((c) => c.method === 'POST') };
}

const run = (stripe, over = {}) => runSetup({ key: KEY, pricing, fetchImpl: stripe.fetchImpl, siteUrl: 'https://lotcurrent.example', webhookUrl: REF, ...over });
const line = (r, check) => r.lines.find((l) => l.check.startsWith(check));

test('stripe setup: key modes, webhook addresses and options', () => {
  assert.equal(keyMode('sk_test_abc'), 'test');
  assert.equal(keyMode('rk_live_abc'), 'live');
  for (const bad of ['', 'pk_test_abc', 'whsec_abc', 'sk_test_', ' sk_test_a b']) assert.equal(keyMode(bad), null, bad);
  assert.equal(webhookUrlFor(REF), HOOK);
  assert.equal(webhookUrlFor(HOOK), HOOK);
  for (const bad of ['', 'http://x.supabase.co/functions/v1/billing/webhook', 'https://x.supabase.co/functions/v1/billing', 'https://u:p@x.co/billing/webhook', 'https://x.co/billing/webhook?a=1', 'ABC']) assert.equal(webhookUrlFor(bad), null, bad);
  assert.deepEqual(parseArgs(['--webhook-urlX', 'y'])['unknown'], ['--webhook-urlX', 'y']);
  assert.deepEqual(parseArgs(['--apply', '--webhook-url', REF, '--site-url=https://a.example', '--nope']), { apply: true, live: false, reprice: false, webhookUrl: REF, siteUrl: 'https://a.example', productName: 'Lot Current', unknown: ['--nope'] });
});

test('stripe setup: the wanted objects carry the numbers in marketing/pricing.json and the events the webhook handles', () => {
  const w = wantedObjects(pricing, { siteUrl: 'https://lotcurrent.example/' });
  assert.deepEqual(w.prices.map((p) => [p.lookup_key, p.unit_amount, p.currency]), [[LOOKUP_KEYS.rooftop, pricing.perRooftopMonthly * 100, 'usd'], [LOOKUP_KEYS.seat, pricing.extraSalespersonMonthly * 100, 'usd']]);
  assert.match(w.prices[0].nickname, new RegExp(`includes ${pricing.includedSalespeople} salespeople`));
  assert.deepEqual([w.coupon.amount_off, w.coupon.duration_in_months, w.coupon.max_redemptions], [(pricing.perRooftopMonthly - pricing.foundingDealerMonthly) * 100, pricing.foundingDealerMonths, pricing.foundingDealerCount]);
  assert.deepEqual(w.webhookEvents, [...HANDLED_EVENTS]);
  assert.equal(w.portal.features.subscription_update.enabled, false, 'seats are never changed in the portal');
  assert.deepEqual(w.portal.business_profile, { headline: 'Lot Current', terms_of_service_url: 'https://lotcurrent.example/legal/terms/', privacy_policy_url: 'https://lotcurrent.example/legal/privacy/' });
  assert.deepEqual(wantedObjects(pricing).portal.business_profile, { headline: 'Lot Current' }, 'no site address, no legal links');
  assert.throws(() => wantedObjects({ ...pricing, foundingDealerMonthly: pricing.perRooftopMonthly }), /founding-dealer rate/);
  assert.throws(() => wantedObjects({ ...pricing, currency: '' }), /currency/);
  assert.equal(JSON.stringify(w).includes('Waynesburg'), false);
});

test('stripe setup: a live key is refused without --live, and a missing key is a failure; neither calls Stripe', async () => {
  const s = fakeStripe();
  const live = await runSetup({ key: 'sk_live_abc', pricing, fetchImpl: s.fetchImpl, apply: true });
  assert.equal(live.ok, false);
  assert.match(live.lines[0].detail, /live key: nothing was read or changed/);
  const none = await runSetup({ key: '', pricing, fetchImpl: s.fetchImpl });
  assert.equal(none.ok, false);
  assert.equal(s.calls.length, 0);
  const allowed = await runSetup({ key: 'sk_live_abc', live: true, pricing, fetchImpl: s.fetchImpl });
  assert.equal(allowed.mode, 'live');
  assert.ok(s.calls.length > 0);
});

test('stripe setup: a read on an empty account writes nothing and fails each missing object, naming --apply', async () => {
  const s = fakeStripe();
  const r = await run(s);
  assert.equal(r.ok, false);
  assert.equal(s.writes().length, 0);
  for (const check of ['product', 'price: Rooftop', 'price: Extra', 'founding-dealer coupon', 'billing portal', 'webhook']) {
    assert.equal(line(r, check).ok, false, check);
    assert.match(line(r, check).detail, /--apply/, check);
  }
  assert.deepEqual(secretsCommands(r), []);
});

test('stripe setup: --apply creates everything once, prints the ids and the signing secret, and a second run only reads', async () => {
  const s = fakeStripe();
  const first = await run(s, { apply: true });
  assert.equal(first.ok, true, JSON.stringify(first.lines, null, 1));
  assert.equal(s.db.products.length, 1);
  assert.equal(s.db.products[0].metadata[TAG], 'plan');
  assert.equal(s.db.products[0].tax_code, 'txcd_10103001');
  assert.deepEqual(s.db.prices.map((p) => p.tax_behavior), ['exclusive', 'exclusive'], 'tax, once on, is added on top');
  const prod = s.db.products[0].id;
  assert.deepEqual(s.db.prices.map((p) => [p.lookup_key, p.unit_amount, p.recurring.interval, p.product]), [
    [LOOKUP_KEYS.rooftop, pricing.perRooftopMonthly * 100, 'month', prod],
    [LOOKUP_KEYS.seat, pricing.extraSalespersonMonthly * 100, 'month', prod],
  ]);
  assert.equal(s.db.coupons[0].id, FOUNDING_COUPON_ID);
  assert.equal(s.db.coupons[0].applies_to.products[0], s.db.products[0].id);
  assert.equal(s.db.portals[0].features.subscription_update.enabled, false);
  assert.deepEqual(s.db.hooks.map((h) => [h.url, h.enabled_events]), [[HOOK, [...HANDLED_EVENTS]]]);
  assert.deepEqual(first.secrets, { STRIPE_PRICE_ROOFTOP: s.db.prices[0].id, STRIPE_PRICE_SEAT: s.db.prices[1].id, STRIPE_PORTAL_CONFIGURATION: s.db.portals[0].id });
  assert.equal(first.webhookSecret, 'whsec_madeup');
  const cmds = secretsCommands(first);
  assert.deepEqual(cmds, [
    `supabase secrets set STRIPE_PRICE_ROOFTOP=${s.db.prices[0].id} STRIPE_PRICE_SEAT=${s.db.prices[1].id} STRIPE_PORTAL_CONFIGURATION=${s.db.portals[0].id}`,
    'supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_madeup',
  ]);
  assert.equal(cmds.join(' ').includes(KEY), false, 'the secret key is never echoed');
  for (const c of s.calls) {
    assert.equal(c.url.includes(KEY), false, 'the key is never in an address');
    assert.equal(JSON.stringify(c.form).includes(KEY), false, 'the key is never in a body');
    assert.ok(c.url.startsWith('https://api.stripe.com/'), c.url);
  }

  const writes = s.writes().length;
  const second = await run(s, { apply: true });
  assert.equal(second.ok, true);
  assert.equal(s.writes().length, writes, 'nothing new on a second run');
  assert.equal(second.webhookSecret, '', 'an existing endpoint\'s secret is never shown again');
  assert.deepEqual(second.secrets, first.secrets);
  const read = await run(s);
  assert.equal(read.ok, true);
  assert.ok(read.lines.every((l) => l.ok));
});

test('stripe setup: a price that differs from pricing.json fails and is left alone; --apply --reprice moves the lookup key to a new price', async () => {
  const s = fakeStripe();
  await run(s, { apply: true });
  const old = s.db.prices[0];
  old.unit_amount = 19900;
  const r = await run(s, { apply: true });
  assert.equal(r.ok, false);
  assert.match(line(r, 'price: Rooftop').detail, new RegExp(`amount 19900 cents, pricing.json says ${pricing.perRooftopMonthly * 100}.*--reprice`));
  assert.equal(r.secrets.STRIPE_PRICE_ROOFTOP, undefined, 'no id is offered for a wrong price');
  assert.equal(s.db.prices.length, 2);
  const re = await run(s, { apply: true, reprice: true });
  assert.equal(re.ok, true);
  assert.equal(s.db.prices.length, 3);
  assert.equal(old.lookup_key, null);
  assert.equal(re.secrets.STRIPE_PRICE_ROOFTOP, s.db.prices[2].id);
  assert.ok(s.calls.some((c) => c.path === '/v1/prices' && c.form.transfer_lookup_key === 'true'));
});

test('stripe setup: a portal or webhook changed in the Dashboard is reported on a read and set back by --apply', async () => {
  const s = fakeStripe();
  await run(s, { apply: true });
  s.db.portals[0].features.subscription_update.enabled = true;
  s.db.hooks[0].enabled_events = ['invoice.paid', 'charge.refunded'];
  const r = await run(s);
  assert.equal(r.ok, false);
  assert.match(line(r, 'billing portal').detail, /subscription_update on/);
  assert.match(line(r, 'webhook').detail, /missing customer\.subscription\.created.*also sends charge\.refunded/);
  const fixed = await run(s, { apply: true });
  assert.equal(fixed.ok, true, JSON.stringify(fixed.lines, null, 1));
  assert.equal(s.db.portals[0].features.subscription_update.enabled, false);
  assert.deepEqual(s.db.hooks[0].enabled_events, [...HANDLED_EVENTS]);
  assert.equal(fixed.webhookSecret, '');
});

test('stripe setup: no webhook address and no site address are notes, not failures; a bad webhook address fails', async () => {
  const s = fakeStripe();
  const r = await run(s, { apply: true, webhookUrl: '', siteUrl: '' });
  assert.equal(r.ok, true);
  assert.equal(line(r, 'webhook').note, true);
  assert.equal(line(r, 'billing portal: legal links').note, true);
  const bad = await run(s, { webhookUrl: 'https://example.com/hook' });
  assert.equal(line(bad, 'webhook').ok, false);
  assert.equal(line(bad, 'webhook').note, undefined);
});

test('stripe setup: a rejected key or an unreachable Stripe ends in one FAIL line, never a crash', async () => {
  const s = fakeStripe();
  const rejected = await runSetup({ key: 'sk_test_other', pricing, fetchImpl: s.fetchImpl });
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.lines.at(-1), { check: 'Stripe', ok: false, detail: 'Stripe rejected the key' });
  const offline = await runSetup({ key: KEY, pricing, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.match(offline.lines.at(-1).detail, /could not reach Stripe/);
});

test('stripe setup: the comparisons name what differs', () => {
  const want = wantedObjects(pricing).prices[0];
  assert.equal(priceMismatch({ unit_amount: want.unit_amount, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, product: 'prod_1' }, want, 'prod_1'), '');
  assert.match(priceMismatch({ unit_amount: want.unit_amount, currency: 'usd', recurring: { interval: 'year' }, product: 'prod_1' }, want, 'prod_1'), /not monthly/);
  assert.match(priceMismatch({ unit_amount: want.unit_amount, currency: 'usd', recurring: { interval: 'month', usage_type: 'metered' }, product: 'prod_2' }, want, 'prod_1'), /metered.*on product prod_2/);
  const w = wantedObjects(pricing);
  assert.deepEqual(portalMismatch({ features: {} }, w.portal).length, 4);
  assert.equal(webhookMismatch({ enabled_events: [...HANDLED_EVENTS], status: 'disabled' }, w.webhookEvents), 'status disabled');
});

test('stripe setup: a price made by hand with no tax behavior fails a read and gets exclusive from --apply; an inclusive one fails and is left alone', async () => {
  const s = fakeStripe();
  await run(s, { apply: true });
  s.db.prices[0].tax_behavior = 'unspecified';
  const r = await run(s);
  assert.match(line(r, 'price: Rooftop').detail, /no tax behavior.*--apply/);
  const fixed = await run(s, { apply: true });
  assert.equal(fixed.ok, true);
  assert.equal(s.db.prices[0].tax_behavior, 'exclusive');
  s.db.prices[1].tax_behavior = 'inclusive';
  const bad = await run(s, { apply: true });
  assert.match(line(bad, 'price: Extra').detail, /tax inclusive, not exclusive/);
  assert.equal(s.db.prices[1].tax_behavior, 'inclusive');
});

test('stripe setup: a new --site-url is applied to the portal and the next read passes', async () => {
  const s = fakeStripe();
  await run(s, { apply: true, siteUrl: '' });
  const r = await run(s, { siteUrl: 'https://lotcurrent.example' });
  assert.match(line(r, 'billing portal').detail, /legal links differ/);
  assert.equal((await run(s, { apply: true, siteUrl: 'https://lotcurrent.example' })).ok, true);
  assert.equal(s.db.portals[0].business_profile.terms_of_service_url, 'https://lotcurrent.example/legal/terms/');
  assert.equal((await run(s, { siteUrl: 'https://lotcurrent.example' })).ok, true);
});
