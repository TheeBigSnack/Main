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
import { wizardSteps } from '../extension/src/wizardSteps.js';
import { checkPreOwned } from '../extension/src/classify.js';
import { readdirSync } from 'node:fs';
import { SITE } from '../site/config.js';
import { copyProblems } from './copyGuards.js';

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
    // test/copyGuards.js: what no document may say; salespeople read the help doc, so nothing in it promises anything about their account either
    assert.deepEqual(copyProblems(text, { customerFacing: name === 'help.md' }), [], `docs/${name}`);
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
  for (const name of ['support.md', 'launch-checklist.md']) {
    const lines = doc(name).split('\n').filter((l) => l.includes('support@lotsync.example'));
    assert.ok(lines.length, `docs/${name} no longer names the placeholder inbox`);
    for (const line of lines) {
      const paths = [...line.matchAll(/`([\w./-]+\.(?:md|js))`/g)].map((m) => m[1]).filter((p) => p !== 'docs/' + name);
      for (const p of paths) {
        const url = new URL('../' + p, import.meta.url);
        assert.ok(existsSync(url), `${p}, named in docs/${name}, does not exist`);
        assert.match(readFileSync(url, 'utf8'), /[\w.+-]+@[\w-]+\.[\w.]+|\[support email\]/, `docs/${name} says the support address lives in ${p}, which has no support address or bracket for one`);
      }
    }
  }
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

// node --test runs every test( and it( call site once; none of the files
// makes tests in a loop, so the count of call sites is the count npm test prints.
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
