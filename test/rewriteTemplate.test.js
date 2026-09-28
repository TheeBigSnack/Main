import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateDescription, runGuardrails, pickFeatures, numbersIn, wordCount, ensureVinLine, stripVin, WORD_LIMITS } from '../extension/src/rewriteTemplate.js';
import { vehicle } from './helpers.js';

const DEALER = { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', zip: '15370' };
const ME = { name: 'Roger', title: 'sales consultant' };
const NOTE = 'Price includes the $490 doc fee; tax and tags extra.';
const FEATURES = ['Power Windows', 'Cruise Control', 'Backup Camera', 'Bluetooth', 'Keyless Entry', 'Tow Package', 'Navigation System', 'Heated Seats', 'Apple CarPlay'];

const ctx = (v, extra = {}) => ({ vehicle: v, dealer: DEALER, salesperson: ME, priceNote: NOTE, price: v.price, ...extra });

test('the Ram gets a full description that passes every check', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const text = buildTemplateDescription(ctx(v));
  const g = runGuardrails(text, ctx(v));
  assert.deepEqual(g.problems, []);
  assert.ok(g.words >= WORD_LIMITS.min && g.words <= WORD_LIMITS.max, `${g.words} words`);
  assert.match(text, /^2019 Ram 1500 Classic Express with 20,986 miles\./);
  assert.match(text, /One owner according to the Carfax report\./);
  assert.match(text, /Highlights: /);
  assert.match(text, /Price includes the \$490 doc fee; tax and tags extra\./);
  assert.match(text, /I'm Roger, sales consultant at Ron Lewis Chrysler Dodge Jeep Ram Waynesburg\./);
  assert.match(text, /^VIN 1C6RR7FT0KS643289\.$/m);
  assert.ok(text.split('\n').every((line) => wordCount(line) <= 30), 'short lines');
});

test('the VIN is in every description, its digits are not "numbers", and it is not counted as prose', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const text = buildTemplateDescription(ctx(v));
  assert.equal(runGuardrails(text, ctx(v)).ok, true);
  const without = text.replace(/^VIN .*$/m, '');
  assert.ok(runGuardrails(without, ctx(v)).problems.some((p) => p.code === 'no-vin'));
  assert.equal(ensureVinLine(without, v.vin).trimEnd().endsWith('VIN 1C6RR7FT0KS643289.'), true);
  assert.equal(ensureVinLine(text, v.vin), text.trimEnd()); // already there
  assert.equal(stripVin('Nice truck.\nVIN 1C6RR7FT0KS643289.\nCall me.').replace(/\s+/g, ' ').trim(), 'Nice truck. Call me.');
  assert.equal(wordCount(stripVin(text)), wordCount(text) - 2);
});

test('features: the useful ones first, at most six, no duplicates', () => {
  const picked = pickFeatures(FEATURES);
  assert.equal(picked.length, 6);
  assert.deepEqual(picked.slice(0, 3), ['Navigation System', 'Apple CarPlay', 'Heated Seats']);
  assert.ok(!picked.includes('Power Windows'));
  assert.deepEqual(pickFeatures(['AWD', 'awd', ' AWD ']), ['AWD']);
  assert.deepEqual(pickFeatures(null), []);
  assert.deepEqual(pickFeatures(['Bluetooth', 'Sunroof']), ['Sunroof', 'Bluetooth']);
});

test('no "one owner" line unless Carfax says so', () => {
  const v = vehicle('usedNoCarfax', { media: { image_count: 5 } });
  const text = buildTemplateDescription(ctx(v));
  assert.doesNotMatch(text, /one owner/i);
  assert.doesNotMatch(text, /Carfax/i);
});

test('a sparse car (no features, no write-up, no Carfax) is still long enough', () => {
  const v = vehicle('usedNoCarfax');
  const text = buildTemplateDescription({ vehicle: v, dealer: { name: 'Ron Lewis' }, salesperson: { title: 'sales consultant' } });
  const g = runGuardrails(text, { vehicle: v, dealer: { name: 'Ron Lewis' } });
  assert.deepEqual(g.problems, []);
  assert.match(text, /Sales consultant at Ron Lewis\./);
});

test('a wordy write-up and lots of features are trimmed to the limit', () => {
  const narrative = [
    'This striking 2016 Dodge Challenger SRT Hellcat delivers premium performance wrapped in sophisticated style, with a supercharged engine that makes every drive an event. ' +
      'Inside, the cabin is comfortable and well appointed with everything you need for a long trip or a quick run into town. ' +
      'It has been well cared for and shows nicely inside and out.',
  ];
  const v = vehicle('usedNoCarfax', { features: FEATURES });
  const text = buildTemplateDescription({ ...ctx(v), narrative });
  const g = runGuardrails(text, ctx(v));
  assert.deepEqual(g.problems, []);
  assert.ok(g.words <= WORD_LIMITS.max, `${g.words} words`);
});

test('the write-up sentence is used only when it fits', () => {
  const v = vehicle('usedNormal', { features: FEATURES.slice(0, 4) });
  const text = buildTemplateDescription({ ...ctx(v), narrative: ['Local trade with new tires and brakes.'] });
  assert.match(text, /Local trade with new tires and brakes\./);
});

test('numbers are normalised before comparing', () => {
  assert.deepEqual([...numbersIn('20,986 miles, $27,163, 5.7L V8, 8-Speed, 4x4')].sort(), ['163', '20986', '27', '4', '5.7', '8'].sort().filter((x) => x !== '163' && x !== '27').concat(['27163']).sort());
});

test('guardrails catch numbers that are not in the source', () => {
  const v = vehicle('usedNormal');
  const g = runGuardrails(buildTemplateDescription(ctx(v)).replace('20,986', '12,000'), ctx(v));
  assert.ok(g.problems.some((p) => p.code === 'unknown-number' && p.text.includes('12000')));
});

test('a price note quoting a fee amount must match the gap between the two prices this car shows', () => {
  const v = vehicle('usedNormal'); // 27163 main, 26673 before fees: a $490 gap
  const ok = runGuardrails(buildTemplateDescription(ctx(v)), ctx(v));
  assert.equal(ok.ok, true);
  const stale = ctx(v, { priceNote: 'Price includes the $500 doc fee; tax and tags extra.' });
  const g = runGuardrails(buildTemplateDescription(stale), stale);
  assert.ok(g.problems.some((p) => p.code === 'price-note-amount' && /\$500/.test(p.text) && /\$490/.test(p.text)), JSON.stringify(g.problems));
  // only the amount tied to the fee is compared: another fee in the same note is the dealer's business
  const two = ctx(v, { priceNote: 'Price includes the $490 doc fee; tax, tags and a $55 title fee extra.' });
  const t2 = runGuardrails(buildTemplateDescription(two), two);
  assert.ok(!t2.problems.some((p) => p.code === 'price-note-amount'), JSON.stringify(t2.problems));
  const wrongTied = ctx(v, { priceNote: 'Price includes the $500 doc fee; tax, tags and a $55 title fee extra.' });
  const t3 = runGuardrails(buildTemplateDescription(wrongTied), wrongTied);
  assert.ok(t3.problems.some((p) => p.code === 'price-note-amount' && /\$500/.test(p.text)), JSON.stringify(t3.problems));
  // no second price on this car: nothing to compare the note with, so it passes
  const single = vehicle('usedNormal', { pricing: { internet_price: null, price: null } });
  const c = ctx(single, { priceNote: 'Price includes the $500 doc fee; tax and tags extra.' });
  const h = runGuardrails(buildTemplateDescription(c), c);
  assert.ok(!h.problems.some((p) => p.code === 'price-note-amount'), JSON.stringify(h.problems));
});

test('guardrails catch banned phrases, fake one-owner claims, a missing dealer name and shouting', () => {
  const v = vehicle('usedNoCarfax');
  const base = buildTemplateDescription(ctx(v));
  const codes = (text, c = ctx(v)) => runGuardrails(text, c).problems.map((p) => p.code);
  assert.ok(codes(base + '\nBest price in town, no accidents!').includes('banned-phrase'));
  assert.ok(codes(base + '\nOne owner, garage kept.').includes('one-owner'));
  assert.ok(codes(base + '\nSelling my car, private seller.').includes('banned-phrase'));
  assert.ok(codes(base + '\nMUST SEE THIS ONE').includes('all-caps'));
  assert.ok(codes(base + '\n🔥🔥🔥🔥 wow').includes('emoji'));
  assert.ok(codes(base.replace(/Ron Lewis Chrysler Dodge Jeep Ram Waynesburg/g, 'our store')).includes('no-dealer'));
  assert.ok(codes('Too short.').includes('too-short'));
  assert.deepEqual(codes(base), []);
  // abbreviations and model names in caps are fine
  assert.ok(!codes(base + '\nHEMI V8 with 4WD and the SRT package.').includes('all-caps'));
});

test('a plain-English problem list comes back for the side panel', () => {
  const v = vehicle('usedNormal');
  const g = runGuardrails('Nice truck for 9,999.', ctx(v));
  assert.equal(g.ok, false);
  assert.ok(g.problems.every((p) => typeof p.text === 'string' && p.text.length));
});
