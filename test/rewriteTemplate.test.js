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

// ---------- prices and mileage the text states ----------
import { dollarAmounts, mileageClaims } from '../extension/src/rewriteTemplate.js';
import { generateDescription } from '../extension/src/rewriter.js';

const EXAMPLE = { name: 'Example Motors', city: 'Springfield' };
const SAM = { name: 'Sam', title: 'sales consultant' };
const STALE = 'Was $31,995, now just $28,995 with 38,000 miles! Rides on 20-inch wheels with the 8.4-inch touchscreen.';

test('a stale price, price drop or mileage in a draft fails the checks, though the write-up has those numbers', () => {
  const v = { ...vehicle('usedNormal', { features: FEATURES }), descriptionRaw: STALE }; // 20,986 miles; posted at 26,673
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: 'Price includes the $490 doc fee; tax and tags extra.', price: 26673 };
  const base = buildTemplateDescription(c);
  assert.deepEqual(runGuardrails(base, c).problems, [], 'the template passes');
  const g = runGuardrails(`${base}\nWas $31,995, now just $28,995 with 38,000 miles!`, c);
  const codes = g.problems.map((p) => p.code);
  assert.ok(!codes.includes('unknown-number'), 'every number is in the write-up');
  assert.deepEqual(codes.filter((x) => x !== 'too-long').sort(), ['mileage-mismatch', 'price-change', 'price-mismatch', 'price-mismatch']);
  assert.ok(g.problems.some((p) => p.text === "Says $31,995, but this listing's price is $26,673"));
  assert.ok(g.problems.some((p) => p.text === 'Says 38,000 miles, but the website shows 20,986 miles'));
  // the posted price, the price note's amount and the website's own mileage are fine
  assert.deepEqual(runGuardrails(`${base}\nAsking $26,673 with 20,986 miles.`.replace('Message me to set up a test drive or ask a question.\n', ''), c).problems.filter((p) => /price|mileage/.test(p.code)), []);
  // a short form of the same claim is caught too
  assert.ok(runGuardrails(`${base}\nOnly 38K miles.`, c).problems.some((p) => p.code === 'mileage-mismatch'));
  // with no price to compare (the rewrite service's own check), any amount outside the price note is flagged
  assert.ok(runGuardrails(`${base}\n$26,673.`, { ...c, price: null }).problems.some((p) => p.code === 'price-mismatch'));
});

test('distances, ranges and warranty terms are not read as the mileage', () => {
  assert.deepEqual(mileageClaims('A 3-year/36,000-mile powertrain warranty, 300 miles of range, 30 miles away, within 50 miles, every 5,000 miles, 60 mph.'), []);
  assert.deepEqual(mileageClaims('Only 38,000 miles! Has 38K miles, 41.2k mi and 45 thousand miles.').map((m) => m.value), [38000, 38000, 41200, 45000]);
  assert.deepEqual(dollarAmounts('$28,995, $ 490 and $28.5k').map((a) => a.value), [28995, 490, 28500]);
});

test('the template leaves out write-up sentences with a price or another mileage, and still passes its own checks', async () => {
  const v = { ...vehicle('usedNormal'), descriptionRaw: STALE };
  const r = await generateDescription({ vehicle: v, dealer: EXAMPLE, salesperson: SAM, price: 26673 });
  assert.doesNotMatch(r.text, /\$|38,000|now just/);
  assert.match(r.text, /Rides on 20-inch wheels with the 8\.4-inch touchscreen\./, 'the next sentence is used instead');
  assert.deepEqual(r.guardrails.problems, []);
  assert.match(r.text, /with 20,986 miles\./);
});

test('the template passes its own word count whatever the features and write-up (the VIN line is not counted)', () => {
  const picks = ['Navigation System', 'Heated Seats', 'Backup Camera', 'Bluetooth', 'Apple CarPlay', 'Remote Start'];
  for (let n = 0; n <= picks.length; n += 1) {
    for (const narrative of [[], ['A clean truck.'], ['A clean truck that drives well.'], ['A clean truck that drives well and has been kept up nicely.']]) {
      const v = vehicle('usedNoCarfax', { features: picks.slice(0, n) });
      const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price, narrative };
      assert.deepEqual(runGuardrails(buildTemplateDescription(c), c).problems, [], `${n} features, ${JSON.stringify(narrative)}`);
    }
  }
});

test('a stale mileage or price is caught in the usual ways a write-up states it, and the template leaves it out', async () => {
  // the car: 20,986 miles, posted at 26,673
  const v = vehicle('usedNormal', { features: FEATURES });
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: 26673 };
  const base = buildTemplateDescription(c);
  const stale = {
    'Only 38,000 original miles.': ['mileage-mismatch'],
    'Just 38,000 actual miles!': ['mileage-mismatch'],
    'Mileage: 38,000.': ['mileage-mismatch'],
    'Odometer reads 38,000.': ['mileage-mismatch'],
    'Odometer reading is just 38K.': ['mileage-mismatch'],
    'It has 38,000 on the clock.': ['mileage-mismatch'],
    'Was 31,995, now just 28,995!': ['price-change', 'price-mismatch'],
    'Sale price 28,995 plus tax.': ['price-mismatch'],
    'Internet price: 28,995.': ['price-mismatch'],
    'Yours for 28,995 today.': ['price-mismatch'],
    'Now 26,673!': ['price-change'],
  };
  for (const [sentence, codes] of Object.entries(stale)) {
    const got = runGuardrails(`${base}\n${sentence}`, c).problems.map((p) => p.code).filter((code) => /price|mileage/.test(code));
    assert.deepEqual([...new Set(got)].sort(), codes, sentence);
    // the template, given the same sentence in the write-up, leaves it out and still passes
    const r = await generateDescription({ vehicle: { ...v, descriptionRaw: `${sentence} Rides on 20-inch wheels with the 8.4-inch touchscreen.` }, dealer: EXAMPLE, salesperson: SAM, price: 26673 });
    assert.ok(!r.text.includes(sentence), `the template leaves out: ${sentence}`);
    assert.match(r.text, /Rides on 20-inch wheels/);
    assert.deepEqual(r.guardrails.problems, [], sentence);
  }
  assert.ok(runGuardrails(`${base}\nOnly 38,000 original miles.`, c).problems.some((p) => p.text === 'Says 38,000 miles, but the website shows 20,986 miles'));
  assert.ok(runGuardrails(`${base}\nInternet price: 28,995.`, c).problems.some((p) => p.text === "Says $28,995, but this listing's price is $26,673"));
  // the listing's own price and mileage, said the same ways, are fine
  for (const sentence of ['Internet price: 26,673.', 'Mileage: 20,986.', 'Odometer reads 20,986.', 'Just 20,986 actual miles.']) {
    const got = runGuardrails(`${base}\n${sentence}`, c).problems.filter((p) => /price|mileage/.test(p.code));
    assert.deepEqual(got, [], sentence);
  }
});

test('a model year, fuel economy, a warranty, a range or a weight is never read as the mileage or a price', () => {
  for (const words of ['Low mileage 2019 Ram 1500.', 'Great gas mileage of 30 mpg.', 'Fuel mileage: 28 city / 36 highway.', '1 owner low miles.', 'Range: 290 Miles', 'Free Oil Changes 2 Years or 24,000 Miles', '24 months or 24,000 miles of coverage.', '5 Miles to Empty Warning', 'Towing capacity was 7,500 lbs.', 'The price includes 2 keys.', 'It was 2019 when it came in.']) {
    assert.deepEqual(mileageClaims(words), [], words);
    assert.deepEqual(dollarAmounts(words), [], words);
  }
  assert.deepEqual(mileageClaims('Only 38,000 original miles. Mileage: 38,000 miles. Odometer reads 41,230; 45k on the odo.').map((m) => m.value), [38000, 38000, 41230, 45000]);
  assert.deepEqual(dollarAmounts('Was 31,995, now just $28,995. Internet price: 28,995. Priced at 26,673; yours for 28.5k.').map((a) => a.value), [31995, 28995, 28995, 26673, 28500]);
});

test('the template leaves out write-up sentences the checks would refuse: a banned phrase, or one owner without the Carfax flag', async () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  for (const sentence of ['Priced for our private sale event this weekend.', 'No accidents and runs perfect!', 'A one-owner truck, traded in here.']) {
    const r = await generateDescription({ vehicle: { ...v, carfaxOneOwner: false, descriptionRaw: `${sentence} Rides on 20-inch wheels with the 8.4-inch touchscreen.` }, dealer: EXAMPLE, salesperson: SAM, price: v.price });
    assert.ok(!r.text.includes(sentence), `the template leaves out: ${sentence}`);
    assert.match(r.text, /Rides on 20-inch wheels/);
    assert.deepEqual(r.guardrails.problems, [], sentence);
  }
  // with the Carfax one-owner flag the same sentence is the website's own fact
  const flagged = await generateDescription({ vehicle: { ...v, carfaxOneOwner: true, descriptionRaw: 'A one-owner truck, traded in here. Rides on 20-inch wheels.' }, dealer: EXAMPLE, salesperson: SAM, price: v.price });
  assert.match(flagged.text, /A one-owner truck, traded in here\./);
  assert.deepEqual(flagged.guardrails.problems, []);
});

test('a feature stating a price or a mileage is never a highlight, so the template passes whatever the features', async () => {
  const features = ['Under 30,000 Miles', '$1,000 Below Market', 'Price Reduced', 'Range: 290 Miles', 'Free Oil Changes 2 Years or 24,000 Miles', '5 Miles to Empty Warning', 'Heated Seats', 'Backup Camera'];
  const choices = featureChoices(features);
  for (const f of ['Under 30,000 Miles', '$1,000 Below Market', 'Price Reduced']) assert.ok(!choices.includes(f), f);
  for (const f of ['Range: 290 Miles', 'Free Oil Changes 2 Years or 24,000 Miles', '5 Miles to Empty Warning', 'Heated Seats', 'Backup Camera']) assert.ok(choices.includes(f), f);
  assert.deepEqual(settleHighlights(['Under 30,000 Miles', 'Heated Seats'], features), ['Heated Seats'], "a salesperson's pick can't bring one in");
  const v = vehicle('usedNormal', { features }); // 20,986 miles
  const r = await generateDescription({ vehicle: v, dealer: EXAMPLE, salesperson: SAM, price: v.price });
  assert.deepEqual(r.guardrails.problems, []);
});

// ---------- the dealership is always named ----------

test('with no dealership name set, the description never passes and never signs off "at ."', async () => {
  const v = { ...vehicle('usedNormal', { features: FEATURES }), descriptionRaw: 'A clean truck that has been well kept by its last owner. It drives smoothly and quietly on the highway.' };
  for (const dealer of [{ name: '', city: '' }, { name: '   ' }, {}]) {
    for (const salesperson of [SAM, { title: 'sales consultant' }]) {
      const r = await generateDescription({ vehicle: v, dealer, salesperson, price: v.price });
      assert.doesNotMatch(r.text, / at \./, 'no empty sign-off');
      assert.equal(r.guardrails.ok, false, JSON.stringify(dealer));
      assert.ok(r.guardrails.problems.some((p) => p.code === 'no-dealer' && p.text === 'No dealership name is set; add it in Settings (Dealership name)'));
    }
  }
  // with the name set, the same car passes
  const named = await generateDescription({ vehicle: v, dealer: EXAMPLE, salesperson: { title: 'sales consultant' }, price: v.price });
  assert.deepEqual(named.guardrails.problems, []);
  assert.match(named.text, /Sales consultant at Example Motors\./);
});

// ---------- the salesperson's role is always stated ----------

test('a description that never gives the salesperson\'s role, or reads as a private sale, fails the checks', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price };
  const text = buildTemplateDescription(c);
  assert.deepEqual(runGuardrails(text, c).problems, []);
  const codes = (t, ctx = c) => runGuardrails(t, ctx).problems.map((p) => p.code);
  // a sign-off without the role, even with the dealership named
  assert.deepEqual(codes(text.replace("I'm Sam, sales consultant at Example Motors.", "I'm Sam at Example Motors.")), ['no-role']);
  assert.equal(runGuardrails(text.replace('sales consultant', 'neighbor'), c).problems[0].text, 'Doesn\'t give your role ("sales consultant"); the sign-off says it');
  // the role set in Settings, any case or spacing; the default when none is set
  const manager = { ...c, salesperson: { name: 'Sam', title: 'Sales  Manager' } };
  assert.deepEqual(codes(buildTemplateDescription(manager), manager), []);
  assert.deepEqual(codes(text, manager), ['no-role'], 'another title is not this salesperson\'s role');
  assert.deepEqual(codes(text, { ...c, salesperson: {} }), [], 'no title set: the default title is the role');
  assert.deepEqual(codes(text, { ...c, salesperson: undefined }), []);
  assert.deepEqual(codes(text, { ...c, salesperson: null }), []);
  // private-sale wording
  assert.ok(codes(`${text}\nPrivate sale.`).includes('banned-phrase'));
  assert.ok(codes(`${text}\nFor sale by owner.`).includes('banned-phrase'));
});
