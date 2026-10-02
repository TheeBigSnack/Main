import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, splitSentences, findBoilerplate, cleanDescription, writeUpParts, openingSegment, endsAtAbbreviation, finishesSentence, isHeading, STARTS_SENTENCE, MIN_BOILERPLATE_COUNT } from '../extension/src/description.js';

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
  assert.deepEqual(cleanDescription(LARAMIE), [LARAMIE_PARAGRAPH, DISCLAIMER]);
});

test('a short real sentence after a Carfax prefix is kept', () => {
  assert.deepEqual(cleanDescription('Recent Arrival! Clean CARFAX. Local trade with new tires and brakes.'), ['Local trade with new tires and brakes.']);
  assert.deepEqual(cleanDescription('CARFAX One-Owner.'), []);
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
    assert.deepEqual(cleanDescription(lot[0], found), [WRITE_UPS[0]], how);
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
});

test('a full stop after an abbreviation does not end a sentence, and a sentence may start after opening punctuation', () => {
  for (const text of ['the original Mfr.', 'Comes with approx.', 'the tow pkg.', 'Ace Auto Inc.', 'Main St.', 'No.', 'Built in the U.S.', 'J.', 'a Jeep Cert.', 'by the Mfg.', 'e.g.']) {
    assert.equal(endsAtAbbreviation(text), true, text);
    assert.equal(finishesSentence(text), false, text);
  }
  // a word with a vowel, a unit after a number, the car's own name in capitals or a word with a digit ends a sentence
  for (const text of ['Local trade.', 'Gets 30 mpg.', 'Makes 395 hp.', 'This Challenger is RWD.', 'A Ram 1500 SLT.', 'It has the 5.7L V8.', 'Ready to go!', 'Is it yours?', 'Call Ace Auto.']) {
    assert.equal(endsAtAbbreviation(text), false, text);
    assert.equal(finishesSentence(text), true, text);
  }
  assert.equal(finishesSentence('Local trade with new brakes'), false);
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

test('a heading is a short line ending in a colon that only names a part of the write-up', () => {
  for (const line of ['Dealer Comments:', 'Vehicle Highlights:', 'About this vehicle:', "Manager's Notes:", 'Features:', 'Description:', 'Please note:']) assert.equal(isHeading(line), true, line);
  for (const line of ['This vehicle does not come with:', 'The previous owner removed the following:', 'Sold without:', 'Not included:', 'Please note, this vehicle is not:', 'Includes:', 'Exclusions:', 'Known issues:', 'Additional charges:', 'Dealer Comments', 'Vehicle Highlights', 'Our dealer comments about this vehicle:']) {
    assert.equal(isHeading(line), false, line);
  }
});

test('each segment of the write-up says whether it starts a sentence on the website, and the opening segment is always the write-up\'s first, past headings', () => {
  const opens = (raw, boilerplate) => writeUpParts(raw, new Set(boilerplate)).map((p) => [p.text, p.opens]);
  // first, after a finished sentence, or after a heading
  assert.deepEqual(opens('Local trade.<br>New brakes.'), [['Local trade.', true], ['New brakes.', true]]);
  assert.deepEqual(opens('Dealer Comments:\nLocal trade.'), [['Dealer Comments:', true], ['Local trade.', true]]);
  // a segment that carries on a sentence the website broke never starts one, whatever it starts with
  assert.deepEqual(opens('Please note this vehicle is not a Jeep<br>Certified Pre-Owned vehicle.'), [['Please note this vehicle is not a Jeep', true], ['Certified Pre-Owned vehicle.', false]]);
  assert.deepEqual(opens('This vehicle does not come with a<br>warranty of any kind.'), [['This vehicle does not come with a', true], ['warranty of any kind.', false]]);
  assert.deepEqual(opens('<p>Vehicle Highlights</p><p>Local trade.</p>'), [['Vehicle Highlights', true], ['Local trade.', false]]);
  // nor does one after a line that ends in a colon but is not a heading, or after an abbreviation
  assert.deepEqual(opens('Sold without:<br>Warranty of any kind.'), [['Sold without:', true], ['Warranty of any kind.', false]]);
  assert.deepEqual(opens('Exclusions:<br>Floor mats.'), [['Exclusions:', true], ['Floor mats.', false]]);
  assert.deepEqual(opens('This one is not covered by the original Mfr.<br>Warranty applies only to new units.'), [['This one is not covered by the original Mfr.', true], ['Warranty applies only to new units.', false]]);
  // judged against the line the website shows right before it, even one the narrative leaves out
  assert.deepEqual(opens('- Heated seats and the<br>Tow package and hitch.'), [['Tow package and hitch.', false]]);
  assert.deepEqual(opens('Local trade.<br>All prices exclude tax and the<br>Documentation fee.', ['All prices exclude tax and the']), [['Local trade.', true], ['Documentation fee.', false]]);
  assert.deepEqual(opens('CARFAX One-Owner.<br>Local trade.'), [['Local trade.', true]]);
  // a segment that starts with an equipment list never starts the write-up line, and its lead stops at a list inside it
  const dump = 'Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package.';
  assert.deepEqual(opens(`${dump} Floor mats.`), [['Floor mats.', false]]);
  assert.deepEqual(writeUpParts(`Local trade. ${dump} Floor mats.`), [{ text: 'Local trade. Floor mats.', opens: true, lead: 'Local trade.' }]);
  // nor does a segment right after a bullet, an award line or an equipment list
  assert.deepEqual(opens(`Not included: ${dump}<br>Floor mats.`), [['Floor mats.', false]]);
  assert.deepEqual(opens('- Not included: floor mats.<br>Spare key.'), [['Spare key.', false]]);
  assert.deepEqual(opens('Awards: Not a 2019 KBB Best Buy.<br>Certified Pre-Owned vehicle.'), [['Certified Pre-Owned vehicle.', false]]);
  // the narrative itself is the same plain strings as before
  assert.deepEqual(cleanDescription('Local trade.<br>New brakes.'), ['Local trade.', 'New brakes.']);

  // the opening segment is the write-up's first, past headings, and only when it starts a sentence
  assert.equal(openingSegment(writeUpParts('Please note this vehicle is not a Jeep<br>Certified Pre-Owned vehicle.')), 'Please note this vehicle is not a Jeep');
  assert.equal(openingSegment(writeUpParts('Dealer Comments:<br>Local trade with new brakes.<br>Price excludes tax.')), 'Local trade with new brakes.');
  assert.equal(openingSegment(writeUpParts('Sold as is. It does not include the Uconnect\nNavigation package.')), 'Sold as is. It does not include the Uconnect');
  assert.equal(openingSegment(writeUpParts('Features:\nHeated Seats\nSunroof')), 'Heated Seats');
  // never a later segment instead of the first
  assert.equal(openingSegment(writeUpParts('This vehicle does not come with:<br>A spare key.<br>Floor mats.')), 'This vehicle does not come with:');
  assert.equal(openingSegment(writeUpParts('Vehicle Highlights<br>Local trade.<br>Clean interior.')), 'Vehicle Highlights');
  assert.equal(openingSegment(writeUpParts('- Heated seats and the<br>Tow package and hitch.')), '');
  assert.equal(openingSegment(writeUpParts(`${dump} Floor mats.<br>Local trade.`)), '');
  // plain strings carry no word on whether they start a sentence, so none does
  assert.equal(openingSegment(['Local trade.']), '');
  assert.equal(openingSegment([]), '');
  assert.equal(openingSegment(undefined), '');
});

test('a lot-wide line after a write-up line that runs on is still found, and the write-up keeps its own words', () => {
  const open = WRITE_UPS.map((car) => car.replace(/\.$/, ''));
  const lot = open.map((car) => `${car}\n${NOTE}`);
  const found = findBoilerplate(lot);
  assert.ok(found.has(NOTE));
  assert.deepEqual(cleanDescription(lot[0], found), [open[0]]);
  // the same when the lot-wide line is wrapped over two lines of its own
  const wrapped = open.map((car) => `${car}\nAll prices exclude tax and the\ndocumentation fee.`);
  assert.deepEqual(cleanDescription(wrapped[0], findBoilerplate(wrapped)), [open[0]]);
});

test('an equipment list or a lot-wide sentence inside a paragraph takes only itself out', () => {
  const dump = 'Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package.';
  assert.deepEqual(cleanDescription(`Local trade with new brakes. ${dump}`), ['Local trade with new brakes.']);
  // a disclaimer full of commas, glued to the write-up, is found as a sentence and the write-up stays
  const legal = 'Price excludes tax, title, license, registration, the documentation fee, dealer add-ons, and finance charges.';
  const lot = WRITE_UPS.map((car) => `${car} ${legal}`);
  assert.deepEqual(cleanDescription(lot[0], findBoilerplate(lot)), [WRITE_UPS[0]]);
  // the floor still holds: on a 2-car lot nothing is lot-wide, sentence or segment
  assert.equal(findBoilerplate(lot.slice(0, 2)).size, 0);
  // a list the website breaks into short "sentences" is a list, however it is cut
  assert.deepEqual(cleanDescription('CARFAX One-Owner. Heated Seats, Navigation, Sunroof. Remote Start, Bluetooth, Backup Camera. Tow Package, Leather, and Alloy Wheels.'), []);
  assert.deepEqual(cleanDescription('Local trade with new brakes. Heated Seats, Navigation, Sunroof.'), ['Local trade with new brakes.']);
  // a sentence that names features among its own words is the write-up
  assert.deepEqual(cleanDescription('It has leather, a sunroof, and navigation.'), ['It has leather, a sunroof, and navigation.']);
  assert.deepEqual(cleanDescription('Comes with Navigation, Heated Seats, Sunroof.'), ['Comes with Navigation, Heated Seats, Sunroof.']);
});

test('non-text input is handled', () => {
  assert.deepEqual(cleanDescription(undefined), []);
  assert.deepEqual(cleanDescription(42), []);
});
