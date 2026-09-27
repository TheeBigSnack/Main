import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildListingData, vehicleKind, normalizeColor, normalizeBodyStyle, normalizeTransmission, normalizeFuelType, locationQuery, locationExpect, STATE_NAMES, LEFT_BLANK } from '../extension/src/listingData.js';
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
    mileage: '20986',
    price: '27163',
    bodyStyle: 'Truck',
    exteriorColor: 'Blue',
    interiorColor: 'Gray',
    fuelType: 'Gasoline',
    transmission: 'Automatic',
    location: '15370',
    description: 'Hello.',
  });
  assert.deepEqual(d.missing, []);
  assert.equal(d.photos.length, 1);
  assert.deepEqual(d.leftBlank.map((b) => b.key), ['condition', 'titleStatus']);
  assert.equal(LEFT_BLANK.length, 2);
});

test('blank values are reported, never guessed', () => {
  const v = vehicle('usedNoCarfax', { styles: { interior_color: 'Sepia' }, mechanical: { fuel_type: 'Unknown' } });
  const d = buildListingData(v, { dealer: {}, price: null });
  assert.equal(d.fields.interiorColor, '');
  assert.equal(d.fields.fuelType, '');
  assert.equal(d.fields.location, '');
  assert.equal(d.fields.price, '');
  assert.deepEqual(d.missing, ['price', 'interiorColor', 'fuelType', 'location', 'description']);
  assert.equal(d.source.interiorColor, 'Sepia');
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
  assert.deepEqual(locationExpect({}), { alternatives: [], strict: false });
  assert.equal(STATE_NAMES.PA, 'Pennsylvania');
  assert.equal(Object.keys(STATE_NAMES).length, 51);
  assert.equal(buildListingData(vehicle('usedNormal'), { dealer: DEALER }).match.location.strict, true);
});
