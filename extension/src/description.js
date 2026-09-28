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

// Segments are split on <br> the way the website itself renders them.
export function splitSegments(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/<br\s*\/?>/i)
    .map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
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
// anything specific to one car. Default threshold matches the brief: ~30%,
// with MIN_BOILERPLATE_COUNT as the floor. Both are re-derived from each
// website's own lot on every scan; nothing about one lot is kept.
export function findBoilerplate(allDescriptions, threshold = 0.3, minCount = MIN_BOILERPLATE_COUNT) {
  const counts = new Map();
  const total = Array.isArray(allDescriptions) ? allDescriptions.length : 0;
  for (const raw of allDescriptions || []) {
    for (const seg of new Set(splitSegments(raw))) {
      counts.set(seg, (counts.get(seg) || 0) + 1);
    }
  }
  const boilerplate = new Set();
  if (total > 0) {
    for (const [seg, count] of counts) {
      if (count >= minCount && count / total >= threshold) boilerplate.add(seg);
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
// feature/option names pulled from the options field.
function looksLikeEquipmentDump(segment) {
  const commas = segment.split(',').length - 1;
  return commas >= 6;
}

// Returns the car-specific narrative sentences left after boilerplate, award
// blurbs, feature bullets and raw equipment dumps are removed.
export function cleanDescription(raw, boilerplate = new Set()) {
  const kept = [];
  for (const seg of splitSegments(raw)) {
    if (boilerplate.has(seg)) continue;
    if (AWARDS_PREFIX.test(seg)) continue;
    if (looksLikeBullet(seg)) continue;
    const stripped = seg.replace(CARFAX_PREFIX, '').trim();
    if (!stripped) continue;
    if (looksLikeEquipmentDump(stripped)) continue;
    kept.push(stripped);
  }
  return kept;
}
