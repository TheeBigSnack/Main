// The guardrails, ported line for line from extension/src/rewriteTemplate.js
// (the parts backend/server.js used: runGuardrails and its helpers) so the
// Edge Function checks Claude's draft the same way the extension does before
// the salesperson sees it. The template writer itself stays in the extension;
// only the checks live here.
//
// Rules from the build brief, enforced here:
//   - 60-120 words (the VIN line does not count)
//   - every number in the text must be in the website's data for the car
//   - a price note quoting a dollar amount must match the car's two-price gap
//   - the VIN and the dealership's name must be present (a dealership with
//     no name set fails), and so must the salesperson's role (their title,
//     or the default one)
//   - banned phrases (claims the data can't support, posing as a private
//     seller, protected characteristics), "one owner" only with the flag,
//     no ALL CAPS shouting, no walls of emoji
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
// case-insensitively. A false positive only means the template is used.
export const BANNED_PHRASES: readonly string[] = Object.freeze([
  // claims the website's data can't support
  'best price in town', 'lowest price', 'best deal', 'no accidents', 'accident free', 'accident-free',
  'never been in an accident', 'clean title', 'no issues', 'runs perfect', 'runs perfectly', 'perfect condition',
  'mint condition', 'like new', 'flawless', "everyone's approved", 'everyone approved', 'guaranteed approval',
  'guaranteed financing', 'bad credit ok', 'no credit check', 'must sell', 'priced to sell', "won't last", 'wont last',
  'act fast', 'no reasonable offer refused',
  // posing as a private seller
  'private seller', 'selling my', 'my personal', 'my truck', 'my car', 'my suv', 'my daily driver',
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
const BANNED_RE: Array<[string, RegExp]> = BANNED_PHRASES.map((p) => [p, new RegExp('\\b' + escapeRe(p).replace(/\s+/g, '\\s+') + '\\b', 'i')]);

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
  const vin = String(vehicle.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin && !t.toUpperCase().includes(vin)) problems.push({ code: 'no-vin', text: "Doesn't include the VIN" });
  for (const [phrase, re] of BANNED_RE) {
    if (re.test(t)) problems.push({ code: 'banned-phrase', text: `Says "${phrase}"` });
  }
  if (/\b(one|1|single)[- ]owner\b/i.test(t) && !vehicle.carfaxOneOwner) {
    problems.push({ code: 'one-owner', text: "Says one owner, but the Carfax one-owner flag isn't set" });
  }
  // who is posting: the dealership and the salesperson's role, in every description
  const dealerName = String(dealer.name || '').trim();
  if (!dealerName) problems.push({ code: 'no-dealer', text: "The dealership's name isn't set; add it in Settings" });
  else if (!t.toLowerCase().includes(dealerName.toLowerCase())) problems.push({ code: 'no-dealer', text: `Doesn't name ${dealerName}` });
  const role = roleOf(salesperson);
  if (role && !t.replace(/\s+/g, ' ').toLowerCase().includes(role.toLowerCase())) problems.push({ code: 'no-role', text: `Doesn't give your role (${role})` });
  if (shouting(t)) problems.push({ code: 'all-caps', text: 'Has ALL CAPS shouting' });
  if (emojiCount(t) > 3) problems.push({ code: 'emoji', text: 'Too many emoji' });
  return { ok: problems.length === 0, problems, words };
}
