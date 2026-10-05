import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDescription, rewriteFacts, rewriteWithBackend, guessColorsWithBackend } from '../extension/src/rewriter.js';
import { SYSTEM_PROMPT, buildRewritePrompt } from '../backend/rewritePrompt.js';
import { vehicle } from './helpers.js';

const DEALER = { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', zip: '15370' };
const ME = { name: 'Roger', title: 'sales consultant' };
const NOTE = 'Price includes the $490 doc fee; tax and tags extra.';
const DISCLAIMER = 'Ron Lewis Real Price includes all costs to be paid by a consumer except for licensing costs, registration fees and taxes. Documentation fee of $490 is not included.';
// the service on, and the store the salesperson ticked: the one the website lists the Ram at
const on = { myStores: [vehicle('usedNormal').location], rewrite: { enabled: true, endpoint: 'http://localhost:8787/', key: 'secret' } };

const args = (extra = {}) => ({
  vehicle: vehicle('usedNormal', { features: ['Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package'], description: `Local trade with new tires.<br>${DISCLAIMER}` }),
  dealer: DEALER, salesperson: ME, priceNote: NOTE, price: 27163, boilerplate: [DISCLAIMER],
  settings: { myStores: on.myStores, rewrite: { enabled: false } },
  ...extra,
});
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test('with the service off: the template, written from the listed facts, with neither the disclaimer nor the write-up copied', async () => {
  const r = await generateDescription(args());
  assert.equal(r.source, 'template');
  assert.ok(r.guardrails.ok, JSON.stringify(r.guardrails.problems));
  // the write-up, without the disclaimer, is what the service would be sent; the template copies none of it
  assert.deepEqual(r.narrative, ['Local trade with new tires.']);
  assert.doesNotMatch(r.text, /Local trade/);
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

test('a Claude draft that drops the salesperson\'s role is not used: the template is shown and the note says why', async () => {
  const template = (await generateDescription(args())).text;
  assert.match(template, /sales consultant/);
  const draft = template.replace(/^I'm Roger, sales consultant at (.+)\.$/m, 'Ask for Roger at $1.');
  assert.doesNotMatch(draft, /sales consultant/);
  const r = await generateDescription(args({ settings: on, fetchImpl: reply(200, { ok: true, text: draft }) }));
  assert.equal(r.source, 'template');
  assert.match(r.note, /Doesn't give your role \("sales consultant"\)/);
});

test('with no dealership name set, the service is not asked and the template says what to fix', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ ok: true, text: 'x' }) }; };
  const r = await generateDescription(args({ dealer: { name: '', city: '' }, settings: on, fetchImpl: counting }));
  assert.equal(calls, 0, 'no paid draft that cannot pass');
  assert.equal(r.source, 'template');
  assert.match(r.note, /name isn't set in Settings/);
  assert.ok(r.guardrails.problems.some((p) => p.code === 'no-dealer'));
});

test('the service is only called when switched on with an address', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ ok: true, text: 'x' }) }; };
  await generateDescription(args({ settings: { rewrite: { enabled: true, endpoint: '' } }, fetchImpl: counting }));
  await generateDescription(args({ settings: { rewrite: { enabled: false, endpoint: 'http://x' } }, fetchImpl: counting }));
  assert.equal(calls, 0);
});

test('only facts leave the browser: no VIN or price field, no Facebook data', () => {
  const v = vehicle('usedNormal');
  const f = rewriteFacts({ vehicle: v, dealer: DEALER, salesperson: ME, priceNote: NOTE, narrative: ['x'] });
  assert.ok(!('vin' in f));
  assert.ok(!('url' in f));
  assert.equal(f.make, 'Ram');
  assert.equal(f.carfaxOneOwner, true);
  assert.deepEqual(f.dealer, { name: DEALER.name, city: 'Waynesburg' });
  assert.deepEqual(f.salesperson, ME);
});

test('the website\'s write-up goes to the service as the website wrote it, a VIN, price or phone number in it included', async () => {
  // what docs/data-inventory.md and the privacy texts say: the VIN and the price are not among the fields,
  // and the description's own sentences go as the website wrote them; the boilerplate is the only thing taken out
  const v = vehicle('usedNormal', { description: `Local trade with new tires. VIN: ${vehicle('usedNormal').vin}. Internet price $27,163. Call Dana at 555-201-3344.<br>${DISCLAIMER}` });
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, text: '' }) };
  };
  const r = await generateDescription(args({ vehicle: v, settings: on, fetchImpl }));
  assert.ok(body, 'the service was called');
  assert.ok(!('vin' in body) && !('price' in body), 'no VIN or price field');
  assert.deepEqual(body.narrative, r.narrative, 'the write-up the template read, unchanged');
  const sent = body.narrative.join(' ');
  for (const part of [v.vin, '$27,163', '555-201-3344', 'Local trade with new tires.']) assert.ok(sent.includes(part), `${part} goes as written`);
  assert.ok(!sent.includes('Documentation fee'), 'the lot-wide boilerplate does not');
});

test('the service system prompt names no real person or dealer', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /Ron Lewis|Waynesburg|Roger/);
});

test('the service system prompt asks for none of the claims the checks refuse unless the facts make them', () => {
  const rule = SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('- Use only facts from the JSON.'));
  for (const what of ['condition', 'service history', 'previous owners', 'how or where it was driven', 'where it came from', 'accidents', 'tires', 'keys', 'title', 'financing', 'warranty']) {
    assert.ok(rule.includes(what), what);
  }
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

test('a Claude draft that drops the salesperson\'s role falls back to the template, which states it', async () => {
  const example = { name: 'Example Motors', city: 'Springfield' };
  const specialist = { name: 'Sam', title: 'product specialist' };
  const base = args({ dealer: example, salesperson: specialist, priceNote: '' });
  const template = (await generateDescription(base)).text;
  assert.match(template, /I'm Sam, product specialist at Example Motors\./);
  const roleless = template.replace("I'm Sam, product specialist at Example Motors.", "I'm Sam at Example Motors.");
  const r = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: roleless }) });
  assert.equal(r.source, 'template');
  assert.match(r.note, /Doesn't give your role \("product specialist"\)/);
  // the role the salesperson set in Settings is the one looked for, not the default
  const other = template.replace('product specialist', 'sales consultant');
  const o = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: other }) });
  assert.equal(o.source, 'template');
  // with the role, the draft is used
  const fine = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: template.replace('Highlights:', 'What I like:') }) });
  assert.equal(fine.source, 'claude', fine.note);
});

// Drafts a rewrite could write that only look honest: each number is one the
// website has, but in the wrong place (the model's "1500" as the mileage, the
// year as a price), or the words are wrong (a number spelled out, care the
// website never mentions, no role, a seller who is not the dealership). Every
// one falls back to the template, and the note says why.
test('a Claude draft with a wrong number, an invented fact, no role or a private-seller pose falls back to the template', async () => {
  const example = { name: 'Example Motors', city: 'Springfield' };
  const dana = { name: 'Dana', title: 'sales consultant' };
  const base = args({ dealer: example, salesperson: dana, priceNote: '' }); // the 2019 Ram 1500 Classic, 20,986 miles, posted at 27,163
  const template = (await generateDescription(base)).text;
  const signoff = "I'm Dana, sales consultant at Example Motors.";
  assert.ok(template.includes('with 20,986 miles') && template.includes(signoff) && /^Pre-owned and on the lot at .*$/m.test(template), template);
  const drafts = {
    '1,500 miles (the model\'s number)': [template.replace('20,986 miles', '1,500 miles'), /Says 1,500 miles, but the website shows 20,986 miles/],
    '$2,019 (the year)': [template.replace('Highlights:', 'Priced at just $2,019 this week.\nHighlights:'), /Says \$2,019, but this listing's price is \$27,163/],
    'a mileage in words': [template.replace('with 20,986 miles', 'with only twelve thousand miles'), /"twelve thousand" isn't in the website's data/],
    'care the website never mentions': [template.replace('Highlights:', 'Garage kept, non-smoker, full service records.\nHighlights:'), /Says "Garage kept"/],
    'no role': [template.replace(signoff, 'Ask for Dana at Example Motors.'), /Doesn't give your role \("sales consultant"\)/],
    'the owner\'s seller, no role': [template.replace(/^Pre-owned and on the lot at .*\n/m, '').replace(signoff, "I'm Dana. Selling this truck for the owner, text me. Message me directly, not the dealership."), /Doesn't give your role/],
    'the owner\'s seller, role kept': [template.replace(/^Pre-owned and on the lot at .*\n/m, '').replace(signoff, `${signoff} Selling this truck for the owner, text me. Message me directly, not the dealership.`), /Says "not the dealership"/],
  };
  for (const [what, [draft, why]] of Object.entries(drafts)) {
    assert.notEqual(draft, template, what);
    const r = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: draft }) });
    assert.equal(r.source, 'template', what);
    assert.match(r.note, why, what);
    assert.equal(r.text, template, what);
  }
});

test('on a one-owner car, a Claude draft that hides a claim inside the one-owner wording falls back to the template', async () => {
  const base = args({ dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Dana', title: 'sales consultant' }, priceNote: '' });
  base.vehicle = { ...base.vehicle, carfaxOneOwner: true };
  const template = (await generateDescription(base)).text;
  assert.match(template, /One owner according to the Carfax report\./);
  const drafts = {
    'One damage-free owner.': /Says "damage", but the website says nothing about accident, damage or title history/,
    'One non-smoking owner.': /Says "non-smoking"/,
    'One adult owner.': /Says "One adult owner", but the website says nothing about its owners/,
  };
  for (const [sentence, why] of Object.entries(drafts)) {
    const draft = template.replace('One owner according to the Carfax report.', `${sentence} One owner according to the Carfax report.`);
    const r = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: draft }) });
    assert.equal(r.source, 'template', sentence);
    assert.match(r.note, why, sentence);
  }
  // the count alone is the Carfax flag's, so that draft is used
  const counted = template.replace('One owner according to the Carfax report.', 'Just one previous owner, according to the Carfax report.');
  const kept = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: counted }) });
  assert.equal(kept.source, 'claude', kept.note);
});

test('a Claude draft that drops the dealership\'s price note falls back to the template, which carries it', async () => {
  const example = { name: 'Example Motors', city: 'Springfield' };
  const note = 'Price is before the $490 doc fee; tax and tags extra.';
  const base = args({ dealer: example, priceNote: note, price: 26673 });
  const template = (await generateDescription(base)).text;
  assert.ok(template.includes(note));
  const noteless = template.replace(`${note}\n`, '').replace('Highlights:', 'What I like about it:') + '\nHappy to set up a time for you to see it.';
  const r = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: noteless }) });
  assert.equal(r.source, 'template');
  assert.match(r.note, /Doesn't include your dealership's price note/);
  assert.ok(r.text.includes(note));
  // with the note, the same draft is used
  const kept = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: template.replace('Highlights:', 'What I like about it:') }) });
  assert.equal(kept.source, 'claude', kept.note);
});

test('nothing about the car\'s type leaves the browser, so the service lets a draft say certified only as the write-up or features do', () => {
  for (const v of [vehicle('usedNormal'), vehicle('certified')]) {
    const f = rewriteFacts({ vehicle: v });
    for (const k of ['inventoryType', 'readableType', 'urlConditionWord', 'siteTitle', 'certified']) assert.ok(!(k in f), k);
  }
});

test('a Claude draft that adds parts to the one the write-up names falls back to the template', async () => {
  const example = { name: 'Example Motors', city: 'Springfield' };
  const base = args({ dealer: example, priceNote: '' });
  const template = (await generateDescription(base)).text;
  const more = template.replace('\n', '\nLocal trade with new tires and new brakes, plus a new battery.\n');
  assert.notEqual(more, template);
  const r = await generateDescription({ ...base, settings: on, fetchImpl: reply(200, { ok: true, text: more }) });
  assert.equal(r.source, 'template');
  assert.match(r.note, /Says "new brakes"/);
  assert.match(r.note, /Says "new battery"/);
  assert.equal(r.text, template);
});

test('for a car the website lists at a store in another town, the template names its store and the service is not asked', async () => {
  const group = { name: 'Sample Auto Group', city: 'Springfield', zip: '00000' };
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ ok: true, text: 'unused' }) }; };
  const away = args({ vehicle: { ...args().vehicle, location: 'Sample Chevrolet Shelbyville' }, dealer: group, priceNote: '' });
  for (const myStores of [[], ['Sample Ford Springfield', 'Sample Chevrolet Shelbyville']]) {
    const r = await generateDescription({ ...away, settings: { ...on, myStores }, fetchImpl: counting });
    assert.equal(r.source, 'template');
    assert.match(r.text, /on the lot at Sample Chevrolet Shelbyville\./);
    assert.doesNotMatch(r.text, /Springfield/);
    assert.match(r.note, /lists this car at Sample Chevrolet Shelbyville, which may not be at your dealership's address/);
    assert.ok(r.guardrails.ok, JSON.stringify(r.guardrails.problems));
  }
  assert.equal(calls, 0, 'nothing was sent');
  // a store in the dealership's own town, or the one store ticked: the service is asked as before
  const home = args({ vehicle: { ...args().vehicle, location: 'Sample Ford Springfield' }, dealer: group, priceNote: '' });
  await generateDescription({ ...home, settings: { ...on, myStores: [] }, fetchImpl: counting });
  await generateDescription({ ...away, settings: { ...on, myStores: ['Sample Chevrolet Shelbyville'] }, fetchImpl: counting });
  assert.equal(calls, 2);
});
