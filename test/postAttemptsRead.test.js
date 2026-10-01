// Who reads the post attempts (time per post) in the dealership's account:
// the salesperson who made them and the dealership's managers, not every
// member (supabase/migrations/0009_ui_post_attempts_read.sql; the database
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
  assert.match(row, /\| The salesperson who made them and the dealership's managers \(`0009_ui_post_attempts_read\.sql`; before it, every member\);/);
  assert.doesNotMatch(inventory, /post attempts, to-do items and scan counts sync to the dealership's rows in the database, where every member of that dealership can read them\./);

  assert.match(termsSummary(true), /only you and your managers see your post timings\./);
  assert.match(read('../docs/help.md'), /only you and your managers see your post timings/);
  assert.match(read('../legal/questions-for-attorney.md'), /the post attempts and to-do items go to the dealership's database, where its managers see them/);

  // the manager view tells a salesperson whose seconds they are looking at
  const manager = read('../manager/manager.js');
  assert.match(manager, /const OWN_SECONDS_ONLY = 'As a salesperson you see only your own seconds per post, so the Everyone median is yours too; your managers see everyone\\'s\.';/);
  assert.match(manager, /\$\{myRole\(\) === 'manager' \? '' : ` \$\{OWN_SECONDS_ONLY\}`\}<\/p>`;/);
});
