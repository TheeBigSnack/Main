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
import { readFileSync, existsSync } from 'node:fs';
import { PILOT_RETENTION_DAYS } from '../extension/src/pilot.js';
import { STORAGE_FULL } from '../extension/src/storage.js';
import { withDefaults, profileFrom } from '../extension/src/settings.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const DOCS = ['help.md', 'support.md', 'launch-checklist.md', 'next-platform.md'];
const doc = (name) => read('../docs/' + name);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  'Clear everything for this website',
  'Forget my synced profile',
  'Allow automatic rescans',
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

test('help.md is organised by what people are trying to do', () => {
  const help = doc('help.md');
  const sections = [
    'Install and update', 'Set up', 'Scan', 'Post one car', 'Post several', 'When a car sells or a price changes', 'The Pilot tab', 'Settings',
    'When a field could not be filled', 'When Facebook restored a draft', 'When Chrome asks for a permission', 'When the website scan fails',
    'When the description writer is off', 'The daily cap', 'What Lot Sync never does', 'Where the data lives', 'How to forget the synced profile',
  ];
  for (const s of sections) assert.match(help, new RegExp('^## ' + escapeRe(s), 'm'), `docs/help.md has no "${s}" section`);
  // the three answers for a field that could not be filled
  assert.match(help, /Copy report/);
  assert.match(help, /Send it/);
  assert.match(help, /Fill it by hand/);
});

test('help.md says Lot Sync never clicks Publish and is not affiliated with Meta', () => {
  const help = doc('help.md');
  assert.match(help, /You click Publish\. Lot Sync never does\./);
  assert.match(help, /never clicks Publish, Update, Delete or Mark as sold/);
  assert.match(help, /Lot Sync is not affiliated with Meta Platforms, Inc\./);
  assert.match(help, /not a guarantee/, 'the cap and the design are described honestly');
});

test('no docs/ file carries a pilot-dealer value or Meta-affiliation wording', () => {
  // the pilot dealer is a fixture, not a default (test/anyDealer.test.js)
  const PILOT = /Waynesburg|Ron Lewis|Cranberry|Pleasant Hills|15370|\$\s?490\b|\bRoger\b|ronlewis/i;
  // what no document may say (test/marketing.test.js)
  const NEVER = [
    /approved by (meta|facebook)/i, /(meta|facebook) partner/i, /partner(ed|ship) with (meta|facebook)/i, /official(ly)? (meta|facebook)/i,
    /compliant with (meta|facebook)/i, /(customers|dealers|salespeople) (say|love|report)/i, /\b(five|5) stars?\b/i,
    /\d+\s*(%|percent|x|times) (faster|more|fewer)/i, /hours? (a|per) (day|week)/i, /industry[- ]leading/i, /best[- ]in[- ]class/i, /\b#1\b/,
  ];
  for (const name of DOCS) {
    const text = doc(name);
    const hit = text.match(PILOT);
    assert.equal(hit, null, `docs/${name} contains the pilot value "${hit && hit[0]}"`);
    for (const re of NEVER) assert.doesNotMatch(text, re, `docs/${name} matches ${re}`);
    // "not a guarantee" and its cousins are the honest line; any other guarantee is a promise we can't make
    const rest = text.replace(/(not|no|isn't|not be|without|never|can't|cannot|won't|doesn't|don't|no one can|no tool can)[a-z' ]{0,20}guarantee[ds]?/gi, '').replace(/a guarantee\b/gi, '');
    assert.doesNotMatch(rest, /\bguarantee[ds]?\b/i, `docs/${name} makes a guarantee`);
  }
  // salespeople read the help doc: nothing that promises account safety
  const help = doc('help.md');
  for (const re of [/never (be|get) restricted/i, /your account is (safe|protected)/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bbots?\b/i]) {
    assert.doesNotMatch(help, re, `docs/help.md matches ${re}`);
  }
});

test('support.md has the inbox, what to ask for, the one-business-day answer, the log, the severity words and what is never done', () => {
  const s = doc('support.md');
  assert.match(s, /support@lotsync\.example/, 'the placeholder inbox');
  assert.match(s, /within one business day/, 'the PLAN.md M6 commitment');
  for (const ask of ['Copy report', 'Settings', 'The website', 'What was on screen']) assert.ok(s.includes(ask), `support.md does not ask for "${ask}"`);
  assert.match(s, /^\| Date \| Dealer \| Who \| What happened \| The report \| Severity \| Fix commit \| Answered when \|$/m, 'the log template');
  for (const w of ['blocks posting', 'wrong data on a listing', 'cosmetic']) assert.ok(s.includes(w), `support.md lacks the severity word "${w}"`);
  assert.match(s, /Never touch a salesperson's Facebook account/);
  assert.match(s, /Never ask for passwords/);
  assert.match(s, /Lot Sync is not affiliated with Meta Platforms, Inc\./);
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
  assert.match(advice, /\*\*Clear pilot numbers\*\*/, 'the first way out: the Pilot tab');
  assert.match(advice, /\*\*Clear everything for this website\*\*/, 'the second way out: Settings on the old website');
  assert.match(advice, /no longer (post from|use)/, 'says it is an old website, not the current one');
});

test('help.md describes the Terms step and the Settings section in both states the code renders', () => {
  const help = doc('help.md');
  const wizard = read('../extension/wizard.js');
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
});

test('the synced-profile lists name the Terms acceptance the profile carries', () => {
  assert.ok(Object.keys(profileFrom({})).includes('legal'), 'the profile no longer carries the acceptance: update the lists');
  assert.ok(read('../extension/popup.js').includes('Terms acceptance'), 'the popup\'s own hint names it');
  for (const rel of ['../legal/privacy-policy.md', '../legal/chrome-web-store-privacy.md', '../docs/help.md']) {
    const lists = read(rel).match(/\(name, role, dealership[^)]*\)/g) || [];
    assert.ok(lists.length, `${rel} has no profile list`);
    for (const l of lists) assert.match(l, /Terms acceptance/, `${rel} profile list lacks the Terms acceptance: ${l}`);
  }
});

test('README.md carries the shipped version in its title and the queue controls as the popup labels them', () => {
  const readme = read('../README.md');
  const [major, minor] = manifest().version.split('.');
  assert.match(readme, new RegExp(`^# Lot Sync \\(v${major}\\.${minor}\\)`), `README.md title is not v${major}.${minor}`);
  const popup = read('../extension/popup.js');
  assert.ok(popup.includes('Select the next ') && popup.includes('Post selected'), 'the queue labels moved: update README and help.md');
  assert.doesNotMatch(readme, /Select all/, 'README.md names a control the popup does not have');
  assert.match(readme, /\*\*Select the next N\*\*/);
  assert.match(readme, /\*\*Post selected\*\*/);
});

test('the CHANGELOG entry for the shipped version names what support and the help doc send people to', () => {
  const changelog = read('../CHANGELOG.md');
  const start = changelog.indexOf('## ' + manifest().version);
  assert.ok(start >= 0, `CHANGELOG.md has no ${manifest().version} section`);
  const end = changelog.indexOf('\n## ', start + 1);
  const section = changelog.slice(start, end > 0 ? end : undefined);
  assert.match(section, /Copy problem report/, 'the button support.md asks for in every report');
  assert.match(section, /storageKeys\.js/, 'the storage hardening');
  assert.match(section, /STORAGE_FULL/, 'the storage-full message');
});

test('the files support.md and the launch checklist say hold the support address do hold it', () => {
  for (const name of ['support.md', 'launch-checklist.md']) {
    const lines = doc(name).split('\n').filter((l) => l.includes('support@lotsync.example'));
    assert.ok(lines.length, `docs/${name} no longer names the placeholder inbox`);
    for (const line of lines) {
      const paths = [...line.matchAll(/`([\w./-]+\.(?:md|js))`/g)].map((m) => m[1]).filter((p) => p !== 'docs/' + name);
      for (const p of paths) {
        const url = new URL('../' + p, import.meta.url);
        assert.ok(existsSync(url), `${p}, named in docs/${name}, does not exist`);
        assert.match(readFileSync(url, 'utf8'), /support@|\[support email\]/, `docs/${name} says the support address lives in ${p}, which has no support address or bracket for one`);
      }
    }
  }
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
  const steps = read('../extension/wizard.js').match(/^const STEPS = \[([^\]]+)\]/m)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  const heading = handoff.match(/^### 5\.7 .*steps `([^`]+)`/m);
  assert.ok(heading, 'HANDOFF.md 5.7 lists the steps');
  assert.deepEqual(heading[1].split(',').map((s) => s.trim()), steps, 'HANDOFF.md 5.7 step list differs from wizard.js STEPS');
});
