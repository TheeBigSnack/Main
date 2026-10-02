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
import { listingStatus, MASS_DISAPPEARANCE_MIN_LOT, diffScans } from '../extension/src/rescan.js';
import { readdirSync } from 'node:fs';
import { SITE } from '../site/config.js';
import { copyProblems } from './copyGuards.js';
import { honestyProblems } from './honesty.js';
import { ADAPTERS, platformNames, unsupportedSiteMessage } from '../extension/adapters/index.js';
import { LEGAL } from '../extension/src/legalLinks.js';
import { accountsConfigured } from '../extension/src/accountConfig.js';
import { FORM_MAP } from '../extension/facebook/formMap.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
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
  assert.match(read('../PILOT.md'), /neither does a scan that keeps the sold car under Needs a look because its page could not be checked/);
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
  const rest = help.split('\n').find((l) => l.includes(`"${held}"`)) || '';
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
  assert.match(para, /scanning another website in the popup does not switch it/, 'help.md does not say a scan in the popup leaves the panel\'s website alone');
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
  assert.match(popup, /resolveFlag\(p, vin, null, \{ how: 'manual' \}\)\)\.then\(syncInBackground\)/, 'Taken down no longer asks for a sync: these texts can say it waits for the next one');
  assert.match(popup, /resolveFlag\(p, vin, 'price', \{ how: 'manual' \}\)\)\.then\(syncInBackground\)/, 'Updated no longer asks for a sync');
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
// none still writes a done deploy as one to come. The workflow keeps its
// "FAIL on purpose" rule for a brand-new project, so the guide says those
// lines are real on production.
test('the setup guides say production already has its database and all four functions', () => {
  assert.match(read('../supabase/README.md'), /The production project has applied `0001_schema\.sql` to `0008_usage\.sql`/, 'supabase/README.md no longer records what production applied: change the guides with it');
  const setup = read('../docs/production-setup.md');
  const step3 = setup.slice(setup.indexOf('## Step 3.'), setup.indexOf('## Step 4.'));
  assert.match(step3, /\*\*Where production stands\.\*\*[^\n]*up to `0008_usage\.sql` and all four functions \(`rewrite`, `sync`, `billing` and `lead`\)/, 'production-setup step 3 does not say what production already has');
  assert.doesNotMatch(step3, /^\s*After plan and database the outside check prints some `FAIL` lines on purpose/m, 'production-setup step 3 calls a FAIL after plan or database expected on production');
  assert.match(step3, /Production is past that[^.]*read any `FAIL` on a plan or database run there as a real one/, 'production-setup step 3 does not say a FAIL on production is real');
  const stale = [
    ['../docs/website.md', /`lead` function is not deployed/],
    ['../docs/stripe-setup.md', /the webhook and the deploy wait for the project/],
    ['../docs/launch-checklist.md', /the first deploy happens when the website pull request is merged|what is left is the deploy\b/],
    ['../supabase/README.md', /arrive with the UI wiring/],
    ['../.github/workflows/supabase.yml', /billing and lead come later/],
  ];
  for (const [rel, re] of stale) assert.doesNotMatch(read(rel), re, `${rel} still writes a deploy that is done as one to come`);
});
