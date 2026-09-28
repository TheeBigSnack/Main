// The customer-facing copy keeps the product's promises straight (CLAUDE.md
// non-negotiables 1 and 8 in words), quotes the one pricing config, and makes
// no claim we have not measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pricing = JSON.parse(read('../marketing/pricing.json'));
const money = (n) => '$' + Number(n).toLocaleString('en-US');

const CUSTOMER_FACING = ['sales-sheet.md', 'pilot-offer-email.md', 'onboarding-emails.md', 'demo-script.md'];
const ALL = [...CUSTOMER_FACING, 'positioning.md'];

test('the pricing hypothesis is one config with the fields the docs quote', () => {
  assert.equal(pricing.hypothesis, true, 'it stays a hypothesis until a dealer pays');
  for (const k of ['perRooftopMonthly', 'includedSalespeople', 'extraSalespersonMonthly', 'pilotDays', 'foundingDealerMonthly', 'foundingDealerMonths', 'foundingDealerCount']) {
    assert.ok(Number.isInteger(pricing[k]) && pricing[k] > 0, `${k} is a whole number`);
  }
  assert.match(pricing.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(pricing.wouldChangeIt) && pricing.wouldChangeIt.length >= 2, 'says what would change it');
});

test('the sales sheet and the positioning quote the pricing config, not their own numbers', () => {
  for (const rel of ['sales-sheet.md', 'positioning.md']) {
    const doc = read('../marketing/' + rel);
    assert.match(doc, new RegExp(`\\${money(pricing.perRooftopMonthly)} per rooftop per month`), `${rel} quotes the monthly price`);
    assert.match(doc, new RegExp(`\\${money(pricing.extraSalespersonMonthly)} a month`), `${rel} quotes the seat price`);
    assert.match(doc, new RegExp(`\\${money(pricing.foundingDealerMonthly)}`), `${rel} quotes the founding rate`);
    assert.match(doc, new RegExp(`${pricing.pilotDays}[ -]day`), `${rel} quotes the pilot length`);
    assert.match(doc, new RegExp(`${pricing.includedSalespeople === 5 ? 'five' : pricing.includedSalespeople} salespeople included`), `${rel} quotes the included seats`);
  }
  // no other dollar-per-month figure sneaks into customer-facing copy (the
  // internal positioning may cite competitor ranges)
  for (const rel of CUSTOMER_FACING) {
    const doc = read('../marketing/' + rel);
    const allowed = new Set([pricing.perRooftopMonthly, pricing.extraSalespersonMonthly, pricing.foundingDealerMonthly].map(money));
    for (const m of doc.matchAll(/(\$[\d,]+)\s*(?:a|per)\s*month/g)) assert.ok(allowed.has(m[1]), `${rel}: ${m[0]} is not from pricing.json`);
  }
});

test('customer-facing copy says who publishes and that Lot Sync is not affiliated with Meta', () => {
  for (const rel of CUSTOMER_FACING) {
    const doc = read('../marketing/' + rel);
    assert.match(doc, /not affiliated with Meta/, `${rel} carries the non-affiliation line`);
    assert.match(doc, /clicks? Publish/, `${rel} says the person clicks Publish`);
    assert.match(doc, /never clicks Publish|Lot Sync never does|never (clicks|does) Publish|Lot Sync never clicks/i, `${rel} says Lot Sync never does`);
    assert.match(doc, /not a guarantee|isn't a guarantee|is not guaranteed|won't pretend|no tool can honestly promise/, `${rel} does not oversell safety`);
  }
});

test('no claim we have not measured, and nothing that sounds like Meta approval', () => {
  // what no document may say, internal ones included
  const never = [/approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i, /compliant with (meta|facebook)/i, /(customers|dealers|salespeople) (say|love|report)/i, /\b(five|5) stars?\b/i, /\d+\s*(%|percent|x|times) (faster|more|fewer)/i, /hours? (a|per) (day|week)/i, /industry[- ]leading/i, /best[- ]in[- ]class/i, /\b#1\b/];
  // what customer-facing copy may not say either (the positioning names these so we know what to avoid)
  const notToCustomers = [/testimonial/i, /never (be|get) restricted/i, /your account is (safe|protected)/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bbots?\b/i];
  for (const rel of ALL) {
    const doc = read('../marketing/' + rel);
    // "not a guarantee" and its cousins are the honest line; anything else with "guarantee" is a promise we can't make
    const rest = doc.replace(/(not|no|isn't|not be|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)[a-z' ]{0,20}guarantee[ds]?/gi, '').replace(/a guarantee\b/gi, '');
    assert.doesNotMatch(rest, /\bguarantee[ds]?\b/i, `${rel} makes a guarantee`);
    for (const re of never) assert.doesNotMatch(doc, re, `${rel} matches ${re}`);
    if (CUSTOMER_FACING.includes(rel)) for (const re of notToCustomers) assert.doesNotMatch(doc, re, `${rel} matches ${re}`);
  }
});

test('the pilot runbook names the three acceptance criteria and where the numbers come from', () => {
  const doc = read('../PILOT.md');
  assert.match(doc, /at least 5 cars/);
  assert.match(doc, /under 60 seconds/);
  assert.match(doc, /within one rescan cycle/);
  assert.match(doc, /extension\/src\/pilot\.js/);
  assert.match(doc, /Download CSV/);
  assert.match(doc, /legal\/pilot-agreement\.md/);
});
