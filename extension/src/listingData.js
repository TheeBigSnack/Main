// Turns a normalised vehicle into the values the Facebook Marketplace vehicle
// form gets, in LotSync's own canonical words. Facebook's spelling for each
// option (and how each field is found on the page) lives in
// extension/facebook/formMap.js, not here.

export const VEHICLE_KIND = Object.freeze({ CAR_TRUCK: 'car_truck', MOTORCYCLE: 'motorcycle' });

// Fields LotSync can't know from the website. They are never filled and the
// side panel highlights them for the salesperson.
export const LEFT_BLANK = Object.freeze([
  { key: 'condition', label: 'Vehicle condition', why: "Only you can judge the condition. Pick it on the form." },
  { key: 'titleStatus', label: 'Title status', why: "The website doesn't say. Check the title and pick it on the form." },
]);

// UNVERIFIED: the live inventory had no motorcycle to check against on
// 2026-09-26. Body type wins; otherwise a short list of makes that only
// build bikes. Brands that build cars too (Honda, BMW, Suzuki) are left out on
// purpose so a car is never listed as a motorcycle.
const MOTORCYCLE_MAKES = ['harley-davidson', 'harley davidson', 'harley', 'yamaha', 'kawasaki', 'ducati', 'triumph', 'indian', 'ktm', 'bmw motorrad', 'aprilia', 'moto guzzi', 'royal enfield', 'husqvarna', 'vespa'];

export function vehicleKind(v = {}) {
  const body = String(v.bodyType || '');
  if (/motorcycle|motorbike|scooter|sport ?bike|dirt ?bike/i.test(body)) return VEHICLE_KIND.MOTORCYCLE;
  const make = String(v.make || '').trim().toLowerCase();
  if (make && MOTORCYCLE_MAKES.includes(make)) return VEHICLE_KIND.MOTORCYCLE;
  return VEHICLE_KIND.CAR_TRUCK;
}

const COLOR_WORDS = [
  ['off white', 'Off white'], ['off-white', 'Off white'], ['black', 'Black'], ['white', 'White'], ['silver', 'Silver'],
  ['gray', 'Gray'], ['grey', 'Gray'], ['charcoal', 'Charcoal'], ['graphite', 'Charcoal'], ['blue', 'Blue'], ['red', 'Red'],
  ['maroon', 'Burgundy'], ['burgundy', 'Burgundy'], ['green', 'Green'], ['brown', 'Brown'], ['bronze', 'Brown'],
  ['tan', 'Tan'], ['beige', 'Beige'], ['gold', 'Gold'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['purple', 'Purple'],
  ['pink', 'Pink'], ['turquoise', 'Turquoise'], ['teal', 'Turquoise'],
];

// "Diesel Gray/Black" -> "Gray" (the first colour word wins); "Sepia" -> ""
export function normalizeColor(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  let best = null;
  for (const [word, canonical] of COLOR_WORDS) {
    const m = new RegExp(`\\b${word}\\b`).exec(t);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, canonical };
  }
  return best ? best.canonical : '';
}

const BODY_STYLES = [
  [/mini.?van/i, 'Minivan'],
  [/\b(truck|pickup|crew cab|quad cab|regular cab|extended cab)/i, 'Truck'],
  [/\bsuv|sport utility|crossover/i, 'SUV'],
  [/sedan/i, 'Sedan'],
  [/coupe/i, 'Coupe'],
  [/hatch/i, 'Hatchback'],
  [/convertible|roadster|cabriolet/i, 'Convertible'],
  [/\bvan\b|cargo/i, 'Van'],
  [/wagon/i, 'Wagon'],
];

export function normalizeBodyStyle(text) {
  const t = String(text || '');
  for (const [re, style] of BODY_STYLES) if (re.test(t)) return style;
  return '';
}

export function normalizeTransmission(text) {
  const t = String(text || '');
  if (!t) return '';
  if (/manual|\bm\/t\b|stick/i.test(t)) return 'Manual';
  if (/auto|\ba\/t\b|\bcvt\b|\bdct\b|\bdsg\b/i.test(t)) return 'Automatic';
  return '';
}

export function normalizeFuelType(text) {
  const t = String(text || '');
  if (!t) return '';
  if (/plug.?in/i.test(t)) return 'Plug-in hybrid';
  if (/hybrid/i.test(t)) return 'Hybrid';
  if (/electric|\bev\b|battery/i.test(t)) return 'Electric';
  if (/diesel/i.test(t)) return 'Diesel';
  if (/flex|e85/i.test(t)) return 'Flex';
  if (/gas|petrol|unleaded/i.test(t)) return 'Gasoline';
  return '';
}

export const STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

const stateAbbr = (s) => {
  const t = String(s || '').trim();
  if (!t) return '';
  if (STATE_NAMES[t.toUpperCase()]) return t.toUpperCase();
  const hit = Object.entries(STATE_NAMES).find(([, name]) => name.toLowerCase() === t.toLowerCase());
  return hit ? hit[0] : '';
};

// What to type into Facebook's location box: a ZIP is the least ambiguous.
export function locationQuery(dealer = {}) {
  const zip = String(dealer.zip || '').trim();
  if (/^\d{5}(-\d{4})?$/.test(zip)) return zip.slice(0, 5);
  const abbr = stateAbbr(dealer.state);
  return [String(dealer.city || '').trim(), abbr || String(dealer.state || '').trim()].filter(Boolean).join(', ');
}

// Which of Facebook's location suggestions may be picked: one that names the
// city together with the state (either spelling). There are several
// Waynesburgs; the first live run picked the one in Ohio. `strict` means the
// state (or ZIP) is known, so the first matching suggestion is safe to take.
export function locationExpect(dealer = {}) {
  const city = String(dealer.city || '').trim();
  const abbr = stateAbbr(dealer.state);
  const zip = String(dealer.zip || '').trim();
  if (!city) return { alternatives: [], strict: Boolean(zip) };
  const alternatives = abbr ? [[city, STATE_NAMES[abbr]], [city, abbr]] : [[city]];
  return { alternatives, strict: Boolean(abbr || /^\d{5}/.test(zip)) };
}

/**
 * @param {object} vehicle   normalised vehicle
 * @param {object} options   { dealer: {city, state, zip}, description, photos, price }
 *   price is the number to post (the caller applies the dealer's price basis)
 */
export function buildListingData(vehicle, { dealer = {}, description = '', photos = null, price = null } = {}) {
  const v = vehicle || {};
  const fields = {
    vehicleType: vehicleKind(v),
    year: v.year ? String(v.year) : '',
    make: String(v.make || '').trim(),
    model: [v.model, v.trim].map((s) => String(s || '').trim()).filter(Boolean).join(' '),
    mileage: typeof v.mileage === 'number' && v.mileage >= 0 ? String(Math.round(v.mileage)) : '',
    price: typeof price === 'number' && price > 0 ? String(Math.round(price)) : '',
    bodyStyle: normalizeBodyStyle(v.bodyType),
    exteriorColor: normalizeColor(v.exteriorColor),
    interiorColor: normalizeColor(v.interiorColor),
    fuelType: normalizeFuelType(v.fuelType),
    transmission: normalizeTransmission(v.transmission),
    location: locationQuery(dealer),
    description: String(description || ''),
  };
  const list = Array.isArray(photos) ? photos : Array.isArray(v.photos) ? v.photos : [];
  return {
    fields,
    // extra rules the fill code needs for a field, by key
    match: { location: locationExpect(dealer) },
    photos: list.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)),
    leftBlank: LEFT_BLANK,
    missing: Object.keys(fields).filter((k) => !fields[k]),
    // what the website said, for the side panel to show next to a blank field
    source: { bodyType: v.bodyType || '', exteriorColor: v.exteriorColor || '', interiorColor: v.interiorColor || '', fuelType: v.fuelType || '', transmission: v.transmission || '' },
  };
}
