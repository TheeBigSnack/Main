// Who reads the post attempts (time per post) in the dealership's account:
// the salesperson who made them and the dealership's managers, not every
// member (supabase/migrations/0011_ui_post_attempts_read.sql; the database
// check is supabase/tests/attempts.sql). The migrations are read in order,
// so the policy that is left is the one a fresh build and the deployed
// project both end with; and the texts that say who sees them say the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { termsSummary } from '../extension/src/wizardSteps.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MIGRATIONS = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

// The policies on public.post_attempts after every migration has run, by name.
function postAttemptPolicies() {
  const policies = new Map();
  for (const f of MIGRATIONS) {
    const sql = read('../supabase/migrations/' + f).replace(/--[^\n]*/g, '');
    const steps = [
      ...[...sql.matchAll(/drop policy (?:if exists )?"([^"]+)"\s+on public\.post_attempts\s*;/g)].map((m) => ({ at: m.index, drop: m[1] })),
      ...[...sql.matchAll(/create policy "([^"]+)"\s+on public\.post_attempts for (\w+) to authenticated\s+([^;]*);/g)].map((m) => ({ at: m.index, create: m[1], cmd: m[2], body: m[3].replace(/\s+/g, ' ') })),
    ].sort((a, b) => a.at - b.at);
    for (const s of steps) {
      if (s.drop) policies.delete(s.drop);
      else policies.set(s.create, { cmd: s.cmd, body: s.body, file: f });
    }
  }
  return policies;
}

test('after every migration a salesperson reads only their own post attempts and a manager the dealership\'s', () => {
  const policies = postAttemptPolicies();
  const selects = [...policies.entries()].filter(([, p]) => p.cmd === 'select');
  assert.equal(selects.length, 1, `one select policy on post_attempts, found: ${selects.map(([n]) => n).join(', ')}`);
  const [name, policy] = selects[0];
  assert.ok(!policies.has("members read their dealership's post attempts"), 'the member-wide select policy of 0002 is still in force');
  assert.equal(policy.body, "using ((public.is_member(dealership_id) and user_id = auth.uid()) or public.is_manager(dealership_id))", `${name} (${policy.file})`);
  // writing is as it was: own rows for a salesperson, any for a manager, deletes for managers only
  assert.ok(policies.has('salespeople insert their own post attempts'));
  assert.ok(policies.has('salespeople update their own post attempts'));
  assert.ok(policies.has('managers update any post attempt of their dealership'));
  assert.ok(policies.has('managers delete post attempts of their dealership'));
  // the database check that proves it runs with the others (scripts/sql-test.mjs)
  const check = read('../supabase/tests/attempts.sql');
  for (const words of ["p_s1 can see a colleague''s post attempt", "the summary view gives p_s1 a colleague''s median", "p_s1''s upsert of their own attempt did not land", 'p_mgr should see the 6 post attempts of P']) {
    assert.ok(check.includes(words), `attempts.sql checks: ${words}`);
  }
  // the deployed files stay as they are: the change is a file of its own
  assert.match(read('../supabase/migrations/0002_rls.sql'), /create policy "members read their dealership's post attempts"\s+on public\.post_attempts for select to authenticated\s+using \(public\.is_member\(dealership_id\)\);/);
});

test('the texts say a person\'s post attempts are seen by them and the managers, not by every member', () => {
  const policy = read('../legal/privacy-policy.md');
  const usage = policy.split('\n').find((l) => l.startsWith('| Usage numbers'));
  assert.ok(usage, 'the privacy policy has a Usage numbers row');
  assert.match(usage, /the User's post attempts are seen by the User and the dealership's managers, and the to-do items by every member of the dealership/);
  const store = read('../legal/chrome-web-store-privacy.md').split('\n').find((l) => l.startsWith('| Usage numbers'));
  assert.match(store, /the user's post attempts are seen by the user and the dealership's managers, and the to-do items by every member of the dealership/);

  const inventory = read('../docs/data-inventory.md');
  const row = inventory.split('\n').find((l) => l.startsWith('| `post_attempts` |'));
  assert.match(row, /\| The salesperson who made them and the dealership's managers \(`0011_ui_post_attempts_read\.sql`; before it, every member\);/);
  assert.doesNotMatch(inventory, /post attempts, to-do items and scan counts sync to the dealership's rows in the database, where every member of that dealership can read them\./);

  assert.match(termsSummary(true), /only you and your managers see your post timings\./);
  assert.match(read('../docs/help.md'), /only you and your managers see your post timings/);

  // the attorney's Web Store question and the website's FAQ say the same,
  // to-do items and all: every member reads those, not only the managers
  const item = read('../legal/questions-for-attorney.md').split('\n').find((l) => l.startsWith('- **8.4**'));
  assert.match(item, /the post attempts and to-do items go to the dealership's database, where the person's post attempts are read by them and the dealership's managers, and the to-do items by every member of the dealership\./);
  assert.doesNotMatch(item, /where its managers see them/, '8.4 says only the managers see the to-do items, which every member reads');
  for (const faq of [read('../site-src/pages/faq.html'), read('../site/faq/index.html')]) {
    assert.match(faq, /where everyone signed in at your dealership sees your posted list, to-do items and scan counts, and only you and your managers see your post timings;/);
    assert.doesNotMatch(faq, /where your manager sees them/);
  }
});

test('the manager view says whose seconds per post it shows, and never calls a manager a salesperson', () => {
  const manager = read('../manager/manager.js');
  const start = manager.indexOf('const OWN_SECONDS_ONLY = ');
  const end = manager.indexOf('\n', manager.indexOf('const secondsNote = '));
  assert.ok(start > 0 && end > start, 'manager.js keeps the note in OWN_SECONDS_ONLY, SECONDS_BY_ROLE and secondsNote');
  const secondsNote = new Function(`${manager.slice(start, end)}\nreturn secondsNote;`)();
  assert.equal(secondsNote('manager'), '', 'a manager reads every attempt: no note');
  assert.equal(secondsNote('salesperson'), " As a salesperson you see only your own seconds per post, so the Everyone median is yours too; your managers see everyone's.");
  // the role could not be read (memberships unreadable, no billing role): the
  // reader may be a manager, so the note names both roles
  assert.equal(secondsNote(''), " A salesperson sees only their own seconds per post here, and a manager everyone's.");
  assert.match(manager, /included\.\$\{secondsNote\(myRole\(\)\)\}<\/p>`;/, 'the table\'s hint carries the note for the reader\'s role');
});

test('the narrowing migration has a number of its own, after the ones other changes took', () => {
  // Supabase keeps its record of applied migrations by number, so two files
  // with one number cannot both be applied and recorded; 0009
  // (subscriptions.cancel_at) and 0010 (the backend review fixes) are taken
  // by other changes, so this one is 0011
  assert.ok(MIGRATIONS.includes('0011_ui_post_attempts_read.sql'), MIGRATIONS.join(', '));
  const numbers = MIGRATIONS.map((f) => f.slice(0, 4));
  assert.deepEqual(numbers.filter((n, i) => numbers.indexOf(n) !== i), [], 'two migrations share a number');
});

test('the attorney questions number each section once, in order, and the pilot records point at their question', () => {
  const questions = read('../legal/questions-for-attorney.md');
  const sections = [...questions.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(sections, [...sections].sort((a, b) => a - b), 'sections out of order');
  assert.equal(new Set(sections).size, sections.length, `a section number is used twice: ${sections.join(', ')}`);
  const cited = read('../extension/src/pilot.js').match(/legal\/questions-for-attorney\.md (\d+)\.(\d+)/);
  assert.ok(cited, 'src/pilot.js names the question on the pilot agreement\'s list');
  const item = questions.split('\n').find((l) => l.startsWith(`- **${cited[1]}.${cited[2]}**`));
  assert.ok(item, `question ${cited[1]}.${cited[2]} is not in questions-for-attorney.md`);
  assert.match(item, /^- \*\*\d+\.\d+\*\* Pilot Agreement section 2 lists what the Dealer lets Lot Current record/);
  const heading = questions.slice(0, questions.indexOf(item)).match(/^## (\d+)\. .*$/gm).pop();
  assert.ok(heading.startsWith(`## ${cited[1]}. `), `question ${cited[1]}.${cited[2]} sits under "${heading}"`);
});
