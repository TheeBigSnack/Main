import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, splitSentences, findBoilerplate, cleanDescription, endsAtAbbreviation, STARTS_SENTENCE, MIN_BOILERPLATE_COUNT, withoutLotWide } from '../extension/src/description.js';

// Text captured from the live Waynesburg site on 2026-09-26 (the equipment
// dump is abridged; the real one runs to 30+ items).
const DISCLAIMER =
  'Ron Lewis Real Price includes all costs to be paid by a consumer except for licensing costs, registration fees and taxes. Documentation fee of $490 is not included. All loans are subject to bank approval.';
const TRX =
  'CARFAX One-Owner. Clean CARFAX. 4 Way Front Headrests, Body Color Door Handles, Bucket Seats, Driver/Passenger Wrapped Assist Handles, Heated Front Seats, Heated Steering Wheel, Leather Trimmed Bucket Seats, Navigation System, Power Sunroof, Premium Sound System, Rear Park Assist System, Remote Start System, Trailer Tow Group, Ventilated Front Seats.<br>Awards: * Motor Trend Automobiles of the Year<br>' +
  DISCLAIMER;
const LARAMIE_PARAGRAPH =
  'This striking 2019 Ram 1500 Laramie delivers premium truck performance wrapped in sophisticated style. With its HEMI 5.7L V8 engine and 4WD capability, this Crew Cab combines power and capability, while the gray exterior and black leather interior create an upscale presence both on and off the road.';
const LARAMIE =
  LARAMIE_PARAGRAPH +
  '<br>- HEMI 5.7L V8 Multi Displacement VVT Engine<br>- 8-Speed Automatic Transmission with 4WD<br>- Leather Trimmed Bucket Seats<br>' +
  DISCLAIMER;

test('segments split on <br> in any spelling, tags stripped, whitespace collapsed', () => {
  assert.deepEqual(splitSegments('one<br>two<BR/>three<br />  four   five <b>six</b>'), ['one', 'two', 'three', 'four five six']);
  assert.deepEqual(splitSegments(''), []);
  assert.deepEqual(splitSegments(null), []);
  assert.deepEqual(splitSegments('<br><br>'), []);
});

test('text on 30% or more of the lot is boilerplate, rarer text is not', () => {
  const lot = [];
  for (let i = 0; i < 12; i += 1) {
    const parts = [`Unique write-up for car ${i}.`];
    if (i < 5) parts.push(DISCLAIMER); // 5 of 12: 42%
    if (i < 3) parts.push('Recent Arrival!'); // 3 of 12: 25%
    lot.push(parts.join('<br>'));
  }
  const b = findBoilerplate(lot);
  assert.ok(b.has(DISCLAIMER));
  assert.ok(!b.has('Recent Arrival!'));
  assert.ok(!b.has('Unique write-up for car 0.'));
  // the threshold can be tuned (the floor of 3 cars is met here)
  assert.ok(findBoilerplate(lot, 0.2).has('Recent Arrival!'));
  assert.equal(findBoilerplate([]).size, 0);
  assert.equal(findBoilerplate(null).size, 0);
});

test('the absolute floor: a share alone never decides on a tiny lot', () => {
  assert.equal(MIN_BOILERPLATE_COUNT, 3);
  // a 3-car lot keeps a sentence one car has, even though 1 of 3 is 33%
  const three = [`Local trade.<br>${DISCLAIMER}`, 'Nice car.', 'Another car.'];
  assert.ok(!findBoilerplate(three).has(DISCLAIMER));
  assert.ok(!findBoilerplate(three).has('Local trade.'));
  // ...but a sentence on all three of them is boilerplate: the floor is a floor, not a ban
  const allThree = three.map((d) => `${d}<br>${DISCLAIMER}`);
  assert.ok(findBoilerplate(allThree).has(DISCLAIMER));
  assert.ok(!findBoilerplate(allThree).has('Nice car.'));
  // a 2-car lot drops nothing, whatever the two share
  const two = [`Nice car.<br>${DISCLAIMER}`, `Another car.<br>${DISCLAIMER}`];
  assert.equal(findBoilerplate(two).size, 0);
  assert.equal(findBoilerplate(two, 0.1).size, 0);
  // a 10-car lot drops a sentence 4 cars share (40%, above the floor)
  const ten = Array.from({ length: 10 }, (_, i) => (i < 4 ? `Car ${i}.<br>${DISCLAIMER}` : `Car ${i}.`));
  assert.ok(findBoilerplate(ten).has(DISCLAIMER));
  // the disclaimer and its own sentences, nothing a car says
  assert.deepEqual([...findBoilerplate(ten)].filter((t) => !DISCLAIMER.includes(t)), []);
  // the floor can be tuned like the share; a floor of 1 is the old share-only rule
  assert.ok(findBoilerplate(three, 0.3, 1).has(DISCLAIMER));
  assert.ok(findBoilerplate(three, 0.3, 1).has('Local trade.'));
});

test('the share is of the whole lot: three pages read out of a 33-car lot make no lot-wide line', () => {
  const SHARED = 'Rebuilt title after hail damage, fully repaired and inspected.';
  const arrivals = [0, 1, 2].map((i) => `Car ${i}.<br>${SHARED}`);
  // only the three new arrivals' pages were read this time; the lot has 33 cars
  assert.ok(!findBoilerplate(arrivals, 0.3, MIN_BOILERPLATE_COUNT, 33).has(SHARED), '3 of 33 is 9%');
  // the same three pages in a 9-car lot are a third of it
  assert.ok(findBoilerplate(arrivals, 0.3, MIN_BOILERPLATE_COUNT, 9).has(SHARED));
  // a lot size under the pages read changes nothing (every page read is the lot)
  assert.ok(findBoilerplate(arrivals, 0.3, MIN_BOILERPLATE_COUNT, 1).has(SHARED));
  assert.ok(findBoilerplate(arrivals).has(SHARED), 'without a lot size the pages read are the lot');
});

test('a segment counts once per car even if the site repeats it', () => {
  const lot = [`${DISCLAIMER}<br>${DISCLAIMER}`, 'Nice car.', 'Another car.', 'Yet another.'];
  assert.ok(!findBoilerplate(lot).has(DISCLAIMER)); // 1 of 4 = 25%
});

test('the TRX (no write-up) has nothing usable: Carfax prefix, equipment dump, awards and disclaimer all go', () => {
  const boilerplate = new Set([DISCLAIMER]);
  assert.deepEqual(cleanDescription(TRX, boilerplate), []);
});

test('the Laramie keeps only its narrative paragraph, not the bullets or the disclaimer', () => {
  const boilerplate = new Set([DISCLAIMER]);
  assert.deepEqual(cleanDescription(LARAMIE, boilerplate), [LARAMIE_PARAGRAPH]);
});

test('without a boilerplate set the disclaimer would survive, so the scan must supply one', () => {
  // the bullets go as the website wrote them
  assert.deepEqual(cleanDescription(LARAMIE), [LARAMIE_PARAGRAPH, '- HEMI 5.7L V8 Multi Displacement VVT Engine', '- 8-Speed Automatic Transmission with 4WD', '- Leather Trimmed Bucket Seats', DISCLAIMER]);
});

test('a line that starts with a Carfax or arrival label is left out whole, never trimmed, and nothing after it is sent', () => {
  for (const raw of [
    'CARFAX One-Owner.',
    'Recent Arrival! Clean CARFAX. Local trade with new tires and brakes.',
    // a sentence that only starts with those words would say the opposite without them
    'Clean CARFAX Not Available On This Unit. Local trade.',
    'Clean Carfax except one reported accident.',
    'Clean CARFAX. Not available on this unit.',
    // nor is the line after it, which may carry it on or take it back
    'Recent Arrival! Clean CARFAX.\nExcept the accident in 2021.',
    'Clean CARFAX.<br>Not available for this unit.',
    'CARFAX One-Owner.\nStatus unverified.',
    'Recent Arrival!\nClean CARFAX except one reported accident.',
    'CARFAX One-Owner.<br>Local trade.',
    // in any case, with any punctuation
    '*** RECENT ARRIVAL ***<br>Local trade.',
    '"Clean Carfax" except one reported accident.',
    'carfax one owner, status not verified',
  ]) assert.deepEqual(cleanDescription(raw), [], raw);
  // a label inside a line stays as the website wrote it; one on a later line ends what is sent
  assert.deepEqual(cleanDescription('Local trade. Clean CARFAX. Not available on this unit.'), ['Local trade. Clean CARFAX. Not available on this unit.']);
  assert.deepEqual(cleanDescription('Local trade with new brakes.<br>CARFAX One-Owner.<br>Heated seats.'), ['Local trade with new brakes.']);
});

// A lot-wide line written the ways other websites write it: on a line of its
// own in plain text (a schema.org or inventory-feed description), in its own
// paragraph, or run on from the car's own write-up with no break at all.
const NOTE = 'All prices exclude tax and the documentation fee.';
const WRITE_UPS = ['Local trade with new brakes.', 'Sharp truck with the towing package.', 'Low miles and a fresh detail.', 'Leather seats and a sunroof.', 'Room for the whole family.'];

test('a lot-wide line is found however the website separates it from the write-up', () => {
  for (const [how, join] of [
    ['a line break in the text', (car) => `${car}\n${NOTE}`],
    ['a blank line', (car) => `${NOTE}\r\n\r\n${car}`],
    ['paragraphs', (car) => `<p>${car}</p><p>${NOTE}</p>`],
    ['divisions', (car) => `<div>${car}</div>\n<div class="legal">${NOTE}</div>`],
    ['list items', (car) => `<ul><li>${car}</li><li>${NOTE}</li></ul>`],
    ['no break at all', (car) => `${car} ${NOTE}`],
    ['a <br>', (car) => `${car}<br>${NOTE}`],
  ]) {
    const lot = WRITE_UPS.map(join);
    const found = findBoilerplate(lot);
    assert.ok(found.has(NOTE), how);
    assert.ok(WRITE_UPS.every((car) => !found.has(car)), how);
    // the narrative never sends it; the car's own line goes when it comes first, on its own
    const narrative = cleanDescription(lot[0], found);
    assert.ok(narrative.every((text) => !text.includes(NOTE)), how);
    assert.deepEqual(narrative, ['a blank line', 'no break at all'].includes(how) ? [] : [WRITE_UPS[0]], how);
  }
});

test('paragraphs and wrapped lines are read as the website shows them', () => {
  // a paragraph break never glues two sentences into one word
  assert.deepEqual(splitSegments('<p>New brakes.</p><p>All set.</p>'), ['New brakes.', 'All set.']);
  assert.deepEqual(splitSegments('Line one of the write-up.\nLine two.'), ['Line one of the write-up.', 'Line two.']);
  // a line that only wraps a sentence joins the line before it again
  assert.deepEqual(splitSegments('Local trade with new\nbrakes and tires.\n- Heated seats'), ['Local trade with new brakes and tires.', '- Heated seats']);
});

test('a line that stops on a word in lower case, a comma or a dash joins the next, whatever the next line starts with; a heading that ends in a colon or a capitalised word keeps its own line', () => {
  // the line before stops mid-sentence: on a word in lower case, a comma or a dash
  assert.deepEqual(splitSegments('Local trade with new\nMichelin tires and fresh brakes.'), ['Local trade with new Michelin tires and fresh brakes.']);
  assert.deepEqual(splitSegments('This SUV comes with the\n3.6L V6 and a tow package.'), ['This SUV comes with the 3.6L V6 and a tow package.']);
  assert.deepEqual(splitSegments('Comes with heated seats,\nNavigation and a sunroof.'), ['Comes with heated seats, Navigation and a sunroof.']);
  // a heading, a title or a finished sentence ends its line
  assert.deepEqual(splitSegments('Dealer Comments:\nLocal trade with new brakes and tires.'), ['Dealer Comments:', 'Local trade with new brakes and tires.']);
  assert.deepEqual(splitSegments('Vehicle Highlights\nLocal trade with new brakes and tires.'), ['Vehicle Highlights', 'Local trade with new brakes and tires.']);
  assert.deepEqual(splitSegments('2019 Jeep Grand Cherokee Limited\nLocal trade.'), ['2019 Jeep Grand Cherokee Limited', 'Local trade.']);
  // a heading with no colon that stops on a word in lower case reads as the start of the next line's sentence
  assert.deepEqual(splitSegments('Dealer comments\nLocal trade with new brakes and tires.'), ['Dealer comments Local trade with new brakes and tires.']);
  // a list item is never joined to the line before it
  assert.deepEqual(splitSegments('Great truck with\n- Heated seats'), ['Great truck with', '- Heated seats']);
  // a line that ends on a closing bracket or quote ends there
  assert.deepEqual(splitSegments('Comes with [Tech Package]\nLocal trade.'), ['Comes with [Tech Package]', 'Local trade.']);
  assert.deepEqual(splitSegments('Comes with the \u2018Tech\u2019\nLocal trade.'), ['Comes with the \u2018Tech\u2019', 'Local trade.']);
});

test('for finding lot-wide text, a full stop after an abbreviation does not end a sentence, and a sentence may start after opening punctuation', () => {
  for (const text of ['the original Mfr.', 'Comes with approx.', 'the tow pkg.', 'Ace Auto Inc.', 'Main St.', 'No.', 'Built in the U.S.', 'J.', 'a Jeep Cert.', 'by the Mfg.', 'e.g.']) {
    assert.equal(endsAtAbbreviation(text), true, text);
  }
  // a word with a vowel, a unit after a number, a word in capitals or a word with a digit ends a sentence, so a
  // disclaimer that ends on one ("by a certified tech.", "etc.") is a sentence of its own
  for (const text of ['Local trade.', 'Gets 30 mpg.', 'Makes 395 hp.', 'This Challenger is RWD.', 'A Ram 1500 SLT.', 'It has the 5.7L V8.', 'Ready to go!', 'Is it yours?', 'Call Ace Auto.', 'Local trade with new brakes', 'All vehicles inspected by a certified tech.', 'Price excludes tax, title, license, etc.', 'Serving drivers all over Southern CA.']) {
    assert.equal(endsAtAbbreviation(text), false, text);
  }
  assert.deepEqual(splitSentences('All vehicles inspected by a certified tech. This Jeep has new brakes.'), ['All vehicles inspected by a certified tech.', 'This Jeep has new brakes.']);
  // so a sentence stays whole across an abbreviation, and before a piece in lower case
  assert.deepEqual(splitSentences('This one is past the original Mfr. Warranty coverage. Local trade.'), ['This one is past the original Mfr. Warranty coverage.', 'Local trade.']);
  assert.deepEqual(splitSentences('Comes with approx. Two keys. Local trade.'), ['Comes with approx. Two keys.', 'Local trade.']);
  assert.deepEqual(splitSentences('Comes with the tow pkg. and a bed liner. Clean interior.'), ['Comes with the tow pkg. and a bed liner.', 'Clean interior.']);
  // a plain line break after an abbreviation wraps the sentence
  assert.deepEqual(splitSegments('Comes with approx.\ntwo keys and a spare tire.'), ['Comes with approx. two keys and a spare tire.']);
  assert.deepEqual(splitSegments('Not covered by the original mfr.\nWarranty applies only to new units.'), ['Not covered by the original mfr. Warranty applies only to new units.']);
  // opening punctuation, Spanish marks included, comes before the capital letter
  for (const text of ['\u00a1Camioneta local con frenos nuevos!', '\u00bfBusca una camioneta?', '(Local trade.)', '\u201cLocal trade.\u201d', '\u00abLocal trade.\u00bb']) assert.ok(STARTS_SENTENCE.test(text), text);
  assert.ok(!STARTS_SENTENCE.test('\u00a1camioneta local!'));
});

test('the narrative is the write-up\'s segments as the website wrote them, from its first, up to the first one it leaves out', () => {
  const dump = 'Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package.';
  assert.deepEqual(cleanDescription('Local trade.<br>New brakes.'), ['Local trade.', 'New brakes.']);
  // headings and bullets go as written: a bullet can be what qualifies the line before it
  assert.deepEqual(cleanDescription('Dealer Comments:<br>Local trade.<br>- Heated seats<br>- Navigation'), ['Dealer Comments:', 'Local trade.', '- Heated seats', '- Navigation']);
  assert.deepEqual(cleanDescription('This truck has the factory warranty.\n- Except the engine.'), ['This truck has the factory warranty.', '- Except the engine.']);
  // an award line, a label, a list or text the lot shares ends it: nothing after is sent, since it may carry that on
  assert.deepEqual(cleanDescription('Local trade.<br>Awards: Best Buy<br>New brakes.'), ['Local trade.']);
  assert.deepEqual(cleanDescription(`Local trade.<br>${dump}<br>Floor mats not included.`), ['Local trade.']);
  assert.deepEqual(cleanDescription('Local trade.<br>All prices exclude tax.<br>New brakes.', new Set(['All prices exclude tax.'])), ['Local trade.']);
  // and the line before it goes too when it may run on into it: it does not end a sentence, or what is left out
  // does not start one
  assert.deepEqual(cleanDescription('Comes with the factory warranty<br>Awards: Best Buy'), []);
  assert.deepEqual(cleanDescription('Comes with the factory warranty.<br>clean carfax, except the accident'), []);
  assert.deepEqual(cleanDescription('- Heated seats<br>Awards: Best Buy<br>CARFAX One-Owner.<br>Local trade.'), []);
  assert.deepEqual(cleanDescription('Local trade.<br>Dealer Comments:<br>Awards: Best Buy'), ['Local trade.']);
  assert.deepEqual(cleanDescription('Local trade.<br>Great truck and the<br>Awards: Best Buy'), ['Local trade.']);
});

test('a lot-wide line after a line of the write-up that runs on is still found, and that line is never sent without it', () => {
  const open = WRITE_UPS.map((car) => car.replace(/\.$/, ''));
  const lot = open.map((car) => `${car}\n${NOTE}`);
  const found = findBoilerplate(lot);
  assert.ok(found.has(NOTE));
  assert.deepEqual(cleanDescription(lot[0], found), []);
  // the same when the lot-wide line is wrapped over two lines of its own
  const wrapped = open.map((car) => `${car}\nAll prices exclude tax and the\ndocumentation fee.`);
  assert.ok(findBoilerplate(wrapped).has('documentation fee.'));
  assert.deepEqual(cleanDescription(wrapped[0], findBoilerplate(wrapped)), []);
  // a line of the write-up that ends its sentence goes
  const closed = WRITE_UPS.map((car) => `${car}\nAll prices exclude tax and the\ndocumentation fee.`);
  assert.deepEqual(cleanDescription(closed[0], findBoilerplate(closed)), [WRITE_UPS[0]]);
});

test('a paragraph with an equipment list or a lot-wide sentence inside it is left out whole, never trimmed', () => {
  const dump = 'Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package.';
  assert.deepEqual(cleanDescription(`Local trade with new brakes. ${dump}`), []);
  assert.deepEqual(cleanDescription(`Local trade. ${dump} Floor mats.`), []);
  // the list taken out could hold what the sentence before it means: "everything exc." + "Engine, Transmission, ..."
  assert.deepEqual(cleanDescription('Warranty covers everything exc. Engine, Transmission, Turbo, Seals, Gaskets, Hoses, Belts.'), []);
  // a disclaimer full of commas, glued to the write-up, is found as a sentence, and the paragraph is not sent
  const legal = 'Price excludes tax, title, license, registration, the documentation fee, dealer add-ons, and finance charges.';
  const lot = WRITE_UPS.map((car) => `${car} ${legal}`);
  assert.ok(findBoilerplate(lot).has(legal));
  assert.deepEqual(cleanDescription(lot[0], findBoilerplate(lot)), []);
  // the floor still holds: on a 2-car lot nothing is lot-wide, sentence or segment
  assert.equal(findBoilerplate(lot.slice(0, 2)).size, 0);
  // a lot-wide head of a sentence each car finishes its own way is never sent without it, on one line or across one
  const head = ['Escape', 'Edge', 'Explorer', 'Bronco'];
  for (const join of [' ', '<br>', '\n']) {
    const cars = head.map((m) => `This vehicle is not a Ford Auth.${join}Certified Pre-Owned ${m} with new brakes.`);
    const found = findBoilerplate(cars);
    assert.ok(found.has('This vehicle is not a Ford Auth.'), JSON.stringify(join));
    assert.deepEqual(cleanDescription(cars[0], found), [], JSON.stringify(join));
  }
  // a list the website breaks into short "sentences" is a list, however it is cut
  assert.deepEqual(cleanDescription('CARFAX One-Owner. Heated Seats, Navigation, Sunroof. Remote Start, Bluetooth, Backup Camera. Tow Package, Leather, and Alloy Wheels.'), []);
  assert.deepEqual(cleanDescription('Local trade with new brakes. Heated Seats, Navigation, Sunroof.'), []);
  assert.deepEqual(cleanDescription('Local trade with new brakes.<br>Heated Seats, Navigation, Sunroof.'), ['Local trade with new brakes.']);
  // a sentence that names features among its own words is the write-up
  assert.deepEqual(cleanDescription('It has leather, a sunroof, and navigation.'), ['It has leather, a sunroof, and navigation.']);
  assert.deepEqual(cleanDescription('Comes with Navigation, Heated Seats, Sunroof.'), ['Comes with Navigation, Heated Seats, Sunroof.']);
});

test('text the lot shares that ends on a word such as "tech." or "etc." is found as a sentence of its own, and never sent', () => {
  const own = ['This Jeep has new brakes.', 'Local trade with new tires.', 'Freshly detailed inside and out.', 'It came to us on trade.', 'The paint still shines.'];
  for (const disclaimer of ['All vehicles inspected by a certified tech.', 'All prices exclude tax and the $699 documentary fee, etc.', 'Price excludes tax, title, license, etc.', 'Serving drivers all over Southern CA.']) {
    const lot = own.map((car) => `${disclaimer} ${car}`);
    const found = findBoilerplate(lot);
    assert.ok(found.has(disclaimer), disclaimer);
    assert.ok(own.every((car) => !found.has(car)), disclaimer);
    assert.deepEqual(cleanDescription(lot[0], found), [], disclaimer);
  }
  // a disclaimer glued after a car's sentence that ends in "etc." is found too, and the paragraph is not sent with it
  const D = 'All prices exclude tax and the $699 documentary fee.';
  const lot = [`Comes with heated seats, remote start, nav, etc. ${D}`, ...own.slice(1).map((car) => `${car} ${D}`)];
  const found = findBoilerplate(lot);
  assert.ok(found.has(D));
  assert.ok(!found.has('Comes with heated seats, remote start, nav, etc.'));
  assert.deepEqual(cleanDescription(lot[0], found), []);
  assert.deepEqual(cleanDescription(lot[1], found), []);
  // and a line that runs on into lot-wide text after an abbreviation ("No.") is left out with it
  const E = 'All prices exclude tax and the $699 documentary fee, etc.';
  const etcLot = own.map((car) => `${car}<br>${E}`);
  const etcFound = findBoilerplate(etcLot);
  assert.ok(etcFound.has(E));
  assert.deepEqual(cleanDescription(`This Jeep comes fully loaded.<br>Smoker? No. ${E}<br>Only 38,000 original miles.`, etcFound), ['This Jeep comes fully loaded.']);
});

test('the lines are read as the page shows them: entities decoded, invisible format characters dropped', () => {
  assert.deepEqual(splitSegments('Runs and drives great.<br>&nbsp;except for the transmission, which slips.'), ['Runs and drives great.', 'except for the transmission, which slips.']);
  assert.deepEqual(splitSegments('Runs and drives great.<br>\u200bexcept for the transmission.<br>\u2060Local trade.'), ['Runs and drives great.', 'except for the transmission.', 'Local trade.']);
  assert.deepEqual(splitSegments('Navi\u00adgation &amp; heated seats &#8211; it&#x2019;s &quot;loaded&quot;&hellip; &bogus;'), ['Navigation & heated seats \u2013 it\u2019s "loaded"\u2026 &bogus;']);
  assert.deepEqual(splitSegments('\ufeff&nbsp;Local trade.'), ['Local trade.']);
  // so a lot-wide line is the same line however the website spaces it
  const lot = WRITE_UPS.map((car, i) => `${car}<br>${i % 2 ? 'All prices exclude&nbsp;tax.' : 'All prices exclude tax.'}`);
  const found = findBoilerplate(lot);
  assert.ok(found.has('All prices exclude tax.'));
  assert.deepEqual(cleanDescription(lot[1], found), [WRITE_UPS[1]]);
});

test('non-text input is handled', () => {
  assert.deepEqual(cleanDescription(undefined), []);
  assert.deepEqual(cleanDescription(42), []);
});

test('the write-up without its lot-wide text: each line the scan found is cut out wherever it stands, and a segment left empty goes', () => {
  const lot = ['All loans are subject to bank approval.', 'We are a locally owned dealership.'];
  assert.deepEqual(withoutLotWide('Local trade with new tires. All loans are subject to bank approval.<br>We are a locally owned dealership.', lot), ['Local trade with new tires.']);
  // inside a segment, between other sentences, and more than once
  assert.deepEqual(withoutLotWide('One owner. We are a locally owned dealership. Runs great. We are a locally owned dealership.', lot), ['One owner. Runs great.']);
  // only where it stands between spaces: a line that is part of a longer word is not cut
  assert.deepEqual(withoutLotWide('Xall loans are subject to bank approval.', ['all loans are subject to bank approval.']), ['Xall loans are subject to bank approval.']);
  // the longest line first, so a shorter one inside it never leaves half of it behind
  assert.deepEqual(withoutLotWide('Financing for all credit types. Runs great.', ['Financing for all credit types.', 'all credit types.']), ['Runs great.']);
  // with no lot-wide text known, the segments as splitSegments gives them
  assert.deepEqual(withoutLotWide('Runs great.<br>Clean inside.'), ['Runs great.', 'Clean inside.']);
  assert.deepEqual(withoutLotWide('Runs great.', new Set(['', '  ', null])), ['Runs great.']);
  assert.deepEqual(withoutLotWide(null, lot), []);
});

// Characters that can't be seen in an editor (zero-width spaces and joiners,
// variation selectors, soft hyphens, non-breaking and other odd spaces) are
// written as \u escapes in the code, so a regular expression or a table that
// holds one can be read, and isn't changed by accident when the line is
// edited. STARTS_SENTENCE's emoji joiners and the entity table's spaces once
// slipped in as the characters themselves.
test('the code writes invisible and space-like characters as \\u escapes, never as the characters', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = join(dir, name);
      if (name === 'node_modules') continue;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(?:js|mjs|ts)$/.test(name)) files.push(rel);
    }
  };
  for (const dir of ['extension', 'backend', 'supabase/functions']) walk(dir);
  assert.ok(files.includes(join('extension', 'src', 'description.js')));
  const hidden = /[\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufe00-\ufe0f]/u;
  const found = [];
  for (const rel of files) {
    readFileSync(join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(hidden);
      if (m) found.push(`${rel}:${i + 1} U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    });
  }
  assert.deepEqual(found, []);
});

// A scan from before the lines were read with their entities decoded saved
// the lot-wide lines as the website wrote them ("Tax, title &amp; tags
// extra."), and a scan that does not read every description keeps them
// (scanRunner.js). They are read the way the description's lines are, so
// they still match, the disclaimer is not sent to the rewrite service, and
// it backs no claim.
test('lot-wide lines saved by an earlier scan with the entities as written still match the lines as they read now', async () => {
  const { runGuardrails } = await import('../extension/src/rewriteTemplate.js');
  const saved = 'Every vehicle comes with a warranty &amp; roadside help. Tax &amp; tags extra.';
  const raw = `Runs great.<br>${saved}`;
  assert.deepEqual(cleanDescription(raw, new Set([saved])), ['Runs great.']);
  assert.deepEqual(cleanDescription(raw, [saved]), ['Runs great.'], 'a list as storage keeps it');
  assert.deepEqual(withoutLotWide(raw, [saved]), ['Runs great.']);
  assert.deepEqual(cleanDescription(raw, new Set(['Every vehicle comes with a warranty & roadside help. Tax & tags extra.'])), ['Runs great.'], 'as a scan saves it now');
  assert.deepEqual(cleanDescription(`Runs great.<br>Tax &amp; tags extra.`, new Set(['Tax &amp; tags extra.'])), ['Runs great.'], 'a sentence of it too');
  const v = { year: 2019, make: 'Ram', model: '1500', descriptionRaw: raw, features: [] };
  const claim = runGuardrails('It comes with a warranty.', { vehicle: v, boilerplate: [saved] }).problems.filter((p) => p.code === 'unsupported-claim');
  assert.equal(claim.length, 1, 'the lot-wide warranty line backs no claim about this car');
});

// The narrative stops before the first line left out, and the line before it
// goes too when it may run on into it: a full stop after an abbreviation
// ("the original Mfr.", "approx.") ends no sentence.
test('a line that stops on an abbreviation is never sent without the line left out after it', () => {
  const terms = 'Warranty: see the terms every car on the lot shares.';
  assert.deepEqual(cleanDescription(`Runs great.<br>Covered by the rest of the original Mfr.<p>${terms}</p>`, new Set([terms])), ['Runs great.']);
  assert.deepEqual(cleanDescription('Runs great.<br>Comes with approx.<br>Clean CARFAX. Except the accident in 2021.'), ['Runs great.']);
  assert.deepEqual(cleanDescription('Runs great.<br>Tow pkg. incl.<br>Recent Arrival!'), ['Runs great.']);
  // a line that ends a sentence still goes, a unit after a number included
  assert.deepEqual(cleanDescription('Runs great.<br>Clean CARFAX.'), ['Runs great.']);
  assert.deepEqual(cleanDescription('Rated 30 mpg.<br>Clean CARFAX.'), ['Rated 30 mpg.']);
});
