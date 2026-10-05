import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateDescription, runGuardrails, pickFeatures, numbersIn, wordCount, ensureVinLine, stripVin, WORD_LIMITS } from '../extension/src/rewriteTemplate.js';
import { vehicle } from './helpers.js';
import { assessVehicle, DECISION } from '../extension/src/classify.js';

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

test('a sparse car still reaches the word minimum, with or without the salesperson\'s name or closing line, at a dealership with a short name', () => {
  // nothing but the year, make, model, trim, mileage and VIN: no features, write-up, colours, mechanicals, stock or Carfax
  const full = vehicle('usedNormal');
  const sparse = { vin: full.vin, year: full.year, make: full.make, model: full.model, trim: full.trim, mileage: full.mileage, price: full.price, features: [] };
  const bare = { vin: full.vin, year: full.year, make: full.make, price: full.price };
  for (const v of [sparse, bare]) {
    for (const dealer of [{ name: 'Sample Motors' }, { name: 'Ace' }, { name: 'Sample Motors', city: 'Springfield' }]) {
      for (const salesperson of [{}, { name: 'Pat' }, { name: 'Pat', closingLine: 'Ask for me by name.' }, { closingLine: 'Ask for me by name; I am in Monday to Saturday.' }]) {
        for (const priceNote of ['', 'Tax and tags extra.']) {
          const c = { vehicle: v, dealer, salesperson, priceNote, price: v.price, closingLine: salesperson.closingLine || '' };
          const text = buildTemplateDescription(c);
          const g = runGuardrails(text, c);
          assert.deepEqual(g.problems, [], `${JSON.stringify({ dealer, salesperson, priceNote, bare: v === bare })}\n${text}`);
          if (salesperson.closingLine) assert.ok(text.endsWith(`\n${salesperson.closingLine}`), `the closing line still ends it:\n${text}`);
        }
      }
    }
  }
});

test('the barest car the pre-owned gate lets through reaches the word minimum from its listed facts alone, whatever its write-up says', () => {
  // no year, make, model, VIN, features, colours, mechanicals, stock or Carfax: only what the gate needs
  const bare = { inventoryType: 'Used', urlConditionWord: 'used', mileage: 100, price: 1, photoCount: 1 };
  assert.equal(assessVehicle(bare).decision, DECISION.READY);
  for (const descriptionRaw of ['', 'Local trade with new tires and brakes. Garage kept.']) {
    for (const dealer of [{ name: 'A' }, { name: 'Ace' }]) {
      for (const salesperson of [{}, { name: 'Al' }]) {
        const v = { ...bare, descriptionRaw };
        const c = { vehicle: v, dealer, salesperson, priceNote: '', price: v.price };
        const text = buildTemplateDescription(c);
        const g = runGuardrails(text, c);
        assert.deepEqual(g.problems, [], text);
        assert.ok(g.words >= WORD_LIMITS.min, `${g.words} words:\n${text}`);
        assert.doesNotMatch(text, /Local trade|Garage kept/);
      }
    }
  }
});

test('lots of features are trimmed to the limit, and a wordy write-up adds nothing to it', () => {
  const descriptionRaw =
    'This striking 2016 Dodge Challenger SRT Hellcat delivers premium performance wrapped in sophisticated style, with a supercharged engine that makes every drive an event. ' +
    'Inside, the cabin is comfortable and well appointed with everything you need for a long trip or a quick run into town. ' +
    'It has been well cared for and shows nicely inside and out.';
  const v = { ...vehicle('usedNoCarfax', { features: FEATURES }), descriptionRaw };
  const text = buildTemplateDescription(ctx(v));
  const g = runGuardrails(text, ctx(v));
  assert.deepEqual(g.problems, []);
  assert.ok(g.words <= WORD_LIMITS.max, `${g.words} words`);
});

test('the template never copies the car\'s own description from the website: it writes from the listed facts', () => {
  const v = { ...vehicle('usedNormal', { features: FEATURES.slice(0, 4) }), descriptionRaw: 'Local trade with new tires and brakes.' };
  const text = buildTemplateDescription(ctx(v));
  assert.doesNotMatch(text, /Local trade/);
  assert.equal(text, buildTemplateDescription(ctx({ ...v, descriptionRaw: '' })));
  assert.deepEqual(runGuardrails(text, ctx(v)).problems, []);
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
  assert.equal(runGuardrails(noRole, c).problems[0].text, 'Doesn\'t give your role ("internet sales manager"); the sign-off says it');
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
  assert.deepEqual(g.problems.filter((p) => p.code === 'no-dealer').map((p) => p.text), ['No dealership name is set; add it in Settings (Dealership name)']);
  assert.ok(runGuardrails(text, { ...c, dealer: {} }).problems.some((p) => p.code === 'no-dealer'), 'no dealer at all is the same');
});

test('a plain-English problem list comes back for the side panel', () => {
  const v = vehicle('usedNormal');
  const g = runGuardrails('Nice truck for 9,999.', ctx(v));
  assert.equal(g.ok, false);
  assert.ok(g.problems.every((p) => typeof p.text === 'string' && p.text.length));
});

// ---------- the salesperson's highlights and closing line ----------
import { featureChoices, settleHighlights, checkClosingLine, ensureClosingLine, usableClosingLine, spelledQuantities, MAX_HIGHLIGHTS, CLOSING_LINE_MAX_WORDS } from '../extension/src/rewriteTemplate.js';

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
import { RULE_PROBLEM_CODES, STYLE_PROBLEMS, ruleProblems } from '../extension/src/rewriteTemplate.js';
import { readFileSync } from 'node:fs';

test('every guardrail code is either a posting rule (stops the fill) or a style warning', () => {
  const src = readFileSync(new URL('../extension/src/rewriteTemplate.js', import.meta.url), 'utf8');
  const codes = [...new Set([...src.matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  const WARNINGS = ['too-short', 'too-long', 'all-caps', 'emoji', 'closing-too-long', 'closing-caps', 'closing-emoji'];
  assert.deepEqual([...STYLE_PROBLEMS].sort(), [...WARNINGS].sort(), 'length, capitals and emoji only warn');
  assert.deepEqual(codes, [...RULE_PROBLEM_CODES, ...WARNINGS].sort());
  assert.ok(Object.isFrozen(RULE_PROBLEM_CODES) && Object.isFrozen(STYLE_PROBLEMS));
  // the rules named in the posting rules: the dealership and the role named, facts only, no posing as a private seller, honest prices
  for (const code of ['no-dealer', 'no-role', 'unknown-number', 'one-owner', 'banned-phrase', 'price-note-amount', 'no-vin']) assert.ok(RULE_PROBLEM_CODES.includes(code), code);
  const v = vehicle('usedNormal');
  const g = runGuardrails('MY TRUCK, ONLY $199 A MONTH', { vehicle: v, dealer: { name: 'Example Motors' }, price: v.price });
  assert.deepEqual(ruleProblems(g).map((p) => p.code).sort(), ['banned-phrase', 'no-dealer', 'no-role', 'no-vin', 'price-mismatch', 'unknown-number']);
  assert.ok(g.problems.some((p) => p.code === 'too-short') && !ruleProblems(g).some((p) => p.code === 'too-short'));
  assert.deepEqual(ruleProblems(null), []);
  assert.deepEqual(ruleProblems({ ok: true, problems: [] }), []);
});

// The template writes from the car's listed facts and copies nothing of the
// dealer's own write-up, so a sentence there that a posting rule stops (a
// banned phrase, a one-owner claim the Carfax flag doesn't back) never
// reaches it: a stop on the review screen comes from the person's edit.
test('the write-up sentences the posting rules stop never reach the template, and nothing else of the write-up does either', async () => {
  const plain = { ...vehicle('usedNormal', { features: FEATURES.slice(0, 4) }), carfaxOneOwner: false }; // the flag is read from the raw record, so set on the normalised one
  const cases = [
    ['ONE OWNER, CLEAN TITLE! Priced to sell. Local trade with new tires and brakes.', ['ONE OWNER', 'CLEAN TITLE', 'Priced to sell', 'Local trade with new tires and brakes']],
    ['1-owner vehicle with low miles. Local trade with new tires and brakes.', ['1-owner', 'Local trade with new tires and brakes']],
    ['Selling my truck because I bought another. Local trade with new tires and brakes.', ['Selling my truck', 'Local trade with new tires and brakes']],
    ['One owner! Must sell.', ['One owner!', 'Must sell']],
  ];
  for (const [story, gone] of cases) {
    const car = { ...plain, descriptionRaw: story };
    const r = await generateDescription({ ...ctx(car), boilerplate: [], settings: {} });
    assert.equal(r.source, 'template');
    for (const g of gone) assert.ok(!r.text.includes(g), `"${g}" is left out:\n${r.text}`);
    assert.deepEqual(ruleProblems(runGuardrails(r.text, ctx(car))), [], r.text);
    // the template takes no write-up: one passed in anyway changes nothing
    assert.equal(buildTemplateDescription({ ...ctx(car), narrative: [story], boilerplate: [story] }), buildTemplateDescription(ctx(car)));
  }
  // the Carfax flag set: the one-owner fact is said in the template's own words, never the write-up's
  const owned = { ...plain, carfaxOneOwner: true, descriptionRaw: '1-owner vehicle with low miles.' };
  const text = (await generateDescription({ ...ctx(owned), boilerplate: [], settings: {} })).text;
  assert.doesNotMatch(text, /1-owner vehicle with low miles/);
  assert.match(text, /One owner according to the Carfax report\./);
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

test('the template never copies a write-up with a price or another mileage in it, and still passes its own checks', async () => {
  const v = { ...vehicle('usedNormal'), descriptionRaw: STALE };
  const r = await generateDescription({ vehicle: v, dealer: EXAMPLE, salesperson: SAM, price: 26673 });
  assert.doesNotMatch(r.text, /\$|38,000|now just/);
  assert.doesNotMatch(r.text, /Rides on 20-inch wheels/);
  assert.deepEqual(r.guardrails.problems, []);
  assert.match(r.text, /with 20,986 miles\./);
  // nor the sentences before it
  const before = await generateDescription({ vehicle: { ...v, descriptionRaw: 'Rides on 20-inch wheels with the 8.4-inch touchscreen. Was $31,995, now just $28,995 with 38,000 miles!' }, dealer: EXAMPLE, salesperson: SAM, price: 26673 });
  assert.doesNotMatch(before.text, /Rides on 20-inch wheels/);
  assert.doesNotMatch(before.text, /\$|38,000|now just/);
  assert.deepEqual(before.guardrails.problems, []);
});

test('the template passes its own word count whatever the features and write-up (the VIN line is not counted)', () => {
  const picks = ['Navigation System', 'Heated Seats', 'Backup Camera', 'Bluetooth', 'Apple CarPlay', 'Remote Start'];
  for (let n = 0; n <= picks.length; n += 1) {
    for (const narrative of [[], ['A clean truck.'], ['A clean truck that drives well.'], ['A clean truck that drives well and has been kept up nicely.']]) {
      const v = { ...vehicle('usedNoCarfax', { features: picks.slice(0, n) }), descriptionRaw: narrative.join(' ') }; // the write-up comes from the website's description
      const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price };
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
    // the year's or the model's digits as money, with the word instead of "$"
    'Only 2,019 dollars down.': ['price-mismatch'],
    '1500 dollars off this week.': ['price-mismatch'],
    'Save 1,500 today.': ['price-mismatch'],
    'Savings of 1,500 bucks.': ['price-mismatch'],
  };
  for (const [sentence, codes] of Object.entries(stale)) {
    const got = runGuardrails(`${base}\n${sentence}`, c).problems.map((p) => p.code).filter((code) => /price|mileage/.test(code));
    assert.deepEqual([...new Set(got)].sort(), codes, sentence);
    // the template, given the same sentence in the write-up, copies none of it and still passes
    const r = await generateDescription({ vehicle: { ...v, descriptionRaw: `Rides on 20-inch wheels with the 8.4-inch touchscreen. ${sentence}` }, dealer: EXAMPLE, salesperson: SAM, price: 26673 });
    assert.ok(!r.text.includes(sentence), `the template leaves out: ${sentence}`);
    assert.doesNotMatch(r.text, /Rides on 20-inch wheels/);
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

test('a bare amount from the write-up, with no "$" and no unit, must be the posted price or the website\'s mileage', async () => {
  // the car: 20,986 miles, two prices (27,163 and 26,673), posted at 26,673; its write-up is out of date
  const writeUp = 'Reduced from 31,995 to 28,995. Only 28,995! Miles: 38,000. With 38,000 on it. Tows 7,500 lbs. Call 555-555-0100.';
  const v = { ...vehicle('usedNormal', { features: FEATURES }), descriptionRaw: writeUp };
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: 26673 };
  const base = buildTemplateDescription(c);
  assert.deepEqual(runGuardrails(base, c).problems, [], 'the template passes');
  const codes = (sentence, ctx = c) => [...new Set(runGuardrails(`${base}\n${sentence}`, ctx).problems.map((p) => p.code))].filter((code) => !/^too-/.test(code)).sort();
  const stale = {
    'Reduced from 31,995 to 28,995.': ['price-change', 'unknown-number'],
    'Only 28,995!': ['unknown-number'],
    'Just 28,995 for this one.': ['unknown-number'],
    'Miles: 38,000.': ['mileage-mismatch'],
    'With 38,000 on it.': ['unknown-number'],
    // the car's other price is not the one being posted
    'Only 27,163!': ['unknown-number'],
  };
  for (const [sentence, want] of Object.entries(stale)) assert.deepEqual(codes(sentence), want, sentence);
  assert.ok(runGuardrails(`${base}\nOnly 28,995!`, c).problems.some((p) => p.text === 'Says "28,995", which is neither the price being posted nor the website\'s mileage for this car'));
  assert.ok(runGuardrails(`${base}\nMiles: 38,000.`, c).problems.some((p) => p.text === 'Says 38,000 miles, but the website shows 20,986 miles'));
  // the posted price, the website's mileage, the model, a year, a weight and a phone number are fine
  for (const sentence of ['Only 26,673!', 'With 20,986 on it.', 'A Ram 1500 from 2019.', 'Tows 7,500 lbs.', 'Call 555-555-0100.']) assert.deepEqual(codes(sentence), [], sentence);
  // the rewrite service's own check has no price to compare: a bare amount is flagged, the mileage is not
  assert.deepEqual(codes('Only 26,673!', { ...c, price: null }), ['unknown-number']);
  assert.deepEqual(codes('With 20,986 on it.', { ...c, price: null }), []);
  // a draft that copies the out-of-date write-up falls back to the template
  const on = { myStores: [v.location], rewrite: { enabled: true, endpoint: 'http://localhost:8787/' } }; // the store the website lists the car at is the salesperson's
  const draft = `${base}\nOnly 28,995!`;
  const r = await generateDescription({ ...c, settings: on, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, text: draft }) }) });
  assert.equal(r.source, 'template');
  assert.match(r.note, /Says "28,995", which is neither the price being posted nor the website's mileage/);
});

test('a model year, fuel economy, a warranty, a range or a weight is never read as the mileage or a price', () => {
  for (const words of ['Low mileage 2019 Ram 1500.', 'Great gas mileage of 30 mpg.', 'Fuel mileage: 28 city / 36 highway.', '1 owner low miles.', 'Range: 290 Miles', 'Free Oil Changes 2 Years or 24,000 Miles', '24 months or 24,000 miles of coverage.', '5 Miles to Empty Warning', 'Towing capacity was 7,500 lbs.', 'The price includes 2 keys.', 'It was 2019 when it came in.', 'The Ram 1500 Classic saves fuel.', 'Save time with remote start.']) {
    assert.deepEqual(mileageClaims(words), [], words);
    assert.deepEqual(dollarAmounts(words), [], words);
  }
  assert.deepEqual(mileageClaims('Only 38,000 original miles. Mileage: 38,000 miles. Odometer reads 41,230; 45k on the odo.').map((m) => m.value), [38000, 38000, 41230, 45000]);
  assert.deepEqual(dollarAmounts('Was 31,995, now just $28,995. Internet price: 28,995. Priced at 26,673; yours for 28.5k.').map((a) => a.value), [31995, 28995, 28995, 26673, 28500]);
  assert.deepEqual(dollarAmounts('Only 2,019 dollars down, 1500 bucks off, save 1,500 or save up to 2k.').map((a) => a.value), [2019, 1500, 1500, 2000]);
});

test('an amount said with what money does ("down", "off", "cash back", "rebate"), without "$", is a price the listing must carry', () => {
  // the car is a Ram 1500 from 2019, so "1500" and "2019" are in its data
  const v = vehicle('usedNormal', { features: FEATURES });
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price };
  const base = buildTemplateDescription(c);
  for (const sentence of ['Only 1,500 down.', 'Get 1500 off.', 'Take 1,500 off this week.', 'Only 2,019 down.', '1,500 cash back.', 'A 1,500 rebate on this one.', 'Rebate of 1,500.', 'A down payment of 1,500.', 'Discount of 1500 today.', '1,500 in savings.', '1500 under book.']) {
    assert.deepEqual(dollarAmounts(sentence).length, 1, sentence);
    const codes = runGuardrails(`${base}\n${sentence}`, c).problems.map((p) => p.code).filter((code) => /price|number/.test(code));
    assert.deepEqual(codes, ['price-mismatch'], sentence);
  }
  assert.ok(runGuardrails(`${base}\nGet 1500 off.`, c).problems.some((p) => p.text === `Says $1,500, but this listing's price is $${v.price.toLocaleString('en-US')}`));
  // "off" and "down" that are not money
  for (const words of ['Ram 1500 Off-Road package.', 'A Ram 1500 Off Road.', 'A 1500 off-lease truck.', 'Drive this 1500 off the lot today.', 'Rear seats fold down 60/40.', 'A Ram 1500 Downtown edition.']) {
    assert.deepEqual(dollarAmounts(words), [], words);
  }
});

test('the template never copies a sentence the checks would refuse: a banned phrase, or one owner without the Carfax flag', async () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  for (const sentence of ['Priced for our private sale event this weekend.', 'No accidents and runs perfect!', 'A one-owner truck, traded in here.']) {
    for (const descriptionRaw of [`Rides on 20-inch wheels with the 8.4-inch touchscreen. ${sentence}`, `${sentence} Rides on 20-inch wheels with the 8.4-inch touchscreen.`]) {
      const r = await generateDescription({ vehicle: { ...v, carfaxOneOwner: false, descriptionRaw }, dealer: EXAMPLE, salesperson: SAM, price: v.price });
      assert.ok(!r.text.includes(sentence), `the template leaves out: ${sentence}`);
      assert.doesNotMatch(r.text, /Rides on 20-inch wheels/, sentence);
      assert.deepEqual(r.guardrails.problems, [], sentence);
    }
  }
  // with the Carfax one-owner flag the template says so in its own words, not the website's
  const flagged = await generateDescription({ vehicle: { ...v, carfaxOneOwner: true, descriptionRaw: 'A one-owner truck, traded in here. Rides on 20-inch wheels.' }, dealer: EXAMPLE, salesperson: SAM, price: v.price });
  assert.doesNotMatch(flagged.text, /traded in here/);
  assert.match(flagged.text, /One owner according to the Carfax report\./);
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

test('private-seller wording is refused in the closing line, in the template and in a rewrite-service draft', async () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price };
  const text = buildTemplateDescription(c);
  const posing = [
    'For sale by owner, text me directly.',
    'Sold by owner.',
    'FSBO, text me.',
    'Private party sale, text me.',
    'Not a dealer, just me.',
    'Personal car, not a dealership car.',
    'Selling it myself, text me.',
    'This is my Jeep, I am the owner.',
    "I'm the owner, ask me anything.",
    'I\u2019m the owner, ask me anything.',
    // steering the buyer away from the dealership, or selling for someone else
    'Message me directly, not the dealership.',
    'Deal with me, not through the dealership.',
    'Call me, not the dealer.',
    'Skip the dealership and text me.',
    'Selling this truck for the owner.',
    'Listed on behalf of the owner.',
    'Selling it for a friend, message me.',
    'Reason for selling: I bought a new one.',
    'Come see me, not at the dealership.',
    'Message me instead of the dealership.',
    "Don't call the dealership, text me.",
    'Don\u2019t call the dealer, text me.',
    'Bypass the dealer and message me.',
    'Avoid the dealership, text me.',
    'Selling it for my brother.',
    'Selling it for my neighbor.',
    'Selling for the owners.',
    // the car as the writer's own
    "I've owned this truck since new.",
    'I\u2019ve owned it since new.',
    'I have owned it for years.',
    'This was my own truck.',
    'My Jeep is ready for you.',
    'My van, ready for you.',
    'My vehicle is ready.',
    'This is my own SUV.',
    'My own Jeep, ready to go.',
    'Our family truck for years.',
  ];
  for (const line of posing) {
    assert.ok(checkClosingLine(line).problems.some((p) => p.code === 'closing-banned'), `closing line: ${line}`);
    assert.equal(usableClosingLine(line), '', `never written into a description: ${line}`);
    const withLine = buildTemplateDescription({ ...c, salesperson: { ...SAM, closingLine: line } });
    assert.equal(withLine, text, `the template leaves it out: ${line}`);
    assert.ok(runGuardrails(`${text}\n${line}`, c).problems.some((p) => p.code === 'banned-phrase'), `description: ${line}`);
    const draft = await generateDescription({ ...c, settings: { myStores: [c.vehicle.location], rewrite: { enabled: true, endpoint: 'http://localhost:8787' } }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, text: `${text}\n${line}` }) }) });
    assert.equal(draft.source, 'template', `a draft saying it is refused: ${line}`);
    assert.match(draft.note, /failed a check/);
  }
  // the salesperson's own first-person words still pass
  for (const line of ['Ask for me by name when you come in.', "I'll walk you around it myself.", 'Text me and I will set up a test drive.', 'Ask about our owner loyalty offers.', 'Message me directly and I will get right back to you.', 'Text me directly any time.', 'Ask the dealership for me by name.']) {
    assert.deepEqual(checkClosingLine(line).problems, [], line);
  }
});

// ---------- the dealer's price note is always in the description ----------

test('a description without the dealership\'s price note fails the checks; the template always carries it', () => {
  // the note explains what the posted price leaves out (here the lower second price, before the doc fee)
  const v = vehicle('usedNormal', { features: FEATURES }); // 27163 main, 26673 before fees
  const note = 'Price is before the $490 doc fee; tax and tags extra.';
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: note, price: 26673 };
  const text = buildTemplateDescription(c);
  assert.ok(text.includes(note));
  assert.deepEqual(runGuardrails(text, c).problems, []);
  const dropped = text.replace(`${note}\n`, '') + '\nHappy to answer any question about this truck and set up a time to see it.';
  const g = runGuardrails(dropped, c);
  assert.deepEqual(g.problems.map((p) => p.code), ['no-price-note']);
  assert.equal(g.problems[0].text, "Doesn't include your dealership's price note: \"Price is before the $490 doc fee; tax and tags extra.\"");
  // wrapped over two lines, or in another case, it is still the note
  assert.deepEqual(runGuardrails(text.replace('$490 doc fee;', '$490 doc fee;\n'), c).problems, []);
  assert.deepEqual(runGuardrails(text.replace(note, note.toLowerCase()), c).problems, []);
  // only part of it is not the note
  assert.deepEqual(runGuardrails(text.replace(' tax and tags extra.', ''), c).problems.map((p) => p.code), ['no-price-note']);
  // no note set (or none for this car): nothing to look for
  assert.deepEqual(runGuardrails(dropped, { ...c, priceNote: '' }).problems, []);
  assert.deepEqual(runGuardrails(dropped, { ...c, priceNote: '   ' }).problems, []);
});

test('a banned phrase in the dealership\'s own price note is named as the note\'s, to change in Settings', () => {
  const v = vehicle('usedNormal', { features: FEATURES });
  const note = 'Plus tax, title and registration, which go to the state, not the dealer.';
  const c = { vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: note, price: v.price };
  const text = buildTemplateDescription(c);
  assert.ok(text.includes(note));
  // still refused (the note goes into every description), but no edit or Reset to template can fix it, so the reason says where it can be
  assert.deepEqual(runGuardrails(text, c).problems, [{ code: 'banned-phrase', text: 'Your dealership\'s price note says "not the dealer"; change the note in Settings' }]);
  // the same words in the description itself are the description's
  assert.deepEqual(runGuardrails(`${text}\nText me, not the dealer.`, c).problems.map((p) => p.text), ['Says "not the dealer"']);
  // a note without them: nothing to say
  const fine = { ...c, priceNote: 'Plus tax, title and registration, which go to the state.' };
  assert.deepEqual(runGuardrails(buildTemplateDescription(fine), fine).problems, []);
});

// ---------- claims only the website can make ----------

// A car whose write-up and features say nothing about warranty, financing,
// certification, history, care or new parts; the template for it passes.
const PLAIN = () => ({ ...vehicle('usedNormal', { features: FEATURES }), descriptionRaw: 'Rides on 20-inch wheels with the 8.4-inch touchscreen.', carfaxOneOwner: false, inventoryType: 'Used', readableType: 'Pre-Owned', urlConditionWord: 'used', siteTitle: 'Pre-Owned 2019 Ram 1500 Classic Express' });
const plainCtx = (v = PLAIN(), extra = {}) => ({ vehicle: v, dealer: EXAMPLE, salesperson: SAM, priceNote: '', price: v.price, ...extra });
const codesAfter = (sentence, c = plainCtx()) => {
  const base = buildTemplateDescription(c).replace(/\nMessage me to set up a test drive or ask a question\./, '');
  return [...new Set(runGuardrails(`${base}\n${sentence}`, c).problems.map((p) => p.code))].filter((code) => !/^too-/.test(code)).sort();
};

test('a draft that invents warranty, financing, certification, history, care, new parts or condition fails the checks', () => {
  assert.deepEqual(runGuardrails(buildTemplateDescription(plainCtx()), plainCtx()).problems, [], 'the template passes');
  const invented = {
    'Comes with a warranty and financing for all credit.': ['unsupported-claim'],
    'Certified pre-owned with a fresh inspection.': ['unsupported-claim'],
    'Clean Carfax, never smoked in, new tires and brakes.': ['unsupported-claim'],
    'It has been well maintained and garage kept.': ['unsupported-claim'],
    'Runs great and is in excellent condition.': ['unsupported-claim'],
    'Zero accidents and no accident history.': ['banned-phrase'],
    'Low miles, great on gas, priced below market.': ['banned-phrase'],
    'It is like-new with a clean-title.': ['banned-phrase'],
    'Only thirty thousand miles and gets twenty-five mpg.': ['unknown-number'],
    'Two owners, both local.': ['unknown-number'],
    'One careful owner, only one previous owner.': ['one-owner'],
    'A single-owner truck.': ['one-owner'],
    // who owned it and how it was driven, the keys, records, coverage and detailing
    'It was only driven by a retired teacher on weekends.': ['unsupported-claim'],
    'Owned by a retired teacher and babied by its previous owner.': ['unsupported-claim'],
    'Two previous owners, both local.': ['unsupported-claim'],
    'Mostly highway miles from an adult-owned weekend driver.': ['unsupported-claim'],
    'A local trade from one family.': ['unsupported-claim'],
    'Comes with both keys, a spare fob and all records.': ['unsupported-claim'],
    'Lifetime powertrain coverage included.': ['unsupported-claim'],
    'Freshly detailed and garaged.': ['unsupported-claim'],
    'A retired teacher drove it to church on Sundays.': ['unsupported-claim'],
    'Never driven in winter.': ['unsupported-claim'],
    "It was Grandma's car.": ['unsupported-claim'],
    'Came in on trade from a local customer.': ['unsupported-claim'],
    'A trade-in from a local family.': ['unsupported-claim'],
  };
  for (const [sentence, codes] of Object.entries(invented)) assert.deepEqual(codesAfter(sentence), codes, sentence);
  const c = plainCtx();
  const said = (sentence) => runGuardrails(`${buildTemplateDescription(c)}\n${sentence}`, c).problems.filter((p) => p.code === 'unsupported-claim').map((p) => p.text);
  assert.deepEqual(said('It was only driven by a retired teacher, with both keys.'), [
    'Says "driven by", but the website says nothing about its owners or how it was driven for this car',
    'Says "both keys", but the website says nothing about its keys for this car',
  ]);
  // wording that only sounds like it: the template's own "Pre-owned", a buyer's plans, the keyless entry
  for (const sentence of ['Pre-owned by our standards and ready for you.', 'Ready for weekend trips and highway drives.', 'Keyless entry with the push-button start.', 'Driven by a 5.7L HEMI V8.', 'Driven by the turbocharged engine.', 'Full airbag coverage front and rear.', 'We take trade-ins.']) {
    assert.deepEqual(codesAfter(sentence), [], sentence);
  }
  assert.deepEqual(said('Comes with a warranty and financing for all credit.'), [
    'Says "warranty", but the website says nothing about a warranty or guarantee for this car',
    'Says "financing", but the website says nothing about financing or credit for this car',
  ]);
  assert.deepEqual(said('Clean Carfax, never smoked in, new tires and brakes.'), [
    'Says "Clean Carfax", but the website says nothing about accident, damage or title history for this car',
    'Says "smoked", but the website says nothing about smoking or pets for this car',
    'Says "new tires", but the website says nothing about new or replaced parts for this car',
  ]);
  const thirty = runGuardrails(`${buildTemplateDescription(c)}\nOnly thirty thousand miles.`, c).problems.find((p) => p.code === 'unknown-number');
  assert.equal(thirty.text, '"thirty thousand" isn\'t in the website\'s data for this car');
});

test('a claim the website itself makes passes, and the template built for a car with such a write-up passes its own checks without copying it', async () => {
  const v = { ...PLAIN(), descriptionRaw: 'Local trade with new tires and brakes. Passed our full inspection and comes with the rest of the factory warranty. Non-smoker, garage kept.', features: [...FEATURES, 'Certified Pre-Owned'] };
  const c = plainCtx(v, { priceNote: 'Price requires financing through the dealership.' });
  const r = await generateDescription({ ...c, settings: {} });
  assert.doesNotMatch(r.text, /Local trade/);
  assert.deepEqual(r.guardrails.problems, []);
  for (const sentence of ['New tires and brakes, and it passed a full inspection.', 'The rest of the factory warranty comes with it.', 'Financing through the dealership.', 'A non-smoker, garage kept.', 'Certified pre-owned.']) {
    assert.deepEqual(codesAfter(sentence, c), [], sentence);
  }
  // new brakes in the write-up are not new rotors
  assert.deepEqual(codesAfter('New rotors too.', c), ['unsupported-claim']);
  // who owned it, how it was driven and its keys, when the write-up says so
  const h = { ...PLAIN(), descriptionRaw: 'Driven by its previous owner on mostly highway miles. Comes with both keys and all service records.' };
  const hr = await generateDescription({ ...plainCtx(h), settings: {} });
  assert.doesNotMatch(hr.text, /Driven by/);
  assert.deepEqual(hr.guardrails.problems, []);
  assert.deepEqual(codesAfter('Its previous owner drove it on highway miles, and both keys and the records come with it.', plainCtx(h)), []);
  // one owner on the Carfax report is said by the one-owner check, not refused again as owner history
  const one = plainCtx({ ...PLAIN(), carfaxOneOwner: true });
  for (const sentence of ['Just one previous owner.', 'Owned by one family.', 'Its sole owner.']) assert.deepEqual(codesAfter(sentence, one), [], sentence);
  // a write-up that says where the car came from says nothing about who drove it
  const trade = plainCtx({ ...PLAIN(), descriptionRaw: 'Local trade with the 8.4-inch touchscreen.' });
  assert.deepEqual(codesAfter('A local trade.', trade), []);
  assert.deepEqual(codesAfter('A local trade, driven by a retired teacher.', trade), ['unsupported-claim']);
  // the dealership's "locally owned and operated" is about the business, not the car, and never vouches for an owner story
  assert.deepEqual(codesAfter('We are locally owned and operated.'), []);
  assert.deepEqual(codesAfter('This one was locally owned.'), ['unsupported-claim']);
  const business = plainCtx({ ...PLAIN(), descriptionRaw: 'Rides on 20-inch wheels. We are locally owned and operated.' });
  assert.deepEqual(codesAfter('It was adult owned and driven by a retired teacher.', business), ['unsupported-claim']);
  // spelled-out numbers the website writes the same way, or as digits, are its own
  const w = { ...PLAIN(), descriptionRaw: 'Two sets of keys and twenty-two inch wheels.' };
  assert.deepEqual(codesAfter('Comes with two sets of keys.', plainCtx(w)), []);
  assert.deepEqual(codesAfter('About twenty thousand miles.', plainCtx({ ...PLAIN(), mileage: 20000 })), []);
});

test('one-owner wording on a one-owner car never hides a claim written inside it', () => {
  const one = plainCtx({ ...PLAIN(), carfaxOneOwner: true });
  const said = (sentence, c = one) => runGuardrails(`${buildTemplateDescription(c)}\n${sentence}`, c).problems.filter((p) => p.code === 'unsupported-claim').map((p) => p.text);
  // a claim of another kind between "one" and "owner" is checked as that kind
  const inside = {
    'One non-smoking owner.': 'smoking or pets',
    'One salvage-free owner.': 'accident, damage or title history',
    'One damage-free owner.': 'accident, damage or title history',
    'One well-maintained owner.': 'service history, inspection or upkeep',
    'One dealer-serviced owner.': 'service history, inspection or upkeep',
    'One garage-kept owner.': 'service history, inspection or upkeep',
    'Single pet-free owner.': 'smoking or pets',
  };
  for (const [sentence, what] of Object.entries(inside)) {
    assert.deepEqual(codesAfter(sentence, one), ['unsupported-claim'], sentence);
    assert.deepEqual(said(sentence).map((t) => t.replace(/^Says "[^"]*", but the website says nothing about | for this car$/g, '')), [what], sentence);
  }
  // who the owner was is owner history the Carfax count doesn't give
  for (const sentence of ['One adult owner.', 'One local owner.', 'One retired teacher owner.', 'One careful owner.']) {
    assert.deepEqual(said(sentence), [`Says "${sentence.slice(0, -1)}", but the website says nothing about its owners or how it was driven for this car`], sentence);
  }
  // the count alone, however it is put, is the Carfax flag's
  for (const sentence of ['Just one previous owner.', 'One original owner.', 'One CARFAX owner.', 'A single-owner truck.', 'Owned by one family.', 'Its sole owner.']) {
    assert.deepEqual(codesAfter(sentence, one), [], sentence);
  }
  // without the flag, one owner is refused as before, with what it says inside
  assert.deepEqual(codesAfter('One damage-free owner.'), ['one-owner', 'unsupported-claim']);
  assert.deepEqual(codesAfter('One adult owner.'), ['one-owner']);
  // the write-up that tells the owner's story makes it the website's own, and the template built from it passes its own checks
  const told = plainCtx({ ...PLAIN(), carfaxOneOwner: true, descriptionRaw: 'One adult owner, garage kept and dealer serviced.' });
  assert.deepEqual(runGuardrails(buildTemplateDescription(told), told).problems, []);
  for (const sentence of ['One adult owner.', 'One garage-kept owner.', 'One adult owner, dealer serviced.']) assert.deepEqual(codesAfter(sentence, told), [], sentence);
  assert.deepEqual(codesAfter('One retired teacher owner.', told), ['unsupported-claim']);
});

test('a denial of accidents is banned in any number, and "first owner" is a one-owner claim', () => {
  const v = { ...PLAIN(), descriptionRaw: 'Carfax shows one accident reported.' };
  for (const sentence of ['No accident on record.', 'No reported accidents.', 'It has never had an accident.', 'Never in an accident.']) {
    assert.deepEqual(codesAfter(sentence, plainCtx(v)), ['banned-phrase'], sentence);
  }
  assert.deepEqual(codesAfter('Sold new here to its first owner.'), ['one-owner']);
  assert.deepEqual(codesAfter('Sold new here to its first owner.', plainCtx({ ...PLAIN(), carfaxOneOwner: true })), []);
  // the template never copies such a sentence from the write-up
  const told = plainCtx({ ...PLAIN(), descriptionRaw: 'No accident on record and its first owner kept it garaged.' });
  const text = buildTemplateDescription(told);
  assert.doesNotMatch(text, /accident|first owner/);
  assert.deepEqual(runGuardrails(text, told).problems, []);
});

test('a write-up with markup inside a claim still backs a draft that makes it', async () => {
  const cases = [
    ['Local trade with new <b>tires</b> and brakes. Garage kept.', ['Local trade with new tires and brakes. Garage kept.'], 'Local trade with new tires and brakes, garage kept.'],
    // nothing after a Carfax label is sent, but the checks still read it as the website's words
    ['Clean CARFAX.<br>Runs <strong>great</strong> and drives <em>smooth</em>.', [], 'It runs great and drives smooth.'],
    ['Runs\n  great, with a <span class="x">new\n battery</span>.', ['Runs great, with a new battery.'], 'It runs great, with a new battery.'],
  ];
  for (const [raw, narrative, claim] of cases) {
    const v = { ...PLAIN(), descriptionRaw: raw };
    const r = await generateDescription({ ...plainCtx(v), settings: {} });
    assert.deepEqual(r.narrative, narrative, raw);
    assert.equal(r.text, buildTemplateDescription(plainCtx({ ...v, descriptionRaw: '' })), `the template copies none of it: ${raw}`);
    assert.deepEqual(r.guardrails.problems, [], raw);
    assert.deepEqual(codesAfter(claim, plainCtx(v)), [], claim);
  }
});

test('a write-up in paragraphs backs a claim in its second paragraph, each paragraph read on its own', async () => {
  // "<p>Clean interior</p><p>Runs great...</p>" is two paragraphs, never "Clean interiorRuns great"
  for (const raw of ['<p>Clean interior</p><p>Runs great and drives smooth.</p>', '<div>Clean interior</div><div>Runs great and drives smooth.</div>', '<ul><li>Clean interior</li><li>Runs great and drives smooth.</li></ul>']) {
    const v = { ...PLAIN(), descriptionRaw: raw };
    assert.deepEqual(codesAfter('It runs great.', plainCtx(v)), [], raw);
    const r = await generateDescription({ ...plainCtx(v), settings: {} });
    assert.deepEqual(r.narrative, ['Clean interior', 'Runs great and drives smooth.'], raw);
    assert.deepEqual(r.guardrails.problems, [], raw);
  }
});

test('every claimed part is checked: a part the website names never covers one the text adds', () => {
  const v = { ...PLAIN(), descriptionRaw: 'Local trade with new tires.' };
  const c = plainCtx(v);
  const said = (sentence) => runGuardrails(`${buildTemplateDescription(c)}\n${sentence}`, c).problems.filter((p) => p.code === 'unsupported-claim').map((p) => p.text);
  assert.deepEqual(said('New tires all around.'), []);
  assert.deepEqual(said('Local trade with new tires and new brakes, plus a new battery.'), [
    'Says "new brakes", but the website says nothing about new or replaced parts for this car',
    'Says "new battery", but the website says nothing about new or replaced parts for this car',
  ]);
  // each part once, however often it is said
  assert.deepEqual(said('New brakes, new brakes and new tires.'), ['Says "New brakes", but the website says nothing about new or replaced parts for this car']);
  // with no part in the website's words, each part the text adds is said
  assert.deepEqual(runGuardrails(`${buildTemplateDescription(plainCtx())}\nNew tires and a new battery.`, plainCtx()).problems.filter((p) => p.code === 'unsupported-claim').map((p) => p.text), [
    'Says "New tires", but the website says nothing about new or replaced parts for this car',
    'Says "new battery", but the website says nothing about new or replaced parts for this car',
  ]);
});

test('certified passes when the website lists the car as certified, whatever its write-up says', () => {
  for (const listed of [{ inventoryType: 'Certified Used' }, { readableType: 'Certified Pre-Owned' }, { urlConditionWord: 'certified used' }, { siteTitle: 'Certified Pre-Owned 2019 Ram 1500 Classic Express' }]) {
    assert.deepEqual(codesAfter('Certified pre-owned and ready to go.', plainCtx({ ...PLAIN(), ...listed })), [], JSON.stringify(listed));
  }
  assert.deepEqual(codesAfter('A CPO truck.', plainCtx()), ['unsupported-claim']);
});

test('the dealership\'s name, the salesperson\'s role, the city and the car\'s own colours are not claims', () => {
  const v = { ...PLAIN(), exteriorColor: 'Smoke Gray', interiorColor: 'Black' };
  const c = { vehicle: v, dealer: { name: 'Certified Auto Credit Center', city: 'Thousand Oaks' }, salesperson: { name: 'Sam', title: 'finance manager' }, priceNote: '', price: v.price };
  const text = buildTemplateDescription(c);
  assert.match(text, /Smoke Gray exterior/);
  assert.deepEqual(runGuardrails(text, c).problems, []);
});

test('a website feature with a banned phrase or a one-owner claim is never a highlight, so the template passes', async () => {
  const features = ['Accident Free', 'Clean Title', 'Priced Below Market', 'Like-New Condition', 'CARFAX One-Owner', 'One Owner', 'Heated Seats', 'Backup Camera'];
  const choices = featureChoices(features);
  assert.deepEqual(choices, ['Heated Seats', 'Backup Camera']);
  for (const flag of [false, true]) {
    const v = { ...PLAIN(), features, carfaxOneOwner: flag };
    const r = await generateDescription({ vehicle: v, dealer: EXAMPLE, salesperson: SAM, price: v.price });
    assert.deepEqual(r.guardrails.problems, [], `one-owner flag ${flag}`);
  }
});

test('a number in words passes only as the website says it, unit and all', () => {
  const w = { ...PLAIN(), descriptionRaw: 'Comes with two sets of keys. Twenty-two inch wheels.' };
  assert.deepEqual(codesAfter('Comes with two sets of keys.', plainCtx(w)), []);
  assert.deepEqual(codesAfter('Two owners before this one.', plainCtx(w)), ['unknown-number'], 'the same number word with another unit is not the website\'s');
  assert.deepEqual(codesAfter('Twenty-five grand.', plainCtx()), ['unknown-number']);
  // a "one" in passing, a word that only holds a number word, and inch sizes are not quantities
  assert.deepEqual(codesAfter('This one is ready for someone new, with a phone mount.', plainCtx()), []);
  assert.deepEqual(spelledQuantities('Only thirty thousand miles, twenty-five mpg, two owners, five grand, one owner.').map((q) => [q.said, q.value]), [['thirty thousand miles', 30000], ['twenty-five mpg', 25], ['two owners', 2], ['five grand', 5000]]);
});

// ---------- where the car is ----------

const GROUP = { name: 'Sample Auto Group', city: 'Springfield', zip: '00000' };
const HOME = 'Sample Ford Springfield';
const AWAY = 'Sample Chevrolet Shelbyville';

test('a car the website lists at another store is described at that store, never at the dealership in its town', () => {
  const base = vehicle('usedNormal', { features: FEATURES });
  const at = (location, stores) => {
    const c = { vehicle: { ...base, location }, dealer: GROUP, salesperson: SAM, priceNote: '', price: base.price, stores };
    return { c, text: buildTemplateDescription(c) };
  };
  // no store ticked (every store's cars count), or two: the car's own store, with no town added
  for (const stores of [[], [HOME, AWAY]]) {
    const { c, text } = at(AWAY, stores);
    assert.match(text, /^Pre-owned and on the lot at Sample Chevrolet Shelbyville\.$/m, JSON.stringify(stores));
    assert.doesNotMatch(text, /Springfield/, 'never the dealership\'s town');
    assert.match(text, /I'm Sam, sales consultant at Sample Auto Group\./, 'the dealership is still named, with the role');
    assert.deepEqual(runGuardrails(text, c).problems, []);
  }
  // at the one store ticked, or with no store named by the website: the dealership in its town, as before
  assert.match(at(HOME, [HOME]).text, /^Pre-owned and on the lot at Sample Auto Group in Springfield\.$/m);
  assert.match(at(null, []).text, /^Pre-owned and on the lot at Sample Auto Group in Springfield\.$/m);
  // a store name in capitals, with a number and a word the claim checks read: written calmly, and neither a claim nor an unknown number
  const odd = at('SAMPLE CERTIFIED MOTORS ROUTE 19 GMC', []);
  assert.match(odd.text, /^Pre-owned and on the lot at Sample Certified Motors Route 19 GMC\.$/m);
  assert.deepEqual(runGuardrails(odd.text, odd.c).problems, []);
  // a sparse car at another store still reaches the word minimum
  const sparse = { vin: base.vin, year: base.year, make: base.make, model: base.model, price: base.price, location: AWAY, features: [] };
  const c = { vehicle: sparse, dealer: GROUP, salesperson: { name: 'Pat', closingLine: 'Ask for me by name.' }, priceNote: '', price: base.price, closingLine: 'Ask for me by name.', stores: [] };
  const text = buildTemplateDescription(c);
  assert.match(text, /Come take a look in person at Sample Chevrolet Shelbyville\./, 'the visit line names the car\'s store too');
  assert.deepEqual(runGuardrails(text, c).problems, []);
});

// ---------- the template passes its own checks ----------

import { readFileSync as readFixture, readdirSync as listFixtures } from 'node:fs';
import { fixtures } from './helpers.js';
import { parseVehiclePage } from '../extension/adapters/schemaOrgParse.js';
import { normalizeVehicle as schemaOrgVehicle } from '../extension/adapters/schemaOrgNormalize.js';

// Every car in the fixtures: the real website records and the schema.org pages.
function fixtureCars() {
  const cars = Object.keys(fixtures).filter((n) => n !== '_about').map((n) => [n, vehicle(n)]);
  const dir = new URL('./fixtures/structured/', import.meta.url);
  for (const file of listFixtures(dir).filter((f) => f.endsWith('.html'))) {
    const url = `https://www.sample-motors.test/inventory/${file.replace('.html', '/')}`;
    const { vehicles, facts } = parseVehiclePage(readFixture(new URL(file, dir), 'utf8'), url);
    vehicles.forEach((node, i) => {
      const v = schemaOrgVehicle(node, { url, facts });
      if (v) cars.push([`${file} #${i}`, v]);
    });
  }
  return cars;
}

test('the template passes its own checks for every fixture car, however the website writes', async () => {
  const upper = (s) => (typeof s === 'string' ? s.toUpperCase() : s);
  const variants = {
    'as the website has it': (v) => v,
    'no features': (v) => ({ ...v, features: [] }),
    'in capitals': (v) => ({ ...v, make: upper(v.make), model: upper(v.model), trim: upper(v.trim), engine: upper(v.engine), transmission: upper(v.transmission), exteriorColor: upper(v.exteriorColor), interiorColor: upper(v.interiorColor), features: [...(v.features || []), ...FEATURES].map(upper) }),
    'a write-up the checks refuse': (v) => ({ ...v, carfaxOneOwner: false, descriptionRaw: 'One owner, clean title, no accidents.\nONE OWNER TRADE, SERVICED HERE SINCE NEW.' }),
    'a write-up in capitals and emoji': (v) => ({ ...v, descriptionRaw: '🔥🔥 Hot one! LOCAL TRADE WITH NEW BRAKES AND TIRES. GREAT TRUCK! 😀😀 Room for everyone.' }),
    'abbreviations in capitals': (v) => ({ ...v, trim: 'SLE EXT CAB', interiorColor: 'BLK/GRY', features: [...(v.features || []), 'AWD', 'ABS', 'USB'] }),
    'a heading and wrapped lines': (v) => ({ ...v, descriptionRaw: 'Dealer Comments:\nLocal trade with new\nMichelin tires and fresh brakes.\nFeatures:\nHeated Seats\nSunroof' }),
  };
  const dealers = [{ name: 'Ace Auto', city: 'Troy' }, { name: 'Example Chrysler Dodge Jeep Ram of Springfield', city: 'Springfield' }];
  const people = [{ title: 'sales consultant' }, { name: 'Alexandra', title: 'sales and leasing consultant' }];
  let runs = 0;
  for (const [name, car] of fixtureCars()) {
    for (const [how, change] of Object.entries(variants)) {
      const v = change(car);
      for (const dealer of dealers) for (const salesperson of people) for (const priceNote of ['', 'Price includes the doc fee; tax and tags extra.']) {
        const r = await generateDescription({ vehicle: v, dealer, salesperson, priceNote, price: v.price, settings: {} });
        assert.deepEqual(r.guardrails.problems, [], `${name}, ${how}, ${dealer.name}, ${salesperson.name || 'no name'}, ${priceNote ? 'a price note' : 'no note'}:\n${r.text}`);
        runs += 1;
      }
    }
  }
  assert.ok(runs >= 9 * 5 * 8, `${runs} descriptions`);
});

test('a name in capitals is written calmly in the description only; one that does not shout is left as the website writes it', async () => {
  const v = { ...PLAIN(), year: 2015, make: 'JEEP', model: 'GRAND CHEROKEE', trim: 'LIMITED', features: ['HEATED SEATS', 'NAVIGATION SYSTEM', 'REMOTE START', 'USB PORT'] };
  const r = await generateDescription({ ...plainCtx(v), settings: {} });
  assert.match(r.text, /^2015 Jeep Grand Cherokee Limited with 20,986 miles\.$/m);
  assert.match(r.text, /^Highlights: Navigation System, Heated Seats, Remote Start, USB Port\.$/m);
  assert.deepEqual(r.guardrails.problems, []);
  // the car itself, which fills the form, keeps the website's spelling
  assert.equal(v.model, 'GRAND CHEROKEE');
  // abbreviations, models with digits and a name that does not shout stay as written
  for (const [make, model, trim] of [['GMC', 'SIERRA 1500', 'SLT AWD'], ['TOYOTA', 'RAV4', 'XLE AWD'], ['Ford', 'F-150', 'XLT SuperCrew'], ['Jeep', 'Grand Cherokee', 'SRT']]) {
    const t = buildTemplateDescription({ ...plainCtx({ ...PLAIN(), make, model, trim }) });
    assert.match(t, new RegExp(`^2019 ${make} ${model} ${trim} with`, 'm'), `${make} ${model} ${trim}`);
  }
});

test('the template never copies what the write-up says about fees, taxes, tags, title, registration or licence: the price note says that', async () => {
  // on a lot of one or two cars the lot-wide check finds no disclaimer, and the write-up's own fee line would contradict the note
  const priceNote = 'Price includes the doc fee; tax and tags extra.';
  const FEES = /\b(?:fees?|tax(?:es)?|tags?|doc|documentation|title|licen[cs]e|charges?|processing|registration)\b/gi;
  const story = [
    'Local trade with new brakes.<br>Price does not include dealer documentation fee, tax or tags.',
    'Local trade with new brakes. Price does not include dealer documentation fee, tax or tags.',
    'Local trade with new brakes. Plus doc, title and license.',
    'Local trade with new brakes. Price excludes the dealer documentation charge.',
    'Local trade with new brakes. A processing charge applies.',
    'Dealer Comments:<br>Price does not include dealer documentation fee, tax or tags.',
    'Price excludes taxes and registration. Local trade with new brakes.',
  ];
  for (const raw of story) {
    const v = { ...PLAIN(), descriptionRaw: raw, location: '' };
    const r = await generateDescription({ ...plainCtx(v, { priceNote }), boilerplate: [], settings: {} });
    assert.doesNotMatch(r.text, /Local trade|Dealer Comments/, raw);
    assert.equal(r.text.match(FEES).length, 4, `only the price note speaks of fees: ${raw}`);
    assert.deepEqual(r.guardrails.problems, [], raw);
  }
});

test("the car's own abbreviations are its name, not shouting: the template keeps every line and passes", async () => {
  const cars = {
    'a trim of three-letter words': { make: 'GMC', model: 'SIERRA 2500HD', trim: 'SLE EXT CAB' },
    'a model and trim of abbreviations': { make: 'Mercedes-Benz', model: 'GLE', trim: 'AMG GLE 43 4MATIC' },
    'abbreviations with a hyphen': { make: 'Honda', model: 'CR-V', trim: 'EX-L AWD' },
    'features that are abbreviations': { features: ['AWD', 'ABS', 'USB', 'Heated Seats'] },
    'colours the website abbreviates': { exteriorColor: 'BLK', interiorColor: 'BLK/GRY CLOTH' },
  };
  for (const [what, change] of Object.entries(cars)) {
    const v = { ...PLAIN(), descriptionRaw: 'Local trade with new brakes.', exteriorColor: 'Blue', interiorColor: 'Black', engine: '5.7L V8', location: '', ...change };
    const c = plainCtx(v);
    const r = await generateDescription({ ...c, settings: {} });
    assert.deepEqual(r.guardrails.problems, [], `${what}:\n${r.text}`);
    assert.doesNotMatch(r.text, /Local trade/, what);
    assert.match(r.text, /exterior, .* interior\.$/m, what);
    assert.match(r.text, /^5\.7L V8, 8-Speed Automatic, 4WD\.$/m, what);
    // passing over the car's own words never breaks a run of shouting around them
    assert.ok(runGuardrails(`${r.text}\nGREAT ${v.trim.split(' ')[0].toUpperCase()} TRUCK FOR YOU.`, c).problems.some((p) => p.code === 'all-caps'), what);
  }
  // the car's own abbreviations never make the website's other words count as shouting, so nothing is calmed for them
  const own = { ...PLAIN(), location: '', features: ['AWD', 'ABS', 'USB', 'Heated Seats'], engine: 'HEMI 5.7L V8 DOHC' };
  const kept = buildTemplateDescription(plainCtx(own));
  assert.match(kept, /^HEMI 5\.7L V8 DOHC, 8-Speed Automatic, 4WD\.$/m);
  assert.deepEqual(runGuardrails(kept, plainCtx(own)).problems, []);
  // a longer word in capitals still counts: a draft that copies the website's capitals shouts, and the template writes them calmly
  const v = { ...PLAIN(), location: '', features: ['HEATED FRONT SEATS', 'NAVIGATION SYSTEM', 'AWD'] };
  const t = buildTemplateDescription(plainCtx(v));
  assert.match(t, /Highlights: Navigation System, Heated Front Seats, AWD\./);
  assert.deepEqual(runGuardrails(t, plainCtx(v)).problems, []);
  assert.deepEqual(runGuardrails(t.replace('Navigation System, Heated Front Seats', 'NAVIGATION SYSTEM, HEATED FRONT SEATS'), plainCtx(v)).problems.map((p) => p.code), ['all-caps']);
});

test('a line is left out for shouting only when it shouts itself, and the website\'s words are calmed only when they shout', async () => {
  // a dealership name typed in capitals (Settings) shouts; the website's colours and engine have nothing to do with it and stay as written
  const v = { ...PLAIN(), descriptionRaw: 'Local trade with new brakes.', location: '' };
  const c = plainCtx(v, { dealer: { name: 'ACE AUTO MALL', city: 'Troy' } });
  const r = await generateDescription({ ...c, settings: {} });
  assert.deepEqual(r.guardrails.problems.map((p) => p.code), ['all-caps']);
  assert.doesNotMatch(r.text, /Local trade/);
  assert.match(r.text, /^Blue exterior, Diesel Gray\/Black interior\.$/m);
  assert.match(r.text, /^HEMI 5\.7L V8 Multi Displacement VVT, 8-Speed Automatic, 4WD\.$/m);
  // a write-up that shouts is never copied
  const w = { ...PLAIN(), descriptionRaw: 'Comes with the big SLT TOW. PKG AND more.', location: '' };
  const rw = await generateDescription({ ...plainCtx(w), settings: {} });
  assert.doesNotMatch(rw.text, /TOW/);
  assert.deepEqual(rw.guardrails.problems, []);
  // a trim in capitals that does not shout on its own stays as the website writes it, and the write-up after it is never copied
  const k = { ...PLAIN(), model: 'F-150', make: 'Ford', trim: 'KING RANCH', mileage: null, descriptionRaw: 'BIG truck with the tow package.', location: '' };
  const rk = await generateDescription({ ...plainCtx(k), settings: {} });
  assert.match(rk.text, /^2019 Ford F-150 KING RANCH\.$/m);
  assert.doesNotMatch(rk.text, /BIG truck/);
  assert.deepEqual(rk.guardrails.problems, []);
});
