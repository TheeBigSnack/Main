// Reads the dealer website's per-car "description" field: finds the text
// the whole lot shares, and gives the optional rewrite service only real,
// car-specific text to draw on. The template writer never copies any of it
// (rewriteTemplate.js); the checks read all of it as the website's own words.
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
// The rewriter should only ever draw on (3), and never on a piece of a
// sentence: what it gets is whole segments of the write-up, from its first,
// up to the first part it leaves out (cleanDescription).

// A website separates the parts of a description in different ways: line
// breaks (<br>), paragraphs, divisions or list items, or plain line breaks
// in the text itself (a schema.org or inventory-feed description). Each of
// those ends a line; other markup is set aside.
const BLOCK_BREAK = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|dt|dd|section|article|blockquote)\b[^>]*>/i;
const OPEN_SENTENCE = /[^.!?:;)"'”]$/;

// The HTML entities a website's description carries ("&nbsp;", "&amp;",
// "&#8217;"), read as the characters they stand for once the markup is set
// aside; a name not on this list is left as written. The same table as the
// standard-data reader's (adapters/schemaOrgParse.js), kept here so this
// shared code takes nothing from a platform's.
const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  deg: '°', times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  cent: '¢', pound: '£', euro: '€', yen: '¥', sect: '§', para: '¶', micro: 'µ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä',
}));
function decodeEntities(s) {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, name) => {
    if (name[0] === '#') {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.get(name) ?? ENTITIES.get(name.toLowerCase()) ?? whole;
  });
}

// A line as plain text: markup set aside, entities decoded, invisible
// format characters (zero-width spaces, word joiners, soft hyphens,
// direction marks: Unicode's Cf) dropped, spacing made plain. So
// "great.<br>&nbsp;except" and "great.<br>&#8203;except" (a zero-width
// space) read as the page shows them.
const plain = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();

// The description's lines as the website lays them out: one list of lines
// per paragraph, division or list item, split at its plain line breaks.
function linesOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(BLOCK_BREAK).map((block) => block.split(/\r\n|\r|\n/).map(plain).filter(Boolean)).filter((lines) => lines.length);
}

// A piece of text that ends as a sentence does, and one that starts as a
// sentence does: its first letter or digit is a capital or a digit, with
// nothing before it but opening punctuation ("(", "“", "¡",
// "¿"), quotes or emoji. A piece that starts in lower case ("warranty
// of any kind.", "brakes and tires.") carries on a sentence begun before it.
const ENDS_SENTENCE = /[.!?][\p{Pe}\p{Pf}"']*$/u;
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

// A plain line break that only wraps a sentence: the line before stops on an
// abbreviation ("approx.", "the original mfr."), or it leaves the sentence
// open and either the next line carries on in lower case or the line before
// stops on a comma, a dash or a word in lower case ("comes with the", "new"),
// whatever the next line starts with ("Michelin", "3.6L"). A heading or a
// title stops on neither ("Dealer Comments:", "Vehicle Highlights", "2019
// Jeep Grand Cherokee Limited"), so it keeps its own line, and a list item
// ("- Heated seats") never joins the line before it.
const wraps = (before, next) =>
  !/^[-•*]\s/.test(next) && (endsAtAbbreviation(before) || (OPEN_SENTENCE.test(before) && (/^[a-z]/.test(next) || /(?:[,–—-]|\b[a-z][a-z'’]*)$/.test(before))));

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

// A line the scan's lot-wide text covers: the whole line, a sentence in it,
// or lot-wide text anywhere in it between spaces, so a disclaimer the line
// runs on into after an abbreviation ("Smoker? No. All prices exclude tax")
// is found though the sentences there split differently.
const NONE = new Set();
function contains(text, part) {
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) {
    if ((i === 0 || /\s/.test(text[i - 1])) && (i + part.length === text.length || /\s/.test(text[i + part.length]))) return true;
  }
  return false;
}
const lotWide = (text, boilerplate) =>
  boilerplate.has(text) || splitSentences(text).some((s) => boilerplate.has(s)) || [...boilerplate].some((part) => typeof part === 'string' && part !== '' && contains(text, part));

// The description's segments: its lines, with each wrapped line joined to the
// one before it. With the lot-wide text the scan found, a line it covers is a
// segment of its own, marked lotWide, and never joined to the lines around it.
function segmentsOf(raw, boilerplate = NONE) {
  const out = [];
  for (const lines of linesOf(raw)) {
    let open = null; // the segment of this paragraph the next line may wrap into
    for (const line of lines) {
      if (boilerplate.size && lotWide(line, boilerplate)) {
        out.push({ text: line, lotWide: true });
        open = null;
      } else if (open && wraps(open.text, line)) open.text += ` ${line}`;
      else out.push((open = { text: line, lotWide: false }));
    }
  }
  return out;
}

export function splitSegments(raw) {
  return segmentsOf(raw).map((seg) => seg.text);
}

// The description's segments with the lot-wide text the scan found taken
// out: what the website says about this car, not what it says about every
// car (a bank-approval or as-is disclaimer, "We are a locally owned
// dealership."). Lot-wide text is cut out wherever it stands between
// spaces, the longest first, and a segment left with nothing goes. The
// checks read this as the website's own words for the car
// (rewriteTemplate.js claimSource).
export function withoutLotWide(raw, boilerplate = NONE) {
  const parts = [...boilerplate].filter((p) => typeof p === 'string' && p.trim() !== '').sort((a, b) => b.length - a.length);
  const out = [];
  for (const segment of splitSegments(raw)) {
    let text = segment;
    for (const part of parts) {
      for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) {
        if ((i === 0 || /\s/.test(text[i - 1])) && (i + part.length === text.length || /\s/.test(text[i + part.length]))) text = `${text.slice(0, i)} ${text.slice(i + part.length)}`;
      }
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
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
// for all of them. Both are worked out from each website's own lot; no number
// from one lot is baked in. The share is of the whole lot: when a scan read
// only some of the lot's descriptions, `lotSize` is how many cars the lot
// has, so three new arrivals sharing a sentence are 3 of 33, not 3 of 3
// (scanRunner.js keeps the lines saved from the last scan next to what such
// a scan finds).
export function findBoilerplate(allDescriptions, threshold = 0.3, minCount = MIN_BOILERPLATE_COUNT, lotSize = 0) {
  const counts = new Map();
  const read = Array.isArray(allDescriptions) ? allDescriptions.length : 0;
  const total = Math.max(read, Number.isFinite(lotSize) ? lotSize : 0);
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

// An award blurb ("Awards: * Motor Trend Automobiles of the Year") speaks of
// the model, not this car.
const AWARDS_PREFIX = /^awards?\s*:/i;
// A Carfax or arrival label ("CARFAX One-Owner.", "Clean CARFAX.", "Recent
// Arrival!") at the start of a segment, in any case and with any
// punctuation: a claim about the car's history that the Carfax flags carry,
// and the start of a sentence that can go on to take it back ("Clean CARFAX
// Not Available On This Unit.").
const LABEL = /^[^\p{L}\p{N}]*(?:recent[\s\p{P}]*arrival|carfax[\s\p{P}]*one[\s\p{P}]*owner|clean[\s\p{P}]*carfax)/iu;

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

// A segment the narrative leaves out: text the lot shares (the whole segment
// or a sentence in it), one that starts with a Carfax or arrival label, an
// award line, or one with a list of equipment in it (the features field
// gives those). A segment is never trimmed: a sentence the website ran on
// from one of these, or that ran on into it, may say the opposite read
// alone, so the whole segment goes.
const leftOut = (seg, boilerplate) =>
  seg.lotWide || lotWide(seg.text, boilerplate) || LABEL.test(seg.text) || AWARDS_PREFIX.test(seg.text) || splitSentences(seg.text).some(looksLikeEquipmentDump);

// The write-up the rewrite service is sent (rewriter.js rewriteFacts; the
// template writer does not use it): the description's segments as the
// website wrote them, from its first, up to the first segment it leaves out,
// one string per segment. Nothing after that segment is sent, since a line
// after one left out may carry on from it ("Clean CARFAX." then "Except the
// accident in 2021."), and the last segment sent goes too when it may run on
// into the one left out: it does not end with ".", "!" or "?", or the one
// left out does not start as a sentence does (past a bullet mark). Bullets
// and headings go as written.
export function cleanDescription(raw, boilerplate = new Set()) {
  const kept = [];
  for (const seg of segmentsOf(raw, boilerplate)) {
    if (!leftOut(seg, boilerplate)) {
      kept.push(seg.text);
      continue;
    }
    let next = seg.text;
    while (kept.length && (!ENDS_SENTENCE.test(kept[kept.length - 1]) || !STARTS_SENTENCE.test(next.replace(/^[-•*]\s+/, '')))) next = kept.pop();
    break;
  }
  return kept;
}
