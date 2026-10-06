// The lead function (a demo request from the landing page): the pure checks
// in supabase/functions/_shared/lead.mjs, driven at their limits (the fields,
// the address the brake keys on, the brake, the hourly cap); the rules the
// function, the migration and the page must keep, read off their source with
// comments stripped; and site.js's form run against a stand-in page, for what
// the visitor reads after each answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SITE } from '../site/config.js';
import {
  validateLead, clean, parseOrigins, originAllowed, clientAddress, addressKey, addressBrake, hourlyCapReached,
  LEAD_LIMITS, HONEYPOT, PER_ADDRESS_PER_HOUR, PER_HOUR_TOTAL, HOUR_MS, BRAKE_MAX_KEYS,
} from '../supabase/functions/_shared/lead.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// SQL as the database runs it: -- and /* */ comments gone, so a commented-out line does not count.
const sqlOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
// TypeScript as Deno runs it: // and /* */ comments gone (a // inside a string, as in https://, stays).
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const good = { name: 'Pat Doe', dealership: 'Example Motors', website: 'www.example-motors.test', email: 'Pat@Example-Motors.test', phone: '(555) 010-0100', message: 'Two stores.\nCall after 3.' };

test('validateLead: a good request is trimmed and kept; the email is lower case; the message keeps its lines', () => {
  const r = validateLead({ ...good, name: '  Pat Doe  ', extra: 'ignored' });
  assert.equal(r.ok, true);
  assert.equal(r.bot, false);
  assert.deepEqual(r.lead, { name: 'Pat Doe', dealership: 'Example Motors', website: 'www.example-motors.test', email: 'pat@example-motors.test', phone: '(555) 010-0100', message: 'Two stores.\nCall after 3.' });
  assert.equal(validateLead({ ...good, website: 'https://www.example-motors.test/used-vehicles/' }).ok, true);
  assert.equal(validateLead({ ...good, phone: '', message: '' }).lead.phone, '');
});

test('validateLead: the missing or malformed field is named', () => {
  for (const field of ['name', 'dealership', 'website', 'email']) {
    const r = validateLead({ ...good, [field]: '   ' });
    assert.deepEqual([r.ok, r.field], [false, field], field);
  }
  assert.equal(validateLead({ ...good, email: 'pat at example' }).field, 'email');
  assert.equal(validateLead({ ...good, website: 'not a website' }).field, 'website');
  assert.equal(validateLead({ ...good, phone: 'call me' }).field, 'phone');
  assert.equal(validateLead(null).ok, false);
  assert.equal(validateLead([good]).ok, false);
  assert.equal(validateLead('text').ok, false);
});

test('validateLead: the honeypot answers like a success and keeps nothing', () => {
  assert.equal(HONEYPOT, 'company_url');
  assert.deepEqual(validateLead({ ...good, company_url: 'http://spam.test' }), { ok: true, bot: true });
  assert.equal(validateLead({ ...good, company_url: '   ' }).bot, false, 'an empty honeypot is a person');
});

test('clean: control characters go, lengths are capped at the table\'s limits', () => {
  assert.equal(clean('a\u0000b\u0007c', 10), 'a b c');
  assert.equal(clean('line 1\nline 2\u0000', 50, { multiline: true }), 'line 1\nline 2');
  assert.equal(clean(42, 10), '');
  const r = validateLead({ ...good, name: 'x'.repeat(500), message: 'y'.repeat(5000) });
  assert.equal(r.lead.name.length, LEAD_LIMITS.name);
  assert.equal(r.lead.message.length, LEAD_LIMITS.message);
  const migration = sqlOf('../supabase/migrations/0005_leads.sql');
  for (const [field, max] of Object.entries(LEAD_LIMITS)) {
    assert.match(migration, new RegExp(`${field} text[^\\n]*${max}\\)`), `the table caps ${field} at ${max} too`);
  }
});

test('origins: only the landing page\'s own origins, compared exactly', () => {
  const allowed = parseOrigins(' https://lotcurrent.example , https://www.lotcurrent.example/, not a url, ftp://x.test ');
  assert.deepEqual(allowed, ['https://lotcurrent.example', 'https://www.lotcurrent.example']);
  assert.equal(originAllowed('https://lotcurrent.example', allowed), true);
  assert.equal(originAllowed('https://evil.test', allowed), false);
  assert.equal(originAllowed('https://lotcurrent.example.evil.test', allowed), false);
  assert.equal(originAllowed('', allowed), false);
  assert.deepEqual(parseOrigins(''), []);
});

test('clientAddress: a header the platform sets, else the rightmost X-Forwarded-For entry, never what the client put first', () => {
  const from = (h) => clientAddress(new Headers(h));
  assert.equal(from({ 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
  // a client that writes its own X-Forwarded-For only moves the entries to the left of the proxy's
  assert.equal(from({ 'x-forwarded-for': '10.0.1.1, 203.0.113.9' }), '203.0.113.9');
  assert.equal(from({ 'x-forwarded-for': '10.0.2.1,10.0.3.1 ,  203.0.113.9 ' }), '203.0.113.9');
  assert.equal(from({ 'x-forwarded-for': '203.0.113.9, ' }), '203.0.113.9', 'an empty last entry is no address');
  // the platform's own headers come first, cf-connecting-ip before x-real-ip
  const all = { 'cf-connecting-ip': '198.51.100.7', 'x-real-ip': '192.0.2.4', 'x-forwarded-for': '10.0.1.1, 203.0.113.9' };
  assert.equal(from(all), '198.51.100.7');
  assert.equal(from({ ...all, 'cf-connecting-ip': '  ' }), '192.0.2.4', 'a blank header is skipped');
  assert.equal(from({ 'x-real-ip': ' 192.0.2.4 ', 'x-forwarded-for': '203.0.113.9' }), '192.0.2.4');
  // nothing to go on: one shared key, so the brake still holds
  assert.equal(from({}), 'unknown');
  assert.equal(from({ 'x-forwarded-for': ' , ,' }), 'unknown');
  assert.equal(clientAddress(null), 'unknown');
});

test('addressKey: the address hashed, the same for a client that rewrites X-Forwarded-For, different for another visitor', async () => {
  const key = await addressKey(new Headers({ 'x-forwarded-for': '10.0.1.1, 203.0.113.9' }));
  assert.match(key, /^[0-9a-f]{24}$/, '12 bytes of SHA-256 in hex, no address');
  assert.equal(await addressKey(new Headers({ 'x-forwarded-for': '10.0.2.1, 203.0.113.9' })), key);
  assert.equal(await addressKey(new Headers({ 'x-forwarded-for': '203.0.113.9' })), key);
  assert.notEqual(await addressKey(new Headers({ 'x-forwarded-for': '10.0.1.1, 203.0.113.10' })), key);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('203.0.113.9')));
  assert.equal(key, Buffer.from(digest.slice(0, 12)).toString('hex'));
});

test('addressBrake: PER_ADDRESS_PER_HOUR from one address, the next refused, and room again an hour after the first', async () => {
  let t = 0;
  const brake = addressBrake({ now: () => t });
  const key = 'k';
  for (let n = 0; n < PER_ADDRESS_PER_HOUR; n++, t++) assert.equal(brake.allow(key), true, `request ${n + 1}`);
  assert.equal(brake.allow(key), false, `request ${PER_ADDRESS_PER_HOUR + 1} is refused`);
  assert.equal(brake.allow('other'), true, 'another address is not held up');
  t = HOUR_MS - 1;
  assert.equal(brake.allow(key), false, 'still inside the hour of the first');
  t = HOUR_MS;
  assert.equal(brake.allow(key), true, 'the first has left the hour, so one more fits');
  assert.equal(brake.allow(key), false, 'and only one');
  t = HOUR_MS + 1;
  assert.equal(brake.allow(key), true, 'the second has left too');
  // one client that makes up a new X-Forwarded-For each time: the proxy's entry, last, is the same
  const live = addressBrake();
  const answers = [];
  for (let i = 1; i <= PER_ADDRESS_PER_HOUR + 3; i++) {
    answers.push(live.allow(await addressKey(new Headers({ 'x-forwarded-for': `10.0.${i}.1, 203.0.113.9` }))));
  }
  assert.deepEqual(answers, [...Array(PER_ADDRESS_PER_HOUR).fill(true), false, false, false]);
});

test('addressBrake: never holds more than its cap of addresses; the one heard from longest ago goes first', () => {
  let t = 0;
  const brake = addressBrake({ limit: 2, maxKeys: 3, now: () => t });
  assert.equal(brake.allow('a'), true);
  assert.equal(brake.allow('a'), true);
  assert.equal(brake.allow('a'), false);
  for (const k of ['b', 'c']) assert.equal(brake.allow(k), true);
  assert.equal(brake.size, 3);
  assert.equal(brake.allow('d'), true);
  assert.equal(brake.size, 3, 'at the cap, a new address pushes the oldest out');
  assert.equal(brake.allow('a'), true, 'a forgotten address starts again: why the table-wide cap is the backstop');
  assert.equal(brake.allow('d'), true);
  assert.equal(brake.allow('d'), false, 'the addresses it kept still count');
  // with the real cap: a client with a new address every time fills a fixed amount of memory
  const live = addressBrake({ now: () => t });
  for (let i = 0; i < BRAKE_MAX_KEYS + 50; i++) {
    live.allow('spoof-' + i);
    assert.ok(live.size <= BRAKE_MAX_KEYS, `at most ${BRAKE_MAX_KEYS} addresses`);
  }
  assert.equal(live.size, BRAKE_MAX_KEYS);
  // an hour of quiet empties it
  t += HOUR_MS;
  live.allow('next');
  assert.equal(live.size, 1, 'addresses quiet for an hour are forgotten');
});

test('hourlyCapReached: the table takes PER_HOUR_TOTAL an hour and not one more', () => {
  assert.equal(hourlyCapReached(0), false);
  assert.equal(hourlyCapReached(null), false);
  assert.equal(hourlyCapReached(PER_HOUR_TOTAL - 1), false);
  assert.equal(hourlyCapReached(PER_HOUR_TOTAL), true);
  assert.equal(hourlyCapReached(PER_HOUR_TOTAL + 1), true);
  assert.ok(PER_ADDRESS_PER_HOUR <= 10 && PER_HOUR_TOTAL <= 500);
});

test('the lead function: origin first, then the address brake, the fields, the honeypot, the hourly cap, the insert', () => {
  const fn = codeOf('../supabase/functions/lead/index.ts');
  const start = fn.indexOf('Deno.serve(');
  assert.ok(start > 0, 'the handler');
  const handler = fn.slice(start);
  const order = [
    "if (!originAllowed(origin, allowed)) return answer(403, { ok: false, error:",
    "if (!brake.allow(await addressKey(req.headers))) return answer(429, { ok: false, error:",
    'const read = await readJson(req, BODY_LIMIT);',
    'const checked = validateLead(',
    'if (checked.bot) return answer(200, { ok: true }, headers);',
    // the cap counts the past hour only: without the window it would count every request ever stored,
    // and after the 200th the form would refuse everyone for good
    'const since = new Date(Date.now() - HOUR_MS).toISOString();',
    ".select('id', { count: 'exact', head: true }).gte('received_at', since);",
    "if (hourlyCapReached(count)) return answer(429, { ok: false, error:",
    ".from('demo_requests').insert({",
  ];
  let at = -1;
  for (const step of order) {
    const i = handler.indexOf(step);
    assert.ok(i > at, `${step} comes next in the handler`);
    assert.equal(handler.indexOf(step, i + 1), -1, `${step} appears once`);
    at = i;
  }
  // one brake for the instance, made before the handler, so it remembers between requests
  assert.equal(fn.split('addressBrake(').length, 2, 'one brake');
  assert.ok(fn.indexOf('const brake = addressBrake();') > 0 && fn.indexOf('const brake = addressBrake();') < start, 'made once, outside the handler');
  assert.doesNotMatch(fn, /x-forwarded-for|cf-connecting-ip|x-real-ip/i, 'the address is chosen in clientAddress (_shared/lead.mjs) only');
  assert.doesNotMatch(fn, /PER_HOUR_TOTAL|PER_ADDRESS_PER_HOUR/, 'the limits are applied in _shared/lead.mjs, where the tests above drive them');
});

test('the lead function: the service role only inside, nothing read back; the table readable by no API role', () => {
  const fn = codeOf('../supabase/functions/lead/index.ts');
  assert.doesNotMatch(fn, /\.select\('\*'\)|\.select\('name|\.select\('email/, 'the function never reads a request back');
  assert.match(fn, /select\('id', \{ count: 'exact', head: true \}\)/, 'it only counts');
  assert.doesNotMatch(fn, /Access-Control-Allow-Origin': '\*'/);
  assert.match(read('../supabase/config.toml'), /\[functions\.lead\]\s+verify_jwt = false/);
  const sql = sqlOf('../supabase/migrations/0005_leads.sql');
  assert.match(sql, /alter table public\.demo_requests enable row level security;/);
  assert.match(sql, /revoke all on public\.demo_requests from anon, authenticated;/);
  assert.doesNotMatch(sql, /create policy/i, 'no policy: no API role reads or writes it');
  assert.doesNotMatch(sql, /disable row level security|no force row level security/i);
  assert.doesNotMatch(sql, /grant [^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i, 'no API role is granted anything back');
  assert.doesNotMatch(sql, /\bip\b|ip_address|user_agent|x_forwarded/i, 'no address or browser is stored');
});

test('the landing page: a honeypot people never reach, and the request goes to the one configured endpoint', () => {
  const html = read('../site/index.html');
  assert.match(html, /<div class="hp" aria-hidden="true">[\s\S]*?<input id="f-company-url" name="company_url" type="text" tabindex="-1" autocomplete="off">/);
  // each field stops where the function would cut it, so nothing is cut after the page says it has the request
  for (const [name, max] of Object.entries(LEAD_LIMITS)) {
    const tags = [...html.matchAll(new RegExp(`<(?:input|textarea)\\b[^>]*\\bname="${name}"[^>]*>`, 'g'))].map((m) => m[0]);
    assert.equal(tags.length, 1, `one ${name} field`);
    const lengths = [...tags[0].matchAll(/\bmaxlength="(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual(lengths, [max], `the ${name} field's maxlength is LEAD_LIMITS.${name}`);
  }
  assert.match(read('../site/site.css'), /\.hp \{ position: absolute; left: -10000px;/);
  const js = read('../site/site.js');
  assert.match(js, /filter\(\(\[k\]\) => k !== 'company_url'\)/, 'the mail fallback leaves the honeypot out');
  assert.match(js, /fetch\(SITE\.demoEndpoint,/);
  assert.match(read('../site/config.js'), /functions\/v1\/lead/);
});

// site.js run against a stand-in page and endpoint: what the visitor reads for each answer the function can give.
async function standInForm(site = { demoEndpoint: 'https://lead.test/functions/v1/lead', demoMailto: 'mailto:demo@lotcurrent.example' }) {
  const src = read('../site/site.js');
  const configImport = "import { SITE } from './config.js';";
  assert.ok(src.includes(configImport), 'site.js takes its addresses from config.js');
  const code = src.replace(configImport, `const SITE = ${JSON.stringify(site)};`) + '\n//# sourceURL=site.js (stand-in)\n';
  const status = { textContent: '', className: '' };
  const button = { disabled: false };
  const page = { submit: null, focused: [], resets: 0, sent: [], location: { href: '' }, reply: () => ({ ok: false, status: 404 }) };
  const form = {
    addEventListener: (type, fn) => { if (type === 'submit') page.submit = fn; },
    reportValidity: () => true,
    querySelector: () => button,
    elements: { namedItem: (name) => ({ focus: () => page.focused.push(name) }) },
    reset: () => { page.resets++; },
  };
  const stubs = {
    window: { location: page.location },
    document: { getElementById: (id) => ({ 'demo-form': form, 'demo-status': status })[id] || null },
    FormData: class { entries() { return Object.entries(good)[Symbol.iterator](); } },
    fetch: async (url, init) => {
      if (url === './pricing.json') return { ok: false, status: 404 };
      page.sent.push({ url, init });
      return page.reply();
    },
  };
  const withStubs = async (fn) => {
    const saved = Object.fromEntries(Object.keys(stubs).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    Object.assign(globalThis, stubs);
    try {
      return await fn();
    } finally {
      for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
    }
  };
  await withStubs(() => import('data:text/javascript,' + encodeURIComponent(code)));
  assert.equal(typeof page.submit, 'function', 'site.js wires the form');
  // one request: `reply` makes the answer (or throws, as a network failure does)
  page.send = async (reply) => {
    page.reply = reply;
    status.textContent = '';
    await withStubs(() => page.submit({ preventDefault() {} }));
    assert.equal(button.disabled, false, 'the button works again');
    return { text: status.textContent, kind: status.className };
  };
  return page;
}

const reply = (status, body) => () => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

test('with an inbox and no endpoint, as site/config.js may be deployed, a request opens the visitor\'s mail app with the fields and sends nothing', async () => {
  // The committed inbox when there is one, so this runs the state that ships; a stand-in otherwise.
  const mailto = SITE.demoMailto || 'mailto:demo@lotcurrent.example';
  const inbox = mailto.replace(/^mailto:/, '').replace(/\?.*$/, '');
  const page = await standInForm({ demoEndpoint: '', demoMailto: mailto });
  const said = await page.send(() => { throw new Error('the mail path must not call any endpoint'); });
  assert.equal(page.sent.length, 0, 'nothing is sent from the page');
  assert.deepEqual(said, { text: `Your email app should open with the request filled in. If it did not, email ${inbox}.`, kind: 'status ok' });
  const href = page.location.href;
  assert.ok(href.startsWith(`${mailto}${mailto.includes('?') ? '&' : '?'}subject=`), `the page goes to the inbox's mailto address: ${href.slice(0, 80)}`);
  const query = new URLSearchParams(href.slice(href.indexOf('?') + 1));
  assert.equal(query.get('subject'), 'Lot Current demo request');
  assert.deepEqual(query.get('body').split('\r\n'), Object.entries(good).map(([k, v]) => `${k}: ${v}`), 'every field as typed, one per line, in the form\'s order');
  assert.equal(page.resets, 0, 'the form keeps what was typed, in case the mail app did not open');
});

test('the landing page tells the visitor a request did not send, unless the function answered 200; only 400 and 429 use its own sentence', async () => {
  const page = await standInForm();
  const failed = { text: 'That did not send. Please try again, or email demo@lotcurrent.example.', kind: 'status error' };
  // the function's own failures and anything in front of it: the visitor is told it did not send
  assert.deepEqual(await page.send(reply(500, { ok: false, error: 'the request could not be saved; please email us instead' })), failed, '500');
  assert.deepEqual(await page.send(reply(403, { ok: false, error: 'demo requests come from the Lot Current website only' })), failed, '403');
  assert.deepEqual(await page.send(reply(502, 'not json')), failed, 'a gateway error page');
  assert.deepEqual(await page.send(reply(400, {})), failed, 'a 400 with no sentence');
  assert.deepEqual(await page.send(() => { throw new TypeError('Failed to fetch'); }), failed, 'no answer at all');
  assert.equal(page.resets, 0, 'the form keeps what was typed');
  // 400 and 429: the function's sentence, and the field to fix
  assert.deepEqual(await page.send(reply(400, { ok: false, error: 'that email address does not look right', field: 'email' })),
    { text: 'That email address does not look right. You can also email demo@lotcurrent.example.', kind: 'status error' });
  assert.deepEqual(page.focused, ['email']);
  assert.deepEqual(await page.send(reply(429, { ok: false, error: 'too many requests from here; please try again in an hour or email us' })),
    { text: 'Too many requests from here; please try again in an hour or email us. You can also email demo@lotcurrent.example.', kind: 'status error' });
  // 200: the thank-you, and the form is cleared
  assert.deepEqual(await page.send(reply(200, { ok: true })), { text: 'Thank you. We have your request and will reply by email.', kind: 'status ok' });
  assert.equal(page.resets, 1);
  // every request went to the endpoint as JSON, with the fields as typed
  for (const { url, init } of page.sent) {
    assert.equal(url, 'https://lead.test/functions/v1/lead');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), good);
  }
});
