// The lead function's real handler (supabase/functions/lead/index.ts) under
// Node, against the fake database (test/functions/): the order of its
// checks (the landing page's origin first, then the per-address brake, then
// the body), which request header the brake counts, the honeypot, the
// hourly cap, and the row it stores. What site/site.js does with each answer
// is in test/lead.test.js; here each answer is held to what the page reads
// (a sentence, and the name of a field its form has).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunction, invoke, fake, hermetic, functionsFetch, keysOf, SUPABASE_URL, SERVICE_KEY } from './functions/harness.mjs';
import { runChecks } from '../scripts/check-deploy.mjs';
import { PER_ADDRESS_PER_HOUR, PER_HOUR_TOTAL, LEAD_LIMITS } from '../supabase/functions/_shared/lead.mjs';

hermetic();

const SITE = 'https://site.example.test';
const STRANGER = 'https://not-the-landing-page.example.test';
const ENV = { LEAD_ORIGINS: `${SITE}, https://www.site.example.test` };
// what site.js sends: every form field, the honeypot empty
const FORM = { name: 'Pat Doe', dealership: 'Example Motors', website: 'www.example-motors.test', email: 'pat@example-motors.test', phone: '', message: '', company_url: '' };
const from = (address) => ({ 'cf-connecting-ip': address });
const lead = (handler, { body = FORM, origin = SITE, headers = from('192.0.2.1'), ...rest } = {}) => invoke(handler, { path: 'lead', origin, body, headers, ...rest });

// The names of the landing page's form fields: a 400's `field` must be one of them (site.js focuses it) or ''.
const FORM_FIELDS = [...readFileSync(new URL('../site/index.html', import.meta.url), 'utf8').matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);

test('lead: the preflight gives the landing page its CORS header and any other page none; a method other than POST gets 405', async () => {
  const handler = await loadFunction('lead', ENV);
  const pre = await invoke(handler, { method: 'OPTIONS', path: 'lead', origin: SITE, headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
  assert.match(pre.headers.get('access-control-allow-methods'), /\bPOST\b/);
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
  const other = await invoke(handler, { method: 'OPTIONS', path: 'lead', origin: STRANGER });
  assert.equal(other.status, 204);
  assert.equal(other.headers.get('access-control-allow-origin'), null, 'no CORS header for another page');
  const get = await invoke(handler, { method: 'GET', path: 'lead', origin: SITE });
  assert.deepEqual([get.status, get.body], [405, { ok: false, error: 'POST only' }]);
  assert.equal(fake.calls.length, 0, 'none of that touched the database');
});

test('lead: another page gets 403 before the brake or the body are looked at; no Origin, or no LEAD_ORIGINS, is refused the same way', async () => {
  const handler = await loadFunction('lead', ENV);
  for (let i = 0; i < PER_ADDRESS_PER_HOUR + 2; i += 1) {
    const r = await lead(handler, { origin: STRANGER, body: { not: 'a form' } });
    assert.deepEqual([r.status, r.body], [403, { ok: false, error: 'demo requests come from the Lot Sync website only' }], `request ${i + 1}`);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await lead(handler, { origin: '' })).status, 403, 'no Origin header');
  // the refused requests did not use the address's allowance
  assert.equal((await lead(handler)).status, 200);
  assert.equal(fake.writes('demo_requests').length, 1);

  const closed = await loadFunction('lead', { LEAD_ORIGINS: undefined });
  assert.equal((await lead(closed)).status, 403, 'with LEAD_ORIGINS unset no page may send');
});

test('lead: one address gets PER_ADDRESS_PER_HOUR requests, answered or refused, and the next is 429 before its body is read', async () => {
  const handler = await loadFunction('lead', ENV);
  for (let i = 0; i < PER_ADDRESS_PER_HOUR; i += 1) {
    const r = await lead(handler, { body: {} });
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'the name is missing', field: 'name' }]);
  }
  const sixth = await lead(handler);
  assert.deepEqual([sixth.status, sixth.body], [429, { ok: false, error: 'too many requests from here; please try again in an hour or email us' }]);
  assert.equal(sixth.headers.get('access-control-allow-origin'), SITE, 'the page can read the sentence');
  assert.equal(fake.writes().length, 0, 'nothing stored');
  assert.equal((await lead(handler, { headers: from('192.0.2.2') })).status, 200, 'another address is not held back');
});

// Six requests, each with the headers `headersFor(i)` gives; the statuses.
async function sixFrom(headersFor) {
  const handler = await loadFunction('lead', ENV);
  const out = [];
  for (let i = 1; i <= PER_ADDRESS_PER_HOUR + 1; i += 1) out.push((await lead(handler, { body: {}, headers: headersFor(i) })).status);
  return out;
}
const braked = [400, 400, 400, 400, 400, 429];
const free = [400, 400, 400, 400, 400, 400];

test('lead: the brake counts cf-connecting-ip, then x-real-ip, then the rightmost X-Forwarded-For entry, never an address the client wrote first', async () => {
  // the platform's edge sets cf-connecting-ip; what the client puts in the other two changes nothing
  assert.deepEqual(await sixFrom((i) => ({ 'cf-connecting-ip': '198.51.100.7', 'x-real-ip': `192.0.2.${i}`, 'x-forwarded-for': `192.0.2.${i}, 192.0.2.${i}` })), braked);
  // without it, x-real-ip decides and X-Forwarded-For is not read
  assert.deepEqual(await sixFrom((i) => ({ 'x-real-ip': '198.51.100.7', 'x-forwarded-for': `192.0.2.${i}` })), braked);
  // only X-Forwarded-For: the entry the nearest proxy appended counts, the client's own leftmost one does not
  assert.deepEqual(await sixFrom((i) => ({ 'x-forwarded-for': `192.0.2.${i}, 198.51.100.7` })), braked);
  assert.deepEqual(await sixFrom((i) => ({ 'x-forwarded-for': `198.51.100.7, 192.0.2.${i}` })), free);
  // each request from its own edge address is its own sender
  assert.deepEqual(await sixFrom((i) => ({ 'cf-connecting-ip': `192.0.2.${i}` })), free);
  // no address at all: they share one allowance
  assert.deepEqual(await sixFrom(() => ({})), braked);
});

test('lead: the honeypot is answered 200 like a stored request, and nothing is read or written', async () => {
  const handler = await loadFunction('lead', ENV);
  const r = await lead(handler, { body: { ...FORM, company_url: 'http://spam.example.test', email: 'not an email' } });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.equal(fake.calls.length, 0, 'no count, no insert');
  assert.equal(fake.clients.length, 0, 'no database client was even made');
});

test('lead: a bad body is 400 with the function\'s sentence and the field the page focuses, a field its form has', async () => {
  const handler = await loadFunction('lead', ENV);
  const cases = [
    [{ ...FORM, name: '   ' }, 'the name is missing', 'name'],
    [{ ...FORM, dealership: '' }, 'the dealership is missing', 'dealership'],
    [{ ...FORM, website: '' }, 'the website is missing', 'website'],
    [{ ...FORM, email: '' }, 'the email is missing', 'email'],
    [{ ...FORM, email: 'pat at example' }, 'that email address does not look right', 'email'],
    [{ ...FORM, website: 'not a website' }, 'that website address does not look right', 'website'],
    [{ ...FORM, phone: 'call me' }, 'that phone number does not look right', 'phone'],
    [[FORM], 'send the form as a JSON object', ''],
  ];
  for (const [i, [body, error, field]] of cases.entries()) {
    const r = await lead(handler, { body, headers: from(`192.0.2.${i + 10}`) }); // one address each, clear of the brake
    assert.deepEqual([r.status, r.body], [400, { ok: false, error, field }], error);
    assert.ok(field === '' || FORM_FIELDS.includes(field), `${field} is a field of site/index.html's form`);
  }
  const notJson = await lead(handler, { raw: '{"name":', headers: from('192.0.2.30') });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /^bad JSON: /);
  assert.equal(notJson.body.field, '');
  assert.equal(fake.writes().length, 0);
});

test('lead: a body over 16 KiB is refused with 400 before it is parsed, by its declared length or its real one', async () => {
  const handler = await loadFunction('lead', ENV);
  const big = { ...FORM, message: 'x'.repeat(16 * 1024) };
  const r = await lead(handler, { body: big });
  assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'request too large', field: '' }]);
  // a small, valid form that declares more than the limit: only the declared
  // length can refuse it, so the function never reads a body it was told is too big
  const declared = await lead(handler, { headers: { ...from('192.0.2.3'), 'content-length': String(16 * 1024 + 1) }, raw: JSON.stringify(FORM) });
  assert.deepEqual([declared.status, declared.body], [400, { ok: false, error: 'request too large', field: '' }]);
  assert.equal(fake.writes().length, 0, 'neither was stored');
  // a long message within the limit is cut to the table's limit, not refused
  const long = await lead(handler, { body: { ...FORM, message: 'y'.repeat(LEAD_LIMITS.message + 500) }, headers: from('192.0.2.4') });
  assert.equal(long.status, 200);
  assert.equal(fake.rows('demo_requests')[0].message.length, LEAD_LIMITS.message);
});

test('lead: at PER_HOUR_TOTAL requests in the past hour the next is 429 and stored nowhere; older rows do not count', async () => {
  const handler = await loadFunction('lead', ENV);
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const row = (at) => ({ received_at: at, name: 'N', dealership: 'D', website: 'w.test', email: 'n@w.test' });
  fake.seed('demo_requests', [...Array.from({ length: PER_HOUR_TOTAL - 1 }, () => row(minutesAgo(30))), ...Array.from({ length: 40 }, () => row(minutesAgo(61)))]);
  const under = await lead(handler);
  assert.deepEqual([under.status, under.body], [200, { ok: true }], 'the 200th of the hour is taken');
  const full = await lead(handler, { headers: from('192.0.2.2') });
  assert.deepEqual([full.status, full.body], [429, { ok: false, error: 'we are receiving a lot of requests right now; please email us instead' }]);
  assert.equal(fake.rows('demo_requests').length, PER_HOUR_TOTAL + 40);
  const counts = fake.queries('demo_requests', 'select');
  assert.equal(counts.length, 2);
  for (const c of counts) {
    assert.equal(c.key, SERVICE_KEY, 'counted with the service role: no API role reads the table');
    assert.deepEqual([c.count, c.head, c.filters.map((f) => [f.op, f.column])], ['exact', true, [['gte', 'received_at']]]);
  }
});

test('lead: the stored row is what the visitor typed, trimmed, the email in lower case, and the page\'s origin; no address, no extra column', async () => {
  const handler = await loadFunction('lead', ENV);
  const r = await lead(handler, {
    body: { ...FORM, name: '  Pat Doe ', email: 'Pat@Example-Motors.TEST', phone: ' (555) 010-0100 ', message: 'Two stores.\nCall after 3.' },
    headers: { 'cf-connecting-ip': '192.0.2.99', 'x-forwarded-for': '203.0.113.5' },
  });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.equal(r.headers.get('access-control-allow-origin'), SITE);
  const [insert] = fake.writes('demo_requests');
  assert.equal(insert.op, 'insert');
  assert.equal(insert.key, SERVICE_KEY);
  assert.deepEqual(keysOf(insert.payload), ['dealership', 'email', 'message', 'name', 'page_origin', 'phone', 'website']);
  const [row] = fake.rows('demo_requests');
  assert.deepEqual(
    { name: row.name, dealership: row.dealership, website: row.website, email: row.email, phone: row.phone, message: row.message, page_origin: row.page_origin, handled_at: row.handled_at },
    { name: 'Pat Doe', dealership: 'Example Motors', website: 'www.example-motors.test', email: 'pat@example-motors.test', phone: '(555) 010-0100', message: 'Two stores.\nCall after 3.', page_origin: SITE, handled_at: null },
  );
  assert.doesNotMatch(JSON.stringify(fake.rows('demo_requests')), /192\.0\.2\.99|203\.0\.113\.5/, 'no address is kept');
  // empty optional fields are stored as null, not ''
  await lead(handler, { headers: from('192.0.2.100') });
  const second = fake.rows('demo_requests')[1];
  assert.deepEqual([second.phone, second.message], [null, null]);
});

test('lead: a database failure, or a missing service key, is 500 with a sentence, and the error goes to the log only', async () => {
  const handler = await loadFunction('lead', ENV);
  fake.script = (call) => (call.op === 'insert' ? { error: { message: 'relation "demo_requests" is full of secrets', code: 'XX000' } } : undefined);
  const r = await lead(handler);
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: 'the request could not be saved; please email us instead' }]);
  assert.doesNotMatch(r.text, /secrets/);
  const noKey = await loadFunction('lead', { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined });
  fake.script = null;
  const r2 = await lead(noKey);
  assert.deepEqual([r2.status, r2.body.error], [500, 'the request could not be saved; please email us instead']);
});

test('lead: scripts/check-deploy.mjs reads both lead lines as ok against the real handler', async () => {
  const lead = await loadFunction('lead', { LEAD_ORIGINS: SITE });
  const findings = await runChecks({ fetchImpl: functionsFetch({ lead }), url: SUPABASE_URL, anonKey: 'anon', siteOrigin: SITE });
  const mine = findings.filter((f) => f.check.startsWith('lead:'));
  assert.deepEqual(mine.map((f) => f.check), ['lead: refuses a page that is not the landing page', 'lead: answers the landing page\'s CORS preflight']);
  for (const f of mine) assert.equal(f.ok, true, `${f.check}: ${f.detail}`);
});
