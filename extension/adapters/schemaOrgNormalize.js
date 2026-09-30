// A schema.org vehicle node -> the flat vehicle of src/vehicle.js. The node
// comes from adapters/schemaOrgParse.js (JSON-LD or microdata, the same
// shape either way) together with the facts about its page. The mapping
// follows the public schema.org definitions of Car, Vehicle and Offer and
// Google's vehicle listing documentation, and the conventions of
// dealerInspireNormalize.js where the two meet ("Used"/"New" for the
// inventory type, "In-Stock" for a car on the lot, "Call for price" when
// there is no price, the same name order), so the gate, the rescan and the
// listing form read both alike. Nothing here depends on a platform.
//
// Only what the markup states is taken, and a price only when the page
// shows it too: markup can carry a stale price or an MSRP the page no longer
// shows. Kilometres are never turned into miles. A number of previous owners
// is not a Carfax report, so it never sets the one-owner flag. When a price
// or a mileage is left out, priceFromOffers and milesFromOdometer (and
// readingNotes) say why; the price's reason also shows as its label.

import { toNumber, shortLocation, conditionFromSchemaOrg, conditionWordFromPath } from '../src/normalize.js';
import { readCondition, titleConditionWords } from '../src/classify.js';

// 17 letters and digits, never I, O or Q: the format every VIN since 1981 has.
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

// ---------- reading schema.org values ----------

// The first piece of text a value holds: a string, a number, or the name of
// a node ({ "@type": "Brand", "name": "Ram" }), from a list the first that has one.
function text(value, depth = 0) {
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = text(v, depth);
      if (t) return t;
    }
    return '';
  }
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && depth < 3) return text(value.name, depth + 1) || text(value['@value'], depth + 1);
  return '';
}

// Text a person would read, not an address: a URL where a colour or a body
// style belongs says nothing about the car.
function words(value) {
  const t = text(value);
  return /^https?:\/\//i.test(t) ? '' : t;
}

const list = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const nodes = (value) => list(value).filter((v) => v && typeof v === 'object' && !Array.isArray(v));

// An enumeration member's own name, however it is written:
// "https://schema.org/InStock", "schema:InStock", "InStock", { "@id": ... }.
function memberName(value) {
  for (const v of list(value)) {
    const raw = typeof v === 'string' ? v : v && typeof v === 'object' ? v['@id'] || v.name : '';
    if (typeof raw === 'string' && raw.trim()) return raw.trim().replace(/\/+$/, '').split(/[/#:]/).pop();
  }
  return '';
}

const key = (name) => name.toLowerCase().replace(/[^a-z]/g, '');

function absolute(href, base) {
  if (typeof href !== 'string' || !href.trim()) return null;
  try {
    const u = new URL(href.trim(), base || undefined);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function modelYear(value) {
  const m = text(value).match(/^((?:19|20)\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// The model year a name starts with or carries ("Used 2019 Ram 1500"),
// never a number glued to other characters ("2500HD").
function yearInName(name) {
  const m = String(name || '').match(/(?<![\w.-])((?:19|20)\d{2})(?![\w.-])/);
  return m ? Number(m[1]) : null;
}

// "1500 Classic Express" with the trim "Express" is model "1500 Classic",
// trim "Express": the listing form joins them again, so the trim is never doubled.
function splitTrim(model, trim) {
  if (!trim) return { model, trim: '' };
  if (model.toLowerCase() === trim.toLowerCase()) return { model, trim: '' };
  if (model.toLowerCase().endsWith(' ' + trim.toLowerCase())) return { model: model.slice(0, model.length - trim.length).trim(), trim };
  return { model, trim };
}

// ---------- condition, title and availability ----------

const CONDITION_WORDS = { used: 'Used', new: 'New', damaged: 'Damaged', refurbished: 'Refurbished' };

// The inventory type in the words dealerInspireNormalize.js uses. A website
// that writes its own short condition text ("Used", "Certified Pre-Owned")
// instead of a schema.org value is taken at its word; anything longer is not
// condition text and is left out, so the gate never reads a full title here.
function inventoryTypeOf(value) {
  const schema = conditionFromSchemaOrg(value);
  if (schema) return CONDITION_WORDS[schema];
  const t = words(value);
  return t && t.length <= 30 && !/\d/.test(t) && t.split(' ').length <= 3 ? t : null;
}

const saysCondition = (title) => readCondition(titleConditionWords(title)) !== 'unknown';

// The website's own title for the car: its name in the markup; or the
// page's title when the name is missing or only the page title starts with
// a condition word, and only when that title is about this car (its model
// year and model are in it), so a list page's title never lends its words
// to the cars on it.
function siteTitleOf(name, pageTitle, year, model) {
  if (name && saysCondition(name)) return name;
  const about = Boolean(pageTitle && year && model) && pageTitle.includes(String(year)) && pageTitle.toLowerCase().includes(model.toLowerCase());
  if (about && (!name || saysCondition(pageTitle))) return pageTitle;
  return name || null;
}

// schema.org ItemAvailability -> the fields dealerInspireNormalize.js fills.
// A sold car reads as sale-pending in the ready check (statusLabel "Sold");
// a car on order is not on the lot yet (inTransit).
const AVAILABILITY = new Map([
  ['instock', { availability: 'In-Stock' }],
  ['instoreonly', { availability: 'In-Stock' }],
  ['limitedavailability', { availability: 'In-Stock' }],
  ['soldout', { statusLabel: 'Sold' }],
  ['outofstock', { statusLabel: 'Sold' }],
  ['discontinued', { statusLabel: 'Sold' }],
  ['reserved', { statusLabel: 'Reserved (sale pending)' }],
  ['preorder', { availability: 'Pre-Order', inTransit: true }],
  ['presale', { availability: 'Pre-Sale', inTransit: true }],
  ['backorder', { availability: 'Back-Order', inTransit: true }],
]);

function availabilityOf(value) {
  const name = memberName(value);
  if (!name) return { status: '', statusLabel: '', availability: null, inTransit: false };
  const known = AVAILABILITY.get(key(name));
  // an availability outside schema.org's list is kept in the website's own
  // words, which the ready check reads as "not on the lot yet"
  return { status: name, statusLabel: '', availability: known ? null : name, inTransit: false, ...known };
}

// ---------- price and mileage ----------

// Every dollar amount the page shows ("$27,163", "$ 27,163.00", "USD 27163").
function shownPrices(pageText) {
  const out = [];
  for (const m of String(pageText || '').matchAll(/(?:\$|\bUSD\b)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d,]*\d)/gi)) {
    out.push(Number(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : '')));
  }
  return out;
}

/**
 * The car's price from its offers, and why there is none when there is none.
 * One Offer (or several that agree) in US dollars, with a positive price
 * that the page also shows. Never an average: an AggregateOffer is a range,
 * not a price. The reason doubles as the label ("No price on the website
 * (the page does not show this price)").
 * @returns {{ value: number|null, label: string, reason: string }}
 */
export function priceFromOffers(node, facts) {
  const offers = nodes(node && node.offers);
  const none = (reason, label = reason) => ({ value: null, label, reason });
  if (!offers.length) return none('the page gives no price', 'Call for price');
  if (offers.some((o) => list(o['@type']).some((t) => memberName(t) === 'AggregateOffer'))) return none('the page gives a price range, not one price');
  const priced = [];
  for (const o of offers) {
    const spec = nodes(o.priceSpecification)[0] || {};
    const raw = o.price ?? spec.price;
    const given = list(raw).find((x) => x !== '' && x !== null && x !== undefined);
    if (given === undefined) continue;
    // words in the price field ("Call for price") are the website's label for no price
    if (typeof given === 'string' && !/\d/.test(given)) return none('the page gives no price', words(given) || 'Call for price');
    const value = toNumber(typeof given === 'string' ? given.trim() : given);
    if (value === null) return none('the price is not a number');
    if (value > 0) priced.push({ value, currency: (text(o.priceCurrency) || text(spec.priceCurrency)).toUpperCase() });
  }
  if (!priced.length) return none('the page gives no price', 'Call for price');
  if (new Set(priced.map((p) => p.value + ' ' + p.currency)).size > 1) return none('the page gives more than one price');
  const { value, currency } = priced[0];
  if (currency !== 'USD') return none(currency ? 'the price is not in US dollars' : 'the page does not say the price is in US dollars');
  if (!shownPrices(facts && facts.text).includes(value)) return none('the page does not show this price');
  return { value, label: 'Price', reason: '' };
}

const MILES = new Set(['smi', 'mi', 'mile', 'miles']);
const KILOMETRES = new Set(['kmt', 'km', 'kms', 'kilometer', 'kilometers', 'kilometre', 'kilometres']);

// Does the page show this number as miles ("41,230 miles", "41,230 mi",
// "Mileage: 41,230")?
function shownAsMiles(value, pageText) {
  const t = String(pageText || '');
  const number = String.raw`(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)(?![\d,]*\d)`;
  const after = new RegExp(number + String.raw`\s*(?:mi|miles)\b`, 'gi');
  const before = new RegExp(String.raw`\b(?:mileage|miles|odometer)\s*:?\s*` + number + String.raw`(?!\s*(?:km|kilomet))`, 'gi');
  for (const re of [after, before]) for (const m of t.matchAll(re)) if (Number(m[1].replace(/,/g, '')) === value) return true;
  return false;
}

/**
 * The odometer reading in miles, and why there is none when there is none.
 * Read when the markup says miles (unitCode SMI, or the unit written out);
 * when it names no unit the reading counts only if the page shows that
 * number as miles; kilometres are never converted.
 * @returns {{ value: number|null, reason: string }}
 */
export function milesFromOdometer(node, facts) {
  const raw = list(node && node.mileageFromOdometer)[0];
  if (raw === undefined || raw === null || raw === '') return { value: null, reason: 'the page gives no mileage' };
  let value = null;
  let unit = '';
  if (typeof raw === 'object') {
    value = toNumber(list(raw.value)[0] ?? null);
    unit = text(raw.unitCode) || text(raw.unitText);
  } else if (typeof raw === 'number') value = toNumber(raw);
  else {
    const m = String(raw).trim().match(/^([\d,.]+)\s*([a-z.]*)$/i);
    if (m) {
      value = toNumber(m[1]);
      unit = m[2];
    }
  }
  if (value === null || value < 0) return { value: null, reason: 'the mileage is not a number' };
  const u = unit.toLowerCase().replace(/\.$/, '');
  if (MILES.has(u)) return { value, reason: '' };
  if (KILOMETRES.has(u)) return { value: null, reason: 'the mileage is in kilometres' };
  if (shownAsMiles(value, facts && facts.text)) return { value, reason: '' };
  return { value: null, reason: u ? 'the page does not say the mileage is in miles' : 'the page gives no unit for the mileage' };
}

// ---------- details ----------

const DRIVES = new Map([
  ['allwheeldriveconfiguration', 'AWD'],
  ['fourwheeldriveconfiguration', '4WD'],
  ['frontwheeldriveconfiguration', 'FWD'],
  ['rearwheeldriveconfiguration', 'RWD'],
]);

function drivetrainOf(value) {
  return DRIVES.get(key(memberName(value))) || words(value);
}

// "5.7L V8" from an EngineSpecification without a name: its displacement in
// litres and its engine type, as stated.
function engineOf(value) {
  const plain = words(value);
  if (plain) return plain;
  const spec = nodes(value)[0];
  if (!spec) return '';
  const size = nodes(spec.engineDisplacement)[0];
  const litres = size && /^(ltr|l|liters?|litres?)$/i.test(text(size.unitCode) || text(size.unitText)) && toNumber(list(size.value)[0] ?? null);
  return [litres ? litres + 'L' : '', words(spec.engineType)].filter(Boolean).join(' ');
}

function photosOf(value, base) {
  const out = [];
  for (const img of list(value)) {
    const raw = typeof img === 'string' ? img : img && typeof img === 'object' ? text(img.contentUrl) || text(img.url) : '';
    const href = absolute(raw, base);
    if (href && !out.includes(href)) out.push(href);
  }
  return out;
}

// A feature list the node carries ("features" or "feature", which schema.org
// does not define but websites add), and each additionalProperty the page
// marks as present (value true or "Yes").
function featuresOf(node) {
  const out = [];
  const add = (f) => {
    const t = words(f);
    if (t && !out.includes(t)) out.push(t);
  };
  for (const f of [...list(node.features), ...list(node.feature)]) add(f);
  for (const p of nodes(node.additionalProperty)) if (list(p.value).some((v) => v === true || /^(true|yes)$/i.test(String(v).trim()))) add(p.name);
  return out;
}

/**
 * Why a price or a mileage was left out, for a person to read:
 * [{ field: 'price' | 'mileage', reason }]. Empty when both were read.
 */
export function readingNotes(node, { facts = null } = {}) {
  const notes = [];
  const price = priceFromOffers(node, facts);
  if (price.value === null) notes.push({ field: 'price', reason: price.reason });
  const miles = milesFromOdometer(node, facts);
  if (miles.value === null) notes.push({ field: 'mileage', reason: miles.reason });
  return notes;
}

/**
 * One schema.org vehicle node -> exactly the fields in src/vehicle.js
 * VEHICLE_FIELDS, or null without a valid VIN.
 * @param {object} node  from schemaOrgParse.js parseVehiclePage (or vehicleNodes)
 * @param {{ url?: string, facts?: object }} page  the page's address and its pageFacts
 */
export function normalizeVehicle(node, { url = null, facts = null } = {}) {
  if (!node || typeof node !== 'object') return null;
  const vin = text(node.vehicleIdentificationNumber).replace(/\s+/g, '').toUpperCase();
  if (!VIN.test(vin)) return null;
  const offers = nodes(node.offers);
  const offer = offers[0] || {};
  const pageUrl = absolute(url);
  const carUrl = absolute(text(node.url), pageUrl) || pageUrl;
  const name = text(node.name);
  const year = modelYear(node.vehicleModelDate) ?? modelYear(node.modelDate) ?? yearInName(name);
  const make = words(node.brand) || words(node.manufacturer);
  const { model, trim } = splitTrim(words(node.model), words(node.vehicleConfiguration));
  const price = priceFromOffers(node, facts);
  const miles = milesFromOdometer(node, facts);
  const state = availabilityOf(offer.availability);
  const location = words(offer.availableAtOrFrom) || words(offer.seller) || words(offer.offeredBy) || null;
  const photos = photosOf(node.image, pageUrl);
  const vinLower = vin.toLowerCase();
  const carfax = list(facts && facts.carfaxLinks).find((href) => typeof href === 'string' && href.toLowerCase().includes(vinLower));
  const spec = nodes(node.vehicleEngine)[0] || {};

  return {
    vin,
    stock: text(node.sku),
    year,
    make,
    model,
    trim,
    name: [year, make, model, trim].filter(Boolean).join(' '),

    // Everything the pre-owned check looks at
    inventoryType: inventoryTypeOf(node.itemCondition ?? offer.itemCondition), // "Used", "New", "Damaged", "Refurbished"
    siteTitle: siteTitleOf(name, facts && typeof facts.title === 'string' ? facts.title : '', year, model),
    readableType: null, // schema.org has no second condition field
    url: carUrl,
    urlConditionWord: conditionWordFromPath(carUrl),
    isDemo: false, // schema.org has no demo or loaner flag; a "demo" in the address or title still counts
    isLoaner: false,
    carfaxUrl: carfax || null, // only a Carfax link that names this car's VIN
    carfaxOneOwner: false, // never read from numberOfPreviousOwners: that is not a Carfax report
    mileage: miles.value,

    // Everything the "ready to post" check and the rescan look at
    price: price.value,
    priceLabel: price.label,
    priceBeforeFees: null, // schema.org has no second, lower price
    status: state.status, // the availability's own name ("InStock", "SoldOut")
    statusLabel: state.statusLabel,
    availability: state.availability,
    inTransit: state.inTransit === true,
    location,
    locationShort: shortLocation(location), // a guess from brand words, settled over the lot's store names by scanWithSearch
    photoCount: photos.length,
    photos,
    dateInStock: null,

    // Text for the description writer
    descriptionRaw: (list(node.description).find((d) => typeof d === 'string' && d.trim()) || '').trim(),
    features: featuresOf(node),

    // Details for the eventual listing
    exteriorColor: words(node.color),
    interiorColor: words(node.vehicleInteriorColor),
    bodyType: words(node.bodyType),
    drivetrain: drivetrainOf(node.driveWheelConfiguration),
    engine: engineOf(node.vehicleEngine),
    transmission: words(node.vehicleTransmission),
    fuelType: words(node.fuelType) || words(spec.fuelType),
  };
}
