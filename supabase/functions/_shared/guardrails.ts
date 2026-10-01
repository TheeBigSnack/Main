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
//     care, new parts or condition that the facts' own words (write-up,
//     features, price note) don't make, and no number in words that isn't
//     in them
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
}

export interface GuardrailDealer {
  name?: unknown;
  city?: unknown;
  zip?: unknown;
}

export interface GuardrailSalesperson {
  title?: unknown;
}

export interface GuardrailContext {
  vehicle?: GuardrailVehicle;
  dealer?: GuardrailDealer;
  salesperson?: GuardrailSalesperson;
  priceNote?: string;
  price?: number | null;
}

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
// extension/src/settings.js DEFAULT_SALESPERSON_TITLE
export const DEFAULT_SALESPERSON_TITLE = 'sales consultant';

// Phrases that never belong in a listing. Matched on word boundaries,
// case-insensitively, with a hyphen or a space between words ("like-new",
// "clean title"). A false positive only means the template is used.
export const BANNED_PHRASES: readonly string[] = Object.freeze([
  // claims the website's data can't support
  'best price in town', 'lowest price', 'best deal', 'no accidents', 'zero accidents', 'no accident history', 'accident free',
  'never been in an accident', 'clean title', 'no issues', 'runs perfect', 'runs perfectly', 'perfect condition',
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
    priceNote, price, dealer.name, dealer.city, dealer.zip,
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
const PRICE_WORD = /\b(prices?|priced|msrp|asking|was|now(?:\s+(?:just|only))?|yours for|reduced to|dropped to)(?:\s+(?:is|of|at|to|just|only|now))*\s*[:\-–]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,7}(?:\.\d{1,2})?|\d{1,3}(?:\.\d+)?(?=\s?k\b))(?![\d,]\d)(\s?k\b)?/gi;
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
  const signed = [...t.matchAll(DOLLARS)].map((m) => ({ text: m[0].trim(), value: amountOf(m[1], m[2]), at: m.index as number }));
  return [...signed, ...priceWordAmounts(t)].sort((a, b) => a.at - b.at).map(({ text: said, value }) => ({ text: said, value }));
}

const MILES = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:k|thousand)\\b)?[\\s-]*(?:${MILE_WORDS}[\\s-]+){0,2}(?:miles?\\b|mi\\b\\.?)`, 'gi');
const NOT_ODOMETER_BEFORE = /(?:\/|\b(?:within|up to|every|range(?: of)?|per|(?:years?|yrs?|months?|mos?)\s+(?:or|and)))\s*:?\s*$/i;
const NOT_ODOMETER_AFTER = /^[\s-]*(?:\/|(?:from|per|an? hour|to empty)\b|(?:[\w'-]+\s+){0,2}(?:warranty|powertrain|bumper|coverage|range|radius|away|charge|tank)\b)/i;
const ODOMETER_SAYS = /\b(gas |fuel )?(?:mileage|odometer(?: reading)?|odo)\b(?:\s+(?:is|of|reads|reading|shows|showing|says|at|now))*\s*[:\-–]?\s*(?:(?:only|just)\s+)?(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand)\b)?/gi;
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
export const PRICE_CHANGE = /\b(?:price (?:drop(?:ped)?|reduced|reduction|cut)|reduced price|just reduced|marked down|was \$|now (?:just |only )?\$)/i;
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

function shouting(text: unknown): boolean {
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

function emojiCount(text: unknown): number {
  return (String(text || '').match(/\p{Extended_Pictographic}/gu) || []).length;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const BANNED_RE: Array<[string, RegExp]> = BANNED_PHRASES.map((p) => [p, new RegExp('\\b' + escapeRe(p).replace(/[\s-]+/g, '[\\s-]+') + '\\b', 'i')]);
// "one owner", "1-owner", "single-owner", "one careful owner", "only one
// previous owner", "its sole owner", "owned by one family"
const ONE_OWNER = /\b(?:(?:one|1|single)[\s-]+(?:(?!(?:new|next|more|other|of|the|a|an|its|your|lucky)\b)[a-z']+[\s-]+){0,2}owner|(?:sole|only) owner|owned by (?:one|a single))\b/i;

// ---------- claims only the website can make ----------
// What a description says about the car's certification, warranty,
// financing, history, care, parts or condition comes from the website's own
// words for this car (here: the facts' write-up, features and the rest of
// the record) or the dealer's price note, never from the writer. Each kind
// is found by its words, and passes when words of the same kind are in those
// sources (new parts: the same part, too). The dealership's name, its city and the role are
// set aside first, as are banned phrases (flagged on their own).
interface ClaimKind {
  what: string;
  re: RegExp;
  part?: boolean;
}
const PARTS = 'tires?|tyres?|brakes?|rotors?|pads|battery|batteries|wipers?|shocks?|struts?|exhaust|alternator|starter|clutch|timing (?:belt|chain)|water pump|engine|motor|transmission|paint|parts';
export const CLAIM_KINDS: readonly ClaimKind[] = Object.freeze([
  { what: 'certification', re: /\b(?:certified|cpo)\b/i },
  { what: 'a warranty or guarantee', re: /\b(?:warrant(?:y|ies|eed)|guarantee[ds]?)\b/i },
  { what: 'financing or credit', re: /\b(?:financ\w*|credit|approv\w*|loans?|lenders?|apr|down[\s-]payments?|monthly payments?|per month|lease\w*|buy[\s-]here)\b/i },
  { what: 'accident, damage or title history', re: /\b(?:accidents?|collisions?|wreck(?:s|ed)?|damaged?|flood\w*|salvage|rebuilt|titles?|clean (?:carfax|autocheck|history|record|report))\b/i },
  { what: 'smoking or pets', re: /\b(?:non[\s-]?smok\w*|smok(?:er|ers|ing|ed)|smoke[\s-]?free|pet[\s-]?free|no pets)\b/i },
  { what: 'service history, inspection or upkeep', re: /\b(?:inspect\w*|serviced|service (?:history|records?)|maintenance|maintained|oil changes?|tune[\s-]?up|reconditioned|garage[\s-]kept|well[\s-](?:kept|cared)|taken care of)\b/i },
  { what: 'new or replaced parts', re: new RegExp(`\\b(?:(?:brand[\\s-])?new|newer|fresh|replaced|recent)\\s+(?:set of\\s+)?(${PARTS})\\b`, 'i'), part: true },
  { what: 'its condition', re: /\b(?:(?:excellent|great|good|pristine|immaculate|showroom|top|amazing|beautiful|clean) (?:condition|shape)|runs (?:great|strong|well|smooth\w*|excellent)|drives (?:great|well|smooth\w*|excellent)|mechanically sound|needs nothing|turn[\s-]?key|rust[\s-]free|no (?:rust|dents|problems))\b/i },
]);

// The write-up split at its line breaks, markup set aside, spacing made
// plain, as the extension's template copies it (here the facts' narrative
// is already plain text, so this changes nothing but the spacing).
function writeUpText(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  return raw.split(/<br\s*\/?>/i).map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
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

// Every claim in the text, not only the first of each kind: one part the
// facts name never covers another the draft adds. Each kind the sources
// don't make is said once; each new part they don't name is said once.
function claimProblems(text: string, ctx: GuardrailContext): GuardrailProblem[] {
  const source = claimSource(ctx);
  const problems: GuardrailProblem[] = [];
  for (const kind of CLAIM_KINDS) {
    if (kind.what === 'certification' && listedCertified(ctx.vehicle)) continue;
    const sourced = kind.re.test(source);
    const said = new Set<string>();
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
  // the car's own words: without the dealership's name, its city and the role, which are not claims about it
  const role = String((salesperson && salesperson.title) || DEFAULT_SALESPERSON_TITLE).replace(/\s+/g, ' ').trim();
  const aboutCar = without(prose, [dealer.name, dealer.city, role]);
  const sourceWords = claimSource({ vehicle, priceNote });
  const spelled = new Set<string>();
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
  return { ok: problems.length === 0, problems, words };
}
