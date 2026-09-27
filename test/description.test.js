import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, findBoilerplate, cleanDescription } from '../extension/src/description.js';

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
  for (let i = 0; i < 10; i += 1) {
    const parts = [`Unique write-up for car ${i}.`];
    if (i < 4) parts.push(DISCLAIMER); // 40%
    if (i < 2) parts.push('Recent Arrival!'); // 20%
    lot.push(parts.join('<br>'));
  }
  const b = findBoilerplate(lot);
  assert.ok(b.has(DISCLAIMER));
  assert.ok(!b.has('Recent Arrival!'));
  assert.ok(!b.has('Unique write-up for car 0.'));
  // the threshold can be tuned
  assert.ok(findBoilerplate(lot, 0.2).has('Recent Arrival!'));
  assert.equal(findBoilerplate([]).size, 0);
  assert.equal(findBoilerplate(null).size, 0);
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

test('non-text input is handled', () => {
  assert.deepEqual(cleanDescription(undefined), []);
  assert.deepEqual(cleanDescription(42), []);
});
