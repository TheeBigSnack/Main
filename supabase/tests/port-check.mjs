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
import { runGuardrails as tsGuardrails, BANNED_PHRASES, BANNED_UNLESS, PRICE_NOTE_UNLESS, PRICE_NOTE_WORDS, WORD_LIMITS, CLAIM_KINDS, spelledQuantities as tsSpelled, ownAbbreviations as tsOwn, numbersAsWords as tsWords, nameWithoutNumber as tsNameWithout } from '../functions/_shared/guardrails.ts';
import { buildRewritePrompt as tsPrompt, SYSTEM_PROMPT } from '../functions/_shared/rewritePrompt.ts';
import { BANNED_PHRASES as JS_BANNED, BANNED_UNLESS as JS_UNLESS, PRICE_NOTE_UNLESS as JS_NOTE_UNLESS, PRICE_NOTE_WORDS as JS_NOTE_WORDS, WORD_LIMITS as JS_LIMITS, CLAIM_KINDS as JS_CLAIMS, spelledQuantities as jsSpelled, ownAbbreviations as jsOwn, numbersAsWords as jsWords, nameWithoutNumber as jsNameWithout } from '../../extension/src/rewriteTemplate.js';
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
  // what follows the note: a line that starts its own sentence (an emoji, a quote, a bullet), or words that carry the note's one on
  sixty('2019 Ram 1500 Big Horn.\nPlus tax, title and registration, which go to the state, not the dealer.\n\u{1F697} Come see it today!\n- Heated seats\n\u201cAsk me anything.\u201d') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn.\nPlus tax, title and registration, which go to the state, not the dealer. (so deal direct with the salesperson) Plus tax, title and registration, which go to the state, not the dealer \u2013 so text the salesperson.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn.\nPlus tax, title and registration, which go to the state, not the dealer\n, so deal direct.\nPlus tax, title and registration, which go to the state, not the dealer\n- \nso deal direct.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn, e.g. Plus tax, title and registration, which go to the state, not the dealer. Text the salesperson vs. Plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('Deal direct with the salesperson, incl. Plus tax, title and registration, which go to the state, not the dealer. Text the salesperson esp. Plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('Deal direct, approx. Plus tax, title and registration, which go to the state, not the dealer. Fees (excl.) Plus tax, title and registration, which go to the state, not the dealer. Ask me etc. Plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  sixty('Deal direct with the salesperson, ie. Plus tax, title and registration, which go to the state, not the dealer. Text the salesperson eg. Plus tax, title and registration, which go to the state, not the dealer.') + '\nVIN TESTVIN0000000001.',
  // a number typed into Settings: in the role, the name or the dealership's name, alone or beside another number
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('sales consultant', '2nd shift sales') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles and a 3.92 axle.').replace('I am Alex, sales consultant', 'I am Alex 2, 3rd shift sales') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace(/Example Motors/g, '8 Mile Auto') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles, in row 2.').replace('sales consultant', 'Team 2 sales, 24/7') + '\nVIN TESTVIN0000000001.',
  // the example the reason offers: none that fails a check of its own, none for "#1", a name that loses only its digits
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('I am Alex, sales consultant', 'I am J2 Smith, 1 owner car specialist') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('sales consultant', 'Sales Associate 2') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('sales consultant', '#1 salesman') + '\nVIN TESTVIN0000000001.',
  // a name whose number belongs to the words around it: no example, since the name without it would be garbled
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('I am Alex,', 'I am Alex (Store 2),') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 41,230 miles.').replace('I am Alex,', 'I am Alex 2nd shift,') + '\nVIN TESTVIN0000000001.',
  // a role that is only a number: set aside only where it is said once, and never inside a longer number
  sixty('2019 Ram 1500 Big Horn with 41,230 miles. Seats 2 rows.').replace('sales consultant', '2') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with 2,000 miles.').replace('sales consultant', '2') + '\nVIN TESTVIN0000000001.',
  // "not the dealers" and "not the dealerships" in a description, and a price note with words that are not price and fee wording
  sixty('2019 Ram 1500 Big Horn. Buy from me, not the dealers; text me, not the dealerships.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Tax, title and fees go to the state, not the dealer. Text Sam at 555-123-4567.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Example Motors prices plus tax. Tax and fees go to the county, not the dealers. Springfield sales tax applies.') + '\nVIN TESTVIN0000000001.',
  // a list after "new": commas, "and", "&", "/", "+", "plus", words before a part, a part said to be checked, the car's own features
  sixty('2019 Ram 1500 Big Horn with new tires, struts and brakes that were replaced last month, new tires/rotors + pads, and fresh tires, the battery, front and rear shocks.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn with new tires, HEMI engine, brakes; new tires, brakes inspected; new tires, Brake Assist, Battery Saver, struts; new tires and brake assist; new brake pads and rotors; a new set of tires plus new front/rear brakes are brand new.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Highlights: New Tires/Brakes, New Brake Pads & Rotors, Brake Assist, Wipers - Rain Sensing, Rear Wiper/Washer and wipers, new tires, brakes for winter.') + '\nVIN TESTVIN0000000001.',
  // the list stops at a line break (but for "and", "&" and "plus" with spaces around them), and only "brake pads" and "brake rotors" are one part in two words
  sixty('2019 Ram 1500 Big Horn. It rides on new tires\nEngine and transmission run great.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Set of new tires\nBrakes, rotors and pads were inspected.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. Just put on new tires\nTransmission, engine and exhaust all strong.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. New tires, struts\nBrakes inspected at our shop.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. New tires brakes and rotors. New brake rotors and pads. New tires\nand brakes. + New battery\n+ Wipers') + '\nVIN TESTVIN0000000001.',
  // "and", "&" and "plus" with spaces around them cross a line break, and "front" or "rear" after them may end its line; after a comma a line break ends the item
  sixty('2019 Ram 1500 Big Horn with new tires &\nbrakes. New battery and front\nbrakes &\nrear\nshocks. New wipers +\nstruts.') + '\nVIN TESTVIN0000000001.',
  sixty('2019 Ram 1500 Big Horn. New tires, front\nbrakes. New battery, brake\npads. New wipers, struts\ninspected.') + '\nVIN TESTVIN0000000001.',
  // an item without its own "new" is quoted from the nearest "new" before it, and a very long list is read once
  sixty('2019 Ram 1500 Big Horn with new tires and new brakes, plus a battery; new tires, struts, new brakes and rotors; fresh brakes, the new battery and wipers.') + '\nVIN TESTVIN0000000001.',
  sixty(`2019 Ram 1500 Big Horn with ${'new tires, struts, Brake Assist, new brake pads & '.repeat(60)}wipers.`) + '\nVIN TESTVIN0000000001.',
];
const contexts = [
  { vehicle, dealer, priceNote: '', price: 28995 },
  { vehicle, dealer, priceNote: 'Price includes the $490 doc fee; tax and tags extra.', price: 28995 },
  { vehicle, dealer, priceNote: 'Price includes new tires/brakes and new brake pads + rotors; tax and tags extra.', price: 28995 },
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
  { vehicle, dealer, salesperson: { name: 'Alex', title: '2nd shift sales' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex 2', title: '3rd shift sales' }, priceNote: '', price: 28995 },
  { vehicle, dealer: { name: '8 Mile Auto', city: 'Springfield' }, salesperson: { name: 'Alex', title: 'sales consultant' }, priceNote: '', price: 28995 },
  { vehicle, dealer: { name: 'Route 19 Motors', city: 'Springfield' }, salesperson: { name: 'Alex', title: 'Team 2 sales, 24/7' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex', title: '2' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'J2 Smith', title: '1 owner car specialist' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex', title: 'Sales Associate 2' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex', title: '#1 salesman' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex (Store 2)', title: 'sales consultant' }, priceNote: '', price: 28995 },
  { vehicle, dealer, salesperson: { name: 'Alex 2nd shift', title: 'sales consultant' }, priceNote: '', price: 28995 },
  // a price note that says "not the dealer": every word price and fee wording, the dealership's own name, city and state, amounts and percentages
  { vehicle, dealer: { ...dealer, state: 'OH' }, priceNote: 'Tax, title and fees go to the state, not the dealer. Text Sam at 555-123-4567.', price: 28995 },
  { vehicle, dealer: { ...dealer, state: 'OH' }, priceNote: 'Example Motors prices plus tax. Tax and fees go to the county, not the dealers. Springfield sales tax applies.', price: 28995 },
  { vehicle, dealer: { name: 'Sample Auto', city: 'Shelbyville' }, priceNote: 'Example Motors prices plus tax. Tax and fees go to the county, not the dealers. Springfield sales tax applies.', price: 28995 },
  { vehicle, dealer, priceNote: 'Price includes the $490 doc fee and 6.25 % tax. Tax and tags go to the state, not the dealerships. Call \uff15\uff15\uff15-0100 or email sales@carmail.com \u{1F4DE}', price: 28995 },
  { vehicle, dealer, priceNote: "Ask for Sam, not the dealer's front desk. T\u0435xt us; prices valid through 2026, $5551234567.", price: 28995 },
  { vehicle, dealer, priceNote: 'Text Sam, not the dealers.', price: 28995 },
  // the state is not one of the dealership's own words (the service is not sent it), "your" is not on the list, invisible characters
  { vehicle, dealer: { name: 'Example Motors', city: 'Portland', state: 'ME' }, priceNote: 'Tax, title and fees go to the state, not the dealer. Cash price paid to me. Price excludes ME sales tax.', price: 28995 },
  { vehicle, dealer, priceNote: 'Tax and fees go to your state, not the dealer. Your price requires financing.', price: 28995 },
  { vehicle, dealer, priceNote: 'Tax, title and fees go to the state, not the dealer. Cash price paid to A\u200Bbe, A\u00ADna or S\uFEFFam from the \u202Eper\u202C; t\u00ADhe doc fee and the\u0336 tax.', price: 28995 },
  { vehicle, dealer, priceNote: 'Price excludes t\u00ADhe doc fee\u200B. Tax, title and fees go to the state, not the dealer.', price: 28995 },
  // a word joined to the next by "." or ":" with no space (a web link of listed words), and the dealership's own name with its dots
  { vehicle, dealer, priceNote: 'Tax, title and fees go to the state, not the dealer. Cash price at dealer.to/sale, cash.sale, price.is or Example-Motors.city; dealer:sale, dealer\u2024to, dealer.\u200Bto. Tags extra.Doc fee $499.', price: 28995 },
  { vehicle, dealer: { name: 'J.D. Example Motors', city: 'Springfield' }, priceNote: 'All J.D. Example Motors prices plus tax and tags. Tax, title and fees go to the state, not the dealer.', price: 28995 },
  { vehicle, dealer, priceNote: 'All J.D. Example Motors prices plus tax and tags. Tax, title and fees go to the state, not the dealer.', price: 28995 },
  // a phone number written as amounts or percentages (a run of seven or more digits), amounts with words between, a number in the dealership's own name, "change"
  { vehicle, dealer, priceNote: 'Tax, title and fees go to the state, not the dealer. $555-$123-$4567, $555.$123.$4567 or ($555) $123-$4567; $ 555 $ 123 $ 4567\n$555/$123/$4567 555% 123% 456% 7%.', price: 28995 },
  { vehicle, dealer, priceNote: 'Price $555-$123-$45.67. Tax, title and fees go to the state, not the dealer. A $499 doc fee and a $25 title fee apply; $499/$25, 6.25%/7.25%.', price: 28995 },
  { vehicle, dealer: { name: 'Route 19 Motors', city: '29 Palms' }, priceNote: 'All Route 19 Motors prices plus tax and tags. Tax, title and fees go to the state, not the dealer. 29 Palms tax; Route 9, 191 or 19-1.', price: 28995 },
  { vehicle, dealer: { name: 'Route 19 Motors', city: '29 Palms' }, priceNote: 'All Route 19 Motors prices plus 29 Palms tax and tags. Tax, title and fees go to the state, not the dealer.', price: 28995 },
  { vehicle, dealer, priceNote: 'Prices subject to change. Tax and title fees go to the Department of Motor Vehicles, not the dealer. See the agent, incl. fees due at signing.', price: 28995 },
  { vehicle: { ...vehicle, features: [...vehicle.features, 'New Tires/Brakes', 'New Brake Pads & Rotors', 'Brake Assist', 'Battery Saver', 'Wipers - Rain Sensing', 'Rear Wiper/Washer'], descriptionRaw: 'Recent service: new tires, brakes and rotors, plus new shocks.' }, dealer, priceNote: '', price: 28995 },
  {},
];

let checks = 0;
const settingsNamed = new Set(); // the settings the reasons above named, so the cases are known to reach that part

for (const text of texts) {
  for (const ctx of contexts) {
    const js = jsGuardrails(text, ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(tsGuardrails(text, ctx))), JSON.parse(JSON.stringify(js)), `runGuardrails differs for ${JSON.stringify(text.slice(0, 40))}`);
    for (const p of js.problems) if (p.code === 'setting-number') settingsNamed.add(p.text.slice(0, p.text.indexOf(' "')));
    checks += 1;
  }
}
assert.deepEqual([...BANNED_PHRASES], [...JS_BANNED]);
assert.deepEqual(JSON.parse(JSON.stringify(BANNED_UNLESS)), JSON.parse(JSON.stringify(JS_UNLESS)));
assert.deepEqual(JSON.parse(JSON.stringify(PRICE_NOTE_UNLESS)), JSON.parse(JSON.stringify(JS_NOTE_UNLESS)));
assert.deepEqual([...PRICE_NOTE_WORDS], [...JS_NOTE_WORDS]);
assert.deepEqual(CLAIM_KINDS.map((k) => [k.what, String(k.re), Boolean(k.part), String(k.hedge), String(k.sourceRe)]), JS_CLAIMS.map((k) => [k.what, String(k.re), Boolean(k.part), String(k.hedge), String(k.sourceRe)]));
assert.deepEqual([...settingsNamed].sort(), ["Your dealership's name", 'Your name', 'Your role']);
for (const value of ['2nd shift sales', 'sales, 2nd shift', 'Team 3 Sales', '8 Mile Auto', '12th Street Motors', 'sales, 24/7', 'Route19', 'sales consultant', '', '0th', '21st', '#1 salesman', 'Sales 2.0', '0% APR specialist', '$0 down specialist', 'Sales Associate 2', 'Internet Sales (Store 2)', 'Sales 2nd shift', 'Shift 2.', '(2nd shift)', '“3rd” shift']) assert.equal(tsWords(value), jsWords(value), value);
for (const value of ['Sam 2', 'Sam2', 'J2 Smith', 'Sam 2nd', 'Sam (2)', 'Sam [2]', 'Sam "2"', 'Sam (2) Smith', 'Mary-Kate 2', "Sam O'Brien 2", 'Sam (Store 2)', 'Sam (2nd shift)', 'Sam 2nd shift', 'Sam, 2nd shift', 'Sam 2 Smith', 'Sam-2', 'Sam #2', 'Sam 24/7', 'Sam 2.0', 'Sam, 2', 'Sam (Jr 2', 'Sam 2-3', '2nd shift Sam', '22', '', 'Sam']) assert.equal(tsNameWithout(value), jsNameWithout(value), value);
for (const text of texts) assert.deepEqual(tsSpelled(text), jsSpelled(text));
for (const ctx of contexts) assert.deepEqual([...tsOwn(ctx.vehicle)], [...jsOwn(ctx.vehicle)]);
assert.deepEqual({ ...WORD_LIMITS }, { ...JS_LIMITS });

const facts = {
  year: 2019, make: 'Ram', model: '1500', trim: 'Big Horn', mileage: 41230, features: ['Heated seats'], carfaxOneOwner: false, carfax: true,
  narrative: ['A well kept truck.'], dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Alex', title: 'sales consultant' }, priceNote: '',
};
// the sign-off with no name, for titles the note's sentence check reads in each way (see signOffLine)
const titled = ['\u{1F697} sales pro', '(bdc) rep', '- sales', '\u2013 sales', ', sales', '...sales', '\u0138 sales', '\u00dfales', '\u{10428} sales'].map((title) => ({ ...facts, salesperson: { name: '', title } }));
for (const f of [facts, { ...facts, salesperson: { name: '', title: '' } }, { ...facts, salesperson: undefined, dealer: undefined }, ...titled]) {
  for (const fixes of [[], ['"3.92" isn\'t in the website\'s data for this car', 'Says "no accidents"']]) {
    assert.deepEqual(tsPrompt(f, fixes), jsPrompt(f, fixes));
    checks += 1;
  }
}
assert.equal(SYSTEM_PROMPT, JS_SYSTEM);
console.log(`port-check: ${checks} comparisons, both ports match the originals`);
