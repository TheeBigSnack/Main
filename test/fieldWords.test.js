// The website's words for the Facebook form's choice fields (fuel, body style,
// transmission, colours, vehicle type), from test/fixtures/field-words.json:
// a word that maps to nothing stays blank and the panel shows the website's
// own words; a value that took a reading is listed under the assumptions with
// the website's words; a trailer, RV, powersport vehicle or boat never reaches
// the car form. Both readers (Dealer Inspire and standard vehicle data) feed
// the same readers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readFuelType, normalizeFuelType, normalizeBodyStyle, readBodyStyle, readTransmission, normalizeTransmission, readColor, normalizeColor, vehicleKind, readVehicleKind, makeKey, buildListingData, FORM_KINDS } from '../extension/src/listingData.js';
import { compareVin, decodeVinOnline, fuelFromDecode } from '../extension/src/vin.js';
import { assessVehicle, DECISION } from '../extension/src/classify.js';
import { recheck } from '../extension/src/vehicleDetails.js';
import { normalizeVehicle as standardVehicle } from '../extension/adapters/schemaOrgNormalize.js';
import { vehicle, fixtures } from './helpers.js';

const WORDS = JSON.parse(readFileSync(new URL('./fixtures/field-words.json', import.meta.url), 'utf8'));

test('fuel: natural gas, propane and hydrogen stay blank; a mild hybrid and gas-plus-electric are readings', () => {
  for (const c of WORDS.fuelType) {
    const r = readFuelType(c.website);
    assert.equal(r.value, c.expect, `"${c.website}"`);
    assert.equal(normalizeFuelType(c.website), c.expect, `"${c.website}"`);
    assert.equal(Boolean(r.why), c.reading, `"${c.website}" reading`);
    if (r.why) assert.ok(r.why.includes(`"${c.website}"`), `the reading quotes the website: ${r.why}`);
  }
});

test('body style: plurals, cab names are trucks, whole words only, and "4dr Car" stays blank', () => {
  for (const c of WORDS.bodyStyle) assert.equal(normalizeBodyStyle(c.website), c.expect, `"${c.website}"`);
});

test('body style: when the field maps to nothing, the body words in the car page address, shown with that source', () => {
  for (const c of WORDS.bodyFromAddress) {
    const r = readBodyStyle({ bodyType: c.bodyType, url: c.url });
    assert.equal(r.value, c.expect, `${c.bodyType} ${c.url}`);
    if (c.words) {
      assert.match(r.why, new RegExp(`page address \\("${c.words}"\\)`), r.why);
      assert.match(r.why, c.bodyType ? new RegExp(`says "${c.bodyType}"`) : /gives no body style/, r.why);
    } else {
      assert.equal(r.why, '', `no reading for ${c.url}`);
    }
  }
});

test('transmission: dual-clutch is automatic, the first word wins, single-speed is automatic only on an electric car', () => {
  for (const c of WORDS.transmission) {
    const r = readTransmission(c.website, { fuel: c.fuel });
    assert.equal(r.value, c.expect, `"${c.website}" (${c.fuel || 'no fuel'})`);
    assert.equal(normalizeTransmission(c.website, { fuel: c.fuel }), c.expect);
    assert.equal(Boolean(r.why), c.reading, `"${c.website}" reading`);
  }
});

test('colour: a list word the website states wins; a shade name is a reading; anything else stays blank', () => {
  for (const c of WORDS.color) {
    const r = readColor(c.website);
    assert.equal(r.value, c.expect, `"${c.website}"`);
    assert.equal(normalizeColor(c.website), c.expect);
    assert.equal(Boolean(r.why), c.reading, `"${c.website}" reading`);
  }
});

test('vehicle kinds: trailers, RVs, powersport vehicles and boats are told apart from cars and motorcycles', () => {
  for (const c of WORDS.vehicleKind) assert.equal(vehicleKind({ bodyType: c.bodyType, make: c.make }), c.expect, `${c.bodyType} / ${c.make}`);
  assert.deepEqual([...FORM_KINDS], ['car_truck', 'motorcycle']);
});

test('the VIN check reads the decode\'s electrification level, and a second fuel of Electric is a hybrid', async () => {
  for (const c of WORDS.vinFuel) {
    assert.equal(fuelFromDecode(c.decoded), c.vin, JSON.stringify(c.decoded));
    const row = compareVin({ fuelType: c.website }, c.decoded).rows.find((r) => r.field === 'Fuel');
    assert.equal(row.verdict, c.verdict, `${c.website} vs ${JSON.stringify(c.decoded)}`);
  }
  // the pilot lot's mild hybrids against a decode that names only the two fuels: no false difference
  const row = compareVin(vehicle('certified'), { fuelType: 'Gasoline', fuelTypeSecondary: 'Electric' }).rows.find((r) => r.field === 'Fuel');
  assert.equal(row.verdict, 'agree');
  // decodeVinOnline reads ElectrificationLevel, and the comparison shows it
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ Results: [{ Make: 'SAMPLE', ModelYear: '2024', FuelTypePrimary: 'Electric', FuelTypeSecondary: '', ElectrificationLevel: 'BEV (Battery Electric Vehicle)', TransmissionStyle: 'Automatic', TransmissionSpeeds: '1', ErrorCode: '0' }] }) });
  const { decoded } = await decodeVinOnline('1FTSAMPL9LE000001', { fetchImpl });
  assert.equal(decoded.electrificationLevel, 'BEV (Battery Electric Vehicle)');
  const ev = compareVin({ fuelType: 'Electric', transmission: '1-Speed' }, decoded);
  assert.equal(ev.rows.find((r) => r.field === 'Fuel').vin, 'Electric (BEV (Battery Electric Vehicle))');
  assert.equal(ev.rows.find((r) => r.field === 'Transmission').verdict, 'agree', 'an electric car\'s single speed agrees with an automatic decode');
});

test('the listing: a mild hybrid is filled as Hybrid and listed as assumed with the website\'s wording', () => {
  const d = buildListingData(vehicle('certified')); // a real record: "Gasoline/Mild Electric Hybrid"
  assert.equal(d.fields.fuelType, 'Hybrid');
  const fuel = d.assumed.find((a) => a.key === 'fuelType');
  assert.equal(fuel.value, 'Hybrid');
  assert.match(fuel.why, /^the website says "Gasoline\/Mild Electric Hybrid": a mild hybrid/);
  assert.deepEqual(d.assumed.map((a) => a.key), ['fuelType', 'condition', 'titleStatus'], 'readings come before the dealership defaults');
});

test('the listing: a word that maps to nothing stays blank, is missing, and the panel has the website\'s words', () => {
  const v = vehicle('usedNormal', { body_details: { type: 'Cars' }, mechanical: { fuel_type: 'Compressed Natural Gas', transmission: '1-Speed' }, vdp_url: 'https://dealer.example/inventory/used-2019-sample-4wd-1sampl0000000001/' });
  const d = buildListingData(v);
  assert.equal(d.fields.fuelType, '', 'natural gas is never Gasoline');
  assert.equal(d.fields.bodyStyle, '', 'no body words anywhere');
  assert.equal(d.fields.transmission, '', 'a single speed on a car that is not electric');
  for (const k of ['bodyStyle', 'fuelType', 'transmission']) assert.ok(d.missing.includes(k), k);
  assert.equal(d.source.fuelType, 'Compressed Natural Gas');
  assert.equal(d.source.bodyStyle, 'Cars', 'the source is keyed by the form field the panel shows');
  assert.equal(d.source.transmission, '1-Speed');
  assert.deepEqual(d.assumed.map((a) => a.key), ['condition', 'titleStatus'], 'nothing blank is listed as assumed');
});

test('the listing: the body style from the page address is filled and listed as assumed with that source', () => {
  const v = vehicle('usedNormal', { body_details: { type: 'Cars' } }); // its address ends ...-4d-quad-cab-<vin>/
  const d = buildListingData(v);
  assert.equal(d.fields.bodyStyle, 'Truck');
  assert.match(d.assumed.find((a) => a.key === 'bodyStyle').why, /page address \("quad-cab"\); its body style field says "Cars"/);
});

test('the standard vehicle data reader\'s fields go through the same readers', () => {
  const node = {
    '@type': 'Car', vehicleIdentificationNumber: '1FTSAMPL9LE000001', name: '2024 Sample Model', url: 'https://dealer.example/inventory/used-2024-sample-model-awd-4d-sport-utility-1ftsampl9le000001/',
    bodyType: 'Cars', fuelType: 'Compressed Natural Gas', vehicleTransmission: '7-Speed Dual-Clutch', color: 'Pewter', vehicleInteriorColor: 'Titanium',
  };
  const v = standardVehicle(node, { url: node.url });
  const d = buildListingData(v);
  assert.equal(d.fields.bodyStyle, 'SUV');
  assert.equal(d.fields.fuelType, '');
  assert.equal(d.fields.transmission, 'Automatic');
  assert.equal(d.fields.exteriorColor, 'Gray');
  assert.equal(d.fields.interiorColor, '');
  assert.deepEqual(d.assumed.map((a) => a.key), ['bodyStyle', 'exteriorColor', 'condition', 'titleStatus']);
  // the same words through the Dealer Inspire reader give the same fields
  const di = buildListingData(vehicle('usedNormal', { body_details: { type: 'Cars' }, mechanical: { fuel_type: 'Compressed Natural Gas', transmission: '7-Speed Dual-Clutch' }, styles: { exterior_color: 'Pewter', interior_color: 'Titanium' }, vdp_url: node.url }));
  for (const k of ['bodyStyle', 'fuelType', 'transmission', 'exteriorColor', 'interiorColor']) assert.equal(di.fields[k], d.fields[k], k);
  // a trailer from standard data is not a car
  const trailer = standardVehicle({ ...node, '@type': 'Vehicle', bodyType: 'Trailer' }, { url: node.url });
  assert.equal(vehicleKind(trailer), 'trailer');
});

test('a trailer, RV, powersport vehicle or boat never reaches the car form', () => {
  const kinds = { Trailer: 'a trailer', 'Travel Trailer': 'an RV or camper', ATV: 'a powersport vehicle', Pontoon: 'a boat' };
  for (const [body, name] of Object.entries(kinds)) {
    // a record every other check calls ready to post
    const v = vehicle('usedNormal', { body_details: { type: body } });
    const a = assessVehicle(v, {});
    assert.equal(a.decision, DECISION.REVIEW, body);
    assert.equal(a.reason, `The website's body style "${body}" makes it ${name}. Lot Current fills in only Marketplace's car/truck and motorcycle forms, so it stays off the posting list.`);
    // the post-time re-check says the same, not that the details stopped adding up
    const r = recheck(v, {});
    assert.equal(r.ok, false);
    assert.equal(r.message, a.reason);
    // and the form data has no vehicle type for it, with the reason for the person
    const d = buildListingData(v);
    assert.equal(d.fields.vehicleType, '');
    assert.ok(d.missing.includes('vehicleType'));
    assert.match(d.leftBlank.find((b) => b.key === 'vehicleType').why, new RegExp(`makes it ${name}`));
  }
  // a make that builds only RVs, with no body style
  assert.match(assessVehicle(vehicle('usedNormal', { make: 'Winnebago', body_details: { type: '' } }), {}).reason, /make "Winnebago" makes it an RV or camper/);
  // a van body from a maker of RVs is a camper van, and stays off the car form; a van from a car maker is a car
  const camper = vehicle('usedNormal', { make: 'Winnebago', model: 'Travato', body_details: { type: 'Van' } });
  assert.equal(assessVehicle(camper, {}).decision, DECISION.REVIEW);
  assert.match(assessVehicle(camper, {}).reason, /make "Winnebago" with body style "Van" makes it an RV or camper/);
  assert.equal(buildListingData(camper).fields.vehicleType, '');
  assert.equal(buildListingData(vehicle('usedNormal', { body_details: { type: 'Van' } })).fields.vehicleType, 'car_truck');
  // a new one is still skipped as new
  assert.equal(assessVehicle(vehicle('newNormal', { body_details: { type: 'Trailer' } }), {}).decision, DECISION.SKIP);
  // cars and trucks are untouched
  assert.equal(assessVehicle(vehicle('usedNormal'), {}).decision, DECISION.READY);
  assert.equal(buildListingData(vehicle('usedNormal')).fields.vehicleType, 'car_truck');
});

test('no car make is caught by a trailer, RV, powersport, boat or motorcycle make list', () => {
  const makes = new Set(WORDS.carMakes);
  for (const [name, r] of Object.entries(fixtures)) if (name !== '_about' && r.make) makes.add(r.make);
  const sandbox = vm.createContext({ window: {}, URL });
  vm.runInContext(readFileSync(new URL('../demo/site/inventory.js', import.meta.url), 'utf8'), sandbox);
  for (const v of sandbox.window.LOT_SYNC_INVENTORY.records('day2')) makes.add(v.make);
  assert.ok(makes.size > 55);
  for (const make of makes) {
    const k = readVehicleKind({ make, bodyType: '' });
    assert.equal(k.kind, 'car_truck', `${make}: ${k.from}`);
    assert.equal(k.fromMake, false, make);
  }
  assert.equal(makeKey('Thor Motor Coach, Inc.'), 'thor');
  assert.equal(makeKey('Can-Am'), 'can am');
  assert.equal(makeKey('Mercedes-Benz'), 'mercedes benz');
});

test('a motorcycle read only from its make is filled but listed as assumed; a motorcycle body style is not', () => {
  const byMake = buildListingData({ make: 'Yamaha', bodyType: '' });
  assert.equal(byMake.fields.vehicleType, 'motorcycle');
  const a = byMake.assumed.find((x) => x.key === 'vehicleType');
  assert.equal(a.value, 'Motorcycle');
  assert.match(a.why, /^read from the website's make "Yamaha"; no body style says it is a motorcycle/);
  const byBody = buildListingData({ make: 'Yamaha', bodyType: 'Motorcycle' });
  assert.equal(byBody.fields.vehicleType, 'motorcycle');
  assert.equal(byBody.assumed.find((x) => x.key === 'vehicleType'), undefined);
});

// canAutoOpen, run as written with the rest of the panel replaced by stubs
// (as test/photoHosts.test.js does): a queued car opens the form by itself
// only when nothing but the dealership's own defaults was assumed.
test('the queue holds a car at review when anything besides the dealership defaults was assumed', () => {
  const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = src.search(/function canAutoOpen\(/);
  assert.ok(start >= 0, 'canAutoOpen is defined');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 2);
  const make = new Function('state', 'currentListing', 'dailyCap', 'photoPatterns', 'refusedPhotoServers', `${body}\nreturn canAutoOpen;`);
  const opens = (listing) => make({ guardrails: { ok: true }, vinCheck: { local: { ok: true } } }, () => listing, () => ({ reached: false }), () => [], new Set())();
  // the salesperson ticked their store, the one the website lists the pilot's Ram at
  const options = { dealer: { zip: '45505' }, description: 'Written from the facts.', price: 20000, photos: ['https://img.example/1.jpg'], stores: [vehicle('usedNormal').location] };
  // the pilot's Ram: only the dealership defaults are assumed, so it opens
  assert.equal(opens(buildListingData(vehicle('usedNormal'), options)), true);
  // each of these used to be blank (and so held at review); now filled, it must still stop there
  const held = {
    'body style from the page address': vehicle('usedNormal', { body_details: { type: 'Cars' } }),
    'a shade name (Sepia)': vehicle('usedNormal', { styles: { interior_color: 'Sepia' } }),
    'a shade name (Pewter Metallic)': vehicle('usedNormal', { styles: { exterior_color: 'Pewter Metallic' } }),
    'two colors run together (Black Forest Green)': vehicle('usedNormal', { styles: { exterior_color: 'Black Forest Green' } }),
    "an electric car's single speed": vehicle('usedNormal', { mechanical: { fuel_type: 'Electric', transmission: '1-Speed' } }),
    'a mild hybrid': vehicle('certified'),
  };
  for (const [what, v] of Object.entries(held)) {
    const listing = buildListingData(v, options);
    assert.deepEqual(listing.missing, [], `${what}: nothing is blank`);
    assert.equal(opens(listing), false, `${what}: the car waits at review`);
  }
  // a motorcycle read from its make, and only the defaults
  assert.equal(opens({ missing: [], assumed: [{ key: 'vehicleType' }, { key: 'condition' }] }), false);
  assert.equal(opens({ missing: [], assumed: [{ key: 'condition' }, { key: 'titleStatus' }] }), true);
  // a colour guessed from the photos is assumed too
  const guessed = buildListingData(vehicle('usedNormal', { styles: { exterior_color: '' } }), { ...options, guesses: { exterior: 'Blue', confidence: 'high' } });
  assert.deepEqual(guessed.missing, []);
  assert.equal(opens(guessed), false, 'a photo guess waits at review');
  // a branded title in the website's own words: the title is left for the person, so the car waits at review
  const branded = buildListingData(vehicle('usedNormal', { description: 'Salvaged title, sold as is.' }), options);
  assert.equal(branded.branded, 'Salvaged');
  assert.deepEqual(branded.missing, ['titleStatus'], 'only the title is blank');
  assert.equal(branded.fields.cleanTitle, 'no');
  assert.equal(opens(branded), false, 'a branded title waits at review');
});
