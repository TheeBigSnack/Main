// Cleans the dealer website's per-car "description" field so the rewriter
// only draws from real, car-specific text.
//
// Verified directly against ronlewischryslerdodgejeepramwaynesburg.com on
// 2026-09-26 by reading the search service's `description` field for several
// real cars and comparing it to the vehicle detail page (they match). On
// this site the field mixes three things:
//   1. A pricing/legal disclaimer paragraph that repeats on almost every car
//      ("Ron Lewis Real Price includes all costs...").
//   2. On cars nobody has written up yet: a "CARFAX One-Owner." / "Recent
//      Arrival!" prefix followed by a raw, comma-separated equipment dump
//      pulled straight from the options list (e.g. the 2021 Ram 1500 TRX and
//      2025 Ram 1500 Tradesman on the live site).
//   3. On cars someone (or a vendor tool) has written up: a real paragraph of
//      unique marketing copy, followed by a bullet list of features that
//      duplicates the structured `features` field (e.g. the 2019 Ram 1500
//      Laramie and 2023 Honda Pilot Touring on the live site).
//
// The rewriter should only ever draw on (3), and only the paragraph, not the
// bullets (the structured `features` field already covers those cleanly).

// A website separates the parts of a description in different ways: line
// breaks (<br>), paragraphs, divisions or list items, or plain line breaks
// in the text itself (a schema.org or inventory-feed description). Each of
// those ends a line; other markup is set aside.
const BLOCK_BREAK = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|dt|dd|section|article|blockquote)\b[^>]*>/i;
// A line that leaves a sentence open: it ends in anything but a full stop,
// "!", "?", a colon, a semicolon, a closing bracket or a quote.
const OPEN_SENTENCE = /[^.!?:;\p{Pe}\p{Pf}"']$/u;
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// The description's lines as the website lays them out: one list of lines
// per paragraph, division or list item, split at its plain line breaks.
function linesOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(BLOCK_BREAK).map((block) => block.split(/\r\n|\r|\n/).map(plain).filter(Boolean)).filter((lines) => lines.length);
}

// A piece of text that starts as a sentence does: its first letter or digit
// is a capital or a digit, with nothing before it but opening punctuation
// ("(", "\u201c", "\u00a1", "\u00bf"), quotes or emoji. A piece that starts
// in lower case ("warranty of any kind.", "brakes and tires.") carries on a
// sentence begun before it.
export const STARTS_SENTENCE = /^[\s\p{Ps}\p{Pi}"'\u00a1\u00bf\p{Extended_Pictographic}\ufe0f\u200d]*[\p{Lu}\p{N}]/u;

// Words a full stop can follow without ending a sentence: "approx. two
// keys", "the original mfr. Warranty", "a Jeep Cert. Pre-Owned unit".
const ABBREVIATIONS = new Set([
  'approx', 'appx', 'incl', 'excl', 'est', 'orig', 'cert', 'certif', 'manuf', 'mfr', 'mfrs', 'mfg', 'pkg', 'pkgs', 'warr',
  'opt', 'opts', 'equip', 'avail', 'eq', 'misc', 'vs', 'no', 'nos', 'inc', 'co', 'corp', 'llc', 'ave', 'hwy', 'pkwy', 'ste',
  'apt', 'dept', 'bros', 'gen', 'gov', 'prof', 'capt', 'col', 'rev', 'yr', 'yrs', 'mo', 'mos', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'prem', 'nav', 'sys', 'reg', 'ext', 'int', 'adj', 'elec', 'alum',
  'conv', 'susp', 'trans', 'eng', 'cyl', 'cap', 'gal', 'ea', 'ref', 'vol', 'sec', 'temp', 'etc', 'avg', 'max', 'min', 'std',
  'auth', 'tech', 'lux', 'perf', 'lim', 'plat', 'addl', 'asst', 'exec', 'intl', 'natl', 'cir', 'rte', 'tel', 'viz', 'ca',
  'esp', 'cu', 'mi', 'req', 'reqd', 'dia', 'diam', 'acc', 'accs', 'awd', 'dlr', 'svc', 'qty', 'ltd', 'pwr', 'htd',
  'appt', 'mem', 'leath', 'util', 'veh', 'oac', 'wac', 'addtl',
]);
// For the write-up line only, these words too: they can end a sentence, but
// a full stop after them is as often a unit or a short form ("20 in.
// Wheels", "8-speed auto. Transmission", "pass. Seat", "open sat. Morning").
const MAYBE_ABBREVIATIONS = new Set(['in', 'auto', 'man', 'pass', 'fin', 'ins', 'dep', 'doc', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun']);

// For finding lot-wide text and for the narrative the rewrite service gets: a
// full stop after an abbreviation does not end a sentence. An abbreviation is
// a single letter or letters with full stops between them ("J.", "U.S.",
// "e.g."), a word on the list above, or a word in lower case or mixed case
// with no vowel ("Mfr.", "pkg.", "St.", "Ltd."), except right after a
// number, where it is a unit ("30 mpg.", "395 hp."). A word in capitals with
// no vowel ("RWD.", "SLT.") is the car's own name, not one.
export function endsAtAbbreviation(text) {
  const t = String(text ?? '').trimEnd();
  if (!t.endsWith('.')) return false;
  const tokens = t.slice(0, -1).split(/\s+/);
  const word = tokens[tokens.length - 1].replace(/^[\p{Ps}\p{Pi}"'\u00a1\u00bf]+/u, '');
  const before = tokens.length > 1 ? tokens[tokens.length - 2] : '';
  if (/^(?:\p{L}\.)*\p{L}$/u.test(word)) return true;
  if (!/^\p{L}+$/u.test(word)) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  return /\p{Ll}/u.test(word) && !/[aeiouy\u00e0-\u00ff]/i.test(word) && !/\d$/.test(before);
}

// A plain line break that only wraps a sentence: the next line starts in
// lower case, or the line before stops on an abbreviation ("approx.", "the
// original mfr."), or it leaves the sentence open and stops on a comma, a
// dash or a word in lower case ("comes with the", "new"), whatever the next
// line starts with ("Michelin", "3.6L"). A heading or a title stops on
// neither ("Dealer Comments:", "Vehicle Highlights", "2019 Jeep Grand
// Cherokee Limited"), so it keeps its own line, and a list item ("- Heated
// seats") never joins the line before it.
const wraps = (before, next) =>
  !/^[-\u2022*]\s/.test(next) &&
  (/^\p{Ll}/u.test(next) || endsAtAbbreviation(before) || (OPEN_SENTENCE.test(before) && /(?:[,\u2013\u2014-]|(?<![\p{L}\p{N}])\p{Ll}[\p{Ll}'\u2019]*)$/u.test(before)));

// The description's segments: its lines, with each wrapped line joined to the
// one before it. `keep` gives what is kept of each line ('' leaves it out)
// before lines are joined, so a lot-wide line between two lines of a car's
// own write-up never ends up inside it.
export function splitSegments(raw, keep = (line) => line) {
  const out = [];
  for (const lines of linesOf(raw)) {
    let open = false; // a segment of this paragraph is open to be joined
    for (const line of lines) {
      const text = keep(line);
      if (!text) continue;
      if (open && wraps(out[out.length - 1], text)) out[out.length - 1] += ` ${text}`;
      else out.push(text);
      open = true;
    }
  }
  return out;
}

// The sentences of one segment, for finding lot-wide text and for the
// narrative the rewrite service gets (not for what the template copies; see
// openingSentences): split after ".", "!" or "?", except that a piece stays
// with the one before it when that one stops on an abbreviation ("the
// original Mfr. Warranty applies", "approx. Two keys") or when the piece does
// not start as a sentence does ("tow pkg. and a bed liner").
export function splitSentences(segment) {
  const out = [];
  for (const piece of String(segment || '').split(/(?<=[.!?])\s+/).filter(Boolean)) {
    if (out.length && (endsAtAbbreviation(out[out.length - 1]) || !STARTS_SENTENCE.test(piece))) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

// The absolute floor under the share: a share alone misbehaves on a tiny
// lot (with 3 cars, any sentence in one car is already 33%, and a 2-car lot
// would lose every sentence the two share). A segment is boilerplate only
// when it appears in at least this many descriptions AND in the share, so a
// 3-car lot and a 124-car lot both behave: on 3 cars only a sentence on all
// three goes, on 124 the share decides.
export const MIN_BOILERPLATE_COUNT = 3;

// A segment that repeats across a large share of the current lot's
// descriptions is boilerplate (a disclaimer, a legal paragraph), not
// anything specific to one car. So is a line or a sentence that repeats that
// way, so a disclaimer the website runs on from a car's own write-up, with no
// break between them or after a line that wraps, is found too. Default
// threshold matches the brief: ~30%, with MIN_BOILERPLATE_COUNT as the floor
// for all of them. Both are re-derived from each website's own lot on every
// scan; nothing about one lot is kept.
export function findBoilerplate(allDescriptions, threshold = 0.3, minCount = MIN_BOILERPLATE_COUNT) {
  const counts = new Map();
  const total = Array.isArray(allDescriptions) ? allDescriptions.length : 0;
  for (const raw of allDescriptions || []) {
    const seen = new Set();
    // each line as the website lays it out, each segment once wrapped lines
    // are joined, and the sentences of both
    for (const text of [...linesOf(raw).flat(), ...splitSegments(raw)]) {
      seen.add(text);
      for (const sentence of splitSentences(text)) seen.add(sentence);
    }
    for (const text of seen) counts.set(text, (counts.get(text) || 0) + 1);
  }
  const boilerplate = new Set();
  if (total > 0) {
    for (const [text, count] of counts) {
      if (count >= minCount && count / total >= threshold) boilerplate.add(text);
    }
  }
  return boilerplate;
}

const AWARDS_PREFIX = /^awards?\s*:/i;
// "CARFAX One-Owner.", "Clean CARFAX.", "Recent Arrival!" in any combination
// at the start of a line, ahead of the write-up or a raw equipment dump. Each
// is set aside only when it ends in "." or "!" and what follows starts with a
// capital or a digit (or nothing follows): "Clean CARFAX Not Available On
// This Unit." and "Clean Carfax except one reported accident." are sentences
// that start with those words, and are kept whole.
const LABEL = /^(?:recent arrival|carfax one-?owner|clean carfax)/i;
function withoutLabels(text) {
  let t = text;
  for (let m; (m = /^(?:recent arrival|carfax one-?owner|clean carfax)[.!](?:\s+|$)/i.exec(t)); ) {
    const rest = t.slice(m[0].length);
    if (rest && !/^[\p{Lu}\p{N}]/u.test(rest)) break;
    t = rest;
  }
  return t;
}

function looksLikeBullet(segment) {
  return /^[-\u2022*]\s+/.test(segment);
}

// A raw equipment dump has no real sentences, just a long comma list of
// feature/option names pulled from the options field. A list the website
// breaks into short "sentences" ("Heated Seats, Navigation, Sunroof.") is one
// too: three or more items, each a name of three words or fewer, with none of
// the small words a sentence has ("Comes with Navigation, Heated Seats,
// Sunroof." is a sentence).
const SENTENCE_WORD = /\b(?:with|has|have|is|are|was|comes|come|the|a|an|of|for|to|in|on|this|it|its)\b/;
function looksLikeEquipmentDump(text) {
  const commas = text.split(',').length - 1;
  if (commas >= 6) return true;
  const items = text.replace(/[.!?]+$/, '').split(/\s*,\s*(?:and\s+|&\s+)?/);
  return items.length >= 3 && items.every((item) => /^[A-Z0-9]/.test(item) && item.split(/\s+/).length <= 3 && !SENTENCE_WORD.test(item));
}

// A heading: a line of at most four words that ends in a colon and only
// names a part of the write-up, in words from this list ("Dealer
// Comments:", "Vehicle Highlights:", "About this vehicle:", "Manager's
// Notes:"). After any other line that ends in a colon the next line may
// finish what it began ("This vehicle does not come with:", "The previous
// owner removed the following:", "Sold without:") or carry a meaning it
// gave ("Exclusions:", "Known issues:"), so the write-up line is never taken
// from past it.
const HEADING_MAX_WORDS = 4;
const HEADING_WORDS = new Set([
  'dealer', 'dealers', 'dealership', 'comments', 'comment', 'notes', 'note', 'remarks', 'description', 'overview', 'summary',
  'details', 'detail', 'info', 'information', 'highlights', 'highlight', 'features', 'feature', 'options', 'equipment', 'specs',
  'specifications', 'facts', 'vehicle', 'car', 'truck', 'suv', 'van', 'about', 'this', 'the', 'our', 'sales', 'manager',
  'key', 'quick', 'more', 'additional', 'why', 'buy', 'from', 'us', 'please', 'read', 'and', '&',
]);
export function isHeading(line) {
  const t = String(line ?? '').trim();
  if (!/:$/.test(t)) return false;
  const words = t.slice(0, -1).trim().split(/\s+/).map((w) => w.toLowerCase().replace(/['\u2019]s$/, ''));
  return words.length <= HEADING_MAX_WORDS && words.every((w) => HEADING_WORDS.has(w));
}

// The car-specific narrative left after boilerplate, award blurbs, feature
// bullets, Carfax and arrival labels and raw equipment dumps are removed:
// one string per segment, with any lot-wide sentence or equipment list inside
// it taken out and the rest of the segment kept as written. This is what the
// rewrite service is sent and the side panel keeps; the template's own
// write-up line comes from openingSentences.
export function cleanDescription(raw, boilerplate = new Set()) {
  const kept = [];
  // a lot-wide line, or a lot-wide sentence in a line, goes before wrapped lines are joined
  const own = (line) => (boilerplate.has(line) ? '' : splitSentences(line).filter((s) => !boilerplate.has(s)).join(' '));
  for (const seg of splitSegments(raw, own)) {
    if (boilerplate.has(seg) || AWARDS_PREFIX.test(seg) || looksLikeBullet(seg)) continue;
    const carText = splitSentences(seg).filter((s) => !boilerplate.has(s)).join(' ');
    const text = splitSentences(withoutLabels(carText).trim()).filter((s) => !looksLikeEquipmentDump(s)).join(' ');
    if (text) kept.push(text);
  }
  return kept;
}

// ---------- the template's write-up line ----------
// What the template copies has to be the website's own whole sentences, so
// it is cut only where a sentence is clearly over. A clear end is a single
// ".", "!" or "?" (never "..", "..." or "?!") followed by a space and then a
// capital letter or a digit, or by nothing at all. Before "." or "!" comes a
// word in lower-case letters only (a hyphen or an apostrophe may join two),
// with a vowel and at least two letters, that is not an abbreviation
// ("approx.", "tech.", "in.": both lists above); before "?", any letter or
// digit. Anything else is unclear and does not end a sentence: a capitalised
// or all-caps word ("Auto.", "Tech.", "DLR.", "No.", "Yahoo!"), a number
// ("2019.", "1."), an ellipsis, a closing quote or bracket, or a word in
// lower case with no vowel ("mfr.", "pkg."). A word in lower case, with a
// vowel, that is an abbreviation the lists do not know ("the conven.
// Package") still reads as a clear end.
const VOWEL = /[aeiou\u00e0-\u00e6\u00e8-\u00ef\u00f2-\u00f6\u00f9-\u00fc]/i;
function clearEndAt(text, at) {
  const before = text.slice(0, at);
  const after = text.slice(at + 1).trimStart();
  if (/[.!?\u2026]$/.test(before) || (after && !/^[\p{Lu}\p{N}]/u.test(after))) return false;
  if (text[at] === '?') return /[\p{L}\p{N}]$/u.test(before);
  const word = before.slice(before.search(/\S*$/));
  if (!/^\p{Ll}+(?:[-'\u2019]\p{Ll}+)*$/u.test(word) || !VOWEL.test(word) || word.replace(/[-'\u2019]/g, '').length < 2) return false;
  return ![word, word.split(/[-'\u2019]/).pop()].some((w) => ABBREVIATIONS.has(w) || MAYBE_ABBREVIATIONS.has(w));
}

// The pieces of a text cut at its clear ends, each with where it starts and
// ends and whether it ends clearly (only the last piece can end unclearly).
function clearPieces(text) {
  const out = [];
  let start = 0;
  const push = (end, clear) => {
    const from = start + (text.slice(start).length - text.slice(start).trimStart().length);
    if (from < end) out.push({ text: text.slice(from, end).trim(), start: from, end, clear });
  };
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    if (!clearEndAt(text, m.index)) continue;
    push(m.index + 1, true);
    start = m.index + 1;
  }
  push(text.length, false);
  return out;
}

// Words after a sentence that carry it on, or take it back: what follows
// starts in lower case, with a comma, a semicolon, a colon, a closing
// bracket, a dash or dots, or with one of these words ("Except it
// expired.", "Not!").
const CARRIES_ON = /^(?:[,;:)\]}\u2026\u2013\u2014]|\.\.|(?:[-\u2022*]\s+)?[\p{Ps}\p{Pi}"'\u00a1\u00bf]*\p{Ll})/u;
const CARRIES_ON_WORD = /^(?:[-\u2022*]\s+)?["'\u201c\u2018(]*(?:and|or|nor|but|yet|except|excepting|excluding|without|minus|not|unless|until|though|although|however|whereas|otherwise|instead)\b/i;
const carriesOn = (next) => typeof next === 'string' && (CARRIES_ON.test(next) || CARRIES_ON_WORD.test(next));

// Where a lot-wide line or sentence sits in a text: [start, end] spans.
function lotWideSpans(text, boilerplate) {
  const spans = [];
  for (const entry of boilerplate) {
    if (typeof entry !== 'string' || !entry) continue;
    for (let at = text.indexOf(entry); at !== -1; at = text.indexOf(entry, at + 1)) {
      const end = at + entry.length;
      if ((at === 0 || /\s/.test(text[at - 1])) && (end === text.length || /\s/.test(text[end]))) spans.push([at, end]);
    }
  }
  return spans;
}

// The sentences the template may copy as the description's write-up line:
// the website's own opening sentences, whole, in order, and nothing after the
// first one it cannot copy.
//  - The write-up's first line is where they start, after any headings
//    ("Dealer Comments:") and labels ("CARFAX One-Owner.", "Recent Arrival!")
//    on lines of their own. That line has to start a sentence (a capital
//    letter or a digit, after any opening punctuation) and not be a bullet,
//    a numbered item, an "Awards:" line or a label that does not end in "."
//    or "!" ("Clean CARFAX Not Available"), nor, after a heading or a label,
//    start with words that carry it on (carriesOn below: "Clean CARFAX." +
//    "Not available."); otherwise nothing is copied. No later line is ever
//    read instead: a line after a lot-wide line, a title or a line that did
//    not end a sentence may carry on from it.
//  - Lines the website's text wraps (wraps above) are read as one, up to a
//    paragraph, a <br> or a lot-wide line.
//  - The text is cut at clear ends only (clearEndAt), and the sentences are
//    taken in order until the first one that does not end clearly, holds
//    lot-wide text, is a list of equipment, or that `accept(sentence,
//    taken)` refuses (the template's own checks and limits).
//  - The last sentence taken is given back while it is a question (its
//    answer may follow: "Smoker? No.") or the words after it, in the same
//    line or the next line the website shows, carry it on (carriesOn:
//    "warranty.<br>until it expired").
export function openingSentences(raw, boilerplate = new Set(), accept = () => true) {
  const lines = linesOf(raw).flatMap((block, b) => block.map((text) => ({ text, block: b })));
  let i = 0;
  while (i < lines.length && (isHeading(lines[i].text) || !withoutLabels(lines[i].text))) i += 1;
  if (i === lines.length) return [];
  let segment = lines[i].text;
  let j = i + 1;
  while (j < lines.length && lines[j].block === lines[i].block && !boilerplate.has(lines[j].text) && wraps(segment, lines[j].text)) {
    segment += ` ${lines[j].text}`;
    j += 1;
  }
  const after = j < lines.length ? lines[j].text : null;
  const text = withoutLabels(segment);
  if (LABEL.test(text) || AWARDS_PREFIX.test(text) || looksLikeBullet(text) || /^\d+[.)]\s/.test(text) || !STARTS_SENTENCE.test(text)) return [];
  // after a heading or a label it passed over, a line that carries it on ("Clean CARFAX." + "Not available.") gives nothing
  if ((i > 0 || text !== segment) && carriesOn(text)) return [];
  const pieces = clearPieces(text);
  const lotWide = lotWideSpans(text, boilerplate);
  const taken = [];
  for (const [k, p] of pieces.entries()) {
    if (!p.clear || lotWide.some(([a, b]) => a < p.end && b > p.start) || looksLikeEquipmentDump(p.text)) break;
    if (!accept(p.text, taken.map((t) => t.text))) break;
    taken.push({ text: p.text, next: k + 1 < pieces.length ? pieces[k + 1].text : after });
  }
  while (taken.length && (taken[taken.length - 1].text.endsWith('?') || carriesOn(taken[taken.length - 1].next))) taken.pop();
  return taken.map((t) => t.text);
}
