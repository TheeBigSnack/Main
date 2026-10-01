// Checks that the two files the Edge Function shares with the rest of the
// repo are faithful ports: _shared/guardrails.ts against
// extension/src/rewriteTemplate.js (runGuardrails) and
// _shared/rewritePrompt.ts against backend/rewritePrompt.js
// (buildRewritePrompt). Node runs the TypeScript directly:
//
//   node --experimental-strip-types supabase/tests/port-check.mjs
//
// Exits 1 on the first difference. Not part of `npm test` (it needs the
// flag); run it whenever either side changes.

import assert from 'node:assert/strict';
import { runGuardrails as jsGuardrails } from '../../extension/src/rewriteTemplate.js';
import { buildRewritePrompt as jsPrompt } from '../../backend/rewritePrompt.js';
import { runGuardrails as tsGuardrails, BANNED_PHRASES, WORD_LIMITS, CLAIM_KINDS, spelledQuantities as tsSpelled } from '../functions/_shared/guardrails.ts';
import { buildRewritePrompt as tsPrompt, SYSTEM_PROMPT } from '../functions/_shared/rewritePrompt.ts';
import { BANNED_PHRASES as JS_BANNED, WORD_LIMITS as JS_LIMITS, CLAIM_KINDS as JS_CLAIMS, spelledQuantities as jsSpelled } from '../../extension/src/rewriteTemplate.js';
import { SYSTEM_PROMPT as JS_SYSTEM } from '../../backend/rewritePrompt.js';

const vehicle = {
  vin: 'TESTVIN0000000001', year: 2019, make: 'Ram', model: '1500', trim: 'Big Horn', mileage: 41230, stock: 'P1234',
  engine: '5.7L V8', transmission: '8-speed automatic', drivetrain: '4WD', exteriorColor: 'Gray', interiorColor: 'Black',
  bodyType: 'Truck', fuelType: 'Gasoline', price: 28995, priceBeforeFees: 28505,
  features: ['Apple CarPlay', 'Heated seats', 'Backup camera', 'Remote start', 'Bluetooth', 'Towing package'],
  descriptionRaw: 'A well kept truck with 41,230 miles.', carfaxOneOwner: false, carfaxUrl: 'yes',
};
const dealer = { name: 'Example Motors', city: 'Springfield', zip: '00000' };
const sixty = (lead) => `${lead} ` + 'It has heated seats, a backup camera, remote start, Bluetooth and Apple CarPlay. Come see it at Example Motors in Springfield. Message me with any question and I will get right back to you. Test drives are welcome any day of the week, just ask. I am Alex, sales consultant at Example Motors.';

const texts = [
  '',
  'Too short.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles and a 3.92 axle.') + '\nVIN TESTVIN0000000001.',
  sixty('One owner 2019 Ram 1500 Big Horn, no accidents, PRICED TO SELL, best price in town.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, ABSOLUTELY STUNNING TRUCK.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn 🚗🚗🚗🚗🔥.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Price includes the $490 doc fee; tax and tags extra.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Price includes the $490 doc fee; tax and tags extra.'),
  sixty('2019 Ram 1500 Big Horn from a private seller, my truck.') + ' '.repeat(3) + Array(70).fill('word').join(' ') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41230 miles for $28,505.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, was $31,995, now just $28,995 with 38,000 miles! Price reduced.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41K miles, a 3-year/36,000-mile warranty, 30 miles away, $28,995 and $28.5k.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, a private sale.').replace('sales consultant at', 'at') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with only 38,000 original miles. Mileage: 38,000; odometer reads 41,230; 38K on the clock.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Was 31,995, now just 28,995! Internet price: 28,995. Sale price 28995 plus tax, yours for 28.5k.') + '\nVIN TESTVIN0000000001.',
  sixty('Low mileage 2019 Ram 1500 Big Horn, gas mileage of 22 mpg, 2 years or 24,000 miles, 5 miles to empty, range: 290 miles, towing was 7,500 lbs.') + '\nVIN TESTVIN0000000001.',
  sixty('Certified 2019 Ram 1500 Big Horn with a warranty, financing for all credit, a clean Carfax, never smoked in, new tires and brakes, well maintained and runs great.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, like-new with a clean-title, zero accidents, great on gas and priced below market.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with only thirty thousand miles, twenty-five mpg, two owners and five grand off; this one is one careful owner, its sole owner.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, a single-owner truck with new rotors and a fresh inspection.').replace('Example Motors in Springfield', 'Certified Credit Motors in Thousand Oaks') + '\nVIN TESTVIN0000000001.',
];
const contexts = [
  { vehicle, dealer, priceNote: '', price: 28995 },
  { vehicle, dealer, priceNote: 'Price includes the $490 doc fee; tax and tags extra.', price: 28995 },
  { vehicle: { ...vehicle, carfaxOneOwner: true }, dealer, priceNote: 'Price includes the $500 doc fee; tax and tags extra.', price: 28995 },
  { vehicle: { ...vehicle, priceBeforeFees: null }, dealer: {}, priceNote: 'doc fee of $490', price: null },
  { vehicle, dealer, salesperson: { name: 'Alex', title: 'Product  Specialist' }, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, urlConditionWord: 'certified used', descriptionRaw: 'Thirty thousand miles of service records. New tires and brakes, inspected, warranty included, non-smoker.' }, dealer: { name: 'Certified Credit Motors', city: 'Thousand Oaks' }, salesperson: { title: 'finance manager' }, priceNote: 'Financing through the dealership.', price: 28995 },
  { vehicle: { ...vehicle, inventoryType: 'Certified Used', features: ['Clean CARFAX', 'Garage Kept'] }, dealer, priceNote: '', price: 28995 },
  {},
];

let checks = 0;
for (const text of texts) {
  for (const ctx of contexts) {
    assert.deepEqual(JSON.parse(JSON.stringify(tsGuardrails(text, ctx))), JSON.parse(JSON.stringify(jsGuardrails(text, ctx))), `runGuardrails differs for ${JSON.stringify(text.slice(0, 40))}`);
    checks += 1;
  }
}
assert.deepEqual([...BANNED_PHRASES], [...JS_BANNED]);
assert.deepEqual(CLAIM_KINDS.map((k) => [k.what, String(k.re), Boolean(k.part)]), JS_CLAIMS.map((k) => [k.what, String(k.re), Boolean(k.part)]));
for (const text of texts) assert.deepEqual(tsSpelled(text), jsSpelled(text));
assert.deepEqual({ ...WORD_LIMITS }, { ...JS_LIMITS });

const facts = {
  year: 2019, make: 'Ram', model: '1500', trim: 'Big Horn', mileage: 41230, features: ['Heated seats'], carfaxOneOwner: false, carfax: true,
  narrative: ['A well kept truck.'], dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Alex', title: 'sales consultant' }, priceNote: '',
};
for (const f of [facts, { ...facts, salesperson: { name: '', title: '' } }, { ...facts, salesperson: undefined, dealer: undefined }]) {
  for (const fixes of [[], ['"3.92" isn\'t in the website\'s data for this car', 'Says "no accidents"']]) {
    assert.deepEqual(tsPrompt(f, fixes), jsPrompt(f, fixes));
    checks += 1;
  }
}
assert.equal(SYSTEM_PROMPT, JS_SYSTEM);
console.log(`port-check: ${checks} comparisons, both ports match the originals`);
