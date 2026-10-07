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
import { normalizeVehicle as normalizeStandard, GUIDE_PRICE_WORDS, LABEL_MARKS, LABEL_NOTE } from './schemaOrgNormalize.js';

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
// Broader than the shared guide words below on purpose ("market", "book",
// "estimat", "trade", a bare "value"): a labelled entry in a list of prices
// that carries one is not taken, so a figure the reader can't place waits on
// a person ("Value Price" alone is "Call for price" here). The standard-data
// reader reads the words before an amount in running page text instead,
// where "Value Price $24,995" is a selling price. The shared list decides
// what is never the price whatever sits beside it, and what is quoted.
// "Value" right after "price" is how a field writes its amount
// ("VehicleInternetPriceValue", "salePriceValue"), not a guide's value, as
// "Retail Value" is the base price.
const NOT_THE_PRICE = /msrp|\bwas\b|original|previous|prior|\bold\b|list ?price|^list|compare|strike|payment|per ?month|monthly|\bmo\b|lease|financ|rebate|incentive|saving|discount|conditional|\bfees?\b|docfee|\btax|invoice|trade|down ?payment|\bapr\b|cash ?back|bonus|wholesale|employee|supplier|military|loyalty|conquest|lowest|highest|market|book|estimat|\bvalue\b(?<!retail value)(?<!price value)/i;
// A label as every label test below reads it: without the footnote and
// trademark marks a website puts after it ("Internet Price*", "Your Offer™",
// "Market Value†", "Our Offer¹", "Best Offer!"), nor the spaces, colons and
// full stops among them (the tests already allow one colon or full stop at
// the end). The marks are the standard-data reader's own list
// (schemaOrgNormalize.js LABEL_MARKS), so the two never drift. A dealer's
// own "Sample Price¹" stays the dealer's price this way. The label is still
// quoted as the website writes it.
// A footnote is also read when it is written as a number, a short list of
// numbers or a letter in brackets ("(1)", "[2]", "(1, 2)", "(a)", "(*)"), a
// mark with a number ("*1", "*1,2") (LABEL_NOTE, shared with the
// standard-data reader), inside an HTML tag ("<sup>*</sup>", "<sup>1</sup>",
// "<sup>1,2</sup>", "<sup>1-2</sup>", "<sup>a</sup>", and at the label's
// end in any tag: a link, a span, small, "<a href="#fn1">1</a>") or as an
// HTML entity ("&#42;", "&trade;"): a superscript holding only a number, a
// list or a range of numbers or a letter is dropped anywhere in the label,
// such a note in any other tag at its end too, the remaining tags after
// them, and entities read as their characters first ("Kelley Blue
// Book<sup>&reg;</sup> Value" reads "Kelley Blue Book® Value"). A tag
// between two words keeps them apart ("Internet<br>Price"), so a note is
// never glued onto the word before it; a word or a model year in a tag is
// never a note. A bare number or letter at the end is kept: nothing says
// it is a footnote.
const SUP_INNER = String.raw`\d{1,3}(?:\s*[,\-–]\s*\d{1,3}){0,3}|[A-Za-z]`;
const NOTE_BODY = String.raw`\(\s*(?:${SUP_INNER})\s*\)|\[\s*(?:${SUP_INNER})\s*\]|${SUP_INNER}`;
const SUP_NOTE = new RegExp(String.raw`<sup\b[^<>]*>(?:\s|<[^<>]*>)*(?:${NOTE_BODY})(?:\s|<[^<>]*>)*<\/sup\s*>`, 'gi');
const TAG_NOTE = new RegExp(String.raw`(?:<[a-z][^<>]*>\s*)+(?:${NOTE_BODY})(?:\s|<\/[a-z][^<>]*>)*$`, 'i');
const TAGS = /(?:<\/?[a-z][^<>]*>)+/gi;
const untagged = (text) => text.replace(TAGS, (tags, at, all) => (/\w/.test(all[at - 1] || '') && /\w/.test(all[at + tags.length] || '') ? ' ' : ''));
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,31}));/gi;
const NAMED_ENTITY = { amp: '&', nbsp: ' ', reg: '®', trade: '™', dagger: '†', Dagger: '‡', ast: '*', midast: '*', excl: '!', sect: '§', sup1: '¹', sup2: '²', sup3: '³', apos: '\'', rsquo: '’', quot: '"' };
const entityText = (whole, dec, hex, name) => {
  const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
  if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  return NAMED_ENTITY[name] ?? NAMED_ENTITY[name.toLowerCase()] ?? ' ';
};
const NOTE_END = new RegExp(String.raw`(?:${LABEL_NOTE}|[\s:.${LABEL_MARKS}])$`);
// A label is a few words: only its first 300 characters are read, so the
// tag patterns above never spend long on a page's worth of text.
const LABEL_MAX = 300;
export function labelWords(label) {
  let tagged = String(label || '').slice(0, LABEL_MAX).replace(SUP_NOTE, '');
  // several notes in a row at the end ("<span>1</span><span>2</span>")
  for (let n = 0; n < 4 && TAG_NOTE.test(tagged); n += 1) tagged = tagged.replace(TAG_NOTE, '');
  let text = untagged(tagged).replace(ENTITY, entityText);
  for (;;) {
    // a footnote is short: only the label's last characters are read each time
    const note = NOTE_END.exec(text.slice(-12));
    if (!note) return text;
    text = text.slice(0, text.length - note[0].length);
  }
}
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
const GUIDE_LABEL = new RegExp(String.raw`\b(?:${GUIDE_PRICE_WORDS})\b\.?(?:[\s:\-\u2013\u2014${LABEL_MARKS}]*(?:price|pricing|value|offer)\b)*[\s:\-\u2013\u2014${LABEL_MARKS}]*$`, 'i');
// The base price a dealer's own price is built from on these platforms:
// "Retail Price", "Retail Value", a "starting" price.
const BASE_WORDS = /retail|\bbase\b|asking|starting/i;
// The price the website says it sells at: a platform's final price, an
// internet, sale or selling price ("Our Price", "Your Price" too).
const SELLER_WORDS = /\bfinal|internet|\bdealer\b|\bsale\b|selling|e-?price|\bnow\b/i;
const SELLING_WORDS = new RegExp(String.raw`${SELLER_WORDS.source}|\bour\b|\byour\b`, 'i');
// A label with the word "Offer" anywhere in it is an offer for the buyer's
// car ("Sell Us Your Car Offer", "Your Carvana Offer", "Our Offer", "Best
// Offer", "Offer for Your Vehicle", "Your Offer Today", "Your Carvana Offer
// - valid 7 days"), never the price, whatever else it says, however a
// footnote after it is written, and even marked final; "your" and "our" do
// not make it the website's price. Only "price" right after the word ("Offer
// Price", "Special Offer Price") or the website's own price words beside it
// do (OFFER_PRICE_WORDS: "Internet Offer", "Sale Offer", "E-Price Offer",
// "Selling Price Offer"), and those only when the label does not also read
// as an offer for the buyer's car (SELL_YOUR_CAR: the offer word before
// "sale", "Carvana offer, sale ends Sunday"; selling or trading the buyer's
// car named, "Sale Offer for Your Car", "Selling Your Car? Our Offer"). Its
// own short list, never SELLER_WORDS: "dealer", "final" and "now" sit beside
// offers for the buyer's car ("Instant Dealer Offer", "Your Final Offer",
// "Your Offer Now"). The offer word is read wherever it sits, as a guide's
// words are.
const OFFER_WORD = /\boffers?\b(?![\s\-–—]*pric)/i;
const OFFER_PRICE_WORDS = /\binternet\b|\bselling\b|\be-?price\b|\bsale\b/i;
const SELL_YOUR_CAR = /\boffers?\b.*\bsale\b|\bsell\b|\bselling\s+(?:us\s+)?(?:your|my)\b|\btrad(?:e|ing)\b|\byour\s+(?:car|vehicle|truck|suv|ride|trade)\b|\bfor\s+your\b/i;
const isOfferForTheCar = (label) => {
  const words = labelWords(label);
  return OFFER_WORD.test(words) && (!OFFER_PRICE_WORDS.test(words) || SELL_YOUR_CAR.test(words));
};
const GENERIC_PRICE = /^\s*(?:the\s+)?price\s*:?\s*$/i;
// A name that says its figure is a price: "...Price", "Internet Special".
const PRICE_NAME = /price|\bspecials?\b/i;
// A label that is nothing but the website's own selling words, with at most
// "deal" or "special" ("Sale", "Your Deal", "Internet Deal", "Now",
// "Today's Deal"): a price's label wherever the record keeps it. A package's
// or an incentive's name holds a word of its own ("Dealer Installed
// Accessories", "Internet Bundle", "Dealer Cash").
const SELLING_ONLY = /^(?:(?:the|our|your|final|internet|dealer|sale|selling|e-?price|now|today'?s|today|deals?|specials?)(?:[\s:.,!/&+\-–—]+|$))+$/i;
const lastKeyPart = (key) => spaced(String(key || '').split('.').pop());
// Whether an entry kept outside the record's price lists and fields names
// the selling price, by its label ("Internet Price", "Sale"), by what the
// platform types it as (a typeClass "internetPrice", a field "salePrice"), or
// by the platform's final mark (labeledPrices, choosePrices).
const namesSellingPrice = (e) => e.final || PRICE_NAME.test(labelWords(e.label)) || PRICE_NAME.test(lastKeyPart(e.key)) || SELLING_ONLY.test(labelWords(e.label).trim());
const NAMED_PRICE = /^\s*[A-Za-z][\w.&'’ -]{0,40}\s+price\s*:?\s*$/i;
// In a list of prices, a line about a sale or the dealer that is not a
// price ("Sale Event", "Sale ends Sunday", "Dealer Notes"; "Year End Sale"
// is still a price's label), unless it also holds one of the website's own
// price words ("Internet Sale - Ends 10/31" is a price's label), and an
// amount added to or taken off the price ("-$500", "+$499", "($500)"): a
// price is never signed. Text in brackets that is not an amount ("(Call for
// Price)") is not signed.
const LIST_NOTE = /\b(?:events?|ends|expires?|notes?|disclaimers?|details)\b/i;
const LIST_PRICE_WORDS = /\binternet|\bfinal|selling|e-?price/i;
const isListNote = (label) => LIST_NOTE.test(label) && !LIST_PRICE_WORDS.test(label);
const SIGNED = /^\s*(?:[-+−–]\s*\$?\s*\d|\(\s*[-+−–]?\s*\$?\s*\d)/;
// Where a label/value entry holds its amount.
const VALUE_FIELDS = ['value', 'amount', 'price', 'displayValue'];
// The amount an entry holds: its value, amount, price or displayValue, or
// the amount or value of an object there ({ value: { amount: "$24,490" } }).
function valueIn(x) {
  const raw = x.value ?? x.amount ?? x.price ?? x.displayValue;
  return isPlain(raw) ? raw.amount ?? raw.value ?? raw.displayValue : raw;
}

// What a key says about prices, by its name:
//   'list'   a list or object of the car's prices: "pricing" (Dealer.com's
//            "pricing", "trackingPricing"), "prices", "dprice", "offers"
//            (where standard vehicle data keeps the car's price);
//   'field'  a field named for a price: "price", "pricing" or "prices" with
//            nothing after it, or with a word for how the amount is written
//            or held ("VehicleInternetPrice", "VehicleInternetPriceFormatted",
//            "finalPriceText", "salePriceDisplay", "priceInfo"), whatever it
//            holds: an amount, text, nothing, or an object with the amount
//            ({ amount }, { value });
//   'about'  a field about a price but not its amount (PRICE_ABOUT: its
//            label, currency, date, history, a change: "VehiclePriceLabel",
//            "priceCurrency", "priceHistory", "internetPriceDrop"): never read;
//   ''       anything else. An object under such a key (a package, a
//            warranty, an accessory, an add-on, a protection plan) holds
//            figures that are not the car's price, whatever they are named.
// The same name test decides whether a field's amount is the price when it
// reads and whether it is kept when it can't be read.
const PRICE_ABOUT = /^(?:label|title|caption|heading|name|notes?|disclaimers?|desc|description|type|class|kind|currency|units?|code|id|date|time|history|histories|source|rank|count|format|style|colou?r|rules?|tier|range|drops?|changes?|diff|difference|reduction|delta|reason|status|visible|hidden|enabled|flag)$/;
export function priceKeyKind(key) {
  const n = keyName(key);
  if (/^(?:dprice|offers?)$/.test(n)) return 'list';
  const at = n.lastIndexOf('pric');
  if (at < 0) return '';
  const tail = n.slice(at);
  const pricing = tail.startsWith('pricing');
  if (!pricing && !tail.startsWith('price')) return '';
  const rest = tail.slice(pricing ? 7 : 5);
  if (PRICE_ABOUT.test(rest) || PRICE_ABOUT.test(rest.replace(/^s/, ''))) return 'about';
  return (pricing && rest === '') || rest === 's' ? 'list' : 'field';
}
// A field that says something about a price, not one: a true or false, or
// a yes or no in a field named as a flag ("isFinalPrice", "showInternetPrice",
// "hideSalePrice", "displayPrice"). Never an amount. A field whose name only
// opens with such letters ("usedInternetPrice", "usedPricing",
// "showroomPrice", "includedPrice") holding an amount, text or an object is
// read as any other price field.
const FLAG = /^(?:is|has|show|hide|use|enable|allow|include|display)[a-z]/;
const YES_NO = /^(?:true|false|yes|no|y|n|0|1)$/i;
const isFlag = (name, v) => typeof v === 'boolean' || (FLAG.test(name) && (typeof v === 'number' || typeof v === 'string') && YES_NO.test(String(v).trim()));
// A field that says to call for the price ("callPrice", "callForPrice"),
// whatever it holds: never the website's price, read or not.
const CALL_FIELD = /^call(?:for)?price/;
// The platform's final price as a field ("finalPrice", "finalPriceText").
const FINAL_FIELD = /^finalprice(?:formatted|text|displayed|display|value|amount|string|raw)?$/;

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
 * (finalPrice, VehicleInternetPrice, retailPrice, priceKeyKind) and fields
 * named for a guide's value or an offer (VehicleMarketValue, kbbValue: never
 * the price, read so a car with only such a figure has its label quoted).
 * Nested up to four levels; never inside photos or features.
 *
 * Only the record's own fields, its price lists and objects ("pricing",
 * "prices", "dprice", "offers") and its fields named for a price give the
 * car's price. A figure inside anything else (a package, a warranty, an
 * accessory, an add-on, a protection plan, whatever it or what holds it is
 * named), and an entry of an "offers" list named for something other than
 * a price (an incentive: "Dealer Cash"), is kept marked `aside`, and
 * choosePrices never takes it as the price; one that names a selling price
 * holds the car there instead (namesSellingPrice). A field about a price but
 * not its amount (a price history, a label) is not read at all, nor a flag
 * (a true or false, or a yes or no in a field named "is...", "show...").
 *
 * The website's own price is kept even when its value is not a plain amount
 * ("$40,590*", "Call for Price", "$24,499 + tax", nothing at all, an object
 * with no amount in it), as an unreadable entry ({ value: null, text }): the
 * price the platform marks final (an entry with isFinalPrice or isFinal, a
 * finalPrice field, or what a finalPrice field holds); a selling price,
 * written as text that is not an amount or as nothing at all, when the
 * platform types it as one (a typeClass or a field named "internetPrice",
 * "salePrice", "VehicleInternetPriceFormatted"), its label says so
 * ("Internet Special", "Sale Price") or a list of prices labels it as one
 * ("Internet Deal", "Sale", "Now", "Our Deal"; never a sale event or a note,
 * "Sale Event", "Dealer Notes", nor an amount added or taken off, "-$500");
 * and, holding text that is not an amount, a plain "Price" and, in a list
 * of labelled prices, a "<Something> Price" (the dealer's own, "Sample
 * Price", which only choosePrices can tell, from the dealership's name), or
 * a field of the record's own so named ("specialPrice", "webPrice",
 * "VehicleDisplayPrice") when no plain or selling price of the record's own
 * reads (never a yes or a no there, nor a call-for-price field, "callPrice",
 * "callForPrice"). A field that holds null is a field the record leaves
 * empty, as one left out. choosePrices then gives the car no price and
 * quotes it, instead of taking the plain, base or starting price beside it.
 * @param {object} record
 * @returns {{ value: number|null, text?: string, label: string, key: string, final: boolean, aside?: boolean }[]}
 */
export function labeledPrices(record) {
  const out = [];
  // an amount that can't be read: kept when it is the final price; when it
  // is a selling price (priceKind) the platform types as a price (its
  // typeClass or field name, "internetPrice"), labels as one ("Internet
  // Special") or lists among its prices ("Internet Deal", "Sale", "Now"),
  // never a sale event, a note or a signed adjustment, holding text or
  // nothing at all (an entry of a list of prices, or one with a value field,
  // that holds nothing; a field holding null is left out); and when it
  // holds some text and its name says it is a plain "Price" or, from a
  // label, a "<Something> Price" (priceKind 'named' without the
  // dealership's name; choosePrices reads it with the name). A field of the
  // record's own (not an entry of a list of prices) named "<Something>
  // Price" ("specialPrice", "webPrice", DealerOn's "VehicleDisplayPrice")
  // holding text is kept too, but only when no plain or selling price of
  // the record's own reads (namedFields, below); never a yes or a no there,
  // nor a call-for-price field ("callPrice", "callForPrice").
  const namedFields = new Set();
  const unreadable = (entry, raw, { labelled = false, listed = false, present = false, typed: held = false } = {}) => {
    const written = typeof raw === 'string' || typeof raw === 'number';
    if (entry.final) {
      out.push(entry);
      return;
    }
    const kind = priceKind(entry);
    const named = PRICE_NAME.test(labelWords(entry.label));
    if (kind === 'selling') {
      const typed = held || PRICE_NAME.test(lastKeyPart(entry.key));
      const inList = listed && !isListNote(labelWords(entry.label)) && !SIGNED.test(entry.text);
      // kept outside the price lists, a label of selling words alone ("Sale")
      const bare = Boolean(entry.aside) && SELLING_ONLY.test(labelWords(entry.label).trim());
      if ((named || typed || inList || bare) && (written || (labelled && (present || listed) && raw === undefined))) out.push(entry);
      return;
    }
    if (!written || !entry.text || !named) return;
    if (kind === 'plain' || (labelled && kind === 'named')) out.push(entry);
    else if (kind === 'named' && !entry.aside && typeof raw === 'string' && !YES_NO.test(raw.trim()) && !CALL_FIELD.test(keyName(entry.key))) {
      namedFields.add(entry);
      out.push(entry);
    }
  };
  // `outside`: below a key that is not a price list or field (a package, a
  // warranty): what is found there is marked aside. `fieldName`: the name of
  // the price field holding this object, for an amount with no label of its
  // own ({ SalePrice: { amount: 24490 } } is "Sale Price").
  const visit = (x, key, depth, { markedFinal = false, outside = false, fieldName = '' } = {}) => {
    if (depth > 4 || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const el of x) visit(el, key, depth + 1, { markedFinal, outside, fieldName });
      return;
    }
    const label = textOf(x.label ?? x.title ?? x.displayName ?? '');
    const kind = textOf(x.typeClass ?? x.type ?? x.name ?? '');
    const raw = valueIn(x);
    // an entry with a value field that holds nothing ({ label, value: null })
    const present = VALUE_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(x, f));
    const value = amount(raw);
    const final = markedFinal || truthy(x.isFinalPrice) || truthy(x.isFinal);
    const name = label || spaced(kind) || fieldName;
    // In an "offers" list, an entry named for something other than a price
    // (an incentive or a rebate: "Dealer Cash", "Customer Cash", "Sale") is
    // kept aside like a figure in any other object: only an entry named or
    // typed for a price ("Internet Price"), one marked final, or the list's
    // own "price" field gives the car's price there.
    if (!outside && depth > 0 && name && !final && /^offers?$/.test(keyName(key)) && !PRICE_NAME.test(labelWords(name)) && !PRICE_NAME.test(spaced(kind))) outside = true;
    const aside = outside ? { aside: true } : {};
    if (depth > 0 && value !== null && (name || final)) {
      out.push({ value, label: name, key: `${key}.${kind}`, final, ...aside });
      return;
    }
    const listed = !outside && /pric/.test(keyName(key)) && priceKeyKind(key) !== '';
    // a named entry's own value, judged by its name here, is not read again
    // below under its field's name ("price")
    let ownField = null;
    if (depth > 0 && (final || name)) {
      const before = out.length;
      unreadable({ value: null, text: textOf(raw).slice(0, 60), label: name, key: `${key}.${kind}`, final, ...aside }, raw, { labelled: true, listed, present });
      if (out.length > before || final) return;
      ownField = VALUE_FIELDS.find((f) => x[f] !== undefined && x[f] !== null) || null;
    }
    // Inside a package, a warranty, an incentive or an accessory, a field
    // named just "price" is the figure of what holds it: labelled by that,
    // as a named entry is, and marked aside.
    const holder = outside ? name || spaced(key) : '';
    for (const [k, v] of Object.entries(x)) {
      if (/image|photo|picture|feature|option|media|attribute/i.test(k)) continue;
      if (k === ownField) continue;
      const n = keyName(k);
      const what = priceKeyKind(k);
      if (what === 'about' || (what && isFlag(n, v))) continue;
      const isFinal = FINAL_FIELD.test(n);
      if (v && typeof v === 'object') {
        if (what === 'field') visit(v, k, depth + 1, { markedFinal: isFinal, outside, fieldName: spaced(k).replace(/^Vehicle\s+/i, '') });
        else visit(v, k, depth + 1, { outside: outside || !what });
        continue;
      }
      if (!what && !GUIDE_LABEL.test(labelWords(spaced(k)))) continue;
      const held = outside && n === 'price';
      const fieldLabel = held ? holder : spaced(k).replace(/^Vehicle\s+/i, '');
      const fieldKey = held ? `${key}.${kind}` : k;
      const got = amount(v);
      if (got !== null) out.push({ value: got, label: fieldLabel, key: fieldKey, final: isFinal, ...aside });
      else if (what && v !== undefined) unreadable({ value: null, text: textOf(v).slice(0, 60), label: fieldLabel, key: fieldKey, final: isFinal, ...aside }, v, { typed: held });
    }
  };
  visit(record, '', 0);
  if (namedFields.size && out.some((e) => !e.aside && e.value !== null && (priceKind(e) === 'plain' || priceKind(e) === 'selling'))) return out.filter((e) => !namedFields.has(e));
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
  const text = labelWords(label);
  if (!NAMED_PRICE.test(text)) return false;
  const before = text.replace(/\s+price\s*:?\s*$/i, '');
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
  const label = labelWords(entry.label);
  const dealers = isDealerPrice(label, dealer);
  const own = dealers ? '' : label;
  const words = `${own} ${spaced(entry.key)}`;
  // The offer word is read in the label and in what the platform types the
  // entry as (its typeClass or field name), never in the name of the list
  // holding it: an "offers" list keeps the car's own price ("Price").
  const offer = isOfferForTheCar(own) || isOfferForTheCar(`${own} ${lastKeyPart(entry.key)}`);
  if (NOT_THE_PRICE.test(labelWords(words)) || GUIDE_PRICE.test(labelWords(words)) || offer) return 'other';
  if (entry.final) return 'selling';
  if (BASE_WORDS.test(words)) return 'base';
  if (SELLING_WORDS.test(words)) return 'selling';
  if (GENERIC_PRICE.test(label) || /^price$/i.test(keyName(entry.key.split('.').pop()))) return 'plain';
  if (dealers) return 'selling';
  return NAMED_PRICE.test(label) ? 'named' : 'other';
}

const NO_PRICE = (label) => ({ price: null, priceLabel: label, priceBeforeFees: null });

// Labels quoted for a person to check, as the reason a car has no price.
function quoteLabels(labels) {
  const quoted = [...new Set(labels.map((l) => String(l).slice(0, 60)))].slice(0, 3).map((l) => `"${l}"`);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0];
  return `the list labels its ${quoted.length > 1 ? 'prices' : 'price'} ${list}, which Lot Current does not read as the selling price`;
}

// A price's text that holds no amount at all: nothing, or a zero ("0",
// "$0", "0.00"), as an unused field holds.
const isEmptyText = (text) => /^\s*(?:\$?\s*0+(?:\.0+)?)?\s*$/.test(String(text ?? ''));

// The website's own price that is not a plain amount, quoted for a person
// to check: "the list's final price reads "$40,590*", which Lot Current does
// not read as an amount", or "the list's final price has no amount" (nothing
// or a zero there).
function unreadablePrice(e) {
  const label = String(e.label || '').slice(0, 60);
  const what = e.final ? `the list's final price${label && !/^final price$/i.test(label) ? `, "${label}",` : ''}` : `the list's "${label || 'Price'}"`;
  return isEmptyText(e.text) ? `${what} has no amount` : `${what} reads "${e.text}", which Lot Current does not read as an amount`;
}

// The labels of a guide's or an offer's figures, quoted: some websites
// label their own selling price that way ("Market Price"), and the price is
// still not taken. A payment or an incentive is not such a label.
function guideLabelled(entries) {
  const labels = entries.map((e) => e.label || spaced(e.key)).filter((l) => GUIDE_LABEL.test(labelWords(l)) || isOfferForTheCar(l));
  return labels.length ? quoteLabels(labels) : null;
}

// The words that set an entry aside, for a person to check: its label when
// the label itself is not the price, else its key's last part ("msrp" for an
// entry labelled just "Price" that the platform files as its MSRP).
const setAsideWords = (e) => (e.label && labelIsNotThePrice(e.label) ? e.label : spaced(String(e.key || '').split('.').pop()) || e.label || 'Price');

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
// value, an offer for the car, an MSRP, a payment (the words priceKind reads
// as 'other').
export const labelIsNotThePrice = (label) => NOT_THE_PRICE.test(labelWords(label)) || GUIDE_PRICE.test(labelWords(label)) || isOfferForTheCar(label);

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
 * price unknown no other figure on the record is taken instead. The same
 * holds for the entry the platform marks final when its label is set aside
 * the same way ("Special Offer", "Market Value", "MSRP"): no price, the
 * label quoted, never the plain or base price beside it. And for the
 * website's own price when it is not a plain amount ("$40,590*", "Call for
 * Price", "$24,499 + tax", nothing at all; labeledPrices keeps it): the
 * final price when none that reads stands beside it, or a selling price
 * ("Internet Price") when no final price reads gives no price, and what the
 * list says is quoted (`the list's final price reads "$40,590*", which Lot
 * Current does not read as an amount`). A selling price holding nothing or
 * 0 (not marked final) beside another selling price that reads is an unused
 * field and holds nothing. A record whose own label says its
 * price is the dealer's or a selling one ("Sample Motors Price") with only a
 * base amount that reads gets no price either: the retail or starting price
 * is not the one it labels.
 * @param {{ value: number|null, text?: string, label: string, key: string, final: boolean }[]} entries
 * @param {{ dealer?: string, label?: string|null }} [context]
 */
export function choosePrices(entries, { dealer = '', label = null } = {}) {
  // The record's own label that is the dealership's name alone ("Sample
  // Motors" at Sample Motors) is its own price's label, as "Sample Motors
  // Price" is.
  const ownIsDealers = Boolean(label) && (isDealerPrice(label, dealer) || isDealerPrice(`${labelWords(label)} Price`, dealer));
  if (label && labelIsNotThePrice(label) && !ownIsDealers) return NO_PRICE(quoteLabels([label]));
  const every = (entries || []).map((e) => ({ ...e, kind: priceKind(e, dealer) }));
  const all = every.filter((e) => !e.aside);
  // A selling price the record keeps outside its price lists and fields
  // (labeledPrices marks it aside: "Internet Price" or a typeClass
  // "internetPrice" in a details object, "Sale" in a deal object, a final
  // price in a nested vehicle object, a sale in an offers list) is never
  // taken. When no selling price of the record's own reads, it holds the
  // car: the website may sell at it, so no retail, base or plain price is
  // taken past it. Beside the record's own selling price it counts as one of
  // the record's own would: one that reads another amount gives two prices,
  // and one that can't be read gives no price, unless a final price reads
  // (then only another final price that disagrees counts). A figure there
  // that does not name a selling price (a package, a warranty, an add-on, an
  // incentive: "Dealer Installed Accessories", "Internet Bundle", "Dealer
  // Cash") is left out (namesSellingPrice).
  const elsewhere = every.filter((e) => e.aside && e.kind === 'selling' && namesSellingPrice(e));
  // The entry the platform marks as the website's price (Dealer.com's
  // isFinalPrice) set aside as not the price: an offer ("Special Offer"), a
  // guide's value ("Market Value"), an MSRP. The website's price is that
  // figure, so, as for a record's own label above, no plain or base price is
  // taken in its place: no price, and the label is quoted.
  const setAside = all.filter((e) => e.final && e.kind === 'other');
  if (setAside.length) return NO_PRICE(quoteLabels(setAside.map(setAsideWords)));
  const kinds = all.filter((e) => e.value !== null && e.value !== undefined);
  // The website's own price written in a way that is not a plain amount
  // ("$40,590*", "Call for Price", nothing at all; labeledPrices keeps it):
  // the final price, or a selling price ("<Dealer> Price" too, read with the
  // dealership's name) when no final price reads, or a plain "Price" or a
  // "<Something> Price" the name does not explain when no selling price
  // reads either (one that reads would be the price, or two prices). The
  // website's price is that figure, so no plain, base or starting price is
  // taken in its place: no price, and what the list says is quoted. A final
  // price that reads still stands beside another final mark that doesn't,
  // and a selling price that reads beside a plain or named one that doesn't.
  const finalReads = kinds.some((e) => e.final && e.kind === 'selling');
  const sellingReads = kinds.some((e) => e.kind === 'selling');
  // The record's own label says its price is the dealer's or a selling one
  // ("Sample Motors Price", "Internet Price"), and only a base amount reads
  // (DealerOn's internet price empty or missing beside its retail price): the
  // price it labels is not the retail or starting one, so that is not taken.
  const ownKind = label ? (ownIsDealers ? 'selling' : priceKind({ label, key: '', final: false }, dealer)) : null;
  const ownIsSelling = ownKind === 'selling' || ownKind === 'named';
  const ownUnread = () => NO_PRICE(`the list labels its price "${String(label).slice(0, 60)}" but gives no amount Lot Current can read for it`);
  // A selling price holding '' or 0 (an unused field, DealerOn's
  // VehicleSalePrice beside its internet price) is an empty field, as one
  // holding null is, when another selling price of the record reads: it
  // holds nothing. A final one still holds.
  const unused = (e) => sellingReads && !e.final && isEmptyText(e.text);
  const unread = finalReads ? [] : all.filter((e) => (e.value === null || e.value === undefined) && !unused(e) && (e.final || e.kind === 'selling' || (!sellingReads && (e.kind === 'plain' || e.kind === 'named'))));
  if (unread.length) {
    // what the website shows is quoted: the final price, else one holding
    // text that is not an amount ("Call"), else an empty one
    const first = unread.find((e) => e.final) || unread.find((e) => !isEmptyText(e.text)) || unread[0];
    // an empty one beside the record's own label: that label is what a person sees
    return isEmptyText(first.text) && !first.final && ownIsSelling ? ownUnread() : NO_PRICE(unreadablePrice(first));
  }
  if (elsewhere.length && !sellingReads) return NO_PRICE(quoteLabels(elsewhere.map((e) => e.label || spaced(e.key))));
  const asideUnread = finalReads ? [] : elsewhere.filter((e) => (e.value === null || e.value === undefined) && !unused(e));
  if (asideUnread.length) return NO_PRICE(unreadablePrice(asideUnread.find((e) => e.final) || asideUnread.find((e) => !isEmptyText(e.text)) || asideUnread[0]));
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
    const besides = elsewhere.filter((e) => e.value !== null && e.value !== undefined && (!flagged.length || e.final));
    if (differ([...pool, ...besides])) return NO_PRICE(TWO);
    main = pool[0];
  } else if (named.length) {
    return NO_PRICE(TWO);
  } else if (plain.length) {
    if (differ(plain)) return NO_PRICE(TWO);
    main = plain[0];
  } else if (base.length) {
    if (ownIsSelling) return ownUnread();
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
  condition: ['inventorytype', 'condition', 'conditiontype', 'newused', 'stocktype', 'type', 'neworused', 'inventorycondition', 'saleclass'],
  isNew: ['isnew'],
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

// The word "new" in a condition field counts whatever else the field says
// (rule 3): "New", "New (In Stock)", "New/In Stock", "NEW!", "In Stock -
// New", "New Model", "Like New", "New Arrival", and beside a used or
// certified word too ("Certified New", "New/Used", "Used - Like New"), so a
// way of writing new nobody listed errs toward Needs a look, never Ready.
// Words such as "Newer", "Newest" or "News" are not "new".
const NEW_WORD = /\bnew\b/i;
// A new code run together with no case or underscore to split it by
// ("NEWVEHICLE", "newcar", "BRANDNEW", "NEWMODEL", "NEWINSTOCK"), read as
// "NEW VEHICLE", "NEW MODEL": a code that opens with "new", except "NEWER",
// "NEWEST", "NEWS" or "NEWLY".
const NEW_RUN = /^(brand)?(new)(?!(?:er|est|s|ly)$)([a-z]+)?$/i;

// A condition word the gate can read, from one condition field's text; a
// field that says nothing about new or used ("Car", "SUV") is not a
// condition ('').
function conditionText(raw) {
  if (/^\s*u\s*$/i.test(raw)) return 'Used'; // a one-letter code, as some list data sends it
  if (/^\s*n\s*$/i.test(raw)) return 'New';
  const words = conditionWords(raw);
  if (/\b(?:new|used|pre-?\s?owned|certified|cpo|demo(?:nstrator)?|loaner|courtesy)\b/i.test(words)) return words;
  const run = NEW_RUN.exec(words);
  if (run) return run.slice(1).filter(Boolean).join(' ');
  return DEMO_LETTERS.test(lettersOf(raw)) || LOANER_LETTERS.test(lettersOf(raw)) ? raw : '';
}

// The first condition field present, as a condition word.
const conditionOf = (card) => conditionText(textOf(pick(card, N.condition)));

// What a condition word says, in the pre-owned gate's order (classify.js
// readCondition): 'demo' for a demo or loaner word, then 'pre-owned', then
// 'new', else ''. So the gate reads "Used - Like New" as used: the new word
// in it is read on its own (newPart).
const USED_WORDS = /\b(?:used|pre-?\s?owned|certified|cpo)\b/gi;
function conditionSays(words) {
  const text = String(words || '');
  if (/\b(?:demo(?:nstrator)?|loaner|courtesy)\b/i.test(text) || DEMO_LETTERS.test(lettersOf(text)) || LOANER_LETTERS.test(lettersOf(text))) return 'demo';
  if (new RegExp(USED_WORDS.source, 'i').test(text)) return 'pre-owned';
  if (NEW_WORD.test(text)) return 'new';
  return '';
}

// The new word of a field that also says used or certified, as the gate
// reads new: "Certified New" -> "New", "New/Used" -> "New", "New or Used" ->
// "New", "Used - Like New" -> "Like New". A field that says only new is
// kept as it is.
function newPart(words) {
  if (conditionSays(words) !== 'pre-owned') return words;
  const rest = words.replace(USED_WORDS, ' ').replace(/\s+/g, ' ').replace(/^(?:[^a-z0-9]+|\b(?:or|and)\b)+|(?:[^a-z0-9]+|\b(?:or|and)\b)+$/gi, '').trim();
  return conditionSays(rest) === 'new' ? rest : 'New';
}

/**
 * Every condition field the record carries, top level and attribute lists,
 * in the order of N.condition's names: { key, text }. conditionOf reads the
 * first; the demo, loaner, certified, new and used words are read in all of
 * them, since a record can say "used" in one ("inventoryType") and "Loaner"
 * or "New" in another ("type", "stockType", "newUsed").
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
  // A flag that says the car is new (isNew) is a new word as well.
  const fields = [condition, ...conditionFields(card).map((f) => f.text), ...(truthy(pick(card, N.isNew)) ? ['New'] : [])];
  const demoWord = fields.some((t) => DEMO_LETTERS.test(lettersOf(t)));
  const loanerWord = fields.some((t) => LOANER_LETTERS.test(lettersOf(t)));
  // A "new" word counts in any condition field too (rule 3), the record's
  // own condition (the first field present) and every other, whatever else
  // the field says (NEW_WORD: "New In Stock", "New Model", "Like New", "New
  // Arrival", "Certified New", "New/Used", "NEWVEHICLE"), and so does a
  // used one beside it: the first of each, as a condition word. A record
  // with a new word anywhere is never renamed Certified Used. When the
  // first field present says nothing, a new word from another field is the
  // inventory type.
  const said = fields.map(conditionText).filter(Boolean);
  const newWord = said.find((w) => NEW_WORD.test(w)) || '';
  const usedWord = said.find((w) => conditionSays(w) === 'pre-owned') || '';
  const inventoryType = (certified && !newWord && !demoWord && !loanerWord ? 'Certified Used' : condition || newWord) || null;
  const marked = certified || fields.some((t) => /\b(?:certified|cpo)\b/i.test(conditionWords(t)));
  // A record whose fields disagree, used in one and new in another, or
  // both in one ("Certified New"), keeps the word that disagrees with its
  // inventory type as its second condition field, so the gate sends the car
  // to Needs a look naming both words (classify.js checkPreOwned) instead
  // of letting it reach Ready or skipping it as new without a word. A new
  // word beside a used one in the same field is named on its own (newPart:
  // "Certified New" is "New"), since the gate reads used first.
  const typeSays = conditionSays(inventoryType);
  const disagrees = typeSays === 'new' ? usedWord : typeSays === 'pre-owned' && newWord ? newPart(newWord) : '';
  const readableType = marked && (demoWord || loanerWord) ? 'Certified' : disagrees || null;
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
