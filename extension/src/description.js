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

// A plain line break that only wraps a sentence: the line before leaves the
// sentence open, and either the next line carries on in lower case or the
// line before stops on a comma, a dash or a word in lower case ("comes with
// the", "new"), whatever the next line starts with ("Michelin", "3.6L"). A
// heading or a title stops on neither ("Dealer Comments:", "Vehicle
// Highlights", "2019 Jeep Grand Cherokee Limited"), so it keeps its own line,
// and a list item ("- Heated seats") never joins the line before it.
const wraps = (before, next) =>
  OPEN_SENTENCE.test(before) && !/^[-\u2022*]\s/.test(next) && (/^[a-z]/.test(next) || /(?:[,\u2013\u2014-]|\b[a-z][a-z'\u2019]*)$/.test(before));

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

// The sentences of one segment, split where the template splits them.
export function splitSentences(segment) {
  return String(segment || '').split(/(?<=[.!?])\s+/).filter(Boolean);
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

// A piece of text that ends as a sentence does, and one that starts as a
// sentence does: its first letter or digit is a capital or a digit, with
// nothing before it but quotes, brackets or emoji. A piece that starts in
// lower case ("warranty of any kind.", "brakes and tires.") carries on a
// sentence begun before it.
export const ENDS_SENTENCE = /[.!?]["'\u2019\u201d)]*$/;
export const STARTS_SENTENCE = /^[\s"'\u2018\u201c([\p{Extended_Pictographic}\ufe0f\u200d]*[\p{Lu}\p{N}]/u;

// A segment starts a sentence on the website when it comes first, or the
// line right before it ended a sentence or is a heading that ends in a colon
// ("Dealer Comments:"), and it starts as a sentence does. Any other segment
// may carry on a sentence the website broke across a line break, a
// paragraph or a list item ("...is not a Jeep" + "Certified Pre-Owned
// vehicle."), and read alone it can say the opposite of the website; so may
// the one after a heading or a title with no colon ("Vehicle Highlights").
const startsAfter = (before) => before === null || ENDS_SENTENCE.test(before) || /:$/.test(before);

// The car-specific narrative left after boilerplate, award blurbs, feature
// bullets and raw equipment dumps are removed: one { text, opens } per
// segment, with any lot-wide sentence or equipment list inside it taken out
// and the rest of the segment kept as written. `opens` is whether the
// segment starts a sentence on the website, judged against the line the
// website shows right before it, even one left out here.
export function writeUpParts(raw, boilerplate = new Set()) {
  const kept = [];
  // a lot-wide line, or a lot-wide sentence in a line, goes before wrapped lines are joined
  const own = (line) => (boilerplate.has(line) ? '' : splitSentences(line).filter((s) => !boilerplate.has(s)).join(' '));
  for (const { text: seg, before } of segmentsOf(raw, own)) {
    const opens = startsAfter(before) && STARTS_SENTENCE.test(seg);
    if (boilerplate.has(seg)) continue;
    if (AWARDS_PREFIX.test(seg)) continue;
    if (looksLikeBullet(seg)) continue;
    const carText = splitSentences(seg).filter((s) => !boilerplate.has(s)).join(' ');
    const stripped = carText.replace(CARFAX_PREFIX, '').trim();
    const text = splitSentences(stripped).filter((s) => !looksLikeEquipmentDump(s)).join(' ');
    if (text) kept.push({ text, opens: opens && STARTS_SENTENCE.test(text) });
  }
  return kept;
}

// The narrative as plain strings, one per segment (what the rewrite service
// is sent and the side panel keeps).
export function cleanDescription(raw, boilerplate = new Set()) {
  return writeUpParts(raw, boilerplate).map((p) => p.text);
}

// The one segment the template's write-up line may come from: the first
// that starts a sentence on the website and holds a finished sentence. A
// segment that does not start a sentence is never it, and no later segment
// is added to it; with no such segment there is none (''). Takes
// writeUpParts' { text, opens }, or plain strings read as the website's
// segments in order, each judged against the one before it.
export function openingSegment(parts) {
  let before = null;
  for (const part of Array.isArray(parts) ? parts : []) {
    const plainText = typeof part === 'string';
    const text = plainText ? part : String((part && part.text) || '');
    const opens = plainText ? startsAfter(before) && STARTS_SENTENCE.test(text) : Boolean(part && part.opens);
    before = text;
    if (opens && splitSentences(text).some((s) => ENDS_SENTENCE.test(s))) return text;
  }
  return '';
}
