import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vinCheckDigit, checkVinFormat, modelYearFromVin, manufacturerFromVin, localVinCheck, decodeVinOnline, compareVin, normalizeVin } from '../extension/src/vin.js';
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
  // a Japanese-built VIN without a matching check digit is only a note
  const jp = checkVinFormat('JTDKN3DU0A0000000');
  assert.equal(jp.ok, true);
  assert.equal(jp.notes.length, 1);
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
