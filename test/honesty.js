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
  /\b(approved|endorsed|certified|sanctioned|authori[sz]ed|verified|recommended|recogni[sz]ed) (by|for|on) (meta|facebook|marketplace)\b/i,
  /\b(meta|facebook|marketplace)[- ](approved|endorsed|certified|sanctioned|authori[sz]ed|verified|recommended|recogni[sz]ed)\b/i,
  /\b(meta|facebook) (has|have|had) (approved|endorsed|certified|sanctioned|authori[sz]ed|verified|recommended|recogni[sz]ed)\b/i,
  // the present tense: "Meta approves of Lot Current", "Facebook endorses it"
  /\b(meta|facebook|marketplace) (approves|endorses|certifies|sanctions|authori[sz]es|accredits)\b/i,
  // verbs with honest uses ("Facebook recommends square photos", "backs up your draft", "Marketplace supports
  // 20 photos") count only with Lot Current as the object: "Meta supports Lot Current", "Facebook OKs Lot Current"
  /\b(meta|facebook|marketplace) (recommends|backs|supports|oks|okays|ok['’]s|vouches for|stands behind)( of)? (lot current|this (tool|extension|app|product)|the extension|our (tool|extension|app|product)|us)\b/i,
  /\b(approved|endorsed|certified|sanctioned|authori[sz]ed|accredited) (meta|facebook|marketplace)\b/i,
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
  /\b(hours?|hrs?)\s*(a|per|each|every|\/)\s*(day|week|month)\b/i,
  /industry[- ]leading/i,
  /best[- ]in[- ]class/i,
  /\b#1\b/,
];

// What no document may say, internal ones included.
export const NEVER = [...AFFILIATION, ...CLAIMS];

// Up to three words that are not a negation: what "is 100% safe" and "will be
// totally safe" put between the verb and "safe" ("is not safe" is no promise).
const UP_TO_THREE_WORDS = String.raw`(?: (?!(?:not|never|no)\b|\w*n['’]t\b)[\w%'’-]+){0,3}`;

// Promises about what happens to a salesperson's Facebook account. A sentence
// that names one only to deny it is passed to honestyProblems as a denial.
export const SAFETY = [
  /never (be|get) restricted/i,
  new RegExp(String.raw`\b(account|profile)(s? (is|are|stays?|will|remains?|should|would)\b|['’]s\b)${UP_TO_THREE_WORDS} (safe|protected|secure)\b`, 'i'),
  /\b(keeps?|keeping|kept)( [\w'’-]+){0,3} (account|profile)s? (safe|protected|secure|in good standing|from)\b/i,
  /\b(protects?|protecting|shields?|shielding|safeguards?|safeguarding)( [\w'’-]+){0,3} (account|profile)s?\b(?! (data|information|details|settings)\b)/i,
  /\b(safe|safer|protected|secure) (for|on|with|to use (on|with|for)) (your |their |a |the )?((facebook|meta|marketplace) )?(account|profile|facebook|meta|marketplace)s?\b/i,
  /(\b(completely|totally|perfectly|entirely|absolutely|fully)|\b100\s?%) (safe|secure|protected)\b/i,
  /\b(safe|protected|immune) from (bans?|blocks?|restrictions?|suspensions?)\b/i,
  /\b(avoid|avoids|avoiding|prevent|prevents|preventing)( [\w'’-]+){0,2} (bans?|blocks?|restrictions?|suspensions?)\b/i,
  /\b(ban|block|account|restriction|suspension)[- ](protection|shield|insurance)\b/i,
  /\bno (ban|block|restriction|suspension)s? risk\b/i,
  /\b(ban|block)[- ]?(proof|free)\b/i,
  /\b(won't|will not|never|can't|cannot|don't|doesn't) (get|be) (banned|blocked|restricted|suspended)\b/i,
  // "post without getting banned", "without your account getting banned", "avoid being blocked"
  /\b(without|avoids?|avoiding)(?: (?!(?:not|never|no)\b)[\w'’-]+){0,3} (getting|being) (banned|blocked|restricted|suspended)\b/i,
  // "keeps you from getting restricted"; one car kept "from being blocked by another" in a queue is no promise
  /\bfrom (ever )?(getting|being) (banned|blocked|restricted|suspended)\b(?! by (?:another|other|the other|the next|a different|one another)\b)/i,
  /\b(meta|facebook|marketplace) (won't|will not|will never|never|can't|cannot) (ban|block|restrict|suspend)\b/i,
  /\brisk[- ]free\b/i,
  /\b(no|zero|without any) risk\b/i,
  /\b(never|not) (be )?at risk\b/i,
  /\bundetect(able|ed)\b/i,
];

// Numbers of customers, posts or time saved that nobody has measured. A count
// of stores in pricing.json is written as a word ("the first five stores"), and
// the daily cap's default may be named as what it is ("10 posts a day").
export const NUMBERS = [
  /\btrusted by\b/i,
  /(?<!\bfirst )\b\d[\d,]*\+?\s*(dealers|dealerships|stores|rooftops|customers|users)\b/i,
  new RegExp(`\\b(?!${DEFAULT_DAILY_CAP} posts (a|per) day\\b)\\d[\\d,]*\\+?\\s*((more|extra|additional|new)\\s+)?(cars|vehicles|listings|posts|sales|leads)\\s*(a|per|each|every|\\/)\\s*(day|week|month|year)\\b`, 'i'),
  /(\b(over|more than|nearly|almost|upwards of) \d[\d,]*\+?|\b\d[\d,]*\+)\s*(cars|vehicles|listings|posts|sales|leads|salespeople)\b/i,
  /\b(hundreds|thousands|dozens|millions) of (cars|vehicles|listings|posts|sales|leads|dealers|dealerships|stores|rooftops|customers|users|salespeople)\b/i,
  /\b(cut|cuts|cutting|reduce|reduces|reducing|slash|slashes|lower|lowers|boost|boosts|increase|increases|double|doubles|improve|improves)\b[^.]{0,40}\bby \d+\s*(%|percent)/i,
  /\b\d+\s*(%|percent) (less|faster|quicker|shorter|more|fewer)\b/i,
  /\b\d+\s*(days?|hours?|hrs?|minutes?|mins?)\s*(faster|sooner|quicker)\b/i,
  /\b(twice|three times|four times|ten times|\d+x) as (fast|quick|many|much)\b/i,
  /\bsav(e|es|ed|ing) ([\w'’-]+ ){0,2}(up to |over |about |nearly |around )?\d+\s*(hours?|hrs?|minutes?|mins?)\b/i,
];

// A time per post in seconds. No fill time has been measured (the live runs
// recorded none; the Numbers tab's CSV records it now), and
// legal/trademark-note.md (Marketing claims) allows a claim about time per
// post only from measured pilot data with written permission to cite it, so a
// figure comes back only with that measurement and a deliberate change here.
// Any figure in seconds is refused, wherever it stands in the sentence ("from
// your website, in 10 seconds", "ready in about ten seconds", "10 sec", "a
// ten-second post"): the only seconds customer copy could quote is a time per
// post. "In seconds" and "a few seconds", with no figure, are not caught. The
// short forms count too: "10sec", "in 10s", "in roughly 10s", "in ~10s", "10 s
// a car" and "a 10s post" (a bare "s" only after a time word, before "a car"
// or before "post", so "the 2010s" and "under 18s" are not read).
const SECONDS = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety)`;
export const TIME_PER_POST = [
  new RegExp(String.raw`\b${SECONDS}(?:\s+|-)(?:seconds?|secs?)\b`, 'i'),
  /\b\d+(?:\.\d+)?(?:seconds?|secs?)\b/i,
  /\b(?:in|about|around|within|takes?|took|roughly|approximately)\s+(?:about |under |around |just |only |less than |roughly |approximately )?~?\s?\d+(?:\.\d+)?\s?s\b/i,
  /\b\d+(?:\.\d+)?\s?s\s+(?:a|per|each|every)\s+(?:car|post|listing|vehicle)\b/i,
  /\b\d{1,3}(?:\.\d+)?\s?s[- ](?:posts?|listings?|fills?)\b/i,
];

// What customer-facing copy may not say either (the positioning names some
// of these so we know what to avoid).
export const NOT_TO_CUSTOMERS = [/testimonial/i, /\bbots?\b/i, ...SAFETY, ...NUMBERS, ...TIME_PER_POST];

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

// Every dollar figure in a text that is not one of pricing.json's three
// prices as the copy writes them ("$149", "$20", "$99"), whatever words follow
// it: "per rooftop per month", "/month", "monthly" and "a year" are all prices.
// Customer-facing copy quotes pricing.json and nothing else.
export function offPricing(text, pricing) {
  const money = (n) => '$' + Number(n).toLocaleString('en-US');
  const allowed = new Set([pricing.perRooftopMonthly, pricing.extraSalespersonMonthly, pricing.foundingDealerMonthly].map(money));
  const figures = [...String(text).matchAll(/\$\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s*(dollars|usd)\b|\busd\s?\d[\d,]*(\.\d+)?/gi)].map((m) => m[0]);
  return figures.filter((f) => !allowed.has(f));
}
