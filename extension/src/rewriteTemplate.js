// Writes a Marketplace description from the website's own facts, with no
// network call, and checks any description (this one or Claude's) against
// the source data before the salesperson sees it.
//
// Rules from the build brief, enforced here:
//   - first-person salesperson voice, 60-120 words, short lines
//   - the 4-6 most useful features, plus mileage
//   - "one owner" only when the Carfax one-owner flag is true
//   - the dealer's own price note (e.g. doc fee wording) from settings, in
//     every description it applies to (the checks fail a text without it)
//   - a sign-off naming the salesperson's role and the dealership (the
//     checks fail a text that names either one nowhere)
//   - no ALL CAPS, no walls of emoji, nothing about protected
//     characteristics, never posing as a private seller
//   - no claim about the car's certification, warranty, financing, history,
//     care, new parts or condition that the website's own words for this car
//     (or the dealer's price note) don't make, and no number, in digits or
//     in words, that isn't in the website's data
// The template is the final fallback, so it is built to pass its own checks.

import { DEFAULT_SALESPERSON_TITLE } from './settings.js';

export const WORD_LIMITS = Object.freeze({ min: 60, max: 120 });

// Phrases that never belong in a listing. Matched on word boundaries,
// case-insensitively, with a hyphen or a space between words ("like-new",
// "clean title"). A false positive only means the template is used.
export const BANNED_PHRASES = Object.freeze([
  // claims the website's data can't support
  'best price in town', 'lowest price', 'best deal', 'no accidents', 'zero accidents', 'no accident', 'no reported accidents', 'accident free',
  'never been in an accident', 'never had an accident', 'never in an accident', 'clean title', 'no issues', 'runs perfect', 'runs perfectly', 'perfect condition',
  'mint condition', 'like new', 'flawless', "everyone's approved", 'everyone approved', 'guaranteed approval',
  'guaranteed financing', 'bad credit ok', 'no credit check', 'must sell', 'priced to sell', "won't last", 'wont last',
  'act fast', 'no reasonable offer refused', 'below market', 'great on gas',
  // posing as a private seller
  'private seller', 'private sale', 'for sale by owner', 'selling my', 'my personal', 'my truck', 'my car', 'my suv', 'my daily driver',
  // protected characteristics have no place in a car ad
  'christian', 'muslim', 'jewish', 'hindu', 'catholic', 'religious', 'hispanic', 'latino', 'immigrant', 'citizens only',
  'disabled', 'handicapped', 'elderly', 'seniors only', 'for men', 'for women', 'for ladies', 'family only', 'no kids',
  'gay', 'lesbian', 'transgender', 'ethnic',
]);

// Which features matter most to a Marketplace shopper. Earlier = better.
export const FEATURE_PRIORITY = Object.freeze([
  /\b(navigation|nav system|gps)\b/i,
  /apple carplay|android auto/i,
  /heated (front |rear )?seats/i,
  /\bleather\b/i,
  /sunroof|moonroof|panoramic/i,
  /(backup|back-up|rear.?view|rear) camera/i,
  /remote start/i,
  /blind.?spot/i,
  /\b(tow|towing|trailer)\b/i,
  /\b(awd|4wd|4x4|all.?wheel|four.?wheel)\b/i,
  /bluetooth/i,
  /keyless|push.?button start/i,
  /adaptive cruise/i,
  /lane (keep|departure|assist)/i,
  /(third|3rd) row/i,
  /heated steering/i,
  /(ventilated|cooled) seats/i,
  /premium (audio|sound)|alpine|harman|bose|beats/i,
  /power (liftgate|tailgate)/i,
  /wireless charging/i,
]);

export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// The VIN line is part of every description but not part of the prose: it
// is left out of the word count and its digits are not "numbers".
const VIN_LINE = /^\s*VIN\b[:\s]*[A-HJ-NPR-Z0-9]{17}\.?\s*$/gim;
const VIN_TOKEN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
export const stripVin = (text) => String(text || '').replace(VIN_LINE, '').replace(VIN_TOKEN, ' ');

export function ensureVinLine(text, vin) {
  const v = String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = String(text || '').trimEnd();
  if (!v || t.toUpperCase().includes(v)) return t;
  return `${t}\nVIN ${v}.`;
}

// Every number in a piece of text, normalised so "20,986" and "20986" match.
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const n = m.replace(/,/g, '');
    if (n) out.add(n);
  }
  return out;
}

// Numbers the website (and the dealer's own settings) actually contain.
export function sourceNumbers({ vehicle = {}, dealer = {}, priceNote = '', price = null } = {}) {
  const v = vehicle;
  const bits = [
    v.year, v.make, v.model, v.trim, v.name, v.mileage, v.stock, v.engine, v.transmission, v.drivetrain,
    v.exteriorColor, v.interiorColor, v.bodyType, v.fuelType, v.price, v.priceBeforeFees, v.descriptionRaw,
    ...(Array.isArray(v.features) ? v.features : []),
    priceNote, price, dealer.name, dealer.city, dealer.zip,
  ];
  return numbersIn(bits.filter((b) => b !== null && b !== undefined).join(' '));
}

// ---------- prices and mileage the text states ----------
// A price or a mileage in a description is a claim about this car's price
// or odometer, so it must be the one the listing carries: the price being
// posted (or an amount in the dealer's price note) and the website's
// mileage. The write-up's own numbers count as "in the website's data", so
// without these checks a write-up still saying last month's "now just
// $28,995 with 38,000 miles" would pass. Both are read in the usual ways a
// write-up states them: "$28,995", "Internet price: 28,995", "was 31,995";
// "38,000 miles", "38,000 original miles", "Mileage: 38,000", "odometer
// reads 38,000", "38,000 on the clock". Distances, ranges, warranty terms
// and fuel economy ("30 miles away", "300 miles of range", "a
// 3-year/36,000-mile warranty", "2 years or 24,000 miles", "gas mileage of
// 30 mpg") are not the odometer, and a model year is neither ("Low mileage
// 2019 Ram").

const amountOf = (digits, thousands) => Math.round(Number(String(digits).replace(/,/g, '')) * (thousands ? 1000 : 1));
const YEAR_SHAPED = /^(?:19|20)\d{2}$/;
// Words that can sit between a number and "miles": "38,000 original miles".
const MILE_WORDS = '(?:original|actual|true|indicated|documented|verified|certified|highway|hwy|city|local|easy|gentle|careful|adult|low|total|clean)';
// After a number: a mileage or another measure, so not a price.
const MEASURE_AFTER = new RegExp(`^\\s?(?:(?:k|thousand)\\b)?[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(?:miles?\\b|mi\\b|kms?\\b|kilomet|lbs?\\b|pounds?\\b|rpm\\b|cc\\b|hp\\b|horsepower|mpg|gal|watts?\\b|volts?\\b|ft\\b|feet|on the (?:odometer|odo|clock)\\b)`, 'i');

const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)(\s?k\b)?/gi;
// A price-sized number right after a price word, written without "$".
const PRICE_WORD = /\b(prices?|priced|msrp|asking|was|now(?:\s+(?:just|only))?|yours for|reduced to|dropped to)(?:\s+(?:is|of|at|to|just|only|now))*\s*[:\-–]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,7}(?:\.\d{1,2})?|\d{1,3}(?:\.\d+)?(?=\s?k\b))(?![\d,]\d)(\s?k\b)?/gi;
function priceWordAmounts(t) {
  const out = [];
  for (const m of t.matchAll(PRICE_WORD)) {
    if (!m[3] && YEAR_SHAPED.test(m[2])) continue;
    if (MEASURE_AFTER.test(t.slice(m.index + m[0].length, m.index + m[0].length + 40))) continue;
    out.push({ text: m[0].trim(), value: amountOf(m[2], m[3]), lead: m[1], at: m.index });
  }
  return out;
}
export function dollarAmounts(text) {
  const t = String(text ?? '');
  const signed = [...t.matchAll(DOLLARS)].map((m) => ({ text: m[0].trim(), value: amountOf(m[1], m[2]), at: m.index }));
  return [...signed, ...priceWordAmounts(t)].sort((a, b) => a.at - b.at).map(({ text: said, value }) => ({ text: said, value }));
}

const MILES = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:k|thousand)\\b)?[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(?:miles?\\b|mi\\b\\.?)`, 'gi');
const NOT_ODOMETER_BEFORE = /(?:\/|\b(?:within|up to|every|range(?: of)?|per|(?:years?|yrs?|months?|mos?)\s+(?:or|and)))\s*:?\s*$/i;
const NOT_ODOMETER_AFTER = /^[\s-]*(?:\/|(?:from|per|an? hour|to empty)\b|(?:[\w'-]+\s+){0,2}(?:warranty|powertrain|bumper|coverage|range|radius|away|charge|tank)\b)/i;
// "Mileage: 38,000", "odometer reads 38,000", "38,000 on the odometer".
const ODOMETER_SAYS = /\b(gas |fuel )?(?:mileage|odometer(?: reading)?|odo)\b(?:\s+(?:is|of|reads|reading|shows|showing|says|at|now))*\s*[:\-–]?\s*(?:(?:only|just)\s+)?(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand)\b)?/gi;
const ON_ODOMETER = /(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand)\b)?\s+on the (?:odometer|odo|clock)\b/gi;
const FUEL_AFTER = /^\s*(?:mpg|mpge|miles? per|city|hwy|highway|combined|\/|%)/i;
export function mileageClaims(text) {
  const t = String(text ?? '');
  const found = new Map(); // where the number starts -> the claim
  for (const m of t.matchAll(MILES)) {
    if (NOT_ODOMETER_BEFORE.test(t.slice(Math.max(0, m.index - 20), m.index))) continue;
    if (NOT_ODOMETER_AFTER.test(t.slice(m.index + m[0].length, m.index + m[0].length + 40))) continue;
    found.set(m.index, { text: m[0].trim(), value: amountOf(m[1], m[2]) });
  }
  for (const m of t.matchAll(ODOMETER_SAYS)) {
    const at = m.index + m[0].length - m[2].length - (m[3] || '').length;
    if (m[1] || found.has(at) || (!m[3] && YEAR_SHAPED.test(m[2]))) continue;
    if (FUEL_AFTER.test(t.slice(m.index + m[0].length, m.index + m[0].length + 20))) continue;
    found.set(at, { text: m[0].trim(), value: amountOf(m[2], m[3]) });
  }
  for (const m of t.matchAll(ON_ODOMETER)) if (!found.has(m.index)) found.set(m.index, { text: m[0].trim(), value: amountOf(m[1], m[2]) });
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, claim]) => claim);
}

// Wording that claims a price change. Prices only ever mirror the website,
// and a listing's price drop reaches buyers through the listing itself.
export const PRICE_CHANGE = /\b(?:price (?:drop(?:ped)?|reduced|reduction|cut)|reduced price|just reduced|marked down|was \$|now (?:just |only )?\$)/i;
const CHANGE_LEAD = /^(?:was|now|reduced to|dropped to)\b/i;
function priceChangeSaid(text) {
  const m = PRICE_CHANGE.exec(text);
  if (m) return m[0].trim();
  const w = priceWordAmounts(String(text ?? '')).find((a) => CHANGE_LEAD.test(a.lead));
  return w ? w.text : '';
}

// The problems a text's prices and mileage give, for runGuardrails.
function priceAndMileageProblems(text, { vehicle = {}, priceNote = '', price = null }) {
  const problems = [];
  const posted = typeof price === 'number' && price > 0 ? Math.round(price) : null;
  const allowed = new Set([posted, ...dollarAmounts(priceNote).map((a) => a.value)].filter((n) => n !== null));
  const said = new Set();
  for (const a of dollarAmounts(text)) {
    if (allowed.has(a.value) || said.has(a.value)) continue;
    said.add(a.value);
    const money = `$${a.value.toLocaleString('en-US')}`;
    problems.push({ code: 'price-mismatch', text: posted ? `Says ${money}, but this listing's price is $${posted.toLocaleString('en-US')}` : `Says ${money}; the price belongs in the listing's price field` });
  }
  const miles = typeof vehicle.mileage === 'number' && vehicle.mileage >= 0 ? Math.round(vehicle.mileage) : null;
  const claimed = new Set();
  for (const m of mileageClaims(text)) {
    if (m.value === miles || claimed.has(m.value)) continue;
    claimed.add(m.value);
    problems.push({ code: 'mileage-mismatch', text: `Says ${m.value.toLocaleString('en-US')} miles, but the website shows ${miles === null ? 'no mileage for this car' : `${miles.toLocaleString('en-US')} miles`}` });
  }
  const change = priceChangeSaid(text);
  if (change) problems.push({ code: 'price-change', text: `Says "${change}"; a description never claims a price change` });
  return problems;
}

// A feature the template may name, or the start of a write-up sentence it
// may copy: no price at all (the price is the listing's own field), no
// price change, and no mileage other than the website's.
const statesNoOtherNumbers = (text, vehicle) => !priceAndMileageProblems(text, { vehicle }).length;
// A write-up sentence the template may copy: that, and nothing the checks
// would refuse in the template's own text, a banned phrase ("no accidents",
// "private sale") or "one owner" without the Carfax one-owner flag.
const narrativeSentenceOk = (sentence, vehicle) =>
  statesNoOtherNumbers(sentence, vehicle) && !BANNED_RE.some(([, re]) => re.test(sentence)) && !(ONE_OWNER.test(sentence) && !vehicle.carfaxOneOwner);

// The website's features a description can name as highlights: each once,
// short enough to read in a list (40 characters or less), stating no price,
// price change or mileage (a feature such as "Under 30,000 Miles" or
// "$1,000 Below Market" is a claim the checks hold to the listing's own
// numbers, not equipment), no banned phrase ("Accident Free", "Clean
// Title") and no one-owner claim (the template says one owner itself, from
// the Carfax flag), ranked by FEATURE_PRIORITY and then the website's own
// order. The side panel offers these for the salesperson's
// pick; the template takes the first few.
export function featureChoices(features) {
  if (!Array.isArray(features)) return [];
  const seen = new Set();
  const clean = [];
  for (const f of features) {
    if (typeof f !== 'string') continue;
    const t = f.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40 || seen.has(t.toLowerCase()) || !statesNoOtherNumbers(t, {})) continue;
    if (BANNED_RE.some(([, re]) => re.test(t)) || ONE_OWNER.test(t)) continue;
    seen.add(t.toLowerCase());
    clean.push(t);
  }
  const rank = (t) => {
    const i = FEATURE_PRIORITY.findIndex((re) => re.test(t));
    return i === -1 ? FEATURE_PRIORITY.length : i;
  };
  return clean.map((t, i) => ({ t, r: rank(t), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);
}

export const MAX_HIGHLIGHTS = 6;

export function pickFeatures(features, { min = 4, max = MAX_HIGHLIGHTS } = {}) {
  const ranked = featureChoices(features);
  const want = ranked.length < min ? ranked.length : Math.min(max, ranked.length);
  return ranked.slice(0, want);
}

// The salesperson's own pick of highlights, settled against the website: only
// features the website lists for this car (matched without regard to case or
// spacing, written as the website writes them), each once, in the order
// picked, at most MAX_HIGHLIGHTS. null (no pick made) is the usual choice.
export function settleHighlights(pick, features) {
  if (!Array.isArray(pick)) return pickFeatures(features);
  const key = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const byKey = new Map(featureChoices(features).map((t) => [key(t), t]));
  const out = [];
  for (const p of pick) {
    const t = byKey.get(key(p));
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_HIGHLIGHTS);
}

// ---------- the salesperson's closing line ----------
// One sentence or two of the salesperson's own, typed in Settings and added
// after the sign-off of every description ("Ask for me by name; I'm in
// Monday to Saturday."). It is about them, not the car: facts about the car
// come from the website, so the line carries no numbers except a phone
// number, no prices and none of the banned phrases. Like the VIN line it is
// left out of the word count, so a long line never pushes out the car's facts.

export const CLOSING_LINE_MAX_WORDS = 30;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

export function cleanClosingLine(line) {
  return String(line ?? '').replace(/\s+/g, ' ').trim();
}

// { ok, problems: [{ code, text }] } for a closing line as typed. An empty
// line is fine: the description then ends as before.
export function checkClosingLine(line) {
  const t = cleanClosingLine(line);
  const problems = [];
  if (!t) return { ok: true, problems };
  const words = wordCount(t);
  if (words > CLOSING_LINE_MAX_WORDS) problems.push({ code: 'closing-too-long', text: `The closing line has ${words} words; keep it to ${CLOSING_LINE_MAX_WORDS}` });
  if (/\$\s?\d|\d\s?%|\bdollars?\b|\bpercent\b/i.test(t)) problems.push({ code: 'closing-price', text: 'The closing line mentions money; prices come from the website only' });
  else if (/\d/.test(t.replace(PHONE, ' '))) problems.push({ code: 'closing-number', text: 'The closing line has a number in it; a phone number is fine, but facts about the car come from the website' });
  for (const [phrase, re] of BANNED_RE) {
    if (re.test(t)) problems.push({ code: 'closing-banned', text: `The closing line says "${phrase}"` });
  }
  if (ONE_OWNER.test(t)) problems.push({ code: 'closing-one-owner', text: "The closing line says one owner; that comes from the car's Carfax report, not from you" });
  if (shouting(t)) problems.push({ code: 'closing-caps', text: 'The closing line has ALL CAPS shouting' });
  if (emojiCount(t) > 1) problems.push({ code: 'closing-emoji', text: 'The closing line has more than one emoji' });
  return { ok: problems.length === 0, problems };
}

// The closing line to write into descriptions: the cleaned line when it
// passes its checks, otherwise none.
export const usableClosingLine = (line) => (checkClosingLine(line).ok ? cleanClosingLine(line) : '');

// Adds the closing line on a line of its own when the text doesn't already
// carry it (a draft from the rewrite service never does: the line is not
// sent there).
export function ensureClosingLine(text, line) {
  const c = cleanClosingLine(line);
  const t = String(text || '').trimEnd();
  if (!c || closingPattern(c).test(t)) return t;
  return `${t}\n${c}`;
}

// The text without the closing line, for the word count and the number check.
// Matched with any run of spaces or line breaks between its words, so a
// line the salesperson wrapped in the box is still recognised.
const closingPattern = (c) => new RegExp(c.split(' ').map(escapeRe).join('\\s+'));
function stripClosing(text, line) {
  const c = cleanClosingLine(line);
  if (!c) return text;
  return String(text || '').replace(closingPattern(c), ' ');
}

function firstSentences(text, maxSentences, maxWords, keep = () => true) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean).filter(keep);
  const out = [];
  for (const s of sentences.slice(0, maxSentences)) {
    if (wordCount([...out, s].join(' ')) > maxWords) break;
    out.push(s);
  }
  return out.join(' ');
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * @param {object} args
 *   vehicle:     normalised vehicle (normalize.js)
 *   dealer:      { name, city }
 *   salesperson: { name, title }
 *   priceNote:   the dealer's wording about fees, typed in Settings (a suggested sentence is offered from the website's price gap)
 *   narrative:   car-specific sentences from description.js (cleanDescription)
 *   highlights:  the salesperson's pick of the website's features (settleHighlights); null for the usual pick
 *   closingLine: the salesperson's own line from Settings (salesperson.closingLine), used when it passes checkClosingLine
 */
export function buildTemplateDescription({ vehicle: v, dealer = {}, salesperson = {}, priceNote = '', narrative = [], highlights = null }) {
  const dealerName = String(dealer.name || '').trim();
  const city = String(dealer.city || '').trim();
  const person = String(salesperson.name || '').trim();
  const title = String(salesperson.title || DEFAULT_SALESPERSON_TITLE).trim();
  const name = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
  const milesText = typeof v.mileage === 'number' ? `${v.mileage.toLocaleString('en-US')} miles` : '';
  const features = settleHighlights(highlights, v.features);
  const closing = usableClosingLine(salesperson.closingLine);
  const mech = [v.engine, v.transmission, v.drivetrain].map((s) => String(s || '').trim()).filter(Boolean);
  const colors = [v.exteriorColor && `${v.exteriorColor} exterior`, v.interiorColor && `${v.interiorColor} interior`].filter(Boolean);
  // the write-up's first sentences, leaving out any that state a price, a price change or another mileage
  const story = Array.isArray(narrative) && narrative.length ? firstSentences(narrative[0], 2, 45, (sentence) => narrativeSentenceOk(sentence, v)) : '';

  // keep: 'always' = part of every description; 'optional' = dropped (in
  // order) if the text runs long; 'filler' = added (in order) if it runs short.
  const blocks = [
    { id: 'lead', keep: 'always', text: milesText ? `${name} with ${milesText}.` : `${name}.` },
    { id: 'owner', keep: 'always', text: v.carfaxOneOwner ? 'One owner according to the Carfax report.' : '' },
    { id: 'narrative', keep: 'optional', text: story },
    { id: 'features', keep: 'always', text: features.length ? `Highlights: ${features.join(', ')}.` : '' },
    { id: 'colors', keep: 'optional', text: colors.length ? `${capitalize(colors.join(', '))}.` : '' },
    { id: 'mech', keep: 'optional', text: mech.length ? `${mech.join(', ')}.` : '' },
    { id: 'where', keep: 'always', text: dealerName ? `Pre-owned and on the lot at ${dealerName}${city ? ' in ' + city : ''}.` : '' },
    { id: 'carfax', keep: 'filler', text: v.carfaxUrl ? 'Carfax report available, just ask.' : '' },
    { id: 'stock', keep: 'filler', text: v.stock ? `Stock number ${v.stock}.` : '' },
    { id: 'vin', keep: 'always', text: v.vin ? `VIN ${String(v.vin).toUpperCase().replace(/[^A-Z0-9]/g, '')}.` : '' },
    { id: 'priceNote', keep: 'always', text: String(priceNote || '').trim() },
    // with no dealership name set the checks stop the description; the sign-off still never reads "at ."
    { id: 'signoff', keep: 'always', text: `${person ? `I'm ${person}, ${title}` : capitalize(title)}${dealerName ? ` at ${dealerName}` : ''}.` },
    { id: 'closing', keep: 'always', text: closing },
    // the salesperson's own closing line takes the place of the stock invitation
    { id: 'cta', keep: 'optional', text: closing ? '' : 'Message me to set up a test drive or ask a question.' },
    { id: 'more', keep: 'filler', text: 'Happy to send more photos or answer any questions.' },
    { id: 'visit', keep: 'filler', text: dealerName ? `Come take a look in person at ${dealerName}.` : '' },
    { id: 'reply', keep: 'filler', text: "Message me here on Marketplace and I'll get right back to you." },
  ].filter((b) => b.text);

  const on = new Set(blocks.filter((b) => b.keep !== 'filler').map((b) => b.id));
  const render = () => blocks.filter((b) => on.has(b.id)).map((b) => b.text).join('\n');
  // the closing line and the VIN line are not counted, as in runGuardrails
  const words = () => wordCount(stripVin(stripClosing(render(), closing)));

  for (const id of ['narrative', 'mech', 'colors', 'cta']) {
    if (words() <= WORD_LIMITS.max) break;
    on.delete(id);
  }
  for (const b of blocks.filter((b) => b.keep === 'filler')) {
    if (words() >= WORD_LIMITS.min) break;
    on.add(b.id);
  }
  return render();
}

function shouting(text) {
  const tokens = String(text || '').split(/\s+/);
  let run = 0;
  for (const tok of tokens) {
    const word = tok.replace(/[^A-Za-z]/g, '');
    const caps = word.length >= 3 && word === word.toUpperCase() && !/\d/.test(tok);
    if (word.length >= 10 && caps) return true;
    run = caps ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

function emojiCount(text) {
  return (String(text || '').match(/\p{Extended_Pictographic}/gu) || []).length;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const BANNED_RE = BANNED_PHRASES.map((p) => [p, new RegExp('\\b' + escapeRe(p).replace(/[\s-]+/g, '[\\s-]+') + '\\b', 'i')]);
// "one owner", "1-owner", "single-owner", "one careful owner", "only one
// previous owner", "its sole owner", "its first owner", "owned by one family"
const ONE_OWNER = /\b(?:(?:one|1|single)[\s-]+(?:(?!(?:new|next|more|other|of|the|a|an|its|your|lucky)\b)[a-z']+[\s-]+){0,2}owner|(?:sole|only|first)[\s-]+owner|owned by (?:one|a single))\b/i;

// ---------- claims only the website can make ----------
// What a description says about the car's certification, warranty,
// financing, history, care, parts or condition comes from the website's own
// words for this car (its write-up, features and the rest of its record) or
// the dealer's price note, never from the writer. Each kind of claim is found
// by its words, and passes when words of the same kind are in those sources
// (new parts: the same part, too); certified also passes when the website
// lists the car as certified. The dealership's name, its city and the
// salesperson's role are not claims about the car and are set aside first,
// as are banned phrases (flagged on their own). A false positive only means
// the template is used: beyond its own fixed sentences, everything the
// template writes is copied from those sources.
const PARTS = "tires?|tyres?|brakes?|rotors?|pads|battery|batteries|wipers?|shocks?|struts?|exhaust|alternator|starter|clutch|timing (?:belt|chain)|water pump|engine|motor|transmission|paint|parts";
export const CLAIM_KINDS = Object.freeze([
  { what: 'certification', re: /\b(?:certified|cpo)\b/i },
  { what: 'a warranty or guarantee', re: /\b(?:warrant(?:y|ies|eed)|guarantee[ds]?)\b/i },
  { what: 'financing or credit', re: /\b(?:financ\w*|credit|approv\w*|loans?|lenders?|apr|down[\s-]payments?|monthly payments?|per month|lease\w*|buy[\s-]here)\b/i },
  { what: 'accident, damage or title history', re: /\b(?:accidents?|collisions?|wreck(?:s|ed)?|damaged?|flood\w*|salvage|rebuilt|titles?|clean (?:carfax|autocheck|history|record|report))\b/i },
  { what: 'smoking or pets', re: /\b(?:non[\s-]?smok\w*|smok(?:er|ers|ing|ed)|smoke[\s-]?free|pet[\s-]?free|no pets)\b/i },
  { what: 'service history, inspection or upkeep', re: /\b(?:inspect\w*|serviced|service (?:history|records?)|maintenance|maintained|oil changes?|tune[\s-]?up|reconditioned|garage[\s-]kept|well[\s-](?:kept|cared)|taken care of)\b/i },
  { what: 'new or replaced parts', re: new RegExp(`\\b(?:(?:brand[\\s-])?new|newer|fresh|replaced|recent)\\s+(?:set of\\s+)?(${PARTS})\\b`, 'i'), part: true },
  { what: 'its condition', re: /\b(?:(?:excellent|great|good|pristine|immaculate|showroom|top|amazing|beautiful|clean) (?:condition|shape)|runs (?:great|strong|well|smooth\w*|excellent)|drives (?:great|well|smooth\w*|excellent)|mechanically sound|needs nothing|turn[\s-]?key|rust[\s-]free|no (?:rust|dents|problems))\b/i },
]);

// The write-up as the website shows it, and as the template copies it
// (description.js splitSegments): split at its line breaks, markup set
// aside, spacing made plain. A claim the template copies from "new
// <b>tires</b>" is then found in its own source.
function writeUpText(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.split(/<br\s*\/?>/i).map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// The website's own words for this car, where its claims may come from.
function claimSource({ vehicle = {}, priceNote = '' }) {
  const v = vehicle;
  const bits = [
    v.year, v.make, v.model, v.trim, v.name, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, writeUpText(v.descriptionRaw), ...(Array.isArray(v.features) ? v.features : []), priceNote,
  ];
  return bits.filter((b) => b !== null && b !== undefined).map((b) => oneLine(b)).join('\n');
}

// The website lists the car as certified: its inventory type, the type it
// shows, or the condition word in its address or at the start of its title.
// The rewrite service gets none of these, so there a draft says certified
// only when the write-up or the features do.
export function listedCertified(v = {}) {
  const titleWords = typeof v.siteTitle === 'string' ? (v.siteTitle.match(/^\s*(.*?)\s*\b(?:19|20)\d{2}\b/) || [])[1] : '';
  return /\b(?:certified|cpo)\b/i.test([v.inventoryType, v.readableType, v.urlConditionWord, titleWords].filter((s) => typeof s === 'string').join(' '));
}

// The text with the given names (the dealership, its city, the role) set aside.
function without(text, names) {
  let out = String(text || '');
  for (const n of names) {
    const name = oneLine(n);
    if (name) out = out.replace(new RegExp(escapeRe(name).replace(/ /g, '\\s+'), 'gi'), ' ');
  }
  return out;
}

// Every claim in the text, not only the first of each kind: one part the
// website names ("new tires") never covers another the text adds ("new
// brakes"). Each kind the sources don't make is said once; each new part
// they don't name is said once.
function claimProblems(text, ctx) {
  const source = claimSource(ctx);
  const problems = [];
  for (const kind of CLAIM_KINDS) {
    if (kind.what === 'certification' && listedCertified(ctx.vehicle)) continue;
    const sourced = kind.re.test(source);
    const said = new Set();
    for (const m of String(text).matchAll(new RegExp(kind.re.source, 'gi'))) {
      const part = kind.part ? m[1].replace(/(?:ies|s)$/i, '').toLowerCase() : '';
      if (sourced && (!kind.part || new RegExp(`\\b${escapeRe(part)}`, 'i').test(source))) continue;
      if (said.has(part)) continue;
      said.add(part);
      problems.push({ code: 'unsupported-claim', text: `Says "${m[0]}", but the website says nothing about ${kind.what} for this car` });
    }
  }
  return problems;
}

// ---------- numbers written out in words ----------
// "thirty thousand miles", "twenty-five mpg", "two owners": a quantity in
// words is a number like any other, so it must be in the website's data (as
// digits, or in the same words with the same unit). Number words count only
// as a quantity: with "hundred" or "thousand", or before a unit; a "one" in
// passing ("this one") is not a number, and "one owner" has its own check.
const NUMBER_WORDS = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const NUM_WORD = `(?:${Object.keys(NUMBER_WORDS).join('|')}|hundred|thousand)`;
const SPELLED = new RegExp(`\\b${NUM_WORD}(?:(?:[\\s-]+|\\s+and\\s+)${NUM_WORD})*\\b`, 'gi');
const SPELLED_UNIT = new RegExp(`^[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(miles?|mi|mpg|k|grand|dollars?|bucks|years?|months?|owners?|keys|sets? of keys)\\b`, 'i');
function spelledValue(words) {
  let total = 0;
  let current = 0;
  for (const w of words.toLowerCase().split(/[\s-]+/)) {
    if (w in NUMBER_WORDS) current += NUMBER_WORDS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
    }
  }
  return total + current;
}
// [{ words, said, value }]: the number words, them with their unit, the number.
export function spelledQuantities(text) {
  const t = String(text ?? '');
  const out = [];
  for (const m of t.matchAll(SPELLED)) {
    const unit = SPELLED_UNIT.exec(t.slice(m.index + m[0].length, m.index + m[0].length + 40));
    if (!/\b(?:hundred|thousand)\b/i.test(m[0]) && !unit) continue;
    const value = spelledValue(m[0]) * (unit && /^(?:k|grand)$/i.test(unit[1]) ? 1000 : 1);
    if (unit && /^owner/i.test(unit[1]) && value === 1) continue;
    out.push({ words: m[0], said: oneLine(m[0] + (unit ? unit[0] : '')), value });
  }
  return out;
}
// The words, said the same way, somewhere in the text (a hyphen or a space between words).
const saysWords = (text, words) => new RegExp(`\\b${escapeRe(oneLine(words)).replace(/[\s-]+/g, '[\\s-]+')}\\b`, 'i').test(String(text || ''));

// The problems a person may still post with: the length and the tone. Every
// other problem (a number, price, mileage or claim the website doesn't make,
// a banned phrase, one owner without the Carfax flag, a missing dealership,
// role, VIN or price note, a price note for another fee) keeps the side
// panel from filling the form until the description is fixed, and a new
// kind of problem does too until it is added here.
export const STYLE_PROBLEMS = Object.freeze(['too-short', 'too-long', 'all-caps', 'emoji', 'closing-too-long', 'closing-caps', 'closing-emoji']);
export const blockingProblems = (g) => (g && Array.isArray(g.problems) ? g.problems.filter((p) => !STYLE_PROBLEMS.includes(p.code)) : []);

/**
 * Checks a description against the source data. Returns { ok, problems, words }.
 * Every problem has a code and a short plain-English text.
 */
export function runGuardrails(text, { vehicle = {}, dealer = {}, salesperson = {}, priceNote = '', price = null, closingLine = '' } = {}) {
  const t = String(text || '');
  // the closing line is the salesperson's, checked on its own (checkClosingLine) wherever the text carries it
  const closing = cleanClosingLine(closingLine);
  const hasClosing = Boolean(closing) && closingPattern(closing).test(t);
  const prose = stripVin(hasClosing ? stripClosing(t, closing) : t);
  const problems = [];
  const words = wordCount(prose);
  if (words < WORD_LIMITS.min) problems.push({ code: 'too-short', text: `${words} words; needs at least ${WORD_LIMITS.min}` });
  if (words > WORD_LIMITS.max) problems.push({ code: 'too-long', text: `${words} words; the limit is ${WORD_LIMITS.max}` });

  const src = sourceNumbers({ vehicle, dealer, priceNote, price });
  for (const n of numbersIn(prose)) {
    if (!src.has(n)) problems.push({ code: 'unknown-number', text: `"${n}" isn't in the website's data for this car` });
  }
  // the car's own words: without the dealership's name, its city and the role, which are not claims about it
  const role = String((salesperson && salesperson.title) || DEFAULT_SALESPERSON_TITLE).replace(/\s+/g, ' ').trim();
  const aboutCar = without(prose, [dealer.name, dealer.city, role]);
  const sourceWords = claimSource({ vehicle, priceNote });
  const spelled = new Set();
  for (const q of spelledQuantities(aboutCar)) {
    const words = oneLine(q.words).toLowerCase();
    if (spelled.has(words) || src.has(String(q.value)) || saysWords(sourceWords, q.said)) continue;
    spelled.add(words);
    problems.push({ code: 'unknown-number', text: `"${oneLine(q.words)}" isn't in the website's data for this car` });
  }
  problems.push(...priceAndMileageProblems(prose, { vehicle, priceNote, price }));
  // The price note is the dealer's wording. When it quotes a dollar amount and
  // the website shows two prices for this car, the amount must be their
  // difference; a note written for one fee must not ride on a car with another.
  const gap = typeof vehicle.price === 'number' && typeof vehicle.priceBeforeFees === 'number' && vehicle.priceBeforeFees > 0 && vehicle.priceBeforeFees < vehicle.price ? vehicle.price - vehicle.priceBeforeFees : null;
  if (gap !== null) {
    const note = String(priceNote || '');
    const amounts = [...note.matchAll(/\$\s?(\d[\d,]*)/g)].map((m) => ({ text: m[0], value: Number(m[1].replace(/,/g, '')), at: m.index }));
    // the amount the note ties to the fee: "$490 doc fee" or "doc fee of $490"; a lone amount counts too
    const FEE = '(doc|documentation|dealer|processing|conveyance)';
    const tiedAfter = new RegExp('^\\s*(?:\\w+\\s+){0,2}' + FEE + '\\b', 'i');
    const tiedBefore = new RegExp('\\b' + FEE + '\\s+fees?\\s*(?:of|is|:|at)?\\s*$', 'i');
    let tied = amounts.filter((a) => tiedAfter.test(note.slice(a.at + a.text.length)) || tiedBefore.test(note.slice(0, a.at)));
    if (!tied.length && amounts.length === 1) tied = amounts;
    for (const a of tied) {
      if (a.value !== gap && t.includes(a.text.replace(/\s/g, ''))) problems.push({ code: 'price-note-amount', text: `The price note says $${a.value.toLocaleString('en-US')}, but the website's two prices for this car differ by $${gap.toLocaleString('en-US')}; check the note in Settings` });
    }
  }
  // The note says what the posted price includes or leaves out (a doc fee,
  // tax and tags), so it is in every description it applies to, whole: a
  // draft or an edit that drops it would post the price without it.
  const noteSaid = oneLine(priceNote);
  if (noteSaid && !oneLine(t).toLowerCase().includes(noteSaid.toLowerCase())) {
    problems.push({ code: 'no-price-note', text: `Doesn't include your dealership's price note: "${noteSaid}"` });
  }
  const vin = String(vehicle.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin && !t.toUpperCase().includes(vin)) problems.push({ code: 'no-vin', text: "Doesn't include the VIN" });
  for (const [phrase, re] of BANNED_RE) {
    if (re.test(t)) problems.push({ code: 'banned-phrase', text: `Says "${phrase}"` });
  }
  if (ONE_OWNER.test(t) && !vehicle.carfaxOneOwner) {
    problems.push({ code: 'one-owner', text: "Says one owner, but the Carfax one-owner flag isn't set" });
  }
  // a banned phrase is said once, as banned, not again as a claim
  problems.push(...claimProblems(BANNED_RE.reduce((s, [, re]) => s.replace(new RegExp(re.source, 'gi'), ' '), aboutCar), { vehicle, priceNote }));
  // the dealership is always named: with no name set there is nothing to name it by
  const dealerName = String(dealer.name || '').trim();
  if (!dealerName) problems.push({ code: 'no-dealer', text: 'No dealership name is set; add it in Settings (Dealership name)' });
  else if (!t.toLowerCase().includes(dealerName.toLowerCase())) {
    problems.push({ code: 'no-dealer', text: `Doesn't name ${dealerName}` });
  }
  // the salesperson's role is always stated (the sign-off says it), so the listing never reads as a private sale
  if (role && !t.replace(/\s+/g, ' ').toLowerCase().includes(role.toLowerCase())) {
    problems.push({ code: 'no-role', text: `Doesn't give your role ("${role}"); the sign-off says it` });
  }
  if (shouting(t)) problems.push({ code: 'all-caps', text: 'Has ALL CAPS shouting' });
  if (emojiCount(t) > 3) problems.push({ code: 'emoji', text: 'Too many emoji' });
  if (hasClosing) for (const p of checkClosingLine(closing).problems) if (!problems.some((q) => q.text === p.text)) problems.push(p);
  return { ok: problems.length === 0, problems, words };
}
