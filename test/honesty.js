// The honesty word lists every copy test runs, kept in one place so the
// copies cannot drift: test/marketing.test.js (marketing/), test/site.test.js
// and test/sitePages.test.js (every page of the website, its image alt text,
// llms.txt and the share-image sentences), test/docs.test.js (docs/),
// test/manifest.test.js (the store listing) and test/manager.test.js (the
// manager view). They stand for CLAUDE.md's rules on copy: no promise of
// account safety, no Meta-approval or partnership wording, no invented
// numbers. A word list is a tripwire, not a proof: it catches the usual ways
// of writing those claims, and test/honesty.test.js holds it to sample claims
// it must catch and to today's honest lines it must let through.

import { DEFAULT_DAILY_CAP } from '../extension/src/cap.js';

// Saying Lot Current is affiliated with, approved by or a partner of Meta.
export const AFFILIATION = [
  /\b(approved|endorsed|certified|sanctioned|authori[sz]ed|verified|recommended) (by|for|on) (meta|facebook|marketplace)\b/i,
  /\b(meta|facebook|marketplace)[- ](approved|endorsed|certified|sanctioned|authori[sz]ed|verified|recommended)\b/i,
  /\b(meta|facebook)['’]s (approval|endorsement|blessing)\b/i,
  /\b(meta|facebook)(['’]s)?( [a-z]+){0,2} partners?\b/i,
  /\bpartner(ed|ship|s)? (with|of) (meta|facebook)\b/i,
  /\bin partnership with\b/i,
  /(?<!\bnot |n't |\bnever )\baffiliated with (meta|facebook)\b/i,
  /\bofficial(ly)?\b[^.]{0,20}\b(meta|facebook|marketplace)\b/i,
  /\b(meta|facebook|marketplace)(['’]s)? official\b/i,
  /\bcompliant with (meta|facebook)\b/i,
  /\b(built|made|developed) (with|by) (meta|facebook)\b/i,
  /\bworks with (meta|facebook)\b/i,
];

// Claims about results nobody has measured: what customers say, ratings, speed-ups.
export const CLAIMS = [
  /(customers|dealers|salespeople) (say|love|report)/i,
  /\b(five|5) stars?\b/i,
  /\d+\s*(%|percent|x|times) (faster|more|fewer)/i,
  /\b(hours?|hrs?)\s*(a|per|each|\/)\s*(day|week|month)\b/i,
  /industry[- ]leading/i,
  /best[- ]in[- ]class/i,
  /\b#1\b/,
];

// What no document may say, internal ones included.
export const NEVER = [...AFFILIATION, ...CLAIMS];

// Promises about what happens to a salesperson's Facebook account.
export const SAFETY = [
  /never (be|get) restricted/i,
  /\b(account|profile)s? (is|are|stays?|will (be|stay|remain)|remains?) (safe|protected|secure)\b/i,
  /\b(safe|protected|immune) from (bans?|blocks?|restrictions?|suspensions?)\b/i,
  /\bno (ban|block|restriction|suspension)s? risk\b/i,
  /\b(ban|block)[- ]?(proof|free)\b/i,
  /\b(won't|will not|never|can't|cannot|don't|doesn't) (get|be) (banned|blocked|restricted|suspended)\b/i,
  /\b(meta|facebook|marketplace) (won't|will not|will never|never|can't|cannot) (ban|block|restrict|suspend)\b/i,
  /\brisk[- ]free\b/i,
  /\bno risk\b/i,
];

// Numbers of customers, posts or time saved that nobody has measured. A count
// of stores in pricing.json is written as a word ("the first five stores"), and
// the daily cap's default may be named as what it is ("10 posts a day").
export const NUMBERS = [
  /\btrusted by\b/i,
  /(?<!\bfirst )\b\d[\d,]*\+?\s*(dealers|dealerships|stores|rooftops|customers|users)\b/i,
  new RegExp(`\\b(?!${DEFAULT_DAILY_CAP} posts (a|per) day\\b)\\d[\\d,]*\\+?\\s*(cars|vehicles|listings|posts|sales|leads)\\s*(a|per|each|every|\\/)\\s*(day|week|month|year)\\b`, 'i'),
  /\b\d+\s*(days?|hours?|hrs?|minutes?|mins?)\s*(faster|sooner|quicker)\b/i,
  /\b(twice|three times|four times|ten times|\d+x) as (fast|quick|many|much)\b/i,
  /\bsaves? (you |them )?(up to )?\d+\s*(hours?|hrs?|minutes?|mins?)\b/i,
];

// What customer-facing copy may not say either (the positioning names some
// of these so we know what to avoid).
export const NOT_TO_CUSTOMERS = [/testimonial/i, /\bbots?\b/i, ...SAFETY, ...NUMBERS];

// "Not a guarantee" and its close cousins are the honest line; any other
// "guarantee" is a promise we can't make. The negation must be a whole word
// right before the noun ("no" inside "know" is not a negation).
export const GUARANTEE_DENIAL = /\b(not|no|isn't|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)\b( be)?( a| any)? guarantee[ds]?\b/gi;

// Every list a text breaks: [] when it is clean. customerFacing adds
// NOT_TO_CUSTOMERS; denials are the sentences that name a forbidden thing only
// to deny it, removed before the scan.
export function honestyProblems(text, { customerFacing = true, denials = [] } = {}) {
  let said = String(text);
  for (const d of denials) said = said.replace(d, '');
  const out = [];
  const rest = said.replace(GUARANTEE_DENIAL, '');
  const g = rest.match(/\bguarantee[ds]?\b/i);
  if (g) out.push(`makes a guarantee ("${context(rest, g.index)}")`);
  for (const re of customerFacing ? [...NEVER, ...NOT_TO_CUSTOMERS] : NEVER) {
    const m = said.match(re);
    if (m) out.push(`matches ${re} ("${context(said, m.index)}")`);
  }
  return out;
}

function context(text, at) {
  return text.slice(Math.max(0, at - 30), at + 50).replace(/\s+/g, ' ').trim();
}
