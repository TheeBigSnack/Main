// Turns a normalised vehicle into the values the Facebook Marketplace vehicle
// form gets, in Lot Current's own canonical words. Facebook's spelling for each
// option (and how each field is found on the page) lives in
// extension/facebook/formMap.js, not here.

// Marketplace's vehicle types Lot Current knows. formMap.js has options only for
// the two it fills in (FORM_KINDS below).
export const VEHICLE_KIND = Object.freeze({ CAR_TRUCK: 'car_truck', MOTORCYCLE: 'motorcycle', TRAILER: 'trailer', RV: 'rv', POWERSPORT: 'powersport', BOAT: 'boat' });

// Facebook's wording for the two fields the website can't tell us. They are
// filled from the dealership's defaults (Settings) and shown in the panel as
// assumptions, so the salesperson can change them on the form.
export const TITLE_STATUSES = Object.freeze(['Clean', 'Rebuilt', 'Salvage', 'Lien', 'Missing']);
export const CONDITIONS = Object.freeze(['Excellent', 'Very good', 'Good', 'Fair', 'Poor']);
export const DEFAULT_LISTING_DEFAULTS = Object.freeze({ titleStatus: 'Clean', condition: 'Very good' });

// Words in the website's own text that mean the title is not clean. When one
// shows up, the title default is NOT applied, the clean-title box is
// unticked, the panel says why, and a queued car waits at review. Each word
// is read in its usual forms ("Salvaged", "Flood-damaged", "Totaled",
// "Previously flooded", "Title Status: Branded"), and as a label and value
// from a specs list ("Title Brand: Flood", "Title Type: Branded", "Title:
// Hail", "Odometer: Not Actual"). A bare "title", "damage" or "branded" is
// never one ("tax, title and license extra", "no frame damage",
// "Mopar-branded mats"), "flood lights" is equipment, "total loss
// protection" or "coverage" is an insurance product, and "odometer exempt"
// ("Odometer: Exempt") is an age exemption, not a brand.
const TITLE_LABEL = 'title(?:[\\s-]+(?:brands?|type|status|designation))?';
const BRANDED = new RegExp(
  '\\b(' +
    [
      'salvag\\w*',
      'rebuil(?:t|dable)',
      'reconstructed',
      'branded[\\s-]+title',
      'title (?:is |was )?branded',
      `${TITLE_LABEL}\\s*[:\\-\u2013]\\s*branded`,
      // a label's value: after a bare "Title" only a colon makes it a label ("Clean title - fire red" is paint); "hail-free" is no brand
      `(?:${TITLE_LABEL}\\s*:|title[\\s-]+(?:brands?|type|status|designation)\\s*[-\u2013])\\s*(?:flood(?:ed)?|hail|fire|water|junk|theft|stolen)(?:[\\s-]+(?:damag\\w*|recover\\w*))?(?![\\s-]*free\\b)`,
      '(?:odometer|mileage)(?:[\\s-]+(?:status|brand|reading|disclosure|type))?\\s*[:\\-\u2013]\\s*not[\\s-]+actual',
      '(?:flood|hail|water|fire)[\\s-]*damag\\w*',
      'flood (?:title|vehicle|car)',
      // "flooded with natural light" or "flooded with options" is a sales line; "flooded with water" and "flooded in a storm" are brands
      'flooded(?![\\s-]+(?:with\\s+(?!(?:\\w+\\s+)?water\\b)|(?:in|by)\\s+(?:\\w+\\s+)?(?:sun)?light\\b))',
      'total(?:l?ed|[\\s-]*loss(?![\\s-]+(?:protection|coverage)))',
      'non[\\s-]*repairable',
      'junk title',
      'lien',
      'lemon(?: law)?(?: buy.?back)?',
      'buy.?back',
      'theft recover\\w*',
      'tmu',
      'true mileage unknown',
      'not (?:the )?actual mileage',
      'mileage (?:is )?not actual',
      'odometer (?:discrepanc\\w*|rollback|tamper\\w*)',
      'odometer (?:reading )?(?:is )?not actual',
      'exceeds? mechanical limits?',
      'r[\\s-]title',
    ].join('|') +
    ')\\b',
  'i',
);
// Mentions of those words that are about something else, read as no brand:
// a program or a finance offer ("qualifies for the CARFAX Buyback
// Guarantee" or "Buyback Program", "3-day buyback", "lien-free title", "we
// pay off your lien", "the lien on your trade"). Any other "buyback
// program" ("manufacturer buyback program") or a "lien payoff" stays a
// mention: either can be this car's own history.
const NOT_A_BRAND = new RegExp(
  [
    'buy[\\s-]?back\\s+(?:guarantee|protection|pledge)',
    '\\b(?:carfax|autocheck)[\\s\u00ae\u2122]+buy[\\s-]?back\\s+programs?',
    '\\d+[\\s-]*days?\\s+buy[\\s-]?back',
    '\\blien[\\s-]*free',
    'free\\s+(?:and|&)\\s+clear\\s+of\\s+(?:all\\s+|any\\s+)?liens?',
    "\\b(?:your|trade(?:[\\s-]?in)?(?:['\u2019]s)?)\\s+lien",
    '\\blien\\s+on\\s+your\\b',
  ].join('|'),
  'gi',
);
// A mention the same clause denies: "no salvage history", "never a
// buyback", "not a rebuilt title", "without flood damage", "has never been
// flooded". Only a few small words may stand between the denial and the
// word, and any punctuation ends it, so "No accidents, salvage title",
// "Do not miss this rebuilt title" and "Not salvage, but rebuilt" are still
// brands. A list joined by "or"/"nor" carries the denial ("no salvage or
// flood damage"); "and" does not.
const FILLER = '(?:a|an|any|the|been|ever|prior|previous|previously|known|reported|history|of|record|records|sign|signs|evidence)';
const DENIED = new RegExp(`\\b(?:no|never|not|without|zero|free\\s+of|(?:is|was|has|have|had)n['\u2019]t)\\s+(?:${FILLER}\\s+)*$`, 'i');
const DENIAL_GOES_ON = new RegExp(`^\\s+(?:or|nor)\\s+(?:${FILLER}\\s+)*$`, 'i');
export function brandedTitleSignal(v = {}) {
  // each part read on its own: a denial never reaches from one feature or field into the next
  const hay = [v.descriptionRaw, ...(Array.isArray(v.features) ? v.features : []), v.name, v.trim, v.siteTitle].filter(Boolean).join(' | ');
  const text = hay.replace(NOT_A_BRAND, (s) => '#'.repeat(s.length));
  let deniedUpTo = -1;
  for (const m of text.matchAll(new RegExp(BRANDED.source, 'gi'))) {
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    if (DENIED.test(before) || (deniedUpTo >= 0 && DENIAL_GOES_ON.test(text.slice(deniedUpTo, m.index)))) {
      deniedUpTo = m.index + m[0].length;
      continue;
    }
    return m[1];
  }
  return '';
}

// What kind of vehicle this is, by Marketplace's vehicle types. Lot Current
// fills in only the car/truck and motorcycle forms (FORM_KINDS); a trailer,
// an RV, a powersport vehicle or a boat is kept out of the posting flow
// (classify.js sends it to Needs a look), never filled in as a car.
// UNVERIFIED: the live inventory had none of these to check against on
// 2026-09-26.
// The body type wins. A car body style ("Crew Cab Pickup - Trailer Tow",
// "Pickup w/Camper Shell") makes it a car or truck, whatever equipment words
// follow and whatever the make, except a van or cargo body from a maker of
// RVs or trailers (a Winnebago "Van" is a camper van, a Wells Cargo "Cargo"
// a cargo trailer). Otherwise the make is read only when the body type says
// nothing, from short lists of makes that build that kind. Some motorcycle
// makes build ATVs, side-by-sides or boats too (Yamaha, Kawasaki), so a
// motorcycle read from the make alone is listed as an assumption, which holds
// a queued car at review. Makes that build cars too (Honda, BMW, Suzuki) are
// on no list, so a car is never held back by its make.
const MOTORCYCLE_MAKES = ['harley-davidson', 'harley', 'yamaha', 'kawasaki', 'ducati', 'triumph', 'indian', 'ktm', 'bmw motorrad', 'aprilia', 'moto guzzi', 'royal enfield', 'husqvarna', 'vespa'];

// Checked in this order: "Travel Trailer" is an RV, "Boat Trailer" and
// "Motorcycle Trailer" are trailers, "Jet Ski" is a powersport vehicle.
const OTHER_KINDS = [
  { kind: VEHICLE_KIND.RV, name: 'an RV or camper', body: /\b(?:rvs?|motor ?homes?|campers?|camper ?vans?|travel ?trailers?|fifth ?wheels?|5th ?wheels?|toy ?haulers?|pop.?up (?:campers?|trailers?)|class [abc])\b/i, makes: ['winnebago', 'jayco', 'airstream', 'forest river', 'keystone', 'coachmen', 'grand design', 'thor', 'tiffin', 'newmar', 'entegra', 'heartland', 'dutchmen'] },
  { kind: VEHICLE_KIND.TRAILER, name: 'a trailer', body: /\btrailers?\b/i, makes: ['big tex', 'pj', 'load trail', 'wells cargo', 'haulmark', 'featherlite'] },
  { kind: VEHICLE_KIND.POWERSPORT, name: 'a powersport vehicle', body: /\b(?:atvs?|utvs?|side[ -]?(?:by|x)[ -]?sides?|sxs|utility vehicles?|snowmobiles?|jet ?skis?|wave ?runners?|sea.?doos?|personal watercraft|pwc|golf carts?|go.?karts?)\b/i, makes: ['polaris', 'can am', 'brp', 'sea doo', 'ski doo', 'arctic cat'] },
  { kind: VEHICLE_KIND.BOAT, name: 'a boat', body: /\b(?:boats?|pontoons?|watercraft|yachts?|outboards?)\b/i, makes: ['bayliner', 'sea ray', 'boston whaler', 'mastercraft', 'bennington', 'chaparral'] },
];
export const FORM_KINDS = Object.freeze([VEHICLE_KIND.CAR_TRUCK, VEHICLE_KIND.MOTORCYCLE]);

// A make as the lists hold it: lower case, punctuation as spaces, and the
// company words dropped ("Thor Motor Coach Inc" -> "thor", "Can-Am" -> "can am",
// "Big Tex Trailers" -> "big tex").
const MAKE_SUFFIX = /\s+(?:inc|llc|ltd|co|corp|corporation|company|mfg|manufacturing|industries|rvs?|trailers?|motor coach|coach|boats?|marine|powersports?|motorcycles?|usa|north america|america)$/;
export function makeKey(make) {
  let t = String(make || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (let before = ''; before !== t;) {
    before = t;
    t = t.replace(MAKE_SUFFIX, '').trim();
  }
  return t;
}
// The whole make, or its first words ("Harley-Davidson Motor Co" is "harley")
function makeOnList(make, list) {
  const k = makeKey(make);
  if (!k) return false;
  return list.some((entry) => {
    const e = makeKey(entry);
    return k === e || k.startsWith(e + ' ');
  });
}

// { kind, name, from, fromMake }: `from` is the website's own words it was
// read from; `fromMake` is true when the body type said nothing and the make
// decided it.
export function readVehicleKind(v = {}) {
  const body = String(v.bodyType || '').trim();
  const carBody = matchBody(body);
  const car = { kind: VEHICLE_KIND.CAR_TRUCK, name: 'a car or truck', from: carBody ? `body style "${body}"` : '', fromMake: false };
  // a van or cargo body may be a camper van or a cargo trailer; any other car body style is a car
  if (carBody && carBody.style !== 'Van') return car;
  for (const k of OTHER_KINDS) if (k.body.test(body)) return { kind: k.kind, name: k.name, from: `body style "${body}"`, fromMake: false };
  if (/\b(?:motorcycles?|motorbikes?|scooters?|sport ?bikes?|dirt ?bikes?)\b/i.test(body)) return { kind: VEHICLE_KIND.MOTORCYCLE, name: 'a motorcycle', from: `body style "${body}"`, fromMake: false };
  if (carBody) {
    // a van or cargo body from a maker of RVs, trailers, powersport vehicles or boats is one of those, not a van
    for (const k of OTHER_KINDS) if (makeOnList(v.make, k.makes)) return { kind: k.kind, name: k.name, from: `make "${String(v.make).trim()}" with body style "${body}"`, fromMake: true };
    return car;
  }
  for (const k of OTHER_KINDS) if (makeOnList(v.make, k.makes)) return { kind: k.kind, name: k.name, from: `make "${String(v.make).trim()}"`, fromMake: true };
  if (makeOnList(v.make, MOTORCYCLE_MAKES)) return { kind: VEHICLE_KIND.MOTORCYCLE, name: 'a motorcycle', from: `make "${String(v.make).trim()}"`, fromMake: true };
  return car;
}

export function vehicleKind(v = {}) {
  return readVehicleKind(v).kind;
}

// Each reader below turns the website's own words for one form field into
// { value, why }. `value` is Facebook's option in Lot Current's spelling, or ''
// when the words map to nothing (the field is left blank and the panel shows
// the website's words; never a guess). `why` is set when the value took a
// reading a person should see: the panel lists it under the assumptions,
// with the website's own words.
const reading = (value, why = '') => ({ value, why });
const said = (text) => `the website says "${String(text).trim()}"`;

// Facebook's color list in Lot Current's spelling (formMap.js maps Gray to Grey etc.).
export const COLORS = Object.freeze(['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Gray', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Tan', 'Beige', 'Burgundy', 'Turquoise', 'Off white']);

// The list's own words (and grey): a color the website states.
const COLOR_WORDS = [
  ['off white', 'Off white'], ['off-white', 'Off white'], ['black', 'Black'], ['white', 'White'], ['silver', 'Silver'],
  ['gray', 'Gray'], ['grey', 'Gray'], ['charcoal', 'Charcoal'], ['blue', 'Blue'], ['red', 'Red'],
  ['burgundy', 'Burgundy'], ['green', 'Green'], ['brown', 'Brown'],
  ['tan', 'Tan'], ['beige', 'Beige'], ['gold', 'Gold'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['purple', 'Purple'],
  ['pink', 'Pink'], ['turquoise', 'Turquoise'],
];
// A small set of shade names that mean one color on the list, shown as a
// reading whenever one decides the color.
const SHADE_WORDS = [
  ['ebony', 'Black'], ['onyx', 'Black'], ['ivory', 'Off white'], ['pewter', 'Gray'], ['graphite', 'Charcoal'],
  ['maroon', 'Burgundy'], ['sepia', 'Brown'], ['bronze', 'Brown'], ['navy', 'Blue'], ['teal', 'Turquoise'],
];

function firstWord(t, words) {
  let best = null;
  for (const [word, canonical] of words) {
    const m = new RegExp(`\\b${word}\\b`).exec(t);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, word, canonical };
  }
  return best;
}

// What separates the colors of a two-tone name ("Diesel Gray/Black",
// "Ebony w/Red Accents", "Black and Tan"): the first color is the main one.
const TWO_TONE = /[/\\&+,;(]|\b(?:with|and|on|over)\b/;

// The first color word wins, a list word or a shade name alike: "Diesel
// Gray/Black" -> Gray; "Ebony w/Red Accents" -> Black, read from "ebony" and
// shown as a reading; "Titanium" -> ''. A shade name straight before a list
// word names the same color twice ("Ivory White", "Onyx Black"): the list
// word the website states is taken. A name that runs a second, different
// color into the first with nothing between them ("Black Forest Green",
// "White Gold", "Charcoal Black") keeps the first, shown as a reading: the
// paint may be the second color.
export function readColor(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return reading('');
  const stated = firstWord(t, COLOR_WORDS);
  const shade = firstWord(t, SHADE_WORDS);
  const first = (w) => {
    const rest = t.slice(w.index + w.word.length);
    const cut = TWO_TONE.exec(rest);
    const other = firstWord(cut ? rest.slice(0, cut.index) : rest, [...COLOR_WORDS, ...SHADE_WORDS].filter(([, c]) => c !== w.canonical));
    return other ? reading(w.canonical, `${said(text)}, which names two colors (${w.word}, ${other.word}); read as ${w.canonical}, the first; check it on the form`) : reading(w.canonical);
  };
  if (!shade) return stated ? first(stated) : reading('');
  if (stated && stated.index < shade.index) return first(stated);
  if (stated && /^\s*$/.test(t.slice(shade.index + shade.word.length, stated.index))) return first(stated);
  return reading(shade.canonical, `${said(text)}; ${shade.word} is read as ${shade.canonical}; check it on the form`);
}

export function normalizeColor(text) {
  return readColor(text).value;
}

// Whole words only, singular or plural ("Vans", "SUVs"), so a model name
// such as Wagoneer or Caravan is never a body style. '4dr Car' and 'Cars'
// name no body style and stay blank.
const TRUCK_CABS = '(?:crew|quad|regular|reg|standard|single|extended|ext|double|access|king|mega|chassis|club|super)[ -]?cabs?|cab[ -]?chassis|super[ -]?crew|crew[ -]?max|xtra[ -]?cab';
const BODY_WORDS = [
  ['mini.?vans?', 'Minivan'],
  [`trucks?|pickups?|${TRUCK_CABS}`, 'Truck'],
  ['suvs?|sport utility(?: vehicles?)?|crossovers?', 'SUV'],
  ['sedans?', 'Sedan'],
  ['convertibles?|roadsters?|cabriolets?', 'Convertible'],
  ['coupes?', 'Coupe'],
  ['hatch(?:backs?)?', 'Hatchback'],
  ['vans?|cargo', 'Van'],
  ['wagons?', 'Wagon'],
];
// anywhere in the text, and anchored at its start (for the page address)
const BODY_STYLES = BODY_WORDS.map(([words, style]) => [new RegExp(`\\b(?:${words})\\b`, 'i'), style]);
const BODY_AT_START = BODY_WORDS.map(([words, style]) => [new RegExp(`^(?:${words})\\b`, 'i'), style]);
const CAB_AT_START = new RegExp(`^(?:${TRUCK_CABS})\\b`, 'i');

function matchBody(text, styles = BODY_STYLES) {
  const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // "Coupé" is "Coupe"
  for (const [re, style] of styles) {
    const m = re.exec(t);
    if (m) return { style, words: m[0] };
  }
  return null;
}

export function normalizeBodyStyle(text) {
  const hit = matchBody(text);
  return hit ? hit.style : '';
}

// The car's own page address, as words: "/inventory/used-2019-ram-1500-4d-
// quad-cab-<vin>/" -> "used 2019 ram 1500 4d quad cab <vin>". Only the last
// part of the path, which names this car; a folder such as /trucks/ may be a
// list the car merely sits in.
function addressWords(url) {
  let path = '';
  try {
    path = new URL(String(url || '')).pathname;
  } catch {
    return '';
  }
  const last = path.split('/').filter(Boolean).pop() || '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // keep it as written
  }
  return decoded.replace(/\.[a-z]{2,5}$/i, '').replace(/[-_+.]+/g, ' ');
}

// Body words in the car's page address, only where an address names the body
// rather than the model or a place: after the model year, and either a cab
// name (-quad-cab-, -supercrew-) or a body word straight after a door count
// or the drive (-4d-sport-utility-, -2d-coupe-, -4x4-sport-utility-). "Van
// Nuys" before the year, a "glc-300-coupe", a "gran-coupe" or a "city-wagon"
// is a place or a model name, so it gives nothing. When unsure, nothing.
const DOORS = /^\d ?d(?:r|oor)?$/;
const DRIVE = /^(?:[24]wd|awd|fwd|rwd|4x[24]|2x4)$/;
function bodyFromAddress(url) {
  const tokens = addressWords(url).toLowerCase().split(/\s+/).filter(Boolean);
  const year = tokens.findIndex((t) => /^(?:19|20)\d{2}$/.test(t));
  if (year < 0) return null;
  for (let i = year + 1; i < tokens.length; i += 1) {
    const rest = tokens.slice(i).join(' ');
    const cab = CAB_AT_START.exec(rest);
    if (cab) return { style: 'Truck', words: cab[0] };
    if (DOORS.test(tokens[i - 1]) || DRIVE.test(tokens[i - 1])) {
      const hit = matchBody(rest, BODY_AT_START);
      if (hit) return hit;
    }
  }
  return null;
}

// The body field first; when it maps to nothing, the body words in the car's
// page address (bodyFromAddress), shown as a reading.
export function readBodyStyle(v = {}) {
  const stated = matchBody(v.bodyType);
  if (stated) return reading(stated.style);
  const fromAddress = bodyFromAddress(v.url);
  if (!fromAddress) return reading('');
  const field = String(v.bodyType || '').trim() ? `its body style field says "${String(v.bodyType).trim()}"` : 'the website gives no body style';
  return reading(fromAddress.style, `read from the car's page address ("${fromAddress.words.toLowerCase().replace(/\s+/g, '-')}"); ${field}; check it on the form`);
}

// Facebook has no word for natural gas, propane or hydrogen: those stay blank.
const NO_FORM_FUEL = /hydrogen|fuel.?cell|\bfcev\b|natural gas|\bcng\b|\blng\b|propane|\blpg\b|autogas/i;

export function readFuelType(text) {
  const t = String(text || '');
  if (!t.trim()) return reading('');
  if (NO_FORM_FUEL.test(t)) return reading('');
  if (/plug.?in|\bphev\b/i.test(t)) return reading('Plug-in hybrid');
  if (/\bmild\b[^,;]*\b(?:hybrid|electric)|\bmhev\b|\be-?torque\b|\be-?assist\b/i.test(t)) return reading('Hybrid', `${said(t)}: a mild hybrid; change it on the form if you list mild hybrids as Gasoline`);
  if (/hybrid|\bhev\b/i.test(t)) return reading('Hybrid');
  // "battery" alone is not electric drive: "Gasoline (Start/Stop Battery)"
  const electric = /electric|\bb?ev\b/i.test(t);
  if (electric && /\bgas(?:oline)?\b|petrol|unleaded|diesel/i.test(t)) return reading('Hybrid', `${said(t)}: it runs on fuel and electricity, so it is listed as Hybrid; check it on the form`);
  if (electric) return reading('Electric');
  if (/diesel/i.test(t)) return reading('Diesel');
  if (/flex|\be-?85\b|ethanol/i.test(t)) return reading('Flex');
  if (/\bgas(?:oline)?\b|petrol|unleaded/i.test(t)) return reading('Gasoline');
  return reading('');
}

export function normalizeFuelType(text) {
  return readFuelType(text).value;
}

// An automatic with a manual mode is an automatic, and a manual with
// automatic rev matching is a manual: the first word wins.
const AUTOMATIC = /auto|\ba\/t\b|\be?cvt\b|continuously variable|dual.?clutch|twin.?clutch|\bdct\b|\bdsg\b|\bpdk\b|tiptronic|steptronic|paddle|shiftable|manumatic/i;
const MANUAL = /manual|\bm\/t\b|stick/i;
// An electric car's single-speed reduction gear: no gears to shift.
const SINGLE_SPEED = /\b(?:1|one|single)[- ]?speed\b|direct.?drive|reduction gear|fixed.?gear/i;

// `fuel` is the car's fuel type in Facebook's words (readFuelType's value).
export function readTransmission(text, { fuel = '' } = {}) {
  const t = String(text || '');
  if (!t.trim()) return reading('');
  const a = AUTOMATIC.exec(t);
  const m = MANUAL.exec(t);
  if (a && (!m || a.index <= m.index)) return reading('Automatic');
  if (m) return reading('Manual');
  if (SINGLE_SPEED.test(t) && fuel === 'Electric') return reading('Automatic', `${said(t)} on an electric car, which has no gears to shift; Automatic is the form's nearest word; check it on the form`);
  return reading('');
}

export function normalizeTransmission(text, options = {}) {
  return readTransmission(text, options).value;
}

export const STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  // territories with franchise dealers and Marketplace
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
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

// Where the website says a car is, against the salesperson's own store.
// `store` is the car's store, for a description to name in place of the
// dealership and its town: the website names a store for the car, and it is
// not the one store the salesperson ticked (they ticked none, so every
// store's cars count, or several, or the car is at another). '' when the
// car is at the one store ticked, or the website names no store. `away` is
// true when that store's name does not name the dealership's town either, so
// the dealership's address, which the listing's location is typed from, may
// not be where the car is. `lot` is the website's cars from the last scan
// (a list, or the snapshot's map by VIN; each a car with its location, or a
// store name), when the caller has them: on a website whose cars are all at
// one store, that store is the dealership the address came from, whatever
// its name says, so its cars are never away. With no lot to go on, a store
// whose name does not name the town may be anywhere.
const placeWords = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || [];
export function carStore(v = {}, { stores = [], dealer = {}, lot = null } = {}) {
  const at = typeof v.location === 'string' ? v.location.trim() : '';
  const mine = (Array.isArray(stores) ? stores : []).map((st) => String(st || '').trim()).filter(Boolean);
  const store = at && !(mine.length === 1 && mine[0] === at) ? at : '';
  const name = placeWords(store);
  const town = placeWords(dealer && dealer.city);
  const inTown = town.length > 0 && name.some((_, i) => town.every((w, j) => name[i + j] === w));
  const listed = Object.values(lot && typeof lot === 'object' ? lot : {}).map((c) => String((c && typeof c === 'object' ? c.location : c) || '').trim()).filter(Boolean);
  const oneStore = listed.length > 0 && new Set([...listed, store]).size === 1;
  return { store, away: Boolean(store) && !inTown && !oneStore };
}

/**
 * @param {object} vehicle   normalised vehicle
 * @param {object} options   { dealer: {city, state, zip}, description, photos, price, defaults: {titleStatus, condition}, stores, lot }
 *   price is the number to post (the caller applies the dealer's price basis);
 *   defaults are the dealership's answers for the fields the website can't give;
 *   guesses ({ exterior, interior, confidence }) are colors read from the photos,
 *   used only where the website gives no usable color;
 *   stores are the salesperson's ticked stores (settings.myStores), and lot the website's cars
 *   from the last scan (the snapshot's map by VIN, when known), for carStore
 */
export function buildListingData(vehicle, { dealer = {}, description = '', photos = null, price = null, defaults = DEFAULT_LISTING_DEFAULTS, guesses = null, stores = [], lot = null } = {}) {
  const v = vehicle || {};
  const d = defaults || {};
  const g = guesses || {};
  const branded = brandedTitleSignal(v);
  const conditionDefault = CONDITIONS.includes(d.condition) ? d.condition : '';
  const titleDefault = TITLE_STATUSES.includes(d.titleStatus) ? d.titleStatus : '';
  const kind = readVehicleKind(v);
  const body = readBodyStyle(v);
  const ext = readColor(v.exteriorColor);
  const int = readColor(v.interiorColor);
  const fuel = readFuelType(v.fuelType);
  const gearbox = readTransmission(v.transmission, { fuel: fuel.value });
  const extStated = ext.value;
  const intStated = int.value;
  const extGuess = !extStated && COLORS.includes(g.exterior) ? g.exterior : '';
  const intGuess = !intStated && COLORS.includes(g.interior) ? g.interior : '';
  const fields = {
    // only a kind the form is filled in for; classify.js keeps the others out of the posting flow
    vehicleType: FORM_KINDS.includes(kind.kind) ? kind.kind : '',
    year: v.year ? String(v.year) : '',
    make: String(v.make || '').trim(),
    model: [v.model, v.trim].map((s) => String(s || '').trim()).filter(Boolean).join(' '),
    vin: String(v.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    mileage: typeof v.mileage === 'number' && v.mileage >= 0 ? String(Math.round(v.mileage)) : '',
    price: typeof price === 'number' && price > 0 ? String(Math.round(price)) : '',
    bodyStyle: body.value,
    exteriorColor: extStated || extGuess,
    interiorColor: intStated || intGuess,
    fuelType: fuel.value,
    transmission: gearbox.value,
    location: locationQuery(dealer),
    description: String(description || ''),
    condition: conditionDefault,
    titleStatus: branded ? '' : titleDefault,
    // the live form's "This vehicle has a clean title" box: yes = tick, no = untick, '' = leave as is
    cleanTitle: branded ? 'no' : titleDefault === 'Clean' ? 'yes' : '',
  };
  // what the panel highlights: filled from a reading of the website's words,
  // a photo guess or a default (assumed), or left for the person
  const assumed = [];
  const leftBlank = [];
  if (!fields.vehicleType) leftBlank.push({ key: 'vehicleType', label: 'Vehicle type', why: `the website's ${kind.from} makes it ${kind.name}; Lot Current fills in only the car/truck and motorcycle forms` });
  const read = (key, label, r) => {
    if (r.value && r.why) assumed.push({ key, label, value: r.value, why: r.why });
  };
  if (fields.vehicleType === VEHICLE_KIND.MOTORCYCLE && kind.fromMake) {
    assumed.push({ key: 'vehicleType', label: 'Vehicle type', value: 'Motorcycle', why: `read from the website's ${kind.from}; no body style says it is a motorcycle, and some motorcycle makes build ATVs, side-by-sides or boats too; check it on the form` });
  }
  read('bodyStyle', 'Body style', body);
  read('exteriorColor', 'Exterior color', ext);
  read('interiorColor', 'Interior color', int);
  read('fuelType', 'Fuel type', fuel);
  read('transmission', 'Transmission', gearbox);
  const guessWhy = (raw) => `guessed from the photos (${g.confidence || 'unknown'} confidence); the website ${raw ? `says "${raw}"` : 'gives no color'}; check it on the form`;
  if (extGuess) assumed.push({ key: 'exteriorColor', label: 'Exterior color', value: extGuess, why: guessWhy(v.exteriorColor) });
  if (intGuess) assumed.push({ key: 'interiorColor', label: 'Interior color', value: intGuess, why: guessWhy(v.interiorColor) });
  // the location is the dealership's address; a car the website lists at a store in another town may be elsewhere
  const where = carStore(v, { stores, dealer, lot });
  if (fields.location && where.away) assumed.push({ key: 'location', label: 'Location', value: fields.location, why: `your dealership's address; the website lists this car at ${where.store}, so check the location on the form` });
  if (fields.condition) assumed.push({ key: 'condition', label: 'Vehicle condition', value: fields.condition, why: "your dealership's default; change it on the form if this car is different" });
  else leftBlank.push({ key: 'condition', label: 'Vehicle condition', why: 'no default set in Settings; pick it on the form' });
  if (fields.titleStatus) assumed.push({ key: 'titleStatus', label: 'Title status', value: fields.titleStatus, why: "your dealership's default; change it on the form if this car's title is branded" });
  else if (branded) leftBlank.push({ key: 'titleStatus', label: 'Title status', why: `the website mentions "${branded}" for this car, so no default was applied; check the title and pick it on the form` });
  else leftBlank.push({ key: 'titleStatus', label: 'Title status', why: 'no default set in Settings; check the title and pick it on the form' });
  const list = Array.isArray(photos) ? photos : Array.isArray(v.photos) ? v.photos : [];
  return {
    fields,
    // extra rules the fill code needs for a field, by key
    match: { location: locationExpect(dealer) },
    photos: list.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)),
    assumed,
    leftBlank,
    branded,
    missing: Object.keys(fields).filter((k) => !fields[k]),
    // what the website said, by form field, for the side panel to show next to a blank field
    source: { vehicleType: v.bodyType || '', bodyStyle: v.bodyType || '', bodyType: v.bodyType || '', exteriorColor: v.exteriorColor || '', interiorColor: v.interiorColor || '', fuelType: v.fuelType || '', transmission: v.transmission || '' },
  };
}

// What the website changed between two reads of the same car, in the fields
// the form gets: [{ key, was, now }]. The description is left aside (it is
// the salesperson's text, checked on its own against the newer read). The
// side panel reads the car again before a fill when its last read is old,
// and goes back to the review on any change, so the form never gets an
// earlier price, mileage or title answer.
export function listingChanges(before, after) {
  const a = (before && before.fields) || {};
  const b = (after && after.fields) || {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'description');
  return keys.filter((k) => String(a[k] ?? '') !== String(b[k] ?? '')).map((k) => ({ key: k, was: String(a[k] ?? ''), now: String(b[k] ?? '') }));
}
