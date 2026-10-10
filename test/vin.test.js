import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vinCheckDigit, checkVinFormat, modelYearFromVin, modelYearReadings, manufacturerFromVin, MANUFACTURERS, localVinCheck, decodeVinOnline, compareVin, compareSummary, normalizeVin } from '../extension/src/vin.js';
import { fixtures, vehicle } from './helpers.js';

test('every real VIN from the site has a correct check digit and decodes to its model year', () => {
  for (const [name, r] of Object.entries(fixtures)) {
    if (name === '_about') continue;
    assert.equal(vinCheckDigit(r.vin), r.vin[8], `${name} ${r.vin}`);
    assert.equal(checkVinFormat(r.vin).ok, true, name);
    assert.equal(modelYearFromVin(r.vin), r.year, `${name} ${r.vin}`);
  }
});

test('typos and impossible VINs are caught', () => {
  assert.equal(checkVinFormat('1C6RR7FT0KS64328').ok, false); // 16 chars
  assert.match(checkVinFormat('1C6RR7FT0KS64328').problems[0], /16 characters/);
  assert.equal(checkVinFormat('1C6RR7FTOKS643289').ok, false); // letter O
  const typo = checkVinFormat('1C6RR7FT0KS643298'); // last two digits swapped
  assert.equal(typo.ok, false);
  assert.match(typo.problems[0], /check digit/);
  // a car built outside North America for the US market carries a check digit too, so a mismatch is a problem
  const jp = checkVinFormat('JTDKN3DU0A0000000');
  assert.equal(jp.ok, false);
  assert.match(jp.problems[0], /check digit is 0 but should be \d: most likely a typo in the VIN .*outside North America.*check the VIN plate/);
  assert.equal(normalizeVin(' 1c6rr7ft0ks643289 '), '1C6RR7FT0KS643289');
  assert.equal(modelYearFromVin('nope'), null);
});

test('model year codes: the letter series (2010+) and the digit series', () => {
  assert.equal(modelYearFromVin('1C6RR7FT0KS643289'), 2019); // K with a letter in position 7
  assert.equal(modelYearFromVin('1C6RR77T0KS643289'), 1989); // K with a digit in position 7 (check digit not asserted here)
  assert.equal(modelYearFromVin('1C4RJHBR3V8166889'), 2027);
});

test('manufacturer groups from the VIN', () => {
  assert.equal(manufacturerFromVin('1C6RR7FT0KS643289').group, 'Stellantis');
  assert.equal(manufacturerFromVin('5FNYG1H78PB014309').group, 'Honda');
  assert.equal(manufacturerFromVin('1HD1KHM10FB600000').group, 'Harley-Davidson');
  assert.equal(manufacturerFromVin('5NPE24AF0FH000000').group, 'Hyundai Motor Group');
  assert.equal(manufacturerFromVin('5N1AT2MV0FC000000').group, 'Nissan');
  assert.equal(manufacturerFromVin('1G1ZD5ST0JF000000').group, 'General Motors');
  assert.equal(manufacturerFromVin('XXXXXXXXXXXXXXXXX'), null);
});

test('a plant code is read by its longest prefix: common cars built where another maker\'s short code matches are not flagged', () => {
  // each VIN has a correct check digit and model year
  const agree = [
    ['KNMAT2MV6FP500001', 'Nissan', 2015, 'Renault Samsung'], // Rogue built in Busan
    ['3CZRU6H55GM700001', 'Honda', 2016, 'Honda'], // HR-V built in Mexico, not Stellantis's 3C
    ['1YVHP80C495M00001', 'Mazda', 2009, 'Mazda'], // Mazda6 from AutoAlliance, not GM's 1Y
    ['3MYDLBYV4KY500001', 'Toyota', 2019, 'Mazda'], // Yaris sedan built by Mazda de Mexico
    ['3MYDLBZV1GY100001', 'Scion', 2016, 'Mazda'], // Scion iA, same plant
    ['2CNALDEW8A6200001', 'Chevrolet', 2010, 'General Motors'], // Equinox from GM's Canadian plant, not Stellantis's 2C
    ['2CTALDEW7A6200001', 'GMC', 2010, 'General Motors'], // Terrain, same plant
    ['JF1ZNAA10D1700001', 'Scion', 2013, 'Subaru'], // FR-S built by Subaru
  ];
  for (const [vin, make, year, group] of agree) {
    const r = localVinCheck({ vin, make, year });
    assert.equal(r.ok, true, `${make} ${vin}: ${r.problems.map((p) => p.detail).join('; ')}`);
    assert.equal(r.manufacturer, group, vin);
  }
  // the plants' own makes still agree, and a make none of them builds is still flagged
  assert.equal(localVinCheck({ vin: '3MYDLBYV4KY500001', make: 'Mazda', year: 2019 }).ok, true);
  assert.equal(localVinCheck({ vin: 'KNMAT2MV6FP500001', make: 'Kia', year: 2015 }).ok, false);
  assert.equal(localVinCheck({ vin: '3CZRU6H55GM700001', make: 'Jeep', year: 2016 }).ok, false);
});

test('a Corolla built by NUMMI and a City Express built by Nissan agree with their make; Honda motorcycle codes read the motorcycle year', () => {
  const valid = (vin) => vin.slice(0, 8) + vinCheckDigit(vin) + vin.slice(9);
  const corolla = localVinCheck({ vin: '1NXBR32E75Z500001', make: 'Toyota', year: 2005 });
  assert.equal(corolla.ok, true, corolla.problems.map((p) => p.detail).join('; '));
  assert.equal(corolla.manufacturer, 'Toyota', "NUMMI's 1NX is not Nissan's 1N");
  assert.equal(localVinCheck({ vin: '1NXBR32E75Z500001', make: 'Nissan', year: 2005 }).ok, false);
  const cityExpress = localVinCheck({ vin: valid('3N63M0YN5FK700001'), make: 'Chevrolet', year: 2015, bodyType: 'Van' });
  assert.equal(cityExpress.ok, true, cityExpress.problems.map((p) => p.detail).join('; '));
  assert.equal(localVinCheck({ vin: valid('3N63M0YN5FK700001'), make: 'Nissan', year: 2015, bodyType: 'Van' }).ok, true);
  assert.equal(localVinCheck({ vin: valid('3N63M0YN5FK700001'), make: 'Ford', year: 2015, bodyType: 'Van' }).ok, false);
  // Nissan's own codes stay Nissan's
  assert.equal(localVinCheck({ vin: valid('1N4AL3AP5JC100001'), make: 'Toyota', year: 2018 }).ok, false);
  // a Honda motorcycle whose body style says nothing of a motorcycle, from Japan (JH2) or Ohio (1HF)
  const year = (vehicle) => localVinCheck(vehicle).checks.find((c) => c.code === 'year');
  for (const vehicle of [
    { vin: valid('JH2PC40J0DK000001'), make: 'Honda', year: 2013, bodyType: '' },
    { vin: valid('JH2PC40J0DK000001'), make: 'Honda', year: 2013, bodyType: 'Cruiser' },
    { vin: valid('1HFSC5200EA000001'), make: 'Honda', year: 2014, bodyType: 'Touring' },
  ]) {
    const r = localVinCheck(vehicle);
    assert.equal(r.ok, true, `${vehicle.vin}: ${r.problems.map((p) => p.detail).join('; ')}`);
    assert.equal(year(vehicle).detail, `${vehicle.year}, website agrees`);
  }
  // Honda's car codes keep the car rule for position 7
  assert.equal(year({ vin: valid('2HGFC2F50GH000001'), make: 'Honda', year: 1986, bodyType: 'Sedan' }).detail, 'VIN says 2016, the website says 1986');
});

test('no prefix in the manufacturer table is hidden by another row', () => {
  const owner = new Map();
  for (const [prefixes, group] of MANUFACTURERS) {
    for (const p of prefixes) {
      assert.ok(!owner.has(p) || owner.get(p) === group, `${p} is listed for both ${owner.get(p)} and ${group}`);
      owner.set(p, group);
      const vin = (p + '0'.repeat(17)).slice(0, 17);
      assert.equal(manufacturerFromVin(vin).group, group, `${p} resolves to ${group}, the row that lists it`);
    }
  }
});

test('local check: the Ram agrees on year and maker; a wrong year or make is flagged', () => {
  const good = localVinCheck(vehicle('usedNormal'));
  assert.equal(good.ok, true);
  assert.deepEqual(good.checks.map((c) => c.ok), [true, true, true]);
  assert.equal(good.vinYear, 2019);
  assert.equal(good.manufacturer, 'Stellantis');

  const wrongYear = localVinCheck(vehicle('usedNormal', { year: 2018 }));
  assert.equal(wrongYear.ok, false);
  assert.match(wrongYear.problems[0].detail, /VIN says 2019, the website says 2018/);

  const wrongMake = localVinCheck(vehicle('usedNormal', { make: 'Chevrolet' }));
  assert.equal(wrongMake.ok, false);
  assert.match(wrongMake.problems[0].detail, /Stellantis, but the website says Chevrolet/);

  const typo = localVinCheck(vehicle('usedNormal', { vin: '1C6RR7FT0KS643298' }));
  assert.equal(typo.ok, false);
  assert.equal(typo.checks[0].ok, false);
});

const nhtsa = (results) => async () => ({ ok: true, status: 200, json: async () => ({ Count: 1, Results: [results] }) });
const RAM = { Make: 'RAM', Model: '1500 Classic', ModelYear: '2019', Trim: 'Express', BodyClass: 'Pickup', VehicleType: 'TRUCK', FuelTypePrimary: 'Gasoline', FuelTypeSecondary: '', DisplacementL: '5.7', EngineCylinders: '8', EngineModel: 'HEMI', DriveType: '4WD/4-Wheel Drive/4x4', TransmissionStyle: 'Automatic', TransmissionSpeeds: '8', Doors: '4', PlantCountry: 'UNITED STATES (USA)', ErrorCode: '0', ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct' };

test('the NHTSA decode is read into a flat record', async () => {
  const r = await decodeVinOnline('1C6RR7FT0KS643289', { fetchImpl: nhtsa(RAM) });
  assert.equal(r.ok, true);
  assert.equal(r.decoded.make, 'RAM');
  assert.equal(r.decoded.year, 2019);
  assert.equal(r.decoded.engine, '5.7L 8 cyl HEMI');
  assert.equal(r.decoded.transmission, 'Automatic 8-speed');
  const fail = await decodeVinOnline('1C6RR7FT0KS643289', { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(fail.ok, false);
  const boom = await decodeVinOnline('x', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.match(boom.error, /offline/);
});

test('website vs VIN comparison: agreement, a difference, and blanks', async () => {
  const { decoded } = await decodeVinOnline('1C6RR7FT0KS643289', { fetchImpl: nhtsa(RAM) });
  const c = compareVin(vehicle('usedNormal'), decoded);
  assert.equal(c.ok, true, JSON.stringify(c.differ));
  assert.deepEqual(c.rows.map((r) => `${r.field}:${r.verdict}`), ['Year:agree', 'Make:agree', 'Model:agree', 'Body:agree', 'Fuel:agree', 'Drive:agree', 'Transmission:agree', 'Engine:info']);

  const off = compareVin(vehicle('usedNormal', { mechanical: { fuel_type: 'Diesel Fuel' }, year: 2018 }), decoded);
  assert.equal(off.ok, false);
  assert.deepEqual(off.differ.map((r) => r.field), ['Year', 'Fuel']);

  const blank = compareVin(vehicle('usedNormal', { mechanical: { transmission: '' } }), { ...decoded, model: '' });
  assert.equal(blank.rows.find((r) => r.field === 'Transmission').verdict, 'unknown');
  assert.equal(blank.rows.find((r) => r.field === 'Model').verdict, 'unknown');
});

test('the model is compared without its punctuation: "F150" and "F-150", "CRV" and "CR-V", "Rav 4" and "RAV4" agree; another model still differs', () => {
  const verdict = (model, decodedModel, trim = '') => compareVin({ model, trim }, { model: decodedModel }).rows.find((r) => r.field === 'Model').verdict;
  const agree = [['F150', 'F-150'], ['F-150', 'F150'], ['CRV', 'CR-V'], ['CX5', 'CX-5'], ['HRV', 'HR-V'], ['Rav 4', 'RAV4'], ['RAV4', 'RAV 4'], ['F 150', 'F-150'], ['1500 Classic', '1500 Classic']];
  for (const [website, decodedModel] of agree) assert.equal(verdict(website, decodedModel), 'agree', `${website} / ${decodedModel}`);
  assert.equal(verdict('F150', 'F-150', 'XLT'), 'agree', 'the trim beside the model');
  for (const [website, decodedModel] of [['F-150', 'F-250'], ['F150', 'F-250'], ['Grand Cherokee', 'Wrangler'], ['Sierra 2500HD', 'Sierra 1500'], ['CX-5', 'CX-9']]) {
    assert.equal(verdict(website, decodedModel), 'differ', `${website} / ${decodedModel}`);
  }
});

test('a website model with words the decode does not confirm is only partly confirmed, never "agrees"', () => {
  const model = (vehicle, decoded) => compareVin(vehicle, decoded).rows.find((r) => r.field === 'Model');
  const pairs = [['Grand Cherokee', 'Cherokee', ['Grand']], ['Bronco Sport', 'Bronco', ['Sport']], ['Transit Connect', 'Transit', ['Connect']], ['Grand Highlander', 'Highlander', ['Grand']], ['Grand Caravan', 'Caravan', ['Grand']], ['Santa Fe Sport', 'Santa Fe', ['Sport']], ['Silverado 1500', 'Silverado', ['1500']], ['Wrangler Unlimited', 'Wrangler', ['Unlimited']]];
  for (const [website, decodedModel, extra] of pairs) {
    const c = compareVin({ year: 2019, make: 'Example', model: website }, { year: 2019, make: 'EXAMPLE', model: decodedModel });
    const row = c.rows.find((r) => r.field === 'Model');
    assert.equal(row.verdict, 'partly', `${website} / ${decodedModel}`);
    assert.deepEqual(row.extra, extra, `${website} / ${decodedModel}`);
    // not a difference: the two sides word models differently, so nothing turns red
    assert.equal(c.ok, true);
    assert.deepEqual(c.partly, [row]);
    const summary = compareSummary(c);
    assert.ok(!summary.some((line) => /agrees with the website on everything it knows/.test(line)), summary.join(' '));
    assert.deepEqual(summary, [`NHTSA's model is "${decodedModel}"; the website says "${website}", and NHTSA does not confirm "${extra.join(' ')}". Check the car before posting.`, 'NHTSA agrees with the website on everything else it knows about this VIN.']);
  }
  // a word NHTSA does decode, in the model, its series or trim, or the make, is confirmed
  assert.equal(model({ make: 'Ram', model: 'Ram 1500' }, { make: 'RAM', model: '1500' }).verdict, 'agree');
  assert.equal(model({ make: 'Chevrolet', model: 'Silverado 1500' }, { make: 'CHEVROLET', model: 'Silverado', series: '1500' }).verdict, 'agree');
  assert.equal(model({ make: 'Jeep', model: 'Wrangler Unlimited' }, { make: 'JEEP', model: 'Wrangler', trim: 'Unlimited Sahara' }).verdict, 'agree');
  assert.equal(model({ make: 'Toyota', model: 'Rav 4' }, { make: 'TOYOTA', model: 'RAV4' }).verdict, 'agree');
  // the other way round is still a difference
  assert.equal(model({ make: 'Jeep', model: 'Cherokee' }, { make: 'JEEP', model: 'Grand Cherokee' }).verdict, 'differ');
  // nothing to look at: the usual line; a difference: the count first
  assert.deepEqual(compareSummary(compareVin({ year: 2019, make: 'Ram', model: '1500' }, { year: 2019, make: 'RAM', model: '1500' })), ['NHTSA agrees with the website on everything it knows about this VIN.']);
  const both = compareSummary(compareVin({ year: 2018, make: 'Jeep', model: 'Grand Cherokee' }, { year: 2019, make: 'JEEP', model: 'Cherokee' }));
  assert.equal(both.length, 2);
  assert.match(both[0], /^1 difference\(s\) between the website and the VIN/);
  assert.match(both[1], /does not confirm "Grand"/);
  // a comparison saved before rows could be partly reads as before
  assert.deepEqual(compareSummary({ ok: true, differ: [] }), ['NHTSA agrees with the website on everything it knows about this VIN.']);
});

test('a check-digit typo is caught whatever country built the car; a correct non-North-American VIN passes', () => {
  const valid = (vin) => vin.slice(0, 8) + vinCheckDigit(vin) + vin.slice(9);
  const cars = [
    [valid('WBA8E9G50GNT12345'), 'BMW', 2016],
    [valid('JTDKN3DU0A1000001'), 'Toyota', 2010],
    [valid('KMHD84LF0HU000001'), 'Hyundai', 2017],
    [valid('3VWDB7AJ0HM000001'), 'Volkswagen', 2017],
  ];
  for (const [vin, make, year] of cars) {
    const good = localVinCheck({ vin, make, year });
    assert.equal(good.ok, true, `${vin}: ${good.problems.map((p) => p.detail).join('; ')}`);
    assert.equal(good.checks[0].detail, '17 characters, check digit correct');
    // one character off, as a typo in the inventory system would be
    const last = vin[16] === '1' ? '2' : '1';
    const typo = vin.slice(0, 16) + last;
    const r = localVinCheck({ vin: typo, make, year });
    assert.equal(r.ok, false, typo);
    assert.equal(r.checks[0].ok, false, typo);
    assert.match(r.checks[0].detail, /check digit is .* but should be .*typo in the VIN/, typo);
  }
});

test('a motorcycle\'s model year is read without the car rule for position 7: a 2014 with a digit there agrees; a car still differs', () => {
  const valid = (vin) => vin.slice(0, 8) + vinCheckDigit(vin) + vin.slice(9);
  const year = (vehicle) => localVinCheck(vehicle).checks.find((c) => c.code === 'year');
  // a digit in position 7 and E in position 10: 1984 by the car rule, 1984 or 2014 for a motorcycle
  for (const vehicle of [
    { vin: valid('JYAVP27E0EA000000'), make: 'Yamaha', year: 2014, bodyType: 'Motorcycle' },
    { vin: valid('JYAVP27E0EA000000'), make: 'Yamaha', year: 2014, bodyType: '' }, // a motorcycle maker's VIN
    { vin: valid('JS1GT78A0E2100001'), make: 'Suzuki', year: 2014, bodyType: '' }, // Suzuki's motorcycle code
    { vin: valid('JH2PC40J0DK000001'), make: 'Honda', year: 2013, bodyType: 'Motorcycle' }, // a car maker's motorcycle, by its body style
  ]) {
    const r = localVinCheck(vehicle);
    assert.equal(r.ok, true, `${vehicle.vin}: ${r.problems.map((p) => p.detail).join('; ')}`);
    assert.equal(year(vehicle).detail, `${vehicle.year}, website agrees`);
    assert.equal(r.vinYear, vehicle.year);
  }
  const off = year({ vin: valid('JYAVP27E0EA000000'), make: 'Yamaha', year: 1999, bodyType: 'Motorcycle' });
  assert.equal(off.ok, false);
  assert.equal(off.detail, 'VIN says 1984 or 2014, the website says 1999');
  // a car or light truck keeps the position-7 rule
  const truck = localVinCheck({ vin: valid('1C6RR77T0ES643289'), make: 'Ram', year: 2014, bodyType: 'Truck' });
  assert.equal(truck.ok, false);
  assert.equal(year({ vin: valid('1C6RR77T0ES643289'), make: 'Ram', year: 2014, bodyType: 'Truck' }).detail, 'VIN says 1984, the website says 2014');
  assert.deepEqual(modelYearReadings(valid('JYAVP27E0EA000000'), { lightVehicle: false }), [1984, 2014]);
  assert.deepEqual(modelYearReadings('1C6RR7FT0KS643289'), [2019]);
});
