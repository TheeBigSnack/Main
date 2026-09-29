// The lead function (a demo request from the landing page): the pure checks
// in supabase/functions/_shared/lead.mjs, and the rules the function, the
// migration and the page must keep, read off their source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLead, clean, parseOrigins, originAllowed, LEAD_LIMITS, HONEYPOT, PER_ADDRESS_PER_HOUR, PER_HOUR_TOTAL } from '../supabase/functions/_shared/lead.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
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
  const migration = read('../supabase/migrations/0005_leads.sql');
  for (const [field, max] of Object.entries(LEAD_LIMITS)) {
    assert.match(migration, new RegExp(`${field} text[^\\n]*${max}\\)`), `the table caps ${field} at ${max} too`);
  }
});

test('origins: only the landing page\'s own origins, compared exactly', () => {
  const allowed = parseOrigins(' https://lotsync.example , https://www.lotsync.example/, not a url, ftp://x.test ');
  assert.deepEqual(allowed, ['https://lotsync.example', 'https://www.lotsync.example']);
  assert.equal(originAllowed('https://lotsync.example', allowed), true);
  assert.equal(originAllowed('https://evil.test', allowed), false);
  assert.equal(originAllowed('https://lotsync.example.evil.test', allowed), false);
  assert.equal(originAllowed('', allowed), false);
  assert.deepEqual(parseOrigins(''), []);
});

test('the lead function: origin first, a brake per address and per hour, the service role only inside, nothing read back', () => {
  const fn = read('../supabase/functions/lead/index.ts');
  const order = ['originAllowed(origin, allowed)', 'allow(await addressKey(req))', 'readJson(req, BODY_LIMIT)', 'validateLead(', "if (checked.bot) return answer(200", 'PER_HOUR_TOTAL', ".insert({"];
  let at = -1;
  for (const step of order) {
    const i = fn.indexOf(step, at + 1);
    assert.ok(i > at, `${step} comes in order`);
    at = i;
  }
  assert.doesNotMatch(fn, /\.select\('\*'\)|\.select\('name|\.select\('email/, 'the function never reads a request back');
  assert.match(fn, /select\('id', \{ count: 'exact', head: true \}\)/, 'it only counts');
  assert.match(fn, /SHA-256/, 'the address is hashed, never kept');
  assert.doesNotMatch(fn, /Access-Control-Allow-Origin': '\*'/);
  assert.ok(PER_ADDRESS_PER_HOUR <= 10 && PER_HOUR_TOTAL <= 500);
  assert.match(read('../supabase/config.toml'), /\[functions\.lead\]\s+verify_jwt = false/);
  const migration = read('../supabase/migrations/0005_leads.sql');
  assert.match(migration, /alter table public\.demo_requests enable row level security;/);
  assert.match(migration, /revoke all on public\.demo_requests from anon, authenticated;/);
  assert.doesNotMatch(migration, /create policy/, 'no policy: no API role reads or writes it');
  const sql = migration.replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\bip\b|ip_address|user_agent|x_forwarded/i, 'no address or browser is stored');
});

test('the landing page: a honeypot people never reach, and the request goes to the one configured endpoint', () => {
  const html = read('../site/index.html');
  assert.match(html, /<div class="hp" aria-hidden="true">[\s\S]*?<input id="f-company-url" name="company_url" type="text" tabindex="-1" autocomplete="off">/);
  assert.match(read('../site/site.css'), /\.hp \{ position: absolute; left: -10000px;/);
  const js = read('../site/site.js');
  assert.match(js, /filter\(\(\[k\]\) => k !== 'company_url'\)/, 'the mail fallback leaves the honeypot out');
  assert.match(js, /fetch\(SITE\.demoEndpoint,/);
  assert.match(read('../site/config.js'), /functions\/v1\/lead/);
});
