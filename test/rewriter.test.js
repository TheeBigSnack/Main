import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDescription, rewriteFacts, rewriteWithBackend, guessColorsWithBackend } from '../extension/src/rewriter.js';
import { SYSTEM_PROMPT, buildRewritePrompt } from '../backend/rewritePrompt.js';
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

test('a Claude draft that passes the checks is used, and gets the VIN line if the service left it out', async () => {
  const template = (await generateDescription(args())).text;
  const draft = template.replace('Highlights:', 'What I like:').replace(/^VIN .*\n?/m, '');
  assert.doesNotMatch(draft, /VIN/);
  const r = await generateDescription(args({ settings: on, fetchImpl: reply(200, { ok: true, text: draft, model: 'claude-haiku-4-5' }) }));
  assert.equal(r.source, 'claude');
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.match(r.text, /VIN 1C6RR7FT0KS643289\.$/);
  assert.ok(r.guardrails.ok);
});

test('color guesses: only the list words come back, and the request carries photos and the list', async () => {
  let seen;
  const capture = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, exterior: 'gray', interior: 'Sepia', confidence: 'medium', model: 'm' }) }; };
  const r = await guessColorsWithBackend({ endpoint: 'http://localhost:8787', key: 'k', photos: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg', 'https://a/4.jpg', 'https://a/5.jpg'], options: ['Gray', 'Black'], fetchImpl: capture });
  assert.equal(seen.url, 'http://localhost:8787/color');
  assert.equal(seen.body.photos.length, 4);
  assert.deepEqual(seen.body.options, ['Gray', 'Black']);
  assert.deepEqual({ ok: r.ok, exterior: r.exterior, interior: r.interior, confidence: r.confidence }, { ok: true, exterior: 'Gray', interior: '', confidence: 'medium' });
  const bad = await guessColorsWithBackend({ endpoint: 'http://x', photos: ['https://a/1.jpg'], options: ['Gray'], fetchImpl: reply(429, { ok: false, error: 'cap reached' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cap reached/);
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

test('the service system prompt names no real person or dealer', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /Ron Lewis|Waynesburg|Roger/);
});

test('the service user prompt tells Claude the exact sign-off, built from the facts', () => {
  const facts = rewriteFacts({ vehicle: vehicle('usedNormal'), dealer: { name: 'Test Motors', city: 'Testville' }, salesperson: { name: 'Dana', title: 'sales consultant' }, priceNote: NOTE });
  const { system, user } = buildRewritePrompt(facts);
  assert.equal(system, SYSTEM_PROMPT);
  assert.match(user, /Sign off with exactly: "I'm Dana, sales consultant at Test Motors\."/);
  // no name: the same form the template writer uses
  const anon = buildRewritePrompt({ ...facts, salesperson: { name: '', title: 'sales consultant' } });
  assert.match(anon.user, /Sign off with exactly: "Sales consultant at Test Motors\."/);
  // the line survives a regeneration with fixes
  const again = buildRewritePrompt(facts, ['too long']);
  assert.match(again.user, /I'm Dana, sales consultant at Test Motors\./);
  assert.match(again.user, /too long/);
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

test('the salesperson\'s closing line never goes to the service and is added to its draft before the VIN', async () => {
  const line = 'Ask for me by name when you come in.';
  let sent = null;
  const capture = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ok: true, text: draft }) }; };
  const template = (await generateDescription(args())).text;
  const draft = template.replace(/^VIN .*\n?/m, '');
  const r = await generateDescription(args({ settings: on, salesperson: { ...ME, closingLine: line }, fetchImpl: capture }));
  assert.ok(!JSON.stringify(sent).includes(line), 'the closing line left the browser');
  assert.equal(r.source, 'claude');
  assert.match(r.text, /Ask for me by name when you come in\.\nVIN 1C6RR7FT0KS643289\.$/);
  assert.ok(r.guardrails.ok, JSON.stringify(r.guardrails.problems));
});

test('the salesperson\'s highlights are the features the service sees', async () => {
  const f = rewriteFacts({ vehicle: vehicle('usedNormal', { features: ['Backup Camera', 'Bluetooth', 'Tow Package'] }), highlights: ['tow package', 'Made up feature'] });
  assert.deepEqual(f.features, ['Tow Package']);
  assert.equal(f.highlightsPicked, true);
  assert.match(buildRewritePrompt(f).system, /If highlightsPicked is true[^\n]*name exactly the ones in "features", in the order given, and no others/);
  const all = rewriteFacts({ vehicle: vehicle('usedNormal', { features: ['Backup Camera', 'Bluetooth'] }) });
  assert.deepEqual(all.features, ['Backup Camera', 'Bluetooth'], 'no pick: the whole list, as before');
  assert.ok(!('highlightsPicked' in all));
});
