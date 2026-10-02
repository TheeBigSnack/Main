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
const OPEN_SENTENCE = /[^.!?:;)"'\u201d]$/;
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// The description's lines as the website lays them out: one list of lines
// per paragraph, division or list item, split at its plain line breaks.
function linesOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(BLOCK_BREAK).map((block) => block.split(/\r\n|\r|\n/).map(plain).filter(Boolean)).filter((lines) => lines.length);
}

// A piece of text that ends as a sentence does, and one that starts as a
// sentence does: its first letter or digit is a capital or a digit, with
// nothing before it but opening punctuation ("(", "\u201c", "\u00a1",
// "\u00bf"), quotes or emoji. A piece that starts in lower case ("warranty
// of any kind.", "brakes and tires.") carries on a sentence begun before it.
export const ENDS_SENTENCE = /[.!?][\p{Pe}\p{Pf}"']*$/u;
export const STARTS_SENTENCE = /^[\s\p{Ps}\p{Pi}"'\u00a1\u00bf\p{Extended_Pictographic}\ufe0f\u200d]*[\p{Lu}\p{N}]/u;

// A full stop after an abbreviation does not end a sentence: "the original
// Mfr. Warranty", "approx. two keys", "a Jeep Cert. Pre-Owned unit". An
// abbreviation is a single letter or letters with full stops between them
// ("J.", "U.S.", "e.g."), a word on this list, or a word in lower case or
// mixed case with no vowel ("Mfr.", "pkg.", "St.", "Ltd."), except right
// after a number, where it is a unit ("30 mpg.", "395 hp."). A word in
// capitals with no vowel ("RWD.", "SLT.") is the car's own name, not one.
const ABBREVIATIONS = new Set([
  'approx', 'appx', 'incl', 'excl', 'est', 'orig', 'cert', 'certif', 'manuf', 'mfr', 'mfrs', 'mfg', 'pkg', 'pkgs', 'warr',
  'opt', 'opts', 'equip', 'avail', 'eq', 'misc', 'vs', 'no', 'nos', 'inc', 'co', 'corp', 'llc', 'ave', 'hwy', 'pkwy', 'ste',
  'apt', 'dept', 'bros', 'gen', 'gov', 'prof', 'capt', 'col', 'rev', 'yr', 'yrs', 'mo', 'mos', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'prem', 'nav', 'sys', 'reg', 'ext', 'int', 'adj', 'elec', 'alum',
  'conv', 'susp', 'trans', 'eng', 'cyl', 'cap', 'gal', 'ea', 'ref', 'vol', 'sec', 'temp',
]);
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

// Whether a piece of text finishes a sentence: it ends as a sentence does,
// and not on an abbreviation.
export const finishesSentence = (text) => ENDS_SENTENCE.test(String(text ?? '').trimEnd()) && !endsAtAbbreviation(text);

// A plain line break that only wraps a sentence: the line before stops on an
// abbreviation ("approx.", "the original mfr."), or it leaves the sentence
// open and either the next line carries on in lower case or the line before
// stops on a comma, a dash or a word in lower case ("comes with the", "new"),
// whatever the next line starts with ("Michelin", "3.6L"). A heading or a
// title stops on neither ("Dealer Comments:", "Vehicle Highlights", "2019
// Jeep Grand Cherokee Limited"), so it keeps its own line, and a list item
// ("- Heated seats") never joins the line before it.
const wraps = (before, next) =>
  !/^[-\u2022*]\s/.test(next) && (endsAtAbbreviation(before) || (OPEN_SENTENCE.test(before) && (/^[a-z]/.test(next) || /(?:[,\u2013\u2014-]|\b[a-z][a-z'\u2019]*)$/.test(before))));

// The description's segments: its lines, with each wrapped line joined to the
// one before it. `keep` gives what is kept of each line ('' leaves it out)
// before lines are joined, so a lot-wide line between two lines of a car's
// own write-up never ends up inside it. Each segment carries `before`, the
// line the website shows right before it (null for the first), whether or
// not that line was kept.
function segmentsOf(raw, keep = (line) => line) {
  const out = [];
  let lastLine = null;
  for (const lines of linesOf(raw)) {
    let seg = null;
    for (const line of lines) {
      const text = keep(line);
      if (text) {
        if (seg && wraps(seg.text, text)) seg.text += ` ${text}`;
        else out.push((seg = { text, before: lastLine }));
      }
      lastLine = line;
    }
  }
  return out;
}

export function splitSegments(raw, keep = (line) => line) {
  return segmentsOf(raw, keep).map((seg) => seg.text);
}

// The sentences of one segment: split after ".", "!" or "?", except that a
// piece stays with the one before it when that one stops on an abbreviation
// ("the original Mfr. Warranty applies", "approx. Two keys") or when the
// piece does not start as a sentence does ("tow pkg. and a bed liner").
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
// at the start of a segment, ahead of a raw equipment dump.
const CARFAX_PREFIX = /^(recent arrival!?\s*)?((carfax one-?owner|clean carfax)\.?\s*)+/i;

function looksLikeBullet(segment) {
  return /^[-•*]\s+/.test(segment);
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
// gave ("Exclusions:", "Known issues:"), so that next line never starts
// the write-up line.
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

// A segment starts a sentence on the website when it comes first, or the
// line right before it finished a sentence (not on an abbreviation such as
// "Mfr.") or is a heading, and it starts as a sentence does. Any other
// segment may carry on a sentence the website broke across a line break, a
// paragraph or a list item ("...is not a Jeep" + "Certified Pre-Owned
// vehicle.", "Sold without:" + "Warranty of any kind."), and read alone it
// can say the opposite of the website; so may the one after a title with no
// colon ("Vehicle Highlights").
const startsAfter = (before) => before === null || finishesSentence(before) || isHeading(before);

// The car-specific narrative left after boilerplate, award blurbs, feature
// bullets and raw equipment dumps are removed: one { text, opens, lead } per
// segment, with any lot-wide sentence or equipment list inside it taken out
// and the rest of the segment kept as written. `opens` is whether the
// segment starts a sentence on the website, judged against the line the
// website shows right before it, even one left out here; it is false when
// the segment starts with an equipment list, or comes right after a bullet,
// an award line or an equipment list ("Not included: Heated Seats, ...").
// `lead` is the segment's own sentences up to the first equipment list
// taken out of it.
export function writeUpParts(raw, boilerplate = new Set()) {
  const kept = [];
  // a lot-wide line, or a lot-wide sentence in a line, goes before wrapped lines are joined
  const own = (line) => (boilerplate.has(line) ? '' : splitSentences(line).filter((s) => !boilerplate.has(s)).join(' '));
  let afterList = false;
  for (const { text: seg, before } of segmentsOf(raw, own)) {
    const opens = !afterList && startsAfter(before) && STARTS_SENTENCE.test(seg);
    afterList = false;
    if (boilerplate.has(seg)) continue;
    if (AWARDS_PREFIX.test(seg) || looksLikeBullet(seg)) {
      afterList = true;
      continue;
    }
    const carText = splitSentences(seg).filter((s) => !boilerplate.has(s)).join(' ');
    const sentences = splitSentences(carText.replace(CARFAX_PREFIX, '').trim());
    const list = sentences.findIndex(looksLikeEquipmentDump);
    afterList = sentences.length > 0 && looksLikeEquipmentDump(sentences[sentences.length - 1]);
    const text = sentences.filter((s) => !looksLikeEquipmentDump(s)).join(' ');
    const lead = (list === -1 ? sentences : sentences.slice(0, list)).join(' ');
    if (text) kept.push({ text, opens: opens && list !== 0 && STARTS_SENTENCE.test(text), lead });
  }
  return kept;
}

// The narrative as plain strings, one per segment (what the rewrite service
// is sent and the side panel keeps).
export function cleanDescription(raw, boilerplate = new Set()) {
  return writeUpParts(raw, boilerplate).map((p) => p.text);
}

// The one segment the template's write-up line may come from: the
// write-up's first, passing over headings ("Dealer Comments:"), and only
// when it starts a sentence on the website (writeUpParts' `opens`); that
// segment's `lead` is returned. No later segment is ever read instead or
// added to it: when the first does not start a sentence there is none ('').
// A part that is not writeUpParts' { text, opens, lead } (a plain string)
// never starts one.
export function openingSegment(parts) {
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part && typeof part === 'object' && isHeading(part.text)) continue;
    return part && typeof part === 'object' && part.opens === true ? String(part.lead ?? part.text ?? '') : '';
  }
  return '';
}
