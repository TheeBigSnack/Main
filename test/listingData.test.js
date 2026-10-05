import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a title brand or odometer line written as a label and value is read as branded; a clean or exempt value is not', () => {
  const branded = {
    'Title Brand: Flood': 'Title Brand: Flood',
    'Title Type: Branded': 'Title Type: Branded',
    'Odometer: Not Actual': 'Odometer: Not Actual',
    'Title: Flood': 'Title: Flood',
    'Title Brand: Hail': 'Title Brand: Hail',
    'Title Brands: Water Damage': 'Title Brands: Water Damage',
    'Title Brand(s): Flood': 'Title Brand(s): Flood',
    'Title Brand - Fire': 'Title Brand - Fire',
    'Title Status: Junk': 'Title Status: Junk',
    'Title: Theft Recovery': 'Title: Theft Recovery',
    'Odometer Status: Not Actual': 'Odometer Status: Not Actual',
    'Mileage - Not Actual': 'Mileage - Not Actual',
  };
  for (const [words, signal] of Object.entries(branded)) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), signal, words);
    assert.equal(brandedTitleSignal({ features: ['Backup Camera', words] }), signal, `${words} as a feature`);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle], ['', 'no'], words);
  }
  for (const words of ['Title: Clean', 'Title Brand: None', 'Title Brand: Not Branded', 'Title Type: Clean', 'Odometer: Actual', 'Odometer: Exempt', 'Title: In hand', 'Clean title - fire red paint', 'Clean title: hail-free, garage kept']) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), '', words);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle], ['Clean', 'yes'], words);
  }
});

test('"flooded with light" or "with options" is a sales line, not a flood brand; a flooded car still is', () => {
  const sales = [
    'This SUV is flooded with natural light from the panoramic roof.', 'Flooded with options!', 'A cabin flooded with sunlight.', 'An interior flooded in natural light.',
    'Flooded with plenty of natural light.', 'Flooded with tons of premium features.', 'Flooded with so many options.', 'A sun-flooded cabin.', 'A light-flooded interior.',
  ];
  for (const words of sales) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), '', words);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle, d.branded], ['Clean', 'yes', ''], words);
  }
  // only a named sales object makes a sales line: whatever else flooded the car, it is a brand
  const flooded = [
    'Previously flooded.', 'This car was flooded with water.', 'Flooded with salt water.', 'Flooded in a hurricane, sold as is.',
    'Previously flooded with saltwater.', 'This car was flooded with seawater during Hurricane Ian.', 'Flooded with rainwater, sold as is.', 'Was flooded with stormwater.',
    'Flooded with floodwater up to the dash.', 'Flooded with 2 feet of water.', 'Flooded with contaminated flood water.', 'Flooded with mud and debris.',
    'Flooded with light damage to the carpet.', 'Flooded in the light rain storm.', 'Flooded by a storm surge.', 'Flooded with the water.',
  ];
  for (const words of flooded) {
    assert.match(brandedTitleSignal({ descriptionRaw: words }), /^flooded$/i, words);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle, d.branded.toLowerCase()], ['', 'no', 'flooded'], words);
  }
  // the help page's sales-line examples are what the code reads as no brand
  const help = readFileSync(new URL('../docs/help.md', import.meta.url), 'utf8');
  const named = help.match(/a sales line such as ((?:"[^"]+"(?: or |, )?)+)/);
  assert.ok(named, 'help.md names the sales lines that do not count');
  const examples = [...named[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(examples.length >= 2, named[1]);
  for (const words of examples) assert.equal(brandedTitleSignal({ descriptionRaw: `${words}.` }), '', words);
});

test('the CARFAX or AutoCheck buyback program line is not a brand, as the help page says; a manufacturer buyback program still is', () => {
  const help = readFileSync(new URL('../docs/help.md', import.meta.url), 'utf8');
  assert.match(help, /CARFAX buyback program line many websites add to every car[^.]*does not count/);
  for (const words of ['This vehicle qualifies for the CARFAX Buyback Program.', 'Qualifies for the CARFAX\u00ae Buyback Program!', 'AutoCheck Buy Back Program eligible.']) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), '', words);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle, d.branded], ['Clean', 'yes', ''], words);
  }
  assert.equal(brandedTitleSignal({ descriptionRaw: 'Manufacturer buyback program vehicle.' }), 'buyback');
  assert.equal(brandedTitleSignal({ descriptionRaw: 'Qualifies for the CARFAX Buyback Program. Lemon law buyback.' }), 'Lemon law buyback');
});

test('a denied mention or a program or finance offer is not a brand; the same words stated of the car still are', () => {
  // a clean car: the dealership's Clean default stands and the box is ticked
  const notBrands = [
    'No accidents, no salvage history, never a buyback.',
    'Carfax shows no flood damage.',
    'Without flood damage.',
    'Not a rebuilt title.',
    'Never salvaged, never rebuilt.',
    'Has never been flooded.',
    "Isn't a lemon.",
    'No salvage or flood damage.',
    'No lien on the title.',
    'Clean title, no lemon buyback, no flood damage.',
    'This vehicle qualifies for the CARFAX Buyback Guarantee.', // the lot-wide line many websites add to every used car
    'Ask about our 3-day buyback guarantee.',
    'AutoCheck Buyback Protection included.',
    'We will pay off your lien!',
    "We'll pay off the lien on your trade.",
    'Lien-free title in hand.',
    'Free and clear of all liens.',
  ];
  for (const words of notBrands) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), '', words);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle, d.branded], ['Clean', 'yes', ''], words);
  }
  // a brand the text states is still read, even near a denial or a program word
  const brands = {
    'This vehicle has a rebuilt title.': 'rebuilt', // a lot-wide line like this one still counts
    'No accidents, salvage title.': 'salvage',
    'No accidents salvage title': 'salvage',
    'Do not miss this rebuilt title truck.': 'rebuilt',
    'Not salvage, but rebuilt.': 'rebuilt',
    'Not salvage but rebuilt.': 'rebuilt',
    'No warranty. Salvage title.': 'Salvage',
    'No hassle, salvage title.': 'salvage',
    'No accidents reported, but this is a rebuilt title.': 'rebuilt',
    'Never a buyback guarantee on a salvage title.': 'salvage',
    'Manufacturer buyback program vehicle.': 'buyback',
    'Lien payoff in process.': 'Lien',
    'Lien on title.': 'Lien',
    'Qualifies for the CARFAX Buyback Guarantee. Lemon law buyback.': 'Lemon law buyback',
    'No salvage and flood damage repaired.': 'flood damage',
  };
  for (const [words, signal] of Object.entries(brands)) {
    assert.equal(brandedTitleSignal({ descriptionRaw: words }), signal, words);
    const d = buildListingData({ descriptionRaw: words }, { defaults: { titleStatus: 'Clean', condition: 'Good' } });
    assert.deepEqual([d.fields.titleStatus, d.fields.cleanTitle], ['', 'no'], words);
  }
  // a denial never reaches from one feature or field into the next
  assert.equal(brandedTitleSignal({ features: ['Backup Camera', 'No', 'Salvage Title'] }), 'Salvage');
  assert.equal(brandedTitleSignal({ descriptionRaw: 'Runs great, no', features: ['Rebuilt Title'] }), 'Rebuilt');
  assert.equal(brandedTitleSignal({ features: ['No Accidents', 'No Salvage History'] }), '');
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

// ---------- what a second read of the car changes on the form ----------
import * as listing from '../extension/src/listingData.js';

test('listingChanges: the form fields a fresh read of the car changes, the description aside', () => {
  const v = vehicle('usedNormal');
  const build = (car, price, description = 'x') => buildListingData(car, { dealer: { city: 'Springfield', state: 'OH' }, price, description, defaults: { titleStatus: 'Clean', condition: 'Very good' } });
  assert.equal(typeof listing.listingChanges, 'function');
  assert.deepEqual(listing.listingChanges(build(v, 27163), build(v, 27163, 'another description')), [], 'the same car: nothing changed');
  assert.deepEqual(listing.listingChanges(build(v, 27163), build(v, 26163)), [{ key: 'price', was: '27163', now: '26163' }]);
  assert.deepEqual(listing.listingChanges(build(v, 27163), build({ ...v, mileage: 21500, exteriorColor: 'Black' }, 27163)).map((c) => c.key), ['mileage', 'exteriorColor']);
  // a branded title the website now mentions takes the title default off
  const branded = listing.listingChanges(build(v, 27163), build({ ...v, descriptionRaw: 'Rebuilt title.' }, 27163));
  assert.ok(branded.some((c) => c.key === 'titleStatus' || c.key === 'cleanTitle'), JSON.stringify(branded));
  assert.deepEqual(listing.listingChanges(null, build(v, 27163)).map((c) => c.key).includes('price'), true, 'no earlier listing: everything is new');
});

test('the listing\'s location is listed as assumed when the website puts the car at a store that may not be at the dealership\'s address', async () => {
  const { carStore } = await import('../extension/src/listingData.js');
  const dealer = { name: 'Sample Auto Group', city: 'Springfield', state: 'OH', zip: '45505' };
  const car = (location) => ({ ...vehicle('usedNormal'), location });
  const opts = (stores) => ({ dealer, price: 20000, stores });
  const location = (d) => d.assumed.find((a) => a.key === 'location');
  // no store ticked, the car at a store whose name does not name the town: check the location
  const away = buildListingData(car('Sample Chevrolet Shelbyville'), opts([]));
  assert.equal(away.fields.location, '45505', 'still filled from the dealership\'s address');
  assert.equal(location(away).value, '45505');
  assert.match(location(away).why, /^your dealership's address; the website lists this car at Sample Chevrolet Shelbyville, so check the location on the form$/);
  // two stores ticked: the same
  assert.ok(location(buildListingData(car('Sample Chevrolet Shelbyville'), opts(['Sample Ford Springfield', 'Sample Chevrolet Shelbyville']))));
  // the one store ticked, a store named for the dealership's town, or no store named: nothing to check
  assert.equal(location(buildListingData(car('Sample Chevrolet Shelbyville'), opts(['Sample Chevrolet Shelbyville']))), undefined);
  assert.equal(location(buildListingData(car('Sample Ford Springfield'), opts([]))), undefined);
  assert.equal(location(buildListingData(car(null), opts([]))), undefined);
  // carStore itself: the town is matched as whole words, any case or accent
  assert.deepEqual(carStore({ location: 'Sample Ford of SPRINGFIELD' }, { dealer }), { store: 'Sample Ford of SPRINGFIELD', away: false });
  assert.deepEqual(carStore({ location: 'Sample Ford Springfieldtown' }, { dealer }), { store: 'Sample Ford Springfieldtown', away: true });
  assert.deepEqual(carStore({ location: 'Sample Ford Mount Pleasant' }, { dealer: { city: 'Mount Pleasant' } }), { store: 'Sample Ford Mount Pleasant', away: false });
  assert.deepEqual(carStore({ location: 'Sample Ford' }, { dealer: {} }), { store: 'Sample Ford', away: true }, 'no town known: it may be anywhere');
  assert.deepEqual(carStore({ location: '  Sample Ford ' }, { stores: ['Sample Ford'] }), { store: '', away: false });
  assert.deepEqual(carStore({}, { stores: [] }), { store: '', away: false });
});

test('on a website whose cars are all at one store, no car is away, ticked or not; a second store brings the check back', async () => {
  const { carStore } = await import('../extension/src/listingData.js');
  const { defaultSettings } = await import('../extension/src/settings.js');
  const { storeNames } = await import('../extension/src/normalize.js');
  // a one-store website whose own name differs from the store name its cars carry: nothing is ticked
  const site = { name: 'Smith Auto Sales', title: 'Used cars | Smith Auto Sales', host: 'www.smithautosales.test', address: { city: 'Springfield', state: 'OH', zip: '45505' } };
  const cars = [1, 2, 3].map(() => ({ ...vehicle('usedNormal'), location: 'Smith Motors' }));
  const s = defaultSettings(site, cars);
  assert.deepEqual(s.myStores, [], 'nothing stands out, so nothing is ticked');
  const opts = (lot) => ({ dealer: s.dealer, defaults: s.defaults, price: 20000, stores: s.myStores, lot });
  const location = (d) => d.assumed.find((a) => a.key === 'location');
  assert.equal(location(buildListingData(cars[0], opts(storeNames(cars)))), undefined, 'the one store is the dealership: its address is where the car is');
  assert.deepEqual(carStore(cars[0], { stores: [], dealer: s.dealer, lot: storeNames(cars) }), { store: 'Smith Motors', away: false });
  // a second store on the website, or a car at a store the last scan did not list: check the location
  const two = [...cars, { ...vehicle('usedNormal'), location: 'Jones Ford Shelbyville' }];
  assert.ok(location(buildListingData(cars[0], opts(storeNames(two)))));
  assert.ok(location(buildListingData({ ...cars[0], location: 'Jones Ford Shelbyville' }, opts(storeNames(cars)))));
  // the side panel passes the last scan as it is stored: its cars by VIN
  const snapshot = Object.fromEntries(cars.map((c, i) => [`VIN${i}`, { name: c.name, location: c.location }]));
  assert.equal(location(buildListingData(cars[0], opts(snapshot))), undefined);
  assert.ok(location(buildListingData(cars[0], opts({ ...snapshot, VIN9: { location: 'Jones Ford Shelbyville' } }))));
  // with no lot to go on (no scan yet), it may be anywhere, as before
  assert.ok(location(buildListingData(cars[0], opts(null))));
  assert.ok(location(buildListingData(cars[0], opts([]))));
  assert.ok(location(buildListingData(cars[0], opts({}))));
  // every listing and description the side panel builds is given the last scan
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const calls = panel.split('\n').filter((line) => /\b(?:buildListingData|generateDescription)\(/.test(line) && !/^\s*(?:import|\/\/)/.test(line));
  assert.ok(calls.length >= 4, calls.join('\n'));
  for (const line of calls) assert.match(line, /lot: state\.snapshotVehicles\b/, line);
  // the README and the help page say so wherever they say when the location is listed as assumed
  for (const doc of ['../README.md', '../docs/help.md']) {
    const said = readFileSync(new URL(doc, import.meta.url), 'utf8').split(/(?<=[.;])\s/).filter((x) => /does not name your town/.test(x));
    assert.ok(said.length, `${doc} says when the location is listed as assumed`);
    for (const x of said) assert.match(x, /the last scan (?:did not find|found) every car on the website at that one store/, `${doc}: ${x}`);
  }
});
