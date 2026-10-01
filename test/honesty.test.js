// The shared honesty word lists (test/honesty.js) against the claims they
// exist to stop and the honest lines the copy already uses. Each claim below
// once passed every copy test, because each test kept its own shorter copy
// of the lists and an "a guarantee" anywhere was waved through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { honestyProblems, offPricing, NEVER, NOT_TO_CUSTOMERS } from './honesty.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pricing = JSON.parse(read('../marketing/pricing.json'));
const money = (n) => '$' + Number(n).toLocaleString('en-US');

// Claims about Meta that no document may make, internal ones included.
const AFFILIATION_CLAIMS = [
  'Lot Current is affiliated with Meta.',
  'A Meta-approved way to post.',
  'Meta-approved for Marketplace vehicle listings.',
  'Facebook-approved listing tool.',
  'A Facebook-approved tool.',
  "Built with Meta's approval.",
  'Approved for Facebook Marketplace.',
  'Approved by Meta.',
  'Endorsed by Meta.',
  'Certified by Facebook.',
  'Certified for Facebook Marketplace.',
  'Sanctioned by Facebook.',
  'Lot Current is a Meta Business Partner.',
  'Your Facebook Marketplace partner.',
  'Built in partnership with the Marketplace team.',
  "Facebook's official listing helper.",
  'Built with Meta.',
  'Lot Current works with Meta.',
];

// Promises and made-up numbers that customer-facing copy may not make.
const CUSTOMER_CLAIMS = [
  'Every plan comes with a guarantee: your Facebook account stays safe.',
  'Backed by a guarantee.',
  'We offer a guarantee that Facebook will never ban you.',
  "We know you're guaranteed safe from bans.",
  'Your account stays safe.',
  'Your account is safe.',
  'Your Facebook profile will stay protected.',
  'No ban risk, ever.',
  "Salespeople don't get banned.",
  "Facebook won't restrict your account.",
  'Salespeople post 30 cars a day with Lot Current.',
  'Dealerships sell their used cars 3 days faster.',
  'Trusted by 140 dealerships.',
  'Used by 40 dealers.',
  'Post twice as fast.',
  'Save 6 hrs/week.',
  'It saves you 5 hours every week.',
];

// Lines today's copy uses, which must stay allowed.
const HONEST = [
  'It is a safety setting, not a guarantee of anything.',
  'Having a person click Publish is the safest design available, but it is not guaranteed safe.',
  "It's the safest way to do this, but it isn't a guarantee, and I won't pretend otherwise.",
  'Lot Current is a tool. We do not guarantee leads, sales or account status.',
  '5. No guarantees about leads, sales or account status.',
  'Lot Current is not affiliated with Meta Platforms, Inc.',
  "Lot Current isn't affiliated with Meta.",
  'Click **Post 3 cars** and show the queue.',
  'Rescans run every 3 hours while Chrome is open.',
  'A price change waiting more than 24 hours shows in red.',
  'Each salesperson may record 10 posts a day unless the dealership changes it.',
  'A founding-dealer rate for the first five stores.',
  'You click Publish. Lot Current never does.',
];

test('every affiliation or approval claim fails, in any document', () => {
  for (const claim of AFFILIATION_CLAIMS) {
    assert.notDeepEqual(honestyProblems(claim, { customerFacing: false }), [], `"${claim}" passes the internal-document check`);
    assert.notDeepEqual(honestyProblems(claim), [], `"${claim}" passes the customer-facing check`);
  }
});

test('every guarantee, account-safety promise and made-up number fails in customer-facing copy', () => {
  for (const claim of CUSTOMER_CLAIMS) assert.notDeepEqual(honestyProblems(claim), [], `"${claim}" passes the customer-facing check`);
  // a guarantee is refused everywhere, not only to customers
  for (const claim of CUSTOMER_CLAIMS.filter((c) => /guarantee/i.test(c))) assert.notDeepEqual(honestyProblems(claim, { customerFacing: false }), [], `"${claim}" passes the internal-document check`);
});

test('the honest lines the copy already uses pass', () => {
  for (const line of HONEST) assert.deepEqual(honestyProblems(line), [], line);
  // a sentence that only denies a forbidden thing passes once that denial is named
  const denial = 'Lot Current is not affiliated with, endorsed by or partnered with Meta, and no one can promise your account will never be restricted.';
  assert.notDeepEqual(honestyProblems(denial), [], 'without the denials named, the words are caught');
  assert.deepEqual(honestyProblems(denial, { denials: [/not affiliated with, endorsed by or partnered with Meta/g, /no one can promise your account will never be restricted/g] }), []);
});

test('the copy tests use these lists and keep no shorter copy of their own', () => {
  assert.ok(NEVER.length >= 15 && NOT_TO_CUSTOMERS.length >= 15);
  for (const file of ['marketing.test.js', 'site.test.js', 'sitePages.test.js', 'docs.test.js', 'manifest.test.js', 'manager.test.js']) {
    const src = read('./' + file);
    assert.match(src, /from '\.\/honesty\.js'/, `${file} does not import the shared lists`);
    assert.ok(!src.includes('/approved by (meta|facebook)/i'), `${file} keeps its own affiliation list`);
    assert.ok(!src.includes('guarantee[ds]?/gi'), `${file} keeps its own guarantee filter`);
  }
});

test('a price in customer-facing copy is one of pricing.json\'s, whatever words follow it', () => {
  // each of these once passed, because only "$N a month" and "$N per month" were read
  for (const line of ['Or $199 per rooftop per month on the annual plan.', 'Just $49/month.', 'From $79 monthly.', '$1,490 a year, paid up front.', '$299 per store per month.', 'Founding stores pay **$79** a month.', 'Only $1,299/month per rooftop.', 'A seat is 25 dollars.']) {
    assert.notDeepEqual(offPricing(line, pricing), [], `"${line}" passes the price check`);
  }
  // pricing.json's own figures pass, in the forms the copy uses
  const quoted = `${money(pricing.perRooftopMonthly)} per rooftop per month, ${money(pricing.extraSalespersonMonthly)} a month per extra salesperson, a founding rate of **${money(pricing.foundingDealerMonthly)}** a month.`;
  assert.deepEqual(offPricing(quoted, pricing), []);
  assert.deepEqual(offPricing(quoted, { ...pricing, perRooftopMonthly: pricing.perRooftopMonthly + 1 }), [money(pricing.perRooftopMonthly)], 'a figure the config no longer has fails');
});

test('docs/website.md says what the website\'s honesty check reads, and that it is a word list', () => {
  const doc = read('../docs/website.md');
  assert.doesNotMatch(doc, /the honesty rules of `CLAUDE\.md` over every page's text/, 'the old claim that npm test enforces the rules themselves');
  assert.match(doc, /honesty word lists in `test\/honesty\.js`.{0,200}image alt text.{0,80}`llms\.txt`/, 'names the lists and the surfaces they read');
  assert.match(doc, /not every possible one, so new copy still needs a person to read it/, 'says a word list is not a proof');
});
