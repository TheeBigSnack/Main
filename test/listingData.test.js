import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildListingData, vehicleKind, normalizeColor, normalizeBodyStyle, normalizeTransmission, normalizeFuelType, locationQuery, locationExpect, brandedTitleSignal, STATE_NAMES, TITLE_STATUSES, CONDITIONS, DEFAULT_LISTING_DEFAULTS } from '../extension/src/listingData.js';
import { vehicle } from './helpers.js';

const DEALER = { name: 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg', city: 'Waynesburg', state: 'PA', zip: '15370' };

test('the Ram maps to the form fields', () => {
  const v = vehicle('usedNormal');
  const d = buildListingData(v, { dealer: DEALER, description: 'Hello.', price: v.price });
  assert.deepEqual(d.fields, {
    vehicleType: 'car_truck',
    year: '2019',
    make: 'Ram',
    model: '1500 Classic Express',
    vin: '1C6RR7FT0KS643289',
    mileage: '20986',
    price: '27163',
    bodyStyle: 'Truck',
    exteriorColor: 'Blue',
    interiorColor: 'Gray',
    fuelType: 'Gasoline',
    transmission: 'Automatic',
    location: '15370',
    description: 'Hello.',
    condition: 'Very good',
    titleStatus: 'Clean',
    cleanTitle: 'yes',
  });
  assert.deepEqual(d.missing, []);
  assert.equal(d.photos.length, 1);
  assert.deepEqual(d.assumed.map((b) => `${b.key}=${b.value}`), ['condition=Very good', 'titleStatus=Clean']);
  assert.deepEqual(d.leftBlank, []);
  assert.deepEqual(DEFAULT_LISTING_DEFAULTS, { titleStatus: 'Clean', condition: 'Very good' });
  assert.equal(TITLE_STATUSES.length, 5);
  assert.equal(CONDITIONS.length, 5);
});

test('title and condition come from the dealership defaults, never from a guess', () => {
  const v = vehicle('usedNormal');
  // dealer chose other defaults
  const d = buildListingData(v, { defaults: { titleStatus: 'Clean', condition: 'Excellent' } });
  assert.equal(d.fields.condition, 'Excellent');
  // "leave blank" and unknown values both leave the field for the person
  const blank = buildListingData(v, { defaults: { titleStatus: '', condition: 'Spotless' } });
  assert.equal(blank.fields.titleStatus, '');
  assert.equal(blank.fields.cleanTitle, '', 'the checkbox is left as it is when there is no default');
  assert.equal(blank.fields.condition, '');
  assert.equal(buildListingData(v, { defaults: { titleStatus: 'Rebuilt', condition: 'Good' } }).fields.cleanTitle, '', 'a non-clean default never ticks the clean box');
  assert.deepEqual(blank.leftBlank.map((b) => b.key), ['condition', 'titleStatus']);
  assert.deepEqual(blank.assumed, []);
});

test('a color guessed from the photos fills only a blank, and is marked as a guess', () => {
  const v = vehicle('usedNoCarfax', { styles: { interior_color: 'Titanium' } }); // exterior Black (stated), interior neither a list word nor a shade name
  const d = buildListingData(v, { guesses: { exterior: 'Red', interior: 'Brown', confidence: 'medium' } });
  assert.equal(d.fields.exteriorColor, 'Black', 'a stated color is never overridden');
  assert.equal(d.fields.interiorColor, 'Brown');
  assert.deepEqual(d.assumed.map((a) => a.key), ['interiorColor', 'condition', 'titleStatus']);
  assert.match(d.assumed[0].why, /guessed from the photos \(medium confidence\); the website says "Titanium"/);
  // a shade name the website states is its reading, and a photo guess never replaces it
  const sepia = buildListingData(vehicle('usedNoCarfax'), { guesses: { interior: 'Red', confidence: 'high' } });
  assert.equal(sepia.fields.interiorColor, 'Brown');
  assert.match(sepia.assumed[0].why, /the website says "Sepia"; sepia is read as Brown/);
  // a guess that is not one of the list words is ignored
  assert.equal(buildListingData(v, { guesses: { interior: 'Mauve' } }).fields.interiorColor, '');
  // no guess: blank, and not "assumed"
  const none = buildListingData(v);
  assert.equal(none.fields.interiorColor, '');
  assert.deepEqual(none.assumed.map((a) => a.key), ['condition', 'titleStatus']);
});

test('a branded title in the website text switches the clean-title default off', () => {
  assert.equal(brandedTitleSignal({ descriptionRaw: 'Rebuilt title, runs and drives great.<br>Disclaimer.' }), 'Rebuilt');
  assert.equal(brandedTitleSignal({ features: ['Salvage Title'] }), 'Salvage');
  assert.equal(brandedTitleSignal({ descriptionRaw: 'Fog lights, flood lights on the rack, one owner.' }), '');
  assert.equal(brandedTitleSignal({}), '');
  const v = vehicle('usedNormal', { description: 'Previously a rebuilt title vehicle.' });
  const d = buildListingData(v);
  assert.equal(d.fields.titleStatus, '');
  assert.equal(d.fields.cleanTitle, 'no', 'the clean-title box is unticked for a branded title');
  assert.equal(d.fields.condition, 'Very good');
  assert.equal(d.branded, 'rebuilt');
  assert.match(d.leftBlank.find((b) => b.key === 'titleStatus').why, /mentions "rebuilt"/);
});

test('a branded title is caught in the usual ways a website writes it, and ordinary words are not', () => {
  const branded = {
    'Salvaged title - sold as is': 'Salvaged',
    'Flood-damaged, sold as is': 'Flood-damaged',
    'Prior flood damage': 'flood damage',
    'TMU - true mileage unknown title': 'TMU',
    'True mileage unknown.': 'True mileage unknown',
    'Odometer reading is NOT ACTUAL MILEAGE.': 'Odometer reading is NOT ACTUAL',
    'Sold with NOT ACTUAL MILEAGE.': 'NOT ACTUAL MILEAGE',
    'Mileage is not actual.': 'Mileage is not actual',
    'Odometer discrepancy on file': 'Odometer discrepancy',
    'Title is branded: odometer exempt': 'Title is branded',
    'Branded Title': 'Branded Title',
    'Previous total loss, insurance claim': 'total loss',
    'Totaled and repaired': 'Totaled',
    'Hail-damaged': 'Hail-damaged',
    'Hail damage on the roof': 'Hail damage',
    'Water damage history': 'Water damage',
    'Fire damage repaired': 'Fire damage',
    'Non-repairable certificate': 'Non-repairable',
    'Rebuildable': 'Rebuildable',
    'Lemon': 'Lemon',
    'Lemon law buyback': 'Lemon law buyback',
    'Manufacturer buyback': 'buyback',
    'R title': 'R title',
    'Theft recovered': 'Theft recovered',
    'Junk title': 'Junk title',
    'Reconstructed vehicle': 'Reconstructed',
    'Title: Branded': 'Title: Branded',
    'Title Status: Branded': 'Title Status: Branded',
    'Title - branded': 'Title - branded',
    'Previously flooded': 'flooded',
    'Flooded vehicle, sold as is': 'Flooded',
    'Odometer not actual': 'Odometer not actual',
    'Odometer reading is not actual.': 'Odometer reading is not actual',
    'Exceeds mechanical limits': 'Exceeds mechanical limits',
    'Mileage exceeds mechanical limits.': 'exceeds mechanical limits',
    'Prior total loss; GAP coverage offered.': 'total loss',
  };
  for (const [words, signal] of Object.entries(branded)) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), signal, words);
    const d = buildListingData({ descriptionRaw: words });
    assert.equal(d.fields.titleStatus, '', `${words}: no title default`);
    assert.equal(d.fields.cleanTitle, 'no', `${words}: the clean-title box is unticked`);
  }
  // in the title or a feature too
  assert.equal(brandedTitleSignal({ siteTitle: 'Used 2018 Ford F-150 XLT - Salvaged Title' }), 'Salvaged');
  assert.equal(brandedTitleSignal({ features: ['Flood-Damaged'] }), 'Flood-Damaged');
  // ordinary dealer wording is not a brand: the dealership's default stands
  for (const words of ['Tax, title and license extra.', 'Fog lights, flood lights on the rack.', 'No liens.', 'Odometer exempt.', 'No frame damage reported.', 'Total price shown includes the doc fee.', 'Lemonade stand not included.', 'Our title clerk handles the paperwork.', 'Water-resistant seats, fire extinguisher mount.', 'Mopar-branded floor mats.', 'Title and registration extra.', 'Total Loss Protection available.', 'GAP and total loss coverage offered.']) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), '', words);
    const d = buildListingData({ descriptionRaw: words });
    assert.equal(d.fields.titleStatus, 'Clean', words);
    assert.equal(d.fields.cleanTitle, 'yes', words);
  }
});

test('blank values are reported, never guessed', () => {
  const v = vehicle('usedNoCarfax', { styles: { interior_color: 'Titanium' }, mechanical: { fuel_type: 'Unknown' } });
  const d = buildListingData(v, { dealer: {}, price: null });
  assert.equal(d.fields.interiorColor, '');
  assert.equal(d.fields.fuelType, '');
  assert.equal(d.fields.location, '');
  assert.equal(d.fields.price, '');
  assert.deepEqual(d.missing, ['price', 'interiorColor', 'fuelType', 'location', 'description']);
  assert.equal(d.source.interiorColor, 'Titanium');
});

test('the price posted is whatever the caller chose (website price or before fees)', () => {
  const v = vehicle('usedNormal');
  assert.equal(buildListingData(v, { price: v.priceBeforeFees }).fields.price, '26673');
});

test('motorcycles: by body type, or by a bike-only make; car brands stay cars', () => {
  assert.equal(vehicleKind({ make: 'Harley-Davidson', bodyType: '' }), 'motorcycle');
  assert.equal(vehicleKind({ make: 'Ford', bodyType: 'Motorcycle' }), 'motorcycle');
  assert.equal(vehicleKind({ make: 'Honda', bodyType: 'SUVs' }), 'car_truck');
  assert.equal(vehicleKind({ make: 'BMW', bodyType: 'Sedan' }), 'car_truck');
  assert.equal(vehicleKind({ make: 'Chrysler', model: 'PT Cruiser', bodyType: 'Wagon' }), 'car_truck');
  assert.equal(vehicleKind({}), 'car_truck');
});

test('colours: the first colour word wins, unknown words stay blank', () => {
  assert.equal(normalizeColor('Diesel Gray/Black'), 'Gray');
  assert.equal(normalizeColor('Sting-Gray Clearcoat'), 'Gray');
  assert.equal(normalizeColor('Steel Blue'), 'Blue');
  assert.equal(normalizeColor('Global Black w/Capri Leatherette Seats'), 'Black');
  assert.equal(normalizeColor('Bright White Clearcoat'), 'White');
  assert.equal(normalizeColor('Off White'), 'Off white');
  assert.equal(normalizeColor('Titanium'), '');
  assert.equal(normalizeColor(''), '');
});

test('body styles, transmissions and fuel types', () => {
  assert.equal(normalizeBodyStyle('Trucks'), 'Truck');
  assert.equal(normalizeBodyStyle('SUVs'), 'SUV');
  assert.equal(normalizeBodyStyle('Coupe'), 'Coupe');
  assert.equal(normalizeBodyStyle('Minivan'), 'Minivan');
  assert.equal(normalizeBodyStyle('Cargo Van'), 'Van');
  assert.equal(normalizeBodyStyle(''), '');
  assert.equal(normalizeTransmission('8-Speed Automatic'), 'Automatic');
  assert.equal(normalizeTransmission('6-Speed Manual'), 'Manual');
  assert.equal(normalizeTransmission('CVT'), 'Automatic');
  assert.equal(normalizeTransmission(''), '');
  assert.equal(normalizeFuelType('Gasoline Fuel'), 'Gasoline');
  assert.equal(normalizeFuelType('Gasoline/Mild Electric Hybrid'), 'Hybrid');
  assert.equal(normalizeFuelType('Plug-In Electric/Gas'), 'Plug-in hybrid');
  assert.equal(normalizeFuelType('Electric'), 'Electric');
  assert.equal(normalizeFuelType('Diesel Fuel'), 'Diesel');
  assert.equal(normalizeFuelType('Flex Fuel Capability'), 'Flex');
});

test('location: ZIP first, then city and state', () => {
  assert.equal(locationQuery(DEALER), '15370');
  assert.equal(locationQuery({ city: 'Waynesburg', state: 'PA' }), 'Waynesburg, PA');
  assert.equal(locationQuery({ city: 'Waynesburg', state: 'Pennsylvania' }), 'Waynesburg, PA');
  assert.equal(locationQuery({ zip: '15370-1234' }), '15370');
  assert.equal(locationQuery({}), '');
});

test('location: only a suggestion in the right state may be picked (there are several Waynesburgs)', () => {
  assert.deepEqual(locationExpect({ city: 'Waynesburg', state: 'PA' }), { alternatives: [['Waynesburg', 'Pennsylvania'], ['Waynesburg', 'PA']], strict: true });
  assert.deepEqual(locationExpect({ city: 'Waynesburg', state: 'pennsylvania', zip: '15370' }), { alternatives: [['Waynesburg', 'Pennsylvania'], ['Waynesburg', 'PA']], strict: true });
  assert.deepEqual(locationExpect({ city: 'Waynesburg' }), { alternatives: [['Waynesburg']], strict: false });
  assert.deepEqual(locationExpect({ zip: '15370' }), { alternatives: [], strict: true });
  // territories count as states for the guard
  assert.deepEqual(locationExpect({ city: 'San Juan', state: 'PR', zip: '00907' }), { alternatives: [['San Juan', 'Puerto Rico'], ['San Juan', 'PR']], strict: true });
  assert.equal(STATE_NAMES.GU, 'Guam');
  assert.deepEqual(locationExpect({}), { alternatives: [], strict: false });
  assert.equal(STATE_NAMES.PA, 'Pennsylvania');
  assert.equal(Object.keys(STATE_NAMES).length, 56); // 50 states, DC, five territories
  assert.equal(buildListingData(vehicle('usedNormal'), { dealer: DEALER }).match.location.strict, true);
});
