// Checks that the two files the Edge Function shares with the rest of the
// repo are faithful ports: _shared/guardrails.ts against
// extension/src/rewriteTemplate.js (runGuardrails) and
// _shared/rewritePrompt.ts against backend/rewritePrompt.js
// (buildRewritePrompt). Node 22.18 or later runs the TypeScript directly,
// with no flag:
//
//   node supabase/tests/port-check.mjs
//
// Throws (and exits 1) on the first difference. `npm test` runs it through
// test/portCheck.test.js, so CI fails when either side changes alone.

import assert from 'node:assert/strict';
import { runGuardrails as jsGuardrails } from '../../extension/src/rewriteTemplate.js';
import { buildRewritePrompt as jsPrompt } from '../../backend/rewritePrompt.js';
import { runGuardrails as tsGuardrails, BANNED_PHRASES, BANNED_UNLESS, PRICE_NOTE_UNLESS, WORD_LIMITS, CLAIM_KINDS, spelledQuantities as tsSpelled, ownAbbreviations as tsOwn } from '../functions/_shared/guardrails.ts';
import { buildRewritePrompt as tsPrompt, SYSTEM_PROMPT } from '../functions/_shared/rewritePrompt.ts';
import { BANNED_PHRASES as JS_BANNED, BANNED_UNLESS as JS_UNLESS, PRICE_NOTE_UNLESS as JS_NOTE_UNLESS, WORD_LIMITS as JS_LIMITS, CLAIM_KINDS as JS_CLAIMS, spelledQuantities as jsSpelled, ownAbbreviations as jsOwn } from '../../extension/src/rewriteTemplate.js';
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
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('I am Alex, sales consultant at Example Motors.', 'Ask for Alex.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('sales consultant', 'Sales  Consultant') + '\nVIN TESTVIN0000000001.',
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
  sixty('2019 Ram 1500 Big Horn with new tires and new brakes, plus a new battery and new brakes; it runs great.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, no accident on record, never had an accident, sold new to its first owner.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, pre-owned and on the lot at Example Certified Motors Route 19.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 GMC Sierra 2500HD SLE EXT CAB with AWD, ABS, USB and a CR-V EX-L AWD next to it.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 GMC SIERRA SLE EXT CAB, GREAT SLE TRUCK FOR YOU.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, pre-owned, driven by its previous owner on highway miles, one previous owner, owned by one family, both keys, all records, powertrain coverage, freshly detailed and garaged.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Message me directly, not the dealership; I have owned it and am selling it for a friend.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, one damage-free owner, one adult owner, one previous owner, one non-smoking owner and one adult owner again.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Plus tax, title and registration, which go to the state, not the dealer. Text me instead of the dealership; our family truck, selling for my brother.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Example Motors is locally owned and operated; this one was adult owned.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, only 2,019 dollars down, save 1,500 today, 1500 bucks off, driven by a 5.7L V8, never driven in winter, came in on trade from a local customer, full airbag coverage.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, 1,000 down, get 1500 off, 2,500 cash back, a rebate of 3,500, discount of 4,000, 4,500 in savings, an off-road 1500 off the lot.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Save 1,500 today.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with a full warranty. Financing available for all credit types, everyone gets approved fast.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, sold as-is with no warranty; financing subject to credit approval. It does not come with any warranty: none. Rust-free, damage-free, clean Carfax, runs great, no rust (no dents).') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Never driven in winter, never smoked in, no pets. Example Motors is a locally owned dealership.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. It does not come with a warranty.') + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. Ask for me, not the dealer's front desk. I'm the owner of this dealership. I am the owner of the store. Taxes and fees go to the state, not the dealership.") + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. Text me, not the dealer. I\u2019m the owner of this truck. I'm the owner. Message me, not the dealership's competitors; not the dealership.") + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. The warranty is not included.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn (no warranty).') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. One careful, loving owner. One very careful adult owner. Owned by one retired teacher.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Owned by a single careful driver, owned by one family since new, driven by a diesel mechanic, driven by a twin-turbo engine, One-Touch Windows, Owner\'s Manual, a single zone owner\'s manual.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, a local trade with new tires and new brakes, plus new wipers and a new engine, new Michelin tires, new front rotors, new tires and shocks, new tires, struts, two new batteries.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, reduced from 31,995 to 28,995, only 28.9k, miles: 38,000, with 38,000 on it, 41,230 on the clock, call 555-555-0100, since 1985, tows 7,500 lbs.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Driven by a General Motors retiree.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Driven by a 5.7L HEMI V8 engine paired with an 8-speed automatic, driven by dual electric motors, driven by a V8.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Adult-owned dealer trade-in.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Locally owned company truck; we are a locally owned dealership.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. No hidden fees, deal with me, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. Registration fees are paid directly to the DMV, not the dealership. Call me, not the dealer's switchboard.") + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. Buy from me, not the dealer's lot.") + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. I'm the owner of this business and this truck.") + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. Locally owned company pickup, locally owned dealership's trade; a locally owned dealer, serving the area; locally owned and operated since the start.") + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Buy from me and the fees go to the state, not the dealer. Pay me directly; the fees go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty("2019 Ram 1500 Big Horn. I'm the owner of this business, and this truck. I'm the owner of the store and the Ram. I'm the owner of this dealership, text me.") + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Buy direct from me, plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Traded in by a locally owned company, locally owned company since new. Here, we are a locally owned dealership; our store is locally owned and operated.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. We\u2019re a locally owned business. Driven by a retired teacher.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Driven  by a retired  teacher, a locally\towned company truck, never\u00a0smoked in, thirty  thousand miles.') + '\nVIN TESTVIN0000000001.',
  // the price note read where the text puts it: as a sentence of its own, or with words joined to it
  sixty('2019 Ram 1500 Big Horn. Taxes are lower when you deal direct with the salesperson, and plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn.\nPlus tax, title and registration, which go to the state, not the dealer, so deal direct with the salesperson.') + '\nVIN TESTVIN0000000001.',
  'Plus tax, title and registration, which go to the state, not the dealer\n' + sixty('2019 Ram 1500 Big Horn with 41,230 miles.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, and\nPlus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn etc. plus tax and tags, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.') + '\nVIN TESTVIN0000000001.\nplus tax and tags, which go to the state, not the dealer.',
  sixty('2019 Ram 1500 Big Horn. Plus tax, title and registration, which go to the state, not the dealer Text the salesperson.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Price note: Plus tax, title and registration, which go to the state, not the dealer. Questions? Plus tax, title and registration, which go to the state, not the dealer') + '\nVIN TESTVIN0000000001.',
];
const contexts = [
  { vehicle, dealer, priceNote: '', price: 28995 },
  { vehicle, dealer, priceNote: 'Price includes the $490 doc fee; tax and tags extra.', price: 28995 },
  { vehicle: { ...vehicle, carfaxOneOwner: true }, dealer, priceNote: 'Price includes the $500 doc fee; tax and tags extra.', price: 28995 },
  { vehicle: { ...vehicle, priceBeforeFees: null }, dealer: {}, priceNote: 'doc fee of $490', price: null },
  { vehicle, dealer, salesperson: { name: 'Alex', title: 'sales manager' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex', title: '' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex', title: 'Product  Specialist' }, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, urlConditionWord: 'certified used', descriptionRaw: 'Thirty thousand miles of service records. New tires and brakes, inspected, warranty included, non-smoker.' }, dealer: { name: 'Certified Credit Motors', city: 'Thousand Oaks' }, salesperson: { title: 'finance manager' }, priceNote: 'Financing through the dealership.', price: 28995 },
  { vehicle: { ...vehicle, inventoryType: 'Certified Used', features: ['Clean CARFAX', 'Garage Kept'] }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: 'Local trade with new <b>tires</b>.<br>Runs\n <strong>great</strong>.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: '<p>Clean interior</p><p>Runs great with new</p><div>brakes.</div>\r\nSmoke-free.<li>Inspected</li>' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, location: 'Example Certified Motors Route 19' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, make: 'GMC', model: 'SIERRA 2500HD', trim: 'SLE EXT CAB', features: [...vehicle.features, 'AWD', 'ABS', 'USB'], interiorColor: 'BLK/GRY', location: 'SAMPLE CDJR' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, carfaxOneOwner: true, descriptionRaw: 'One adult owner, garage kept.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, carfaxOneOwner: true, descriptionRaw: 'One careful, loving owner. Owned by a retired teacher.' }, dealer, priceNote: '', price: 28995 },
  { vehicle, dealer, priceNote: 'Plus tax, title and registration, which go to the state, not the dealer.', price: 28995 },
  { vehicle, dealer, priceNote: 'Deal direct with me: fees go to the state, not the dealer.', price: 28995 },
  { vehicle, dealer, priceNote: 'Price excludes tax, title and registration, which are paid to the state, not the dealership.', price: 28995 },
  { vehicle, dealer, priceNote: 'Plus tax, title and registration, which go to the state, not the dealer', price: 28995 },
  { vehicle, dealer, priceNote: 'plus tax and tags, which go to the state, not the dealer.', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: 'Sold as-is, no warranty. Carfax shows one accident reported. All loans are subject to bank approval. No rust. Driven by its previous owner. We are a locally owned dealership.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: 'Comes with the rest of the factory warranty. Clean Carfax. Financing for all credit types. Runs great. Non-smoker.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, features: [...vehicle.features, 'ABS Brakes', 'Remote Engine Start', 'Variable Intermittent Wipers'], descriptionRaw: 'Local trade with new tires.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: 'Recent service: new tires, brakes and rotors, plus new shocks and a new battery.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: 'Traded in by a locally owned company. Example Motors is a locally owned dealership.' }, dealer, priceNote: '', price: 28995 },
  { vehicle: { ...vehicle, descriptionRaw: 'Reduced from 31,995 to 28,995. Only 28.9k! Miles: 38,000. With 38,000 on it. Call 555-555-0100. Since 1985. Tows 7,500 lbs.' }, dealer, priceNote: '', price: 27995 },
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
assert.deepEqual(JSON.parse(JSON.stringify(BANNED_UNLESS)), JSON.parse(JSON.stringify(JS_UNLESS)));
assert.deepEqual(JSON.parse(JSON.stringify(PRICE_NOTE_UNLESS)), JSON.parse(JSON.stringify(JS_NOTE_UNLESS)));
assert.deepEqual(CLAIM_KINDS.map((k) => [k.what, String(k.re), Boolean(k.part), String(k.hedge), String(k.sourceRe)]), JS_CLAIMS.map((k) => [k.what, String(k.re), Boolean(k.part), String(k.hedge), String(k.sourceRe)]));
for (const text of texts) assert.deepEqual(tsSpelled(text), jsSpelled(text));
for (const ctx of contexts) assert.deepEqual([...tsOwn(ctx.vehicle)], [...jsOwn(ctx.vehicle)]);
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
