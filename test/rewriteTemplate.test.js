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
  const single = vehicle('usedNormal', { extra_fields: { lightning: { pricing: { high: false } } } });
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

test('every description names the salesperson\'s role: the title from Settings (or the default), in any case or spacing', () => {
  const v = vehicle('usedNoCarfax');
  const dealer = { name: 'Example Auto Outlet', city: 'Springfield' };
  const me = { name: 'Alex', title: 'internet sales manager' };
  const c = { vehicle: v, dealer, salesperson: me, priceNote: '', price: v.price };
  const text = buildTemplateDescription(c);
  assert.match(text, /I'm Alex, internet sales manager at Example Auto Outlet\./);
  assert.deepEqual(runGuardrails(text, c).problems, []);
  const codes = (t, ctx2 = c) => runGuardrails(t, ctx2).problems.map((p) => p.code);
  // the dealership is named but the role is gone: refused, with the role named in the reason
  const noRole = text.replace("I'm Alex, internet sales manager at Example Auto Outlet.", 'Ask for Alex at Example Auto Outlet.');
  assert.deepEqual(codes(noRole), ['no-role']);
  assert.equal(runGuardrails(noRole, c).problems[0].text, "Doesn't give your role (internet sales manager)");
  // another role than the salesperson's is not theirs
  assert.deepEqual(codes(text, { ...c, salesperson: { name: 'Alex', title: 'finance manager' } }), ['no-role']);
  // case and spacing do not matter
  assert.deepEqual(codes(text.replace('internet sales manager', 'Internet  Sales\nManager')), []);
  // with no title set, the default one is the role the template writes and the check asks for
  const plain = { ...c, salesperson: { name: 'Alex', title: '' } };
  assert.deepEqual(codes(buildTemplateDescription(plain), plain), []);
  assert.deepEqual(codes(noRole, { ...c, salesperson: {} }), ['no-role']);
});

test('with no dealership name set, the template writes no empty "at" and every description fails until the name is set', () => {
  const v = vehicle('usedNoCarfax', { features: ['Bluetooth', 'Backup Camera', 'Heated Seats'] });
  const c = { vehicle: v, dealer: { name: '  ' }, salesperson: { name: 'Alex', title: 'sales consultant' }, priceNote: '', price: v.price };
  const text = buildTemplateDescription(c);
  assert.doesNotMatch(text, / at \./);
  assert.match(text, /I'm Alex, sales consultant\./);
  const g = runGuardrails(text, c);
  assert.equal(g.ok, false);
  assert.deepEqual(g.problems.filter((p) => p.code === 'no-dealer').map((p) => p.text), ["The dealership's name isn't set; add it in Settings"]);
  assert.ok(runGuardrails(text, { ...c, dealer: {} }).problems.some((p) => p.code === 'no-dealer'), 'no dealer at all is the same');
});

test('a plain-English problem list comes back for the side panel', () => {
  const v = vehicle('usedNormal');
  const g = runGuardrails('Nice truck for 9,999.', ctx(v));
  assert.equal(g.ok, false);
  assert.ok(g.problems.every((p) => typeof p.text === 'string' && p.text.length));
});

// ---------- the salesperson's highlights and closing line ----------
import { featureChoices, settleHighlights, checkClosingLine, ensureClosingLine, usableClosingLine, MAX_HIGHLIGHTS, CLOSING_LINE_MAX_WORDS } from '../extension/src/rewriteTemplate.js';

const SAMPLE_DEALER = { name: 'Example Auto Outlet', city: 'Springfield' };

test('feature choices: each once, short ones only, the useful ones first', () => {
  const list = ['Power Windows', 'power  windows', 'Heated Seats', 'A very long equipment line that runs past forty characters', 'Navigation System', 7];
  assert.deepEqual(featureChoices(list), ['Navigation System', 'Heated Seats', 'Power Windows']);
  assert.deepEqual(pickFeatures(FEATURES), featureChoices(FEATURES).slice(0, 6), 'the usual pick is the first choices');
});

test('the salesperson\'s highlights: only the website\'s features, as the website writes them, in the order picked, at most six', () => {
  assert.deepEqual(settleHighlights(null, FEATURES), pickFeatures(FEATURES));
  assert.deepEqual(settleHighlights(['cruise control', 'Heated Seats', 'Heated seats', 'Leather everything', 'Free gas for a year'], FEATURES), ['Cruise Control', 'Heated Seats']);
  assert.deepEqual(settleHighlights([], FEATURES), []);
  assert.equal(settleHighlights(FEATURES, FEATURES).length, MAX_HIGHLIGHTS);
});

test('the template names the picked highlights, and none when all are unticked', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const picked = buildTemplateDescription(ctx(v, { dealer: SAMPLE_DEALER, highlights: ['Cruise Control', 'Power Windows'] }));
  assert.match(picked, /Highlights: Cruise Control, Power Windows\./);
  const none = buildTemplateDescription(ctx(v, { dealer: SAMPLE_DEALER, highlights: [] }));
  assert.doesNotMatch(none, /Highlights:/);
  for (const text of [picked, none]) assert.deepEqual(runGuardrails(text, ctx(v, { dealer: SAMPLE_DEALER })).problems, []);
});

test('a closing line: the salesperson\'s own words about themselves, no prices or numbers but a phone number', () => {
  assert.deepEqual(checkClosingLine(''), { ok: true, problems: [] });
  assert.ok(checkClosingLine('Ask for me by name when you come in.').ok);
  assert.ok(checkClosingLine('Call or text me at (555) 010-4477.').ok);
  const code = (line) => checkClosingLine(line).problems.map((p) => p.code);
  assert.deepEqual(code('Only 9,000 miles on it!'), ['closing-number']);
  assert.deepEqual(code('I can take $500 off today.'), ['closing-price']);
  assert.deepEqual(code('Best deal around, priced to sell.'), ['closing-banned', 'closing-banned']);
  assert.deepEqual(code('Selling my truck myself.'), ['closing-banned', 'closing-banned']);
  assert.deepEqual(code('A one-owner gem.'), ['closing-one-owner']);
  assert.deepEqual(code('CALL TODAY NOW'), ['closing-caps']);
  assert.deepEqual(code('Come see me 🚗🚗'), ['closing-emoji']);
  assert.deepEqual(code(Array(CLOSING_LINE_MAX_WORDS + 1).fill('word').join(' ')), ['closing-too-long']);
  assert.equal(usableClosingLine('  Ask   for me.  '), 'Ask for me.');
  assert.equal(usableClosingLine('Only 9,000 miles!'), '');
});

test('the template ends with the closing line in place of the stock invitation, and still passes every check', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const line = 'Call or text me at (555) 010-4477, and ask for me by name when you come by the lot this week.';
  const args = ctx(v, { dealer: SAMPLE_DEALER, salesperson: { ...ME, closingLine: line } });
  const text = buildTemplateDescription(args);
  assert.ok(text.includes(`I'm Roger, sales consultant at Example Auto Outlet.\n${line}`), text);
  assert.doesNotMatch(text, /Message me to set up a test drive/);
  // the phone number is the salesperson's, not a fact about the car; the line is not counted
  const g = runGuardrails(text, { ...args, closingLine: line });
  assert.deepEqual(g.problems, []);
  // checked on its own wherever it appears; outside it, every number still comes from the website
  assert.ok(runGuardrails(text, args).problems.some((p) => p.code === 'unknown-number'), 'without the closing line, the phone number is an unknown number');
  const bad = 'Only 9,000 miles!';
  assert.equal(buildTemplateDescription(ctx(v, { dealer: SAMPLE_DEALER, salesperson: { ...ME, closingLine: bad } })), buildTemplateDescription(ctx(v, { dealer: SAMPLE_DEALER })), 'a line that fails its checks is left out');
});

test('ensureClosingLine adds the line once', () => {
  assert.equal(ensureClosingLine('Text.', 'Ask for me.'), 'Text.\nAsk for me.');
  assert.equal(ensureClosingLine('Text.\nAsk for me.', 'Ask for me.'), 'Text.\nAsk for me.');
  assert.equal(ensureClosingLine('Text.  ', ''), 'Text.');
});

test('a closing line the salesperson wrapped in the description is still recognised as theirs', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const line = 'Call or text me at (555) 010-4477 any time.';
  const args = ctx(v, { dealer: SAMPLE_DEALER, salesperson: { ...ME, closingLine: line } });
  const wrapped = buildTemplateDescription(args).replace('(555) 010-4477 any', '(555) 010-4477\nany');
  assert.deepEqual(runGuardrails(wrapped, { ...args, closingLine: line }).problems, []);
  assert.equal(ensureClosingLine(wrapped, line), wrapped, 'not added twice');
});

// The side panel won't fill a description with a rule problem; style
// warnings don't stop it. Every code the checks can give is one or the
// other, so a new check has to be sorted when it is added.
import { RULE_PROBLEM_CODES, ruleProblems } from '../extension/src/rewriteTemplate.js';
import { readFileSync } from 'node:fs';

test('every guardrail code is either a posting rule (stops the fill) or a style warning', () => {
  const src = readFileSync(new URL('../extension/src/rewriteTemplate.js', import.meta.url), 'utf8');
  const codes = [...new Set([...src.matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  const WARNINGS = ['too-short', 'too-long', 'all-caps', 'emoji', 'no-vin', 'closing-too-long', 'closing-caps', 'closing-emoji'];
  assert.deepEqual(codes, [...RULE_PROBLEM_CODES, ...WARNINGS].sort());
  assert.ok(Object.isFrozen(RULE_PROBLEM_CODES));
  // the rules named in the posting rules: the dealership and the role named, facts only, no posing as a private seller, honest prices
  for (const code of ['no-dealer', 'no-role', 'unknown-number', 'one-owner', 'banned-phrase', 'price-note-amount']) assert.ok(RULE_PROBLEM_CODES.includes(code), code);
  const v = vehicle('usedNormal');
  const g = runGuardrails('MY TRUCK, ONLY $199 A MONTH', { vehicle: v, dealer: { name: 'Example Motors' }, price: v.price });
  assert.deepEqual(ruleProblems(g).map((p) => p.code).sort(), ['banned-phrase', 'no-dealer', 'no-role', 'unknown-number']);
  assert.ok(g.problems.some((p) => p.code === 'too-short') && !ruleProblems(g).some((p) => p.code === 'too-short'));
  assert.deepEqual(ruleProblems(null), []);
  assert.deepEqual(ruleProblems({ ok: true, problems: [] }), []);
});

// The template copies the first sentences of the dealer's own write-up. One
// that a posting rule stops (a banned phrase, a one-owner claim the Carfax
// flag doesn't back) is left out, so the template never writes what its own
// checks stop: a stop on the review screen comes from the person's edit.
test('the write-up sentences the posting rules stop are left out of the template, the rest are used', () => {
  const plain = { ...vehicle('usedNormal', { features: FEATURES.slice(0, 4) }), carfaxOneOwner: false }; // the flag is read from the raw record, so set on the normalised one
  const cases = [
    ['ONE OWNER, CLEAN TITLE! Priced to sell. Local trade with new tires and brakes.', ['ONE OWNER', 'CLEAN TITLE', 'Priced to sell'], 'Local trade with new tires and brakes.'],
    ['1-owner vehicle with low miles. Local trade with new tires and brakes.', ['1-owner'], 'Local trade with new tires and brakes.'],
    ['Selling my truck because I bought another. Local trade with new tires and brakes.', ['Selling my truck'], 'Local trade with new tires and brakes.'],
  ];
  for (const [story, gone, kept] of cases) {
    const text = buildTemplateDescription({ ...ctx(plain), narrative: [story] });
    for (const g of gone) assert.ok(!text.includes(g), `"${g}" is left out:\n${text}`);
    assert.ok(text.includes(kept), `the rest of the write-up is used:\n${text}`);
    assert.deepEqual(ruleProblems(runGuardrails(text, ctx(plain))), [], text);
  }
  // nothing usable left: no write-up sentence at all
  const none = buildTemplateDescription({ ...ctx(plain), narrative: ['One owner! Must sell.'] });
  assert.deepEqual(ruleProblems(runGuardrails(none, ctx(plain))), []);
  assert.ok(!/must sell|one owner!/i.test(none));
  // the Carfax flag set: a one-owner sentence is a fact the data backs, and is kept
  const owned = { ...plain, carfaxOneOwner: true };
  assert.match(buildTemplateDescription({ ...ctx(owned), narrative: ['1-owner vehicle with low miles.'] }), /1-owner vehicle with low miles\./);
});
