// VIN checks. The VIN is the one identifier the manufacturer stamped on the
// car, so it is the right thing to double-check the website's record against.
//
// Local checks need no network: format, check digit, model year (from the
// 10th character) and the manufacturer group (from the first characters).
// The full decode (make, model, body, fuel, engine, drive) comes from NHTSA's
// free vPIC service and needs the vpic.nhtsa.dot.gov permission, which the
// salesperson grants in Chrome the first time they click Check VIN.
//
// The VIN never overwrites the website's data by itself. It flags
// disagreements for a person to look at (facts only, and the website is
// still the source the dealer controls).

import { normalizeBodyStyle, normalizeFuelType, normalizeTransmission, readVehicleKind, VEHICLE_KIND } from './listingData.js';

const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789'; // 1980-2009, then again 2010-2039

export function normalizeVin(vin) {
  return String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function vinCheckDigit(vin) {
  const v = normalizeVin(vin);
  if (v.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const ch = v[i];
    const val = /\d/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (val === undefined) return null;
    sum += val * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

// Every vehicle built for sale in the US carries a check digit in position 9
// (49 CFR 565), wherever it was made, and Canada's rule follows the US one,
// so a mismatch is a problem whatever the first character: most likely a
// typo. Only a car built for a market outside North America may lack one,
// and the VIN plate settles it. (`notes` is kept, empty, for callers that read it.)
export function checkVinFormat(vin) {
  const v = normalizeVin(vin);
  const problems = [];
  const notes = [];
  if (v.length !== 17) problems.push(`${v.length} characters instead of 17`);
  if (/[IOQ]/.test(v)) problems.push('contains I, O or Q, which VINs never use');
  if (v.length === 17 && !/[IOQ]/.test(v)) {
    const expected = vinCheckDigit(v);
    if (expected !== v[8]) {
      if (/^[1-5]/.test(v)) problems.push(`check digit is ${v[8]} but should be ${expected}: a typo in the VIN`);
      else problems.push(`check digit is ${v[8]} but should be ${expected}: most likely a typo in the VIN (only a car built for a market outside North America may lack one); check the VIN plate`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

export function modelYearFromVin(vin) {
  const v = normalizeVin(vin);
  if (v.length !== 17) return null;
  const idx = YEAR_CODES.indexOf(v[9]);
  if (idx === -1) return null;
  const base = /[A-Z]/.test(v[6]) ? 2010 : 1980;
  return base + idx;
}

// The model years the VIN can mean. The position-7 rule above (a letter
// there means 2010 or later) is for passenger cars, multipurpose vehicles
// and trucks of 10,000 lb or less (49 CFR 565.15); a motorcycle, a trailer
// or a powersport vehicle has no such rule, so its 10th character reads as
// either of two years 30 apart.
export function modelYearReadings(vin, { lightVehicle = true } = {}) {
  const v = normalizeVin(vin);
  if (v.length !== 17) return [];
  const idx = YEAR_CODES.indexOf(v[9]);
  if (idx === -1) return [];
  return lightVehicle ? [modelYearFromVin(v)] : [1980 + idx, 2010 + idx];
}

// Manufacturer groups by the first characters of the VIN (the WMI). Not
// every code in the world, just enough to catch a wrong make on a US lot.
// Each row lists plain prefixes, and the longest prefix that matches wins,
// whatever the row order: a plant code such as 3CZ (Honda, Mexico) or 1YV
// (Mazda, AutoAlliance) is never read as the shorter 3C (Stellantis) or 1Y
// (General Motors). A plant that builds for more than one maker lists every
// make it builds (KNM: Renault Samsung, which built the Nissan Rogue; 3MY:
// Mazda de Mexico, which built the Toyota Yaris sedan and the Scion iA; JF1:
// Subaru, which builds the Toyota 86 and the Scion FR-S).
export const MANUFACTURERS = Object.freeze([
  [['1HD', '5HD'], 'Harley-Davidson', ['harley-davidson', 'harley davidson', 'harley']],
  [['5NP', '5NM', 'KMH', 'KMT', 'KM8', 'KNA', 'KND', '5XY', '5XX', '3KP', 'KMU', '5NT'], 'Hyundai Motor Group', ['hyundai', 'kia', 'genesis']],
  [['KNM'], 'Renault Samsung', ['nissan', 'renault']],
  [['1N', '3N', 'JN', '5N1', '5N3'], 'Nissan', ['nissan', 'infiniti', 'datsun']],
  [['1C', '2C', '3C', '1B', '2B', '3B', '1A', '1J', '1P', '2P', '3P', 'ZFA', 'ZAR', 'ZAC'], 'Stellantis', ['chrysler', 'dodge', 'jeep', 'ram', 'fiat', 'alfa romeo', 'plymouth', 'eagle']],
  [['1F', '2F', '3F', '1L', '5L', '1ZV', '1M'], 'Ford', ['ford', 'lincoln', 'mercury']],
  [['1G', '2G', '3G', '1Y', '5Y4', 'W06', '2CN', '2CK', '2CT'], 'General Motors', ['chevrolet', 'chevy', 'gmc', 'buick', 'cadillac', 'pontiac', 'saturn', 'hummer', 'oldsmobile', 'saab']],
  [['1H', '2H', '19X', '19U', '5FN', '5FP', '5FR', '5J6', '5J8', '7FA', 'JH', 'SHH', 'SHS', '3CZ', '3HG', '2HN', '2HK', '2HG'], 'Honda', ['honda', 'acura']],
  [['4T', '5T', 'JT', '2T', '3TM', '3TY', 'JTD', 'JTH', 'JTJ', 'JTE', 'JTN', '5YF', '58A'], 'Toyota', ['toyota', 'lexus', 'scion', 'subaru']],
  [['JF', '4S'], 'Subaru', ['subaru', 'toyota', 'scion']],
  [['JM', '3MZ', '1YV', '4F', '7MZ', 'JM1', 'JM3'], 'Mazda', ['mazda']],
  [['3MY'], 'Mazda', ['mazda', 'toyota', 'scion']],
  [['WBA', 'WBS', 'WBX', 'WBY', '5UX', '5YM', '4US', 'WMW', '3MW'], 'BMW', ['bmw', 'mini']],
  [['WDD', 'WDC', 'WDB', 'W1K', 'W1N', 'W1V', '4JG', '55S', 'WDF', 'W1Z'], 'Mercedes-Benz', ['mercedes-benz', 'mercedes']],
  [['WVW', 'WVG', '3VW', '1VW', 'WV1', 'WV2', 'WV3', '9BW'], 'Volkswagen', ['volkswagen', 'vw']],
  [['WAU', 'WA1', 'WUA', 'TRU', 'WAP'], 'Audi', ['audi']],
  [['YV', 'LYV', '7JR', 'LVY'], 'Volvo', ['volvo']],
  [['SAJ', 'SAL', 'SAD', 'SAT'], 'Jaguar Land Rover', ['jaguar', 'land rover', 'range rover']],
  [['5YJ', '7SA', '7G2', 'XP7', 'LRW'], 'Tesla', ['tesla']],
  [['JYA', 'JY4'], 'Yamaha', ['yamaha']],
  [['JKA', 'JKB', 'JKS'], 'Kawasaki', ['kawasaki']],
  [['JS1', 'JS3', '2S3'], 'Suzuki', ['suzuki']],
  [['ZDM'], 'Ducati', ['ducati']],
  [['56K'], 'Indian', ['indian']],
  [['SMT'], 'Triumph', ['triumph']],
  [['ZD4', 'ZAP'], 'Piaggio', ['aprilia', 'vespa', 'moto guzzi']],
  [['WB1', 'WB3'], 'BMW Motorrad', ['bmw', 'bmw motorrad']],
]);

// VINs from makers of motorcycles and powersport vehicles, never a car or
// light truck: the groups below, and Suzuki's motorcycle code JS1 (its other
// codes build cars and SUVs too).
const CYCLE_MAKERS = new Set(['Harley-Davidson', 'Yamaha', 'Kawasaki', 'Ducati', 'Indian', 'Triumph', 'Piaggio', 'BMW Motorrad']);
const cycleVin = (vin, maker) => Boolean(maker && CYCLE_MAKERS.has(maker.group)) || vin.startsWith('JS1');

export function manufacturerFromVin(vin) {
  const v = normalizeVin(vin);
  let best = null;
  for (const [prefixes, group, makes] of MANUFACTURERS) {
    for (const p of prefixes) if (v.startsWith(p) && (!best || p.length > best.prefix.length)) best = { prefix: p, group, makes };
  }
  return best ? { group: best.group, makes: best.makes } : null;
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Everything that can be checked without the network.
export function localVinCheck(vehicle = {}) {
  const vin = normalizeVin(vehicle.vin);
  const format = checkVinFormat(vin);
  const checks = [];
  checks.push({ code: 'format', label: 'VIN format and check digit', ok: format.ok, detail: format.ok ? (format.notes[0] || '17 characters, check digit correct') : format.problems.join('; ') });

  const maker = format.ok ? manufacturerFromVin(vin) : null;
  // the position-7 year rule holds only for a car or light truck: not for a motorcycle by
  // the website's body style or make, nor for a VIN from a motorcycle maker
  const lightVehicle = readVehicleKind(vehicle).kind === VEHICLE_KIND.CAR_TRUCK && !cycleVin(vin, maker);
  const readings = format.ok ? modelYearReadings(vin, { lightVehicle }) : [];
  const said = readings.join(' or ');
  let vinYear = readings.length === 1 ? readings[0] : null;
  if (!readings.length) checks.push({ code: 'year', label: 'Model year', ok: null, detail: 'could not be read from the VIN' });
  else if (typeof vehicle.year !== 'number') checks.push({ code: 'year', label: 'Model year', ok: null, detail: `VIN says ${said}; the website has no year` });
  else if (readings.includes(vehicle.year)) {
    vinYear = vehicle.year;
    checks.push({ code: 'year', label: 'Model year', ok: true, detail: `${vinYear}, website agrees` });
  } else checks.push({ code: 'year', label: 'Model year', ok: false, detail: `VIN says ${said}, the website says ${vehicle.year}` });

  const make = String(vehicle.make || '').trim().toLowerCase();
  if (!maker) checks.push({ code: 'make', label: 'Manufacturer', ok: null, detail: 'this manufacturer code is not in the local list' });
  else if (!make) checks.push({ code: 'make', label: 'Manufacturer', ok: null, detail: `VIN is from ${maker.group}; the website has no make` });
  else if (maker.makes.some((m) => make === m || make.startsWith(m + ' '))) checks.push({ code: 'make', label: 'Manufacturer', ok: true, detail: `${maker.group}, website's "${vehicle.make}" agrees` });
  else checks.push({ code: 'make', label: 'Manufacturer', ok: false, detail: `VIN is from ${maker.group}, but the website says ${vehicle.make}` });

  const problems = checks.filter((c) => c.ok === false);
  return { vin, ok: problems.length === 0, checks, problems, vinYear, manufacturer: maker ? maker.group : null };
}

export const NHTSA_ORIGIN = 'https://vpic.nhtsa.dot.gov';

// Full decode from NHTSA (free, no key). Needs the host permission.
export async function decodeVinOnline(vin, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const v = normalizeVin(vin);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${NHTSA_ORIGIN}/api/vehicles/DecodeVinValues/${encodeURIComponent(v)}?format=json`, { signal: controller ? controller.signal : undefined });
    if (!res.ok) return { ok: false, error: `NHTSA returned ${res.status}` };
    const body = await res.json();
    const r = (body && body.Results && body.Results[0]) || {};
    const pick = (k) => (typeof r[k] === 'string' ? r[k].trim() : r[k] === null || r[k] === undefined ? '' : String(r[k]));
    const engine = [pick('DisplacementL') && `${Number(pick('DisplacementL')).toFixed(1)}L`, pick('EngineCylinders') && `${pick('EngineCylinders')} cyl`, pick('EngineModel')].filter(Boolean).join(' ');
    const decoded = {
      make: pick('Make'), model: pick('Model'), year: Number(pick('ModelYear')) || null, trim: pick('Trim'), series: pick('Series'),
      bodyClass: pick('BodyClass'), vehicleType: pick('VehicleType'), fuelType: pick('FuelTypePrimary'), fuelTypeSecondary: pick('FuelTypeSecondary'), electrificationLevel: pick('ElectrificationLevel'),
      engine, driveType: pick('DriveType'), transmission: [pick('TransmissionStyle'), pick('TransmissionSpeeds') && `${pick('TransmissionSpeeds')}-speed`].filter(Boolean).join(' '),
      doors: pick('Doors'), plantCountry: pick('PlantCountry'), errorCode: pick('ErrorCode'), errorText: pick('ErrorText'),
    };
    const bad = /^(1|4|5|6|7|8|11|12|14)\b/.test(decoded.errorCode) && !decoded.make; // vPIC error codes other than 0 with nothing decoded
    if (bad) return { ok: false, error: decoded.errorText || 'NHTSA could not decode this VIN', decoded };
    return { ok: true, decoded };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const drive = (s) => {
  const t = String(s || '').toLowerCase();
  if (/4wd|4x4|four.?wheel/.test(t)) return '4WD';
  if (/awd|all.?wheel/.test(t)) return 'AWD';
  if (/fwd|front.?wheel/.test(t)) return 'FWD';
  if (/rwd|rear.?wheel/.test(t)) return 'RWD';
  return '';
};
// The decode's fuel in the form's words. vPIC's ElectrificationLevel says it
// best ("Mild HEV", "PHEV", "BEV"); without one, a second fuel of Electric
// beside gasoline or diesel is a hybrid, never an electric car, and a second
// fuel of ethanol ("Ethanol (E85)", how vPIC reports a flex-fuel car) is Flex.
export function fuelFromDecode(decoded = {}) {
  const level = String(decoded.electrificationLevel || '');
  if (/\bfcev\b|fuel cell/i.test(level)) return '';
  if (/\bphev\b|plug.?in/i.test(level)) return 'Plug-in hybrid';
  if (/\bbev\b|battery electric/i.test(level)) return 'Electric';
  if (/\bhev\b|hybrid/i.test(level)) return 'Hybrid';
  const primary = normalizeFuelType(decoded.fuelType);
  if (/ethanol|\be85\b/i.test(decoded.fuelTypeSecondary || '') && primary === 'Gasoline') return 'Flex';
  if (/electric/i.test(decoded.fuelTypeSecondary || '') && primary && primary !== 'Electric') return 'Hybrid';
  return primary;
}

// A model's words in letters and digits only: punctuation inside a word is
// dropped, so "F-150" is "f150" and "CR-V" is "crv", as the website often
// writes them; a slash, comma, ampersand or plus still parts two words.
const titleWords = (s) => String(s || '').toLowerCase().replace(/[/,&+]/g, ' ').replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
// Every run of consecutive words written together: "Rav 4" gives rav, rav4 and 4.
const wordRuns = (words) => words.flatMap((_, i) => words.slice(i).map((__, j) => words.slice(i, i + j + 1).join('')));

// The website model's words that nothing NHTSA decoded confirms: not a word
// of its model (alone or run together, "Rav 4" for "RAV4"), its series or
// trim, nor the make ("Ram 1500" for "1500"). "Grand" in "Grand Cherokee"
// against a decoded "Cherokee" is one; so is "1500" in "Silverado 1500"
// when the decode puts it nowhere.
function unconfirmedModelWords(model, decoded, make) {
  const confirmed = new Set([...wordRuns(titleWords(decoded.model)), ...titleWords(decoded.series), ...titleWords(decoded.trim), ...titleWords(decoded.make), ...titleWords(make)]);
  // the website's own words, as it writes them, beside their plain forms
  const shown = String(model || '').replace(/[/,&+]/g, ' ').split(/\s+/).filter((t) => titleWords(t).length);
  const words = shown.map((t) => titleWords(t).join(''));
  const covered = words.map(() => false);
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i; j < words.length; j += 1) {
      if (confirmed.has(words.slice(i, j + 1).join(''))) for (let k = i; k <= j; k += 1) covered[k] = true;
    }
  }
  return shown.filter((_, i) => !covered[i]);
}

// Website record vs the NHTSA decode, field by field. verdict: 'agree' |
// 'differ' | 'partly' | 'unknown' (one side is blank). Model and body are
// compared loosely because the two sides word them differently. The model
// differs when the decode names a word the website's model and trim don't;
// when the website's model only adds words the decode doesn't confirm
// ("Grand Cherokee" for a decoded "Cherokee", "Silverado 1500" for
// "Silverado"), it is 'partly', with those words in the row's `extra`: not a
// difference, since the two sides word models differently, but not an
// agreement either.
export function compareVin(vehicle = {}, decoded = {}) {
  const rows = [];
  const add = (field, website, vin, verdict, extra) => rows.push({ field, website: website || '', vin: vin || '', verdict, ...(extra ? { extra } : {}) });
  const v = (a, b, agree) => (!a || !b ? 'unknown' : agree ? 'agree' : 'differ');

  add('Year', vehicle.year, decoded.year, v(vehicle.year, decoded.year, vehicle.year === decoded.year));
  add('Make', vehicle.make, decoded.make, v(vehicle.make, decoded.make, same(vehicle.make, decoded.make)));
  const model = String(vehicle.model || '');
  const decodedWords = titleWords(decoded.model);
  const siteWords = titleWords(model + ' ' + (vehicle.trim || ''));
  // each decoded word is one of the website's (or starts one of its model's words), or
  // the decoded model is the website's words run together ("RAV4" and "Rav 4", "F-150" and "F 150")
  const modelAgree = decodedWords.length > 0 && (decodedWords.every((w) => siteWords.includes(w) || titleWords(model).some((x) => x.startsWith(w))) || wordRuns(siteWords).includes(decodedWords.join('')));
  const extra = modelAgree ? unconfirmedModelWords(model, decoded, vehicle.make) : [];
  const modelVerdict = v(model, decoded.model, modelAgree);
  if (modelVerdict === 'agree' && extra.length) add('Model', model, decoded.model, 'partly', extra);
  else add('Model', model, decoded.model, modelVerdict);
  const bodyW = normalizeBodyStyle(vehicle.bodyType);
  const bodyV = normalizeBodyStyle(decoded.bodyClass) || (/pickup|truck/i.test(decoded.bodyClass) ? 'Truck' : /sport utility|suv|crossover/i.test(decoded.bodyClass) ? 'SUV' : '');
  add('Body', vehicle.bodyType, decoded.bodyClass, v(bodyW, bodyV, bodyW === bodyV));
  const fuelW = normalizeFuelType(vehicle.fuelType);
  const fuelV = fuelFromDecode(decoded);
  const fuelShown = [decoded.fuelType, decoded.fuelTypeSecondary].filter(Boolean).join(' / ') + (decoded.electrificationLevel ? ` (${decoded.electrificationLevel})` : '');
  add('Fuel', vehicle.fuelType, fuelShown, v(fuelW, fuelV, fuelW === fuelV));
  add('Drive', vehicle.drivetrain, decoded.driveType, v(drive(vehicle.drivetrain), drive(decoded.driveType), drive(vehicle.drivetrain) === drive(decoded.driveType)));
  const trW = normalizeTransmission(vehicle.transmission, { fuel: fuelW });
  const trV = normalizeTransmission(decoded.transmission, { fuel: fuelV });
  add('Transmission', vehicle.transmission, decoded.transmission, v(trW, trV, trW === trV));
  add('Engine', vehicle.engine, decoded.engine, 'info');

  const differ = rows.filter((r) => r.verdict === 'differ');
  return { rows, ok: differ.length === 0, differ, partly: rows.filter((r) => r.verdict === 'partly'), agree: rows.filter((r) => r.verdict === 'agree').length };
}

// What the side panel says under the comparison: the differences, then
// each row NHTSA only partly confirms, by name, and that it agrees on the
// rest only when nothing is left to look at.
export function compareSummary(compare = {}) {
  const differ = Array.isArray(compare.differ) ? compare.differ : [];
  const partly = Array.isArray(compare.partly) ? compare.partly : [];
  const lines = [];
  if (differ.length) lines.push(`${differ.length} difference(s) between the website and the VIN: check the car before posting.`);
  for (const r of partly) {
    lines.push(`NHTSA's ${r.field.toLowerCase()} is "${r.vin}"; the website says "${r.website}", and NHTSA does not confirm "${r.extra.join(' ')}". Check the car before posting.`);
  }
  if (!lines.length) lines.push('NHTSA agrees with the website on everything it knows about this VIN.');
  else if (!differ.length) lines.push('NHTSA agrees with the website on everything else it knows about this VIN.');
  return lines;
}
