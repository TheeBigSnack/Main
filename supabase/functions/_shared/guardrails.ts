// The guardrails, ported line for line from extension/src/rewriteTemplate.js
// (the parts backend/server.js used: runGuardrails and its helpers) so the
// Edge Function checks Claude's draft the same way the extension does before
// the salesperson sees it. The template writer itself stays in the extension;
// only the checks live here.
//
// Rules from the build brief, enforced here:
//   - 60-120 words (the VIN line does not count)
//   - every number in the text must be in the website's data for the car
//   - a price note quoting a dollar amount must match the car's two-price gap,
//     and the price note, when one is set, must be in the text whole
//   - a dollar amount must be the price posted or one in the price note, a
//     mileage must be the website's, and no price change is claimed
//   - the VIN and the dealership's name must be present (and a name must be set)
//   - the salesperson's role (their title, or the default one) must be present
//   - banned phrases (claims the data can't support, posing as a private
//     seller, protected characteristics), "one owner" only with the flag,
//     no ALL CAPS shouting, no walls of emoji
//   - no claim about the car's certification, warranty, financing, history,
//     care, new parts, condition, previous owners, how it was driven,
//     where it came from (a local trade, a lease return) or its keys that
//     the facts' own words (write-up, features, price note) don't make, and
//     no number in words that isn't in them
//
// Keep this file equal to the original in what it returns;
// supabase/tests/port-check.mjs runs both on the same inputs.

export interface GuardrailVehicle {
  vin?: unknown;
  year?: unknown;
  make?: unknown;
  model?: unknown;
  trim?: unknown;
  name?: unknown;
  mileage?: unknown;
  stock?: unknown;
  engine?: unknown;
  transmission?: unknown;
  drivetrain?: unknown;
  exteriorColor?: unknown;
  interiorColor?: unknown;
  bodyType?: unknown;
  fuelType?: unknown;
  price?: unknown;
  priceBeforeFees?: unknown;
  descriptionRaw?: unknown;
  features?: unknown;
  carfaxOneOwner?: unknown;
  carfaxUrl?: unknown;
  inventoryType?: unknown;
  readableType?: unknown;
  urlConditionWord?: unknown;
  siteTitle?: unknown;
  location?: unknown; // the store the website lists the car at
}

export interface GuardrailDealer {
  name?: unknown;
  city?: unknown;
  zip?: unknown;
}

export interface GuardrailSalesperson {
  name?: unknown;
  title?: unknown;
}

export interface GuardrailContext {
  vehicle?: GuardrailVehicle;
  dealer?: GuardrailDealer;
  salesperson?: GuardrailSalesperson;
  priceNote?: string;
  price?: number | null;
}

// The title a salesperson has when they set none (extension/src/settings.js DEFAULT_SALESPERSON_TITLE).
export const DEFAULT_SALESPERSON_TITLE = 'sales consultant';

// The salesperson's role as a description must name it: their title, or the
// default one, with its spacing evened out.
export const roleOf = (salesperson: GuardrailSalesperson | undefined): string => String((salesperson && salesperson.title) || DEFAULT_SALESPERSON_TITLE).replace(/\s+/g, ' ').trim();

export interface GuardrailProblem {
  code: string;
  text: string;
}

export interface GuardrailResult {
  ok: boolean;
  problems: GuardrailProblem[];
  words: number;
}

export const WORD_LIMITS = Object.freeze({ min: 60, max: 120 });

// Phrases that never belong in a listing. Matched on word boundaries,
// case-insensitively, with a hyphen or a space between words ("like-new",
// "clean title"). A false positive only means the template is used.
export const BANNED_PHRASES: readonly string[] = Object.freeze([
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
  'not the dealership', 'not the dealer', 'not through the dealership', 'not through the dealer', 'not at the dealership', 'skip the dealership', 'skip the dealer',
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
// phrase is not banned there: the dealership's own fee wording ("tax, title
// and registration, which go to the state, not the dealer"), the
// dealership's own desk or number ("Ask for me, not the dealer's front
// desk"), and the dealership's owner ("I'm the owner of this dealership").
// For each phrase: what comes before it in its sentence, or right after it,
// when it is fine. Still banned: "Text me, not the dealer.", "I'm the owner.",
// "I'm the owner of this truck".
const FEE_EARLIER = "\\b(?:tax(?:es)?|title|registration|tags|plates|fees?)\\b[^.!?;\\n]*";
const THE_BUSINESS = "[\\s-]+of[\\s-]+(?:this|the|our)[\\s-]+(?:dealership|dealer|store|business|company|lot)\\b";
export const BANNED_UNLESS: Readonly<Record<string, Readonly<{ before?: string; after?: string }>>> = Object.freeze({
  'not the dealership': Object.freeze({ before: FEE_EARLIER, after: "['\u2019]s\\b" }),
  'not the dealer': Object.freeze({ before: FEE_EARLIER, after: "['\u2019]s\\b" }),
  'i am the owner': Object.freeze({ after: THE_BUSINESS }),
  "i'm the owner": Object.freeze({ after: THE_BUSINESS }),
  'i\u2019m the owner': Object.freeze({ after: THE_BUSINESS }),
});

export function wordCount(text: unknown): number {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// The VIN line is part of every description but not part of the prose: it
// is left out of the word count and its digits are not "numbers".
const VIN_LINE = /^\s*VIN\b[:\s]*[A-HJ-NPR-Z0-9]{17}\.?\s*$/gim;
const VIN_TOKEN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
export const stripVin = (text: unknown): string => String(text || '').replace(VIN_LINE, '').replace(VIN_TOKEN, ' ');

// Every number in a piece of text, normalised so "20,986" and "20986" match.
export function numbersIn(text: unknown): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? '').match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const n = m.replace(/,/g, '');
    if (n) out.add(n);
  }
  return out;
}

// Numbers the website (and the dealer's own settings) actually contain.
export function sourceNumbers({ vehicle = {}, dealer = {}, priceNote = '', price = null }: GuardrailContext = {}): Set<string> {
  const v = vehicle;
  const bits: unknown[] = [
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
// mileage. Both are read in the usual ways a write-up states them
// ("$28,995", "Internet price: 28,995", "was 31,995"; "38,000 original
// miles", "Mileage: 38,000", "odometer reads 38,000", "38,000 on the
// clock"). Distances, ranges, warranty terms and fuel economy are not the
// odometer, and a model year is neither.

interface Amount {
  text: string;
  value: number;
}
interface WordAmount extends Amount {
  lead: string;
  at: number;
}

const amountOf = (digits: string, thousands: string | undefined): number => Math.round(Number(String(digits).replace(/,/g, '')) * (thousands ? 1000 : 1));
const YEAR_SHAPED = /^(?:19|20)\d{2}$/;
const MILE_WORDS = '(?:original|actual|true|indicated|documented|verified|certified|highway|hwy|city|local|easy|gentle|careful|adult|low|total|clean)';
const MEASURE_AFTER = new RegExp(`^\\s?(?:(?:k|thousand)\\b)?[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(?:miles?\\b|mi\\b|kms?\\b|kilomet|lbs?\\b|pounds?\\b|rpm\\b|cc\\b|hp\\b|horsepower|mpg|gal|watts?\\b|volts?\\b|ft\\b|feet|on the (?:odometer|odo|clock)\\b)`, 'i');

const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)(\s?k\b)?/gi;
// An amount with the word instead of "$" ("1,500 dollars", "2k bucks"), or
// with what money does after it ("1,500 down", "1500 off", "1,000 cash
// back", "a 1,500 rebate"); "off" that is not money ("1500 off-road", "off
// the lot") is not.
const DOLLAR_WORDS = /\b(\d[\d,]*(?:\.\d+)?)(\s?k\b)?[\s-]*(?:dollars?|bucks|down|off(?![\s-]?(?:road|lease)|[\s-]+(?:the|our)[\s-]+(?:lot|showroom|line|floor))|cash[\s-]?back|rebates?|discounts?|savings|in (?:savings|rebates?|discounts?|cash[\s-]?back)|(?:under|below) (?:book|kbb|market|retail|msrp|invoice|sticker))\b/gi;
// A price-sized number right after a price word, "save", "rebate",
// "discount", "cash back" or "down payment", written without "$".
const PRICE_WORD = /\b(prices?|priced|msrp|asking|was|now(?:\s+(?:just|only))?|yours for|reduced to|dropped to|sav(?:e|ings?)(?:\s+(?:up to|over))?|rebates?|discounts?|cash[\s-]?back|down[\s-]payments?)(?:\s+(?:is|of|at|to|just|only|now))*\s*[:\-–]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,7}(?:\.\d{1,2})?|\d{1,3}(?:\.\d+)?(?=\s?k\b))(?![\d,]\d)(\s?k\b)?/gi;
function priceWordAmounts(t: string): WordAmount[] {
  const out: WordAmount[] = [];
  for (const m of t.matchAll(PRICE_WORD)) {
    const at = m.index as number;
    if (!m[3] && YEAR_SHAPED.test(m[2])) continue;
    if (MEASURE_AFTER.test(t.slice(at + m[0].length, at + m[0].length + 40))) continue;
    out.push({ text: m[0].trim(), value: amountOf(m[2], m[3]), lead: m[1], at });
  }
  return out;
}
export function dollarAmounts(text: unknown): Amount[] {
  const t = String(text ?? '');
  const signed = [...t.matchAll(DOLLARS), ...t.matchAll(DOLLAR_WORDS)].map((m) => ({ text: m[0].trim(), value: amountOf(m[1], m[2]), at: m.index as number }));
  return [...signed, ...priceWordAmounts(t)].sort((a, b) => a.at - b.at).map(({ text: said, value }) => ({ text: said, value }));
}

const MILES = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:k|thousand)\\b)?[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(?:miles?\\b|mi\\b\\.?)`, 'gi');
const NOT_ODOMETER_BEFORE = /(?:\/|\b(?:within|up to|every|range(?: of)?|per|(?:years?|yrs?|months?|mos?)\s+(?:or|and)))\s*:?\s*$/i;
const NOT_ODOMETER_AFTER = /^[\s-]*(?:\/|(?:from|per|an? hour|to empty)\b|(?:[\w'-]+\s+){0,2}(?:warranty|powertrain|bumper|coverage|range|radius|away|charge|tank)\b)/i;
const ODOMETER_SAYS = /\b(gas |fuel )?(?:mileage|odometer(?: reading)?|odo|miles(?=\s*:))\b(?:\s+(?:is|of|reads|reading|shows|showing|says|at|now))*\s*[:\-–]?\s*(?:(?:only|just)\s+)?(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand)\b)?/gi;
const ON_ODOMETER = /(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand)\b)?\s+on the (?:odometer|odo|clock)\b/gi;
const FUEL_AFTER = /^\s*(?:mpg|mpge|miles? per|city|hwy|highway|combined|\/|%)/i;
export function mileageClaims(text: unknown): Amount[] {
  const t = String(text ?? '');
  const found = new Map<number, Amount>();
  for (const m of t.matchAll(MILES)) {
    const at = m.index as number;
    if (NOT_ODOMETER_BEFORE.test(t.slice(Math.max(0, at - 20), at))) continue;
    if (NOT_ODOMETER_AFTER.test(t.slice(at + m[0].length, at + m[0].length + 40))) continue;
    found.set(at, { text: m[0].trim(), value: amountOf(m[1], m[2]) });
  }
  for (const m of t.matchAll(ODOMETER_SAYS)) {
    const end = (m.index as number) + m[0].length;
    const at = end - m[2].length - (m[3] || '').length;
    if (m[1] || found.has(at) || (!m[3] && YEAR_SHAPED.test(m[2]))) continue;
    if (FUEL_AFTER.test(t.slice(end, end + 20))) continue;
    found.set(at, { text: m[0].trim(), value: amountOf(m[2], m[3]) });
  }
  for (const m of t.matchAll(ON_ODOMETER)) if (!found.has(m.index as number)) found.set(m.index as number, { text: m[0].trim(), value: amountOf(m[1], m[2]) });
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, claim]) => claim);
}

// Wording that claims a price change. Prices only ever mirror the website.
export const PRICE_CHANGE = /\b(?:price (?:drop(?:ped)?|reduced|reduction|cut)|reduced price|just reduced|marked down|(?:reduced|dropped|lowered|slashed|cut) from(?= \$?\d)|was \$|now (?:just |only )?\$)/i;
const CHANGE_LEAD = /^(?:was|now|reduced to|dropped to)\b/i;
function priceChangeSaid(text: string): string {
  const m = PRICE_CHANGE.exec(text);
  if (m) return m[0].trim();
  const w = priceWordAmounts(String(text ?? '')).find((a) => CHANGE_LEAD.test(a.lead));
  return w ? w.text : '';
}

function priceAndMileageProblems(text: string, { vehicle = {}, priceNote = '', price = null }: GuardrailContext): GuardrailProblem[] {
  const problems: GuardrailProblem[] = [];
  const posted = typeof price === 'number' && price > 0 ? Math.round(price) : null;
  const allowed = new Set([posted, ...dollarAmounts(priceNote).map((a) => a.value)].filter((n) => n !== null));
  const said = new Set<number>();
  for (const a of dollarAmounts(text)) {
    if (allowed.has(a.value) || said.has(a.value)) continue;
    said.add(a.value);
    const money = `$${a.value.toLocaleString('en-US')}`;
    problems.push({ code: 'price-mismatch', text: posted ? `Says ${money}, but this listing's price is $${posted.toLocaleString('en-US')}` : `Says ${money}; the price belongs in the listing's price field` });
  }
  const miles = typeof vehicle.mileage === 'number' && vehicle.mileage >= 0 ? Math.round(vehicle.mileage) : null;
  const claimed = new Set<number>();
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
// no unit after it ("Only 28,995!", "With 38,000 on it"). A bare amount the
// car's record (model, trim, stock number, features, the dealership's name
// and ZIP, the price note) does not hold comes from the write-up, where it
// is a price or a mileage that can be out of date, so it must be the price
// being posted, an amount in the price note or the website's mileage. A
// year and a phone number are neither, and an amount the price and mileage
// checks read is theirs.
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
function bareAmountProblems(text: string, { vehicle = {}, dealer = {}, priceNote = '', price = null }: GuardrailContext, src: Set<string>): GuardrailProblem[] {
  const v = vehicle;
  const t = String(text ?? '');
  const record: unknown[] = [
    v.year, v.make, v.model, v.trim, v.name, v.stock, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, ...(Array.isArray(v.features) ? v.features : []), priceNote, dealer.name, dealer.city, dealer.zip, v.location,
  ];
  const held = numbersIn(record.filter((b) => b !== null && b !== undefined).join(' '));
  const posted = typeof price === 'number' && price > 0 ? Math.round(price) : null;
  const miles = typeof v.mileage === 'number' && v.mileage >= 0 ? Math.round(v.mileage) : null;
  const read = new Set<number | null>([posted, miles, ...[...dollarAmounts(t), ...dollarAmounts(priceNote), ...mileageClaims(t)].map((a) => a.value)]);
  const phones = [...t.matchAll(PHONE)].map((m) => [m.index as number, (m.index as number) + m[0].length]);
  const problems: GuardrailProblem[] = [];
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const at = m.index as number;
    const said = m[0].replace(/,+$/, '');
    const end = at + said.length;
    const after = t.slice(end, end + 40);
    const k = /^\s?k\b/i.test(after);
    const value = amountOf(said, k ? 'k' : undefined);
    if (value < 1000 || (!k && YEAR_SHAPED.test(said)) || MEASURE_AFTER.test(after)) continue;
    const n = said.replace(/,/g, '');
    if (!src.has(n) || held.has(n) || read.has(value) || phones.some(([a, b]) => at >= a && end <= b)) continue;
    read.add(value);
    problems.push({ code: 'unknown-number', text: `Says "${said}${k ? 'k' : ''}", which is neither the price being posted nor the website's mileage for this car` });
  }
  return problems;
}

// Three words in capitals in a row, or one long one. A word in `passOver`
// (the car's own abbreviations) neither counts nor breaks a run.
function shouting(text: unknown, passOver: Set<string> = new Set()): boolean {
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
// still counts.
export function ownAbbreviations(vehicle: GuardrailVehicle = {}): Set<string> {
  const v = vehicle || {};
  const bits: unknown[] = [
    v.name, v.make, v.model, v.trim, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, v.stock, v.location, ...(Array.isArray(v.features) ? v.features : []),
  ];
  const out = new Set<string>();
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

function emojiCount(text: unknown): number {
  return (String(text || '').match(/\p{Extended_Pictographic}/gu) || []).length;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const BANNED_RE: Array<[string, RegExp]> = BANNED_PHRASES.map((p) => {
  const unless: { before?: string; after?: string } = BANNED_UNLESS[p] || {};
  return [p, new RegExp((unless.before ? `(?<!${unless.before})` : '') + '\\b' + escapeRe(p).replace(/[\s-]+/g, '[\\s-]+') + '\\b' + (unless.after ? `(?!${unless.after})` : ''), 'i')];
});
// "one owner", "1-owner", "single-owner", "one careful owner", "one
// careful, loving owner", "one very careful adult owner" (up to three words
// between, a comma after any but the last), "only one previous owner", "its
// sole owner", "its first owner", "owned by one family"; not "One-Touch
// Windows, Owner's Manual"
const ONE_OWNER = /\b(?:(?:one|1|single)[\s-]+(?:(?:(?!(?:new|next|more|other|of|the|a|an|its|your|lucky)\b)[a-z']+,?[\s-]+){0,2}(?!(?:new|next|more|other|of|the|a|an|its|your|lucky)\b)[a-z']+[\s-]+)?owner(?!['\u2019]s[\s-]+(?:manual|guide|handbook|portal|app)\b)|(?:sole|only|first)[\s-]+owner|owned by (?:one|a single))\b/i;

// ---------- claims only the website can make ----------
// What a description says about the car's certification, warranty,
// financing, history, care, parts, condition, owners, use, origin or keys
// comes from the website's own words for this car (here: the facts'
// write-up, features and the rest of the record) or the dealer's price
// note, never from the writer. Each kind is found by its words, and passes
// when words of the same kind, said the same way, are in those sources: a
// claim that the thing is there needs them to say it is there, and one that
// it is not ("no warranty", "clean Carfax", "as-is") needs them to say it
// is not (new parts: the sources must say that part is new). The facts'
// narrative already leaves out the text the whole lot shares (the
// extension's cleanDescription), so this copy has no lot-wide text to set
// aside. The dealership's name, its city and the role are set aside
// first, as are banned phrases and the words of one-owner wording (each
// flagged on its own; what that wording says about the owner is still
// checked, see ownerStoryProblems).
interface ClaimKind {
  what: string;
  re: RegExp;
  part?: boolean;
  hedge?: RegExp;
}
const PARTS = 'tires?|tyres?|brakes?|rotors?|pads|battery|batteries|wipers?|shocks?|struts?|exhaust|alternator|starter|clutch|timing (?:belt|chain)|water pump|engine|motor|transmission|paint|parts';
export const CLAIM_KINDS: readonly ClaimKind[] = Object.freeze([
  { what: 'certification', re: /\b(?:certified|cpo)\b/i },
  { what: 'a warranty or guarantee', re: /\b(?:warrant(?:y|ies|eed)|guarantee[ds]?|(?<!air[\s-]?bags?[\s-])coverage|protection plans?|service contracts?|as[\s-]is)\b/i },
  { what: 'financing', re: /\b(?:financ\w*|loans?|lenders?|apr|down[\s-]payments?|monthly payments?|per month|lease\w*|buy[\s-]here)\b/i },
  // credit and approval, apart from financing: "subject to bank approval" never backs "everyone gets approved"
  { what: 'credit or approval', re: /\b(?:credit|approv\w*)\b/i, hedge: /\b(?:subject to\b[^.!?;\n]{0,40}\b(?:approval|credit)|(?:with|on|upon) approved credit|upon (?:credit |lender |bank )?approval|if (?:you(?:'re| are) )?approved|approval (?:is )?required)\b/i },
  { what: 'accident, damage or title history', re: /\b(?:accidents?|collisions?|wreck(?:s|ed)?|damaged?|flood\w*|salvage|rebuilt|titles?|clean (?:carfax|autocheck|history|record|report))\b/i },
  { what: 'smoking or pets', re: /\b(?:non[\s-]?smok\w*|smok(?:er|ers|ing|ed)|smoke[\s-]?free|pet[\s-]?free|no pets)\b/i },
  { what: 'service history, inspection or upkeep', re: /\b(?:inspect\w*|serviced|service (?:history|records?)|records|maintenance|maintained|oil changes?|tune[\s-]?up|reconditioned|(?:fully|freshly|just|professionally|recently) detailed|garage[\s-]kept|garaged|well[\s-](?:kept|cared)|taken care of)\b/i },
  { what: 'new or replaced parts', re: new RegExp(`\\b(?:(?:brand[\\s-])?new|newer|fresh|replaced|recent)\\s+(?:(?:set of|[\\w-]+)\\s+){0,2}?(${PARTS})\\b`, 'i'), part: true },
  { what: 'its condition', re: /\b(?:(?:excellent|great|good|pristine|immaculate|showroom|top|amazing|beautiful|clean) (?:condition|shape)|runs (?:great|strong|well|smooth\w*|excellent)|drives (?:great|well|smooth\w*|excellent)|mechanically sound|needs nothing|turn[\s-]?key|rust[\s-]free|no (?:rust|dents|problems))\b/i },
  // who had it and how it was used ("one owner" has its own check, against the Carfax flag; "Pre-owned" is not a claim)
  { what: 'its owners or how it was driven', re: /\b(?:(?:previous|prior|past|former|original) owners?|(?<!pre[\s-])owned by|(?:adult|local|locally)[\s-]owned(?![\s-]+(?:(?:and|&)[\s-]+operated|dealer\w*|business|company|store|shop)\b)|driven (?:by(?!\s+(?:(?:a|an|the|its)\s+)?(?:\d|v-?\d|hemi\b|ecoboost|duramax|cummins|power[\s-]?stroke|pentastar|vortec|(?:[\w.-]+\s+){0,3}(?:engines?|motors?|powertrains?|v-?\d+)(?![\w-])))|only|mostly|mainly|gently|sparingly|carefully)|never driven|drove it (?:to|only|mostly|mainly|gently|sparingly|carefully)|(?:grand(?:ma|mother|pa|father)|granny)['\u2019]s (?:car|truck|suv|van|jeep|vehicle|ride)|(?:adult|gently|lightly|carefully|rarely|barely)[\s-]driven|babied|pampered|weekend (?:driver|car|cruiser|only)|(?:highway|freeway) miles|one[\s-]family)\b/i },
  { what: 'where it came from', re: /\b(?:local(?:ly)? trade[ds]?|traded in locally|(?:came|taken|took) in on trade|on trade from|trade[\s-]in from|lease returns?|off[\s-]lease)\b/i },
  { what: 'its keys', re: /\b(?:(?:both|spare|extra|second|two|2|three|3|(?:sets?|pairs?) of) (?:keys|key[\s-]?fobs|fobs|remotes)|(?:spare|extra|second) (?:key|key[\s-]?fob|fob|remote))\b/i },
]);

// The write-up split at its line breaks, paragraphs and list items, markup
// set aside, spacing made plain, as the extension's checks read it
// (extension/src/description.js splitSegments; claimSource makes it one
// line, so where a wrapped line is joined again makes no difference here).
// Here the facts' narrative is already plain text (the extension decodes
// entities and drops invisible characters before sending it), so this
// changes nothing but the spacing.
const BLOCK_BREAK = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|dt|dd|section|article|blockquote)\b[^>]*>/i;
function writeUpText(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  return raw
    .split(BLOCK_BREAK)
    .flatMap((block) => block.split(/\r\n|\r|\n/))
    .map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function claimSource({ vehicle = {}, priceNote = '' }: GuardrailContext): string {
  const v = vehicle;
  const bits: unknown[] = [
    v.year, v.make, v.model, v.trim, v.name, v.engine, v.transmission, v.drivetrain, v.exteriorColor, v.interiorColor,
    v.bodyType, v.fuelType, writeUpText(v.descriptionRaw), ...(Array.isArray(v.features) ? v.features : []), priceNote,
  ];
  return bits.filter((b) => b !== null && b !== undefined).map((b) => oneLine(b)).join('\n');
}

// The extension's record says certified (the facts carry none of these
// fields, so here a draft says certified only when the write-up or the
// features do; the port keeps them so both files return the same).
export function listedCertified(v: GuardrailVehicle = {}): boolean {
  const titleWords = typeof v.siteTitle === 'string' ? (v.siteTitle.match(/^\s*(.*?)\s*\b(?:19|20)\d{2}\b/) || [])[1] : '';
  return /\b(?:certified|cpo)\b/i.test([v.inventoryType, v.readableType, v.urlConditionWord, titleWords].filter((s) => typeof s === 'string').join(' '));
}

function without(text: unknown, names: unknown[]): string {
  let out = String(text || '');
  for (const n of names) {
    const name = oneLine(n);
    if (name) out = out.replace(new RegExp(escapeRe(name).replace(/ /g, '\\s+'), 'gi'), ' ');
  }
  return out;
}

// The parts a text says are new or replaced, each with the words that say
// so: "new tires", "new Michelin tires", "a new set of tires", "replaced
// brakes", and each part joined straight on to one with "and" ("new tires
// and brakes"). In the website's own words a list with commas counts too
// ("new tires, brakes and rotors"); in the text it does not, since the
// highlights line lists the website's features with commas ("New Tires,
// Brake Assist").
const AND_PARTS = new RegExp(`^\\s+(?:and|&|plus)\\s+(?:(?:front|rear)\\s+)?(${PARTS})\\b`, 'i');
const LISTED_PARTS = new RegExp(`^(?:\\s*,\\s*(?:and\\s+|&\\s+)?|\\s+(?:and|&|plus)\\s+)(?:(?:front|rear)\\s+)?(${PARTS})\\b`, 'i');
const partKey = (part: string): string => oneLine(part).toLowerCase().replace(/(?:ies|ys|s|y)$/, '');
function newPartsSaid(text: unknown, re: RegExp, more: RegExp): Array<{ said: string; part: string }> {
  const t = String(text ?? '');
  const out: Array<{ said: string; part: string }> = [];
  for (const m of t.matchAll(new RegExp(re.source, 'gi'))) {
    out.push({ said: m[0], part: partKey(m[1]) });
    let end = (m.index as number) + m[0].length;
    for (let next = more.exec(t.slice(end)); next; next = more.exec(t.slice(end))) {
      end += next[0].length;
      out.push({ said: t.slice(m.index as number, end), part: partKey(next[1]) });
    }
  }
  return out;
}

// Whether a claim says the thing is not there: its own words deny it ("no
// pets", "non-smoker", "rust-free", "clean Carfax", "as-is"), a denying word
// comes up to four words before it in its clause ("no warranty", "does not
// come with a warranty"), it is followed by one ("warranty: none",
// "damage-free"), or, for credit and approval, its sentence makes approval
// a condition ("subject to bank approval").
const DENIES_ITSELF = /^(?:no|non|never|zero)\b|^non[\s-]?|[\s-]free$|^clean\b|^as[\s-]is$/i;
const DENYING_WORD = /^(?:no|not|never|without|none|nor|zero|cannot|lacks?|lacking|excludes?|excluding|except|\w+n['\u2019]t)$/i;
const DENIED_AFTER = /^(?:none|not|n\/a|expired|void(?:ed)?|excluded|unavailable|\w+n['\u2019]t)$/i;
function denies(text: string, at: number, said: string, kind: ClaimKind): boolean {
  if (DENIES_ITSELF.test(said)) return true;
  const before = text.slice(Math.max(0, at - 80), at).split(/[.,;:!?\n]|\b(?:and|but|however|although|though|while)\b/i).pop() || '';
  const word = (w: string): string => w.replace(/^[^\w]+|[^\w'\u2019]+$/g, '');
  if (before.split(/\s+/).map(word).filter(Boolean).slice(-4).some((w) => DENYING_WORD.test(w))) return true;
  const after = text.slice(at + said.length, at + said.length + 40);
  if (/^[\s-]*free\b/i.test(after)) return true;
  if (after.split(/[.,;!?\n]|\b(?:and|but|or)\b/i)[0].split(/[\s:]+/).map(word).filter(Boolean).slice(0, 2).some((w) => DENIED_AFTER.test(w))) return true;
  if (!kind.hedge) return false;
  const start = Math.max(text.lastIndexOf('.', at), text.lastIndexOf('!', at), text.lastIndexOf('?', at), text.lastIndexOf(';', at), text.lastIndexOf('\n', at)) + 1;
  const end = text.slice(at).search(/[.!?;\n]/);
  return kind.hedge.test(text.slice(start, end < 0 ? text.length : at + end));
}
// Each claim of a kind in a text, with whether it says the thing is not there.
const mentions = (text: unknown, kind: ClaimKind): Array<{ said: string; denied: boolean }> => [...String(text).matchAll(new RegExp(kind.re.source, 'gi'))].map((m) => ({ said: m[0], denied: denies(String(text), m.index as number, m[0], kind) }));

// Every claim in the text, not only the first of each kind: one part the
// facts say is new never covers another the draft adds, and a part the
// facts only name ("ABS Brakes") is not one they say is new. Each kind the
// sources don't make is said once; each new part they don't say is new is
// said once.
function claimProblems(text: string, ctx: GuardrailContext): GuardrailProblem[] {
  const source = claimSource(ctx);
  const problems: GuardrailProblem[] = [];
  for (const kind of CLAIM_KINDS) {
    if (kind.what === 'certification' && listedCertified(ctx.vehicle)) continue;
    if (kind.part) {
      const said = new Set<string>();
      // a part passes only when the website's own words say that part is new: naming it ("ABS Brakes") is not enough
      const named = new Set(newPartsSaid(source, kind.re, LISTED_PARTS).map((p) => p.part));
      for (const p of newPartsSaid(text, kind.re, AND_PARTS)) {
        if (named.has(p.part) || said.has(p.part)) continue;
        said.add(p.part);
        problems.push({ code: 'unsupported-claim', text: `Says "${p.said}", but the website says nothing about ${kind.what} for this car` });
      }
      continue;
    }
    // the facts say it is there, that it is not, or both: a claim of either kind needs the facts to say the same
    const sourced = new Set(mentions(source, kind).map((x) => x.denied));
    const m = mentions(text, kind).find((x) => !sourced.has(x.denied));
    if (!m) continue;
    // (the extension also names the lot-wide text it left out; the narrative here has none)
    const why = sourced.size ? `the website does not say the same about ${kind.what} for this car` : `the website says nothing about ${kind.what} for this car`;
    problems.push({ code: 'unsupported-claim', text: `Says "${m.said}", but ${why}` });
  }
  return problems;
}

// One-owner wording on a one-owner car. The Carfax flag gives the count of
// owners and nothing more, so the wording's own words are held to the flag
// and set aside before the claim check, but what it says between "one" and
// "owner" stays: "one damage-free owner" is checked as damage history, and
// "one adult owner" or "one careful owner" as owner history the facts' own
// words must tell too. "previous", "prior", "original" and the like only
// restate the count.
const ONE_OWNER_ALL = new RegExp(ONE_OWNER.source, 'gi');
const OWNER_COUNT_WORDS = /^(?:previous|prior|original|registered|recorded|reported|listed|carfax|autocheck)$/i;
const betweenOneAndOwner = (said: string): string => (String(said).match(/^(?:one|1|single)[\s-]+(.*?)[\s-]*owner$/i) || [])[1] || '';
const withoutOneOwner = (text: string): string => String(text).replace(ONE_OWNER_ALL, (said) => ` ${betweenOneAndOwner(said)} `);
// After "owned by one" or "owned by a single", the words that say who, up
// to the first word that only carries the sentence on ("owned by one
// retired teacher", "a single careful driver", "one family since new");
// "family", "person", "driver" and the like only restate the count.
const STORY_ENDS = /^(?:since|from|for|and|or|but|with|in|on|at|who|that|which|until|to|of|the|a|an|its|it|this)$/i;
const COUNT_NOUNS = /^(?:family|families|household|owner|person|individual|party|driver|buyer|customer)$/i;
function ownerStory(text: string, m: RegExpMatchArray): { said: string; words: string[] } {
  if (!/^owned by/i.test(m[0])) return { said: m[0], words: betweenOneAndOwner(m[0]).split(/[\s,-]+/).filter((w) => w && !OWNER_COUNT_WORDS.test(w)) };
  const tail = (String(text).slice((m.index as number) + m[0].length).match(/^(?:[\s-]+[a-z'\u2019]+){1,4}/i) || [''])[0];
  const words: string[] = [];
  for (const w of tail.split(/[\s-]+/).filter(Boolean)) {
    if (STORY_ENDS.test(w)) break;
    words.push(w);
  }
  return { said: `${m[0]} ${words.join(' ')}`, words: words.filter((w) => !COUNT_NOUNS.test(w) && !OWNER_COUNT_WORDS.test(w)) };
}
function ownerStoryProblems(text: string, source: string): GuardrailProblem[] {
  const problems: GuardrailProblem[] = [];
  const said = new Set<string>();
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
// A quantity in words ("thirty thousand miles", "twenty-five mpg", "two
// owners") must be in the facts as digits, or in the same words with the
// same unit. Number words count only with "hundred" or "thousand", or
// before a unit; "one owner" has its own check.
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const NUM_WORD = `(?:${Object.keys(NUMBER_WORDS).join('|')}|hundred|thousand)`;
const SPELLED = new RegExp(`\\b${NUM_WORD}(?:(?:[\\s-]+|\\s+and\\s+)${NUM_WORD})*\\b`, 'gi');
const SPELLED_UNIT = new RegExp(`^[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(miles?|mi|mpg|k|grand|dollars?|bucks|years?|months?|owners?|keys|sets? of keys)\\b`, 'i');
function spelledValue(words: string): number {
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
interface Spelled {
  words: string;
  said: string;
  value: number;
}
export function spelledQuantities(text: unknown): Spelled[] {
  const t = String(text ?? '');
  const out: Spelled[] = [];
  for (const m of t.matchAll(SPELLED)) {
    const at = m.index as number;
    const unit = SPELLED_UNIT.exec(t.slice(at + m[0].length, at + m[0].length + 40));
    if (!/\b(?:hundred|thousand)\b/i.test(m[0]) && !unit) continue;
    const value = spelledValue(m[0]) * (unit && /^(?:k|grand)$/i.test(unit[1]) ? 1000 : 1);
    if (unit && /^owner/i.test(unit[1]) && value === 1) continue;
    out.push({ words: m[0], said: oneLine(m[0] + (unit ? unit[0] : '')), value });
  }
  return out;
}
const saysWords = (text: unknown, words: string): boolean => new RegExp(`\\b${escapeRe(oneLine(words)).replace(/[\s-]+/g, '[\\s-]+')}\\b`, 'i').test(String(text || ''));

/**
 * Checks a description against the source data. Returns { ok, problems, words }.
 * Every problem has a code and a short plain-English text.
 */
export function runGuardrails(text: unknown, { vehicle = {}, dealer = {}, salesperson = {}, priceNote = '', price = null }: GuardrailContext = {}): GuardrailResult {
  const t = String(text || '');
  const prose = stripVin(t);
  const problems: GuardrailProblem[] = [];
  const words = wordCount(prose);
  if (words < WORD_LIMITS.min) problems.push({ code: 'too-short', text: `${words} words; needs at least ${WORD_LIMITS.min}` });
  if (words > WORD_LIMITS.max) problems.push({ code: 'too-long', text: `${words} words; the limit is ${WORD_LIMITS.max}` });

  const src = sourceNumbers({ vehicle, dealer, priceNote, price });
  for (const n of numbersIn(prose)) {
    if (!src.has(n)) problems.push({ code: 'unknown-number', text: `"${n}" isn't in the website's data for this car` });
  }
  // the car's own words: without the dealership's name, its city, the store the website lists the car at and the role, which are not claims about it
  const role = roleOf(salesperson);
  const aboutCar = without(prose, [dealer.name, dealer.city, vehicle.location, role]);
  const sourceWords = claimSource({ vehicle, priceNote });
  const spelled = new Set<string>();
  for (const q of spelledQuantities(aboutCar)) {
    const words = oneLine(q.words).toLowerCase();
    if (spelled.has(words) || src.has(String(q.value)) || saysWords(sourceWords, q.said)) continue;
    spelled.add(words);
    problems.push({ code: 'unknown-number', text: `"${oneLine(q.words)}" isn't in the website's data for this car` });
  }
  problems.push(...priceAndMileageProblems(prose, { vehicle, priceNote, price }));
  problems.push(...bareAmountProblems(prose, { vehicle, dealer, priceNote, price }, src));
  // The price note is the dealer's wording. When it quotes a dollar amount and
  // the website shows two prices for this car, the amount must be their
  // difference; a note written for one fee must not ride on a car with another.
  const gap = typeof vehicle.price === 'number' && typeof vehicle.priceBeforeFees === 'number' && vehicle.priceBeforeFees > 0 && vehicle.priceBeforeFees < vehicle.price ? vehicle.price - vehicle.priceBeforeFees : null;
  if (gap !== null) {
    const note = String(priceNote || '');
    const amounts = [...note.matchAll(/\$\s?(\d[\d,]*)/g)].map((m) => ({ text: m[0], value: Number(m[1].replace(/,/g, '')), at: m.index as number }));
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
  // tax and tags), so it is in every description it applies to, whole.
  const noteSaid = oneLine(priceNote);
  if (noteSaid && !oneLine(t).toLowerCase().includes(noteSaid.toLowerCase())) {
    problems.push({ code: 'no-price-note', text: `Doesn't include your dealership's price note: "${noteSaid}"` });
  }
  const vin = String(vehicle.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin && !t.toUpperCase().includes(vin)) problems.push({ code: 'no-vin', text: "Doesn't include the VIN" });
  // a banned phrase only the dealership's price note says is the note's to change, in Settings: no edit or template can drop the note
  const besideNote = noteSaid ? without(t, [noteSaid]) : t;
  for (const [phrase, re] of BANNED_RE) {
    if (re.test(besideNote)) problems.push({ code: 'banned-phrase', text: `Says "${phrase}"` });
    else if (re.test(t)) problems.push({ code: 'banned-phrase', text: `Your dealership's price note says "${phrase}"; change the note in Settings` });
  }
  if (ONE_OWNER.test(t) && !vehicle.carfaxOneOwner) {
    problems.push({ code: 'one-owner', text: "Says one owner, but the Carfax one-owner flag isn't set" });
  }
  // a banned phrase is said once, as banned, not again as a claim; one owner is held to the Carfax flag above, not again as owner history, but what the wording says about the owner is still checked
  const claimText = withoutOneOwner(BANNED_RE.reduce((s, [, re]) => s.replace(new RegExp(re.source, 'gi'), ' '), aboutCar));
  problems.push(...claimProblems(claimText, { vehicle, priceNote }));
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
  return { ok: problems.length === 0, problems, words };
}
