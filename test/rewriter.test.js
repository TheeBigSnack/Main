import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDescription, rewriteFacts, rewriteWithBackend } from '../extension/src/rewriter.js';
import { vehicle } from './helpers.js';

const DEALER = { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', zip: '15370' };
const ME = { name: 'Roger', title: 'sales consultant' };
const NOTE = 'Price includes the $490 doc fee; tax and tags extra.';
const DISCLAIMER = 'Ron Lewis Real Price includes all costs to be paid by a consumer except for licensing costs, registration fees and taxes. Documentation fee of $490 is not included.';
const on = { rewrite: { enabled: true, endpoint: 'http://localhost:8787/', key: 'secret' } };

const args = (extra = {}) => ({
  vehicle: vehicle('usedNormal', { features: ['Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package'], description: `Local trade with new tires.<br>${DISCLAIMER}` }),
  dealer: DEALER, salesperson: ME, priceNote: NOTE, price: 27163, boilerplate: [DISCLAIMER],
  settings: { rewrite: { enabled: false } },
  ...extra,
});
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test('with the service off: the template, with the disclaimer stripped and the write-up kept', async () => {
  const r = await generateDescription(args());
  assert.equal(r.source, 'template');
  assert.ok(r.guardrails.ok, JSON.stringify(r.guardrails.problems));
  assert.deepEqual(r.narrative, ['Local trade with new tires.']);
  assert.match(r.text, /Local trade with new tires\./);
  assert.doesNotMatch(r.text, /Documentation fee/);
});

test('a Claude draft that passes the checks is used', async () => {
  const template = (await generateDescription(args())).text;
  const draft = template.replace('Highlights:', 'What I like:');
  const r = await generateDescription(args({ settings: on, fetchImpl: reply(200, { ok: true, text: draft, model: 'claude-haiku-4-5' }) }));
  assert.equal(r.source, 'claude');
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.text, draft);
});

test('a Claude draft with a made-up number falls back to the template and says why', async () => {
  const template = (await generateDescription(args())).text;
  const r = await generateDescription(args({ settings: on, fetchImpl: reply(200, { ok: true, text: template.replace('20,986', '12,000') }) }));
  assert.equal(r.source, 'template');
  assert.match(r.note, /12000/);
  assert.equal(r.text, template);
});

test('a service error or an unreachable service falls back to the template', async () => {
  const boom = async () => { throw new Error('connection refused'); };
  const a = await generateDescription(args({ settings: on, fetchImpl: reply(500, { ok: false, error: 'cap reached' }) }));
  const b = await generateDescription(args({ settings: on, fetchImpl: boom }));
  assert.equal(a.source, 'template');
  assert.match(a.note, /cap reached/);
  assert.equal(b.source, 'template');
  assert.match(b.note, /connection refused/);
});

test('the service is only called when switched on with an address', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ ok: true, text: 'x' }) }; };
  await generateDescription(args({ settings: { rewrite: { enabled: true, endpoint: '' } }, fetchImpl: counting }));
  await generateDescription(args({ settings: { rewrite: { enabled: false, endpoint: 'http://x' } }, fetchImpl: counting }));
  assert.equal(calls, 0);
});

test('only facts leave the browser: no VIN, no Facebook data', () => {
  const v = vehicle('usedNormal');
  const f = rewriteFacts({ vehicle: v, dealer: DEALER, salesperson: ME, priceNote: NOTE, narrative: ['x'] });
  assert.ok(!('vin' in f));
  assert.ok(!('url' in f));
  assert.equal(f.make, 'Ram');
  assert.equal(f.carfaxOneOwner, true);
  assert.deepEqual(f.dealer, { name: DEALER.name, city: 'Waynesburg' });
  assert.deepEqual(f.salesperson, ME);
});

test('the request goes to /rewrite with the service key', async () => {
  let seen;
  const capture = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true, text: 'draft', model: 'm' }) }; };
  const r = await rewriteWithBackend({ endpoint: 'http://localhost:8787/', key: 'secret', facts: { make: 'Ram' }, fetchImpl: capture });
  assert.equal(seen.url, 'http://localhost:8787/rewrite');
  assert.equal(seen.init.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(seen.init.body).make, 'Ram');
  assert.deepEqual({ ok: r.ok, text: r.text, model: r.model }, { ok: true, text: 'draft', model: 'm' });
});
