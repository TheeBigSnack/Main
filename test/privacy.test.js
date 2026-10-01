// The owner's privacy tools (supabase/migrations/0006_privacy.sql), held to
// the rules a Node test can read off their source: no API role may execute
// any of them, each runs as its caller with a pinned search_path, the
// confirm guards come before anything is changed, the delete lets the
// foreign keys cascade rather than deleting around keep_a_manager, and
// every table that belongs to a dealership is exported and counted. Nothing
// here runs SQL; supabase/tests/privacy.sql proves the behaviour against a
// database. The second half holds supabase/README.md and docs/support.md to
// the functions and to the privacy policy's promise and its one number, and
// the copy of a person's own data to every table that carries their user id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sql = read('../supabase/migrations/0006_privacy.sql');
const sqlTest = read('../supabase/tests/privacy.sql');
const readme = read('../supabase/README.md');
const support = read('../docs/support.md');
const policy = read('../legal/privacy-policy.md');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MIGRATIONS = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const API_ROLES = 'public, anon, authenticated, service_role';

// every function 0006 creates, with its signature as Postgres spells it
const FUNCTIONS = [...sql.matchAll(/^create or replace function public\.(\w+)\(([^)]*)\)/gm)].map((m) => ({
  name: m[1],
  signature: `public.${m[1]}(${m[2].split(',').map((p) => p.trim().split(/\s+/).slice(1).join(' ')).join(', ')})`,
}));
const body = (name) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = sql.indexOf(`comment on function public.${name}(`, start);
  assert.ok(start >= 0 && end > start, `0006_privacy.sql has no ${name}() with a comment after it`);
  return sql.slice(start, end);
};

// every table the migrations create, and whether it carries a dealership_id
const TABLES = MIGRATIONS.flatMap((f) => [...read('../supabase/migrations/' + f).matchAll(/^create table public\.(\w+) \(([^]*?)\n\);/gm)].map((m) => ({ name: m[1], columns: m[2], file: f })));
// signup_attempts (0007_signup.sql) names a dealership without belonging to
// it: a created row is the account's record of the dealership it started,
// which per_account keeps counting after that dealership is deleted, so its
// foreign key sets null instead of cascading. It is exported all the same.
const REFERS = ['signup_attempts'];
const OWNED = TABLES.filter((t) => /^\s*dealership_id uuid\b/m.test(t.columns) && !REFERS.includes(t.name));

test('0006_privacy.sql creates the three tools and their helper, and no API role may execute any of them', () => {
  assert.deepEqual(FUNCTIONS.map((f) => f.signature).sort(), [
    'public.billing_events_of(uuid)',
    'public.delete_dealership(uuid, text)',
    'public.export_dealership(uuid)',
    'public.forget_person(uuid, text)',
  ]);
  for (const { name, signature } of FUNCTIONS) {
    assert.ok(sql.includes(`revoke execute on function ${signature} from ${API_ROLES};`), `${signature}: execute is not revoked from ${API_ROLES}`);
    const fn = body(name);
    assert.match(fn, /\bsecurity invoker\b/, `${name} runs as its caller`);
    assert.match(fn, /\nset search_path = ''\n/, `${name} pins search_path`);
  }
  assert.doesNotMatch(sql, /security definer/i, 'no function here runs with its owner\'s rights');
  assert.doesNotMatch(sql, /^\s*grant\b/im, 'nothing is granted to anyone');
  assert.doesNotMatch(sql, /disable trigger|session_replication_role/i, 'no trigger is switched off');
});

test('delete_dealership: the exact website_origin guard comes first, then the cascade does the deleting', () => {
  const fn = body('delete_dealership');
  const guard = fn.indexOf('if delete_dealership.confirm is distinct from d.website_origin then');
  assert.ok(guard > 0, 'the confirm is compared with the stored origin exactly (no lower, no trim)');
  assert.match(fn.slice(guard), /^[^;]*\n\s+raise exception [^;]*errcode = 'P0007'/, 'a wrong confirm raises P0007');
  assert.doesNotMatch(fn, /lower\(|trim\(/, 'nothing loosens the origin comparison');
  const deletes = [...fn.matchAll(/\bdelete from ([\w.]+)/g)].map((m) => m[1]);
  assert.deepEqual(deletes, ['public.dealerships'], 'only the dealership row is deleted; the foreign keys take the rest (and let keep_a_manager through)');
  assert.ok(guard < fn.indexOf('delete from public.dealerships'), 'the guard comes before the delete');
  assert.match(fn, /where x\.id = delete_dealership\.dealership_id for update;/, 'the row is locked before the counts');
  // the membership rows before the dealership row, the order a manager's step-down takes them (the row,
  // then keep_a_manager's lock on the dealership): the other order deadlocks the two
  const members = fn.indexOf('perform 1 from public.memberships m where m.dealership_id = delete_dealership.dealership_id for update;');
  assert.ok(members > 0 && members < fn.indexOf('from public.dealerships x where x.id = delete_dealership.dealership_id for update;'), 'memberships are locked before the dealership');
  assert.match(fn, /'stripe_customer_id', sub\.stripe_customer_id/, 'the answer names the Stripe customer');
  assert.match(fn, /'accounts_without_a_dealership', orphans/);
  assert.match(fn, /'kept', jsonb_build_object\('billing_events', kept_events\)/, 'billing events are kept and counted');
});

test('forget_person: the email guard and the last-manager check come before any change, and the auth row goes last', () => {
  const fn = body('forget_person');
  const guard = fn.indexOf('lower(forget_person.confirm) <> lower(their_email)');
  assert.ok(guard > 0, 'the confirm is compared with the account\'s email');
  assert.match(fn, /if their_email is null or forget_person\.confirm is null or /, 'no email, or no confirm, is refused too');
  const lastManager = fn.indexOf("using errcode = 'P0006'");
  assert.ok(lastManager > guard, 'the last-manager refusal, with keep_a_manager\'s own code');
  const firstChange = fn.search(/\n\s+(delete from|update) /);
  assert.ok(firstChange > lastManager, 'nothing changes before both checks');
  assert.match(fn.slice(guard), /^[^;]*\n\s+raise exception [^;]*errcode = 'P0007'/, 'a wrong confirm raises P0007');
  assert.match(fn, /update public\.listings l set salesperson = null where l\.user_id = uid/);
  assert.match(fn, /update public\.post_attempts a set salesperson = null where a\.user_id = uid/);
  assert.match(fn, /update public\.listings l set listing_url = null where l\.user_id = uid and l\.status = 'taken_down'/, 'links go only where the listing is already down');
  assert.doesNotMatch(fn, /delete from public\.(listings|post_attempts|rewrite_usage)\b/, 'the dealership\'s rows stay');
  assert.match(fn, /delete from public\.invites i where i\.created_by = uid and i\.used_at is null;/, 'unused codes they made');
  assert.match(fn, /delete from public\.invite_misses x where x\.user_id = uid;/);
  // their sign-up attempts go with the auth row (on delete cascade), counted first so the answer says so
  assert.match(fn, /select count\(\*\) into n_signups from public\.signup_attempts a where a\.user_id = uid;\n\s+delete from auth\.users u where u\.id = uid;/);
  assert.match(fn, /'signup_attempts', n_signups,/);
  const lastDelete = [...fn.matchAll(/\n\s+delete from ([\w.]+)/g)].pop();
  assert.equal(lastDelete[1], 'auth.users', 'the account is the last thing deleted');
});

test('every table that belongs to a dealership cascades from it, is exported and is counted by the delete', () => {
  assert.ok(OWNED.length >= 8, OWNED.map((t) => t.name).join(', '));
  const exportFn = body('export_dealership');
  const deleteFn = body('delete_dealership');
  for (const t of OWNED) {
    assert.match(t.columns, /dealership_id uuid[^,\n]*references public\.dealerships \(id\) on delete cascade/, `${t.name} (${t.file}) does not cascade from dealerships`);
    assert.match(exportFn, new RegExp(`from public\\.${t.name} (\\w+)\\b[^;]{0,120}?where \\1\\.dealership_id = d\\.id`), `export_dealership leaves out ${t.name}`);
    assert.match(deleteFn, new RegExp(`'${t.name}', \\(select count\\(\\*\\) from public\\.${t.name} `), `delete_dealership does not count ${t.name}`);
  }
  // an unused invite's code stays out of the export
  assert.match(exportFn, /case when i\.used_at is null then \(to_jsonb\(i\) - 'code'\)/);
  // review 5 (G3): the notes do not claim less than the file holds: a former member's rows keep their name
  assert.doesNotMatch(exportFn, /appear only as a user_id/);
  assert.ok(exportFn.includes("People who are no longer members have no email here; the rows they made keep their user_id and the salesperson name they posted under, unless they asked to be forgotten."), 'the note on former members');
  assert.match(exportFn, /'billing_events', coalesce\(\(\s+select jsonb_agg\(to_jsonb\(e\)[^)]*\)\s+from public\.billing_events_of\(d\.id\) e\)/);
  assert.match(exportFn, /left join auth\.users u on u\.id = m\.user_id/, 'member emails');
  // a table that names a dealership without belonging to it: set null, not cascaded, and still exported
  for (const name of REFERS) {
    const t = TABLES.find((x) => x.name === name);
    assert.ok(t, `no migration creates ${name}: drop it from REFERS`);
    assert.match(t.columns, /dealership_id uuid[^,\n]*references public\.dealerships \(id\) on delete set null/, `${name} (${t.file}) keeps its row when the dealership goes`);
    assert.match(exportFn, new RegExp(`from public\\.${name} (\\w+)\\b[^;]{0,120}?where \\1\\.dealership_id = d\\.id`), `export_dealership leaves out ${name}`);
    assert.doesNotMatch(deleteFn, new RegExp(`'${name}'`), `delete_dealership does not count ${name} as removed: its rows stay`);
  }
  // the time and outcome of the sign-up, never which account made it
  const signup = exportFn.match(/'signup_attempts', coalesce\(\(([^]*?)\), '\[\]'::jsonb\)/);
  assert.ok(signup, 'the export has a signup_attempts list');
  assert.match(signup[1], /select jsonb_agg\(jsonb_build_object\('at', a\.at, 'outcome', a\.outcome\) order by a\.at, a\.id\)\s+from public\.signup_attempts a where a\.dealership_id = d\.id and a\.outcome = 'created'$/);
  assert.doesNotMatch(signup[1], /to_jsonb|user_id/, 'not the row as stored: which account signed up is the account\'s record');
  // every other table is named in the header with what happens to it
  const header = sql.slice(sql.indexOf('-- Tables without a dealership_id'), sql.indexOf('-- Error codes'));
  for (const t of TABLES.filter((x) => !OWNED.includes(x) && x.name !== 'dealerships')) {
    assert.match(header, new RegExp(`^--   ${t.name}\\b`, 'm'), `0006_privacy.sql's header does not say what happens to ${t.name}`);
  }
});

test('tests/privacy.sql checks the export, the API roles, both guards and that B is untouched, and rolls back', () => {
  for (const words of [
    'a signed-in manager exported their dealership', 'the service role exported a dealership', 'anon exported a dealership', '% may execute %',
    'the export of A contains', 'the export carries the code of an unused invite', 'rows are not in the export as stored',
    'forget_person accepted "%" as a-sales@example.test', 'forget_person removed the last manager of A', 'the auth row survived',
    'forgetting a_sales changed a row of B or of another person', 'delete_dealership accepted "%" for A', 'rows of A survived',
    'deleting A changed a row of B or of another person', 'A\'\'s billing events were deleted',
    'the export still lists a removed member, or their email', 'a removed member\'\'s rows lost their user_id or name',
    'the export\'\'s notes do not say that a former member\'\'s rows keep their name',
    'the export says which account signed A up', 'their sign-up attempt survived', 'a_mgr\'\'s sign-up attempt did not stay, without A',
  ]) {
    assert.ok(sqlTest.includes(words), `privacy.sql does not check: ${words}`);
  }
  assert.match(sqlTest, /^begin;$/m);
  assert.match(sqlTest, /^rollback;\n\n\\echo 'privacy\.sql: every check passed \(all changes rolled back\)'\n$/m);
});

test('supabase/README.md: the migration count, the psql recipe and the privacy section', () => {
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  assert.match(readme, new RegExp(`\`db push\` applies the ${WORDS[MIGRATIONS.length]} migrations in order`), `${MIGRATIONS.length} migrations`);
  const recipe = readme.slice(readme.indexOf('createdb lotsync_test'), readme.indexOf('```', readme.indexOf('createdb lotsync_test')));
  for (const f of MIGRATIONS) assert.ok(recipe.includes(`-f supabase/migrations/${f}`), `the plain-Postgres recipe does not apply ${f}`);
  for (const t of ['rls.sql', 'billing.sql', 'privacy.sql']) assert.ok(recipe.includes(`-f supabase/tests/${t}`), `the recipe does not run ${t}`);

  const heading = "## Export or delete a dealership's data";
  const start = readme.indexOf(heading);
  assert.ok(start >= 0, `supabase/README.md has no "${heading}" section`);
  const end = readme.indexOf('\n## ', start + heading.length);
  const section = readme.slice(start, end > 0 ? end : undefined);
  assert.match(section, /select jsonb_pretty\(public\.export_dealership\('<dealership id>'\)\);/);
  assert.match(section, /select public\.delete_dealership\('<dealership id>', 'https:\/\/www\.<the dealer website>'\);/);
  assert.match(section, /select public\.forget_person\('<user id>', '<their email>'\);/);
  assert.match(section, /In the Stripe Dashboard[^.]*delete the customer/, 'the Stripe customer is deleted by hand');
  assert.match(section, /Nothing in the database reaches Stripe/);
  for (const role of ['public', 'anon', 'authenticated', 'service_role']) assert.ok(section.includes(`\`${role}\``), `the section does not say ${role} cannot call them`);
  for (const code of ['P0007', 'P0006']) assert.ok(section.includes(code), `the section does not explain ${code}`);
  assert.match(section, /update public\.memberships set role = 'manager'/, 'what to do when they are the last manager');
  assert.match(section, /\*\*Clear everything for this website\*\* and \*\*Forget my synced profile\*\*/, 'the browser half, as the popup labels it');
});

test('the policy\'s promise has its tools, and the README and support.md keep the policy\'s one number of days', () => {
  assert.match(policy, /Customers can ask us to export or delete their dealership's records\./);
  assert.match(policy, /rights of access, correction, deletion and portability/);
  const days = policy.match(/deleted within (\d+) days of the subscription ending/);
  assert.ok(days, 'the policy\'s retention line moved: update this test');
  const n = days[1];
  const section = (text, heading) => {
    const s = text.indexOf(heading);
    assert.ok(s >= 0, `no "${heading}"`);
    const e = text.indexOf('\n## ', s + heading.length);
    return text.slice(s, e > 0 ? e : undefined);
  };
  const readmeSection = section(readme, "## Export or delete a dealership's data");
  const supportSection = section(support, '## Privacy requests');
  for (const [name, text] of [['supabase/README.md', readmeSection], ['docs/support.md', supportSection]]) {
    assert.match(text, new RegExp(`\\b${n} days\\b`), `${name} does not give the policy's ${n} days`);
    for (const m of text.matchAll(/\b(\d+)[- ]days?\b/g)) assert.equal(m[1], n, `${name} gives ${m[0]}, not the policy's ${n} days`);
  }
});

test('docs/support.md: the three request types, who may ask for each and how it is verified', () => {
  const s = support.slice(support.indexOf('## Privacy requests'));
  assert.ok(support.includes('## Privacy requests'), 'support.md has no Privacy requests section');
  const rows = s.split('\n').filter((l) => l.startsWith('| **'));
  const byType = Object.fromEntries(rows.map((l) => [l.match(/^\| \*\*([^*]+)\*\*/)[1], l]));
  assert.deepEqual(Object.keys(byType), ['Export a dealership\'s records', 'Delete a dealership', 'Forget a person']);
  assert.match(byType['Export a dealership\'s records'], /\| A manager of that dealership \|/);
  assert.match(byType['Delete a dealership'], /\| A manager of that dealership \|/);
  assert.match(byType['Forget a person'], /\| The person themself \|/);
  assert.match(byType['Export a dealership\'s records'], /manager membership of that dealership/, 'verified against the membership');
  assert.match(byType['Delete a dealership'], /phone call/, 'a delete is confirmed by phone');
  assert.match(byType['Forget a person'], /email of their own Lot Current account/);
  for (const fn of ['export_dealership', 'delete_dealership', 'forget_person']) {
    assert.match(byType[{ export_dealership: 'Export a dealership\'s records', delete_dealership: 'Delete a dealership', forget_person: 'Forget a person' }[fn]], new RegExp('`' + escapeRe(fn) + '`'), `the row does not name ${fn}`);
  }
  assert.match(s, /`supabase\/README\.md`, "Export or delete a dealership's data"/, 'points at the SQL');
  assert.match(support, /Never send a dealership's export to anyone but the verified manager who asked/);
});

// round H review: the policy lists sign-up attempts as a person's account data, and the copy left them out
test('docs/support.md: the copy of a person\'s own data reads every table that carries a user_id', () => {
  const start = support.indexOf('A person asking for a copy of their own data');
  assert.ok(start >= 0, 'support.md has no recipe for a copy of a person\'s own data');
  const open = support.indexOf('```sql', start);
  assert.ok(open > start, 'the recipe has no SQL block');
  const recipe = support.slice(open, support.indexOf('```\n', open + '```sql'.length));
  const withUser = TABLES.filter((t) => /^\s*user_id uuid\b/m.test(t.columns));
  assert.ok(withUser.length >= 6, withUser.map((t) => t.name).join(', '));
  for (const t of withUser) {
    assert.match(recipe, new RegExp(`\\bfrom public\\.${t.name}\\b[^;]*\\bwhere (\\w+\\.)?user_id = '<user id>'`), `the copy leaves out ${t.name} (${t.file})`);
  }
  assert.match(recipe, /from public\.invites i\b[^;]*where '<user id>' in \(i\.created_by, i\.used_by\)/, 'the codes they made or used');
  assert.match(recipe, /from auth\.users where id = '<user id>'/, 'their account');
  assert.match(support, /it leaves out their invite misses, sign-up attempts and demo requests/, 'what export_dealership leaves out');
});

// review: the attorney was told forget_person keeps "two things", and the README called every colleague's
// copy out of reach, while the rows kept under the bare id were more and a colleague's sync can drop the name
test('what forget_person keeps is put to the attorney in full, and a colleague\'s copy loses the name at its next sync', () => {
  const questions = read('../legal/questions-for-attorney.md');
  const item = questions.split('\n').find((l) => l.startsWith('- `forget_person`'));
  assert.ok(item, 'questions-for-attorney.md asks about forget_person');
  for (const kept of ['listing and post-attempt rows', 'the invite codes they used or made that were used', 'description-writer usage rows', 'the listing link on their listings still marked up', 'the Stripe webhook events']) {
    assert.ok(item.includes(kept), `the attorney is not told forget_person keeps ${kept}`);
  }
  assert.doesNotMatch(item, /keeps two things/);
  const colleague = "A colleague's extension drops the person's name from a car still listed at its next sync";
  for (const [name, text] of [['questions-for-attorney.md', item], ['supabase/README.md', readme]]) assert.ok(text.includes(colleague), `${name} says what a colleague's copy does`);
  assert.match(support, /a colleague's extension drops the name from a car still listed at its next sync/);
  assert.doesNotMatch(readme, /Copies the dealership already holds \(colleagues' extensions/, 'a colleague\'s synced copy is no longer out of reach');
});

// review: the pilot agreement promises deletion within 30 days of a pilot's end, but a dealership the owner
// made in SQL sat in `none` (served with no end, never on the retention line) and a pilot ended early on
// notice was listed only from its original end date
test('every pilot reaches the retention line: its clock starts when the owner makes the dealership, an early end is recorded, and dealerships with no plan are listed', () => {
  const step5 = readme.slice(readme.indexOf('5. **The first dealership and its manager**'), readme.indexOf('Invite codes and the rules around them'));
  assert.match(step5, /insert into public\.subscriptions \(dealership_id, status, pilot_ends_at\)\s+values \('<the id returned above>', 'pilot', '<the agreement''s start date, YYYY-MM-DD>'::date \+ <its pilot length in days>\);/, 'step 5 starts the pilot clock from the signed agreement');
  assert.doesNotMatch(step5, /start_pilot\(/, 'not start_pilot: the SQL editor has no auth.uid(), and start_pilot refuses without a manager');
  const retention = readme.slice(readme.indexOf('**The retention line.**'), readme.indexOf('### Forget a person'));
  assert.match(retention, /coalesce\(s\.status, 'pilot'\) in \('pilot', 'canceled', 'incomplete_expired'\)/, 'an ended pilot is on the retention line');
  const early = retention.slice(retention.indexOf('**A pilot ended early.**'));
  assert.ok(early.length > 0, 'the README says how to record a pilot ended early');
  assert.match(early, /values \('<dealership id>', 'pilot', now\(\)\)\non conflict \(dealership_id\) do update\n {2}set status = 'pilot', pilot_ends_at = excluded\.pilot_ends_at, updated_at = now\(\)\n {2}where s\.status is null or \(s\.status = 'pilot' and s\.pilot_ends_at > excluded\.pilot_ends_at\);/, 'it ends a pilot, or a dealership with no plan, and leaves a paying one alone');
  assert.match(early, /\*\*Dealerships with no plan\.\*\*[\s\S]*where public\.subscription_state\(d\.id\) = 'none'/, 'the weekly run lists the dealerships served with no end');
  const pilot = read('../PILOT.md');
  assert.match(pilot, /its pilot row with the signed agreement's start date and length/, 'PILOT.md\'s account step starts the clock');
  assert.match(pilot, /record the end in the database that day \(`supabase\/README\.md`, "A pilot ended early"\)/, 'PILOT.md records a stop or an early end');
  assert.match(pilot, /those records are the CSVs the owner collected and, for a dealership on accounts, its rows in the database/, 'the database rows are pilot records too');
  assert.match(read('../docs/launch-checklist.md'), /an early end recorded the day the notice comes/);
});
