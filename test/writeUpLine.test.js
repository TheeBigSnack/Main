// The description's write-up line copies only the website's own whole
// sentences, from its first: never part of one, never one after a sentence it
// leaves out. These tests build thousands of write-ups from true sentences,
// joined and broken across lines every way a website does it, and check what
// the template copies from each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDescription } from '../extension/src/rewriter.js';
import { findBoilerplate } from '../extension/src/description.js';

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

// Each one whole, as a dealership might write it. Some have a full stop, "!"
// or "?" inside that does not end them; some the template must refuse.
const SENTENCES = [
  // plain ones
  'Local trade with new brakes and tires.',
  'Runs and drives great.',
  'This Jeep comes fully loaded.',
  'Clean interior with no rips or stains.',
  'Comes with heated seats and a sunroof.',
  'The tow package is ready for your camper.',
  'Great truck for work or play.',
  'Room for seven with the third row.',
  'It has the 8.4-inch touchscreen and navigation.',
  'Serviced here since it came in.',
  'Bring the whole family for a test drive.',
  'Freshly detailed inside and out.',
  'The paint still shines.',
  'Leather seats and a heated steering wheel keep winter easy.',
  'Apple CarPlay and Android Auto come standard.',
  'This one has the bigger engine.',
  'It came to us on trade.',
  'The cargo area holds a lot.',
  'It runs on regular gas.',
  'Two keys come with it.',
  // negations and sentences that take something back
  'This SUV is not a Jeep Certified Pre-Owned vehicle.',
  'It does not come with a spare key.',
  'The factory warranty has expired.',
  'Sold as is, with no warranty of any kind.',
  'Not a rental, not a fleet unit.',
  'Comes with the factory warranty, except on the engine.',
  'The sunroof does not open.',
  // a mark inside that does not end the sentence
  'Comes with the Tech. Package and adaptive cruise.',
  'Certified by the Auth. Dealer network.',
  'Covered by the DLR. Warranty plan.',
  'Equipped with the 8-Speed Auto. Transmission and heated seats.',
  'Has the Lux. Group, minus the sunroof.',
  'This truck does not have the Max. Tow Package and hitch.',
  'Not covered by the original Mfr. Warranty on this one.',
  'Comes with approx. two keys and a spare tire.',
  'Comes with the tow pkg. and a bed liner.',
  'Built in the U.S. at the original plant.',
  'Runs great... mostly.',
  'Built in 2019.',
  'Smoker? No.',
  'Not a Yahoo! Autos Certified vehicle.',
  'Any rust? No, none at all.',
  'Ask about the No. 1 package.',
  'Made by Ace Mfg. Co. at the old plant.',
  'Rated at 30 mpg. Highway driving helps.',
  'Wow! What a truck.',
  'It is a 4x4. Off-road ready.',
  'It has the 3.6L V6. Plenty of power.',
  'Includes floor mats, a cargo cover etc. And the manuals.',
  'Covered until Jan. 2027 by the plan.',
  'Fits 20 in. Wheels from the factory.',
  'Comes with the 8-speed auto. Transmission included.',
  'Asked if it was "certified." It is not.',
  'Is it a hybrid? It is not.',
  'Does it smoke? Not at all.',
  '(Local trade, never smoked in.)',
  '"Clean" inside and out.',
  '\u00a1Camioneta local con frenos nuevos!',
  // ones the template refuses: fees, a price, another mileage, a banned phrase, one owner without the Carfax flag, a list
  'Price excludes tax, title and registration.',
  'Plus doc, title and license.',
  'A processing charge applies.',
  'No accidents and runs perfect!',
  'Was $31,995, now just $28,995!',
  'Only 38,000 original miles.',
  'A one-owner truck with every record.',
  'Priced for our private sale event.',
  'Heated Seats, Navigation, Sunroof.',
];

// Text the whole lot shares, as it sits in a car's write-up: a sentence of
// its own, a lead-in the car's next sentence depends on, or the head of a
// sentence each car finishes its own way.
const MODELS = ['Escape', 'Edge', 'Explorer', 'Bronco', 'Ranger', 'Maverick'];
const LOT_TEXT = [
  { kind: 'sentence', text: 'All prices exclude tax and the documentation fee.' },
  { kind: 'sentence', text: 'Please see the dealer for warranty details.' },
  { kind: 'lead-in', text: 'The following items are not included with this vehicle.', after: ['Spare key and floor mats.', 'Owner\u2019s manual.', 'Tonneau cover.', 'Second key fob.', 'Cargo net.', 'Roof rack.'] },
  { kind: 'head', text: 'This vehicle is not a Ford Auth.', tail: (model) => `Certified Pre-Owned ${model}.` },
];

const BETWEEN = [' ', '\n', '<br>', '</p><p>', '\n\n'];
const LINE_BREAKS = ['\n', '<br>', '</p><p>'];
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// One car's write-up: [raw, its whole sentences in order], where each whole
// sentence is a sentence of SENTENCES, a lot-wide sentence or lead-in, or a
// lot-wide head with the car's own tail. A heading or a Carfax label may come
// first; they are not sentences of the write-up.
function writeUp(rand, { lot = null, at = 0, carIndex = 0, headBreak = ' ' } = {}) {
  const pool = [...SENTENCES];
  const items = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i += 1) items.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  if (lot) {
    const where = Math.min(at, items.length);
    if (lot.kind === 'sentence') items.splice(where, 0, lot.text);
    if (lot.kind === 'lead-in') items.splice(where, 0, lot.text, lot.after[carIndex % lot.after.length]);
    if (lot.kind === 'head') items.splice(where, 0, `${lot.text}${headBreak}${lot.tail(MODELS[carIndex % MODELS.length])}`);
  }
  // break one of the car's own sentences across a line, at a word
  const own = items.map((s, i) => [s, i]).filter(([s]) => SENTENCES.includes(s) && s.includes(' '));
  if (own.length && rand() < 0.5) {
    const [s, i] = pick(rand, own);
    const words = s.split(' ');
    const cut = 1 + Math.floor(rand() * (words.length - 1));
    items[i] = `${words.slice(0, cut).join(' ')}${pick(rand, LINE_BREAKS)}${words.slice(cut).join(' ')}`;
  }
  let raw = items.reduce((text, s, i) => (i ? `${text}${pick(rand, BETWEEN)}${s}` : s), '');
  const first = rand();
  if (first < 0.1) raw = `Dealer Comments:${pick(rand, LINE_BREAKS)}${raw}`;
  else if (first < 0.2) raw = `${pick(rand, ['CARFAX One-Owner.', 'Recent Arrival!', 'Clean CARFAX.'])}${pick(rand, BETWEEN)}${raw}`;
  if (raw.includes('</p><p>')) raw = `<p>${raw}</p>`;
  const plainText = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { raw, sentences: items.map(plainText) };
}

const CAR = {
  year: 2019, make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', mileage: 20986, price: 28995, vin: '1C4RJFBG5KC123456', stock: 'A123',
  inventoryType: 'Used', carfaxOneOwner: false, exteriorColor: 'Blue', interiorColor: 'Black', engine: '3.6L V6', transmission: 'Automatic', drivetrain: '4WD',
  features: ['Heated Seats', 'Navigation System', 'Remote Start', 'Backup Camera'], location: '',
};
const ARGS = { dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Sam', title: 'sales consultant' }, priceNote: 'Price includes the doc fee; tax and tags extra.', price: CAR.price, settings: {} };

// The write-up line of a description: the line after the car's name, unless that is the highlights.
const writeUpLine = (text) => {
  const second = text.split('\n')[1];
  return /^Highlights: /.test(second) ? '' : second;
};

const CASES = 5000;

async function check(rand, { withLot }) {
  const stats = { cases: 0, copied: 0, twoOrMore: 0, broken: 0, lotWide: 0 };
  for (let n = 0; n < CASES; n += 1) {
    let car;
    let boilerplate = [];
    let lot = null;
    if (withLot) {
      lot = pick(rand, LOT_TEXT);
      // the website lays every car out the same way
      const at = Math.floor(rand() * 4);
      const headBreak = pick(rand, [' ', '\n', '<br>']);
      const lotCars = [0, 1, 2, 3].map((carIndex) => writeUp(rand, { lot, at, carIndex, headBreak }));
      car = lotCars[0];
      // a head the website runs on into the car's own words on one line is part of a sentence that is each car's own
      boilerplate = [...findBoilerplate(lotCars.map((c) => c.raw))];
      if (boilerplate.length) stats.lotWide += 1;
    } else {
      car = writeUp(rand);
    }
    const r = await generateDescription({ ...ARGS, vehicle: { ...CAR, descriptionRaw: car.raw }, boilerplate });
    const line = writeUpLine(r.text);
    const why = `${JSON.stringify(car.raw)} gave ${JSON.stringify(line)}`;
    if (line) {
      // the first k whole sentences, k >= 1, exactly
      const k = car.sentences.findIndex((_, i) => car.sentences.slice(0, i + 1).join(' ') === line);
      assert.ok(k >= 0, `not the opening whole sentences: ${why}`);
      // and never the text the lot shares, or what only reads right after it
      if (lot) assert.ok(!boilerplate.some((b) => line.includes(b)), `lot-wide text copied: ${why}`);
      stats.copied += 1;
      if (k >= 1) stats.twoOrMore += 1;
      if (/<br>|<\/p><p>|\n/.test(car.raw)) stats.broken += 1;
    }
    if (n % 50 === 0) assert.deepEqual(r.guardrails.problems, [], why);
    stats.cases += 1;
  }
  return stats;
}

test('the write-up line is empty or exactly the write-up\'s first whole sentences, over 5,000 seeded write-ups with no lot-wide text', async () => {
  const stats = await check(seeded(20261002), { withLot: false });
  assert.equal(stats.cases, CASES);
  // the line is copied often enough for the check to mean something, across lines and with two sentences
  assert.ok(stats.copied >= 2500, JSON.stringify(stats));
  assert.ok(stats.twoOrMore >= 250, JSON.stringify(stats));
  assert.ok(stats.broken >= 2000, JSON.stringify(stats));
});

test('the write-up line is empty or exactly the write-up\'s first whole sentences, never lot-wide text, over 5,000 seeded lots of four', async () => {
  const stats = await check(seeded(91), { withLot: true });
  assert.equal(stats.cases, CASES);
  assert.ok(stats.lotWide >= 4000, JSON.stringify(stats));
  assert.ok(stats.copied >= 2000, JSON.stringify(stats));
  assert.ok(stats.twoOrMore >= 150, JSON.stringify(stats));
});
