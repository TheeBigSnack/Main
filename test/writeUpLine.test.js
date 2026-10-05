// The template writer never copies the website's own write-up: a sentence
// taken from free text can be cut where it only seems to end and say the
// opposite of the website, and no rule for where a sentence ends holds for
// every dealer and language. So the description it writes for a car is the
// same whatever the car's write-up says. These tests build thousands of
// write-ups from true sentences, joined and broken across lines every way a
// website does it, with headings, Carfax labels, HTML entities and invisible
// characters, on their own and on lots of four that share text, and check
// that the template gives exactly the description it gives with no write-up,
// that the checks pass it, and that the write-up the rewrite service would
// be sent never carries the text the lot shares. Every write-up the reviews
// of the old write-up line tried is checked the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDescription } from '../extension/src/rewriter.js';
import { buildTemplateDescription, runGuardrails } from '../extension/src/rewriteTemplate.js';
import { findBoilerplate, splitSegments } from '../extension/src/description.js';

// A small seeded random number generator, so every run builds the same write-ups.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sentences as a dealership might write them: plain ones, ones that take
// something back, ones with a full stop, "!" or "?" inside that does not end
// them, and ones the checks would refuse in a description.
const SENTENCES = [
  'Local trade with new brakes and tires.',
  'Runs and drives great.',
  'This Jeep comes fully loaded.',
  'Clean interior with no rips or stains.',
  'Comes with heated seats and a sunroof.',
  'The tow package is ready for your camper.',
  'Room for seven with the third row.',
  'It has the 8.4-inch touchscreen and navigation.',
  'Serviced here since it came in.',
  'Freshly detailed inside and out.',
  'Apple CarPlay and Android Auto come standard.',
  'It came to us on trade.',
  'Two keys come with it.',
  'This SUV is not a Jeep Certified Pre-Owned vehicle.',
  'It does not come with a spare key.',
  'The factory warranty has expired.',
  'Sold as is, with no warranty of any kind.',
  'Comes with the factory warranty, except on the engine.',
  'Comes with the Tech. Package and adaptive cruise.',
  'Certified by the Auth. Dealer network.',
  'Equipped with the 8-Speed Auto. Transmission and heated seats.',
  'This truck does not have the Max. Tow Package and hitch.',
  'Not covered by the original Mfr. Warranty on this one.',
  'Comes with approx. two keys and a spare tire.',
  'Has the factory warranty from the prev. Owner, now void.',
  'Includes a 90-day powertrain warranty exc. Turbo and seals.',
  'Runs great... mostly.',
  'Smoker? No.',
  'Not a Yahoo! Autos Certified vehicle.',
  'Is it a hybrid? It is not.',
  'Includes floor mats, a cargo cover etc. And the manuals.',
  '(Local trade, never smoked in.)',
  '¡Camioneta local con frenos nuevos!',
  'Price excludes tax, title and registration.',
  'Plus doc, title and license.',
  'No accidents and runs perfect!',
  'Was $31,995, now just $28,995!',
  'Only 38,000 original miles.',
  'A one-owner truck with every record.',
  'Priced for our private sale event.',
  'Heated Seats, Navigation, Sunroof.',
  'Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package.',
  'BIG TRUCK WITH THE TOW PACKAGE.',
];
// Lines that qualify or take back the sentence before them.
const QUALIFIERS = ['except for the transmission, which slips.', 'Except the engine.', 'Expired last spring.', '- Except the engine.', 'Not!', 'Void due to a salvage title.'];

// Text the whole lot shares, as it sits in a car's write-up: a sentence of
// its own, one that ends on a word such as "tech." or "etc.", a lead-in the
// car's next sentence depends on, or the head of a sentence each car
// finishes its own way.
const MODELS = ['Escape', 'Edge', 'Explorer', 'Bronco', 'Ranger', 'Maverick'];
const LOT_TEXT = [
  { kind: 'sentence', text: 'All prices exclude tax and the documentation fee.' },
  { kind: 'sentence', text: 'All vehicles inspected by a certified tech.' },
  { kind: 'sentence', text: 'All prices exclude tax and the $699 documentary fee, etc.' },
  { kind: 'lead-in', text: 'The following items are not included with this vehicle.', after: ['Spare key and floor mats.', 'Owner’s manual.', 'Tonneau cover.', 'Second key fob.', 'Cargo net.', 'Roof rack.'] },
  { kind: 'head', text: 'This vehicle is not a Ford Auth.', tail: (model) => `Certified Pre-Owned ${model}.` },
];

const BETWEEN = [' ', '\n', '<br>', '</p><p>', '\n\n', '<br>&nbsp;', '\n​', '<br>⁠'];
const LINE_BREAKS = ['\n', '<br>', '</p><p>', '<br>&nbsp;', '\n﻿'];
const FIRST = ['Dealer Comments:', 'CARFAX One-Owner.', 'Recent Arrival!', 'Clean CARFAX.', 'Recent Arrival! Clean CARFAX.', '*** RECENT ARRIVAL ***'];
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// One car's write-up as raw text, with what it was built from.
function writeUp(rand, { lot = null, at = 0, carIndex = 0, headBreak = ' ' } = {}) {
  const pool = [...SENTENCES];
  const items = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i += 1) items.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  if (rand() < 0.25) items.splice(1 + Math.floor(rand() * items.length), 0, pick(rand, QUALIFIERS));
  if (lot) {
    const where = Math.min(at, items.length);
    if (lot.kind === 'sentence') items.splice(where, 0, lot.text);
    if (lot.kind === 'lead-in') items.splice(where, 0, lot.text, lot.after[carIndex % lot.after.length]);
    if (lot.kind === 'head') items.splice(where, 0, `${lot.text}${headBreak}${lot.tail(MODELS[carIndex % MODELS.length])}`);
  }
  // break one sentence across a line, at a word
  let broken = false;
  const own = items.map((s, i) => [s, i]).filter(([s]) => SENTENCES.includes(s) && s.includes(' '));
  if (own.length && rand() < 0.5) {
    const [s, i] = pick(rand, own);
    const words = s.split(' ');
    const cut = 1 + Math.floor(rand() * (words.length - 1));
    items[i] = `${words.slice(0, cut).join(' ')}${pick(rand, LINE_BREAKS)}${words.slice(cut).join(' ')}`;
    broken = true;
  }
  let raw = items.reduce((text, s, i) => (i ? `${text}${pick(rand, BETWEEN)}${s}` : s), '');
  const first = rand() < 0.3 ? pick(rand, FIRST) : '';
  if (first) raw = `${first}${pick(rand, BETWEEN)}${raw}`;
  // markup and characters a page carries without showing them
  if (rand() < 0.2) raw = raw.replace(' ', ' &amp; ').replace(/'/g, '&#8217;');
  if (rand() < 0.2) raw = `​${raw.replace(' ', '­ ')}`;
  if (raw.includes('</p><p>')) raw = `<p>${raw}</p>`;
  return { raw, broken, first };
}

// Cars the template writes for: with and without the Carfax one-owner flag, features, colours and a closing line.
const CAR = {
  year: 2019, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', mileage: 20986, price: 28995, vin: '1C4RJFBG5KC123456', stock: 'A123',
  inventoryType: 'Used', carfaxOneOwner: false, exteriorColor: 'Blue', interiorColor: 'Black', engine: '3.6L V6', transmission: 'Automatic', drivetrain: '4WD',
  features: ['Heated Seats', 'Navigation System', 'Remote Start', 'Backup Camera'], location: '',
};
const CARS = [
  CAR,
  { ...CAR, carfaxOneOwner: true, carfaxUrl: 'https://www.carfax.com/vhr/1C4RJFBG5KC123456' },
  { ...CAR, features: [], exteriorColor: '', interiorColor: '', engine: '', transmission: '', drivetrain: '', stock: '' },
];
const SETTINGS = [
  { dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Sam', title: 'sales consultant' }, priceNote: 'Price includes the doc fee; tax and tags extra.' },
  { dealer: { name: 'Ace', city: '' }, salesperson: { title: 'sales consultant', closingLine: 'Ask for me by name.' }, priceNote: '' },
];

// The template's description for this car and these settings with no write-up at all.
const baseline = new Map();
const withoutWriteUp = (car, s) => {
  const key = `${CARS.indexOf(car)}|${SETTINGS.indexOf(s)}`;
  if (!baseline.has(key)) baseline.set(key, buildTemplateDescription({ vehicle: { ...car, descriptionRaw: '' }, ...s, price: car.price }));
  return baseline.get(key);
};

const CASES = 5000;

async function check(rand, { withLot }) {
  const stats = { cases: 0, broken: 0, first: 0, entities: 0, invisible: 0, lotWide: 0, narrative: 0, separators: new Set() };
  for (let n = 0; n < CASES; n += 1) {
    const car = pick(rand, CARS);
    const s = pick(rand, SETTINGS);
    let w;
    let boilerplate = [];
    if (withLot) {
      const lot = pick(rand, LOT_TEXT);
      // the website lays every car out the same way
      const at = Math.floor(rand() * 4);
      const headBreak = pick(rand, [' ', '\n', '<br>']);
      const lotCars = [0, 1, 2, 3].map((carIndex) => writeUp(rand, { lot, at, carIndex, headBreak }));
      w = lotCars[0];
      boilerplate = [...findBoilerplate(lotCars.map((c) => c.raw))];
      if (boilerplate.length) stats.lotWide += 1;
    } else {
      w = writeUp(rand);
    }
    const r = await generateDescription({ ...s, vehicle: { ...car, descriptionRaw: w.raw }, price: car.price, boilerplate, settings: {} });
    const why = JSON.stringify(w.raw);
    // the template gives exactly what it gives with no write-up, and the checks pass it
    assert.equal(r.text, withoutWriteUp(car, s), `the template copied from the write-up: ${why}`);
    assert.deepEqual(r.guardrails.problems, [], why);
    // the write-up the rewrite service would get never carries the text the lot shares
    assert.ok(r.narrative.every((text) => !boilerplate.some((b) => text.includes(b))), `lot-wide text in the narrative: ${why} gave ${JSON.stringify(r.narrative)}`);
    // and, with nothing the lot shares, is the website's own segments, from its first
    if (!withLot) assert.deepEqual(r.narrative, splitSegments(w.raw).slice(0, r.narrative.length), why);
    if (r.narrative.length) stats.narrative += 1;
    if (w.broken) stats.broken += 1;
    if (w.first) stats.first += 1;
    if (/&(?:amp|nbsp|#8217);/.test(w.raw)) stats.entities += 1;
    if (/[​⁠﻿­]/.test(w.raw)) stats.invisible += 1;
    for (const sep of BETWEEN) if (w.raw.includes(sep)) stats.separators.add(sep);
    stats.cases += 1;
  }
  return stats;
}

test('the template never copies the write-up: over 5,000 seeded write-ups it writes what it writes with none, and passes its own checks', async () => {
  const stats = await check(seeded(20261005), { withLot: false });
  assert.equal(stats.cases, CASES);
  // the generator made what it claims to make, often enough for the check to mean something
  assert.ok(stats.broken >= 1500 && stats.first >= 1000 && stats.entities >= 500 && stats.invisible >= 500, JSON.stringify({ ...stats, separators: stats.separators.size }));
  assert.equal(stats.separators.size, BETWEEN.length);
  assert.ok(stats.narrative >= 2500, `the rewrite service's write-up is exercised: ${stats.narrative}`);
});

test('the template never copies the write-up, nor the text a lot shares: over 5,000 seeded lots of four', async () => {
  const stats = await check(seeded(91), { withLot: true });
  assert.equal(stats.cases, CASES);
  assert.ok(stats.lotWide >= 4000, JSON.stringify({ ...stats, separators: stats.separators.size }));
  assert.ok(stats.narrative >= 1000, `the rewrite service's write-up is exercised: ${stats.narrative}`);
});

// Every write-up the reviews of the old write-up line tried, and the attacks of the last review.
const EARLIER = [
  'Dealer Comments:\nLocal trade with new brakes and tires.',
  'Dealer Comments:<br>Local trade with new brakes and tires.',
  'Local trade with new brakes.<br><br>Certified Pre-Owned vehicle.',
  'Line one of the write-up.\n\tLine two, after a raw line break and a tab.',
  'Local trade with new brakes.<br>Price does not include dealer documentation fee, tax or tags.',
  'Local trade with new brakes.<br><br>Vehicle subject to prior sale. See dealer for details.',
  'Local trade with new brakes.\nAll vehicles are sold as is with no warranty.',
  'This SUV is not a Jeep Certified Pre-Owned vehicle.<br>Local trade.',
  'Local trade with new\nMichelin tires and fresh brakes.',
  'This truck comes with the\n8.4-inch touchscreen and a tow package.',
  'Comes with approx.\ntwo keys and a spare tire.',
  'This one is not covered by the original mfr.\nWarranty applies only to new units.',
  'Local trade with new brakes and the tow pkg.\nIncludes a bed liner.',
  'Dealer comments\nLocal trade with new brakes and tires.',
  'Local trade with new brakes and tires\nCall today.',
  'Local trade, not a Jeep Cert. Pre-Owned unit.',
  'Comes with the tow pkg. and a bed liner. Clean interior.',
  'Tax and tags extra, and this unit is not a Mfr. Certified Pre-Owned vehicle.',
  'Price excludes tax and is not eligible for the Mfr. Certified Pre-Owned program.',
  'No doc fees and no remaining Mfr. Warranty on this one.',
  'Price plus tax; not a Mfr. Certified vehicle.',
  'No dealer fees and it is not covered by the Mfg. Warranty anymore.',
  'Priced at $28,995 and not covered by any Mfr. Warranty.',
  'Has 45,000 miles and is no longer under Mfr. Warranty.',
  'No accidents, but this is not a Mfr. Certified Pre-Owned unit.',
  'This truck has 98,000 miles and is past the original Mfr. Warranty coverage is still active on the powertrain.',
  'Was $32,995 and is no longer under the Mfr. Warranty applies to the next owner.',
  'Price excludes tax; this is not a Jeep Cert. Pre-Owned vehicle. Local trade.',
  'Local trade. Tax and tags extra and not under the Mfr. Warranty.',
  'Sold as is. It does not include the Uconnect\nNavigation package.',
  'Local trade. The previous owner removed the Mopar\nTow package and hitch.',
  'No accidents.\nCertified Pre-Owned vehicle with warranty.',
  'Price excludes the dealer documentation charge and title. Local trade.',
  'Plus doc, title and license.<br>Local trade.',
  'Local trade. Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package. Floor mats.',
  'Not included: Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package. Floor mats.',
  'Not included: Heated Seats, Navigation, Sunroof, Remote Start, Bluetooth, Backup Camera, Tow Package.<br>Floor mats.',
  '- Not included: floor mats.<br>Spare key.',
  'Awards: Not a 2019 KBB Best Buy.<br>Certified Pre-Owned vehicle.',
  'CARFAX One-Owner.<br>Local trade.',
  'Please note this vehicle is not a Jeep\nCertified Pre-Owned vehicle.',
  'Please note this vehicle is not a Jeep<br>Certified Pre-Owned vehicle.',
  '<p>This SUV is not a Jeep</p><p>Certified Pre-Owned vehicle.</p>',
  'This vehicle does not come with a<br>warranty of any kind.',
  'Please note this vehicle is not a<br>certified pre-owned vehicle.',
  'This one is not part of the Mopar\nCertified program.',
  'Our Jeep\nCertified technicians replaced the brakes.',
  'This Limited has a new set of Michelin\nDefender tires and fresh brakes.',
  'Local trade, serviced here with the 3.6L\nV6 and a new battery.',
  'Comes loaded with Uconnect\nNavigation, a sunroof and heated seats.',
  'Equipped with the 5.7L HEMI\nV8 engine and a tow package.',
  'Local trade with new<br>brakes and tires.',
  'Comes with the tow pkg.<br>and a bed liner.',
  'This vehicle is not a Jeep<br>All vehicles are sold as is.<br>Certified Pre-Owned vehicle.',
  '"Not a CPO"<br>Certified Pre-Owned vehicle.',
  'Please note, this vehicle is not:<br>Certified Pre-Owned.',
  'Sold without:<br>Warranty of any kind.',
  'The previous owner removed the following:<br>Tow package and hitch.',
  'This vehicle does not come with:<br>A spare key.',
  'This vehicle does not come with:<br>A spare key.<br>Floor mats.',
  'Not included with this vehicle:<br>Factory warranty coverage.',
  'Exclusions:<br>Floor mats.',
  'Known issues:\nCheck engine light.',
  'Dealer Comments:<br>This vehicle does not come with:<br>A spare key.',
  '<p><strong>Vehicle Highlights</strong></p><p>Local trade with new brakes and tires.</p>',
  'Vehicle Highlights<br>Local trade with new brakes.<br>Clean interior.',
  '2019 Ram 1500 Classic Express\nLocal trade with new brakes and tires.',
  '<ul><li>Heated seats</li></ul><p>Local trade with new brakes.</p>',
  '*** Local trade with new brakes ***<br>Clean interior.',
  'Features:\nHeated Seats\nNavigation\nSunroof',
  '¡Camioneta local con frenos nuevos!',
  'Runs and drives great.\nexcept for the transmission, which slips.',
  'Runs and drives great.<br>except for the transmission, which slips.',
  'Comes with the remaining factory powertrain warranty.\nuntil it expired last spring.',
  'Comes with the remaining factory powertrain warranty.<br>until it expired last spring.',
  '<p>This Jeep comes fully loaded.</p><p>except for the navigation and sunroof.</p>',
  'Runs great...\nexcept the transmission slips.',
  'Runs great...<br>except the transmission slips.',
  'Local trade. Runs great…<br>except the transmission slips.',
  'Comes with the factory warranty.<br>Except the engine.',
  'Local trade. Comes with the factory warranty.<br>Except the engine.',
  'Certified Pre-Owned.<br>NOT!',
  'Local trade. Equipped with the 8-Speed Auto. Transmission and heated seats.',
  'Local trade with new tires. Comes with the Tech. Package and adaptive cruise.',
  'Local trade. This truck was certified by the Auth. Dealer until a $500 repair voided it.',
  'Local trade. Not covered by the DLR. Warranty applies only to new units.',
  'Local trade. This truck does not have the Max. Tow Package.',
  'This SUV is not a Ford Auth.<br>Certified Pre-Owned vehicle.',
  'This SUV is not...<br>Certified Pre-Owned.',
  'Not a Yahoo! Autos Certified vehicle, tax extra.',
  'Built in 2019.<br>Local trade.',
  'This 2019 Ram 1500 Classic Express Quad Cab pairs the HEMI 5.7L V8 with 4WD and an 8-Speed Automatic.<br>- HEMI 5.7L V8 Engine',
  'This 2019 Ram 1500 Classic Express pairs the HEMI 5.7L V8 with an 8-Speed Automatic. It came in on trade.',
  'This 2019 Ram 1500 Classic Express Quad Cab pairs the HEMI 5.7L V8 with 4WD and an 8-speed automatic.<br>- HEMI 5.7L V8 Engine',
  '1. Price excludes tax.<br>2. Local trade.',
  '1. Local trade with new brakes.',
  'Clean CARFAX Not Available On This Unit. Local trade.',
  'Clean Carfax Except One Reported Accident.',
  'CARFAX One-Owner Status Not Verified.',
  'Recent Arrival! Clean CARFAX Not Available. Local trade.',
  'Recent Arrival! Clean CARFAX. Local trade with new brakes.',
  'Clean CARFAX.<br>Not available for this unit.',
  'Clean CARFAX. Not available for this unit.',
  'CARFAX One-Owner.\nNot verified.',
  'Smoker? No.<br>Local trade.',
  'Any rust? No. Frame damage? Yes, repaired.',
  'Smoker? No, never. Local trade.',
];
const ATTACKS = [
  "Everything works.<br>With the exception of the A/C, which needs a recharge.",
  "Everything works. With the exception of the A/C, which needs a recharge.",
  "Runs and drives great.\nOther than the transmission, which slips.",
  "Runs and drives great. Apart from the transmission, which slips.",
  "Runs and drives great. Aside from the transmission.",
  "Comes with the remaining factory warranty.\nExpired last spring.",
  "Comes with the remaining factory warranty. Void after the accident.",
  "Comes with the remaining factory warranty. Only on the powertrain.",
  "Comes with the remaining factory warranty. Save for the turbo.",
  "Equipped with the pano. Roof and heated seats.",
  "Comes with a 90-day warranty exc. Turbo and seals.",
  "Has heated and vent. Seats up front.",
  "Has the rear ent. System for the kids.",
  "This is the 80th anniv. Edition with the gray interior.",
  "Includes free oil changes for a year, subj. To approval by the lender.",
  "Comes with the factory warranty and it is transferable.\nPer the manufacturer, it is not.",
  "Local trade. Runs great.\nNo.",
  "Has a clean history. Allegedly.",
  "Has the factory warranty! Not.",
  "Has the factory warranty. NOT!",
  "Has the factory warranty. Nope, it expired.",
  "Has the factory warranty. Never mind, it expired.",
  "Has the factory warranty. Just kidding.",
  "Has the factory warranty. Well, it did.",
  "Has the factory warranty. Or so we thought.",
  "Has the factory warranty. Excludes the engine.",
  "Has the factory warranty. Exclusions apply.",
  "Has the factory warranty. Except it does not.",
  "Has the factory warranty. Barring the engine.",
  "Has the factory warranty. Less the engine.",
  "Has the factory warranty. Besides the engine.",
  "Has the factory warranty. Outside of the engine.",
  "Has the factory warranty. As of last year.",
  "Has the factory warranty. Through March only.",
  "Has the factory warranty. Up until last year.",
  "Has the factory warranty. Formerly.",
  "Has the factory warranty. Previously.",
  "Has the factory warranty. Once upon a time.",
  "Has the factory warranty. In theory.",
  "Has the factory warranty. Sort of.",
  "Has the factory warranty. Kind of.",
  "Has the factory warranty. Not anymore.",
  "Has the factory warranty. NO.",
  "Has the factory warranty. Haha no.",
  "Has the factory warranty. LOL no.",
  "Local trade. Equipped with the pano. Roof and heated seats.",
  "Equipped with the pano. Roof and heated seats. Priced at $25,995.",
  "Local trade. Includes a 90-day powertrain warranty exc. Turbo and seals.",
  "Local trade. Has heated and vent. Seats up front.",
  "Local trade. Has the rear ent. System for the kids.",
  "Local trade. Includes free oil changes for a year, subj. To approval.",
  "This is the 80th anniv. Edition with the gray interior and 22-inch wheels. Local trade. New tires.",
  "Local trade. Has the factory warranty, transferable w/ the dealer's recon. Approval only.",
  "Local trade. Comes with rem. Start and heated seats.",
  "Local trade. Finished in a silv. Metallic paint with a black interior.",
  "Local trade. Comes with the cust. Wheels and a lift.",
  "Local trade. Has the aftermarket exh. System and cold air intake.",
  "Local trade. Equipped with the spec. Edition package.",
  "Local trade. Has the sport appearance pack. Plus a bed liner.",
  "Local trade. Has the factory warranty. Expired last spring.",
  "Tiene garant\u00eda de f\u00e1brica.<br>Excepto el motor.",
  "Tiene garant\u00eda de f\u00e1brica. Salvo el motor.",
  "Everything works great.<br>Other than the sunroof.",
  "Everything works great.</p><p>Apart from the sunroof.",
  "<p>Everything works great.</p><p>With the exception of the sunroof.</p>",
  "Everything works great.\nAside from the A/C.",
  "Everything works great.\nSave for the A/C.",
  "Everything works great.\nOutside of the A/C.",
  "Everything works great.\nBarring the A/C.",
  "Everything works great.\nExcludes the A/C.",
  "This truck has the factory warranty.\nOnly until March.",
  "This truck has the factory warranty.\nThrough March only.",
  "This truck has the factory warranty.\nPending approval.",
  "This truck has the factory warranty.\nVoid due to a salvage title.",
  "This truck has the factory warranty.\nOr did, until it expired.",
  "This truck has the factory warranty.\nAnd it expired last month.",
  "This truck has the factory warranty.\nWell, it used to.",
  "This truck has the factory warranty.\nJust kidding.",
  "This truck has the factory warranty.\nNope.",
  "This truck has the factory warranty.\nNo longer, it expired.",
  "This truck has the factory warranty.\nNever had one.",
  "This truck has the factory warranty.\nSorry, it does not.",
  "This truck has the factory warranty.\nCorrection: it does not.",
  "This truck has the factory warranty.\nUpdate: it does not.",
  "This truck has the factory warranty.\n(Not really.)",
  "This truck has the factory warranty.\n*Not transferable.",
  "This truck has the factory warranty.\n* Except the engine.",
  "This truck has the factory warranty.\n**Except the engine.",
  "This truck has the factory warranty.\n- Except the engine.",
  "This truck has the factory warranty.\n\u2022 except the engine.",
  "This truck has the factory warranty.\n\u2026except the engine.",
  "This truck has the factory warranty.\n... except the engine.",
  "This truck has the factory warranty.\n\u201cExcept the engine.\u201d",
  "This truck has the factory warranty.\n\u2018Except\u2019 the engine.",
  "This truck has the factory warranty.\n[Except the engine.]",
  "This truck has the factory warranty.\n>Except the engine.",
  "This truck has the factory warranty.\n~except the engine.",
  "This truck has the factory warranty.\n+ except the engine.",
  "This truck has the factory warranty.\n# except the engine.",
  "This truck has the factory warranty.\n1. Except the engine.",
  "This truck has the factory warranty.\n&nbsp;except the engine.",
  "This truck has the factory warranty.\n<b></b>except the engine.",
  "This truck has the factory warranty.\n&amp; except the engine.",
  "This truck has the factory warranty.\nEXCEPT the engine.",
  "This truck has the factory warranty.\nExcept: the engine.",
  "This truck has the factory warranty.\n\u00a0except the engine.",
  "This truck has the factory warranty.\n\u200bexcept the engine.",
  "This truck has the factory warranty.\n\ufeffexcept the engine.",
  "This truck has the factory warranty.\n\u2060except the engine.",
  "Local trade. Comes with the factory warranty.<br>Except the engine.",
  "1. Price excludes tax.<br>2. Local trade.",
  "Not a Yahoo! Autos Certified vehicle, tax extra.",
  "Smoker? No, never. Local trade.",
  "Smoker? No.<br>Local trade.",
  "Any rust? No. Frame damage? Yes, repaired.",
  "Local trade. This truck was certified by the Auth. Dealer until a $500 repair voided it.",
  "Runs great...\nexcept the transmission slips.",
  "Runs great...<br>except the transmission slips.",
  "Local trade. Loaded with options, ie. Navigation and a sunroof.",
  "Local trade. Loaded with options, eg. Navigation and a sunroof.",
  "Local trade. This truck is in exc. Condition with new tires.",
  "Local trade. Comes with the remaining factory warranty, exp. 12/2026 per the warranty office.",
  "Local trade. Comes with all maint. Records from the previous owner.",
  "Local trade. Has the factory warranty from the prev. Owner, now void.",
  "Has the factory warranty. Formerly. Local trade.",
  "Runs and drives great. With the exception of the A/C.",
  "Runs and drives great. With the exception of the A/C. Local trade.",
  "Clean CARFAX. Not available on this unit.",
  "CARFAX One-Owner.\nStatus unverified.",
  "Recent Arrival! Clean CARFAX.\nExcept the accident in 2021.",
  "Recent Arrival!\nClean CARFAX except one reported accident.",
  "Dealer Comments:\nNot a rental.",
  "Dealer Comments:<br>Runs great.<br>Except the A/C.",
  "&nbsp;Runs great.",
  "Runs and drives great.<br>&nbsp;except for the transmission, which slips.",
  "This truck has the factory warranty.\nExpired last spring.",
  "Comes with the remaining factory warranty. Expired in 2024.",
  "Has the factory powertrain warranty. Void since the accident in 2023.",
  "Everything works. Other than the HVAC.",
  "Has every option. Other than the Sunroof.",
  "Comes with the factory warranty. Through March 2027.",
  "Runs and drives great. Needs a new A/C.",
  "Runs and drives great. Check engine light is on per the OBD.",
  "Local trade. Runs and drives great. With the exception of the A/C.",
  "Clean history report. Two accidents reported to CARFAX.",
  "Runs and drives great.<br>\u200bexcept for the transmission, which slips.",
  "Runs and drives great.<br>\u2060except for the transmission, which slips.",
  "Loaded with options, ie. Navigation and a sunroof.",
];

test('no write-up any review tried gives the template a word of its text, and the checks pass every one', async () => {
  for (const raw of [...EARLIER, ...ATTACKS]) {
    for (const s of SETTINGS) {
      for (const car of CARS) {
        const r = await generateDescription({ ...s, vehicle: { ...car, descriptionRaw: raw }, price: car.price, boilerplate: [], settings: {} });
        assert.equal(r.text, withoutWriteUp(car, s), raw);
        assert.deepEqual(r.guardrails.problems, [], raw);
      }
    }
  }
  assert.ok(EARLIER.length >= 100 && ATTACKS.length >= 140);
});

test('nor does a write-up on a lot that shares text, however the lot-wide text sits in it', async () => {
  const lot = (each) => ['Escape', 'Edge', 'Explorer', 'Bronco', 'Ranger'].map(each);
  const own = ['This Jeep has new brakes.', 'Local trade with new tires.', 'Freshly detailed inside and out.', 'It came to us on trade.', 'The paint still shines.'];
  const lots = [
    lot((m) => `This vehicle is not a Ford Auth.<br>Certified Pre-Owned ${m}.`),
    lot((m) => `This vehicle is not a Ford Auth.\nCertified Pre-Owned ${m}.`),
    lot((m) => `This vehicle is not a Ford Auth. Certified Pre-Owned ${m} with new brakes.`),
    lot((m, i) => `The following items are not included with this vehicle.<br>${['Spare key and floor mats.', "Owner's manual.", 'Tonneau cover.', 'Second key fob.', 'Cargo net.'][i]}`),
    lot((m) => `All prices exclude tax and the documentation fee.<br>Local trade ${m} with new brakes.`),
    lot((m) => `Local trade ${m} with new brakes. All prices exclude tax and the documentation fee. Clean interior.`),
    own.map((car) => `All vehicles inspected by a certified tech. ${car}`),
    own.map((car) => `All prices exclude tax and the $699 documentary fee, etc. ${car}`),
    own.map((car) => `Serving drivers all over Southern CA. ${car}`),
    [`Comes with heated seats, remote start, nav, etc. All prices exclude tax and the $699 documentary fee.`, ...own.slice(1).map((car) => `${car} All prices exclude tax and the $699 documentary fee.`)],
  ];
  for (const raws of lots) {
    const boilerplate = [...findBoilerplate(raws)];
    assert.ok(boilerplate.length, raws[0]);
    for (const s of SETTINGS) {
      const r = await generateDescription({ ...s, vehicle: { ...CAR, descriptionRaw: raws[0] }, price: CAR.price, boilerplate, settings: {} });
      assert.equal(r.text, withoutWriteUp(CAR, s), raws[0]);
      assert.deepEqual(r.guardrails.problems, [], raws[0]);
      assert.ok(r.narrative.every((text) => !boilerplate.some((b) => text.includes(b))), `${raws[0]} gave ${JSON.stringify(r.narrative)}`);
    }
  }
});

test('the checks still read the write-up as the website\'s own words, so a draft may say what it says', () => {
  const c = { vehicle: { ...CAR, descriptionRaw: 'Local trade with new <b>tires</b>.<br>&nbsp;Garage kept.' }, ...SETTINGS[0], price: CAR.price };
  const base = buildTemplateDescription(c);
  assert.deepEqual(runGuardrails(`${base}\nA local trade with new tires, garage kept.`, c).problems.filter((p) => p.code === 'unsupported-claim'), []);
  assert.deepEqual(runGuardrails(`${base}\nA local trade with new brakes.`, c).problems.map((p) => p.code), ['unsupported-claim']);
});
