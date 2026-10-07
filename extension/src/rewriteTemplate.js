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
//     care, new parts, condition, previous owners, how it was driven,
//     where it came from (a local trade, a lease return) or its keys that
//     the website's own words for this car (or the dealer's price note)
//     don't make, and no number, in digits or in words, that isn't in the
//     website's data
// The template is the final fallback, so it is built to pass its own checks
// and, when in doubt, to say less. It is written from the car's listed facts
// only (its name, mileage, features, colours, engine, store, stock number and
// VIN, the Carfax flags, and the dealer's price note) and never copies the
// website's own write-up: a sentence taken from free text can be cut where
// it seems to end and say the opposite of the website, and no rule for where
// a sentence ends holds for every dealer and language. The write-up is the
// optional rewrite service's to draw on (description.js cleanDescription),
// and the checks below read it as the website's own words. When the
// website's words shout beyond the car's own abbreviations ("SLE", "AWD":
// they stay as written, and the checks pass over them) it writes them
// calmly, leaves out a colour or engine line that still shouts on its own,
// and counts words as the checks do.
// test/rewriteTemplate.test.js runs it over every fixture car, as written,
// in capitals and with write-ups it must not copy, and test/writeUpLine.test.js
// checks over thousands of write-ups that it never copies one. What the tests
// find can still fail it is the dealership's own Settings (no dealership
// name, a price note for another fee, a name typed in capitals, a number in
// the role or the name, a dealership name that reads as a price or a
// mileage), and the side panel says which.

import { DEFAULT_SALESPERSON_TITLE } from './settings.js';
import { carStore } from './listingData.js';
import { splitSegments, withoutLotWide, lotWideLines as plainLotWide } from './description.js';

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
  'private seller', 'private sale', 'private party', 'by owner', 'fsbo', 'not a dealer', 'not a dealership',
  'selling it myself', 'i am the owner', "i'm the owner", 'i\u2019m the owner', 'selling my', 'my personal', 'my truck', 'my car', 'my suv', 'my daily driver',
  //   steering the buyer away from the dealership, or selling for someone else
  'not the dealership', 'not the dealer', 'not the dealerships', 'not the dealers', 'not through the dealership', 'not through the dealer', 'not at the dealership', 'skip the dealership', 'skip the dealer',
  'instead of the dealership', 'instead of the dealer', "don't call the dealership", "don't call the dealer", 'don\u2019t call the dealership', 'don\u2019t call the dealer',
  'bypass the dealership', 'bypass the dealer', 'avoid the dealership', 'avoid the dealer',
  'for the owner', 'for the owners', 'on behalf of the owner', 'for a friend', 'for my friend', 'for my brother', 'for my sister', 'for my neighbor', 'for my neighbour', 'reason for selling',
  //   the car as the writer's own
  "i've owned", 'i\u2019ve owned', 'i have owned', 'my own truck', 'my own car', 'my own vehicle', 'my own suv', 'my own jeep', 'my own van', 'my vehicle', 'my jeep', 'my van',
  'our family truck', 'our family car', 'our family suv', 'our family van', 'our family vehicle',
  // protected characteristics have no place in a car ad
  'christian', 'muslim', 'jewish', 'hindu', 'catholic', 'religious', 'hispanic', 'latino', 'immigrant', 'citizens only',
  'disabled', 'handicapped', 'elderly', 'seniors only', 'for men', 'for women', 'for ladies', 'family only', 'no kids',
  'gay', 'lesbian', 'transgender', 'ethnic',
]);

// Wording a banned phrase is part of that says something else, so the
// phrase is not banned there: the dealership's own desk or line ("Ask for
// me, not the dealer's front desk"; "not the dealership's main line"), and
// the dealership's owner ("I'm the owner of this dealership.", "I'm the
// owner of the store, text me."), where the business ends the sentence or
// clause or only "text me", "call me", "message me", "email me" or "ask for
// me" follows it (after a comma or a dash, maybe with "so" before it and
// "anytime", "by name" or "today" after it), since anything else joined on
// may be the truck. For each
// phrase: what comes right before it, or right after it, when it is fine.
// Still banned: "Text me, not the dealer.", "Buy from me, not the dealer's
// lot.", "I'm the owner.", "I'm the owner of this truck", "I'm the owner of
// this business, and this truck", "I'm the owner of the store and the Ram",
// "I'm the owner of the business, this truck included".
const DEALERS_DESK = "['\u2019]s[\\s-]+(?:front[\\s-]+desk|reception(?:ist|[\\s-]+desk)?|switchboard|main[\\s-]+(?:line|number|phone(?:[\\s-]+(?:line|number))?)|general[\\s-]+(?:line|number)|phone[\\s-]+(?:line|number|tree)|call[\\s-]+cent(?:er|re)|answering[\\s-]+service|voicemail)\\b";
const THE_BUSINESS = "[\\s-]+of[\\s-]+(?:this|the|our)[\\s-]+(?:dealership|dealer|store|business|company|lot)(?=\\s*(?:[.!?;\\n]|$)|\\s*[,\u2013\u2014-]\\s*(?:so\\s+)?(?:text|call|message|email|ask\\s+for)\\s+me(?:\\s+(?:any\\s*time|by\\s+name|today))?\\s*(?:[.!?;\\n]|$))";
export const BANNED_UNLESS = Object.freeze({
  'not the dealership': Object.freeze({ after: DEALERS_DESK }),
  'not the dealer': Object.freeze({ after: DEALERS_DESK }),
  'not the dealerships': Object.freeze({ after: DEALERS_DESK }),
  'not the dealers': Object.freeze({ after: DEALERS_DESK }),
  'i am the owner': Object.freeze({ after: THE_BUSINESS }),
  "i'm the owner": Object.freeze({ after: THE_BUSINESS }),
  'i\u2019m the owner': Object.freeze({ after: THE_BUSINESS }),
});

// In the dealership's price note only (Settings; it goes into every
// description whole), "not the dealer" may also end a sentence that says
// where the fees go: "Plus tax, title and registration, which go to the
// state, not the dealer."; "Registration fees are paid directly to the DMV,
// not the dealership." The sentence starts with the fees, or with a few
// words from a short list before them ("Plus", "Our price excludes",
// "Those", "Sales"), with no ":" or ";" before the phrase and no "I", "me"
// or "my" anywhere in the sentence ("Fees go to the state, not the dealer -
// I sell it myself." is refused). The same words anywhere else (a draft, an
// edit, the salesperson's closing line) are refused: there they steer the
// buyer from the dealership ("Buy from me and the fees go to the state, not
// the dealer."; "Pay me directly; the fees go to the state, not the
// dealer."), and so is the note's own sentence when the text joins words to
// it (runGuardrails reads it where the text puts it).
const FEE_PLACE = "(?:the\\s+|your\\s+)?(?:state|county|city|dmv|bmv|mvd|rmv|government|tax\\s+(?:office|collector|assessor)|secretary\\s+of\\s+state|department\\s+of\\s+(?:motor\\s+vehicles|revenue)|motor\\s+vehicle\\s+(?:department|division|agency))";
const FEES_OPENING = "(?:(?:plus|and|also|note|all|any|applicable|the|those|these|our|sales|state|local|government|advertised|listed|price|prices|pricing|excludes?|excluding|includes?|including|(?:does\\s+not|doesn['\u2019]t|do\\s+not|don['\u2019]t)\\s+include|not\\s+including|before|without)[\\s,]+){0,6}";
const FEES_GO_TO = `(?:^|[.!?\\n])\\s*${FEES_OPENING}\\b(?:tax(?:es)?|title|registration|tags|plates|fees?)\\b(?:(?!\\b(?:i|me|my|mine|myself)\\b)[^.!?;:\\n])*\\b(?:go(?:es)?|paid|payable|collected|due|sent|remitted)(?:\\s+(?:directly|straight))?\\s+(?:to|for|by)\\s+${FEE_PLACE}(?:\\s*(?:,|and|or|&)\\s*${FEE_PLACE})*\\s*[,\u2013\u2014-]?\\s*(?:and\\s+)?(?![^.!?\\n]*\\b(?:i|me|my|mine|myself)\\b)`;
export const PRICE_NOTE_UNLESS = Object.freeze({
  'not the dealership': Object.freeze({ before: FEES_GO_TO }),
  'not the dealer': Object.freeze({ before: FEES_GO_TO }),
  'not the dealerships': Object.freeze({ before: FEES_GO_TO }),
  'not the dealers': Object.freeze({ before: FEES_GO_TO }),
});

// A price note that says one of those phrases ("not the dealer", "not the
// dealership", "not the dealers", "not the dealerships") passes only when,
// besides that rule, every word of the whole note is price and fee wording:
// a word on this closed list, or a word of the dealership's own name or city
// as set. Not its state: the rewrite service is sent the name and city only
// (rewriter.js rewriteFacts), so its checks could not pass the same note,
// and a state code can be a pronoun or a name ("ME", "AL"). A word is a run
// of letters (with any accent that did not join its letter), read after NFKC
// (so full-width letters and digits read as plain ones) and in lower case,
// with an apostrophe or a hyphen splitting it into its parts ("dealer's" is
// "dealer" and "s"). An invisible character (a zero-width space, a soft
// hyphen, a word joiner) is read as nothing, so a word it splits is read
// whole ("A\u200Bbe" is "Abe"); one that changes the direction of the text
// is refused. Its only digits are dollar amounts ("$499", "$1,299.00") and
// percentages ("6%", "6.25 %"), and its only other marks are the
// punctuation between words (NOTE_MARKS). Anything else (a name, a way to
// get in touch, a payment route, "in person", a phone number, a year, an
// emoji, a word with a look-alike letter from another alphabet) refuses the
// note, and the reason quotes it (noteSteerWords). A note without those
// phrases is read as before. The list holds no pronoun but "our", no word
// for a person or a role, no way to get in touch or to pay, no place but a
// government fee place (FEE_PLACE's words, but "your") and no word for
// haggling; test/priceNoteWords.test.js holds it to that, and the hosted
// checker (supabase/functions/_shared/guardrails.ts) lists the same words.
export const PRICE_NOTE_WORDS = Object.freeze([
  // articles, determiners, conjunctions and prepositions
  'a', 'an', 'the', 'all', 'any', 'no', 'only', 'our', 'these', 'those', 'that', 'which',
  'and', 'or', 'nor', 'but', 'as', 'if', 'where',
  'of', 'to', 'for', 'from', 'in', 'on', 'at', 'by', 'with', 'without', 'per', 'before', 'after', 'through', 'upon',
  // verbs that say what the price includes and where the fees go
  'is', 'are', 'be', 'does', 'do', 'not', 'may', 'vary', 'apply', 'applies',
  'include', 'includes', 'included', 'including', 'exclude', 'excludes', 'excluded', 'excluding',
  'go', 'goes', 'paid', 'payable', 'collected', 'due', 'sent', 'remitted', 'directly',
  // the price
  'price', 'prices', 'priced', 'pricing', 'advertised', 'listed', 'internet', 'sale', 'selling', 'cash', 'plus',
  'applicable', 'additional', 'extra',
  'rebate', 'rebates', 'incentive', 'incentives', 'discount', 'discounts', 'manufacturer',
  'financing', 'finance', 'credit', 'approval', 'subject', 'qualified', 'buyers',
  // the fees and who they go to
  'tax', 'taxes', 'sales', 'title', 'titling', 'tag', 'tags', 'plate', 'plates', 'registration', 'registered', 'license', 'licensing',
  'fee', 'fees', 'doc', 'documentation', 'documentary', 'processing', 'electronic', 'filing',
  'dealer', 'dealers', 'dealership', 'dealerships',
  'state', 'county', 'city', 'local', 'government',
  'dmv', 'bmv', 'mvd', 'rmv', 'office', 'collector', 'assessor', 'secretary', 'department', 'motor', 'vehicle', 'vehicles', 'division', 'agency', 'revenue',
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
    priceNote, price, dealer.name, dealer.city, dealer.zip, v.location,
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
// An amount with the word instead of "$" ("1,500 dollars", "2k bucks"), or
// with what money does after it: "1,500 down", "1500 off", "1,000 cash
// back", "a 1,500 rebate", "1,500 in savings", "1,500 under book". "Off"
// that is not money ("1500 off-road", "1500 off-lease", "drive this 1500 off
// the lot") is not.
const DOLLAR_WORDS = /\b(\d[\d,]*(?:\.\d+)?)(\s?k\b)?[\s-]*(?:dollars?|bucks|down|off(?![\s-]?(?:road|lease)|[\s-]+(?:the|our)[\s-]+(?:lot|showroom|line|floor))|cash[\s-]?back|rebates?|discounts?|savings|in (?:savings|rebates?|discounts?|cash[\s-]?back)|(?:under|below) (?:book|kbb|market|retail|msrp|invoice|sticker))\b/gi;
// A price-sized number right after a price word, "save", "rebate",
// "discount", "cash back" or "down payment", written without "$".
const PRICE_WORD = /\b(prices?|priced|msrp|asking|was|now(?:\s+(?:just|only))?|yours for|reduced to|dropped to|sav(?:e|ings?)(?:\s+(?:up to|over))?|rebates?|discounts?|cash[\s-]?back|down[\s-]payments?)(?:\s+(?:is|of|at|to|just|only|now))*\s*[:\-–]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,7}(?:\.\d{1,2})?|\d{1,3}(?:\.\d+)?(?=\s?k\b))(?![\d,]\d)(\s?k\b)?/gi;
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
  const signed = [...t.matchAll(DOLLARS), ...t.matchAll(DOLLAR_WORDS)].map((m) => ({ text: m[0].trim(), value: amountOf(m[1], m[2]), at: m.index }));
  return [...signed, ...priceWordAmounts(t)].sort((a, b) => a.at - b.at).map(({ text: said, value }) => ({ text: said, value }));
}

const MILES = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:k|thousand)\\b)?[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(?:miles?\\b|mi\\b\\.?)`, 'gi');
const NOT_ODOMETER_BEFORE = /(?:\/|\b(?:within|up to|every|range(?: of)?|per|(?:years?|yrs?|months?|mos?)\s+(?:or|and)))\s*:?\s*$/i;
const NOT_ODOMETER_AFTER = /^[\s-]*(?:\/|(?:from|per|an? hour|to empty)\b|(?:[\w'-]+\s+){0,2}(?:warranty|powertrain|bumper|coverage|range|radius|away|charge|tank)\b)/i;
// "Mileage: 38,000", "Miles: 38,000", "odometer reads 38,000", "38,000 on the odometer".
const ODOMETER_SAYS = /\b(gas |fuel )?(?:mileage|odometer(?: reading)?|odo|miles(?=\s*:))\b(?:\s+(?:is|of|reads|reading|shows|showing|says|at|now))*\s*[:\-–]?\s*(?:(?:only|just)\s+)?(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand)\b)?/gi;
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
export const PRICE_CHANGE = /\b(?:price (?:drop(?:ped)?|reduced|reduction|cut)|reduced price|just reduced|marked down|(?:reduced|dropped|lowered|slashed|cut) from(?= \$?\d)|was \$|now (?:just |only )?\$)/i;
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

// A bare amount: a number of a thousand or more with no "$" before it and
// no unit after it ("Only 28,995!", "With 38,000 on it", "Reduced from
// 31,995 to 28,995"). The car's record holds its model, trim, stock number
// and features, and the dealership's name and ZIP; a bare amount none of
// those holds comes from the website's write-up (or is the car's other
// price), where it is a price or a mileage, and a write-up can be out of
// date. So it must be the price being posted, an amount in the price note
// or the website's mileage. A year ("2019") and a phone number are neither,
// and an amount the price and mileage checks read is theirs.
function bareAmountProblems(text, { vehicle = {}, dealer = {}, priceNote = '', price = null }, src) {
  const v = vehicle;
  const t = String(text ?? '');
  const record = [
    v.year, v.make, v.model, v.trim, v.name, v.stock, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, ...(Array.isArray(v.features) ? v.features : []), priceNote, dealer.name, dealer.city, dealer.zip, v.location,
  ];
  const held = numbersIn(record.filter((b) => b !== null && b !== undefined).join(' '));
  const posted = typeof price === 'number' && price > 0 ? Math.round(price) : null;
  const miles = typeof v.mileage === 'number' && v.mileage >= 0 ? Math.round(v.mileage) : null;
  const read = new Set([posted, miles, ...[...dollarAmounts(t), ...dollarAmounts(priceNote), ...mileageClaims(t)].map((a) => a.value)]);
  const phones = [...t.matchAll(PHONE)].map((m) => [m.index, m.index + m[0].length]);
  const problems = [];
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const said = m[0].replace(/,+$/, '');
    const end = m.index + said.length;
    const after = t.slice(end, end + 40);
    const k = /^\s?k\b/i.test(after);
    const value = amountOf(said, k);
    if (value < 1000 || (!k && YEAR_SHAPED.test(said)) || MEASURE_AFTER.test(after)) continue;
    const n = said.replace(/,/g, '');
    if (!src.has(n) || held.has(n) || read.has(value) || phones.some(([a, b]) => m.index >= a && end <= b)) continue;
    read.add(value);
    problems.push({ code: 'unknown-number', text: `Says "${said}${k ? 'k' : ''}" with no "$" and no unit, and it is not the price being posted or the website's mileage for this car; if it is not a price or a mileage, give its unit (such as "lbs") or leave it out` });
  }
  return problems;
}

// A feature the template may name: no price at all (the price is the
// listing's own field), no price change, and no mileage other than the
// website's.
const statesNoOtherNumbers = (text, vehicle) => !priceAndMileageProblems(text, { vehicle }).length;

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

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// The title with its first letter a capital, past any bracket, quote or emoji
// before it ("(BDC) rep", "“Internet” sales"); a letter whose capital is
// more than one letter ("ß") is kept, so the title is still said as typed.
const sentenceCase = (s) => s.replace(/[\p{L}\p{N}]/u, (c) => (c.toUpperCase().length === c.length ? c.toUpperCase() : c));
// The sign-off, the line the template puts right after the price note: with
// no name, the title starts it, so a title the note's sentence check would
// read as carrying the note on (one that starts with a comma, a dot, a dash
// with no space after it or a letter with no capital) is said as "I'm the
// <title>" instead, so the sign-off never fails the note's check. The
// rewrite prompts ask for the same line (backend/rewritePrompt.js).
export function signOffLine(person, title, dealerName) {
  const at = dealerName ? ` at ${dealerName}` : '';
  if (person) return `I'm ${person}, ${title}${at}.`;
  const line = `${sentenceCase(title)}${at}.`;
  return startsOwnSentence(line, true) ? line : `I'm the ${title}${at}.`;
}

// The salesperson's role as a description must name it: their title from
// Settings, or the default one, with its spacing evened out.
export const roleOf = (salesperson) => String((salesperson && salesperson.title) || DEFAULT_SALESPERSON_TITLE).replace(/\s+/g, ' ').trim();

/**
 * @param {object} args
 *   vehicle:     normalised vehicle (normalize.js)
 *   dealer:      { name, city }
 *   salesperson: { name, title }
 *   priceNote:   the dealer's wording about fees, typed in Settings (a suggested sentence is offered from the website's price gap)
 *   highlights:  the salesperson's pick of the website's features (settleHighlights); null for the usual pick
 *   closingLine: the salesperson's own line from Settings (salesperson.closingLine), used when it passes checkClosingLine
 *   stores:      the salesperson's ticked stores (settings.myStores); a car the website lists at any other store, or
 *                with none or several ticked, is said to be at its own store, never at the dealership in its town
 */
export function buildTemplateDescription({ vehicle: v, dealer = {}, salesperson = {}, priceNote = '', highlights = null, stores = [] }) {
  const dealerName = String(dealer.name || '').trim();
  const city = String(dealer.city || '').trim();
  const store = calmName(carStore(v, { stores, dealer }).store);
  // where the car is: its own store as the website names it, or the dealership in its town
  const lot = store || (dealerName ? `${dealerName}${city ? ' in ' + city : ''}` : '');
  const person = String(salesperson.name || '').trim();
  const title = String(salesperson.title || DEFAULT_SALESPERSON_TITLE).trim();
  const name = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
  const milesText = typeof v.mileage === 'number' ? `${v.mileage.toLocaleString('en-US')} miles` : '';
  const features = settleHighlights(highlights, v.features);
  const closing = usableClosingLine(salesperson.closingLine);
  const mech = [v.engine, v.transmission, v.drivetrain].map((s) => String(s || '').trim()).filter(Boolean);
  const colors = [v.exteriorColor && `${v.exteriorColor} exterior`, v.interiorColor && `${v.interiorColor} interior`].filter(Boolean);

  // keep: 'always' = part of every description; 'optional' = dropped (in
  // order) if the text runs long; 'filler' = added (in order) if it runs short.
  // site: the website's own words for the car, as it writes them.
  const blocks = [
    { id: 'lead', keep: 'always', site: true, text: milesText ? `${name} with ${milesText}.` : `${name}.` },
    { id: 'owner', keep: 'always', text: v.carfaxOneOwner ? 'One owner according to the Carfax report.' : '' },
    { id: 'features', keep: 'always', site: true, text: features.length ? `Highlights: ${features.join(', ')}.` : '' },
    { id: 'colors', keep: 'optional', site: true, text: colors.length ? `${capitalize(colors.join(', '))}.` : '' },
    { id: 'mech', keep: 'optional', site: true, text: mech.length ? `${mech.join(', ')}.` : '' },
    { id: 'where', keep: 'always', text: lot ? `Pre-owned and on the lot at ${lot}.` : '' },
    { id: 'carfax', keep: 'filler', text: v.carfaxUrl ? 'Carfax report available, just ask.' : '' },
    { id: 'stock', keep: 'filler', text: v.stock ? `Stock number ${v.stock}.` : '' },
    { id: 'vin', keep: 'always', text: v.vin ? `VIN ${String(v.vin).toUpperCase().replace(/[^A-Z0-9]/g, '')}.` : '' },
    { id: 'priceNote', keep: 'always', text: String(priceNote || '').trim() },
    // with no dealership name set the checks stop the description; the sign-off still never reads "at ."
    { id: 'signoff', keep: 'always', text: signOffLine(person, title, dealerName) },
    // the salesperson's own closing line takes the place of the stock invitation,
    // which then comes back only when the text runs short (the closing line is not counted)
    { id: 'cta', keep: closing ? 'filler' : 'optional', text: 'Message me to set up a test drive or ask a question.' },
    { id: 'more', keep: 'filler', text: 'Happy to send more photos or answer any questions.' },
    { id: 'visit', keep: 'filler', text: store || dealerName ? `Come take a look in person at ${store || dealerName}.` : '' },
    { id: 'reply', keep: 'filler', text: "Message me here on Marketplace and I'll get right back to you." },
    // the last filler names nothing, so a sparse car at a dealership with a short name still reaches the minimum
    { id: 'see', keep: 'filler', text: 'Let me know a good time to come see it.' },
    // the salesperson's own line ends every description, after any filler
    { id: 'closing', keep: 'always', text: closing },
  ].filter((b) => b.text);

  const on = new Set(blocks.filter((b) => b.keep !== 'filler').map((b) => b.id));
  const render = () => blocks.filter((b) => on.has(b.id)).map((b) => b.text).join('\n');
  // the closing line and the VIN line are not counted, as in runGuardrails
  const words = () => wordCount(stripVin(stripClosing(render(), closing)));

  // A website that writes in capitals ("2015 JEEP GRAND CHEROKEE LIMITED",
  // "HEATED SEATS, NAVIGATION SYSTEM") would make the text shout, which the
  // checks refuse: when the website's own words shout, they are calmed
  // (calmWords), in the description only; the form's fields keep the
  // website's spelling. The car's own abbreviations ("SLE EXT CAB", "AWD")
  // stay as written; the checks pass over them (ownAbbreviations), and so
  // does this test, so they never get the website's other words calmed. A
  // colour or engine line that still shouts on its own is left out; a line
  // that does not is kept, since leaving it out could not help.
  const own = ownAbbreviations(v);
  const siteWords = blocks.filter((b) => b.site).map((b) => b.text).join('\n');
  if (shouting(siteWords, own)) for (const b of blocks) if (b.site) b.text = calmWords(b.text);
  for (const b of blocks) if (b.keep === 'optional' && b.site && shouting(b.text, own)) on.delete(b.id);
  for (const id of ['mech', 'colors', 'cta']) {
    if (words() <= WORD_LIMITS.max) break;
    on.delete(id);
  }
  for (const b of blocks.filter((b) => b.keep === 'filler')) {
    if (words() >= WORD_LIMITS.min) break;
    on.add(b.id);
  }
  return render();
}

// A store name as the website writes it, without shouting: when the name
// is in capitals ("SMITH CHEVROLET SHELBYVILLE"), each word of three or more
// capitals with a vowel is set in title case; an abbreviation with no vowel
// ("GMC", "CDJR") stays as written.
function calmName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!shouting(n)) return n;
  return calmWords(n, 3);
}

// Words in capitals set in title case: each word of `min` or more capital
// letters with a vowel ("GRAND" is "Grand"). Shorter words ("AWD", "XLE"),
// abbreviations with no vowel ("GMC") and words with a digit ("RAV4",
// "F-150") stay as written. Only the description's text is calmed; the
// form's fields keep the website's own spelling.
function calmWords(text, min = 4) {
  return String(text || '').replace(new RegExp(`\\b[A-Z]{${min},}\\b`, 'g'), (w) => (/[AEIOUY]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w));
}

// Three words in capitals in a row, or one long one. A word in `passOver`
// (the car's own abbreviations) neither counts nor breaks a run.
const NOTHING = new Set();
function shouting(text, passOver = NOTHING) {
  const tokens = String(text || '').split(/\s+/);
  let run = 0;
  for (const tok of tokens) {
    const word = tok.replace(/[^A-Za-z]/g, '');
    const caps = word.length >= 3 && word === word.toUpperCase() && !/\d/.test(tok);
    if (caps && passOver.has(word)) continue;
    if (word.length >= 10 && caps) return true;
    run = caps ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

// The car's own abbreviations, as the website writes them for this car: a
// word in capitals whose letters come in runs of three or fewer, or with no
// vowel ("SLE EXT CAB", "AMG GLE", "CR-V EX-L", "AWD", "BLK/GRY", "GMC",
// "CDJR"), in its name, equipment, colours, features, stock number or store.
// Written that way they name the car; they are not shouting, so the shouting
// check passes over them. A longer word in capitals ("GRAND", "HEATED")
// still counts: the template writes those calmly, and a draft that copies
// them as the website writes them shouts.
export function ownAbbreviations(vehicle = {}) {
  const v = vehicle || {};
  const bits = [
    v.name, v.make, v.model, v.trim, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, v.stock, v.location, ...(Array.isArray(v.features) ? v.features : []),
  ];
  const out = new Set();
  for (const bit of bits) {
    if (typeof bit !== 'string') continue;
    for (const tok of bit.split(/\s+/)) {
      const runs = tok.match(/[A-Za-z]+/g) || [];
      const word = runs.join('');
      if (word.length >= 3 && word === word.toUpperCase() && runs.every((r) => r.length <= 3 || !/[AEIOUY]/.test(r))) out.add(word);
    }
  }
  return out;
}

function emojiCount(text) {
  return (String(text || '').match(/\p{Extended_Pictographic}/gu) || []).length;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const phraseRe = (p, { before, after } = {}) => new RegExp((before ? `(?<!${before})` : '') + '\\b' + escapeRe(p).replace(/[\s-]+/g, '[\\s-]+') + '\\b' + (after ? `(?!${after})` : ''), 'i');
const BANNED_RE = BANNED_PHRASES.map((p) => [p, phraseRe(p, BANNED_UNLESS[p])]);
// the same phrases as the dealership's price note may say them (PRICE_NOTE_UNLESS)
const NOTE_BANNED_RE = new Map(BANNED_PHRASES.map((p) => [p, phraseRe(p, { ...BANNED_UNLESS[p], ...PRICE_NOTE_UNLESS[p] })]));
// The phrases a price note may end its fee sentence with, as said anywhere in
// the note (the dealership's own desk or line too: "Ask for Sam, not the
// dealer's front desk." in a note is held to the word list).
const NOTE_STEER_SAID = new Map(Object.keys(PRICE_NOTE_UNLESS).map((p) => [p, phraseRe(p)]));
const NOTE_WORD_SET = new Set(PRICE_NOTE_WORDS);
// a dollar amount or a percentage standing on its own (not "$5551234567", "US$499" or "6.25.7")
const NOTE_AMOUNT = /(?<![\p{L}\p{N}])(?:\$\s?(?:\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.\d{1,2})?|\d{1,3}(?:\.\d{1,3})?\s?%)(?![\p{L}\p{N}]|[.,]\p{N})/gu;
// the marks a note may have between its words: spaces, punctuation, brackets, quotes, dashes, "/", "&", "*" and "+"
const NOTE_MARKS = /^[\s.,;:!?'"\u2018\u2019\u201c\u201d()[\]\-\u2010-\u2015/&*+]$/u;
const NOTE_EDGE_MARKS = /^[.,;:!?'"\u2018\u2019\u201c\u201d()[\]\-\u2010-\u2015/&*+]+|[.,;:!?'"\u2018\u2019\u201c\u201d()[\]\-\u2010-\u2015/&*+]+$/gu;
const NOTE_NUMBER = /\S*\p{N}\S*/gu;
const NOTE_WORD = /\p{L}[\p{L}\p{M}]*(?:['\u2019\u2010-]\p{L}[\p{L}\p{M}]*)*/gu;
// an invisible character: read as nothing, unless it changes the direction of the text
const NOTE_HIDDEN = /\p{Default_Ignorable_Code_Point}/gu;
const NOTE_DIRECTION = /\p{Bidi_Control}/u;
const lettersOf = (s) => String(s ?? '').normalize('NFKC').replace(NOTE_HIDDEN, '').toLowerCase().match(/\p{L}[\p{L}\p{M}]*/gu) || [];
const blank = (s) => ' '.repeat(s.length);
// What a price note says that is not price and fee wording, in the order it
// says it, each once, quoted as it shows: a number that is not an amount or
// a percentage, a word (with its apostrophe or hyphen parts) one of whose
// parts is neither on PRICE_NOTE_WORDS nor in the dealership's name or city,
// any other mark, and, unquoted, "an invisible direction mark". [] when
// there is none.
function noteSteerWords(note, dealer) {
  const d = dealer || {};
  const own = new Set([d.name, d.city].flatMap(lettersOf));
  const found = [];
  let gone = 0;
  let rest = String(note ?? '').normalize('NFKC').replace(NOTE_HIDDEN, (c, at) => {
    if (!NOTE_DIRECTION.test(c)) {
      gone += c.length;
      return '';
    }
    found.push({ at: at - gone, text: 'an invisible direction mark' });
    return ' ';
  });
  rest = rest.replace(NOTE_AMOUNT, blank);
  rest = rest.replace(NOTE_NUMBER, (said, at) => {
    found.push({ at, text: `"${said.replace(NOTE_EDGE_MARKS, '')}"` });
    return blank(said);
  });
  rest = rest.replace(NOTE_WORD, (said, at) => {
    if (!lettersOf(said).every((w) => NOTE_WORD_SET.has(w) || own.has(w))) found.push({ at, text: `"${said}"` });
    return blank(said);
  });
  for (const m of rest.matchAll(/\S/gu)) if (!NOTE_MARKS.test(m[0])) found.push({ at: m.index, text: `"${m[0]}"` });
  const seen = new Set();
  return found.sort((a, b) => a.at - b.at).map((f) => f.text).filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}
const listOf = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]);
// The reason a note that says one of those phrases is refused for its words
// ('' when it is not): the words to take out, or the phrase. The phrase is
// looked for in the note on one line (noteSaid), its words are read in the
// note as written (a byte order mark is a space to oneLine, and nothing on
// the screen).
function noteSteer(phrase, noteSaid, dealer, note = noteSaid) {
  const said = NOTE_STEER_SAID.get(phrase);
  if (!said || !said.test(noteSaid)) return '';
  const words = noteSteerWords(note, dealer);
  return words.length ? `Your price note says "${phrase}", so it may only say where the fees go and what the price includes; take out ${listOf(words)}, or take out "${phrase}". Change the note in Settings.` : '';
}
const noteBanned = (phrase) => `Your dealership's price note says "${phrase}"; change the note in Settings`;
// What the checks say of the price note's "not the dealer", "not the
// dealership" and their plurals, as runGuardrails says it: the phrase where
// the fees do not go, or a word that is not price and fee wording. `notice`
// says the same without the quoted words, so it stays the same while the
// warning stands.
function priceNoteReasons(note, dealer) {
  const said = oneLine(note);
  if (!said) return [];
  const out = [];
  for (const phrase of NOTE_STEER_SAID.keys()) {
    if (NOTE_BANNED_RE.get(phrase).test(said)) out.push({ text: noteBanned(phrase), notice: noteBanned(phrase) });
    else if (noteSteer(phrase, said, dealer, note)) out.push({ text: noteSteer(phrase, said, dealer, note), notice: `Your price note says "${phrase}", so it may only say where the fees go and what the price includes. Take out the other words, or take out "${phrase}".` });
  }
  return out;
}
// The warning set-up and Settings show under the price note ('' for none),
// with the dealership (its name and city) as the form holds it now.
// Plain text. Saving is never held back by it.
export const priceNoteWarning = (note, dealer) => priceNoteReasons(note, dealer).map((r) => r.text).join(' ');
// What a screen reader is told when the warning comes ('' for none).
export const priceNoteNotice = (note, dealer) => priceNoteReasons(note, dealer).map((r) => r.notice).join(' ');
// "one owner", "1-owner", "single-owner", "one careful owner", "one
// careful, loving owner", "one very careful adult owner" (up to three words
// between, a comma after any but the last), "only one previous owner", "its
// sole owner", "its first owner", "owned by one family"; not "One-Touch
// Windows, Owner's Manual"
const ONE_OWNER = /\b(?:(?:one|1|single)[\s-]+(?:(?:(?!(?:new|next|more|other|of|the|a|an|its|your|lucky)\b)[a-z']+,?[\s-]+){0,2}(?!(?:new|next|more|other|of|the|a|an|its|your|lucky)\b)[a-z']+[\s-]+)?owner(?!['\u2019]s[\s-]+(?:manual|guide|handbook|portal|app)\b)|(?:sole|only|first)[\s-]+owner|owned by (?:one|a single))\b/i;

// "Driven by" the engine is what powers the car, not who drove it ("driven
// by a 5.7L HEMI V8", "by the turbocharged engine", "by an electric motor",
// "by a Cummins diesel"): after "by" (and "a", "an", "the" or "its") come
// only engine words, ending on the engine itself ("engine", "motor",
// "powertrain", a size, a cylinder count or an engine's name), and the
// clause stops there or goes on about the engine ("with 395 horsepower",
// "paired with", "and an 8-speed automatic"). Anything else is who drove
// it: "driven by a diesel mechanic", "a HEMI enthusiast", "a V8 lover", "a
// General Motors retiree", "a retired engine builder", "2 retirees".
const ENGINE_NAME = "\\d(?:\\.\\d)?\\s*-?\\s*(?:l|t|liters?|litres?)|v-?\\d{1,2}|i-?\\d|(?:inline|straight|flat)[\\s-]?(?:\\d|four|six)|(?:\\d{1,2}|three|four|five|six|eight|ten|twelve)[\\s-]?cyl(?:inders?)?|\\d+[\\s-]?(?:hp|horsepower)|hemi|ecoboost|ecodiesel|duramax|cummins|power[\\s-]?stroke|pentastar|vortec|ecotec|turbo(?:charged)?|twin[\\s-]turbo(?:charged)?|bi[\\s-]?turbo|supercharged|turbo[\\s-]?diesel|diesel|hybrid|plug[\\s-]in(?:[\\s-]hybrid)?|electric|gas(?:oline)?|flex[\\s-]?fuel|high[\\s-]output";
const ENGINE_WORD = `${ENGINE_NAME}|powerful|proven|legendary|potent|(?:fuel[\\s-])?efficient|reliable|smooth|responsive|capable|strong|robust|peppy|refined|quiet|big|small|dual|twin`;
const ENGINE_ENDS = "(?=\\s*(?:[.,;:!?)\\]\\n\u2013\u2014]|-\\s|$)|\\s+(?:with|paired|mated|making|producing|rated|that|which|and\\s+(?:(?:an?|the)\\s+)?(?:\\d+[\\s-]speed|automatic|manual|transmission|cvt|all[\\s-]wheel|four[\\s-]wheel|awd|4wd|4x4))\\b)";
const DRIVEN_BY_ENGINE = `\\s+(?:(?:a|an|the|its)\\s+)?(?:(?:${ENGINE_WORD})[\\s-]+){0,4}(?:engines?|motors?|powertrains?|${ENGINE_NAME})${ENGINE_ENDS}`;
// The dealership's own "locally owned (and operated) dealership", which is
// about the business, not the car: "locally owned" then "and operated", a
// business ("dealership", "dealer", "business", "company", "store") or both,
// and then the end of the sentence or one of a few words the dealership's
// own wording goes on with ("serving", "since", "in", "located", "here",
// after a comma or not). Any other word after it may be about the car:
// "locally owned dealer trade", "locally owned company pickup", "locally
// owned business owner's truck", "locally owned dealership's trade",
// "locally owned and operated by a retired couple". So may the words before
// it: "traded in by a locally owned company", "belonged to a locally owned
// business", "Locally owned company since new", "A locally owned business;
// one driver". In a description it is the dealership's only when the
// dealership says it of itself, at the start of the sentence or clause:
// "We are", "We're", "We've been", "We have been" or "Our dealership (store,
// business, company) is" or "has been", then up to two of "a", "an",
// "your", "proudly", "still", "also" and "truly" ("We are a locally owned
// dealership."; "We're proudly locally owned and operated."). In the
// website's own words for the car (claimSource), where setting it aside
// backs fewer claims, the words after it are enough, so "<the dealership's
// name> is a locally owned dealership." in a write-up never backs an owner
// story. Every "adult owned" is about the car.
const LOCAL_BUSINESS = "(?:dealer(?:ship)?s?|business(?:es)?|compan(?:y|ies)|stores?)";
const LOCAL_OWNED_WORDS = 'local(?:ly)?[\\s-]owned';
const FOR_THE_BUSINESS = `(?:[\\s-]+(?:and|&)[\\s-]+operated(?:[\\s-]+${LOCAL_BUSINESS})?|[\\s-]+${LOCAL_BUSINESS})(?:\\s*(?:[.;!?)\\n]|$)|,?\\s+(?:serving|since|in|located|here)\\b)`;
const WE_ARE = `(?:^|[.!?;:,(\\n])\\s*(?:we\\s+are|we['\u2019]re|we['\u2019]ve\\s+been|we\\s+have\\s+been|our\\s+(?:dealership|store|business|company)\\s+(?:is|has\\s+been))\\s+(?:(?:a|an|your|proudly|still|also|truly)\\s+){0,2}`;
// as the website's words for the car say it, and as a description says it
const LOCALLY_OWNED = `${LOCAL_OWNED_WORDS}(?!${FOR_THE_BUSINESS})`;
const LOCALLY_OWNED_SAID = `(?:(?<!${WE_ARE})${LOCAL_OWNED_WORDS}|${LOCALLY_OWNED})`;
// who had the car and how it was used, with "locally owned" read one way or the other
const ownerWords = (locallyOwned) => new RegExp(`\\b(?:(?:previous|prior|past|former|original) owners?|(?<!pre[\\s-])owned by|adult[\\s-]owned|${locallyOwned}|driven (?:by(?!${DRIVEN_BY_ENGINE})|only|mostly|mainly|gently|sparingly|carefully)|never driven|drove it (?:to|only|mostly|mainly|gently|sparingly|carefully)|(?:grand(?:ma|mother|pa|father)|granny)['\u2019]s (?:car|truck|suv|van|jeep|vehicle|ride)|(?:adult|gently|lightly|carefully|rarely|barely)[\\s-]driven|babied|pampered|weekend (?:driver|car|cruiser|only)|(?:highway|freeway) miles|one[\\s-]family)\\b`, 'i');

// ---------- claims only the website can make ----------
// What a description says about the car's certification, warranty,
// financing, history, care, parts, condition, owners, use, origin or keys
// comes from the website's own words for this car (its write-up, features
// and the rest of its record) or the dealer's price note, never from the
// writer. Each kind of claim is found by its words, and passes when words
// of the same kind, said the same way, are in those sources: a claim that
// the thing is there ("a full warranty", "one accident reported", "runs
// great") needs the sources to say it is there, and one that it is not ("no
// warranty", "never smoked in", "clean Carfax", "rust-free", "sold as-is")
// needs them to say it is not, so "Sold as-is, no warranty." never backs "a
// full warranty", nor "subject to bank approval" "everyone gets approved"
// (new parts: the sources must say that part is new); certified also passes
// when the website lists the car as certified. Text the whole lot shares (a
// disclaimer, "We are a locally owned dealership.") is not the website's
// words for this car, so it backs nothing. The
// dealership's name, its city and the salesperson's role are not claims
// about the car and are set aside first, as are banned phrases and the
// words of one-owner wording (each flagged on its own; what the wording says
// about the owner is still checked, see ownerStoryProblems). A false
// positive only means the template is used: beyond its own fixed sentences,
// everything the template writes is copied from those sources.
const PARTS = "tires?|tyres?|brakes?|rotors?|pads|battery|batteries|wipers?|shocks?|struts?|exhaust|alternator|starter|clutch|timing (?:belt|chain)|water pump|engine|motor|transmission|paint|parts";
export const CLAIM_KINDS = Object.freeze([
  { what: 'certification', re: /\b(?:certified|cpo)\b/i },
  { what: 'a warranty or guarantee', re: /\b(?:warrant(?:y|ies|eed)|guarantee[ds]?|(?<!air[\s-]?bags?[\s-])coverage|protection plans?|service contracts?|as[\s-]is)\b/i },
  { what: 'financing', re: /\b(?:financ\w*|loans?|lenders?|apr|down[\s-]payments?|monthly payments?|per month|lease\w*|buy[\s-]here)\b/i },
  // credit and approval, apart from financing: "subject to bank approval" or "with approved credit" says approval is not given, so it never backs "everyone gets approved" or "all credit types"
  { what: 'credit or approval', re: /\b(?:credit|approv\w*)\b/i, hedge: /\b(?:subject to\b[^.!?;\n]{0,40}\b(?:approval|credit)|(?:with|on|upon) approved credit|upon (?:credit |lender |bank )?approval|if (?:you(?:'re| are) )?approved|approval (?:is )?required)\b/i },
  { what: 'accident, damage or title history', re: /\b(?:accidents?|collisions?|wreck(?:s|ed)?|damaged?|flood\w*|salvage|rebuilt|titles?|clean (?:carfax|autocheck|history|record|report))\b/i },
  { what: 'smoking or pets', re: /\b(?:non[\s-]?smok\w*|smok(?:er|ers|ing|ed)|smoke[\s-]?free|pet[\s-]?free|no pets)\b/i },
  { what: 'service history, inspection or upkeep', re: /\b(?:inspect\w*|serviced|service (?:history|records?)|records|maintenance|maintained|oil changes?|tune[\s-]?up|reconditioned|(?:fully|freshly|just|professionally|recently) detailed|garage[\s-]kept|garaged|well[\s-](?:kept|cared)|taken care of)\b/i },
  { what: 'new or replaced parts', re: new RegExp(`\\b(?:(?:brand[\\s-])?new|newer|fresh|replaced|recent)\\s+(?:(?:set of|[\\w-]+)\\s+){0,2}?(${PARTS})\\b`, 'i'), part: true },
  { what: 'its condition', re: /\b(?:(?:excellent|great|good|pristine|immaculate|showroom|top|amazing|beautiful|clean) (?:condition|shape)|runs (?:great|strong|well|smooth\w*|excellent)|drives (?:great|well|smooth\w*|excellent)|mechanically sound|needs nothing|turn[\s-]?key|rust[\s-]free|no (?:rust|dents|problems))\b/i },
  // who had it and how it was used ("one owner" has its own check, against the Carfax flag; "Pre-owned" is not a claim)
  // (sourceRe: the same kind in the website's own words, where only the words after "locally owned" decide that it is the dealership's)
  { what: 'its owners or how it was driven', re: ownerWords(LOCALLY_OWNED_SAID), sourceRe: ownerWords(LOCALLY_OWNED) },
  { what: 'where it came from', re: /\b(?:local(?:ly)? trade[ds]?|traded in locally|(?:came|taken|took) in on trade|on trade from|trade[\s-]in from|lease returns?|off[\s-]lease)\b/i },
  { what: 'its keys', re: /\b(?:(?:both|spare|extra|second|two|2|three|3|(?:sets?|pairs?) of) (?:keys|key[\s-]?fobs|fobs|remotes)|(?:spare|extra|second) (?:key|key[\s-]?fob|fob|remote))\b/i },
]);

// The write-up as the website shows it (description.js splitSegments):
// split at its line breaks, paragraphs and list items, markup set aside,
// entities decoded, spacing made plain, and without the lot-wide text the
// scan found (description.js withoutLotWide). A claim a draft makes from
// "new <b>tires</b>" is then found in its own source, and one only a
// disclaimer every car carries makes is not.
function writeUpText(raw, boilerplate) {
  if (typeof raw !== 'string') return raw;
  return withoutLotWide(raw, lotWideLines(boilerplate)).join('\n');
}
// the scan's lot-wide lines, as a list or a set, read as the write-up's
// lines are (a line saved before entities were decoded still matches);
// anything else is none
const lotWideLines = (b) => [...plainLotWide(b)];

// The website's own words for this car, where its claims may come from.
function claimSource({ vehicle = {}, priceNote = '', boilerplate = [] }) {
  const v = vehicle;
  const bits = [
    v.year, v.make, v.model, v.trim, v.name, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, writeUpText(v.descriptionRaw, boilerplate), ...(Array.isArray(v.features) ? v.features : []), priceNote,
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

// The text with the given names (the dealership, its city, the car's store, the role) set aside.
function without(text, names) {
  let out = String(text || '');
  for (const n of names) {
    const name = oneLine(n);
    if (name) out = out.replace(new RegExp(escapeRe(name).replace(/ /g, '\\s+'), 'gi'), ' ');
  }
  return out;
}

// The text with only the copies of the price note set aside that stand as a
// sentence of their own where the text puts them, as the template puts the
// note: after the start of the text or a sentence's end (".", "!" or "?",
// maybe a closing quote or bracket, then a space or a new line; never the dot
// of "e.g.", "i.e.", "eg.", "ie.", "vs.", "cf.", "viz.", "incl.", "excl.",
// "esp." or "approx."; "etc." may end one), and before the end of the text
// or a new sentence (a stop, the note's own last one or one right after it,
// or else a new line; then a space or a new line and a sentence that does not
// carry the note's one on: startsOwnSentence). A line break alone ends no
// sentence ("..., and" at the end of a line carries on), and a copy that
// starts in lower case where the note does not ("etc. tax, title and fees go
// ...") carries one on; a note the dealership starts in lower case may start
// a line after a stop. Any other copy has words joined to it in its sentence
// ("Taxes are lower when you deal direct, and tax, title and fees go to the
// state, not the dealer."; "..., not the dealer, so deal direct with the
// salesperson."; "Price note: ..."; "Plus tax, title ...") and stays in the
// text.
const NOTE_CLOSERS = "['\"\u2019\u201d)\\]]*";
const NOTE_OPENS = new RegExp(`(?<=(^|[.!?]${NOTE_CLOSERS})(\\s*))`, 'y');
const NOTE_ENDS = new RegExp(`((?:[^\\S\\n]*[.!?]+)?)${NOTE_CLOSERS}(\\s*)`, 'y');
const NOTE_OWN_STOP = new RegExp(`[.!?]${NOTE_CLOSERS}$`);
const NOT_A_STOP = new RegExp(`(?:^|[\\s(\\[{"'\u2018\u201c])(?:e\\.g|i\\.e|eg|ie|vs|cf|viz|incl|excl|esp|approx)\\.${NOTE_CLOSERS}\\s*$`, 'iu');
// What follows a sentence's end starts a sentence of its own unless it
// carries that one on: it starts with a mark that joins (a comma, semicolon,
// colon, dot or ellipsis, dash, "&", "+", "/" or a closing bracket), or its
// first letter, past any opening bracket, quote, emoji or line with no letter,
// is in lower case ("(so deal direct ...)"). At the start of a line, a bullet
// ("- ", "* ", "• ", "– ", "— ") may come first.
const CARRIES_ON = /^[,;:.\u2026&+/)\]}\-\u2010-\u2015]/;
const LINE_BULLET = /^[-*\u2022\u2013\u2014][^\S\n]+(?=\S)/;
function startsOwnSentence(rest, onNewLine) {
  const r = onNewLine ? rest.replace(LINE_BULLET, '') : rest;
  if (CARRIES_ON.test(r)) return false;
  const first = r.match(/[\p{L}\p{N}]/u);
  return !first || !/\p{Ll}/u.test(first[0]);
}
function withoutOwnSentenceNote(text, note) {
  const t = String(text || '');
  const said = oneLine(note);
  if (!said) return t;
  const at = (re, i) => { re.lastIndex = i; return re.exec(t); };
  const lower = (s) => /^\p{Ll}/u.test(s);
  let out = '';
  let from = 0;
  for (const m of t.matchAll(new RegExp(escapeRe(said).replace(/ /g, '\\s+'), 'gi'))) {
    const end = m.index + m[0].length;
    const before = at(NOTE_OPENS, m.index);
    const opens = Boolean(before) && (before[1] === '' || before[2] !== '') && !NOT_A_STOP.test(t.slice(0, m.index))
      && (!lower(m[0]) || (lower(said) && (before[1] === '' || before[2].includes('\n'))));
    const after = opens ? at(NOTE_ENDS, end) : null;
    const next = after ? end + after[0].length : -1;
    const stopped = Boolean(after) && (after[1] !== '' || NOTE_OWN_STOP.test(m[0]));
    const ends = Boolean(after) && (next >= t.length
      || (after[2] !== '' && (stopped || after[2].includes('\n')) && startsOwnSentence(t.slice(next), after[2].includes('\n'))));
    if (!ends) continue;
    out += `${t.slice(from, m.index)} `;
    from = end;
  }
  return out + t.slice(from);
}

// The parts a text says are new or replaced, each with the words that say
// so: "new tires", "new Michelin tires", "a new set of tires", "replaced
// brakes", and in the website's own words each part listed after one with a
// comma, "and", "&" or "plus" ("new tires, brakes and rotors").
const LISTED_PARTS = new RegExp(`^(?:\\s*,\\s*(?:and\\s+|&\\s+)?|\\s+(?:and|&|plus)\\s+)(?:(?:front|rear)\\s+)?(${PARTS})\\b`, 'i');
const partKey = (part) => oneLine(part).toLowerCase().replace(/(?:ies|ys|s|y)$/, '');
function newPartsSaid(text, re, more) {
  const t = String(text ?? '');
  const out = [];
  for (const m of t.matchAll(new RegExp(re.source, 'gi'))) {
    out.push({ said: m[0], part: partKey(m[1]) });
    let end = m.index + m[0].length;
    for (let next = more.exec(t.slice(end)); next; next = more.exec(t.slice(end))) {
      end += next[0].length;
      out.push({ said: t.slice(m.index, end), part: partKey(next[1]) });
    }
  }
  return out;
}

// In the text checked (a draft, an edit, the template), the list after a
// "new <part>" claim is followed across commas, "and", "&", "/", "+" and
// "plus" (LIST_JOIN): each next item that is a part on its own (LIST_ITEM:
// maybe after "the", "a", "an" or "both", "new" or "brand new", and "front",
// "rear", "front and rear" or "front/rear"; "brake pads" and "brake rotors"
// are one part each, LIST_TAIL) is claimed too, and the list stops at the
// first item that is anything else (a spec or brand word before a part,
// "HEMI engine", "automatic transmission", "Bosch wipers", is not a part on
// its own; nor are two parts with nothing between them, "tires brakes"). The
// list never goes on past a line break, apart from the join "and", "&" or
// "plus" with spaces around it, which crossed one before the list was read
// ("New tires\nand brakes"), so the next line that starts with a part ("New
// tires\nBrakes, rotors and pads were inspected.") is not on it. A
// listed part followed by words about its state ("inspected", "checked",
// "serviced", "look(s)", "good", "in good shape", "original", maybe after
// "is", "are", "were", "have been" and the like: LIST_STATE) is not claimed,
// and the list stops there; followed by a newness word ("were replaced",
// "are brand new", "installed", "put on", "done", "just", "recently") or by
// anything else, it is. After a comma alone, an item that is one of the car's
// own features as the website writes it ("Brake Assist", "Battery Saver",
// "Wipers - Rain Sensing"; without regard to case or spacing) is that
// feature, not a claim, and the list goes on past it: the highlights line
// lists the website's features with commas ("New Tires, Brake Assist"). A
// claim inside one of the car's features as the website writes it ("New
// Tires/Brakes", "New Brake Pads & Rotors") is the website's own words, so
// the template's highlights line passes its own check. An item that says
// "new" itself is quoted from its "new" ("new brakes"); any other from the
// start of the list.
const LIST_JOIN = /^(?:[^\S\n]*,[^\S\n]*(?:(?:and|plus)[^\S\n]+|[&+/][^\S\n]*)?|[^\S\n]*[&+/][^\S\n]*|\s+(?:and|&|plus)\s+)/i;
const ONLY_A_COMMA = /^[^\S\n]*,[^\S\n]*$/;
const SP = '[^\\S\\n]'; // a space that is not a line break
const LIST_ITEM = new RegExp(`^(?:(?:the|a|an|both)${SP}+)?((?:brand(?:${SP}|-)+)?new${SP}+)?(?:(?:front${SP}*(?:and|&|\\/)${SP}*rear|rear${SP}*(?:and|&|\\/)${SP}*front|front|rear)${SP}+)?(${PARTS})\\b(?:(?<=brakes?)${SP}+(?:pads|rotors?)\\b)?`, 'i');
const BRAKE = /^brakes?$/i;
const LIST_TAIL = new RegExp(`^${SP}+(?:pads|rotors?)\\b`, 'i');
const LIST_STATE = new RegExp(`^${SP}+(?:(?:is|are|was|were|has|have|had|been|got|all|both|also)${SP}+){0,3}(?:inspected|checked|serviced|looks?|good|in${SP}+good${SP}+shape|original)\\b`, 'i');
const ITEM_NEW = /(?:brand[\s-]+)?new\b/i;
// where a feature written in the text ends: a mark that ends or joins an item, the end of the line, "and" or "plus"
const FEATURE_ENDS = "(?=[^\\S\\n]*(?:[,.;:!?&+/)\\]}\"'\u2019\u201d\u2026\\n]|$)|\\s+(?:and|plus)\\b)";
// Where the car's own features stand in the text, as the website writes them: [start, end] pairs.
function featureSpans(t, features) {
  const own = [...new Set((Array.isArray(features) ? features : []).filter((f) => typeof f === 'string').map((f) => oneLine(f).toLowerCase()).filter(Boolean))];
  if (!own.length) return [];
  const alt = own.sort((a, b) => b.length - a.length).map((f) => escapeRe(f).replace(/ /g, '\\s+')).join('|');
  return [...t.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})${FEATURE_ENDS}`, 'giu'))].map((m) => [m.index, m.index + m[0].length]);
}
function newPartsListed(text, re, features) {
  const t = String(text ?? '');
  let spans = null;
  const featuresIn = () => (spans = spans || featureSpans(t, features));
  const out = [];
  for (const m of t.matchAll(new RegExp(re.source, 'gi'))) {
    let end = m.index + m[0].length;
    const whole = featuresIn().find(([a, b]) => a <= m.index && b >= end);
    if (whole) end = whole[1];
    else {
      out.push({ said: m[0], part: partKey(m[1]) });
      const tail = BRAKE.test(m[1]) && LIST_TAIL.exec(t.slice(end));
      if (tail) end += tail[0].length;
    }
    for (let join = LIST_JOIN.exec(t.slice(end)); join; join = LIST_JOIN.exec(t.slice(end))) {
      const at = end + join[0].length;
      const feature = ONLY_A_COMMA.test(join[0]) && featuresIn().find(([a]) => a === at);
      if (feature) {
        end = feature[1];
        continue;
      }
      const item = LIST_ITEM.exec(t.slice(at));
      if (!item) break;
      const itemEnd = at + item[0].length;
      if (LIST_STATE.test(t.slice(itemEnd))) break;
      out.push({ said: t.slice(item[1] ? at + item[0].search(ITEM_NEW) : m.index, itemEnd), part: partKey(item[2]) });
      end = itemEnd;
    }
  }
  return out;
}

// Whether a claim says the thing is not there: its own words deny it ("no
// pets", "non-smoker", "never driven", "rust-free", "clean Carfax", "as-is"),
// a denying word comes up to four words before it in its clause ("no
// warranty", "does not come with a warranty", "without any accidents",
// "no warranty or guarantee"), it is followed by one ("warranty: none",
// "warranty not included", "damage-free", "warranty expired"), or, for
// credit and approval, its sentence makes approval a condition ("subject to
// bank approval").
const DENIES_ITSELF = /^(?:no|non|never|zero)\b|^non[\s-]?|[\s-]free$|^clean\b|^as[\s-]is$/i;
const DENYING_WORD = /^(?:no|not|never|without|none|nor|zero|cannot|lacks?|lacking|excludes?|excluding|except|\w+n['\u2019]t)$/i;
const DENIED_AFTER = /^(?:none|not|n\/a|expired|void(?:ed)?|excluded|unavailable|\w+n['\u2019]t)$/i;
function denies(text, at, said, kind) {
  if (DENIES_ITSELF.test(said)) return true;
  const before = text.slice(Math.max(0, at - 80), at).split(/[.,;:!?\n]|\b(?:and|but|however|although|though|while)\b/i).pop();
  const word = (w) => w.replace(/^[^\w]+|[^\w'\u2019]+$/g, '');
  if (before.split(/\s+/).map(word).filter(Boolean).slice(-4).some((w) => DENYING_WORD.test(w))) return true;
  const after = text.slice(at + said.length, at + said.length + 40);
  if (/^[\s-]*free\b/i.test(after)) return true;
  if (after.split(/[.,;!?\n]|\b(?:and|but|or)\b/i)[0].split(/[\s:]+/).map(word).filter(Boolean).slice(0, 2).some((w) => DENIED_AFTER.test(w))) return true;
  if (!kind.hedge) return false;
  const start = Math.max(text.lastIndexOf('.', at), text.lastIndexOf('!', at), text.lastIndexOf('?', at), text.lastIndexOf(';', at), text.lastIndexOf('\n', at)) + 1;
  const end = text.slice(at).search(/[.!?;\n]/);
  return kind.hedge.test(text.slice(start, end < 0 ? text.length : at + end));
}
// Each claim of a kind in a text, with whether it says the thing is not there
// (in the website's own words, read with the kind's sourceRe when it has one).
const mentions = (text, kind, re = kind.re) => [...String(text).matchAll(new RegExp(re.source, 'gi'))].map((m) => ({ said: m[0], denied: denies(String(text), m.index, m[0], kind) }));

// Every claim in the text, not only the first of each kind: one part the
// website says is new ("new tires") never covers another the text adds
// ("new brakes"), and a part the website only names ("ABS Brakes", "Remote
// Engine Start") is not one it says is new. Each kind the sources don't
// make is said once; each new part they don't say is new is said once.
function claimProblems(text, ctx) {
  const source = claimSource(ctx);
  const lotWide = lotWideText(ctx);
  const problems = [];
  for (const kind of CLAIM_KINDS) {
    if (kind.what === 'certification' && listedCertified(ctx.vehicle)) continue;
    if (kind.part) {
      const said = new Set();
      // a part passes only when the website's own words say that part is new: naming it ("ABS Brakes") is not enough
      const named = new Set(newPartsSaid(source, kind.re, LISTED_PARTS).map((p) => p.part));
      for (const p of newPartsListed(text, kind.re, ctx.vehicle && ctx.vehicle.features)) {
        if (named.has(p.part) || said.has(p.part)) continue;
        said.add(p.part);
        problems.push({ code: 'unsupported-claim', text: `Says "${p.said}", but the website says nothing about ${kind.what} for this car` });
      }
      continue;
    }
    // the website says it is there, that it is not, or both: a claim of either kind needs the website to say the same
    const sourced = new Set(mentions(source, kind, kind.sourceRe).map((x) => x.denied));
    const m = mentions(text, kind).find((x) => !sourced.has(x.denied));
    if (!m) continue;
    let why = `the website says nothing about ${kind.what} for this car`;
    if (sourced.size) why = `the website does not say the same about ${kind.what} for this car`;
    else if (mentions(lotWide, kind, kind.sourceRe).length) why = `the website mentions ${kind.what} only in text it shows with every car, never about this car`;
    problems.push({ code: 'unsupported-claim', text: `Says "${m.said}", but ${why}` });
  }
  return problems;
}

// The lot-wide text this car's write-up carries, which backs no claim (claimSource
// leaves it out); a problem names it, so the salesperson sees why the
// website's "Financing for all credit types" under every car is not enough.
function lotWideText({ vehicle = {}, boilerplate = [] }) {
  if (typeof vehicle.descriptionRaw !== 'string') return '';
  const raw = splitSegments(vehicle.descriptionRaw).join('\n');
  return lotWideLines(boilerplate).filter((p) => typeof p === 'string' && p.trim() !== '' && raw.includes(p)).join('\n');
}

// One-owner wording on a one-owner car. The Carfax flag gives the count of
// owners and nothing more, so the wording's own words ("one", "owner",
// "owned by one", "sole", "first") are held to the flag and set aside before
// the claim check, but what it says between "one" and "owner" stays: "one
// damage-free owner" is checked as damage history, and "one adult owner",
// "one retired teacher owner" or "one careful owner" as owner history the
// website's own words must tell too ("adult owner" in the write-up).
// "previous", "prior", "original" and the like only restate the count.
const ONE_OWNER_ALL = new RegExp(ONE_OWNER.source, 'gi');
const OWNER_COUNT_WORDS = /^(?:previous|prior|original|registered|recorded|reported|listed|carfax|autocheck)$/i;
const betweenOneAndOwner = (said) => (String(said).match(/^(?:one|1|single)[\s-]+(.*?)[\s-]*owner$/i) || [])[1] || '';
const withoutOneOwner = (text) => String(text).replace(ONE_OWNER_ALL, (said) => ` ${betweenOneAndOwner(said)} `);
// After "owned by one" or "owned by a single", the words that say who, up
// to the first word that only carries the sentence on ("owned by one
// retired teacher", "a single careful driver", "one family since new");
// "family", "person", "driver" and the like only restate the count.
const STORY_ENDS = /^(?:since|from|for|and|or|but|with|in|on|at|who|that|which|until|to|of|the|a|an|its|it|this)$/i;
const COUNT_NOUNS = /^(?:family|families|household|owner|person|individual|party|driver|buyer|customer)$/i;
function ownerStory(text, m) {
  if (!/^owned by/i.test(m[0])) return { said: m[0], words: betweenOneAndOwner(m[0]).split(/[\s,-]+/).filter((w) => w && !OWNER_COUNT_WORDS.test(w)) };
  const tail = (String(text).slice(m.index + m[0].length).match(/^(?:[\s-]+[a-z'\u2019]+){1,4}/i) || [''])[0];
  const words = [];
  for (const w of tail.split(/[\s-]+/).filter(Boolean)) {
    if (STORY_ENDS.test(w)) break;
    words.push(w);
  }
  return { said: `${m[0]} ${words.join(' ')}`, words: words.filter((w) => !COUNT_NOUNS.test(w) && !OWNER_COUNT_WORDS.test(w)) };
}
function ownerStoryProblems(text, source) {
  const problems = [];
  const said = new Set();
  for (const m of String(text).matchAll(ONE_OWNER_ALL)) {
    const { said: wording, words } = ownerStory(text, m);
    const story = words.join(' ').toLowerCase();
    // a word of another kind ("damage-free", "non-smoking") is that kind's claim, checked with the rest
    if (!story || said.has(story) || CLAIM_KINDS.some((k) => k.re.test(story))) continue;
    // the website tells the same story: "one careful, loving owner", "adult owned", "owned by a retired teacher"
    const phrase = words.map(escapeRe).join('[\\s,-]+');
    if (new RegExp(`\\b${phrase}[\\s,-]+(?:[a-z']+[\\s-]+)?own(?:er|ed)\\b|\\bowned by (?:(?:one|a single|a|an)[\\s-]+)?${phrase}\\b`, 'i').test(source)) continue;
    said.add(story);
    problems.push({ code: 'unsupported-claim', text: `Says "${oneLine(wording)}", but the website says nothing about its owners or how it was driven for this car` });
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

// ---------- numbers typed into Settings ----------
// The sign-off says the salesperson's role and name, and every description
// names the dealership, so a number typed into one of them is in every
// description, and the checks hold every number, price and mileage in it to
// the website's data for the car. A digit in the role or the name ("2nd
// shift sales") is in nearly no car's data, and a dealership name that reads
// as a price or a mileage ("8 Mile Auto") is nearly never the listing's:
// either keeps the Marketplace form shut. The description still fails; the
// reason names the setting, what it says and a way to write it
// (settingNumberProblems in runGuardrails), and set-up and Settings warn as
// soon as the field holds such a number (settingNumberWarning). The digits of
// a dealership's name alone ("1st Choice Auto") pass: the name is among the
// facts the number check reads (sourceNumbers), with its city and ZIP, so a
// role or a name whose numbers those hold passes too. Not covered: the
// dealership's city and the store the website lists the car at
// (vehicle.location) are in the description as well, and one that reads as a
// mileage ("100 Mile House") fails the mileage check with the plain reason,
// which does not name it. The city must match Marketplace's location
// suggestions, so there is no other way of writing it to offer.
const SMALL_NUMBERS = Object.freeze(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']);
const ORDINAL_WORDS = Object.freeze(['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth']);
// The value with each number up to twenty, or "1st" to "20th", written as a
// word: "2nd shift sales" is "Second shift sales", "Team 3 Sales" is "Team
// Three Sales". The word takes a capital at the start of the value, or where
// the word after it has one, or, with no word after it, where the word
// before it has one ("Sales Associate 2" is "Sales Associate Two"). Only a
// number that stands as a word of its own is written: after the start, a
// space or an opening bracket or quote, and before the end, a space, a
// closing bracket or quote, a comma, a semicolon, "!" or "?", or a stop or a
// colon that ends the value or comes before a space. '' when a number is left
// that no word stands in for ("24/7", "Route19", "#1", "$0", "0%", "2.0").
const NUMBER_ALONE = /(?<=^|[\s(\[{"'\u2018\u201c])(\d{1,2})(st|nd|rd|th)?(?=$|[\s)\]}"'\u2019\u201d,;!?]|[.:](?:\s|$))/gi;
const startsUpper = (c) => Boolean(c) && c !== c.toLowerCase();
export function numbersAsWords(value) {
  const v = oneLine(value);
  const out = v.replace(NUMBER_ALONE, (said, n, nth, at) => {
    const word = (nth ? ORDINAL_WORDS : SMALL_NUMBERS)[Number(n)];
    if (!word) return said;
    const before = v.slice(0, at);
    if (!/[\p{L}\p{N}]/u.test(before)) return capitalize(word);
    const next = /^[^\p{L}\p{N}]*(\p{L})/u.exec(v.slice(at + said.length));
    const prev = /(\p{L})\p{L}*[^\p{L}\p{N}]*$/u.exec(before);
    return startsUpper(next ? next[1] : prev && prev[1]) ? capitalize(word) : word;
  });
  return /\d/.test(out) ? '' : out;
}
// The name without its number, offered only where taking the number out
// leaves the rest of the name as typed (it goes into the sign-off of every
// listing once copied): digits inside a word, after a letter ("Sam2" is
// "Sam", "J2 Smith" is "J Smith"), a number that is a word of its own at the
// end of the name ("Sam 2", "Sam 2nd"), or one in brackets or quotes of its
// own anywhere ("Sam (2)", "Sam (2) Smith"). '' for any other number: one
// among the name's words may belong to them ("Sam 2nd shift" is not "Sam
// shift", "Sam (Store 2)" is not "Sam (Store"), and one with another sign at
// it ("Sam-2", "Sam #2", "24/7", "2.0", "Sam, 2") leaves the sign behind.
// '' too for what has no letter, or brackets or quotes left unpaired.
const NTH = '\\d+(?:st|nd|rd|th)?';
const BARE_NUMBER = new RegExp(`^${NTH}$`, 'i');
const OWN_BRACKETS = new RegExp(`^(?:\\(${NTH}\\)|\\[${NTH}\\]|\\{${NTH}\\}|"${NTH}"|'${NTH}'|\u2018${NTH}\u2019|\u201c${NTH}\u201d)$`, 'i');
const AFTER_A_LETTER = /(?<=\p{L})\d+(?:(?:st|nd|rd|th)(?!\p{L}))?/giu;
const timesIn = (text, c) => text.split(c).length - 1;
const paired = (text) => [['(', ')'], ['[', ']'], ['{', '}'], ['\u201c', '\u201d']].every(([a, b]) => timesIn(text, a) === timesIn(text, b)) && timesIn(text, '"') % 2 === 0;
export function nameWithoutNumber(value) {
  const words = oneLine(value).split(' ');
  const kept = [];
  for (const [i, word] of words.entries()) {
    if (!/\d/.test(word)) kept.push(word);
    else if (OWN_BRACKETS.test(word) || (BARE_NUMBER.test(word) && i === words.length - 1)) continue;
    else {
      const left = word.replace(AFTER_A_LETTER, '');
      if (/\d/.test(left)) return '';
      kept.push(left);
    }
  }
  const out = kept.join(' ');
  return /\p{L}/u.test(out) && paired(out) && /[\p{L}.)\]}"'\u2019\u201d]$/u.test(out) ? out : '';
}
const SETTING_WORDS = Object.freeze({
  role: Object.freeze({ your: 'Your role', field: 'Your role', example: numbersAsWords, otherwise: 'write the number as a word or leave it out' }),
  name: Object.freeze({ your: 'Your name', field: 'Your name', example: nameWithoutNumber, otherwise: 'leave the number out' }),
  dealer: Object.freeze({ your: "Your dealership's name", field: 'Dealership name', example: numbersAsWords, otherwise: 'write the number as a word' }),
});
// The way to write the value that the reason and the warning offer ('' for
// none): offered only when the sign-off written with it gives the checks no
// problem the sign-off with the plain role gives none of ("1 owner car
// specialist" written "One owner car specialist" says one owner, which only
// the Carfax flag may say). The example holds no digit, so checking it never
// comes back here.
const EXAMPLE_SLOT = Object.freeze({ role: 'title', name: 'person', dealer: 'dealerName' });
function signOffCodes(slot) {
  const s = { person: '', title: DEFAULT_SALESPERSON_TITLE, dealerName: '', ...slot };
  const g = runGuardrails(signOffLine(s.person, s.title, s.dealerName), { salesperson: { name: s.person, title: s.title }, dealer: { name: s.dealerName } });
  return new Set(g.problems.map((p) => p.code));
}
function exampleOf(setting, value) {
  const v = oneLine(value);
  const example = SETTING_WORDS[setting].example(v);
  if (!example || example === v) return '';
  const plain = signOffCodes({});
  return [...signOffCodes({ [EXAMPLE_SLOT[setting]]: example })].every((code) => plain.has(code)) ? example : '';
}
// The reason a description fails because of a number in one of these settings.
function settingNumberText(setting, value) {
  const w = SETTING_WORDS[setting];
  const example = exampleOf(setting, value);
  const how = example ? `, for example to "${example}"` : `: ${w.otherwise}`;
  const why = setting === 'dealer'
    ? 'reads as a price or a mileage, and every price and mileage in a description must match the listing'
    : "has a number in it, and every number in a description must match the website's data for the car";
  return `${w.your} "${value}" ${why}; change it in Settings (${w.field})${how}`;
}
// The text with each value set aside where it stands as words of its own:
// "Sam 2" in "I'm Sam 2, ...", never the "2" of "12,000", "2,000" or "2.5".
// A value with no letter ("2") can't be told from the description's own
// numbers ("Seats 2 rows"), so it is set aside only where the text says it
// once (the sign-off), after the values with letters; said again, it stays,
// and the plain reason stands.
const asWords = (value) => new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[.,])${escapeRe(value).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}]|[.,]\\p{N})`, 'giu');
const hasLetter = (value) => /\p{L}/u.test(value);
const setAside = (text, values) => [...values].sort((a, b) => Number(hasLetter(b)) - Number(hasLetter(a))).reduce((out, value) => {
  const re = asWords(value);
  return !hasLetter(value) && (out.match(re) || []).length > 1 ? out : out.replace(re, ' ');
}, text);
// The settings a description says (the role, the salesperson's name, the
// dealership's name) that hold a number, given the number checks (check):
// the problems the text no longer gives with them all set aside (gone), and
// one problem for each setting that, with the others set aside, still gives
// one of those. Nothing is set aside when no setting is to blame, so a
// problem never goes without a reason in its place.
function settingNumberProblems(prose, check, { role, name, dealerName }) {
  const none = { problems: [], gone: new Set() };
  const settings = [['role', oneLine(role)], ['name', oneLine(name)], ['dealer', oneLine(dealerName)]].filter(([, value]) => /\d/.test(value));
  if (!settings.length) return none;
  const said = (text) => new Set(check(text).map((p) => p.text));
  const aside = (list) => said(setAside(prose, list.map(([, value]) => value)));
  const rest = aside(settings);
  const gone = new Set([...said(prose)].filter((t) => !rest.has(t)));
  if (!gone.size) return none;
  const blamed = settings.filter((s) => {
    const alone = aside(settings.filter((o) => o !== s));
    return [...gone].some((t) => alone.has(t));
  });
  if (!blamed.length) return none;
  return { problems: blamed.map(([setting, value]) => ({ code: 'setting-number', text: settingNumberText(setting, value) })), gone };
}

// The warning set-up and Settings show under the role, the name or the
// dealership's name while it holds a number that keeps the form shut: a
// digit in the role or the name, unless the dealership's name, city and ZIP
// (dealer, as the form holds them now) hold every number in it, which the
// number check reads as facts, and it reads as neither a price nor a mileage;
// a dealership name only when it reads as a price or a mileage. `text` quotes
// the number and a way to write the value, so it follows every key; `notice`
// says the same without them, so it stays the same while the warning stands.
// null for no warning. Plain text.
function settingWarning(setting, value, dealer = {}) {
  const v = oneLine(value);
  const w = SETTING_WORDS[setting];
  if (!w || !/\d/.test(v)) return null;
  if (setting !== 'dealer') {
    const facts = sourceNumbers({ dealer: dealer || {} });
    const amounts = [...mileageClaims(v), ...dollarAmounts(v)];
    if (!amounts.length && [...numbersIn(v)].every((n) => facts.has(n))) return null;
  }
  const example = exampleOf(setting, v);
  const like = example ? `, for example "${example}"` : '';
  if (setting === 'dealer') {
    const said = [...mileageClaims(v), ...dollarAmounts(v)];
    if (!said.length) return null;
    const say = (quote, eg) => `The dealership's name reads as a price or a mileage${quote}, which keeps the Marketplace form shut for nearly every car: every price and mileage in a description must match the listing. Write the number as a word${eg}.`;
    return { text: say(` ("${said[0].text}")`, like), notice: say('', '') };
  }
  const numbers = (v.match(/\S*\d\S*/g) || []).map((s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const advice = setting === 'role' ? 'Write the number as a word or leave it out' : 'Leave it out';
  const say = (quote, eg) => `A number in your ${setting}${quote} keeps the Marketplace form shut for nearly every car: every number in a description must match the website's data for the car. ${advice}${eg}.`;
  return { text: say(` (${numbers.map((n) => `"${n}"`).join(', ')})`, like), notice: say('', '') };
}
// The warning shown under the field ('' for none).
export const settingNumberWarning = (setting, value, dealer) => (settingWarning(setting, value, dealer) || { text: '' }).text;
// What a screen reader is told when the warning comes ('' for none): the
// warning without the number and the example, which change as the person
// types, so a live region written with it is spoken once, not on every key.
export const settingNumberNotice = (setting, value, dealer) => (settingWarning(setting, value, dealer) || { notice: '' }).notice;

// The problems a person may still post with: the length and the tone. Every
// other problem (a number, price, mileage or claim the website doesn't make,
// a banned phrase, one owner without the Carfax flag, a missing dealership,
// role, VIN or price note, a price note for another fee, and the same in the
// salesperson's closing line) keeps the side panel from filling the form
// until the description is fixed (ruleProblems), and a new kind of problem
// does too until it is added here.
export const STYLE_PROBLEMS = Object.freeze(['too-short', 'too-long', 'all-caps', 'emoji', 'closing-too-long', 'closing-caps', 'closing-emoji']);

/**
 * Checks a description against the source data. Returns { ok, problems, words }.
 * Every problem has a code and a short plain-English text.
 */
export function runGuardrails(text, { vehicle = {}, dealer = {}, salesperson = {}, priceNote = '', price = null, closingLine = '', boilerplate = [] } = {}) {
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
  const unknownNumbers = (text) => [...numbersIn(text)].filter((n) => !src.has(n)).map((n) => ({ code: 'unknown-number', text: `"${n}" isn't in the website's data for this car` }));
  const amountProblems = (text) => [...priceAndMileageProblems(text, { vehicle, priceNote, price }), ...bareAmountProblems(text, { vehicle, dealer, priceNote, price }, src)];
  const role = roleOf(salesperson);
  // a number problem that comes only from the role, the name or the dealership's name is said as one reason naming that setting
  const fromSettings = settingNumberProblems(prose, (text) => [...unknownNumbers(text), ...amountProblems(text)], { role, name: salesperson && salesperson.name, dealerName: dealer.name });
  const notFromSettings = (p) => !fromSettings.gone.has(p.text);
  problems.push(...fromSettings.problems, ...unknownNumbers(prose).filter(notFromSettings));
  // the car's own words: without the dealership's name, its city, the store the website lists the car at and the role, which are not claims about it
  // with each run of spaces read as one, so "Driven  by" is read like "Driven by"
  const aboutCar = without(prose, [dealer.name, dealer.city, vehicle.location, role]).replace(/[^\S\n]+/g, ' ');
  // the website's own words for the car, without the text its whole lot shares (boilerplate: the scan's lot-wide lines)
  const sourceWords = claimSource({ vehicle, priceNote, boilerplate });
  const spelled = new Set();
  for (const q of spelledQuantities(aboutCar)) {
    const words = oneLine(q.words).toLowerCase();
    if (spelled.has(words) || src.has(String(q.value)) || saysWords(sourceWords, q.said)) continue;
    spelled.add(words);
    problems.push({ code: 'unknown-number', text: `"${oneLine(q.words)}" isn't in the website's data for this car` });
  }
  problems.push(...amountProblems(prose).filter(notFromSettings));
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
  // a banned phrase only the dealership's price note says is the note's to change, in Settings: no edit or template can drop the note;
  // the note alone may say where the fees go (PRICE_NOTE_UNLESS), and a phrase across the note's edge is the description's.
  // Where the fees go is fine only where the note stands as a sentence of its own in the text (withoutOwnSentenceNote):
  // words the description joins to the note's sentence ("Taxes are lower when you deal direct, and tax, title and fees go
  // to the state, not the dealer.") make it the description's
  const besideNote = noteSaid ? without(t, [noteSaid]) : t;
  const besideOwnNote = noteSaid ? withoutOwnSentenceNote(t, noteSaid) : t;
  for (const [phrase, re] of BANNED_RE) {
    if (re.test(besideNote)) problems.push({ code: 'banned-phrase', text: `Says "${phrase}"` });
    else if (noteSaid && NOTE_BANNED_RE.get(phrase).test(noteSaid)) problems.push({ code: 'banned-phrase', text: noteBanned(phrase) });
    else if (noteSaid && noteSteer(phrase, noteSaid, dealer, priceNote)) problems.push({ code: 'banned-phrase', text: noteSteer(phrase, noteSaid, dealer, priceNote) });
    else if (!re.test(t)) continue;
    else if (!(noteSaid && re.test(noteSaid))) problems.push({ code: 'banned-phrase', text: `Says "${phrase}"` });
    else if (re.test(besideOwnNote)) problems.push({ code: 'banned-phrase', text: `Says "${phrase}" with words joined to your price note's sentence; keep the note as a sentence of its own: end the sentence before it, and start the one after it with a capital letter` });
  }
  if (ONE_OWNER.test(t) && !vehicle.carfaxOneOwner) {
    problems.push({ code: 'one-owner', text: "Says one owner, but the Carfax one-owner flag isn't set" });
  }
  // a banned phrase is said once, as banned, not again as a claim; one owner is held to the Carfax flag above, not again as owner history, but what the wording says about the owner is still checked
  const claimText = withoutOneOwner(BANNED_RE.reduce((s, [, re]) => s.replace(new RegExp(re.source, 'gi'), ' '), aboutCar));
  problems.push(...claimProblems(claimText, { vehicle, priceNote, boilerplate }));
  if (vehicle.carfaxOneOwner) problems.push(...ownerStoryProblems(aboutCar, sourceWords));
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
  // the car's own abbreviations as the website writes them ("SLE EXT CAB", "AWD, ABS, USB") are its name, not shouting
  if (shouting(t, ownAbbreviations(vehicle))) problems.push({ code: 'all-caps', text: 'Has ALL CAPS shouting' });
  if (emojiCount(t) > 3) problems.push({ code: 'emoji', text: 'Too many emoji' });
  if (hasClosing) for (const p of checkClosingLine(closing).problems) if (!problems.some((q) => q.text === p.text)) problems.push(p);
  return { ok: problems.length === 0, problems, words };
}

// The problems that break a posting rule rather than a style preference:
// the dealership or the salesperson's role not named (the dealership stays
// identifiable); a number, price, mileage, price change, claim or one-owner
// wording the website's data doesn't hold, the same from a number in the
// role, the name or the dealership's name (setting-number), or a missing VIN
// (facts only); a banned phrase (a claim the data can't support, posing as a
// private seller, words about protected groups); the dealer's price note missing or
// quoting the wrong fee (honest prices); and the same in the salesperson's
// closing line. Every code runGuardrails and checkClosingLine give is one of
// these or one of STYLE_PROBLEMS (test/rewriteTemplate.test.js checks it).
export const RULE_PROBLEM_CODES = Object.freeze([
  'no-dealer', 'no-role', 'unknown-number', 'setting-number', 'price-mismatch', 'mileage-mismatch', 'price-change', 'unsupported-claim', 'one-owner', 'banned-phrase',
  'price-note-amount', 'no-price-note', 'no-vin', 'closing-price', 'closing-number', 'closing-one-owner', 'closing-banned',
]);

// The problems in a runGuardrails result that keep the form from being
// filled: every one but the style warnings, so a check added later stops the
// fill until it is sorted ([] for none, or for no result). The side panel's
// one blocker (sidepanel.js fillBlocker) goes by this, on every way of
// filling the form.
export const ruleProblems = (guardrails) => ((guardrails && Array.isArray(guardrails.problems)) ? guardrails.problems : []).filter((p) => !STYLE_PROBLEMS.includes(p.code));
