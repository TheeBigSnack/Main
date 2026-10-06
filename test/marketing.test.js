// The customer-facing copy keeps the product's promises straight (CLAUDE.md
// non-negotiables 1 and 8 in words), quotes the one pricing config, and makes
// no claim we have not measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_DAILY_CAP } from '../extension/src/cap.js';
import { OVERDUE_HOURS, SCAN_STALE_HOURS, SCAN_STALE_WHY } from '../manager/data.js';
import { copyProblems } from './copyGuards.js';
import { honestyProblems, offPricing, TIME_PER_POST } from './honesty.js';
import { stripComments } from './helpers.js';
import { pricingUnconfirmed } from '../scripts/stripe-setup-lib.mjs';

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
const US_STATE = /\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b/;
const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "hypothesis" stays true until a dealer agrees to a price in writing. Setting
// it to false is docs/launch-checklist.md's "Pricing confirmed" step, and the
// file then records when that happened ("confirmedOn", the agreement's date),
// so npm test passes on the step the checklist and docs/stripe-setup.md
// describe and fails on a bare flip with no record. A confirmed file must also
// pass the check `npm run stripe-setup -- --live` makes (pricingUnconfirmed),
// so npm test never passes a file that live mode refuses, such as a
// "confirmedOn" after today.
function pricingRecordRule(p, now = Date.now()) {
  assert.equal(typeof p.hypothesis, 'boolean', '"hypothesis" is true or false');
  if (p.hypothesis) {
    assert.ok(!('confirmedOn' in p), 'a hypothesis carries no confirmation date');
    return;
  }
  assert.match(String(p.confirmedOn), /^\d{4}-\d{2}-\d{2}$/, 'a confirmed price says when a dealer agreed to it in writing ("confirmedOn": "YYYY-MM-DD")');
  const t = Date.parse(p.confirmedOn + 'T00:00:00Z');
  assert.ok(Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === p.confirmedOn, 'confirmedOn is a real date');
  assert.equal(pricingUnconfirmed(p, now), '', 'live mode would refuse this file');
}

test('the pricing hypothesis is one config with the fields the docs quote', () => {
  pricingRecordRule(pricing);
  for (const k of ['perRooftopMonthly', 'includedSalespeople', 'extraSalespersonMonthly', 'pilotDays', 'foundingDealerMonthly', 'foundingDealerMonths', 'foundingDealerCount']) {
    assert.ok(Number.isInteger(pricing[k]) && pricing[k] > 0, `${k} is a whole number`);
  }
  assert.match(pricing.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(pricing.wouldChangeIt) && pricing.wouldChangeIt.length >= 2, 'says what would change it');
});

test('pricing.json can be marked confirmed the way the launch checklist says, and only with the agreement\'s date', () => {
  const { confirmedOn: _, ...numbers } = pricing;
  const now = Date.parse('2026-12-15T12:00:00Z');
  // the step docs/launch-checklist.md ("Pricing confirmed") and docs/stripe-setup.md describe passes, on the day or after
  pricingRecordRule({ ...numbers, hypothesis: false, confirmedOn: '2026-12-01' }, now);
  pricingRecordRule({ ...numbers, hypothesis: false, confirmedOn: '2026-12-15' }, now);
  pricingRecordRule({ ...numbers, hypothesis: true }, now);
  // an agreement dated after today fails here as it does in stripe-setup's live mode
  assert.throws(() => pricingRecordRule({ ...numbers, hypothesis: false, confirmedOn: '2026-12-16' }, now), /after today/);
  // a bare flip, a date that does not exist, a hypothesis with a date, a string for the flag: each fails
  assert.throws(() => pricingRecordRule({ ...numbers, hypothesis: false }), /confirmedOn/);
  assert.throws(() => pricingRecordRule({ ...numbers, hypothesis: false, confirmedOn: '2026-02-30' }), /real date/);
  assert.throws(() => pricingRecordRule({ ...numbers, hypothesis: true, confirmedOn: '2026-12-01' }), /no confirmation date/);
  assert.throws(() => pricingRecordRule({ ...numbers, hypothesis: 'false' }), /true or false/);
  // and both documents name the date with the flag, and say npm test passes after it
  const checklist = read('../docs/launch-checklist.md');
  const item = checklist.slice(checklist.indexOf('**Pricing confirmed.**'));
  assert.match(item.split('\n')[0], /"hypothesis": false`[^\n]*`"confirmedOn"[^\n]*`npm test` (still )?passes/, 'the checklist item names confirmedOn and npm test');
  const stripe = read('../docs/stripe-setup.md');
  for (const para of stripe.split('\n').filter((l) => l.includes('"hypothesis": false'))) assert.match(para, /"confirmedOn"/, `docs/stripe-setup.md: ${para.slice(0, 60)}`);
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
  // no other dollar figure sneaks into customer-facing copy, whatever words follow it (the
  // internal positioning may cite competitor ranges)
  for (const rel of CUSTOMER_FACING) {
    assert.deepEqual(offPricing(read('../marketing/' + rel), pricing), [], `marketing/${rel} quotes a price that is not from pricing.json`);
  }
});

test('customer-facing copy says who publishes and that Lot Current is not affiliated with Meta', () => {
  for (const rel of CUSTOMER_FACING) {
    const doc = read('../marketing/' + rel);
    assert.match(doc, /not affiliated with Meta/, `${rel} carries the non-affiliation line`);
    assert.match(doc, /clicks? Publish/, `${rel} says the person clicks Publish`);
    assert.match(doc, /never clicks Publish|Lot Current never does|never (clicks|does) Publish|Lot Current never clicks/i, `${rel} says Lot Current never does`);
    assert.match(doc, /not a guarantee|isn't a guarantee|is not guaranteed|won't pretend|no tool can honestly promise/, `${rel} does not oversell safety`);
  }
});

test('no claim we have not measured, and nothing that sounds like Meta approval', () => {
  // test/copyGuards.js and the shared lists (test/honesty.js): what no document may say, internal ones included, and
  // what customer-facing copy may not say either (the positioning names some of these so we know what to avoid)
  for (const rel of ALL) {
    const doc = read('../marketing/' + rel);
    assert.deepEqual(copyProblems(doc, { customerFacing: CUSTOMER_FACING.includes(rel) }), [], rel);
    assert.deepEqual(honestyProblems(doc, { customerFacing: CUSTOMER_FACING.includes(rel) }), [], `marketing/${rel}`);
    // the internal positioning too: its numbers are measured or labelled a guess, and no fill time has been measured
    for (const re of TIME_PER_POST) {
      const hit = doc.match(re);
      assert.equal(hit, null, `marketing/${rel} gives a time per post nobody has measured: "${hit && hit[0]}" (legal/trademark-note.md, Marketing claims)`);
    }
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

test('the pilot emails and the positioning send people to the numbers tab as the popup labels it', () => {
  const label = read('../extension/popup.js').match(/\['pilot', '([^']+)'\]/)[1];
  assert.equal(label, 'Numbers', 'the tab was renamed again: update the emails, the positioning and this test together');
  assert.ok(read('../marketing/onboarding-emails.md').includes(`**${label}** tab`), `onboarding-emails.md does not send people to the ${label} tab`);
  assert.ok(read('../marketing/positioning.md').includes(`The ${label} tab`), `positioning.md does not name the ${label} tab`);
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

test('no marketing or Web Store document names the pilot dealer: every marketing file is sorted, and each is checked', () => {
  // CLAUDE.md keeps the pilot dealer to test/fixtures/, marked worked examples and the pilot record
  // (PILOT.md, CHANGELOG.md, legal/questions-for-attorney.md); the demo script, the sales sheet and the
  // internal positioning are read before or at another dealership, so they name no pilot value either
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(md('marketing'), [...ALL].sort(), 'a marketing document is not in CUSTOMER_FACING or ALL here: sort it, so the checks in this file read it');
  for (const rel of [...ALL.map((f) => 'marketing/' + f), ...md('store').map((f) => 'store/' + f)]) {
    const doc = read('../' + rel);
    const line = doc.split('\n').findIndex((l) => PILOT.test(l));
    assert.equal(line, -1, `${rel}:${line + 1} contains the pilot value "${line >= 0 && doc.split('\n')[line].match(PILOT)[0]}"`);
    // region is data too (CLAUDE.md): the pilot's state, or any other, is not where Lot Current is sold
    const region = doc.split('\n').findIndex((l) => US_STATE.test(l));
    assert.equal(region, -1, `${rel}:${region + 1} names a state: "${region >= 0 && doc.split('\n')[region].match(US_STATE)[0]}"`);
  }
  // the positioning once said nothing is rescanned "while every Chrome at the store is closed", as if one open
  // Chrome covered the store: each salesperson's listings are rescanned only in their own Chrome
  const positioning = read('../marketing/positioning.md');
  assert.doesNotMatch(positioning, /every Chrome at the store/);
  assert.match(positioning, /Each salesperson installs Lot Current in their own Chrome/);
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
  // the last-scan line shows the last trusted scan: one judged a website hiccup goes up marked withheld and is told
  // beside it, never as it (extension/src/accountFlow.js scanFromStored, manager/data.js SCAN_STALE_WHY and
  // summarize), so an old line is not only a closed Chrome
  assert.match(SCAN_STALE_WHY, /held back as a likely website hiccup[^.]*never the last scan/, 'the manager view no longer says hiccup scans are held back: change onboarding-store.md and For managers with it');
  const scanPara = store.split('\n').find((l) => /last-scan line/.test(l)) || '';
  assert.match(scanPara, /last scan Lot Current trusted/, 'onboarding-store.md calls the line the last read of the website');
  assert.match(scanPara, /website hiccup[^.]*is held back and never shown as the last scan: the line says how many later scans were held back beside the last trusted one\./, 'onboarding-store.md does not say a hiccup scan is held back and told beside the last trusted one');
  assert.doesNotMatch(scanPara, /not recorded/, 'onboarding-store.md says a hiccup scan is not recorded, while it goes up marked held back');
  assert.doesNotMatch(scanPara, /, nobody's Chrome had it on\./, 'onboarding-store.md blames a closed Chrome alone for an old line');
  // a rescan reaches the dealership's account only while its salesperson is signed in (accountFlow.js syncNow)
  assert.match(scanPara, /not signed in to their Lot Current accounts \(a scan reaches this view only while its salesperson is signed in\)/, 'onboarding-store.md leaves out that a signed-out salesperson\'s rescans never reach the view');
  // the three sentences that matter
  assert.match(store, /\*\*You click Publish\. Lot Current never does\.\*\*/);
  assert.match(store, /\*\*Keep prices honest\.\*\*/);
  assert.match(store, /\*\*Clear the To do tab the day items appear\.\*\*/);
  // who creates invite codes is stated from the code: the manager view's Invite codes card calls create_invite
  const manager = read('../manager/manager.js') + read('../manager/data.js');
  assert.ok(/create_invite/.test(manager), 'the manager view no longer creates invite codes: update onboarding-store.md (who creates the codes) and this test together');
  assert.ok(manager.includes('Invite a salesperson'), '"Invite a salesperson" is no longer a label in manager/: update onboarding-store.md and this test together');
  assert.match(store, /\*\*Invite a salesperson\*\*/, 'says the manager makes the codes in the manager view');
  assert.doesNotMatch(store, /manager view (doesn't|does not) have a button/, 'the old sentence about the missing button');
  // the controls, word for word as the popup, the side panel and the manager view label them
  const ui = (read('../extension/popup.js') + read('../extension/sidepanel.js')).replace(/&amp;/g, '&');
  for (const label of ['Send me a sign-in code', 'Sign in', 'Invite code', 'Join', 'Set up Lot Current', 'Ready to post', 'Open the Marketplace form', "It's posted, record it", 'Open & update price', 'Mark posted']) {
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

// Chrome's permission prompt can come from three places now (round J added
// the photo servers), and the demo script tells the presenter what each one
// is. Every prompt goes through askChrome (src/askChrome.js), the extension's
// one call to chrome.permissions.request, which refuses Facebook's servers and
// wildcard hosts whatever list it is handed (test/askChrome.test.js). So this
// reads every use of chrome.permissions and of askChrome in the code: a
// request made anywhere else, an alias, a renamed import or a computed name on
// chrome fails; a new place to ask from fails until it is added to KNOWN and
// to the script; and so does a second call with the same words as a known one.
test('the demo script says what every Chrome permission prompt the extension raises is for', () => {
  const GATE = 'src/askChrome.js';
  // each askChrome call's argument, as written, in that file: [what it asks for, how many calls]
  const KNOWN = {
    'wizard.js origins': ['rescan', 1],
    'popup.js rescanOrigins()': ['rescan', 2],
    'sidepanel.js patterns': ['photos', 1],
    'sidepanel.js origins': ['rescan', 1], // the website itself, when posting or rescanning from the side panel's list
    "sidepanel.js [NHTSA_ORIGIN + '/' + '*']": ['NHTSA', 1],
  };
  // what else the code may do with chrome.permissions (none of these prompts)
  const QUIET = ['contains', 'getAll', 'onAdded', 'onRemoved'];
  const WORDS = { rescan: /automatic rescan/, photos: /download this car's photos/, NHTSA: /Check with NHTSA/ };
  const argumentAt = (code, open) => {
    let depth = 0;
    for (let k = open; k < code.length; k += 1) {
      if (code[k] === '(') depth += 1;
      else if (code[k] === ')' && (depth -= 1) === 0) return code.slice(open + 1, k).trim();
    }
    return null;
  };
  const kinds = new Set();
  const calls = {};
  const requests = [];
  const files = readdirSync(new URL('../extension/', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('sidepanel.js') && files.includes('wizard.js') && files.includes(GATE), 'the extension folder moved: fix this test');
  for (const file of files) {
    let code = stripComments(read('../extension/' + file), { trailing: true });
    assert.doesNotMatch(code, /\bchrome\s*(?:\?\.)?\s*\[/, `extension/${file} reads chrome by a computed name (chrome[...]): write chrome.<name>, so this inventory reads what it uses`);
    for (const m of code.matchAll(/\bpermissions\b(\s*\??\.\s*([A-Za-z_$][\w$]*)(\s*\()?)?/g)) {
      const [, , method, paren] = m;
      if (QUIET.includes(method)) continue;
      assert.ok(method === 'request' && paren, `extension/${file}: "permissions" appears as "${m[0]}". In code, use only chrome.permissions.${QUIET.join('/')}, and ask Chrome through askChrome(origins) (src/askChrome.js); in text a person reads, word it another way (this test reads strings as code)`);
      requests.push(`${file} ${argumentAt(code, m.index + m[0].length - 1)}`);
    }
    if (file === GATE) continue;
    // the one import form, on one line and under its own name, so every call below is read
    code = code.replace(/^import \{([^}\n]*)\} from '\.\/src\/askChrome\.js';$/gm, (line, names) => {
      assert.deepEqual(names.split(',').map((n) => n.trim()).filter(Boolean), ['askChrome'], `extension/${file}: import { askChrome } from './src/askChrome.js', nothing renamed and nothing else`);
      return '';
    });
    for (const m of code.matchAll(/\baskChrome\b(\s*\()?/g)) {
      assert.ok(m[1], `extension/${file}: askChrome appears as "${code.slice(m.index, m.index + 40).split('\n')[0]}"; import it as import { askChrome } from './src/askChrome.js' and call it as askChrome(origins), never under another name, so this inventory reads every request`);
      const arg = argumentAt(code, m.index + m[0].length - 1);
      const key = `${file} ${arg}`;
      assert.ok(KNOWN[key], `extension/${file} asks Chrome for ${arg}: add it to KNOWN here and say what it is in the demo script`);
      calls[key] = (calls[key] || 0) + 1;
      kinds.add(KNOWN[key][0]);
    }
  }
  assert.deepEqual(requests, [`${GATE} { origins: asked }`], 'Chrome is asked for a permission only inside askChrome (src/askChrome.js), which refuses Facebook\'s servers and wildcard hosts: call askChrome(origins) instead of chrome.permissions.request');
  for (const [key, [, count]] of Object.entries(KNOWN)) {
    assert.equal(calls[key] || 0, count, `extension/${key.replace(' ', ' asks Chrome for ')} in ${calls[key] || 0} places, not ${count}: a new place to ask from is added to KNOWN here and to the demo script; a removed one is taken out of both`);
  }
  assert.deepEqual([...kinds].sort(), Object.keys(WORDS).sort(), 'a permission request in KNOWN is gone from the code: take it out of here and the demo script');
  const line = read('../marketing/demo-script.md').split('\n').find((l) => l.startsWith('- **Chrome asks for a permission:**'));
  assert.ok(line, 'the demo script lost its "Chrome asks for a permission" line');
  for (const kind of kinds) assert.match(line, WORDS[kind], `the demo script does not say a prompt can be the ${kind} permission`);
});

// The dealer is told every salesperson ticks the posting rules before their
// first post. Set-up can be skipped (Not now), so that holds only while the
// side panel stops a post on a website whose settings have no tick and shows
// the rules (test/panelFlow.test.js runs it).
test('the store email says every salesperson ticks the posting rules before posting, and the side panel still makes it so', () => {
  const store = read('../marketing/onboarding-store.md');
  const sentence = store.split('\n').find((l) => l.startsWith('**5. The posting rules.**'));
  assert.ok(sentence, 'onboarding-store.md has no posting-rules paragraph');
  assert.match(sentence, /ticks that they will follow them before their first post: in set-up, or in the side panel if they skipped set-up/);
  assert.doesNotMatch(sentence, /during set-up and ticks/, 'set-up can be skipped: say where else the tick is asked for');
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /if \(!state\.settings\.rulesReadAt\) \{[^}]*state\.step = 'rules';/, 'the side panel no longer stops a post until the posting rules are ticked: change the email');
});

// review: the manager was told "Nothing from the pilot is lost: each pilot salesperson's posted list and
// numbers sync into the account the first time they sign in", while every salesperson was sent to the Web
// Store. The manifest has no "key", so the store copy has its own extension id and its own storage: it
// starts empty, and a pilot that ran without accounts left its listings only in the pilot copy.
test('the store-install emails carry the pilot salespeople\'s listings across from the pilot copy, since the store copy starts empty', () => {
  const manifest = JSON.parse(read('../extension/manifest.json'));
  const store = read('../marketing/onboarding-store.md');
  assert.doesNotMatch(store, /nothing (from the pilot )?is lost|sync into the account the first time they sign in/i, 'a promise the store install does not keep');
  if (manifest.key) return; // a fixed id would share one storage between the zip and the store copy
  const manager = store.split('\n').find((l) => l.startsWith('**1. The account.**'));
  assert.ok(manager, 'the manager email has its account paragraph');
  assert.match(manager, /starts empty/, 'the manager is told the store copy starts empty');
  assert.match(manager, /before installing from the store, they sign in and join the account in the copy they used during the pilot/, 'and what each pilot salesperson does first');
  const salesperson = store.slice(store.indexOf('## To each salesperson'), store.indexOf('## Day 7'));
  const before = salesperson.split('\n').find((l) => /Only for a salesperson who was in the pilot/.test(l)) || '';
  assert.ok(before && salesperson.indexOf(before) < salesperson.indexOf('**1. Install'), 'the salesperson email has the pilot step before the install step');
  assert.match(before, /in that pilot copy[^.]*\*\*Settings\*\*[^.]*\*\*Account\*\* sign in and join/, 'the pilot step signs in and joins in the pilot copy');
  assert.match(before, /Keep the pilot copy until \*\*My listings\*\* in the new copy shows your pilot cars/, 'and keeps it until the new copy shows them');
  // the labels it names are the popup's
  const popup = read('../extension/popup.js');
  for (const label of ['My listings', 'Settings', 'Account']) assert.ok(popup.includes(label), `"${label}" is no longer a label in popup.js: update onboarding-store.md and this test together`);
  assert.ok(read('../extension/src/accountFlow.js').includes('Accounts are not set up yet'), 'the pilot step quotes the Account section of a copy without accounts');
});

// review: the demo script had "a Facebook account signed in (yours, or the manager's salesperson's with their
// OK)" on the presenter's laptop, and a branch where a salesperson clicks Publish there. Support never touches a
// salesperson's Facebook account (docs/support.md) and the posting rules say each person posts from their own
// account only. The demo runs on the presenter's own account, is never published, and a real listing is the
// salesperson's own, on their own computer.
test('the demo script signs in only the presenter\'s own Facebook account and never publishes', () => {
  const demo = read('../marketing/demo-script.md');
  const setup = demo.split('\n').find((l) => l.startsWith('For a used car manager'));
  assert.ok(setup, 'the demo script lost its set-up line');
  assert.match(setup, /your own Facebook account signed in/, 'the presenter signs in their own account');
  assert.match(setup, /Never sign anyone else's Facebook account in on your laptop/, 'and never anyone else\'s');
  assert.doesNotMatch(demo, /salesperson's with their OK|or the (manager's )?salesperson's\)|sign(ed|s)? in as (them|the salesperson|a salesperson)|their (Facebook )?(login|password)/i, 'someone else\'s account on the presenter\'s laptop');
  assert.doesNotMatch(demo, /have the salesperson click Publish|unless they want real posts|whether the demo post gets published/i, 'a real listing during the demo');
  assert.match(demo, /The demo post is never published/, 'the demo publishes nothing');
  for (const line of demo.split('\n').filter((l) => /real listing/i.test(l))) {
    assert.match(line, /their own computer/, `a real listing is made on the salesperson's own computer: ${line.slice(0, 80)}`);
    assert.match(line, /their own (Facebook )?account/, `in their own Facebook account: ${line.slice(0, 80)}`);
  }
  // the support rule the script follows
  assert.match(read('../docs/support.md'), /Never touch a salesperson's Facebook account/, 'docs/support.md no longer says support never touches a salesperson\'s account: check the demo script against it');
});

// review: the sales sheet said "no contract", while a subscription is the Dealer Subscription Agreement the
// dealer signs (and the store email opens "Thanks for signing"). What is true is that it runs month to month
// and either side can end it at the end of a paid month; the copy says that instead.
test('no customer-facing text says "no contract" while the subscription is a signed agreement, and the sales sheet says month to month', () => {
  const agreement = legal('dealer-subscription-agreement.md');
  assert.match(agreement, /^# Dealer Subscription Agreement/m);
  assert.match(agreement, /^Signed:/m, 'the subscription agreement is still signed: copy cannot say there is no contract');
  const noContract = /\bno(?:-|\s+)contracts?\b|\bcontract-free\b|without (?:a|any) contract|nothing to sign/i;
  const files = [
    ...CUSTOMER_FACING.map((f) => `../marketing/${f}`),
    ...readdirSync(new URL('../site-src/pages/', import.meta.url)).filter((f) => f.endsWith('.html') && f !== 'legal.html').map((f) => `../site-src/pages/${f}`),
    ...readdirSync(new URL('../store/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../store/${f}`),
  ];
  for (const rel of files) {
    const hit = read(rel).match(noContract);
    assert.equal(hit, null, `${rel.slice(3)} says "${hit && hit[0]}", but a subscription is a signed agreement`);
  }
  // the term the agreement sets, in the sheet's own words
  assert.match(agreement, /Month to month from the effective date\. Either party may terminate on notice effective at the end of the current paid month\./, 'the agreement\'s term changed: change the sales sheet with it');
  assert.match(read('../marketing/sales-sheet.md'), /month to month: you can cancel at any time, effective at the end of the paid month\./);
});
