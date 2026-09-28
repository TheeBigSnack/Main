// The customer-facing copy keeps the product's promises straight (CLAUDE.md
// non-negotiables 1 and 8 in words), quotes the one pricing config, and makes
// no claim we have not measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { OVERDUE_HOURS, SCAN_STALE_HOURS } from '../manager/data.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pricing = JSON.parse(read('../marketing/pricing.json'));
const money = (n) => '$' + Number(n).toLocaleString('en-US');

const CUSTOMER_FACING = ['sales-sheet.md', 'pilot-offer-email.md', 'onboarding-emails.md', 'onboarding-store.md', 'demo-script.md'];
const ALL = [...CUSTOMER_FACING, 'positioning.md'];
// the emails are templates one owner sends to any dealership
const EMAILS = ['pilot-offer-email.md', 'onboarding-emails.md', 'onboarding-store.md'];
// the two agreements the parties fill in
const AGREEMENTS = ['pilot-agreement.md', 'dealer-subscription-agreement.md'];
const legal = (rel) => read('../legal/' + rel);
// the pilot dealer is a fixture, not a default (the same words as test/anyDealer.test.js)
const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

test('the emails are templates for any dealership: no pilot-dealer value, no "our store", no fixed weekday, the cap as a bracket', () => {
  for (const rel of EMAILS) {
    const doc = read('../marketing/' + rel);
    const hit = doc.match(PILOT);
    assert.equal(hit, null, `${rel} contains the pilot value "${hit && hit[0]}"`);
    // the sender is a vendor writing to a dealership, not one of its staff
    assert.doesNotMatch(doc, /\b(our|my) (own )?(website|store|site|inventory|rooftop|lot)\b/i, `${rel} speaks as the dealership's own staff`);
    // a check-in day is a bracket, not the first pilot's weekday
    assert.doesNotMatch(doc, /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/, `${rel} pins a weekday`);
    // the daily cap is the dealer's to set: a bracket showing the code's default
    if (/daily cap/i.test(doc)) assert.ok(doc.includes(`[${DEFAULT_DAILY_CAP}]`), `${rel} names the daily cap without the bracketed default [${DEFAULT_DAILY_CAP}]`);
  }
  const offer = read('../marketing/pilot-offer-email.md');
  assert.match(offer, new RegExp(`${pricing.pilotDays}-day pilot`), 'the pilot offer quotes the pilot length');
  assert.match(offer, /\[dealership\]/, 'the pilot offer names the dealership as a bracket');
});

test('the store-install emails quote the pricing config and the code\'s numbers, and name the controls as the code labels them', () => {
  const store = read('../marketing/onboarding-store.md');
  for (const h of ['## To the manager', '## To each salesperson', '## Day 7, to the manager']) {
    assert.match(store, new RegExp('^' + escapeRe(h), 'm'), `onboarding-store.md has no "${h}" email`);
  }
  // counts and prices: pricing.json by name, or a bracket
  const five = pricing.includedSalespeople === 5 ? 'five' : String(pricing.includedSalespeople);
  assert.match(store, new RegExp(`includes ${five} salespeople`), 'the included seats come from pricing.json');
  assert.match(store, new RegExp(`\\${money(pricing.extraSalespersonMonthly)} a month`), 'the seat price comes from pricing.json');
  const allowed = new Set([pricing.perRooftopMonthly, pricing.extraSalespersonMonthly, pricing.foundingDealerMonthly].map(money));
  for (const m of store.matchAll(/\$[\d,]+/g)) assert.ok(allowed.has(m[0]), `onboarding-store.md: ${m[0]} is not from pricing.json`);
  assert.ok(store.includes(`[${DEFAULT_DAILY_CAP}]`), 'the daily cap is a bracket showing the default');
  // the day-7 numbers are read the way the manager view draws them
  assert.match(store, new RegExp(`more than ${OVERDUE_HOURS} hours`), 'the red threshold is OVERDUE_HOURS from manager/data.js');
  assert.match(store, new RegExp(`more than ${SCAN_STALE_HOURS} hours ago`), 'the stale-scan line is SCAN_STALE_HOURS from manager/data.js');
  // the three sentences that matter
  assert.match(store, /\*\*You click Publish\. Lot Sync never does\.\*\*/);
  assert.match(store, /\*\*Keep prices honest\.\*\*/);
  assert.match(store, /\*\*Clear the To do tab the day items appear\.\*\*/);
  // who creates invite codes today is stated from the code: the manager view has no button for it
  const manager = read('../manager/manager.js');
  assert.ok(!/create_invite|createInvite/.test(manager), 'the manager view can now create invite codes: update onboarding-store.md (who creates the codes) and this test together');
  assert.match(store, /manager view (doesn't|does not) have a button/, 'says the owner creates the codes today');
  // the controls, word for word as the popup, the side panel and the manager view label them
  const ui = (read('../extension/popup.js') + read('../extension/sidepanel.js')).replace(/&amp;/g, '&');
  for (const label of ['Send me a sign-in code', 'Sign in', 'Invite code', 'Join', 'Set up Lot Sync', 'Ready to post', 'Open the Marketplace form', "It's posted, record it", 'Open & update price', 'Mark posted']) {
    assert.ok(ui.includes(label), `"${label}" is no longer a label in popup.js or sidepanel.js: update onboarding-store.md and this list together`);
    assert.ok(store.includes(label), `onboarding-store.md does not name "${label}"`);
  }
  for (const label of ['Send me a sign-in link', 'Download CSV', 'Salespeople', 'Sold cars still listed', 'Price changes not yet updated']) {
    assert.ok(manager.includes(label), `"${label}" is no longer a label in manager/manager.js: update onboarding-store.md and this list together`);
    assert.ok(store.includes(label), `onboarding-store.md does not name "${label}"`);
  }
  // no promise about anyone's Facebook account, and no invented number
  assert.doesNotMatch(store, /account (will|won't|will not) (be|get|stay)/i);
  assert.doesNotMatch(store, /\d+\s*(%|percent)/);
});

test('the two agreements are templates: no pilot-dealer value, every dollar amount a bracket, prices named from pricing.json, the attorney notes kept', () => {
  for (const rel of AGREEMENTS) {
    const doc = legal(rel);
    const hit = doc.match(PILOT);
    assert.equal(hit, null, `legal/${rel} contains the pilot value "${hit && hit[0]}"`);
    // a dollar amount is a bracket the parties fill in (a suggested figure may sit inside it)
    const outside = doc.replace(/\[[^\]]*\]/g, '');
    const dollar = outside.match(/\$\s?[\d,]*\d/);
    assert.equal(dollar, null, `legal/${rel} types a dollar amount: "${dollar && dollar[0]}"`);
    // every camelCase name in backticks is a field of pricing.json
    for (const m of doc.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)) assert.ok(Object.hasOwn(pricing, m[1]), `legal/${rel} names ${m[1]}, which is not in pricing.json`);
    assert.ok((doc.match(/\[Attorney:/g) || []).length >= 1, `legal/${rel} lost its [Attorney: …] notes`);
  }
  // the pilot agreement's table: blank rows the parties fill in, the length named from pricing.json
  const pilot = legal('pilot-agreement.md');
  const s1 = pilot.slice(pilot.indexOf('## 1.'), pilot.indexOf('## 2.'));
  for (const row of ['Rooftop', 'Website address', 'Number of designated salespeople', 'Pilot length in days', 'Start date']) {
    assert.match(s1, new RegExp(`^\\| ${escapeRe(row)}[^|]*\\| \\[ \\]`, 'm'), `pilot agreement section 1 has no blank "${row}" row`);
  }
  assert.match(s1, /`pilotDays`/, 'the pilot length is named from pricing.json');
  assert.doesNotMatch(s1, /\[\d[^\]]*\]/, 'pilot agreement section 1 carries a filled-in value');
  // Schedule A: the seven columns, blank, the fees named and explained as the ones shown at purchase
  const sub = legal('dealer-subscription-agreement.md');
  const a = sub.slice(sub.indexOf('## Schedule A'), sub.indexOf('## Schedule B'));
  assert.match(a, /^\| Rooftop \| Website \| Included salespeople \| Extra seats \| Monthly fee \| Founding rate \(if any\) \| Start date \|$/m, 'Schedule A has the seven columns');
  const rows = a.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('| Rooftop') && !l.startsWith('|---'));
  assert.ok(rows.length >= 1, 'Schedule A has a row to fill in');
  for (const row of rows) assert.match(row, /^\|( *\|){7}$/, `Schedule A row is not blank: ${row.slice(0, 60)}`);
  for (const name of ['perRooftopMonthly', 'includedSalespeople', 'extraSalespersonMonthly', 'foundingDealerMonthly', 'foundingDealerMonths']) {
    assert.ok(a.includes('`' + name + '`'), `Schedule A does not name ${name}`);
  }
  assert.match(a, /shown at purchase/, 'Schedule A says the fees are the ones shown at purchase');
  assert.match(sub, /\[Attorney: see questions-for-attorney\.md item 3/, 'the website-terms note stays');
  assert.match(sub, /\[Attorney: see item 7\.\]/, 'the personal-accounts note stays');
});
