// What no Lot Current text may say, in one place for every copy guard: the
// store listing and the Web Store answers (test/manifest.test.js), the
// marketing kit (test/marketing.test.js), the website (test/site.test.js,
// test/sitePages.test.js) and the docs (test/docs.test.js). CLAUDE.md: no
// affiliation or approval wording, no invented numbers, and no promise of
// account safety, since having a person click Publish is the safest design
// available but not guaranteed safe. Not a test file itself
// (test/copyGuards.test.js holds it to the sentences it must catch).

// Nothing anyone writes may say these, internal documents included.
export const NEVER = Object.freeze([
  /approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i,
  /compliant with (meta|facebook)/i, /(customers|dealers|salespeople) (say|love|report)/i, /\b(five|5) stars?\b/i,
  /\d+\s*(%|percent|x|times) (faster|more|fewer)/i, /hours? (a|per) (day|week)/i, /industry[- ]leading/i, /best[- ]in[- ]class/i, /\b#1\b/,
]);

// What the people Lot Current is sold to and used by may not read either
// (the positioning names some of these so we know what to avoid).
export const NOT_TO_CUSTOMERS = Object.freeze([/testimonial/i, /never (be|get) restricted/i, /your account is (safe|protected)/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bbots?\b/i]);

// A promise about what happens to a person's account, in other words than
// the ones above.
export const ACCOUNT_PROMISES = Object.freeze([
  /\b(won't|will not|never|can't|cannot|can not) (be |get )?(banned|restricted|blocked|suspended|disabled|flagged)\b/i,
  /\baccounts?\b[^.]{0,40}\b(protected|safe|secure|in good standing)\b/i,
  /\bin good standing\b/i,
]);

// The honest lines that name a forbidden thing only to deny it, taken out
// before the scan.
export const DENIALS = Object.freeze([
  /not affiliated with, endorsed by or partnered with Meta/g,
  /no one can promise your account will never be restricted/g,
]);

// A word that denies what follows within a few words: "not a guarantee",
// "no one can promise", "we make no promise".
const DENY = "\\b(?:not|no|isn't|not be|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)[a-z' ]{0,20}";
const DENIED_GUARANTEE = new RegExp(DENY + 'guarantee[ds]?', 'gi');
const DENIED_PROMISE = new RegExp(DENY + 'promise[ds]?', 'gi');

// The text with the honest denials taken out.
export function withoutDenials(text) {
  let said = String(text);
  for (const d of DENIALS) said = said.replace(d, '');
  return said;
}

/**
 * What a text says that it may not, as a list of reasons (empty when
 * nothing). Every text: NEVER, and no "guarantee" outside a denial of one.
 * Customer-facing text also: NOT_TO_CUSTOMERS, ACCOUNT_PROMISES, and no
 * "promise" outside a denial of one.
 */
export function copyProblems(text, { customerFacing = true } = {}) {
  const said = withoutDenials(text);
  const problems = [];
  if (/\bguarantee[ds]?\b/i.test(said.replace(DENIED_GUARANTEE, ''))) problems.push('makes a guarantee');
  for (const re of NEVER) if (re.test(said)) problems.push(`matches ${re}`);
  if (customerFacing) {
    for (const re of [...NOT_TO_CUSTOMERS, ...ACCOUNT_PROMISES]) if (re.test(said)) problems.push(`matches ${re}`);
    if (/\bpromise[ds]?\b/i.test(said.replace(DENIED_PROMISE, ''))) problems.push('makes a promise');
  }
  return problems;
}
