// The launch kit (docs/): the help doc names the popup and side panel
// controls as the code labels them, no docs/ file carries a pilot-dealer
// value or Meta-affiliation wording (the same rules as test/marketing.test.js
// and test/anyDealer.test.js), and the support process, the launch checklist
// and the next-platform memo carry what PLAN.md Milestone 6 asks for.
// The second half holds the other documents to the code: the privacy texts,
// PILOT.md, README, CHANGELOG and HANDOFF.md each went stale once on a rule
// the code can state (the pilot pruning numbers, the storage-full message,
// the Terms step, the settings shape, the wizard steps, the version).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PILOT_RETENTION_DAYS } from '../extension/src/pilot.js';
import { notSavedReport, NOT_SAVED_STEPS } from '../extension/src/notSaved.js';
import { STORAGE_FULL } from '../extension/src/storage.js';
import { withDefaults, profileFrom } from '../extension/src/settings.js';
import { wizardSteps } from '../extension/src/wizardSteps.js';
import { checkPreOwned } from '../extension/src/classify.js';
import { listingStatus, MASS_DISAPPEARANCE_MIN_LOT, diffScans } from '../extension/src/rescan.js';
import { readdirSync } from 'node:fs';
import { SITE } from '../site/config.js';
import { copyProblems } from './copyGuards.js';
import { honestyProblems } from './honesty.js';
import { ADAPTERS, platformNames, unsupportedSiteMessage } from '../extension/adapters/index.js';
import { LEGAL } from '../extension/src/legalLinks.js';
import { accountsConfigured } from '../extension/src/accountConfig.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';
import { runGuardrails } from '../extension/src/rewriteTemplate.js';

// A checkout with CRLF line ends (git's autocrlf on Windows) reads the same as
// an LF one: every line-anchored pattern below is written for \n.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const DOCS = ['help.md', 'support.md', 'launch-checklist.md', 'next-platform.md'];
const doc = (name) => read('../docs/' + name);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A host nobody can serve mail or pages from (RFC 2606 and RFC 6761 names).
const PLACEHOLDER_HOST = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|org|net)$/i;
// The support inbox: the address docs/support.md gives under "The inbox", a
// real one (it replaced a placeholder on the reserved .example domain once
// the mailbox existed).
function supportInbox() {
  const line = doc('support.md').split('\n').find((l) => l.startsWith('- Address: '));
  assert.ok(line, 'docs/support.md has no "- Address:" line under "The inbox"');
  const m = line.match(/^- Address: `([^`@\s]+@([^`@\s]+))`/);
  assert.ok(m, 'the inbox line of docs/support.md does not start with the address in backticks');
  assert.doesNotMatch(m[2], PLACEHOLDER_HOST, `docs/support.md gives ${m[1]}, an address on a placeholder domain`);
  return m[1];
}

// Labels the help doc must use, word for word, and that the popup and the
// side panel must still render. `&amp;` in the popup's HTML strings is the
// on-screen `&`.
const LABELS = [
  'Scan website',
  'Ready to post',
  'Post',
  'Mark posted',
  'Open the Marketplace form',
  "It's posted, record it",
  'Taken down',
  'Open & update price',
  'Download CSV',
  'Numbers',
  'Clear the numbers',
  'Clear everything for this website',
  'Forget my synced profile',
  'Allow automatic rescans',
  'Use these highlights',
  'Make cover',
  'Untick all',
  'Your closing line (optional)',
  'Rescan the website',
  'Post the next',
  'Allow reading',
  'Fix before the form can be filled',
  'Worth fixing (the form can still be filled)',
];

test('the four launch-kit files exist and are not stubs', () => {
  for (const name of DOCS) {
    assert.ok(existsSync(new URL('../docs/' + name, import.meta.url)), `docs/${name} is missing`);
    const text = doc(name);
    assert.ok(text.length > 1000, `docs/${name} is too short to be the real thing`);
    assert.match(text, /^# /m, `docs/${name} has no title`);
  }
});

test('help.md names the popup and side panel controls as the code labels them', () => {
  const ui = (read('../extension/popup.js') + read('../extension/sidepanel.js')).replace(/&amp;/g, '&');
  const help = doc('help.md');
  for (const label of LABELS) {
    assert.ok(ui.includes(label), `"${label}" is no longer a label in popup.js or sidepanel.js: update the help doc and this list together`);
    assert.ok(help.includes(label), `docs/help.md does not name "${label}"`);
  }
});

test('help.md names every state My listings can show a posted car in, as the code words it', () => {
  const help = doc('help.md');
  const states = [
    listingStatus(null, 1, null),
    listingStatus({ status: 'pend-sale' }, 1, 1),
    listingStatus({ statusLabel: 'Sold' }, 1, 1),
    listingStatus({ decision: 'skip' }, 1, 1),
    listingStatus({ decision: 'review' }, 1, 1),
    listingStatus({ decision: 'not-ready' }, 1, null),
    listingStatus({ decision: 'ready' }, 1, 2),
    listingStatus({ decision: 'ready' }, 1, 1),
  ];
  assert.equal(new Set(states.map((s) => s.text)).size, states.length);
  for (const s of states) assert.ok(help.includes(`"${s.text}"`), `docs/help.md does not name the My listings state "${s.text}"`);
});

test('help.md and README give the "vanished at once" rule with the lot size it starts at', () => {
  const floor = String(MASS_DISAPPEARANCE_MIN_LOT);
  assert.match(doc('help.md'), new RegExp(`on a lot of ${floor} cars or more, if more than half of it disappears between scans, nothing is marked gone`));
  assert.match(read('../README.md'), new RegExp(`If more than half the cars of a lot of ${floor} or more vanish between scans, nothing is marked gone`));
});

// The dots that end no sentence before the price note (rewriteTemplate.js
// NOT_A_STOP, and its port in guardrails.ts): help.md names each, so a
// salesperson can tell why "Deal direct, incl. Tax, title ..." is refused.
test('help.md names every abbreviation whose dot ends no sentence before the price note, as both description checkers list them', () => {
  const listed = (src) => {
    const m = /const NOT_A_STOP = new RegExp\(`[^`]*?\(\?:((?:[a-z]|\\\\\.)+(?:\|(?:[a-z]|\\\\\.)+)*)\)\\\\\./.exec(src);
    assert.ok(m, 'NOT_A_STOP is found');
    return m[1].split('|').map((w) => w.replace(/\\\\/g, '') + '.');
  };
  const js = listed(read('../extension/src/rewriteTemplate.js'));
  assert.deepEqual(listed(read('../supabase/functions/_shared/guardrails.ts')), js, 'both checkers list the same ones');
  for (const w of ['e.g.', 'vs.', 'incl.', 'esp.', 'approx.']) assert.ok(js.includes(w), `NOT_A_STOP lists "${w}"`);
  assert.ok(!js.includes('etc.'), '"etc." may end a sentence');
  const sentence = /the dot of ((?:"[^"]+",? (?:or )?)+)ends no sentence/.exec(doc('help.md'));
  assert.ok(sentence, 'help.md says which dots end no sentence');
  assert.deepEqual([...sentence[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...js].sort());
});

test('the adapter contract\'s PLATFORM row names every adapter and quotes no stale unsupported-page message', () => {
  const row = read('../extension/adapters/README.md').split('\n').find((l) => l.startsWith('| `PLATFORM` |')) || '';
  assert.ok(row, 'the PLATFORM row is there');
  for (const a of ADAPTERS) assert.ok(row.includes('`' + a.PLATFORM.id + '`'), `the PLATFORM row names the ${a.PLATFORM.id} adapter`);
  // a quoted message must be the one the extension shows (index.js builds it from every adapter's name)
  const quoted = /What it reads today: ([^"]*?)\.?"/.exec(row);
  if (quoted) assert.equal(quoted[1], platformNames().join('; '));
  // the message as it reads now, in its two groups (checked on a real website, and not yet)
  const groups = /"((?:Checked on a real dealership website|Also tries, not yet checked)[^"]*)"/.exec(row);
  if (groups) assert.ok(unsupportedSiteMessage().includes(groups[1]), `the PLATFORM row quotes "${groups[1]}", which is not the message the extension shows: ${unsupportedSiteMessage()}`);
});

test('the adapter contract and help.md say a car whose own page could not be checked is left unchecked, not that it stops every verdict', () => {
  const contract = read('../extension/adapters/README.md');
  assert.match(contract, /`confirm\.unchecked`, `\{ vin: reason \}`/);
  assert.match(contract, /A refusal \(403, 429, 503, a bot check\) sets `confirm\.error`/);
  assert.doesNotMatch(contract, /Anything else \(403, 429, 5xx/, 'the old whole-check rule for a 5xx is gone');
  assert.match(doc('help.md'), /whose own page could not be checked .* stays under \*\*Needs a look\*\* with the reason/);
  assert.match(read('../PILOT.md'), /Nor does a scan that lists the car under Needs a look as the salesperson's \(still missing but its page could not be checked, say\)/);
});

// The rescan raises a posted car the website marks sale-pending or sold on
// every scan (rescan.js), so its pilot flag stays open until Taken down or
// the website shows it for sale again; the runbook defines "cleared" that way.
test('PILOT.md says a take-down flag on a car the website still marks sale-pending or sold stays open, and when it counts as cleared', () => {
  const cleared = /\("cleared": ([^)]*)\)/.exec(read('../PILOT.md'));
  assert.ok(cleared, 'PILOT.md defines "cleared"');
  assert.match(cleared[1], /for sale again after a sale-pending or sold mark/);
  assert.match(cleared[1], /a car the website still marks sale-pending or sold stays open/);
});

// review: the flag definition left out that a take-down of a car the website
// retyped as new, demo or loaner raises no flag and keeps an open one open
// (pilot.js noteFlags), and that finishing a take-down closes every open flag
// of that car, the price one too (upkeep.js finish, the popup's Taken down).
test('PILOT.md says which take-downs raise no flag, which keep one open, and which flags a finished take-down, price update or unmarking closes', async () => {
  const { noteFlags, resolveFlag } = await import('../extension/src/pilot.js');
  const vin = 'TESTVIN00000000P1';
  const at = (h) => `2026-11-16T${String(h).padStart(2, '0')}:00:00.000Z`;
  const retyped = { takenAt: at(9), takeDown: [{ vin, yours: true, why: 'not-pre-owned', name: 'A' }], priceUpdates: [], needsALook: [] };
  assert.equal(noteFlags(null, retyped).flags.length, 0, 'a take-down of a car the website retyped raises a flag now: PILOT.md changes with it');
  const sold = noteFlags(null, { takenAt: at(8), takeDown: [{ vin, yours: true, why: 'sale-pending', name: 'A' }], priceUpdates: [{ vin, yours: true, from: 20000, to: 19000, name: 'A' }], needsALook: [] });
  const kept = noteFlags(sold, { ...retyped, priceUpdates: [{ vin, yours: true, from: 20000, to: 19000, name: 'A' }] });
  assert.ok(kept.flags.find((f) => f.kind === 'takeDown' && !f.doneAt), 'an open sold-car flag no longer stays open when the website retypes the car: PILOT.md changes with it');
  const done = resolveFlag(kept, vin, null, { at: at(12), how: 'manual' });
  assert.deepEqual(done.flags.map((f) => [f.kind, f.how, f.hours]).sort(), [['price', 'manual', 4], ['takeDown', 'manual', 4]], 'a finished take-down no longer closes and times every open flag of the car');
  assert.deepEqual(resolveFlag(kept, vin, 'price', { at: at(12) }).flags.filter((f) => f.doneAt).map((f) => f.kind), ['price']);
  // where each closes them
  assert.match(read('../extension/upkeep.js'), /resolveFlag\(p, up\.vin, price \? 'price' : null, \{ how \}\)/, 'upkeep no longer closes every flag of the car on a take-down: PILOT.md changes with it');
  const popup = read('../extension/popup.js');
  assert.match(popup, /case 'takenDown':[\s\S]{0,300}?resolveFlag\(p, vin, null, \{ how: 'manual' \}\)/);
  assert.match(popup, /case 'priceUpdated':[\s\S]{0,300}?resolveFlag\(p, vin, 'price', \{ how: 'manual' \}\)/);
  assert.match(popup, /case 'unpost': \{[\s\S]{0,700}?resolveFlag\(p, vin, null, \{ how: 'cleared' \}\)/);

  const line = read('../PILOT.md').split('\n').find((l) => l.startsWith('- **Sold cars and price changes:**'));
  assert.ok(line, 'PILOT.md no longer defines the to-do flags');
  assert.match(line, /A car to take down because the website now calls it new, demo or loaner \(it was not sold\) gets no flag/);
  assert.match(line, /A take-down finished either way \(in upkeep, seen or \*\*I took it down\*\*, or \*\*Taken down\*\* in the popup\) closes every open flag of that car, the sold one and any price change, each timed from its own flagging scan/);
  assert.match(line, /a price update closes only the price flag/);
  assert.match(line, /unmarking \*\*Posted ✓\*\* closes the car's open flags as "cleared"/);
  assert.match(line, /or under Take down because the website now calls it new, demo or loaner: an open sold-car flag of that car stays open/);
});

test('the adapter contract says what the standard-data reader does with robots.txt, as the code does it', () => {
  const contract = read('../extension/adapters/README.md');
  const code = read('../extension/adapters/schemaOrg.js').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (!/disallow|crawl-?delay/i.test(code)) {
    // robots.txt is read for its Sitemap lines only: the contract must not let a reader think its rules are obeyed
    assert.match(contract, /`robots\.txt` is read only for its `Sitemap` lines[^.]*: its `Disallow` and `Crawl-delay` lines are not applied to these reads/);
    assert.match(contract, /open question for the owner/);
  } else {
    assert.match(contract, /`Disallow`/, 'the reader now applies robots.txt rules: the contract must say how');
  }
  assert.match(read('../docs/data-inventory.md'), /`\/robots\.txt` \(read for its sitemap lines only\)/);
});

test('help.md gives the one-car-at-a-time sold check only for the standard-data reader, and the whole-check rule the others still use, as the code words it', () => {
  const help = doc('help.md');
  const own = help.split('\n').find((l) => /whose own page could not be checked/.test(l)) || '';
  assert.match(own, /^- On a website Lot Current reads from the standard vehicle data on each car's page,/, 'the per-car rule is the standard-data reader\'s only');
  // what every other reader still does when its check fails: no car is marked gone that scan
  const one = { vin: 'V1', name: 'Car', decision: 'ready', price: 1 };
  const held = diffScans({ vehicles: { V1: one } }, { vehicles: {} }, { confirm: { checked: [], notFound: [], error: 'HTTP 500' } }).needsALook[0].text;
  // (the standard-data bullet quotes it too, for a refused page: the whole-check rule's own bullet is the other one)
  const rest = help.split('\n').find((l) => l.includes(`"${held}"`) && l !== own) || '';
  assert.match(rest, /^- On Dealer Inspire, DealerOn and Dealer\.com websites, one failed check holds back every missing car for that scan/, `help.md names the readers that still show "${held}"`);
});

test('help.md is organised by what people are trying to do', () => {
  const help = doc('help.md');
  const sections = [
    'Install and update', 'Set up', 'Scan', 'Post one car', 'Post several', 'When a car sells or a price changes', 'The Numbers tab', 'Settings',
    'When a field could not be filled', 'When Facebook restored a draft', 'When Chrome asks for a permission', 'When the website scan fails',
    'When the description writer is off', 'The daily cap', 'What Lot Current never does', 'Where the data lives', 'How to forget the synced profile',
  ];
  for (const s of sections) assert.match(help, new RegExp('^## ' + escapeRe(s), 'm'), `docs/help.md has no "${s}" section`);
  // the three answers for a field that could not be filled
  assert.match(help, /Copy report/);
  assert.match(help, /Send it/);
  assert.match(help, /Fill it by hand/);
});

test('help.md says Lot Current never clicks Publish and is not affiliated with Meta', () => {
  const help = doc('help.md');
  assert.match(help, /You click Publish\. Lot Current never does\./);
  assert.match(help, /never clicks Publish, Update, Delete or Mark as sold/);
  assert.match(help, /Lot Current is not affiliated with Meta Platforms, Inc\./);
  assert.match(help, /not a guarantee/, 'the cap and the design are described honestly');
});

test('no docs/ file carries a pilot-dealer value or Meta-affiliation wording', () => {
  // the pilot dealer is a fixture, not a default (test/anyDealer.test.js)
  const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
  for (const name of DOCS) {
    const text = doc(name);
    const hit = text.match(PILOT);
    assert.equal(hit, null, `docs/${name} contains the pilot value "${hit && hit[0]}"`);
    // test/copyGuards.js and the shared lists (test/honesty.js): what no document may say; salespeople read the
    // help doc, so it is held to the customer-facing rules too (no promise about their account, no made-up number)
    assert.deepEqual(copyProblems(text, { customerFacing: name === 'help.md' }), [], `docs/${name}`);
    assert.deepEqual(honestyProblems(text, { customerFacing: name === 'help.md' }), [], `docs/${name}`);
  }
  // every guide under docs/, the owner's set-up guides too: region is data (CLAUDE.md), so none gives the pilot's
  // state as the reason for a choice (review: the Supabase region was "the closest to Pennsylvania dealers")
  const every = readdirSync(new URL('../docs/', import.meta.url)).filter((f) => f.endsWith('.md'));
  assert.ok(every.includes('production-setup.md'));
  for (const name of every) {
    const hit = doc(name).match(new RegExp(`${PILOT.source}|Pennsylvania`, 'i'));
    assert.equal(hit, null, `docs/${name} contains the pilot value "${hit && hit[0]}"`);
  }
  const region = doc('production-setup.md').split('\n').find((l) => /^\s*- Region:/.test(l));
  assert.match(region, /the one closest to the dealerships Lot Current will serve/, 'the set-up guide does not say how to pick the Supabase region for any dealer');
});

test('support.md has the inbox, what to ask for, the one-business-day answer, the log, the severity words and what is never done', () => {
  const s = doc('support.md');
  supportInbox();
  assert.doesNotMatch(s, /@[\w-]+(\.[\w-]+)*\.example\b/, 'a placeholder inbox is still in docs/support.md');
  assert.match(s, /within one business day/, 'the PLAN.md M6 commitment');
  for (const ask of ['Copy report', 'Settings', 'The website', 'What was on screen']) assert.ok(s.includes(ask), `support.md does not ask for "${ask}"`);
  assert.match(s, /^\| Date \| Dealer \| Who \| What happened \| The report \| Severity \| Fix commit \| Answered when \|$/m, 'the log template');
  for (const w of ['blocks posting', 'wrong data on a listing', 'cosmetic']) assert.ok(s.includes(w), `support.md lacks the severity word "${w}"`);
  assert.match(s, /Never touch a salesperson's Facebook account/);
  assert.match(s, /Never ask for passwords/);
  assert.match(s, /Lot Current is not affiliated with Meta Platforms, Inc\./);
});

test('launch-checklist.md has the six groups, a "done when" on every item and no dates', () => {
  const c = doc('launch-checklist.md');
  for (const g of ['Legal', 'Product', 'Accounts and billing', 'Sales', 'Support', 'Design partners']) assert.match(c, new RegExp('^## ' + g + '$', 'm'), `no "${g}" group`);
  const items = c.split('\n').filter((l) => /^- \[ \]/.test(l));
  assert.ok(items.length >= 20, `${items.length} checklist items`);
  for (const item of items) assert.match(item, /Done when:/, `no "done when" in: ${item.slice(0, 70)}`);
  assert.doesNotMatch(c, /\b(19|20)\d{2}\b/, 'a year in the checklist');
  assert.doesNotMatch(c, /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d/, 'a date in the checklist');
  const wanted = ['attorney', 'Terms of Service and Privacy Policy', 'Entity', 'Insurance', 'unlisted', 'photo-host permission', 'second platform', 'Supabase', 'Stripe', 'manager view', 'pilot numbers', 'sales sheet', 'Demo script', 'inbox', 'help doc', 'log', 'Three to five dealers', 'Sister stores'];
  for (const w of wanted) assert.ok(c.toLowerCase().includes(w.toLowerCase()), `launch-checklist.md does not mention "${w}"`);
});

test('next-platform.md names the four candidates from adapters/README.md, the criteria, a blank scoring table and the required output', () => {
  const n = doc('next-platform.md');
  const readme = read('../extension/adapters/README.md');
  for (const p of ['Dealer.com', 'DealerOn', 'Dealer eProcess', 'DealerFire']) {
    assert.ok(readme.includes(p), `${p} is not a TODO in extension/adapters/README.md`);
    assert.match(n, new RegExp('^### ' + escapeRe(p) + '$', 'm'), `no "${p}" section`);
  }
  assert.match(n, /to be verified on a real site/);
  for (const c of ['Demand from named dealers', 'A real site to verify against', 'How the inventory is exposed', 'Photo host', 'Address data']) assert.ok(n.includes(c), `no criterion "${c}"`);
  // every candidate cell in the scoring table is blank
  const scoring = n.split('## Scoring')[1].split('## ')[0];
  const rows = scoring.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Criterion') && !l.startsWith('|---'));
  assert.ok(rows.length >= 8, `${rows.length} scoring rows`);
  for (const row of rows) assert.match(row, /^\| [^|]+ \|( +\|){4}$/, `scoring row is not blank: ${row.slice(0, 60)}`);
  assert.match(n, /chosen with a written reason and a named first dealer/, 'the PLAN.md M6 wording');
  assert.match(n, /\*\*Chosen platform:\*\* \[platform\]/);
  assert.match(n, /\*\*First dealer:\*\* \[dealer name/);
});

// The memo and the launch checklist once described two adapters, called the
// DealerOn and Dealer.com readers "an idea the owner has not asked for",
// quoted adapters/README.md for a server-rendered DealerOn list it no longer
// describes, and said to write a new adapter "only then" even for a platform
// that has a reader. They follow ADAPTERS: the memo names every reader's
// file and says which candidates have one, and the checklist's contract item
// covers every adapter.
test('next-platform.md and the launch checklist describe the readers ADAPTERS holds', () => {
  const n = doc('next-platform.md');
  const index = read('../extension/adapters/index.js');
  const files = [...index.matchAll(/^import \w+ from '\.\/(\w+)\.js';$/gm)].map((m) => m[1] + '.js');
  assert.equal(files.length, ADAPTERS.length, 'extension/adapters/index.js imports its adapters differently: update this test');
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  assert.match(n, new RegExp(`Today Lot Current has ${WORDS[ADAPTERS.length] || ADAPTERS.length} adapters`), `next-platform.md does not count the ${ADAPTERS.length} adapters in ADAPTERS`);
  for (const f of files) assert.ok(n.includes('`extension/adapters/' + f + '`') || n.includes(f), `next-platform.md does not name ${f}`);
  const section = (p) => (n.split(new RegExp('^### ' + escapeRe(p) + '$', 'm'))[1] || '').split(/^##+ /m)[0];
  const built = platformNames();
  for (const p of ['Dealer.com', 'DealerOn', 'Dealer eProcess', 'DealerFire']) {
    const reader = section(p).split('\n').find((l) => l.startsWith('- **Reader**:')) || '';
    if (built.includes(p)) assert.match(reader, /^- \*\*Reader\*\*: built/, `next-platform.md's ${p} section does not say its reader is built`);
    else assert.match(reader, /^- \*\*Reader\*\*: none yet/, `next-platform.md's ${p} section does not say it has no reader yet`);
    assert.doesNotMatch(section(p), /has not asked for/, `next-platform.md's ${p} section says the owner has not asked for a reader the owner asked for`);
  }
  const adaptersReadme = read('../extension/adapters/README.md');
  if (!/server-rendered/.test(adaptersReadme)) assert.doesNotMatch(n, /server-rendered/, 'next-platform.md quotes extension/adapters/README.md for a server-rendered list it no longer describes');
  const steps = (n.split(/^## Verification steps[^\n]*$/m)[1] || '').split(/^## /m)[0];
  const step5 = steps.split('\n').find((l) => l.startsWith('5. ')) || '';
  assert.match(step5, /reader already there/, "next-platform.md's step 5 says to write a new adapter even for a platform that has a reader");
  const contract = doc('launch-checklist.md').split('\n').find((l) => l.includes('**Adapter contract complete**')) || '';
  assert.match(contract, /every adapter in `ADAPTERS`/, "the launch checklist's adapter contract item does not cover every adapter in ADAPTERS");
});

// supabase/README.md's header said "sign-in by magic link" and "two small
// server functions", and "How the extension is configured" said a Settings
// section takes the project URL and anon key for every salesperson to type.
// The extension signs in with an emailed code, supabase/functions holds four
// functions, and npm run set-project builds the address and key into
// extension/src/accountConfig.js, which the popup reads; Settings has no
// field for them.
test('supabase/README.md counts the functions there are and says the project address is built in, not typed', () => {
  const r = read('../supabase/README.md');
  const fns = readdirSync(new URL('../supabase/functions/', import.meta.url), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name);
  assert.ok(fns.length >= 2, 'supabase/functions/ holds fewer functions than expected');
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const header = r.split('\n## ')[0];
  assert.match(header, new RegExp(`\\b${WORDS[fns.length] || fns.length}\\s+server\\s+functions`), `supabase/README.md's header does not count the ${fns.length} functions in supabase/functions/`);
  for (const f of fns) assert.ok(header.includes('`' + f + '`'), `supabase/README.md's header does not name the ${f} function`);
  assert.doesNotMatch(header, /sign-in\s+by\s+magic\s+link/, "supabase/README.md's header says salespeople sign in by link; the extension asks for the emailed code");
  const popup = read('../extension/popup.js');
  assert.match(popup, /import \{[^}]*\bACCOUNT\b[^}]*\} from '\.\/src\/accountConfig\.js'/, 'the popup no longer takes the project from accountConfig.js: this README section must change with it');
  const configured = (r.split('## How the extension is configured')[1] || '').split('\n## ')[0];
  assert.ok(configured.length > 100, 'supabase/README.md has no "How the extension is configured" section');
  assert.doesNotMatch(configured, /type into every salesperson|takes the \*\*project URL\*\*|with the UI wiring/, 'supabase/README.md says salespeople type the project address and key into Settings');
  assert.match(configured, /npm run set-project/, 'supabase/README.md does not say set-project builds the project address and key in');
  const row = read('../README.md').split('\n').find((l) => l.startsWith('| `supabase/` |')) || '';
  for (const f of fns) assert.ok(row.includes('`' + f + '`'), `README's supabase/ row does not name the ${f} function`);
});

// README's Settings section once gave the sign-off "at the pilot store" with a
// person's first name, one the handoff notes say was guessed from a commit
// identity. A person's name is a dealer-specific value (CLAUDE.md): the
// sign-off is shown with brackets, as the template builds it
// (src/rewriteTemplate.js), and README names no such person anywhere.
test('README shows the description sign-off with brackets and names no guessed person', () => {
  const readme = read('../README.md');
  const you = readme.split('\n').find((l) => l.startsWith('- **You**:'));
  assert.ok(you, 'README no longer explains the You settings');
  assert.match(you, /"I'm \[name\], \[role\] at \[dealership\]"/, "README's You line does not show the sign-off with its brackets");
  assert.doesNotMatch(you, /I'm (?!\[)/, "README's You line signs off with a person's name instead of the bracket");
  assert.doesNotMatch(readme, /\bRoger\b/, 'README names a person whose name was only guessed from a git email');
});

// README's dry-run step said the panel reports on "13 fields" while
// FORM_MAP.fields, which probeFormInPage walks, held 17, so a tester could
// take a short list for a pass. A count of the form's fields in README, the
// help doc or PILOT.md is the form map's.
test('a text that counts the form fields the field check reports gives FORM_MAP\'s number', () => {
  const n = FORM_MAP.fields.length;
  assert.ok(n > 5, 'FORM_MAP.fields is shorter than expected');
  for (const rel of ['../README.md', '../docs/help.md', '../PILOT.md']) {
    for (const line of read(rel).split('\n').filter((l) => /check fields only|field check|fields it can find/i.test(l))) {
      for (const m of line.matchAll(/\b(\d+) (?:form )?fields\b/g)) {
        assert.equal(Number(m[1]), n, `${rel.slice(3)}: "${line.trim().slice(0, 100)}..." counts ${m[1]} fields; FORM_MAP has ${n}`);
      }
    }
  }
});

// README's website paragraph said siteUrl "stays empty until the owner has
// the domain" after site/config.js had been given the domain, so the rule it
// stated was one to put the value back to empty, which would drop the
// canonical, share and sitemap addresses from the next deploy. The paragraph
// gives the address config.js holds, or says it is empty.
test('README\'s website paragraph gives siteUrl as site/config.js holds it', () => {
  const para = read('../README.md').split('\n').find((l) => l.startsWith('Website: '));
  assert.ok(para, 'README has no "Website:" paragraph');
  assert.match(para, /`siteUrl` in `site\/config\.js`/, "README's website paragraph no longer says where the site's address comes from");
  if (SITE.siteUrl) {
    assert.ok(para.includes('`' + SITE.siteUrl + '`'), `README's website paragraph does not give siteUrl as site/config.js holds it (${SITE.siteUrl})`);
    assert.doesNotMatch(para, /stays empty until/, "README says siteUrl stays empty, but site/config.js has it set");
  } else {
    assert.match(para, /empty/, "README's website paragraph does not say siteUrl is empty");
  }
});

// PILOT.md defined the blocked reason `no-permission` as a post started from
// the side panel without the dealership tab. The panel's own list asks Chrome
// before it starts anything and records nothing after a no; the reason is
// recorded when a post that began from a dealership tab has to read the car
// straight from the website (the tab was closed or shows another page) and
// the permission is missing, so the definition names that case.
test('PILOT.md defines no-permission by the posts that record it', () => {
  const panel = read('../extension/sidepanel.js');
  for (const fn of ['postFromList', 'queueFromList']) {
    assert.match(panel, new RegExp(`async function ${fn}\\([^)]*\\) \\{\\n  if \\(!\\(await askForSite\\(\\)\\)\\) return undefined;`), `${fn} no longer asks Chrome before it starts: PILOT.md's no-permission line changes with it`);
  }
  assert.match(panel, /if \(!fresh\.ok && fresh\.needsPermission\) \{[^}]*block\(fresh\.message, 'no-permission'\)/, 'where the panel records no-permission moved: PILOT.md changes with it');
  assert.match(read('../extension/src/vehicleDetails.js'), /if \(!r\.tabUnusable\) return r;/, 'a post from a tab no longer falls through to the direct read only when the tab cannot be used');
  const line = read('../PILOT.md').split('\n').find((l) => l.startsWith('- **Reason (blocked posts):**'));
  assert.ok(line, 'PILOT.md no longer defines the blocked reasons');
  const def = line.slice(line.indexOf('`no-permission`'));
  assert.ok(def.length > 20, 'PILOT.md no longer defines no-permission');
  assert.doesNotMatch(def, /a post started from the side panel without the dealership tab/, 'PILOT.md credits no-permission to side-panel list posts, which ask Chrome first and record nothing after a no');
  assert.match(def, /started from the popup whose dealership tab was closed/, 'PILOT.md does not name the popup post whose dealership tab went');
  assert.match(def, /side panel's own list asks Chrome first and records nothing/, "PILOT.md does not say a side-panel list post records nothing after a no");
});

// PILOT.md's "abandoned" names every way a car is left open: Stop this post
// drops the post through clearFlow, which ends the open attempt as
// abandoned, as Back, Stop queue and a panel closed on it do.
test('PILOT.md counts Stop this post among the abandoned attempts, as the panel records it', () => {
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /async function clearFlow\([^)]*\) \{[\s\S]{0,200}endPost\(p, vin, 'abandoned'\)/, 'dropping a post no longer ends its attempt as abandoned: update PILOT.md and this test');
  assert.match(panel, /case 'stopPost': \{[\s\S]{0,300}await clearFlow\(\);/, 'Stop this post no longer drops the post through clearFlow: update PILOT.md and this test');
  const line = read('../PILOT.md').split('\n').find((l) => l.startsWith('- **Time per post:**'));
  assert.match(line, /A car left open \(the panel closed on it, Back, Stop queue, Stop this post\) is recorded as abandoned/);
});

// The help said the side panel's own list is for "the website you last
// scanned", and the data inventory said lastPostOrigin only reopens a post.
// The panel opens its list on lastPostOrigin when that website is still
// known (src/panelList.js defaultOrigin), which a post, a set-up, a To do
// item and the Website menu write and the popup's Scan does not; the most
// recent scan decides only before the panel has worked on any website.
test('the help and the data inventory say which website the side panel\'s list opens on', () => {
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /defaultOrigin\(stored\[GLOBAL_KEYS\.sites\], lastPostOrigin\)/, 'the panel no longer opens its list on lastPostOrigin: the help and the data inventory change with it');
  assert.match(panel, /async function chooseSite\(origin\) \{[\s\S]*?\[GLOBAL_KEYS\.lastPostOrigin\]: origin/, 'the Website menu no longer writes lastPostOrigin');
  assert.doesNotMatch(read('../extension/popup.js'), /lastPostOrigin/, "the popup now writes lastPostOrigin: say that a scan switches the panel's list");
  const help = doc('help.md');
  const para = help.split('\n').find((l) => l.startsWith('**Post the next car from the side panel.**'));
  assert.ok(para, 'help.md no longer explains the side panel\'s own list');
  assert.doesNotMatch(para, /list for the website you last scanned/, 'help.md says the panel\'s list follows the last scan; it follows the website the panel last worked on');
  assert.match(para, /list for the website it last worked on/, 'help.md does not say the list opens on the website the panel last worked on');
  assert.match(para, /[Ss]canning another website in the popup does not switch it/, 'help.md does not say a scan in the popup leaves the panel\'s website alone');
  const row = doc('data-inventory.md').split('\n').find((l) => l.startsWith('| `lastPostOrigin` |'));
  assert.ok(row, 'the data inventory has no lastPostOrigin row');
  const [, , why, written] = row.split(' | ');
  assert.match(why, /Ready to post\*\* list the side panel opens on/, 'the lastPostOrigin row does not say it picks the website of the side panel\'s list');
  assert.match(written, /\*\*Website\*\* menu/, 'the lastPostOrigin row does not say the Website menu writes it');
});

// help.md's "When the website scan fails" kept naming only Dealer Inspire and
// the standard-data reader after the DealerOn and Dealer.com readers shipped,
// so a salesperson at such a store read that their website could not be
// read. The bullet names every reader adapters/index.js lists, with the
// sample-websites caveat while any of them is not checked on a real one.
test('help.md\'s "not one Lot Current can read yet" bullet names every reader the extension has', () => {
  const bullet = doc('help.md').split('\n').find((l) => l.startsWith('- The website is not one Lot Current can read yet.'));
  assert.ok(bullet, 'help.md no longer explains a website Lot Current cannot read');
  for (const a of ADAPTERS) {
    const name = a.PLATFORM.name;
    const said = /^Standard vehicle data\b/.test(name) ? /standard vehicle data/i : new RegExp(`\\b${escapeRe(name)}\\b`);
    assert.match(bullet, said, `help.md's bullet does not name the ${name} reader`);
  }
  if (ADAPTERS.some((a) => a.PLATFORM.checkedLive !== true)) assert.match(bullet, /tested only on sample websites/, "help.md's bullet does not say which readers were tested only on sample websites");
});

// ---------- the other documents against the code ----------

const manifest = () => JSON.parse(read('../extension/manifest.json'));

test('every text that describes the pilot numbers states the pruning rule with pilot.js\'s numbers', () => {
  // MAX_ENTRIES is private to the module; the source is the one place it is spelled
  const max = Number(read('../extension/src/pilot.js').match(/^const MAX_ENTRIES = (\d+)/m)[1]);
  assert.ok(max > 0);
  const entries = new RegExp(`\\b${max} entries\\b`);
  const days = new RegExp(`\\b${PILOT_RETENTION_DAYS} days\\b`);
  for (const rel of ['../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../docs/help.md', '../PILOT.md', '../HANDOFF.md', '../CHANGELOG.md']) {
    const text = read(rel);
    assert.match(text, entries, `${rel} does not state the ${max}-entry cap per list`);
    assert.match(text, days, `${rel} does not state the ${PILOT_RETENTION_DAYS}-day window`);
    assert.match(text, /open (to-do )?(items?|flags?)[^.]*(excepted|stays?)/i, `${rel} does not say open to-do items are kept`);
  }
  // the legal texts must not also claim the numbers stay until cleared
  for (const rel of ['../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md']) {
    assert.doesNotMatch(read(rel), /usage numbers (stay|are kept) until/i, `${rel} says the usage numbers stay until cleared`);
  }
});

test('help.md quotes the storage-full message as the code shows it, with the two ways out', () => {
  const help = doc('help.md');
  const section = help.slice(help.indexOf('## Where the data lives'), help.indexOf('## How to forget'));
  assert.ok(section.includes(STORAGE_FULL), 'docs/help.md "Where the data lives" does not quote STORAGE_FULL (src/storage.js) word for word');
  const advice = section.slice(section.indexOf(STORAGE_FULL));
  assert.match(advice, /\*\*Clear the numbers\*\* on the \*\*Numbers\*\* tab/, 'the first way out: the Numbers tab');
  assert.match(advice, /\*\*Clear everything for this website\*\*/, 'the second way out: Settings on the old website');
  assert.match(advice, /no longer (post from|use)/, 'says it is an old website, not the current one');
});

// The tab was called Pilot until 0.5.0. The view id and the storage key keep
// that name (renaming the key would orphan installs); every text a person
// reads uses the label the popup renders.
const PERSON_FACING = ['../docs/help.md', '../README.md', '../PILOT.md', '../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../marketing/onboarding-emails.md', '../marketing/positioning.md', '../store/listing.md', '../site/index.html'];

test('the numbers tab is labelled Numbers, help.md lists the tabs as the popup does, and no text a person reads still says Pilot tab', () => {
  const popup = read('../extension/popup.js');
  const block = popup.slice(popup.indexOf('const VIEWS = ['), popup.indexOf('];', popup.indexOf('const VIEWS = [')));
  const views = [...block.matchAll(/^  \['(\w+)', '([^']+)'\],/gm)].map((m) => [m[1], m[2]]);
  assert.ok(views.length >= 7, 'the VIEWS list moved: update this test');
  assert.deepEqual(views.find(([id]) => id === 'pilot'), ['pilot', 'Numbers'], 'the pilot view is labelled Numbers');
  assert.ok(!views.some(([, label]) => label === 'Pilot'));
  assert.ok(popup.includes('Clear the numbers') && popup.includes('Click again to clear the numbers'), 'the clear button and its armed text');
  assert.ok(!popup.includes('Clear pilot numbers'), 'the old button label');
  // help.md names every tab, in the popup\'s order
  const line = doc('help.md').split('\n').find((l) => l.startsWith('- The tabs, left to right:'));
  assert.ok(line, 'docs/help.md lists the tabs');
  let at = -1;
  for (const [, label] of views) {
    const i = line.indexOf(`**${label}**`);
    assert.ok(i > at, `docs/help.md tab list lacks **${label}** in the popup's order`);
    at = i;
  }
  // nothing a person reads sends them to a Pilot tab (the storage-full message is quoted as the code has it)
  for (const rel of PERSON_FACING) {
    const text = read(rel).replace(STORAGE_FULL, '');
    const hit = text.match(/pilot tab|\*\*Pilot\*\*|Pilot →|Clear pilot numbers|clear the pilot numbers|Pilot numbers cleared/i);
    assert.equal(hit, null, `${rel} still says "${hit && hit[0]}"`);
  }
});

test('PILOT.md runs a second dealership on the accounts and the manager view, with the CSV only for an offline machine', () => {
  const runbook = read('../PILOT.md');
  const heading = '## Running a pilot at a second dealership';
  const start = runbook.indexOf(heading);
  assert.ok(start >= 0, `PILOT.md has no "${heading}" section`);
  const end = runbook.indexOf('\n## ', start + heading.length);
  const section = runbook.slice(start, end > 0 ? end : undefined);
  for (const path of ['`manager/`', '`supabase/README.md`', '`marketing/onboarding-store.md`']) assert.ok(section.includes(path), `the section does not point at ${path}`);
  // the manager view\'s tables and buttons, as manager/manager.js labels them
  const manager = read('../manager/manager.js') + read('../manager/data.js');
  for (const label of ['Salespeople', 'Sold cars still listed', 'Price changes not yet updated', 'Send me a sign-in link', 'Download CSV', 'Invite a salesperson']) {
    assert.ok(manager.includes(label), `"${label}" is no longer a label in manager/: update PILOT.md and this test together`);
    assert.ok(section.includes(label), `PILOT.md's second-dealership section does not name "${label}"`);
  }
  // the extension\'s controls, as popup.js labels them
  const popup = read('../extension/popup.js');
  for (const label of ['Send me a sign-in code', 'Sign in', 'Join', 'Numbers']) {
    assert.ok(popup.includes(label), `"${label}" is no longer a label in popup.js: update PILOT.md and this test together`);
    assert.ok(section.includes(label), `PILOT.md's second-dealership section does not name "${label}"`);
  }
  assert.match(section, /offline/, 'the Numbers tab\'s CSV is for an offline machine only');
  assert.doesNotMatch(section, /each salesperson clicks \*\*Numbers/, 'a CSV per person is not the weekly loop');
  assert.match(section, /price note[^.]*typed once|typed once[^.]*price note/i, 'the price note is typed once in Settings');
  assert.match(section, /Nothing about the store[^.]*code/, 'nothing dealer-specific goes into code');
  // the first pilot\'s way is described as the first pilot\'s, not as the only way
  assert.doesNotMatch(runbook, /no shared view/);
  assert.match(runbook, /reads the manager view instead/, 'the weekly loop points at the second-dealership section');
  assert.match(runbook, /called \*\*Numbers\*\*/, 'the runbook says what the tab is called');
});

test('help.md describes the Terms step and the Settings section in both states the code renders', () => {
  const help = doc('help.md');
  const wizard = read('../extension/wizard.js') + read('../extension/src/wizardSteps.js');
  const popup = read('../extension/popup.js');
  const tick = 'I have read and accept the Terms of Service and the Privacy Policy';
  assert.ok(wizard.includes(tick) && popup.includes(tick), 'the tick label moved: update the help doc and this test together');
  assert.ok(wizard.includes('being finalised') && popup.includes('being finalised'), 'the informational variant (legalHosted() false) moved');
  const setup = help.slice(help.indexOf('## Set up'), help.indexOf('## Scan'));
  const settings = help.slice(help.indexOf('## Settings'), help.indexOf('## When a field'));
  for (const [name, text] of [['Set up', setup], ['Settings', settings]]) {
    const terms = text.slice(text.indexOf('**Terms and privacy**'));
    assert.ok(terms.length > 100, `docs/help.md "${name}" has no Terms and privacy entry`);
    assert.match(terms, /being finalised/, `docs/help.md "${name}" does not describe the informational step`);
    assert.match(terms, /published/, `docs/help.md "${name}" does not say when the links and the tick appear`);
    assert.ok(terms.includes(tick), `docs/help.md "${name}" does not quote the tick`);
  }
  // while the documents are drafts no acceptance is recorded, but the usage
  // numbers are recorded from the first post: the help never says the step
  // "records nothing"
  const step = setup.slice(setup.indexOf('**Terms and privacy**'));
  assert.doesNotMatch(step.slice(0, step.indexOf('\n')), /records nothing|nothing is recorded/, 'docs/help.md says the Terms step records nothing while the usage numbers are recorded from the first post');
  assert.match(step, /records no acceptance/);
});

// The salesperson part of the profile, in the words the lists use.
const SALESPERSON_WORDS = { name: 'name', title: 'role', closingLine: 'closing line' };

test('the synced-profile lists name the Terms acceptance and every salesperson field the profile carries', () => {
  assert.ok(Object.keys(profileFrom({})).includes('legal'), 'the profile no longer carries the acceptance: update the lists');
  assert.deepEqual(Object.keys(profileFrom({}).salesperson).sort(), Object.keys(SALESPERSON_WORDS).sort(), 'the salesperson part of the profile changed: update the lists and SALESPERSON_WORDS');
  for (const rel of ['../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../docs/help.md', '../store/listing.md', '../extension/popup.js']) {
    const lists = read(rel).match(/\(name, role, [^)]*\)/g) || [];
    assert.ok(lists.length, `${rel} has no profile list`);
    for (const l of lists) {
      assert.match(l, /Terms acceptance/, `${rel} profile list lacks the Terms acceptance: ${l}`);
      for (const word of Object.values(SALESPERSON_WORDS)) assert.ok(l.includes(word), `${rel} profile list lacks "${word}": ${l}`);
    }
  }
});

test('README.md carries the shipped version in its title and the queue controls as the popup labels them', () => {
  const readme = read('../README.md');
  const [major, minor] = manifest().version.split('.');
  assert.match(readme, new RegExp(`^# Lot Current \\(v${major}\\.${minor}\\)`), `README.md title is not v${major}.${minor}`);
  const popup = read('../extension/popup.js');
  assert.ok(popup.includes('Select the next ') && popup.includes('Post selected'), 'the queue labels moved: update README and help.md');
  assert.doesNotMatch(readme, /Select all/, 'README.md names a control the popup does not have');
  assert.match(readme, /\*\*Select the next N\*\*/);
  assert.match(readme, /\*\*Post selected\*\*/);
});

test('the CHANGELOG entry for the shipped version names what support and the help doc send people to', () => {
  const changelog = read('../CHANGELOG.md');
  // 0.5.0 is the release these shipped in; later entries need not repeat them
  const start = changelog.indexOf('## 0.5.0 (');
  assert.ok(start >= 0, 'CHANGELOG.md has no 0.5.0 section');
  const end = changelog.indexOf('\n## ', start + 1);
  const section = changelog.slice(start, end > 0 ? end : undefined);
  assert.match(section, /Copy problem report/, 'the button support.md asks for in every report');
  assert.match(section, /storageKeys\.js/, 'the storage hardening');
  assert.match(section, /STORAGE_FULL/, 'the storage-full message');
});

test('the files support.md and the launch checklist say hold the support address do hold it', () => {
  const inbox = supportInbox();
  for (const name of ['support.md', 'launch-checklist.md']) {
    assert.doesNotMatch(doc(name), /\bsupport@[\w-]+(\.[\w-]+)*\.example\b/, `docs/${name} still names a placeholder inbox`);
    const lines = doc(name).split('\n').filter((l) => l.includes(inbox));
    assert.ok(lines.length, `docs/${name} does not name the support inbox ${inbox}`);
    for (const line of lines) {
      const paths = [...line.matchAll(/`([\w./-]+\.(?:md|js))`/g)].map((m) => m[1]).filter((p) => p !== 'docs/' + name);
      for (const p of paths) {
        const url = new URL('../' + p, import.meta.url);
        assert.ok(existsSync(url), `${p}, named in docs/${name}, does not exist`);
        assert.ok(readFileSync(url, 'utf8').includes(inbox), `docs/${name} says the support address lives in ${p}, which does not have ${inbox}`);
      }
    }
  }
  // the website shows the same address once it has one
  if (SITE.supportEmail) assert.equal(SITE.supportEmail, inbox, 'site/config.js supportEmail is not the inbox docs/support.md gives');
});

// store/listing.md is what goes into the Web Store dashboard: its homepage and
// support lines are the site and the inbox, and its legal addresses are the
// ones the wizard links to, placeholders until the texts are final.
test('store/listing.md gives the site, the support inbox and the legal addresses legalLinks.js holds', () => {
  const listing = read('../store/listing.md');
  const inbox = supportInbox();
  const section = listing.slice(listing.indexOf('## Support and homepage'), listing.indexOf('## Before submitting'));
  assert.ok(section.startsWith('## Support and homepage'), 'store/listing.md has no "Support and homepage" section');
  const values = (label) => {
    const line = section.split('\n').find((l) => l.startsWith(`- ${label}: `));
    assert.ok(line, `store/listing.md has no "${label}" line`);
    return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  };
  assert.doesNotMatch(listing, /\[support email\]|\[support page URL\]/, 'store/listing.md still has a support bracket');
  const [home] = values('Homepage');
  assert.match(home, /^https:\/\/[^/]+\/$/, 'the homepage is not an https origin with its slash');
  assert.doesNotMatch(new URL(home).hostname, PLACEHOLDER_HOST, 'the homepage is a placeholder');
  if (SITE.siteUrl) assert.equal(home, SITE.siteUrl + '/', 'the homepage is not siteUrl in site/config.js');
  const supportPage = new URL('support/', home).href;
  assert.deepEqual(values('Support'), [inbox, supportPage], 'the support line is not the inbox and the support page');
  assert.ok(existsSync(new URL('../site/support/index.html', import.meta.url)), 'the support page the listing names is not in site/');
  const described = listing.split('\n').find((l) => l.startsWith('Support: '));
  assert.ok(described && described.includes(inbox) && described.includes(supportPage), 'the detailed description does not give the support inbox and page');
  // the three documents, and the privacy policy URL in the privacy answers, are LEGAL's addresses
  assert.deepEqual(values('Terms of Service'), [LEGAL.termsUrl]);
  assert.deepEqual(values('Privacy Policy'), [LEGAL.privacyUrl]);
  assert.deepEqual(values('Posting rules'), [LEGAL.rulesUrl]);
  assert.ok(listing.includes(`Privacy policy URL: \`${LEGAL.privacyUrl}\``), 'the privacy answers give another privacy policy URL than legalLinks.js');
});

// Set-up reads the website and finishes with one more read, which saves the
// snapshot, and the popup's button reads "Rescan website" once a snapshot is
// saved. The Web Store reviewer's steps say the list is already there after
// set-up, not to click a "Scan website" button the popup no longer shows.
test('the store reviewer\'s steps say set-up has already read the website, and name the button the popup shows then', () => {
  const wizard = read('../extension/wizard.js');
  const finish = wizard.slice(wizard.indexOf('async function finish('));
  assert.match(finish, /^async function finish\([^]*?const ok = await runScan\(ctx\);/, 'set-up no longer ends with a read: update store/listing.md step 2 and this test');
  assert.match(wizard, /chrome\.storage\.local\.set\(\{ \[k\.snapshot\]: kept/, 'set-up\'s read no longer saves the snapshot: update store/listing.md step 2 and this test');
  assert.match(read('../extension/popup.js'), /\$\('scan'\)\.textContent = state\.snapshot \? 'Rescan website' : 'Scan website';/, 'the popup\'s scan button has another label: update store/listing.md step 2 and this test');
  const step = read('../store/listing.md').split('\n').find((l) => l.startsWith('2. Click the Lot Current icon in the toolbar.'));
  assert.ok(step, 'store/listing.md lost the reviewer\'s set-up step');
  assert.doesNotMatch(step, /click Scan website/i, 'the reviewer is told to click Scan website, which the popup shows only before a scan is saved');
  assert.match(step, /Set-up reads the website and ends with one more read[^.]*the Ready to post tab already lists the pre-owned cars at that store \(Rescan website, at the top of the popup, reads the website again\)/);
});

// Every Markdown or script file outside the docs and the history that holds
// the website's support address is named on support.md's inbox line, so a
// change of address reaches all of them (the Terms and the onboarding email
// once kept the old one).
test('support.md names every file that carries the support address', () => {
  if (!SITE.supportEmail) return; // no address yet: nothing carries it
  const line = doc('support.md').split('\n').find((l) => l.startsWith('- Address:'));
  assert.ok(line, 'support.md has no inbox line');
  const named = new Set([...line.matchAll(/`([\w./-]+\.(?:md|js))`/g)].map((m) => m[1]));
  const SKIP = new Set(['node_modules', '.git', 'docs', 'test', 'CHANGELOG.md', 'HANDOFF.md']);
  const walk = (dir) => readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true }).flatMap((e) => {
    const rel = dir + e.name;
    if (SKIP.has(rel)) return [];
    if (e.isDirectory()) return walk(rel + '/');
    return /\.(md|js)$/.test(e.name) ? [rel] : [];
  });
  const carriers = walk('').filter((rel) => read('../' + rel).includes(SITE.supportEmail));
  assert.ok(carriers.length, 'no file carries the support address');
  for (const rel of carriers) assert.ok(named.has(rel), `${rel} carries ${SITE.supportEmail} but support.md's inbox line does not name it`);
});

test('HANDOFF.md 5.1 names every settings key and the profile rule, and 5.7 lists the wizard steps in order', () => {
  const handoff = read('../HANDOFF.md');
  const s51 = handoff.slice(handoff.indexOf('### 5.1'), handoff.indexOf('### 5.2'));
  const line = s51.split('\n').find((l) => l.startsWith('- `settings:<origin>`'));
  assert.ok(line, 'HANDOFF.md 5.1 documents settings:<origin>');
  for (const key of Object.keys(withDefaults({}))) {
    assert.ok(new RegExp(`[\\s{,]${key}[\\s:,\\[}]`).test(line), `HANDOFF.md 5.1 settings shape lacks "${key}"`);
  }
  // the profile is keyed on the website it was saved from, never the editable dealer name (CLAUDE.md)
  const profile = s51.split('\n').find((l) => l.includes('chrome.storage.sync `profile`'));
  assert.ok(profile, 'HANDOFF.md 5.1 documents the synced profile');
  assert.doesNotMatch(profile, /dealer name matches/, 'the rule 0.4.0 removed');
  assert.match(profile, /`origin`/);
  assert.match(profile, /never the key/);
  const steps = wizardSteps(true); // every step; the Account step shows only when accounts are configured
  const heading = handoff.match(/^### 5\.7 .*steps `([^`]+)`/m);
  assert.ok(heading, 'HANDOFF.md 5.7 lists the steps');
  assert.deepEqual(heading[1].split(',').map((s) => s.trim()), steps, 'HANDOFF.md 5.7 step list differs from src/wizardSteps.js wizardSteps(true)');
});

// Round J's photo permission: Chrome keeps a grant, and the side panel keeps a
// refusal only in memory, so a "no" is asked again once the panel reopens.
// The CHANGELOG entry sits under "## Unreleased" until a release renames that
// heading to the version's and puts an empty "## Unreleased" above it
// (scripts/release.mjs), so the entry is found by its title, not by place;
// test/release.test.js runs this file on that layout.
test('the texts say Chrome remembers a yes, and a no only while the side panel stays open', () => {
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /^const refusedPhotoServers = new Set\(\);$/m, 'the side panel no longer keeps photo refusals in a Set: check what the texts below say');
  assert.ok(!panel.split('\n').some((l) => l.includes('refusedPhotoServers') && /storage/.test(l)), 'the side panel stores photo refusals now: the texts can say Chrome or Lot Current remembers a no');
  const sections = read('../CHANGELOG.md').split(/\n(?=## )/).slice(1);
  const unreleased = sections.find((s) => /^## Unreleased[ \t]*(\n|$)/.test(s));
  assert.ok(unreleased !== undefined, 'CHANGELOG.md has no "## Unreleased" heading');
  const photo = sections.find((s) => s.includes('\n- **Photos from any server'));
  assert.ok(photo, 'CHANGELOG.md has no "Photos from any server" entry');
  const photoHeading = photo.slice(3, photo.indexOf('\n'));
  const texts = { 'README.md': read('../README.md'), 'CHANGELOG.md (Unreleased)': unreleased, [`CHANGELOG.md (${photoHeading})`]: photo, 'docs/help.md': doc('help.md'), 'store/listing.md': read('../store/listing.md'), 'marketing/demo-script.md': read('../marketing/demo-script.md') };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /remembers (the|your) answer|asks once/i, `${name} says a photo-server answer is remembered, and a no is forgotten when the side panel closes`);
  }
  const line = texts['README.md'].split('\n').find((l) => l.startsWith('- Photos on a server'));
  assert.ok(line, "README's Limits no longer has the photo-server line");
  assert.match(line, /remembers a yes/);
  assert.match(line, /while the side panel stays open/);
  const entry = photo.split('\n').find((l) => l.startsWith('- **Photos from any server'));
  assert.match(entry, /Chrome remembers a yes, and after a no Lot Current doesn't ask about that server again while the side panel stays open/);
});

test('the pre-submission checklists quote only what PLAN.md says', () => {
  const plan = read('../PLAN.md');
  for (const name of ['store/listing.md', 'docs/launch-checklist.md']) {
    for (const line of read('../' + name).split('\n').filter((l) => /^- \[ \]/.test(l) && l.includes('PLAN.md'))) {
      // a quote right after the file's name: PLAN.md ("..."), (PLAN.md, "...")
      for (const m of line.matchAll(/PLAN\.md`?,? ?\(?"([^"]+)"/g)) {
        assert.ok(plan.includes(m[1]), `${name} sends the reader to PLAN.md's "${m[1]}", which PLAN.md does not have: ${line.slice(0, 80)}`);
      }
    }
  }
  const item = read('../store/listing.md').split('\n').find((l) => /^- \[ \]/.test(l) && l.includes('vehicle-images.carscommerce.inc'));
  assert.ok(item, 'store/listing.md has no pre-submission item for the static photo host');
  assert.doesNotMatch(item, /requested at post time/, 'the checklist asks again whether photo servers are requested at post time, which PLAN.md records as decided');
  assert.match(item, /real Chrome/, 'the checklist item names the one run by hand in real Chrome that is left');
});

test('README\'s pre-owned rules say what classify.js decides when the signs mix', () => {
  const para = read('../README.md').split('## How the pre-owned check works')[1].split('\n## ')[0];
  const sentence = (word) => {
    const s = para.split(/(?<=\.) (?=[A-Z])/).filter((x) => x.includes(word)).join(' ');
    assert.ok(s, `README's pre-owned section no longer says anything about ${word}`);
    return s;
  };
  const verdict = (v) => checkPreOwned({ inventoryType: null, urlConditionWord: null, siteTitle: '', ...v }).verdict;
  // a car the website lists as damaged or refurbished
  assert.equal(verdict({ inventoryType: 'Refurbished', urlConditionWord: 'used' }), 'review');
  const worn = sentence('damaged or refurbished');
  assert.match(worn, /\*\*Needs a look\*\*/);
  if (verdict({ inventoryType: 'Damaged', urlConditionWord: 'new' }) === 'new' && verdict({ inventoryType: 'Refurbished', isDemo: true }) === 'new') {
    assert.doesNotMatch(worn, /always/, 'README says a damaged or refurbished car always goes to Needs a look; a new or demo sign wins first');
    assert.match(worn, /unless[^.]*skipped as new[^.]*demo or loaner flag[^.]*new sign with no pre-owned one/, 'README does not say which signs are skipped as new first');
  }
  // a demo or loaner flag
  assert.equal(verdict({ inventoryType: 'Used', isDemo: true }), 'review');
  const demo = sentence('demo or loaner flag means');
  assert.doesNotMatch(demo, /always/, 'README says a demo flag always means sold as new; a pre-owned demo goes to Needs a look');
  assert.match(demo, /pre-owned and nowhere new, it goes to \*\*Needs a look\*\*/);
});

// The e2e flows are listed in four places besides their files, and a merge that keeps one side of a
// conflicting list would quietly stop CI running a flow: the files are the one list the others follow.
test('the e2e flows agree: test/e2e files, package.json scripts, the CI matrix, e2e-all.mjs and README\'s count', () => {
  const files = readdirSync(new URL('./e2e/', import.meta.url)).filter((f) => f.endsWith('.e2e.mjs')).map((f) => f.replace(/\.e2e\.mjs$/, '')).sort();
  assert.ok(files.length >= 1, 'test/e2e holds the flows');
  const pkg = JSON.parse(read('../package.json'));
  const scripts = Object.keys(pkg.scripts).filter((k) => /^test:e2e:/.test(k) && k !== 'test:e2e:parallel');
  assert.deepEqual(scripts.map((k) => k.slice('test:e2e:'.length)).sort(), files, 'package.json has one test:e2e:<flow> script per test/e2e/<flow>.e2e.mjs');
  for (const flow of files) assert.equal(pkg.scripts['test:e2e:' + flow], `node test/e2e/${flow}.e2e.mjs`, `test:e2e:${flow} runs its own file`);
  const matrix = read('../.github/workflows/ci.yml').match(/^\s*flow: \[([^\]]*)\]/m);
  assert.ok(matrix, 'ci.yml no longer has the e2e job\'s flow matrix');
  assert.deepEqual(matrix[1].split(',').map((f) => f.trim()).sort(), files, 'ci.yml\'s e2e matrix runs every flow, and only those');
  const all = read('../scripts/e2e-all.mjs').match(/^const FLOWS = \[([^\]]*)\];/m);
  assert.ok(all, 'scripts/e2e-all.mjs no longer has its FLOWS list');
  assert.deepEqual(all[1].split(',').map((f) => f.trim().replace(/^'|'$/g, '')).sort(), files, 'e2e-all.mjs runs every flow, and only those');
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const readme = read('../README.md').match(/^npm run test:e2e\s+# (\w+) e2e flows/m);
  assert.ok(readme, 'README.md no longer counts the e2e flows on its npm run test:e2e line');
  assert.equal(readme[1], WORDS[files.length] || String(files.length), 'README.md\'s count of e2e flows');
});

// The settings never guess a town from a store name (src/settings.js
// withDefaults): the dealership's city, state and ZIP come from the website's
// own address or from a person. The texts a salesperson or dealer reads say
// so, instead of promising an address that is always already filled in.
test('help, README and the onboarding emails say the address comes from the website only when it shows one', () => {
  assert.equal(withDefaults({ myStores: ['Example Auto Mall'] }, { name: 'Example Auto Mall' }).dealer.city, '', 'the city is never guessed from a store name');
  const step = doc('help.md').split('\n').find((l) => l.includes("**The store's address**"));
  assert.ok(step, "docs/help.md describes the wizard's address step");
  assert.match(step, /when it shows one/, 'docs/help.md does not say the address is read only when the website shows one');
  assert.match(step, /never guesses a town/, 'docs/help.md does not say a missing town is asked for, not guessed');
  for (const rel of ['../README.md', '../docs/help.md', '../marketing/onboarding-emails.md', '../marketing/onboarding-store.md']) {
    assert.doesNotMatch(read(rel), /already filled from the website/i, `${rel} promises the address is always filled from the website`);
  }
  // README's set-up step and its Dealership setting said "(read from the website)" and "normally there is nothing to type"
  const readme = read('../README.md');
  const setup = readme.split('\n').find((l) => l.includes('**Set up Lot Current**'));
  assert.ok(setup, "README's Use section describes set-up");
  assert.doesNotMatch(readme, /address \(read from the website\)|normally there is nothing to type/, 'README promises the address is always read from the website');
  assert.match(setup, /the store's address \(filled from the website when it shows one; type any part it leaves blank\)/, "README's set-up step does not say a missing part of the address is typed");
  const dealership = readme.split('\n').find((l) => l.startsWith('- **Dealership**:'));
  assert.match(dealership, /when it shows one, and leaves blank any part it does not give for you to type/, "README's Dealership setting does not say a missing part is typed");
});

test('the docs say the template writes the description from the car\'s listed facts and does not copy the website\'s write-up', () => {
  // the template once copied the website's opening sentences, and the help kept saying so after the code stopped
  const COPIES = [/write-up line/i, /opening sentences/i, /write-up is kept/i, /\bcop(?:y|ies|ied)\b[^.]{0,40}\bsentences\b/i, /real write-up on the website/i];
  const SAYS_NOT = /\b(?:does not copy|not copied from) (?:the website's |its )write-up\b/;
  const telling = ['../docs/help.md', '../README.md', '../store/listing.md', '../site-src/pages/home.html', '../site-src/pages/how-it-works.html', '../marketing/positioning.md', '../marketing/demo-script.md'];
  for (const rel of [...telling, '../docs/data-inventory.md', '../site/index.html', '../site/how-it-works/index.html']) {
    const text = read(rel);
    for (const re of COPIES) assert.doesNotMatch(text, re, `${rel} matches ${re}`);
  }
  for (const rel of telling) assert.match(read(rel), SAYS_NOT, `${rel} does not say the description is not copied from the website's write-up`);
  // and the help says what the rewrite service is sent instead, and that its draft is checked
  const help = doc('help.md');
  assert.ok(help.includes("The template builds the description from the car's listed facts"), 'docs/help.md does not say what the template builds the description from');
  assert.ok(help.includes('the write-up is sent to it as the website wrote it, in whole lines joined into one text (so a sentence the website breaks across lines arrives whole), from its first line up to the first line Lot Current leaves out'), 'docs/help.md does not say what the rewrite service is sent');
  assert.ok(help.includes("The service's draft goes through the same checks"), "docs/help.md does not say the service's draft is checked");
});

// README gives the number of test( and it( call sites in test/*.test.js, and
// node --test runs each one once only while every call site stands alone at the
// start of a line: a test made in a loop or a callback is indented or follows
// other code on its line, and a subtest (t.test) or a node:test describe/suite
// adds tests the count never sees. testSiteProblems refuses all of those.
const TEST_CALL = /(?<![.\w$])(?:test|it)(?:\.(?:only|skip|todo))?\(/g;
const NODE_TEST_NAMES = new Set(['test', 'after', 'afterEach', 'before', 'beforeEach', 'mock']);
function testSiteProblems(src) {
  const problems = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(TEST_CALL)) if (m.index !== 0) problems.push(`line ${i + 1}: a test call not at the start of its line: ${line.trim().slice(0, 60)}`);
    if (/\b(?:t|ctx|context)\.(?:test|it|describe|suite)\(/.test(line)) problems.push(`line ${i + 1}: a subtest: ${line.trim().slice(0, 60)}`);
  });
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]node:test['"]/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name && !NODE_TEST_NAMES.has(name)) problems.push(`imports ${name} from node:test`);
    }
  }
  for (const m of src.matchAll(/^import\b[^\n]*from\s*['"]node:test['"]/gm)) if (!/^import\s*\{[^}]*\}\s*from/.test(m[0])) problems.push(`imports node:test other than by name: ${m[0]}`);
  return problems;
}

test('every test in test/*.test.js is one call site at the start of its line, so README\'s count is what npm test runs', () => {
  const dir = new URL('./', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
    assert.deepEqual(testSiteProblems(readFileSync(new URL(f, dir), 'utf8')), [], `test/${f}`);
  }
  // the check itself sees a test made in a loop, in a callback, as a subtest or by describe
  // (written with TEST so this file's own lines do not hold the shapes they show)
  const probe = (src) => testSiteProblems(src.replaceAll('TEST', 'test'));
  assert.notDeepEqual(probe("for (const n of [1, 2]) {\n  TEST('car ' + n, () => {});\n}\n"), []);
  assert.notDeepEqual(probe("[1, 2].forEach((n) => TEST('car ' + n, () => {}));\n"), []);
  assert.notDeepEqual(probe("TEST('cars', async (t) => {\n  await t.TEST('one', () => {});\n});\n"), []);
  assert.notDeepEqual(probe("import { TEST, describe } from 'node:test';\n"), []);
  assert.notDeepEqual(probe("import * as nt from 'node:test';\n"), []);
  assert.deepEqual(probe("import { TEST, after } from 'node:test';\n// a comment naming TEST( is fine\nTEST('one', () => { assert.ok(/x/.test('x')); });\n"), []);
});

test('a checkout with CRLF line ends reads as LF, so the CHANGELOG headings are still found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-current-crlf-'));
  try {
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, read('../CHANGELOG.md').replace(/\n/g, '\r\n'));
    const text = read(pathToFileURL(file).href);
    assert.ok(!text.includes('\r'), 'read() keeps the carriage returns of a CRLF file');
    const sections = text.split(/\n(?=## )/).slice(1);
    assert.ok(sections.some((s) => /^## Unreleased[ \t]*(\n|$)/.test(s)), 'the "## Unreleased" heading is not found in a CRLF copy of CHANGELOG.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README\'s unit-test count is the number of tests npm test runs', () => {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.js'));
  let count = 0;
  for (const f of files) count += (readFileSync(new URL(f, dir), 'utf8').match(/^\s*(?:test|it)(?:\.(?:only|skip|todo))?\(/gm) || []).length;
  const m = read('../README.md').match(/^npm test\s+# (\d+) unit tests/m);
  assert.ok(m, 'README.md no longer gives the unit-test count on its npm test line');
  assert.equal(Number(m[1]), count, `README.md says ${m[1]} unit tests, and test/*.test.js holds ${count}`);
});

// The 3-hourly rescan is the one thing that runs with nobody at the computer,
// and for a signed-in salesperson it is a read and an upload: runRescan in
// background.js ends with syncSite, which sends the posted list, the post
// attempts, the to-do items and the scan's counts to the dealership's
// account. Every text that tells a person what Lot Current does on its own
// names both, and none says it only reads the website: not the texts that
// describe the rescan, and not the marketing kit a dealer reads first.
// (site-src's "It only reads your own public website" is about the popup's
// Scan website button, which uploads nothing, so the website is not held to
// this.)
const ONLY_READS = /one thing it does on its own|only read[s]? (your|the)[^.]*website|except (to )?read/i;
test('every text that says what Lot Current does on its own names the upload a signed-in rescan sends', () => {
  const bg = read('../extension/background.js');
  const rescan = bg.slice(bg.indexOf('async function runRescan'), bg.indexOf('async function rescanDueSites'));
  assert.ok(rescan.length > 100 && /\bsyncSite\(/.test(rescan), 'the background rescan no longer syncs: change these texts with it');
  const TEXTS = ['../README.md', '../store/listing.md', '../docs/help.md', '../extension/popup.js', '../legal/chrome-web-store-privacy.md'];
  const MARKETING = readdirSync(new URL('../marketing/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../marketing/${f}`);
  assert.ok(MARKETING.includes('../marketing/pilot-offer-email.md'));
  for (const rel of [...TEXTS, ...MARKETING]) {
    for (const line of read(rel).split('\n')) {
      assert.doesNotMatch(line, ONLY_READS, `${rel} says the background rescan only reads the website: "${line.trim().slice(0, 120)}"`);
      // a line that says what the automatic rescan reads says what it sends
      if (/\b(automatic rescans?|in the background it) (re-)?read/i.test(line)) assert.match(line, /signed in to a Lot Current account, (it also )?sends? (that rescan's |the )results/, `${rel}: "${line.trim().slice(0, 90)}..." leaves out what a signed-in rescan sends`);
    }
  }
  for (const rel of TEXTS) {
    const text = read(rel);
    // the lines that describe the unattended rescan: "every 3 hours" with what it never does then, or the Settings hint once the permission is granted
    const lines = text.split('\n').filter((l) => (/every 3 hours while Chrome is open/.test(l) && /never (touches Facebook|opens or reads Marketplace)/i.test(l)) || /in the background: granted/.test(l));
    assert.ok(lines.length >= 1, `${rel} no longer describes the background rescan`);
    for (const l of lines) assert.match(l, /[Ww]hile (you are|they are|the user is) signed in to a Lot Current account, (it also )?sends that rescan(\\)?'s results/, `${rel}: "${l.trim().slice(0, 90)}..." leaves out what a signed-in rescan sends`);
  }
  // the store listing's tester steps and set-up's permission step say it too
  const SAYS_SYNC = /signed in[^.|]*(sync|sends? (that rescan's |the )?results)/;
  const tester = read('../store/listing.md').split('\n').find((l) => l.includes('Background rescans happen only'));
  assert.ok(tester, 'store/listing.md no longer has its tester step about background rescans');
  assert.match(tester, SAYS_SYNC, 'store/listing.md: the tester step about background rescans does not say they sync while signed in');
  const wizard = read('../extension/wizard.js');
  const step = wizard.slice(wizard.indexOf("case 'permission':"), wizard.indexOf("case 'rules':"));
  assert.ok(step.length > 100, "wizard.js's permission step moved: update this test");
  assert.match(step, SAYS_SYNC, 'the set-up permission step does not say the rescan sends its results while signed in');
  assert.doesNotMatch(wizard, ONLY_READS, 'set-up says the background job only reads the website');
  // the help doc's list of what leaves the browser includes the unattended rescan and its sync, so it is not "only when you act"
  for (const rel of TEXTS) assert.doesNotMatch(read(rel), /only when you act/i, `${rel} says data leaves the browser only when the person acts, but an allowed rescan reads the website and syncs on its own`);
});

// The screenshot captions, README and the help doc once said the numbers were
// "kept in your browser" after accounts began syncing them to the dealership's
// account. A line that says so also names that account and signing in.
test('copy that says the numbers are kept in the browser also says they go to the dealership\'s account while signed in', () => {
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../${dir}/${f}`);
  const files = ['../README.md', '../store/listing.md', ...md('docs'), ...md('marketing'), ...readdirSync(new URL('../site-src/pages/', import.meta.url)).filter((f) => f.endsWith('.html')).map((f) => '../site-src/pages/' + f)];
  let seen = 0;
  for (const f of files) {
    for (const line of read(f).split('\n').filter((l) => /kept in (?:your|this) browser(?!')/i.test(l))) {
      seen++;
      assert.ok(/dealership's account/.test(line) && /\bsign(?:ed)? in\b/.test(line), `${f.slice(3)}: "${line.trim().slice(0, 120)}" leaves out the sync to the dealership's account`);
    }
  }
  assert.ok(seen >= 4, 'README, the help doc, the store listing and the website still describe where the numbers are kept');
});

// README once said each salesperson's posted list was "kept only in their own
// browser" after the committed account config began offering sign-in and
// the sync began sending that list to the dealership's account. While the
// config names a project, no tester or launch text says so, and a line that
// says the posted list is kept in the browser names the sync too.
test('while accounts are configured, no text says the posted list stays only in the browser', () => {
  if (!accountsConfigured()) return;
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../${dir}/${f}`);
  const ONLY_HERE = /kept only in (?:their|your|this|the) (?:own )?browser|only in (?:their|your) own browser/i;
  for (const f of ['../README.md', '../PILOT.md', '../store/listing.md', ...md('docs'), ...md('marketing')]) {
    for (const line of read(f).split('\n')) {
      assert.doesNotMatch(line, ONLY_HERE, `${f.slice(3)}: "${line.trim().slice(0, 120)}" says the data stays in the browser, but a signed-in salesperson's posted list syncs to the dealership's account`);
      if (/posted list/.test(line) && /kept in (?:their|your|this|the) (?:own )?browser(?!')/i.test(line)) {
        assert.ok(/dealership's account/.test(line) && /\bsign(?:ed)? in\b/.test(line), `${f.slice(3)}: "${line.trim().slice(0, 120)}" leaves out the sync to the dealership's account`);
      }
    }
  }
  // README's synced-profile line also called the account a milestone still to
  // come, two lines above the Account item that describes the one built
  const profile = read('../README.md').split('\n').find((l) => l.startsWith('- **Your profile follows you.**'));
  assert.ok(profile, 'README no longer explains the synced profile');
  assert.doesNotMatch(profile, /account[^.]*\bis Milestone 4\b/i, "README's profile line calls the Lot Current account a milestone still to come");
  assert.match(profile, /\*\*Account\*\*/, "README's profile line does not point at the Account item");
});

// README's profile line once named only the name, role and listing defaults as
// what follows the person, and said the account gets the posted list "from then
// on", while settingsFromProfile carries the closing line, the Terms acceptance
// and the rewrite-service address too, and the first sync sends the posts and
// numbers recorded before the sign-in (syncPayload sends every own post, and
// every post attempt when nothing has synced yet).
test('README and the help name every part of the profile that follows the person, and say earlier posts sync too', () => {
  const code = read('../extension/src/settings.js');
  const person = code.match(/const person = \{([^\n]*)\};/);
  assert.ok(person, 'settingsFromProfile no longer builds the person part in one line: check what follows the person');
  assert.deepEqual([...person[1].matchAll(/(\w+): /g)].map((m) => m[1]).filter((k) => k !== 'key'), ['salesperson', 'defaults', 'legal', 'rewrite'], 'the person part of the profile changed: update README and docs/help.md');
  assert.match(code, /rewrite: \{ \.\.\.\(profile\.rewrite \|\| \{\}\), key: '' \}/, 'the rewrite-service key follows the profile now: the texts say it stays on the computer');
  const PERSON = { salesperson: /\bname, role, closing line\b/, defaults: /listing defaults/, legal: /Terms acceptance/, rewrite: /rewrite-service address/ };
  const texts = { 'README.md': read('../README.md').split('\n').find((l) => l.startsWith('- **Your profile follows you.**')), 'docs/help.md': doc('help.md').split('\n').find((l) => l.startsWith('Your profile follows you.')) };
  for (const [name, line] of Object.entries(texts)) {
    assert.ok(line, `${name} no longer says what follows the person`);
    const follows = line.slice(0, line.search(/follow you\b/));
    for (const [key, re] of Object.entries(PERSON)) assert.match(follows, re, `${name}: what follows the person leaves out ${key}`);
    assert.match(line, /dealership part \(name, address, stores, price basis, price note and daily cap\)/, `${name} does not list the dealership part`);
    assert.match(line, /rewrite-service key stays on the computer/, `${name} does not say the rewrite-service key stays behind`);
  }
  assert.doesNotMatch(texts['README.md'], /from then on/, "README's profile line says only posts after the sign-in reach the account");
  assert.match(texts['README.md'], /including the ones from before you signed in/, "README's profile line does not say earlier posts sync too");
  const sync = read('../extension/src/sync.js');
  assert.match(sync, /const isOwn = \(entry, userId\) => entry\.mine !== false && \(!entry\.userId \|\|/, 'a post recorded before the sign-in (no userId) may no longer sync: check README');
  assert.match(sync, /const cutoff = last === null \? null :/, 'the first sync may no longer send every post attempt: check README');
});

// Two rewrite services read an Anthropic API key: the standalone backend/
// (backend/.env) and the accounts' rewrite function (a function secret).
// supabase/README.md once called the function secret "the only place it
// exists" while README called backend/ the place the key lives, so a session
// could remove one as a rule breach, or a rotation miss the other. The texts
// that say where the key lives name both, and none calls one the only place.
test('the texts that say where the Anthropic API key lives name both rewrite services', () => {
  assert.match(read('../backend/server.js'), /process\.env\.ANTHROPIC_API_KEY/, 'backend/ no longer reads a key: these texts can name one place');
  assert.match(read('../supabase/functions/rewrite/index.ts'), /env\('ANTHROPIC_API_KEY'\)/, 'the rewrite function no longer reads a key: these texts can name one place');
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../${dir}/${f}`);
  for (const f of ['../README.md', '../supabase/README.md', '../backend/README.md', ...md('docs')]) {
    for (const line of read(f).split('\n').filter((l) => /ANTHROPIC_API_KEY|Anthropic API key/.test(l))) {
      assert.doesNotMatch(line, /\bonly place\b|\bkey lives here\b/i, `${f.slice(3)}: "${line.trim().slice(0, 120)}" gives one place for the key, but both backend/ and the rewrite function hold one`);
    }
  }
  const secret = read('../supabase/README.md').split('\n').find((l) => l.startsWith('| `ANTHROPIC_API_KEY` |'));
  assert.ok(secret, 'supabase/README.md no longer lists ANTHROPIC_API_KEY among the function secrets');
  assert.match(secret, /backend\/\.env/, "supabase/README.md's ANTHROPIC_API_KEY row does not name backend/.env");
  const backendRow = read('../README.md').split('\n').find((l) => l.startsWith('| `backend/` |'));
  assert.ok(backendRow, "README's file table has no backend/ row");
  assert.match(backendRow, /function secret/, "README's backend/ row does not say the rewrite function keeps its own key");
});

// PLAN.md's status went stale on three facts the code states: it said no
// Supabase project existed while extension/src/accountConfig.js named one,
// that formMap.js was verified only against the mock while the map records
// its live runs, and that the second platform waited for a dealer while
// ADAPTERS already carried the DealerOn and Dealer.com readers.
test('PLAN.md\'s status agrees with the account config, the form map and the adapters', () => {
  const plan = read('../PLAN.md');
  if (accountsConfigured()) {
    assert.doesNotMatch(plan, /No project exists yet/, 'PLAN.md says no Supabase project exists, but extension/src/accountConfig.js names one');
    const m4 = plan.split('\n').find((l) => l.startsWith('| M4 '));
    assert.ok(m4, "PLAN.md's status table has no M4 row");
    assert.match(m4, /accountConfig\.js/, "PLAN.md's M4 row does not say where the project is named");
  }
  if (/\blive\b/.test(String(FORM_MAP.verifiedAgainstFacebook || ''))) {
    assert.doesNotMatch(plan, /verified only against the mock/, `PLAN.md says formMap.js has met only the mock, but the map says "${FORM_MAP.verifiedAgainstFacebook}"`);
  }
  const m6 = plan.split('\n').find((l) => l.startsWith('- M6:'));
  assert.ok(m6, 'PLAN.md\'s "Wider use" list has no M6 line');
  for (const name of platformNames().filter((n) => n !== 'Dealer Inspire' && !/^Standard/.test(n))) {
    assert.ok(m6.includes(name), `PLAN.md's M6 line does not say a reader for ${name} exists`);
  }
});

// Clear the numbers keeps the to-do items still open (src/pilot.js
// clearNumbers): the texts that say what it deletes say what it keeps.
test('every text that says what Clear the numbers deletes says the to-do items still open stay', () => {
  for (const rel of ['../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../docs/data-inventory.md', '../docs/help.md']) {
    const sentences = read(rel).split(/(?<=\.)\s+|\n/);
    assert.ok(sentences.some((t) => /Clear the numbers/.test(t) && /still open/.test(t)), `${rel} does not say Clear the numbers keeps the to-do items still open`);
  }
});

// While signed in, Clear the numbers also keeps the to-do items closed since
// the last sync until the next sync sends them (src/sync.js
// clearNumbersKeepingUnsynced, the popup's pilotClear): the same texts say so.
test('every text that says what Clear the numbers deletes says the items closed since the last sync wait for the next sync', () => {
  assert.match(read('../extension/popup.js'), /clearNumbersKeepingUnsynced\(got\[k\.pilot\], got\[k\.sync\]\)/, 'the popup no longer keeps the closed items the next sync sends: these texts can drop the clause');
  for (const rel of ['../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../docs/data-inventory.md', '../docs/help.md']) {
    const sentences = read(rel).split(/(?<=\.)\s+|\n/);
    assert.ok(sentences.some((t) => /Clear the numbers/.test(t) && /closed since the last sync/.test(t) && /next sync/.test(t)), `${rel} does not say Clear the numbers keeps the to-do items closed since the last sync until the next sync`);
  }
});

// While signed in, the popup's Scan, Mark posted, unmarking, Taken down and
// Updated, and a take-down or price update the side panel saw done, each ask
// the worker to sync (popup.js syncInBackground, upkeep.js finish). So the
// texts that list when Lot Current syncs count them, and none says a change
// made in the popup waits for the next sync.
test('every text that lists when the extension syncs counts the scans, take-downs and price updates recorded in the popup and the side panel', () => {
  const popup = read('../extension/popup.js');
  // the flag closes, then (when it was saved) the diff, then the sync
  assert.match(popup, /resolveFlag\(p, vin, null, \{ how: 'manual' \}\)\)\)\) break;\n[^\n]*\n\s*syncInBackground\(\);/, 'Taken down no longer asks for a sync: these texts can say it waits for the next one');
  assert.match(popup, /resolveFlag\(p, vin, 'price', \{ how: 'manual' \}\)\)\)\) break;\n[^\n]*\n\s*syncInBackground\(\);/, 'Updated no longer asks for a sync');
  assert.match(popup, /recordFlags\(state\.origin, (?:r|state)\.diff, (?:r|state)\.diff\.takenAt\)[^\n]*\n\s*syncInBackground\(\);/, 'the popup\'s Scan no longer asks for a sync');
  assert.match(read('../extension/upkeep.js'), /type: 'syncNow', origin: up\.origin/, 'the side panel\'s take-downs and price updates no longer ask for a sync');
  assert.match(popup, /Lot Current also syncs after every rescan and after each post, take-down or price update you record\./, 'Settings says when it syncs');
  const lineWith = (rel, marker) => {
    const line = read(rel).split('\n').find((l) => l.includes(marker));
    assert.ok(line, `${rel} has no line with "${marker}"`);
    return line;
  };
  for (const [rel, marker] of [['../docs/data-inventory.md', '| Sync ('], ['../docs/help.md', '**What leaves the browser'], ['../legal/chrome-web-store-privacy.md', '| While signed in:']]) {
    const line = lineWith(rel, marker);
    assert.match(line, /take-down/, `${rel}: the sync triggers leave out take-downs`);
    assert.match(line, /price update/, `${rel}: the sync triggers leave out price updates`);
    assert.match(line, /each scan/, `${rel}: the sync triggers leave out the popup's scan`);
    assert.doesNotMatch(line, /next of these|do not sync on their own/, `${rel} says a change made in the popup waits for the next sync`);
  }
});

// A sync the account server turns away for coming too often (its brake is a
// dozen a minute) is tried again a minute later by a one-shot alarm
// (background.js planRetry), so a run of Mark posted clicks still reaches
// the dealership. That is a call the extension makes a minute after the
// click, with the alarms permission: the texts that list when it syncs and
// what the alarms permission does say so.
test('every text that lists when the extension syncs, or what the alarms permission does, says a sync the server asked to wait is tried again a minute later', () => {
  const worker = read('../extension/background.js');
  assert.match(worker, /if \(r\.status !== 429\) return null;[^]*?chrome\.alarms\.create\(name, \{ delayInMinutes: SYNC_RETRY_MINUTES \}\)/, 'the worker no longer retries a sync the server asked to wait: these texts must stop saying it does');
  const lineWith = (rel, marker) => {
    const line = read(rel).split('\n').find((l) => l.includes(marker));
    assert.ok(line, `${rel} has no line with "${marker}"`);
    return line;
  };
  for (const [rel, marker] of [
    ['../docs/data-inventory.md', '| Sync ('],
    ['../docs/help.md', '**What leaves the browser'],
    ['../legal/chrome-web-store-privacy.md', '| While signed in:'],
    ['../legal/chrome-web-store-privacy.md', '| `alarms` |'],
    ['../store/listing.md', '| `alarms` |'],
  ]) {
    const line = lineWith(rel, marker);
    assert.match(line, /asked (it )?to wait|asks to wait|turns away/, `${rel}: "${marker}" does not say when the server turns a sync away`);
    assert.match(line, /again a minute (later|after)/, `${rel}: "${marker}" does not say the sync is tried again a minute later`);
  }
});

// Only Save settings (the popup's onSettingsSubmit) and finishing set-up
// (wizard.js) write the synced profile; a scan, the rescan permission or a
// sign-in never puts back a profile the person forgot. Every text that says
// what re-creates it says exactly that.
test('every text that says what re-creates the forgotten profile names only Save settings and finishing set-up', () => {
  const popup = read('../extension/popup.js');
  assert.equal((popup.match(/await saveProfile\(/g) || []).length, 1, 'popup.js writes the profile from more than one place: these texts must say what else re-creates it');
  assert.match(popup.slice(popup.indexOf('async function onSettingsSubmit(')), /^[^]*?await saveProfile\(/, 'the popup writes the profile outside Save settings');
  assert.equal((read('../extension/wizard.js').match(/await saveProfile\(/g) || []).length, 1, 'set-up writes the profile from more than one place');
  for (const rel of ['../legal/privacy-policy.md', '../docs/help.md', '../docs/data-inventory.md', '../extension/popup.js']) {
    const sentences = read(rel).split(/(?<=\.)\s+|\n/).filter((t) => /re-creates?/.test(t));
    assert.ok(sentences.length, `${rel} no longer says what re-creates the profile`);
    for (const t of sentences) assert.match(t, /only saving Settings or finishing set-up re-creates/i, `${rel}: "${t.trim().slice(0, 120)}" does not say only Save settings and finishing set-up re-create the profile`);
  }
});

// The committed extension/src/accountConfig.js names the production project
// (docs/production-setup.md step 1), so every build offers sign-in: no text
// may still say the shipped config is empty, and the setup docs say that no
// build goes to a tester before sign-in works there.
test('while the committed account config names a project, no text says the shipped build has accounts off', () => {
  if (!accountsConfigured()) return;
  for (const rel of ['../extension/src/accountConfig.js', '../extension/src/wizardSteps.js', '../docs/data-inventory.md', '../README.md']) {
    assert.doesNotMatch(read(rel), /shipped empty config|as shipped\*\* \(`extension\/src\/accountConfig\.js` empty\)|until then every value is empty|Until the owner has set the account service up/i, `${rel} still says the shipped build has no account config`);
  }
  assert.match(read('../docs/production-setup.md'), /\*\*From then on every build offers sign-in\.\*\*[^\n]*no build goes to a pilot tester before then/);
  assert.match(doc('launch-checklist.md'), /\*\*No tester build before sign-in works\.\*\*/);
  // the shipped build's set-up has the Account step, so README's walk through set-up names it and its way past
  assert.ok(wizardSteps(accountsConfigured()).includes('account'), 'the shipped set-up has no Account step: README can drop it');
  const setUp = read('../README.md').split('\n').find((l) => l.includes('**Set up Lot Current**'));
  assert.ok(setUp, 'README no longer walks through set-up');
  assert.match(setUp, /sign in to your dealership's Lot Current account[^.]*\*\*Skip for now\*\*/, 'README\'s set-up steps leave out the Account step the shipped build shows');
  // The Web Store answers and the support page say what is sent when the
  // person signs in, not that sending waits for accounts to be set up: the
  // build already offers sign-in, and asking for a code sends the email.
  for (const rel of ['../legal/chrome-web-store-privacy.md', '../store/listing.md']) {
    assert.doesNotMatch(read(rel), /once Lot Current accounts are set up/i, `${rel} still says the sign-in data waits for accounts to be set up`);
    assert.match(read(rel), /when (?:the user signs|they sign) in to a Lot Current account, the email address/, `${rel} does not say the sign-in email is sent when the person signs in`);
  }
  const support = read('../site-src/pages/support.html');
  assert.doesNotMatch(support, /Until then nothing leaves your browser/, 'the support page says nothing leaves the browser while every build offers sign-in');
  assert.match(support, /sends nothing to Lot Current's database until you ask for a sign-in code/, 'the support page does not say when the extension first sends to Lot Current\'s database');
});

// review: README said each salesperson's scans, settings and posted list are
// "kept only in their own browser", two lines under the Account bullet that
// says the posted list syncs. The profile always goes to Chrome's synced
// storage (src/settings.js saveProfile), and while the person is signed in
// their posted list, post timings, to-do items and scan counts sync to the
// dealership's account (src/sync.js). No text a person reads says the data
// stays in the browser alone, and the ones that say where it is kept name
// both, and the button that removes the synced profile.
test('no text says the data stays only in the browser: the profile follows the Chrome sign-in, and a signed-in person\'s posted list and numbers sync', () => {
  const settingsSrc = read('../extension/src/settings.js');
  assert.match(settingsSrc.slice(settingsSrc.indexOf('export async function saveProfile(')), /chrome\.storage\.sync/, 'the profile is no longer kept in Chrome sync: say where it is in these texts and in this test');
  const LOCAL_ONLY = /\b(?:kept|stays?|stored|held) only (?:in|on) (?:your|their|the) (?:own )?(?:browser|computer)|nothing (?:leaves|goes beyond) (?:your|their|the) browser/i;
  for (const rel of ['../README.md', '../PILOT.md', '../docs/help.md', '../docs/support.md', '../docs/data-inventory.md', '../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../site-src/pages/support.html', '../site-src/pages/faq.html', '../site-src/pages/home.html', '../marketing/onboarding-emails.md', '../marketing/onboarding-store.md', '../store/listing.md']) {
    const hit = read(rel).match(LOCAL_ONLY);
    assert.equal(hit && hit[0], null, `${rel} says "${hit && hit[0]}", but the profile follows the Chrome sign-in${accountsConfigured() ? " and a signed-in person's posted list and numbers sync to the dealership's account" : ''}`);
  }
  const line = read('../README.md').split('\n').find((l) => l.startsWith("Each salesperson's scans, settings, posted list and numbers are kept in their own browser, separately per website."));
  assert.ok(line, "README no longer says where each salesperson's scans, settings and posted list are kept");
  assert.match(line, /the profile \(above\) is in Chrome's synced storage, so it follows their Chrome sign-in/, "README's storage line does not say the profile follows the Chrome sign-in");
  if (accountsConfigured()) {
    assert.match(line, /while they are signed in to a Lot Current account their posted list, post timings, to-do items and the newest scan's counts also sync to the dealership's account/, "README's storage line does not say what syncs to the dealership's account");
  }
  // Clear everything for this website does not reach the synced profile (legal/privacy-policy.md, Retention)
  const support = read('../site-src/pages/support.html').split('\n').filter((l) => /stays in your browser/.test(l));
  for (const l of support) assert.match(l, /<b>Clear everything for this website<\/b> removes it\. Your profile \([^)]*closing line[^)]*\) is also kept by Chrome's sync under your Google account, and Settings, <b>Forget my synced profile<\/b> removes it\./, 'the support page says Clear everything removes what the extension keeps, but the synced profile needs Forget my synced profile');
});

// Three help lines went stale against the code they describe: the side
// panel's own list was said to show "the same cars as the popup's tab" in the
// very case where the popup shows another website (panelList.js
// defaultOrigin); a single ready arrival was said to have its own Post button
// when a Facebook draft shows Mark posted instead (popup.js postButton); and
// a standard-data website's failed page check left out the refusal, which
// still holds back every missing car (rescan.js, schemaOrg.js confirmMissing).
test('the help says what the panel list, a single arrival and a refused page check show', () => {
  const help = doc('help.md').split('\n');
  const panel = help.find((l) => l.startsWith('**Post the next car from the side panel.**'));
  assert.ok(panel, 'docs/help.md no longer explains the side panel\'s own list');
  assert.match(read('../extension/src/panelList.js'), /if \(lastOrigin && has\(all, lastOrigin\)\) return lastOrigin;/, 'the panel no longer opens on the website it last worked on: check the help');
  assert.doesNotMatch(panel, /as the popup's tab,/, 'the help says the panel shows the popup tab\'s cars, which can be another website\'s');
  assert.match(panel, /as the popup's tab shows for that website/);
  assert.match(panel, /once that website's data was cleared/, 'the help leaves out that a cleared website sends the panel to the most recent scan');

  const popup = read('../extension/popup.js');
  assert.match(popup, /const readyArrivals = \(items\) => items\.filter\(\(n\) => n\.decision === DECISION\.READY && !state\.posted\[n\.vin\]\);/, 'ready arrivals changed: check what the help says a single one shows');
  assert.match(popup, /if \(state\.drafts\[vin\]\) \{\n[^\n]*draftPill[^\n]*\n[^\n]*data-action="post"[^\n]*>Mark posted</, 'a Facebook draft no longer shows Mark posted: check the help');
  const arrivals = help.find((l) => l.startsWith('- On **To do**, **Queue all N ready arrivals**'));
  assert.ok(arrivals, 'docs/help.md no longer explains Queue all N ready arrivals');
  assert.match(arrivals, /a single one has its own \*\*Post\*\* button, or, when it was saved as a draft on Facebook, a "Draft on Facebook" pill and \*\*Mark posted\*\*/, 'the help says a single ready arrival always has a Post button');

  const rescan = read('../extension/src/rescan.js');
  assert.match(rescan, /const notFound = new Set\(confirm && !confirm\.error \?/, 'a refused check may now mark cars gone: check the help');
  assert.match(rescan, /text: 'Missing from this scan but not confirmed gone\. Rescan later\.'/);
  const schema = read('../extension/adapters/schemaOrg.js');
  assert.match(schema, /if \(item\.verdict\.refused\) \{\s*confirm\.error = item\.verdict\.refused;/, "a refused car page no longer stops the whole check: check the help");
  assert.match(schema, /else if \(got && got\.kind === 'blocked'\) confirm\.error =/, 'a refused comparison page no longer stops the whole check: check the help');
  const standard = help.find((l) => l.startsWith('- On a website Lot Current reads from the standard vehicle data'));
  assert.ok(standard, 'docs/help.md no longer explains the standard-data check of missing cars');
  assert.match(standard, /except when the website turned a page away \(HTTP 403, 429 or 503, or a check page shown instead of it\)[^.]*: then no car is marked gone in that scan, each missing car shows under \*\*Needs a look\*\* as "Missing from this scan but not confirmed gone\. Rescan later\."/, 'the help leaves out that a refusal holds back every missing car');
});

// The help's Billing card once grouped Start the free pilot with Subscribe
// and Manage billing under "(Stripe's own pages, ...)", as if the pilot took a
// card; the manager view's own action says no card is asked for.
test('the help keeps Start the free pilot apart from the two buttons that open Stripe', () => {
  assert.match(read('../manager/data.js'), /label: 'Start the free pilot', does: '[^\n]*no card is asked for' \}/, 'the free pilot now asks for a card: check the help');
  const billing = doc('help.md').split('\n').find((l) => l.startsWith('- **Billing**:'));
  assert.ok(billing, 'docs/help.md no longer explains the Billing card');
  assert.doesNotMatch(billing, /\*\*Start the free pilot\*\*, \*\*Subscribe\*\* and \*\*Manage billing\*\* \(Stripe's own pages/, 'the help puts Start the free pilot among Stripe\'s own pages');
  assert.match(billing, /\*\*Start the free pilot\*\* \(no card\), and \*\*Subscribe\*\* and \*\*Manage billing\*\* \(Stripe's own pages/);
});

// The functions on the production project were deployed by hand, before the
// Supabase workflow's first run, and production-setup's step 3 says verify
// has not compared them with the repository yet. stripe-setup and the
// website notes still stated what those deployed functions answer as fact.
// A line that says a function is deployed on production and what it answers
// says that holds for the repository's code, and names verify.
test('the guides say what a deployed function answers only as what the repository\'s code does, until verify compares them', () => {
  const setup = read('../docs/production-setup.md');
  assert.match(setup, /\*\*verify\*\*: compares production with the repository/, 'production-setup no longer has a verify mode: check these lines');
  const ANSWERS = /\b(?:answers with what is missing|refuses every request)\b/;
  const DEPLOYED = /\b(?:is|were) deployed (?:on the production project|outside the Supabase workflow)\b/;
  let seen = 0;
  for (const rel of ['../docs/stripe-setup.md', '../docs/website.md']) {
    for (const line of read(rel).split('\n').filter((l) => DEPLOYED.test(l) && ANSWERS.test(l))) {
      seen += 1;
      assert.match(line, /[Ii]f what was deployed is this repository's code \(`docs\/production-setup\.md` step 3's \*\*verify\*\* compares the two\)/, `${rel.slice(3)}: "${line.trim().slice(0, 100)}..." states what the deployed function answers as fact`);
    }
  }
  assert.equal(seen, 2, 'stripe-setup and website.md each say what a deployed function answers');
});

// supabase/README.md drifted from the code in eight places: the header said
// everything stays in the browser (the profile goes to Chrome sync); "the
// two functions" after the header named four; the sync function's
// late-sighting rule left out that a take-down needs rows of the caller's;
// the checkout 409 said Stripe retries an unpaid invoice (it no longer does);
// the seat rule for an untagged price left out the fallback with no seat
// price set; "choose whether to prorate" read as settled while the owner has
// not set the rule; two db push comments named files step 3 already applied;
// and /rewrite left out its 400 for a missing dealership name.
test('supabase/README.md says what the functions and the billing code do', () => {
  const readme = read('../supabase/README.md');
  const flat = readme.replace(/\s+/g, ' ');
  assert.doesNotMatch(flat, /everything stays in the browser/, 'the header says everything stays in the browser, but the profile goes to Chrome sync');
  assert.match(flat, /the profile still goes to Chrome's synced storage/);

  const functions = readdirSync(new URL('../supabase/functions/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort();
  assert.deepEqual(functions, ['billing', 'lead', 'rewrite', 'sync'], 'the functions changed: check how supabase/README.md names them');
  assert.doesNotMatch(readme, /^## The two functions$|\*\*Secrets and the two functions\.\*\*/m, 'supabase/README.md calls rewrite and sync "the two functions" after its header names four');
  assert.match(readme, /^## The rewrite and sync functions$/m);

  const sync = read('../supabase/functions/sync/index.ts');
  assert.match(sync, /if \(kind === 'takeDown'\) return rows\.length > 0 && up\.length === 0;/, 'the late-sighting rule changed: check supabase/README.md');
  assert.match(sync, /return to !== null && up\.length > 0 && up\.every\(\(r\) => intOrNull\(r\.price\) === to\)/);
  // the comment above step 4 says the same rule as the code and the README:
  // a price change counts as shown only when the caller has a listed row
  const syncComments = sync.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/\s?/, '')).join(' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(syncComments, /every listed row of theirs for the VIN is at the flag's new price/, 'the sync comment leaves out that a price change needs a listed row of the caller\'s');
  assert.match(syncComments, /\(`shows`\): for a price change, they have a listed row for the VIN and every one is at the flag's new price; for a take-down, they have rows for it and none is up\./);
  assert.doesNotMatch(flat, /none of their rows for it up/, 'the late-sighting rule leaves out that a take-down needs rows of the caller\'s');
  assert.match(flat, /for a price change, they have a listed row for the VIN and every one is at the flag's new price; for a take-down, they have rows for it and none is up/);
  // a closed flag with no row goes in as its own item, except in the two orders the function merges into a row it
  // holds (review: an older "a closed flag with no row always goes in" came back in a merge and nothing failed)
  assert.match(sync, /const later = next && next\.id && sameChange\(next, t\) \? next : null;/, 'the fix-after-a-later-sighting merge changed: check supabase/README.md');
  assert.match(sync, /if \(newest && newest\.done_at && newest\.how !== 'cleared' && \(ms\(newest\.done_at\) \?\? 0\) <= flagged && sameChange\(newest, t\)/, 'the ticked-off-after-the-close merge changed: check supabase/README.md');
  assert.doesNotMatch(flat, /closed flag with no row always goes in/, 'supabase/README.md says a closed flag with no row always goes in, while the function merges it in two orders');
  assert.match(flat, /a closed flag with no row goes in as its own item \(a change flagged and fixed on one machine between two syncs\), except in two orders that make it the same item as a row the server holds: the fix reached the server after another machine sighted the same change[\s\S]{0,800}?, or a machine that rescanned on an old registry ticked the change off before its first sync, after the item was closed already/);

  const billing = read('../supabase/functions/_shared/billing.mjs');
  assert.match(billing, /an invoice being retried \(past_due\) or no longer retried\n\/\/ but still payable \(unpaid\)/, 'the billing code\'s account of unpaid changed: check supabase/README.md');
  assert.doesNotMatch(flat, /Stripe retries the open invoice/, 'supabase/README.md says Stripe retries an unpaid invoice');
  assert.match(billing, /if \(priceSeat \? price === priceSeat : price !== priceRooftop\) extra \+= qty;/, 'the untagged seat rule changed: check supabase/README.md');
  assert.doesNotMatch(flat, /an untagged price counts only when it is `STRIPE_PRICE_SEAT`/, 'the seat rule leaves out the fallback with no seat price set');
  assert.match(flat, /with `STRIPE_PRICE_SEAT` unset, whenever it is not `STRIPE_PRICE_ROOFTOP`/);

  if (/^- \*\*11\.2\*\*/m.test(read('../legal/questions-for-attorney.md'))) {
    assert.doesNotMatch(flat, /choose whether to prorate/, 'supabase/README.md leaves proration to whoever adds a seat, while the owner has not set the rule');
    assert.match(flat, /not set yet: `legal\/questions-for-attorney\.md` 11\.2/);
  }
  assert.doesNotMatch(readme, /db push\s+# applies 0\d{3}_/, 'a db push comment names a file step 3\'s push already applied');

  const rewrite = read('../supabase/functions/rewrite/index.ts');
  assert.match(rewrite, /if \(!dealerNameOf\(facts\)\) return json\(req, 400, \{ ok: false, error: NO_DEALER_NAME \}\);/, 'the rewrite function no longer refuses a body without the dealership\'s name: check supabase/README.md');
  const msg = rewrite.match(/const NO_DEALER_NAME = "([^"]+)";/)[1];
  assert.ok(flat.includes(`gets 400 \`${msg}\``), 'supabase/README.md leaves out /rewrite\'s 400 for a missing dealership name');
});

// README's Account item once sent readers to "steps 3 to 6: the functions, ..."
// as what must go live before a sign-in completes, after production-setup's
// step 3 said all four functions were up, and its storage line called two
// things the only ones that go further, leaving out the description writer.
// The range it names covers exactly the steps its list names, by heading, and
// lists the functions only while step 3 says they are not up.
test('README points at the set-up steps still open, and its storage line names the description writer', () => {
  const setup = read('../docs/production-setup.md');
  const headings = Object.fromEntries([...setup.matchAll(/^## Step (\d+)\. ([^[\n]*)/gm)].map((m) => [Number(m[1]), m[2].trim()]));
  const account = read('../README.md').split('\n').find((l) => l.startsWith('- **Account**'));
  assert.ok(account, 'README no longer has its Account item');
  const m = account.match(/`docs\/production-setup\.md` steps (\d+) to (\d+): ([^;)]*)/);
  assert.ok(m, "README's Account item no longer names the production-setup steps a sign-in waits for");
  const [from, to] = [Number(m[1]), Number(m[2])];
  const NAMED = { 'the sign-in settings': /^Sign-in settings/, 'the sign-in email sender': /^The sign-in email sender/, 'the manager view': /^The manager view/, 'the first dealership': /^The first dealership/, 'the functions': /\bthe functions\b/ };
  const items = m[3].split(/, | and /).map((x) => x.trim()).filter(Boolean);
  for (const item of items) {
    assert.ok(NAMED[item], `README names "${item}": add it to this test's map`);
    const step = Object.entries(headings).find(([, h]) => NAMED[item].test(h));
    assert.ok(step, `docs/production-setup.md has no step for "${item}"`);
    assert.ok(Number(step[0]) >= from && Number(step[0]) <= to, `README puts "${item}" in steps ${from} to ${to}, and it is step ${step[0]}`);
  }
  for (let n = from; n <= to; n++) assert.ok(items.some((item) => NAMED[item].test(headings[n] || '')), `README's steps ${from} to ${to} include step ${n} (${headings[n]}) without naming it`);
  if (/already has the database[^.]*all four functions/.test(setup)) assert.ok(!items.includes('the functions'), 'production-setup says the functions are up, and README still lists them as what a sign-in waits for');
  const storage = read('../README.md').split('\n').find((l) => l.startsWith("Each salesperson's scans, settings, posted list and numbers are kept in their own browser"));
  assert.doesNotMatch(storage, /\bTwo things also go further\b/, "README's storage line calls two things the only ones that leave the browser");
  assert.match(storage, /description writer[^.]*rewrite service/, "README's storage line leaves out what the description writer sends");
});

// review: the privacy texts, README, help and set-up's Terms summary said "each scan's (time and) counts" sync,
// while each sync sends one scan's counts, the newest stored one (src/accountFlow.js scanFromStored). A scan judged
// a website hiccup goes up too, marked withheld, with the counts of its own read: the privacy texts say so.
test('no text says each scan\'s counts sync: a sync sends the newest scan\'s, marked held back after a website hiccup', async () => {
  const { scanFromStored } = await import('../extension/src/accountFlow.js');
  const T = (h) => new Date(Date.UTC(2026, 10, 16, h)).toISOString();
  const lot = (n) => ({ takenAt: T(9), vehicles: Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, { decision: 'ready' }])) });
  const hiccup = { takenAt: T(9), unreliable: true, takeDown: [], priceUpdates: [], withheld: { since: T(9), scans: 1, cars: 8, saved: 20, snapshot: lot(8) } };
  assert.equal(scanFromStored({ snapshot: lot(20), diff: hiccup })?.withheld, true, 'a hiccup scan no longer goes up marked held back: these texts can change');
  assert.equal(scanFromStored({ snapshot: lot(20), diff: { takenAt: T(9), takeDown: [], priceUpdates: [] } })?.withheld, undefined, 'a trusted scan now goes up marked: these texts can change');
  const EACH = /\b(?:each|every) scan's (?:time and )?counts\b/i;
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../${dir}/${f}`);
  const pages = readdirSync(new URL('../site-src/pages/', import.meta.url)).map((f) => `../site-src/pages/${f}`);
  for (const rel of ['../README.md', ...md('docs'), ...md('legal'), ...md('marketing'), '../store/listing.md', ...pages, '../extension/src/wizardSteps.js', '../extension/popup.js']) {
    const hit = read(rel).match(EACH);
    assert.equal(hit && hit[0], null, `${rel} says "${hit && hit[0]}" sync, while a sync sends the newest scan's counts`);
  }
  const policy = read('../legal/privacy-policy.md').split('\n').find((l) => l.startsWith('| Scan results |'));
  assert.match(policy, /of the newest scan, and whether that scan was held back as a likely website hiccup/);
  assert.doesNotMatch(policy, /sends none/, 'the policy says a hiccup scan sends nothing, while it goes up marked held back');
  const store = read('../legal/chrome-web-store-privacy.md');
  assert.match(store, /the newest scan's counts \(marked as held back for a scan that looked like a website hiccup\)/);
  assert.match(store, /the scan's counts, marked as held back when the rescan looked like a website hiccup/);
  assert.doesNotMatch(store, /none for a scan that looked like a website hiccup|unless the rescan looked like a website hiccup/, 'the Web Store answers say a hiccup scan sends no counts, while it goes up marked held back');
});

// review: help.md said "If you already belong to that dealership, a code does nothing and says so", while
// redeem_invite (as 0010 last defined it) turns a salesperson who redeems a manager code into a manager and
// leaves the code unused only for a member already at the code's role or a manager.
test('the help says an invite code can raise a member\'s role and does nothing only for a member at its role or a manager', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const defines = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().filter((f) => /create or replace function public\.redeem_invite\(/.test(read(`../supabase/migrations/${f}`)));
  const latest = read(`../supabase/migrations/${defines[defines.length - 1]}`);
  const body = latest.slice(latest.indexOf('create or replace function public.redeem_invite('));
  assert.match(body, /if found and \(member\.role = 'manager' or member\.role = inv\.role\) then/, 'redeem_invite changed who a code leaves alone: update help.md and this test');
  assert.match(body, /on conflict \(user_id, dealership_id\) do update\s+set role = excluded\.role/, 'redeem_invite no longer raises a member\'s role: update help.md and this test');
  const help = doc('help.md');
  assert.doesNotMatch(help, /If you already belong to that dealership, a code does nothing/, 'help.md says a code does nothing for any member, while a manager code makes a salesperson a manager');
  assert.match(help, /A code can raise your role, never lower it: a salesperson who enters a manager code becomes a manager\. If you already belong to that dealership with the code's role, or as a manager, the code does nothing and says so/);
});

// "It didn't post" ends the post attempt the click on Post opened, as
// not-posted (sidepanel.js notPosted): the Numbers tab counts it under
// "Started but not posted", and while signed in it syncs with the other post
// attempts. A text that tells a salesperson or a manager about the button
// says the attempt is recorded, never that nothing is.
test('every text that explains It didn\'t post says the attempt is recorded as not posted', () => {
  const panel = read('../extension/sidepanel.js');
  const notPosted = panel.slice(panel.indexOf('async function notPosted'), panel.indexOf('\n}\n', panel.indexOf('async function notPosted')));
  assert.match(notPosted, /endPost\(p, state\.vin, 'not-posted'\)/, 'It didn\'t post no longer records the attempt as not posted: these texts must change with it');
  let seen = 0;
  for (const rel of ['../README.md', '../docs/help.md', '../marketing/demo-script.md', '../PILOT.md']) {
    for (const line of read(rel).split('\n').filter((l) => /It didn't post/.test(l))) {
      seen++;
      assert.doesNotMatch(line, /nothing (is|was|gets) recorded|posted or recorded|nothing is kept/i, `${rel}: "${line.trim().slice(0, 120)}" says It didn't post records nothing`);
      assert.match(line, /\bnot posted\b|recorded as such/i, `${rel}: "${line.trim().slice(0, 120)}" does not say the attempt is recorded as not posted`);
    }
  }
  assert.ok(seen >= 4, 'README, the help doc, the demo script and PILOT.md no longer explain It didn\'t post');
});

// PILOT.md is the runbook, in a public repository; the pilot log's rows name a
// dealer's salespeople and their results, which the pilot agreement keeps
// confidential and unpublished (sections 3 and 4) and has deleted within 30
// days of the end (section 6), which git history cannot do. So the runbook
// sends the log and the CSVs to the owner's private spreadsheet, its table
// stays an empty template, and git ignores the CSVs both downloads save.
test('the pilot log and the pilot CSVs stay out of the repository', async () => {
  const pilot = read('../PILOT.md');
  assert.doesNotMatch(pilot, /into this file or a spreadsheet|in the log above/i, 'PILOT.md tells the owner to put the pilot results in this repository');
  assert.match(pilot, /private pilot spreadsheet, never into this file/, 'PILOT.md no longer says the pilot log is kept outside the repository');
  const header = pilot.split('\n').findIndex((l) => l.startsWith('| Week | Salesperson |'));
  assert.ok(header > 0, 'PILOT.md has no pilot log template');
  for (const row of pilot.split('\n').slice(header + 2).filter((l) => l.startsWith('|'))) {
    const cells = row.split('|').slice(2, -1);
    assert.ok(cells.every((c) => c.trim() === ''), `PILOT.md's pilot log template holds results: "${row.trim()}"`);
  }
  assert.doesNotMatch(pilot, /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}\b/, 'PILOT.md holds a VIN');
  const { pilotFileName } = await import('../extension/src/pilot.js');
  const { csvFileName } = await import('../manager/data.js');
  const globs = read('../.gitignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const ignored = (name) => globs.some((g) => new RegExp('^' + g.split('*').map(escapeRe).join('[^/]*') + '$').test(name));
  for (const name of [pilotFileName('2026-10-01T15:00:00Z', { site: 'https://dealer.test', salesperson: 'Pat' }), csvFileName('2026-10-01T15:00:00Z', { dealer: 'Any Motors' })]) {
    assert.ok(ignored(name), `.gitignore does not keep ${name} out of the repository`);
  }
});

// The daily cap's only control is the Settings field in each salesperson's
// own popup, saved with that website's settings; no table, function or
// manager-view control holds a cap (the server only counts the day's posts).
// So a text that says the dealership sets the cap also says where it is
// entered, the help doc says the manager view does not set it, and the
// install email for a store's salespeople has each of them enter the
// manager's number. While the cap's count takes the server's count when it is
// higher (src/cap.js), the help doc says posts from other computers count.
test('texts about the daily cap say each salesperson enters the dealership\'s number in their own Settings', () => {
  assert.match(read('../extension/popup.js'), /field\('Posts per day, per salesperson', 'dailyCap'/, 'the cap\'s Settings field moved: these texts must change with it');
  const server = ['../supabase/functions/sync/index.ts', '../manager/manager.js', '../manager/data.js', ...readdirSync(new URL('../supabase/migrations/', import.meta.url)).map((f) => `../supabase/migrations/${f}`)];
  for (const rel of server) assert.doesNotMatch(read(rel), /daily_?cap\b|post_cap\b/i, `${rel} holds a cap: the dealership may now set it centrally, so these texts can say so`);
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../${dir}/${f}`);
  for (const rel of ['../README.md', '../store/listing.md', ...md('docs'), ...md('marketing')]) {
    for (const line of read(rel).split('\n').filter((l) => /daily (post )?cap|posts a day|posts per day/i.test(l))) {
      if (/\b(dealership|dealer|manager)( can)? (sets?|changes?|controls?)\b|\byou control\b/i.test(line)) {
        assert.match(line, /Settings/, `${rel}: "${line.trim().slice(0, 120)}" says the dealership sets the cap without saying each salesperson enters it in Settings`);
      }
    }
  }
  // review: the posting rules (shown in the product from src/postingRules.js) said "The dealership sets how many
  // posts a day", and the subscription agreement "the daily cap it sets for its staff", with no word of who enters it
  const legal = readdirSync(new URL('../legal/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../legal/${f}`);
  for (const rel of [...legal, '../extension/src/postingRules.js']) {
    for (const line of read(rel).split('\n').filter((l) => /daily (post )?cap|posts a day|posts per day/i.test(l))) {
      if (/\b(dealership|dealer|manager|it)( can)? (sets?|changes?|controls?)\b/i.test(line) && /\bcap\b|posts a day/i.test(line)) {
        assert.match(line, /Settings/, `${rel}: "${line.trim().slice(0, 120)}" says the dealership sets the cap without saying each salesperson enters it in Settings`);
      }
    }
  }
  assert.match(read('../legal/posting-rules.md'), /The dealership chooses how many posts a day each salesperson may make \(10 by default\), and you enter that number in Settings\./);
  assert.match(read('../legal/dealer-subscription-agreement.md'), /the daily cap it chooses for its staff, which each User enters in the extension's Settings/);
  const help = doc('help.md');
  const capSection = help.slice(help.indexOf('## The daily cap'), help.indexOf('\n## ', help.indexOf('## The daily cap') + 5));
  assert.match(capSection, /each salesperson enters it in their own \*\*Settings\*\*/, 'the help doc does not say each salesperson enters the cap in their own Settings');
  assert.match(capSection, /manager view does not set it/, 'the help doc does not say the manager view does not set the cap');
  const store = read('../marketing/onboarding-store.md');
  const toSalesperson = store.slice(store.indexOf('## To each salesperson'));
  assert.match(toSalesperson.slice(0, toSalesperson.indexOf('\n## ', 5)), /\*\*Posts per day, per salesperson\*\* read \[10\]/, 'the install email does not have each salesperson enter the manager\'s cap');
  if (/Math\.max\(postsToday\([^)]*\), serverPostsToday\(/.test(read('../extension/src/cap.js'))) {
    assert.match(capSection, /[Ss]igned in\b[^.]*count[^.]*other computers/, 'the help doc says the cap counts only this browser\'s posts, but a signed-in count also takes the account\'s');
  }
});

// The production project got its first eight migrations and all four
// functions outside the Supabase workflow, before that workflow's first run
// (supabase/README.md records the migrations): the setup guides say so, and
// none still writes a done deploy as one to come. The workflow lets the
// outside check's FAILs leave a run green only for a brand-new project (its
// new_project box), so the guide says production runs leave it unticked.
test('the setup guides say production already has its database and all four functions', () => {
  assert.match(read('../supabase/README.md'), /The production project has applied `0001_schema\.sql` to `0008_usage\.sql`/, 'supabase/README.md no longer records what production applied: change the guides with it');
  const setup = read('../docs/production-setup.md');
  const step3 = setup.slice(setup.indexOf('## Step 3.'), setup.indexOf('## Step 4.'));
  assert.match(step3, /\*\*Where production stands\.\*\*[^\n]*up to `0008_usage\.sql` and all four functions \(`rewrite`, `sync`, `billing` and `lead`\)/, 'production-setup step 3 does not say what production already has');
  assert.doesNotMatch(step3, /^\s*After plan and database the outside check prints some `FAIL` lines on purpose/m, 'production-setup step 3 calls a FAIL after plan or database expected on production');
  assert.match(step3, /A `FAIL` from the outside check turns any run red\./, 'production-setup step 3 does not say a FAIL on production is real');
  assert.match(step3, /Production is past that \(its tables and functions exist\), so leave the box unticked there\./, 'production-setup step 3 does not say to leave the new-project box unticked on production');
  const stale = [
    ['../docs/website.md', /`lead` function is not deployed/],
    ['../docs/stripe-setup.md', /the webhook and the deploy wait for the project/],
    ['../docs/launch-checklist.md', /the first deploy happens when the website pull request is merged|what is left is the deploy\b/],
    ['../supabase/README.md', /arrive with the UI wiring/],
    ['../.github/workflows/supabase.yml', /billing and lead come later/],
  ];
  for (const [rel, re] of stale) assert.doesNotMatch(read(rel), re, `${rel} still writes a deploy that is done as one to come`);
});

// docs/release.md sent the owner to the manager view for the form fields that
// could not be filled after a release, but those records never leave the
// salesperson's browser (src/sync.js sends the pilot's posts and flags only;
// no table has a field column). While that holds, the release guide sends the
// owner to each person's Numbers tab, and no guide line that names the
// manager view and the unfilled fields leaves out that they stay in the browser.
test('the guides keep the fields that could not be filled in each browser, out of the manager view', () => {
  assert.match(read('../extension/src/sync.js'), /pilot: \{ posts, flags \}/, 'the sync payload changed: if it now sends the fill records, these texts must change with it');
  const bullet = doc('release.md').split('\n').find((l) => l.startsWith('- **Fields that could not be filled.**')) || '';
  assert.match(bullet, /not synced/, 'docs/release.md does not say the fields that could not be filled stay in each browser');
  assert.match(bullet, /\*\*Copy summary\*\*/, 'docs/release.md does not say how the owner gets the fields that could not be filled from each salesperson');
  const md = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../${dir}/${f}`);
  for (const rel of ['../README.md', '../PILOT.md', '../supabase/README.md', ...md('docs')]) {
    for (const line of read(rel).split('\n').filter((l) => /manager view/i.test(l) && /could not be filled|couldn't fill|could not fill/i.test(l))) {
      assert.match(line, /\bstays? (in (the|that|this) browser|here)\b|never leaves?\b[^.]*\bbrowsers?\b|not synced|not in the database/i, `${rel}: "${line.trim().slice(0, 120)}" puts the fields that could not be filled in the manager view`);
    }
  }
});

// help.md said every popup tab shows a count, but the popup draws a count
// only for the tabs in its `counts` (not Numbers). The tab sentence names
// every tab and the ones drawn without a count.
test('help.md says which popup tabs show a count, as the popup draws them', () => {
  const popup = read('../extension/popup.js');
  const viewList = popup.match(/const VIEWS = \[([\s\S]*?)\];/);
  const countList = popup.match(/const counts = \{([\s\S]*?)\};/);
  assert.ok(viewList && countList, 'the popup\'s tab list or tab counts moved: this test must change with it');
  const views = [...viewList[1].matchAll(/\['(\w+)', '([^']+)'\]/g)].map(([, id, label]) => ({ id, label }));
  const counted = new Set([...countList[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  assert.ok(views.length > 3 && counted.size > 3, 'the popup\'s tab list or tab counts moved: this test must change with it');
  const line = doc('help.md').split('\n').find((l) => l.startsWith('- The tabs, left to right:')) || '';
  for (const v of views) assert.ok(line.includes(`**${v.label}**`), `docs/help.md's tab list does not name the "${v.label}" tab`);
  const without = views.filter((v) => !counted.has(v.id));
  if (!without.length) return assert.match(line, /Each shows a count\./, 'every popup tab shows a count, and docs/help.md does not say so');
  assert.doesNotMatch(line, /Each shows a count\./, `docs/help.md says every tab shows a count; ${without.map((v) => v.label).join(', ')} shows none`);
  for (const v of without) assert.match(line, new RegExp(`except[^.]*\\*\\*${escapeRe(v.label)}\\*\\*[^.]*shows? a count`), `docs/help.md does not say the "${v.label}" tab shows no count`);
});

// README wrote the To do tab's arrivals button as "Queue all ready
// arrivals"; the popup puts the count in it and draws it only when more than
// one arrival is ready. README and help.md write it with its N and say when
// it is there.
test('README and help.md write the arrivals queue button as the popup draws it', () => {
  const popup = read('../extension/popup.js');
  assert.match(popup, />Queue all \$\{ready\.length\} ready arrivals</, 'the arrivals queue button\'s label moved: these texts must change with it');
  const shownAbove = popup.match(/const queueAll = ready\.length > (\d+)/);
  assert.ok(shownAbove, 'the condition for the arrivals queue button moved: these texts must change with it');
  for (const [rel, text] of [['README.md', read('../README.md')], ['docs/help.md', doc('help.md')]]) {
    assert.doesNotMatch(text, /\*\*Queue all ready arrivals\*\*/, `${rel} writes the arrivals queue button without its count`);
    const line = text.split('\n').find((l) => l.includes('**Queue all N ready arrivals**')) || '';
    assert.ok(line, `${rel} does not name **Queue all N ready arrivals**`);
    if (shownAbove[1] === '1') assert.match(line, /more than one[^.]*ready/, `${rel} does not say the arrivals queue button is there only when more than one arrival is ready`);
  }
});

// The side panel reads the car again when its read is older than
// READ_MAX_AGE_MS (sidepanel.js); the help names the same number of minutes.
test('the help gives the same age for a re-read of the car as the side panel uses', () => {
  const panel = read('../extension/sidepanel.js');
  const ms = Number(new Function(`return ${/const READ_MAX_AGE_MS = ([^;]+);/.exec(panel)[1]}`)());
  assert.ok(ms > 0);
  const help = doc('help.md');
  assert.match(help, new RegExp(`read from the website more than ${ms / 60000} minutes ago`), 'help.md says when the car is read again');
});

// Upkeep reads the car on the website again just before it opens the
// listing (upkeep.js startUpkeep, sidepanel.js upkeepPriceNow) and fills the
// price the website shows then, or stops and says why. The copy a person
// reads says so, never that it fills the last scan's price without reading
// the website again, and the panel's own price banner says it too.
test('the help, README and site say a price update reads the website again first, as the upkeep banner does', async () => {
  const help = doc('help.md');
  const open = help.split('\n').find((l) => l.includes('Click **Open & update price**. The panel'));
  assert.ok(open, 'help.md describes the price update');
  assert.match(open, /reads the car on the website again first, with the same check a post makes/);
  assert.match(open, /stops there and says why: it opens and fills nothing/);
  assert.match(open, /marks it sold or sale-pending, no longer calls it pre-owned, has details that need a look/);
  assert.match(open, /A car at another store, without photos or not yet on the lot still gets its new price/);
  // a read that fails, or that Chrome refuses from the panel, stops it too (upkeepPriceNow)
  const priceNow = read('../extension/sidepanel.js').match(/async function upkeepPriceNow\([\s\S]*?\n\}\n/)[0];
  assert.match(priceNow, /if \(!fresh\.ok && fresh\.needsPermission\) \{\s*return \{ ok: false,/);
  assert.match(priceNow, /if \(!fresh\.ok\) \{[\s\S]*?return \{ ok: false,/);
  assert.match(open, /If the website can't be read just then \(or Chrome hasn't let Lot Current read it from the panel: open the website's used inventory page and click \*\*Open & update price\*\* in the popup there\)/);
  const step = help.split('\n').find((l) => l.includes('The moment the Price box appears'));
  assert.match(step, /the price the website showed at that read/);
  for (const rel of ['../docs/help.md', '../README.md', '../site-src/pages/how-it-works.html', '../site/how-it-works/index.html']) {
    assert.doesNotMatch(read(rel), /the website's new price|does not read the website again|the new price the last scan found/, `${rel} says the filled price is the last scan's`);
  }
  assert.match(read('../README.md'), /reads the car on the website again just before it opens the listing/);
  const { up, upkeepHtml } = await import('../extension/upkeep.js');
  Object.assign(up, { active: true, kind: 'price', status: 'waiting', price: 19000, scanPrice: null, listedPrice: 20000, name: 'Car A', vin: 'AAA', listingUrl: '', note: '', error: '' });
  assert.match(upkeepHtml(), /fills in <b>\$19,000<\/b> \(was \$20,000\), the price the website shows now: Lot Current read the car on the website again just before opening the listing\. Then you click <b>Update<\/b>\./);
  up.active = false;
});

// The listing watcher (detectPost.js watchForListing) reports the first
// listing or Your listings address the form's tab goes to and then stops;
// the panel reads that page once more only when it is opened again. And the
// re-read before the form opens (sidepanel.js readIsOld, readCarNow) runs
// for a read over 10 minutes old or one a newer scan contradicts in price,
// second price, status, availability or inventory type, and stops on any
// failed check. The help says both as the code does them, not "whenever".
test('the help says the panel reads the first listing page the tab goes to, and when and why the car is read again', () => {
  const watch = read('../extension/facebook/detectPost.js');
  assert.match(watch, /function finish\(result\) \{\s*if \(done\) return;\s*done = true;/, 'the listing watcher no longer stops at its first answer: update the help and this test');
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /same\(listed\.price, v\.price\) && same\(listed\.priceBeforeFees, v\.priceBeforeFees\) && same\(listed\.status, v\.status\) && same\(listed\.availability, v\.availability\) && same\(listed\.type, v\.inventoryType\)/, 'the re-read compares other fields now: update the help and this test');
  assert.match(panel, /const check = recheck\(fresh\.vehicle, state\.settings\);\s*if \(!check\.ok\) \{\s*await block\(/, 'a post no longer stops on every failed check: update the help and this test');
  const help = doc('help.md');
  assert.doesNotMatch(help, /Whenever that tab goes to a listing page/);
  assert.match(help, /The first time that tab goes to a listing page \(or to Your listings\) after the form opened, the panel reads the page[^\n]*It does not watch the tab after that first page/);
  assert.match(help, /The panel notices the first listing page the tab goes to after the form opened and reads it/);
  assert.match(help, /a scan since then no longer lists it or shows it at another price, second price, status, availability or inventory type, the panel reads and checks it again first, with the same checks as Ready to post/);
});

// Mark posted on a draft's car records the draft's price when the draft
// kept one, else the website's (drafts.js markDraftPosted, the popup's Mark
// posted); the help says both, and the old draft's pill as drafts.js draws it.
test('the help says Mark posted on a draft records the draft\'s price, or the website\'s for a draft that kept none', async () => {
  const { markDraftPosted } = await import('../extension/src/drafts.js');
  const entry = { vin: 'AAA', name: 'Car A', price: 20000 };
  assert.equal(markDraftPosted({}, entry, { price: 19500, basis: 'website' }, 'website', '2026-10-01T12:00:00.000Z').AAA.price, 19500);
  assert.equal(markDraftPosted({}, entry, { savedAt: '2026-09-30T12:00:00.000Z' }, 'website', '2026-10-01T12:00:00.000Z').AAA.price, 20000);
  assert.match(read('../extension/popup.js'), /draft \? markDraftPosted\(/, 'the popup\'s Mark posted no longer records a draft\'s price: update the help and this test');
  const line = doc('help.md').split('\n').find((l) => l.startsWith('- A car saved as a draft shows'));
  assert.match(line, /\*\*Mark posted\*\* records the draft's price, because that is what the listing shows \(a draft saved by an older version of Lot Current kept no price: its pill reads just "Draft on Facebook", and \*\*Mark posted\*\* records the website's price/);
});

// What has not been checked on Facebook's live pages is listed where a
// tester and a maintainer look: the README's Limits and the form map's
// header. The listing page's sold and removed signs (listingSigns.js, NOT
// YET VERIFIED there) are among them while that file says so.
test('the README Limits and the form map header name the listing page\'s unverified sold and removed signs', () => {
  const signs = read('../extension/facebook/listingSigns.js');
  if (!/NOT YET VERIFIED/.test(signs)) return; // checked live: the lines may go
  const limits = read('../README.md').split('\n').find((l) => l.startsWith('- The Facebook form map was checked'));
  assert.match(limits, /the words a listing page shows once it is sold or removed \(`extension\/facebook\/listingSigns\.js`\) have not been checked live yet/);
  const header = read('../extension/facebook/formMap.js').split('export const FORM_MAP')[0];
  assert.match(header, /Not checked live:[\s\S]*the sold and removed signs\s+\/\/ a listing page shows \(facebook\/listingSigns\.js, marked NOT VERIFIED there\)/);
});

// The side panel's photo button reads Attach photos until photos are on the
// form and Attach photos again after; the places that list the clicks
// Chrome's photo prompt comes from name both labels, and the demo script
// names Attach photos again, not Fill again, which asks for nothing.
test('the README, store listing and help name both labels of the photo button where they list the clicks that ask for photos', () => {
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /id="attachAgain">\$\{state\.photos && \(state\.photos\.attached \|\| state\.photos\.again\) \? 'Attach photos again' : 'Attach photos'\}/, 'the photo button\'s labels changed: update the texts and this test');
  assert.match(panel, /case 'attachAgain':\s*await askForPhotos\(\);/, 'the photo button no longer asks Chrome first: update the texts and this test');
  assert.match(panel, /case 'fillAgain':(?![^\n]*askForPhotos)/, 'Fill again now asks for photos: update the demo script and this test');
  assert.match(read('../README.md'), /Fill it in now, Attach photos, which reads Attach photos again once photos are on the form, or Download photos/);
  assert.match(read('../store/listing.md').split('\n').find((l) => l.startsWith('| `https://*/*` (optional) |')), /Fill it in now, Attach photos \(Attach photos again once photos are on the form\) or Download photos/);
  const help = doc('help.md');
  assert.match(help, /\*\*Fill it in now\*\*, \*\*Attach photos\*\*, which reads \*\*Attach photos again\*\* once photos are on the form, or \*\*Download photos\*\*\) for the first car with photos there/);
  assert.match(help, /Under \*\*Photos\*\*: \*\*Download photos\*\*, \*\*Fill again\*\*, \*\*Attach photos\*\* \(it reads \*\*Attach photos again\*\* once photos are on the form\)/);
  const demo = read('../marketing/demo-script.md');
  assert.doesNotMatch(demo, /fill it again or download photos/i);
  assert.match(demo, /When you open the form, attach photos again or download photos, it's permission to download this car's photos/);
});

// The cap counts this person's posts on the website today, taking the
// server's count from all their computers when signed in (cap.js capStatus,
// serverPostsToday). The help said "posts recorded in this browser" only,
// which a salesperson with two computers finds untrue.
test('the help says the daily cap counts your posts from all your computers when signed in, not this browser\'s alone', () => {
  const cap = read('../extension/src/cap.js');
  assert.match(cap, /serverPostsToday\(opts\.serverCount, now\)/, 'capStatus takes the server\'s count');
  const help = doc('help.md');
  const section = help.slice(help.indexOf('## The daily cap'), help.indexOf('\n## ', help.indexOf('## The daily cap') + 5));
  assert.doesNotMatch(section, /counts posts recorded in this browser for this website today\./);
  assert.match(section, /counts your own posts on this website today: the ones recorded in this browser or, when you are signed in to a Lot Current account[^.]*all your computers/);
  assert.match(section, /A colleague's posts never count toward yours\./);
  assert.match(section, /safety setting, not a guarantee/);
  // unmarking a car never hands a post back (cap.js: nothing takes an entry off the day's log)
  assert.doesNotMatch(help, /takes that post back off the count/);
  assert.match(section, /Unmarking a car \(clicking \*\*Posted ✓\*\*\) does not take it off the count either/);
  // and the data inventory's day's-log row says the same
  const logRow = read('../docs/data-inventory.md').split('\n').find((l) => l.startsWith('| `postLog:<origin>`'));
  assert.doesNotMatch(logRow, /an unmarking takes its own entry off/);
  assert.match(logRow, /still counts a post taken down or unmarked the same day/);
  assert.match(logRow, /a take-down or unmarking leaves it as it is/);
});

// A no to Chrome's question from the side panel's own list (Post, Post the
// next N, Rescan the website) starts nothing: askForSite only sets the
// status line, and a click on the same button asks again. The help said the
// panel stopped with an Allow reading button, which the panel draws only for
// a post already under way that stopped at its re-check for the permission.
test('the help says what a no to Chrome from the side panel\'s list does: nothing starts, and the same button asks again', () => {
  const panel = read('../extension/sidepanel.js');
  for (const fn of ['postFromList', 'queueFromList', 'rescanFromList']) {
    assert.match(panel, new RegExp(`async function ${fn}\\([^)]*\\) \\{\\n  if \\(!\\(await askForSite\\(\\)\\)\\) return undefined;`), `${fn} starts nothing after a no`);
  }
  assert.match(panel, /setStatus\(`Not allowed, so Lot Current can't read \$\{hostOf\(state\.origin\)\} from the side panel\. /, 'what the panel says after a no');
  assert.match(panel, /function viewBlocked\(\) \{[\s\S]*?state\.blockedOrigins[\s\S]*?id="allowSite"/, 'Allow reading is drawn only on a post stopped for the permission');
  const help = doc('help.md');
  assert.doesNotMatch(help, /If you said no, the panel stops with \*\*Allow reading/);
  assert.doesNotMatch(help, /or click \*\*Allow reading \[website\]\*\* to be asked again/);
  assert.match(help, /If you say no, nothing starts: the panel stays on its list and says "Not allowed, so Lot Current can't read \[website\] from the side panel"\. Click the same button/);
  assert.match(help, /Decline and nothing starts: the panel stays on its list and says "Not allowed, so Lot Current can't read \[website\] from the side panel"\. Click the same button again to be asked again/);
  for (const line of help.split('\n').filter((l) => /Allow reading \[website\]/.test(l))) assert.match(line, /stopped at (the|its) re-check/, `help.md ties Allow reading to a stopped post: ${line.slice(0, 80)}`);
});

// review: the help said the record of listings taken off the posted list keeps
// the VIN and times, while it keeps the car's name too (src/takenDown.js
// noteTakenDown), which the listing reader's namesake check reads.
test('the help says what the take-down record keeps, the car\'s name among it, and what each part is for', async () => {
  const { noteTakenDown } = await import('../extension/src/takenDown.js');
  const [kept] = noteTakenDown([], { vin: 'TESTVIN00000000T1', postedAt: '2026-11-16T09:00:00.000Z', stillListed: true, listedBefore: true, name: '2021 Make Model' }, '2026-11-16T12:00:00.000Z');
  assert.deepEqual(Object.keys(kept).sort(), ['listedBefore', 'name', 'postedAt', 'stillListed', 'takenDownAt', 'vin'], 'the take-down record keeps something else now: update the help and this test');
  assert.match(read('../extension/upkeep.js'), /for \(const t of takenDownList\(takenDown\)\) if \(!others\.get\(t\.vin\)\) others\.set\(t\.vin, t\.name/, 'the namesake check no longer reads the take-down record\'s names: the help can change');
  const browser = doc('help.md').split('\n').find((l) => l.startsWith('**In this browser, per website:**'));
  assert.ok(browser, 'the help no longer says what is kept in this browser');
  assert.doesNotMatch(browser, /the VIN and times of each listing you took off/, 'the help leaves the car\'s name out of the take-down record');
  assert.match(browser, /the VIN, the car's name and the times of each listing you took off your posted list in the last 30 days, with whether the website still listed the car then and whether you had marked it as gone up before that day \(for the re-post notice, so the daily cap counts a post taken down the same day, and so a listing of that car is not taken for another car with a name like it\)/);
});

test('the help says one post from a website goes at a time across Chrome windows, as the side panel holds it', () => {
  const panel = read('../extension/sidepanel.js');
  // startFlow checks the website's saved post for any car, and saves its own from the start of the check
  assert.match(panel, /const elsewhere = await postElsewhere\(req\.origin\);/, 'startFlow looks at the website\'s saved post, whatever its car');
  assert.match(panel, /state\.step = 'checking';[\s\S]{0,700}?const taken = await saveFlow\(\);[\s\S]{0,80}?if \(taken\) return giveWay\(taken[,)]/, 'the post is saved as the check begins, and gives way to one saved first');
  assert.match(panel, /One post from a website goes at a time, so none starts here/, 'what the panel says for another car');
  const help = doc('help.md');
  assert.doesNotMatch(help, /A side panel never opens a second form for a car whose post is under way in another window's side panel/);
  assert.match(help, /One post from a website goes at a time across Chrome windows\. While the side panel in one window has a post under way from a website \(a car being checked or reviewed there with that panel open, or a car whose Marketplace form is open there\), the side panel in another window starts no post from that website, for that car or another, and opens no second form/);
  assert.doesNotMatch(help, /Finish or stop it in that window, or close the side panel there, then try again\./, 'closing that side panel frees nothing while the form\'s tab is open (liveElsewhere)');
  assert.match(panel, /if \(form && typeof saved\.fbTabId === 'number'\) \{[\s\S]{0,200}?chrome\.tabs\.get\(saved\.fbTabId\)/, 'an open form\'s tab keeps the post under way with that window\'s side panel closed');
  assert.match(help, /For a car being checked or reviewed there, finish or stop it in that window, or close the side panel there, then try again\. A car whose Marketplace form is open there has to be finished there first \(closing that side panel is not enough while the form's tab is open\)/);
  // a copy in a second window replaces the post only while it is the post as it stands (saveId)
  assert.match(panel, /const samePost = [^;]*\(saved\.saveId \|\| null\) === \(known \|\| null\);/, 'saveFlow lets a copy save only while it is the post as it stands');
  assert.match(help, /A side panel opened in a second window while a post was under way shows that post as it stood then\. Once the first window's side panel has changed it \(text typed there, or its form opened\), nothing done in the second window's copy is saved over it, and that copy opens no form, while the first window's side panel or that form stays open\./);
  // review: the help and the data inventory said a second window's copy never replaces the saved post, and nothing
  // said a refused save goes unsaid: typing saves without reading the answer (onInput), and once the first window's
  // panel is closed with no form open there (liveElsewhere null) the second window's save replaces the post
  assert.match(panel, /other = samePost \? null : await liveElsewhere\(saved\);\n      if \(other\) return undefined;/, 'a refused save no longer writes nothing: update the help and the data inventory');
  assert.match(panel, /const panels = await chrome\.runtime\.getContexts\(\{ contextTypes: \['SIDE_PANEL'\], windowIds: \[saved\.windowId\] \}\);\n    if \(panels && panels\.length\) return found;/);
  // HANDOFF 22.5: a refused save went unsaid, and what was done there was lost. The panel now says it
  // (saveFlow, notSavedHere) from a review, a fields check or a form waiting for Publish, keeps the
  // text typed there on screen to copy, and names the rest (src/notSaved.js)
  assert.match(panel, /if \(other && !quiet && run === flowRun\) await notSavedHere\(other, newer\);/, 'saveFlow no longer says a refused save: update the help and the data inventory');
  assert.match(panel, /setFormButtons\(\);\n    saveFlow\(\);\n  \}, 250\);/, 'typing saves through saveFlow, which says a refused save');
  assert.deepEqual(NOT_SAVED_STEPS, ['review', 'probe', 'publish'], 'a refused save is said from other steps now: the help names the changes it covers');
  // review round 1: the help and the data inventory said every step changed there is said, while a car the
  // re-check stops there (block, step blocked) shows only why it stopped, as it does in one window
  assert.equal(notSavedReport({ copy: { vin: 'AAA', step: 'blocked', description: 'typed' }, broughtBack: { vin: 'AAA' }, saved: null, other: { where: 'form', vin: 'AAA', name: 'A' } }), null, 'a refused save at a re-check stop is said now: drop the carve-out from the help and the data inventory');
  assert.match(panel, /async function block\(message, code = 'blocked'\) \{\n  state\.step = 'blocked';\n  state\.message = message;\n  render\(\);\n  await saveFlow\(\);/, 'a re-check stop saves differently now: check what the help says of it');
  const notSaved = notSavedReport({ copy: { vin: 'AAA', step: 'review', description: 'typed', descriptionSource: 'claude', photoPick: [], highlights: ['x'], colorGuess: { exterior: 'Red' }, vinCheck: { online: { ok: true } }, listingTyped: 'y' }, broughtBack: { vin: 'AAA' }, saved: null, other: { where: 'review', vin: 'AAA', name: 'A' } });
  assert.deepEqual(notSaved.kept.map((k) => k.label), ['Description', 'Listing link'], 'the panel keeps other text now: the help says which');
  assert.equal(notSaved.notSaved.length, 5, 'the panel names other changes as not saved now: the help says which');
  assert.doesNotMatch(help, /The second window's panel does not say when a change made there was not saved/, 'the help still says a refused save goes unsaid');
  // review round 1: the kept text is not always typed (a description begun or rewritten there), anything
  // else opened in that side panel clears it too, and a pick lost to another car's post is done again
  // when this car is posted (src/notSaved.js)
  assert.match(help, /When a change made in the second window's copy is not saved this way \(text typed there, photos or highlights picked, a rewrite, a colour guess or VIN check, a step changed\), that side panel says so, except for a car the re-check stops there, which shows only why it stopped: it names the car under way in the other window and says to finish or stop that post there\. It then leaves its copy and opens no form, shows the description as it stood there and any listing link typed there in boxes with a \*\*Copy\*\* button \(kept on that screen only: copy it before you leave that screen, since closing that side panel, clicking \*\*Back to the list\*\* or opening anything else in it clears it\), and names the photo or highlight picks, rewrite, colour guess or VIN check made there, which were not saved and can be done again in the other window \(or, when another car's post is under way there, when you post this car\)\. So type in the window whose side panel has the post\./);
  assert.doesNotMatch(help, /until that side panel closes or you click \*\*Back to the list\*\*/, 'the help says only closing the panel or Back clears the kept text');
  assert.match(panel, /<button type="button" class="primary wide" id="back">Back to the list<\/button>/, 'the help names the button that leaves the kept text');
  assert.match(help, /Once the first window's side panel is closed with no Marketplace form of that post open there, the side panel in the second window takes the post over: its next save replaces the saved post with its own copy as it stands/);
  const single = help.slice(help.indexOf('## Post one car'), help.indexOf('## Post several (the queue)'));
  assert.match(single, /Side panels open in two Chrome windows: one post from a website goes at a time, and a change made in the second window's copy of a post may not be saved; that side panel then says so and shows the text from there for you to copy\. The point under "Post several \(the queue\)" that starts "Each car is recorded once" says how; it holds for a single post too\./, 'the single-post section does not point to what happens in a second window');
  assert.match(help, /^- Each car is recorded once[^\n]*When a change made in the second window's copy is not saved this way/m, 'the pointer names the point that says it');
  const flowRow = doc('data-inventory.md').split('\n').find((l) => l.startsWith('| `postFlow:<origin>` |'));
  assert.doesNotMatch(flowRow, /never replaces it/, 'the data inventory says a second window\'s copy never replaces the saved post, while it takes the post over once the first window\'s panel is closed with no form open');
  assert.doesNotMatch(flowRow, /\(in a queue, with whether its page was seen to show the car\)/, 'the data inventory says the listing page is read only in a queue, while it is read after every post');
  assert.match(flowRow, /the listing address detected, with whether its page was seen to show the car \(read after every post, in a queue or not\)/);
  assert.doesNotMatch(flowRow, /dropped without a word/, 'the data inventory still says a refused save goes unsaid');
  assert.match(flowRow, /a save from a second window's side panel replaces the saved post only while it is that post as last saved, or once the window that saved it has its side panel closed and no Marketplace form of it open, when that panel takes the post over; otherwise nothing is written: opening the form or starting a post there says that the post is under way in another window, and anything else done there \(text typed, photos or highlights picked, a rewritten or regenerated description, a colour guess or VIN check, a step changed\) is dropped and that side panel says so \(a car the re-check stops there shows only why it stopped\), showing the description as it stood there and any listing link typed there on its screen to copy \(held in no storage, and gone once that panel closes or shows anything else\) and naming the picks, rewrite, colour guess or VIN check made there/, 'the data inventory says what a second window\'s panel shows of a refused save, and that the kept text is stored nowhere (sidepanel.js notSavedHere, src/notSaved.js)');
});

// The help said a price "with or without $" and a mileage "however it is
// written" must match, and that one owner "is said only when" the Carfax flag
// is set, while the checks read set forms: a price written out in words, or
// after a word they don't know ("Get it for 15,350" where 15,350 is also the
// stock number), passes. The help and README say which forms are read, every
// form they quote is caught, and the caveat covers prices and one owner too.
test('the help and README say which ways of writing a price, a mileage or one owner the checks read, and each example is caught', () => {
  const vehicle = { year: 2019, make: 'Jeep', model: 'Cherokee', trim: 'Latitude', mileage: 41250, price: 26500, priceBeforeFees: 25995, vin: '1C4PJMCB5KD100001', features: [], descriptionRaw: 'Was 28,995 with 38,000 miles.', carfaxOneOwner: false };
  const ctx = { vehicle, dealer: { name: 'Example Motors', city: 'Springfield' }, salesperson: { name: 'Pat', title: 'Sales Consultant' }, price: 26500 };
  const codes = (said) => runGuardrails(`The 2019 Jeep Cherokee Latitude. ${said} I'm Pat, Sales Consultant at Example Motors.`, ctx).problems.map((p) => p.code);
  const line = doc('help.md').split('\n').find((l) => l.includes('The checks line:'));
  const readme = read('../README.md').split('\n').find((l) => l.startsWith('- **Description writer**'));
  assert.ok(line && readme);
  const caught = {
    'price-mismatch': ['$28,995', 'Internet price: 28,995', 'Save 1,500', '1,500 down', '1500 off', '1,500 dollars'],
    'mileage-mismatch': ['38,000 original miles', 'Mileage: 38,000', '38k on the clock'],
    'one-owner': ['one owner', 'single owner', 'the only owner', 'one adult owner', 'one careful, loving owner', 'owned by one retired teacher', 'one damage-free owner'],
    'price-change': ['Reduced from 31,995'],
  };
  for (const [code, examples] of Object.entries(caught)) {
    for (const ex of examples) {
      assert.ok(line.includes(`"${ex}"`), `help.md no longer quotes "${ex}"; update this list`);
      assert.ok(codes(ex + '.').includes(code), `"${ex}" is not caught as ${code}`);
    }
  }
  assert.ok(codes('Only 28,995!').includes('unknown-number'), 'a bare write-up amount is caught');
  for (const text of [line, readme]) {
    assert.doesNotMatch(text, /with or without "\$"|however it is written|One owner is said only when/, 'a check is described as catching every wording');
    assert.match(text, /a price written with "\$", after a price word or before a money word/);
    assert.match(text, /a mileage written in one of the usual ways/);
    assert.match(text, /go by set words and number forms, so [^:]*can still pass: read (?:the description|every draft) through before you publish/);
  }
  assert.match(line, /Wording that says one owner \([^)]*\) fails unless the Carfax one-owner flag is set/);
  assert.match(line, /a price, a mileage, one owner or any other claim worded in a way they don't know \(such as a price written out in words\) can still pass/);
  // what the caveat names: a price in words, and a price after a word the checks don't know, pass
  const stock = { ...ctx, vehicle: { ...vehicle, stock: '15350' } };
  assert.equal(runGuardrails('The 2019 Jeep Cherokee Latitude. Twenty-five thousand nine hundred ninety-five dollars. I\'m Pat, Sales Consultant at Example Motors.', ctx).problems.filter((p) => /price|number/.test(p.code)).length, 0);
  assert.equal(runGuardrails('The 2019 Jeep Cherokee Latitude. Get it for 15,350. I\'m Pat, Sales Consultant at Example Motors.', stock).problems.filter((p) => /price|number/.test(p.code)).length, 0);
});
