// The inventory data a dealer website's own list page loads as JSON, read
// without knowing the platform's exact field names. Shared by the DealerOn
// and Dealer.com adapters (dealerOn.js, dealerCom.js), the way
// schemaOrgParse.js is shared: pure, string- and object-level, so the service
// worker can run it.
//
// Why tolerant: the two platforms' inventory answers were described from
// public sources only (Dealer.com's Web Integration API documentation, a
// public write-up of DealerOn's list data, the 2026-10-01 survey of local
// dealer websites), never read from a live site from here. So nothing below
// depends on one wrapper name or one spelling of a field:
//   - findCards walks the answer for the objects that carry a valid VIN;
//   - pick reads a field by any of its usual names, ignoring case, a
//     "Vehicle" prefix (DealerOn's VehicleVin, VehicleYear) and one level of
//     nesting (Dealer.com's address.accountName), and also reads
//     [{ name, value }] attribute lists;
//   - labeledPrices / choosePrices read every price the record labels and
//     pick the website's selling price by its label (see choosePrices).
// What a field means is never guessed past its name: a field this file
// can't name stays empty, and the pre-owned gate and the ready check treat
// an empty field as they always do (Needs a look, Not ready).

import { toNumber, shortLocation, conditionWordFromPath } from '../src/normalize.js';
import { parseVehiclePage } from './schemaOrgParse.js';
import { normalizeVehicle as normalizeStandard, GUIDE_PRICE_WORDS } from './schemaOrgNormalize.js';

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const MAX_DEPTH = 8;

// "VehicleVin" -> "vin", "stock_number" -> "stocknumber", "Year" -> "year".
export function keyName(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return k.length > 7 && k.startsWith('vehicle') ? k.slice(7) : k;
}

const isPlain = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

// A record's attribute lists ([{ name, value }], as some platforms send the
// car's details) read as plain fields.
function attributeFields(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (!Array.isArray(v) || !/attributes?$/i.test(k)) continue;
    for (const a of v) {
      if (!isPlain(a) || typeof a.name !== 'string') continue;
      const value = a.value ?? a.normalizedValue ?? a.labeledValue;
      if (value !== undefined && value !== null && value !== '') out[a.name] = value;
    }
  }
  return out;
}

/**
 * The first value found under any of the names, in this order: the
 * record's own keys (the names in their order), then its attribute lists,
 * then, only when `nested` is set, one level of nested objects (Dealer.com's
 * address.accountName). Nested objects are never read otherwise: a Carfax
 * object's link, a dealer object's name or an offer's type is not the car's.
 * @param {object} record
 * @param {string[]} names  already in keyName() form
 * @param {{ nested?: boolean }} [how]
 */
export function pick(record, names, { nested = false } = {}) {
  if (!isPlain(record)) return undefined;
  const layers = [record, attributeFields(record), ...(nested ? Object.values(record).filter(isPlain) : [])];
  for (const layer of layers) {
    for (const name of names) {
      for (const [k, v] of Object.entries(layer)) {
        if (keyName(k) === name && v !== undefined && v !== null && v !== '') return v;
      }
    }
  }
  return undefined;
}

export function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isPlain(value)) return textOf(value.value ?? value.name ?? value.label ?? value.text ?? '');
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) return textOf(value.join(' '));
  return '';
}

const truthy = (value) => value === true || (typeof value === 'string' && /^(?:true|yes|y|1)$/i.test(value.trim())) || value === 1;

export function vinIn(x) {
  if (!isPlain(x)) return '';
  for (const [k, v] of Object.entries(x)) {
    const name = keyName(k);
    if (name === 'vin' || name === 'identificationnumber' || name === 'vinnumber') {
      const vin = textOf(v).replace(/\s+/g, '').toUpperCase();
      if (VIN.test(vin)) return vin;
    }
  }
  return '';
}

/**
 * The car records of an inventory answer, in the order it gives them, one
 * per VIN: the objects that carry a valid VIN under a VIN name, in the one
 * list of the answer that holds the most of them. An element without a VIN
 * of its own gives the nested object that has it (DealerOn's
 * DisplayCards[].VehicleCard). Objects outside lists are not cars, and a
 * smaller list beside the lot's (featured cars, specials) is not the lot:
 * its cars would also throw out the page size the paging counts by.
 * @param {unknown} json
 * @returns {object[]}
 */
export function findCards(json) {
  return findCardList(json).cards;
}

/**
 * findCards, saying where the list was ({ cards, path }: the keys leading
 * to it). With `path` from the list's first page, a later page reads the
 * list at the same place even when it holds fewer cars than a list beside
 * it (the last page of the lot next to two featured cars).
 * @param {unknown} json
 * @param {string|null} [path]
 */
export function findCardList(json, path = null) {
  let best = { cards: [], path: null };
  let same = null;
  const visit = (x, depth, at) => {
    if (depth > MAX_DEPTH || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      const cards = [];
      const seen = new Set();
      for (const el of x) {
        if (!isPlain(el)) {
          visit(el, depth + 1, at);
          continue;
        }
        const inner = vinIn(el) ? null : Object.entries(el).find(([, v]) => isPlain(v) && vinIn(v));
        let card = vinIn(el) ? el : null;
        if (inner) {
          card = { ...el, ...inner[1] };
          if (!Object.prototype.hasOwnProperty.call(inner[1], inner[0])) delete card[inner[0]];
        }
        if (card) {
          const vin = vinIn(card);
          if (!seen.has(vin)) {
            seen.add(vin);
            cards.push(card);
          }
        } else {
          visit(el, depth + 1, at);
        }
      }
      if (path !== null && at === path && !same) same = { cards, path: at };
      if (cards.length > best.cards.length) best = { cards, path: at };
      return;
    }
    for (const [k, v] of Object.entries(x)) visit(v, depth + 1, at ? `${at}.${k}` : k);
  };
  visit(json, 0, '');
  return same || best;
}

const TOTAL_NAMES = new Set(['totalcount', 'totalrecords', 'totalresults', 'totalvehicles', 'totalvehiclecount', 'totalitems', 'resultcount', 'recordcount', 'totalrecordcount']);

/**
 * The number of cars the answer says the whole list holds, or null. Read
 * only under a name that says so (totalCount, TotalRecords...), never a bare
 * "total", which can be a price, and never inside a car record.
 * @param {unknown} json
 */
export function totalCount(json) {
  let found = null;
  const visit = (x, depth) => {
    if (found !== null || depth > MAX_DEPTH || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const el of x) if (!vinIn(el)) visit(el, depth + 1);
      return;
    }
    if (vinIn(x)) return;
    for (const [k, v] of Object.entries(x)) {
      if (TOTAL_NAMES.has(keyName(k))) {
        const n = toNumber(v);
        if (n !== null && n >= 0 && Number.isInteger(n)) {
          found = n;
          return;
        }
      }
    }
    for (const v of Object.values(x)) visit(v, depth + 1);
  };
  visit(json, 0);
  return found;
}

// ---------- prices ----------

// Words that make an amount something other than the price a buyer pays
// today: a manufacturer's, earlier or book price, a payment, a fee or a
// discount on its own, a price only some buyers get, an estimate.
const NOT_THE_PRICE = /msrp|\bwas\b|original|previous|prior|\bold\b|list ?price|^list|compare|strike|payment|per ?month|monthly|\bmo\b|lease|financ|rebate|incentive|saving|discount|conditional|\bfees?\b|docfee|\btax|invoice|trade|down ?payment|\bapr\b|cash ?back|bonus|wholesale|employee|supplier|military|loyalty|conquest|lowest|highest|market|book|estimat|\bvalue\b(?<!retail value)/i;
// A guide's value, an estimate or an offer for the car ("KBB Value",
// "Market Price", "Instant Cash Offer"): the standard-data reader's own list
// (schemaOrgNormalize.js GUIDE_PRICE_WORDS), so the two readers never
// drift. Never the price, whatever words sit beside it ("Your Cash Offer"),
// and when the record has no other price the reason quotes the label.
const GUIDE_PRICE = new RegExp(String.raw`\b(?:${GUIDE_PRICE_WORDS})\b`, 'i');
// A label that IS a guide's or an offer's figure: those words at its end,
// or followed only by "price", "value" or "offer" ("Market Value", "KBB
// Value", "Instant Cash Offer Price"), as the standard-data reader's
// REFERENCE_CUE ends them. Not "Estimated Payment" or "Trade-In Bonus": a
// payment or an incentive named after a guide or a trade is never quoted as
// if it might be the car's price, and a field so named is not read.
const GUIDE_LABEL = new RegExp(String.raw`\b(?:${GUIDE_PRICE_WORDS})\b\.?(?:[\s:\-\u2013\u2014\u00ae\u2122]*(?:price|pricing|value|offer)\b)*[\s:\-\u2013\u2014\u00ae\u2122]*$`, 'i');
// The base price a dealer's own price is built from on these platforms:
// "Retail Price", "Retail Value", a "starting" price.
const BASE_WORDS = /retail|\bbase\b|asking|starting/i;
// The price the website says it sells at: a platform's final price, an
// internet, sale or selling price.
const SELLING_WORDS = /\bfinal|internet|\bdealer\b|\bsale\b|selling|\bour\b|\byour\b|e-?price|\bnow\b/i;
const GENERIC_PRICE = /^\s*(?:the\s+)?price\s*:?\s*$/i;
const NAMED_PRICE = /^\s*[A-Za-z][\w.&'’ -]{0,40}\s+price\s*:?\s*$/i;

// "finalPrice" -> "final Price", "VehicleInternetPrice" -> "Vehicle Internet Price".
const spaced = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();

function amount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  // only a plain amount: "$23,985", "23985", "23,985.00"; never "From $199/mo" or "Call"
  if (!/^\$?\s*\d{1,3}(?:,\d{3})+(?:\.\d{2})?$|^\$?\s*\d+(?:\.\d{2})?$/.test(s)) return null;
  const n = toNumber(s.replace(/[$\s,]/g, ''));
  return n !== null && n > 0 ? n : null;
}

/**
 * Every amount the record labels as a price, with its label and where it
 * came from: label/value objects (Dealer.com's pricing entries:
 * { label, value, typeClass, isFinalPrice }), fields named for a price
 * (finalPrice, VehicleInternetPrice, retailPrice) and fields named for a
 * guide's value or an offer (VehicleMarketValue, kbbValue: never the price,
 * read so a car with only such a figure has its label quoted). Nested up to
 * four levels; never inside photos or features.
 * @param {object} record
 * @returns {{ value: number, label: string, key: string, final: boolean }[]}
 */
export function labeledPrices(record) {
  const out = [];
  const visit = (x, key, depth) => {
    if (depth > 4 || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const el of x) visit(el, key, depth + 1);
      return;
    }
    const label = textOf(x.label ?? x.title ?? x.displayName ?? '');
    const kind = textOf(x.typeClass ?? x.type ?? x.name ?? '');
    const value = amount(x.value ?? x.amount ?? x.price ?? x.displayValue);
    if (value !== null && (label || kind)) {
      out.push({ value, label: label || spaced(kind), key: `${key}.${kind}`, final: truthy(x.isFinalPrice) || truthy(x.isFinal) });
      return;
    }
    for (const [k, v] of Object.entries(x)) {
      if (/image|photo|picture|feature|option|media|attribute/i.test(k)) continue;
      const n = /price/i.test(k) || GUIDE_LABEL.test(spaced(k)) ? amount(v) : null;
      if (n !== null) out.push({ value: n, label: spaced(k).replace(/^Vehicle\s+/i, ''), key: k, final: keyName(k) === 'finalprice' });
      else if (v && typeof v === 'object') visit(v, k, depth + 1);
    }
  };
  visit(record, '', 0);
  return out;
}

// Words of a name, for matching a "<Dealer> Price" label to the dealership:
// every word, single letters too ("J.D." is "j d"), so "J.D. Power Price" is
// never explained by a "Power Chevrolet".
const nameWords = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Whether a label is the dealership's own price, "<Dealer> Price": every
 * word before "Price" is in the dealership's name as the record gives it
 * ("Sample Price" at "Sample Chevrolet"). A dealership's name can hold a word
 * that otherwise says a figure is not the price ("Kelley Chevrolet", "Old
 * Town Ford", "Value Auto Mart", "Trade Winds Toyota"); such a label is the
 * dealer's own only when its words open the name, as the platforms write it
 * (DealerOn the whole name, Dealer.com its first word): "Kelley Price" at
 * "Kelley Chevrolet" is the dealer's price, "Market Price" at "Auto Market of
 * Springfield" is not, and with no dealership name on the record nothing is.
 * @param {string} label
 * @param {string} [dealer]
 */
export function isDealerPrice(label, dealer = '') {
  if (!NAMED_PRICE.test(String(label || ''))) return false;
  const before = String(label).replace(/\s+price\s*:?\s*$/i, '');
  const own = nameWords(before);
  const theirs = nameWords(dealer);
  if (!own.length || !own.every((w) => theirs.includes(w))) return false;
  return !labelIsNotThePrice(before) || own.every((w, i) => theirs[i] === w);
}

/**
 * What one labeled price is: 'selling', 'base', 'plain' (just "Price"),
 * 'named' (a "<Something> Price" this record's dealership name does not
 * explain) or 'other' (never used). "<Dealer> Price" (isDealerPrice) is a
 * selling price, and the dealership's name in it never makes it something
 * else: a "KBB Price" or "Market Price" the name does not explain is never
 * mistaken for the dealer's.
 * @param {{ label: string, key: string, final: boolean }} entry
 * @param {string} [dealer]  the dealership name the record carries
 */
export function priceKind(entry, dealer = '') {
  const dealers = isDealerPrice(entry.label, dealer);
  const words = `${dealers ? '' : entry.label} ${spaced(entry.key)}`;
  if (labelIsNotThePrice(words)) return 'other';
  if (entry.final) return 'selling';
  if (BASE_WORDS.test(words)) return 'base';
  if (SELLING_WORDS.test(words)) return 'selling';
  if (GENERIC_PRICE.test(entry.label) || /^price$/i.test(keyName(entry.key.split('.').pop()))) return 'plain';
  if (dealers) return 'selling';
  return NAMED_PRICE.test(entry.label) ? 'named' : 'other';
}

const NO_PRICE = (label) => ({ price: null, priceLabel: label, priceBeforeFees: null });

// Labels quoted for a person to check, as the reason a car has no price.
function quoteLabels(labels) {
  const quoted = [...new Set(labels.map((l) => String(l).slice(0, 60)))].slice(0, 3).map((l) => `"${l}"`);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0];
  return `the list labels its ${quoted.length > 1 ? 'prices' : 'price'} ${list}, which Lot Current does not read as the selling price`;
}

// The labels of a guide's or an offer's figures, quoted: some websites
// label their own selling price that way ("Market Price"), and the price is
// still not taken. A payment or an incentive is not such a label.
function guideLabelled(entries) {
  const labels = entries.map((e) => e.label || spaced(e.key)).filter((l) => GUIDE_LABEL.test(l));
  return labels.length ? quoteLabels(labels) : null;
}

// The record's own label for its price, in a field of its own (DealerOn's
// VehiclePriceLabel, as the fixtures have it: "Sample Motors Price"), read
// at the record's top level under a name such as PriceLabel or PriceTitle:
// { key, label }, or null when it has none.
const OWN_LABEL = /^(?:display|final|selling|main|primary)?price(?:label|title|caption)$/;
export function ownPriceLabel(record) {
  if (!isPlain(record)) return null;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'string' || !OWN_LABEL.test(keyName(k))) continue;
    const label = textOf(v);
    if (label && amount(label) === null) return { key: k, label: label.slice(0, 60) };
  }
  return null;
}

// Whether a label names something other than the selling price: a guide's
// value, an offer, an MSRP, a payment (the words priceKind reads as 'other').
export const labelIsNotThePrice = (label) => NOT_THE_PRICE.test(label) || GUIDE_PRICE.test(label);

/**
 * The website's price and, when it shows one, the lower base price.
 *   price           the selling price: one the platform marks as final, else
 *                   one labelled final/internet/sale/dealer or named for the
 *                   dealership ("<Dealer> Price"), else a plain "Price", else
 *                   the base price when it is the only one. On the sites
 *                   surveyed this is the dealer's price with its doc fee.
 *   priceBeforeFees a base ("Retail", plain "Price") amount below it, when
 *                   the record has one; the dealer's price basis setting
 *                   (settings.js, rescan.js basisPrice) chooses between them.
 * When it can't tell, there is no price and the label says why, so the car
 * waits on Not ready rather than going out at a price picked by chance: two
 * selling prices that disagree, or a "<Something> Price" the dealership's
 * name does not explain next to the plain or base price ("Two prices on
 * the website"). A record whose only figures are a guide's or an offer's
 * ("Market Price", "Instant Cash Offer") gets no price either, and the label
 * quotes them (guideLabelled). So does a record whose own label for its
 * price (`label`, ownPriceLabel's label) names something other than the selling
 * price ("Market Value", "Instant Cash Offer", "MSRP") and is not the
 * dealership's own "<Dealer> Price" (isDealerPrice): the price it labels
 * is that figure whatever its field is called, and with the website's own
 * price unknown no other figure on the record is taken instead.
 * @param {{ value: number, label: string, key: string, final: boolean }[]} entries
 * @param {{ dealer?: string, label?: string|null }} [context]
 */
export function choosePrices(entries, { dealer = '', label = null } = {}) {
  if (label && labelIsNotThePrice(label) && !isDealerPrice(label, dealer)) return NO_PRICE(quoteLabels([label]));
  const kinds = (entries || []).map((e) => ({ ...e, kind: priceKind(e, dealer) }));
  const of = (kind) => kinds.filter((e) => e.kind === kind);
  const selling = of('selling');
  const plain = of('plain');
  const base = of('base');
  const named = of('named');
  const differ = (list) => new Set(list.map((e) => e.value)).size > 1;
  const TWO = 'Two prices on the website';
  let main = null;
  const flagged = selling.filter((e) => e.final);
  const pool = flagged.length ? flagged : selling;
  if (pool.length) {
    if (differ(pool)) return NO_PRICE(TWO);
    main = pool[0];
  } else if (named.length) {
    return NO_PRICE(TWO);
  } else if (plain.length) {
    if (differ(plain)) return NO_PRICE(TWO);
    main = plain[0];
  } else if (base.length) {
    if (differ(base)) return NO_PRICE(TWO);
    main = base[0];
  }
  if (!main) return NO_PRICE(guideLabelled(kinds) || 'Call for price');
  const lower = [...base, ...plain].filter((e) => e !== main && e.value < main.value).map((e) => e.value);
  return { price: main.value, priceLabel: main.label || 'Price', priceBeforeFees: lower.length ? Math.max(...lower) : null };
}

// ---------- photos ----------

/**
 * Photo addresses from an images field: strings, or objects with
 * uri/url/src/href. Made absolute against the website; only http(s).
 * @param {unknown} value
 * @param {string} base
 */
export function imageUrls(value, base) {
  const out = [];
  const add = (u) => {
    if (typeof u !== 'string' || !u.trim()) return;
    try {
      const abs = new URL(u.trim(), base || undefined);
      if ((abs.protocol === 'https:' || abs.protocol === 'http:') && !out.includes(abs.href)) out.push(abs.href);
    } catch (e) {
      // not an address
    }
  };
  for (const item of Array.isArray(value) ? value : value ? [value] : []) {
    if (typeof item === 'string') add(item);
    else if (isPlain(item)) add(item.uri ?? item.url ?? item.src ?? item.href ?? item.imageUrl ?? item.large ?? item.full);
  }
  return out;
}

// ---------- the flat vehicle ----------

const N = {
  vin: ['vin', 'identificationnumber', 'vinnumber'],
  stock: ['stocknumber', 'stock', 'stockno', 'stocknum'],
  year: ['year', 'modelyear'],
  make: ['make', 'makename', 'brand'],
  model: ['model', 'modelname'],
  trim: ['trim', 'trimname', 'trimlevel'],
  mileage: ['odometer', 'mileage', 'miles', 'odometervalue'],
  mileageUnit: ['odometerunit', 'odometerunits', 'mileageunit', 'mileageunits', 'odometerunitofmeasure', 'distanceunit'],
  url: ['link', 'detailurl', 'detailsurl', 'vdpurl', 'detailpageurl', 'url', 'href'],
  images: ['images', 'photos', 'imageurls', 'photourls', 'pictures', 'photo', 'image', 'imageurl', 'photourl'],
  photoCount: ['photocount', 'imagecount', 'numberofphotos', 'numberofimages', 'photoscount'],
  condition: ['inventorytype', 'condition', 'conditiontype', 'newused', 'stocktype', 'type'],
  certified: ['certified', 'iscertified', 'cpo', 'iscpo'],
  title: ['title', 'name', 'displayname', 'heading'],
  status: ['status', 'statuscode'],
  statusLabel: ['statuslabel', 'statustext', 'availabilitystatus'],
  inTransit: ['intransit', 'isintransit'],
  demo: ['isdemo', 'demo'],
  loaner: ['isloaner', 'loaner'],
  exterior: ['exteriorcolor', 'extcolor', 'exteriorcolorname', 'colorexterior'],
  interior: ['interiorcolor', 'intcolor', 'interiorcolorname', 'colorinterior'],
  body: ['bodystyle', 'bodytype', 'body'],
  drivetrain: ['driveline', 'drivetrain', 'drivetype'],
  engine: ['engine', 'enginedescription'],
  transmission: ['transmission', 'transmissiondescription'],
  fuel: ['fueltype', 'fuel'],
  location: ['accountname', 'dealershipname', 'dealername', 'locationname', 'storename', 'location'],
  description: ['description', 'dealercomments', 'comments', 'sellercomments', 'vehiclecomments'],
  features: ['features', 'highlights', 'highlightedfeatures'],
  dateInStock: ['dateinstock', 'instockdate', 'stockdate', 'datereceived', 'inventorydate'],
  carfax: ['carfaxurl', 'carfaxlink', 'historyreporturl', 'carfax'],
};

// A condition value in words, however the platform writes it: a code in
// one word or with underscores ("SERVICE_LOANER", "ServiceLoaner",
// "CERTIFIED_PRE_OWNED") reads as "SERVICE LOANER", "Service Loaner",
// "CERTIFIED PRE OWNED".
const conditionWords = (raw) => String(raw).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
// A demo or loaner in a condition value even when its words run together
// with no case to split them by ("SERVICELOANER", "demounit"): read from its
// letters alone, so such a unit is never taken for a plain used car.
const DEMO_LETTERS = /demo/i;
const LOANER_LETTERS = /loaner|courtesy/i;
const lettersOf = (text) => String(text).replace(/[^a-z]/gi, '');

// A condition word the gate can read, from a condition field; a field that
// says nothing about new or used ("Car", "SUV") is not a condition.
function conditionOf(card) {
  const raw = textOf(pick(card, N.condition));
  if (/^\s*u\s*$/i.test(raw)) return 'Used'; // a one-letter code, as some list data sends it
  if (/^\s*n\s*$/i.test(raw)) return 'New';
  const words = conditionWords(raw);
  if (/\b(?:new|used|pre-?\s?owned|certified|cpo|demo(?:nstrator)?|loaner|courtesy)\b/i.test(words)) return words;
  return DEMO_LETTERS.test(lettersOf(raw)) || LOANER_LETTERS.test(lettersOf(raw)) ? raw : '';
}

/**
 * Every condition field the record carries, top level and attribute lists,
 * in the order of N.condition's names: { key, text }. conditionOf reads the
 * first; the demo, loaner and certified words are read in all of them, since
 * a record can say "used" in one ("inventoryType") and "Loaner" in another
 * ("type", "stockType").
 * @param {object} card
 * @returns {{ key: string, text: string }[]}
 */
export function conditionFields(card) {
  if (!isPlain(card)) return [];
  const out = [];
  for (const layer of [card, attributeFields(card)]) {
    for (const name of N.condition) {
      for (const [k, v] of Object.entries(layer)) {
        const text = keyName(k) === name ? textOf(v) : '';
        if (text) out.push({ key: k, text });
      }
    }
  }
  return out;
}

function carfaxOf(card, vin) {
  const named = textOf(pick(card, N.carfax));
  if (/^https?:\/\//i.test(named)) return named;
  // any address in the record that is a Carfax report for this car
  let found = null;
  const visit = (x, depth) => {
    if (found || depth > 4 || !x) return;
    if (typeof x === 'string') {
      if (/^https?:\/\/[^\s"']*carfax\.com\//i.test(x) && x.toUpperCase().includes(vin)) found = x;
      return;
    }
    if (typeof x === 'object') for (const v of Object.values(x)) visit(v, depth + 1);
  };
  visit(card, 0);
  return found;
}

const MILE_UNITS = new Set(['mi', 'mile', 'miles', 'smi']);
const KILOMETRE_UNITS = new Set(['km', 'kms', 'kmt', 'kilometer', 'kilometers', 'kilometre', 'kilometres']);

/**
 * The odometer reading in miles, and why there is none when there is none.
 * A number the record gives with no unit is miles, as these US platforms
 * send it; one written with a unit ("31,207 miles", "31,207 mi") or beside a
 * unit field counts only when that unit is miles. Kilometres are never
 * turned into miles, and any other unit or text is no mileage, so the car
 * waits on Needs a look (classify.js) instead of going out with a wrong
 * figure.
 * @param {object} card
 * @returns {{ value: number|null, reason: string }}
 */
export function mileageOf(card) {
  const raw = pick(card, N.mileage);
  if (raw === undefined) return { value: null, reason: 'the list gives no mileage' };
  let value = null;
  let unit = '';
  if (typeof raw === 'number') value = Number.isFinite(raw) ? raw : null;
  else if (isPlain(raw)) {
    const inner = raw.value ?? raw.amount;
    value = typeof inner === 'number' && Number.isFinite(inner) ? inner : toNumber(textOf(inner).replace(/,/g, ''));
    unit = textOf(raw.unit ?? raw.unitCode ?? raw.unitText ?? raw.units ?? '');
  } else {
    // a mileage written out is short: a number and at most a unit
    const written = textOf(raw);
    const m = written.length <= 40 ? written.match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*([a-z.]*)$/i) : null;
    if (m) {
      value = toNumber(m[1].replace(/,/g, ''));
      unit = m[2];
    }
  }
  if (value === null || value < 0) return { value: null, reason: 'the mileage is not a number' };
  const u = (unit || textOf(pick(card, N.mileageUnit))).toLowerCase().replace(/\.$/, '');
  if (!u || MILE_UNITS.has(u)) return { value, reason: '' };
  if (KILOMETRE_UNITS.has(u)) return { value: null, reason: 'the mileage is in kilometres' };
  return { value: null, reason: 'the list does not say the mileage is in miles' };
}

// A date the website gives, kept only when it reads as one.
function dateOf(value) {
  const s = textOf(value);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

const strings = (value) => (Array.isArray(value) ? value : []).map((f) => textOf(f)).filter(Boolean);

/**
 * One inventory record -> the flat vehicle (src/vehicle.js VEHICLE_FIELDS).
 * `page` is what the car's own page added at post time (all its photos, its
 * description), when it was read.
 * @param {object} card
 * @param {{ origin: string, page?: { photos?: string[], description?: string|null, carfaxUrl?: string|null } }} where
 */
export function normalizeInventoryRecord(card, { origin, page = null } = {}) {
  const vin = vinIn(card);
  if (!vin) return null;
  const year = toNumber(textOf(pick(card, N.year)));
  const make = textOf(pick(card, N.make));
  const model = textOf(pick(card, N.model));
  const trim = textOf(pick(card, N.trim));
  let url = null;
  const link = textOf(pick(card, N.url));
  if (link) {
    try {
      const u = new URL(link, origin);
      if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href;
    } catch (e) {
      // not an address
    }
  }
  const certified = truthy(pick(card, N.certified));
  const condition = conditionOf(card);
  // A demo or loaner word in the condition counts like the platform's own
  // flag, and a certified flag never renames it: a certified service loaner
  // stays a loaner for the pre-owned gate (classify.js). Its certified mark
  // is kept beside it as the second condition field (readableType), so the
  // gate sees a car the website calls both certified and a loaner, and sends
  // it to Needs a look instead of Ready, or instead of skipping it as sold as
  // new without a word about the mark. A plain certified car gets no second
  // sign from its mark: its type already says Certified Used. A certified
  // word in the condition itself ("Certified Loaner") is the same mark as
  // the flag. The gate counts that mark even when the title has words of its
  // own (classify.js checkPreOwned). A demo, loaner or certified word in any
  // of the record's condition fields counts, not only in the first.
  // Every condition field counts for these words, not only the first one
  // present (conditionFields): "used" in one beside "Loaner" in another is a
  // loaner, and "Certified" in another is the certified mark.
  const fields = [condition, ...conditionFields(card).map((f) => f.text)];
  const demoWord = fields.some((t) => DEMO_LETTERS.test(lettersOf(t)));
  const loanerWord = fields.some((t) => LOANER_LETTERS.test(lettersOf(t)));
  const inventoryType = certified && !/\bnew\b/i.test(condition) && !demoWord && !loanerWord ? 'Certified Used' : condition || null;
  const marked = certified || fields.some((t) => /\b(?:certified|cpo)\b/i.test(conditionWords(t)));
  const readableType = marked && (demoWord || loanerWord) ? 'Certified' : null;
  const title = textOf(pick(card, N.title));
  const location = textOf(pick(card, N.location, { nested: true })) || null;
  const own = ownPriceLabel(card);
  const prices = choosePrices(labeledPrices(card), { dealer: location || '', label: own && own.label });
  const cardPhotos = imageUrls(pick(card, N.images), url || origin);
  const photos = page && Array.isArray(page.photos) && page.photos.length ? page.photos.slice() : cardPhotos;
  const counted = toNumber(textOf(pick(card, N.photoCount)));
  const status = textOf(pick(card, N.status));
  const statusLabel = textOf(pick(card, N.statusLabel));
  const mileage = mileageOf(card).value;
  const described = page && typeof page.description === 'string' ? page.description : textOf(pick(card, N.description));
  const inTransit = truthy(pick(card, N.inTransit)) || /transit/i.test(`${status} ${statusLabel}`);

  return {
    vin,
    stock: textOf(pick(card, N.stock)),
    year,
    make,
    model,
    trim,
    name: [year, make, model, trim].filter(Boolean).join(' '),

    // the pre-owned gate: the record's condition, the car's address, its title
    inventoryType,
    siteTitle: title || null,
    readableType,
    url,
    urlConditionWord: conditionWordFromPath(url),
    isDemo: truthy(pick(card, N.demo)) || demoWord,
    isLoaner: truthy(pick(card, N.loaner)) || loanerWord,
    carfaxUrl: (page && page.carfaxUrl) || carfaxOf(card, vin),
    carfaxOneOwner: false, // never inferred: only a Carfax report says one owner
    mileage,

    // the ready check and the rescan
    price: prices.price,
    priceLabel: prices.priceLabel,
    priceBeforeFees: prices.priceBeforeFees,
    status,
    statusLabel,
    availability: inTransit ? 'In-Transit' : null,
    inTransit,
    location,
    locationShort: shortLocation(location), // a guess from brand words, settled over the lot's store names by scanWithSearch
    photoCount: photos.length > (counted || 0) ? photos.length : counted ?? photos.length,
    photos,
    dateInStock: dateOf(pick(card, N.dateInStock)),

    // text for the description writer: null means this read had none
    descriptionRaw: described ? described : null,
    features: strings(pick(card, N.features)),

    // listing details
    exteriorColor: textOf(pick(card, N.exterior)),
    interiorColor: textOf(pick(card, N.interior)),
    bodyType: textOf(pick(card, N.body)),
    drivetrain: textOf(pick(card, N.drivetrain)),
    engine: textOf(pick(card, N.engine)),
    transmission: textOf(pick(card, N.transmission)),
    fuelType: textOf(pick(card, N.fuel)),
  };
}

/**
 * Where the photos are hosted, from a scan's records ({ card, origin }).
 * @param {{ card: object, origin: string }[]} records
 */
export function photoOriginsOf(records) {
  const out = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.card) continue;
    const v = normalizeInventoryRecord(r.card, { origin: r.origin, page: r.page });
    for (const u of v ? v.photos : []) {
      try { out.add(new URL(u).origin); } catch (e) { /* not absolute */ }
    }
  }
  return [...out].sort();
}

// ---------- reading the list, checking a missing car, one car's details ----------
//
// scanInventory and detailsFor are the scan() and getDetails() of an adapter
// whose website loads its list as JSON from its own origin. The adapter
// gives:
//   search(request)        one GET on the website, { url } -> { ok, status,
//                          finalUrl, redirected, contentType, json, text }
//                          (its searchInPage or makeDirectSearch)
//   pageAddress(url, n, firstCount)  the inventory address for list page n
//                          (1-based), from the address the page itself
//                          called; firstCount is how many cars page 1 held
//   pagePhotos(html, vin, pageUrl)   the photo addresses its car pages carry
//   pageGapMs              the fixed gap between two car-page reads when
//                          the website's robots.txt can't be read (0: none;
//                          a readable robots.txt decides otherwise);
//                          options.pageGapMs overrides both (the tests)
// Requests go one at a time, with no pauses between list pages and nothing random about
// their timing. A refusal (403, 429, 503) stops the scan and says so; nothing is
// retried and nothing is worked around.

export const MAX_INVENTORY_PAGES = 30;
// The most missing cars one scan checks at their own pages. The rest wait
// for the next scan (nothing is marked gone for them): a list that lost
// many cars at once is more likely a website hiccup than a sales day, and
// with a fixed gap between page reads the check stays short.
export const MAX_CONFIRM_PAGES = 12;
// Missing cars' pages failing in a row (a 500, an answer from another
// website, a timeout) before the check stops for this scan: a website
// having a bad day is not read further, and the rest wait unconfirmed.
export const MAX_FAILED_IN_A_ROW = 3;

// The longest fixed gap one scan keeps between two car-page reads. A website
// whose robots.txt asks for more gets one car page per scan instead, so
// nothing is read faster than it asks and a scan stays short.
export const MAX_PAGE_GAP_MS = 10000;

/**
 * The Crawl-delay a robots.txt gives every robot (a group naming
 * User-agent: *), in seconds, or null when it gives none.
 * @param {string} text
 */
export function crawlDelaySeconds(text) {
  let agents = [];
  let inRules = false;
  let delay = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.replace(/#.*/, ''));
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(m[2]);
      continue;
    }
    inRules = true;
    if (field === 'crawl-delay' && agents.includes('*')) {
      const n = Number(m[2]);
      if (Number.isFinite(n) && n >= 0) delay = Math.max(delay ?? 0, n);
    }
  }
  return delay;
}

// A robots.txt answer that is the file itself: plain text, not a web page
// answering 200 for every address.
function isRobotsText(answer) {
  if (typeof answer.text !== 'string') return false;
  if (/html/i.test(answer.contentType || '')) return false;
  return !/^\s*<(?:!doctype|html|head|body)\b/i.test(answer.text);
}

const REFUSED = { 401: 'asked for a sign-in (401)', 403: 'turned the read away (403)', 429: 'asked for fewer requests (429)', 503: 'said it is unavailable right now (503)' };

function originOf(href) {
  try {
    return new URL(String(href)).origin;
  } catch (e) {
    return null;
  }
}

// Why a missing car's own page could not settle whether it is gone, in the
// words the standard-data reader uses for the same (schemaOrg.js
// pageProblem), since the rescan puts it in the car's to-do item ("Missing
// from this scan, and its page gave HTTP 500, so it was not marked gone").
function carPageProblem(answer, origin, thrown = null) {
  if (thrown) return `its page could not be read (${String((thrown && thrown.message) || thrown).slice(0, 120)})`;
  if (!answer || typeof answer !== 'object') return 'its page gave no answer';
  if (answer.finalUrl && originOf(answer.finalUrl) !== origin) return `its page sent Lot Current to another website (${originOf(answer.finalUrl) || 'an address that is not a website'})`;
  return `its page gave HTTP ${answer.status}`;
}

// Why an answer can't be used, or null when it can.
function problemWith(answer, origin) {
  if (!answer || typeof answer !== 'object') return 'no answer';
  if (answer.finalUrl && originOf(answer.finalUrl) !== origin) return `the answer came from ${originOf(answer.finalUrl) || 'another website'}`;
  if (REFUSED[answer.status]) return `the website ${REFUSED[answer.status]}`;
  if (!answer.ok) return `the website answered ${answer.status}`;
  return null;
}

/**
 * The adapter's scan(): the list through the inventory address its page
 * called, page by page, then the cars the last scan had that did not come
 * back, each checked at its own page.
 */
export async function scanInventory(search, options, platform) {
  options = options || {};
  const { origin, inventoryUrl, confirmVins = [], confirmUrls = {} } = options;
  let requests = 0;
  const call = async (url) => {
    requests += 1;
    return search({ url });
  };
  if (!origin || !inventoryUrl) {
    return { ok: false, error: 'no-inventory-call', message: "Couldn't see the list of cars this page loads. Open the website's used inventory page, wait until the cars show, and try again.", requests };
  }

  const byVin = new Map();
  let total = null;
  let ended = false;
  let firstCount = 0;
  let listPath = null;
  try {
    for (let n = 1; n <= MAX_INVENTORY_PAGES; n += 1) {
      const answer = await call(platform.pageAddress(inventoryUrl, n, firstCount));
      const problem = problemWith(answer, origin);
      if (problem) {
        if (n === 1 || REFUSED[answer && answer.status]) return { ok: false, error: 'search-failed', message: `Couldn't read the inventory: ${problem}.`, requests };
        break; // a later page failed: what was read stands, and the scan is not complete
      }
      if (!answer.json || typeof answer.json !== 'object') {
        if (n === 1) return { ok: false, error: 'search-failed', message: "Couldn't read the inventory: the website's answer was not inventory data.", requests };
        break;
      }
      const found = findCardList(answer.json, listPath);
      if (n === 1) listPath = found.path;
      const cards = found.cards;
      const said = totalCount(answer.json);
      if (said !== null) total = said;
      if (n === 1) firstCount = cards.length;
      let added = 0;
      for (const card of cards) {
        const vin = vinIn(card);
        if (!byVin.has(vin)) {
          byVin.set(vin, { card, origin });
          added += 1;
        }
      }
      if (!cards.length) {
        // an answer with no car that does not say the lot is empty is not a
        // lot: a session that ran out, an error object, another widget's data
        if (n === 1 && total !== 0) return { ok: false, error: 'search-failed', message: "Couldn't read the inventory: the website's answer held no cars.", requests };
        ended = true;
        break;
      }
      if (total !== null && byVin.size >= total) {
        ended = true;
        break;
      }
      // the same cars again: the page number didn't move the list on
      if (!added) break;
      if (total === null && cards.length < firstCount) {
        ended = true;
        break;
      }
    }
  } catch (e) {
    return { ok: false, error: 'search-failed', message: "Couldn't read the inventory: " + ((e && e.message) || e), requests };
  }
  const complete = total !== null ? byVin.size >= total : ended;

  // A car from the last scan that is not in this one is gone only when its
  // own page answers 404 or 410 without being redirected (Dealer.com's 410
  // for a sold car's page was reported by the 2026-10-01 page-text survey).
  // Any other readable answer, such as a page that still shows the car (a
  // "sold" banner, or a car only hidden from the list), and a car with no
  // known page or past this scan's limit, is left unconfirmed: the rescan
  // lists it as missing but not confirmed gone. A page that fails on its own
  // (a server error, an answer from another website, a request that fails
  // outright, as a page redirecting to another website does in the browser)
  // leaves only that car unconfirmed, listed in confirm.unchecked with the
  // reason; after MAX_FAILED_IN_A_ROW such pages in a row the check stops
  // and the rest wait. A refusal (401, 403, 429, 503) sets confirm.error,
  // and the rescan then marks nothing gone.
  const confirm = { checked: [], notFound: [], error: null };
  const unchecked = {};
  const pageOf = (vin) => {
    const href = confirmUrls && confirmUrls[vin];
    try {
      const url = href ? new URL(href, origin) : null;
      return url && url.origin === origin ? url : null;
    } catch (e) {
      return null;
    }
  };
  const toCheck = [...new Set((confirmVins || []).map((v) => String(v).toUpperCase()))].filter((v) => !byVin.has(v) && pageOf(v));
  // The gap between two car-page reads is the Crawl-delay the website's own
  // robots.txt asks every robot for, read once when more than one page is
  // to be read; none when it asks for none; the platform's usual gap when
  // robots.txt can't be read (DealerOn's sites ask for 10 seconds). The same
  // fixed gap every time; nothing about the timing is varied. A website that
  // asks for more than MAX_PAGE_GAP_MS gets one car page per scan.
  let gap = 0;
  let pageLimit = MAX_CONFIRM_PAGES;
  if (Number.isFinite(options.pageGapMs)) gap = options.pageGapMs;
  else if (toCheck.length > 1) {
    let rules;
    try {
      rules = await call(origin + '/robots.txt');
    } catch (e) {
      rules = null;
    }
    const where = rules && rules.finalUrl ? originOf(rules.finalUrl) : origin;
    if (rules && REFUSED[rules.status]) {
      confirm.error = `robots.txt: the website ${REFUSED[rules.status]}`;
      pageLimit = 0;
    } else if (rules && where === origin && (rules.status === 404 || rules.status === 410)) {
      gap = 0; // no robots.txt, no rules
    } else if (rules && where === origin && rules.ok && isRobotsText(rules)) {
      const asked = crawlDelaySeconds(rules.text);
      gap = asked === null ? 0 : Math.round(asked * 1000);
    } else {
      // unreadable, off the website, or a web page answering for robots.txt
      gap = Number(platform.pageGapMs) || 0;
    }
  }
  if (gap > MAX_PAGE_GAP_MS) pageLimit = Math.min(pageLimit, 1);
  let pagesRead = 0;
  let failedInARow = 0;
  for (const vin of toCheck) {
    if (pagesRead >= pageLimit || failedInARow >= MAX_FAILED_IN_A_ROW) break;
    const url = pageOf(vin);
    let answer;
    try {
      if (pagesRead > 0 && gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      pagesRead += 1;
      answer = await call(url.href);
    } catch (e) {
      failedInARow += 1;
      unchecked[vin] = carPageProblem(null, origin, e);
      continue;
    }
    if (answer && REFUSED[answer.status]) {
      confirm.error = `the page of ${vin}: ${problemWith(answer, origin)}`;
      break;
    }
    const sameOrigin = !answer || !answer.finalUrl || originOf(answer.finalUrl) === origin;
    if (answer && (answer.ok || answer.status === 404 || answer.status === 410) && sameOrigin) {
      failedInARow = 0;
      confirm.checked.push(vin);
      if ((answer.status === 404 || answer.status === 410) && !answer.redirected) confirm.notFound.push(vin);
      continue; // anything else readable is not a clear "gone"
    }
    failedInARow += 1;
    unchecked[vin] = carPageProblem(answer, origin);
  }
  if (Object.keys(unchecked).length) confirm.unchecked = unchecked;

  return { ok: true, fetchedAt: new Date().toISOString(), total: total ?? byVin.size, complete, requests, records: [...byVin.values()], confirm };
}

// What a car's own page adds at post time: every photo it carries, its
// description and a Carfax link, from the page's standard vehicle data when
// it has some, and the platform's own photo addresses.
export function pageExtras(html, pageUrl, vin, platform) {
  const out = { photos: [], description: null, carfaxUrl: null };
  if (typeof html !== 'string' || !html) return out;
  try {
    const { vehicles, facts } = parseVehiclePage(html, pageUrl);
    for (const node of vehicles) {
      const v = normalizeStandard(node, { url: pageUrl, facts });
      if (!v || v.vin !== vin) continue;
      out.photos = v.photos;
      out.description = v.descriptionRaw || null;
      out.carfaxUrl = v.carfaxUrl;
      break;
    }
  } catch (e) {
    // a page the standard reader can't read: the platform's own photos below
  }
  const own = platform && typeof platform.pagePhotos === 'function' ? platform.pagePhotos(html, vin, pageUrl) : [];
  if (own.length > out.photos.length) out.photos = own;
  return out;
}

/**
 * The adapter's getDetails(): the car from the list (any car the list
 * gives), then its own page for every photo and its description. A car the
 * list doesn't have gets record null, with the list read's `complete`: true
 * when the whole list was read (the car is gone), false when the read
 * stopped early (a later page failed or repeated), so it is not proof.
 */
export async function detailsFor(search, vin, options, platform) {
  const wanted = String(vin || '').toUpperCase();
  const res = await scanInventory(search, { ...options, confirmVins: [] }, platform);
  if (!res.ok) return { ok: false, message: res.message };
  const found = res.records.find((r) => vinIn(r.card) === wanted);
  // complete: false says the list read stopped early, so a car not found may
  // be on a page that was not read
  if (!found) return { ok: true, record: null, complete: res.complete, fetchedAt: res.fetchedAt };
  const v = normalizeInventoryRecord(found.card, { origin: found.origin });
  const href = (v && v.url) || options.url;
  let page = null;
  if (href && originOf(href) === options.origin) {
    try {
      const answer = await search({ url: href });
      if (!problemWith(answer, options.origin)) page = pageExtras(answer.text, answer.finalUrl || href, wanted, platform);
    } catch (e) {
      page = null; // the list's own data stands
    }
  }
  return { ok: true, record: page ? { ...found, page } : found, fetchedAt: res.fetchedAt };
}

// A response body up to the limit, without reading the rest.
export async function cappedText(res, limit) {
  if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return out + decoder.decode();
      out += decoder.decode(chunk.value, { stream: true });
      if (out.length >= limit) {
        reader.cancel().catch(() => {});
        return out.slice(0, limit);
      }
    }
  }
  return String(await res.text()).slice(0, limit);
}

// A search(request) from the service worker: one GET on the website, without the browser's cookies, no
// header of its own, never off the website.
export function directSearch(service, fetchImpl = globalThis.fetch) {
  const origin = webOrigin(service && service.origin);
  return async (request) => {
    let target = null;
    try { target = new URL(String((request && request.url) || ''), origin || undefined); } catch (e) { target = null; }
    if (!origin || !target || target.origin !== origin) throw new Error(`reads only ${origin || 'the dealership website'}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetchImpl(target.href, { credentials: 'omit', signal: ctrl.signal });
      const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
      const text = await cappedText(res, 3000000);
      let json = null;
      if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
        try { json = JSON.parse(text); } catch (e) { json = null; }
      }
      return { ok: Boolean(res.ok), status: res.status, finalUrl: res.url || target.href, redirected: Boolean(res.redirected), contentType, json, text: json ? '' : text };
    } finally {
      clearTimeout(timer);
    }
  };
}


function webOrigin(value) {
  const origin = originOf(value);
  return origin && /^https?:/.test(origin) ? origin : null;
}
