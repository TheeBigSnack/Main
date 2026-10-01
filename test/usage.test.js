// The owner's usage report (supabase/migrations/0008_usage.sql), held to
// the rules a Node test can read off its source: no API role may execute
// it, it runs as its caller with a pinned search_path and writes nothing,
// its plan is subscription_state()'s own, and its columns are facts from
// existing tables, the ones supabase/README.md ("Usage report") and
// docs/launch-checklist.md name. Nothing here runs SQL;
// supabase/tests/usage.sql proves the behaviour against a database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sql = read('../supabase/migrations/0008_usage.sql');
const sqlTest = read('../supabase/tests/usage.sql');
const readme = read('../supabase/README.md');
const checklist = read('../docs/launch-checklist.md');
const code = sql.replace(/--.*$/gm, '');

const SIGNATURE = 'public.usage_report(timestamptz)';
const API_ROLES = 'public, anon, authenticated, service_role';
// The report's columns in order. A rename breaks the owner's weekly sheet
// and the two documents that explain the columns, so it is a change to make
// in all three on purpose.
const COLUMNS = [
  'dealership_id', 'name', 'website_origin', 'created_at',
  'plan_state', 'pilot_ends_at', 'current_period_end',
  'managers', 'salespeople', 'active_salespeople', 'posts', 'cars_listed_now',
  'open_take_downs', 'open_price_changes', 'oldest_open_hours',
  'last_synced_scan_at', 'rewrite_calls',
];

const body = (() => {
  const start = sql.indexOf('create or replace function public.usage_report(');
  const end = sql.indexOf(`comment on function ${SIGNATURE} is `, start);
  assert.ok(start >= 0 && end > start, '0008_usage.sql has no usage_report() with a comment after it');
  return sql.slice(start, end);
})();
const returned = (() => {
  const m = body.match(/\nreturns table \(\n([^]*?)\n\)\n/);
  assert.ok(m, 'usage_report returns a table');
  return m[1].split(',\n').map((l) => l.trim().split(/\s+/));
})();
const section = (text, heading) => {
  const s = text.indexOf(heading);
  if (s < 0) return null;
  const e = text.indexOf('\n## ', s + heading.length);
  return text.slice(s, e > 0 ? e : undefined);
};

test('0008_usage.sql creates usage_report(since) and nothing else, and no API role may execute it', () => {
  assert.deepEqual([...code.matchAll(/\bcreate (?:or replace )?(\w+(?: \w+)?) ([\w.]+)/g)].map((m) => `${m[1]} ${m[2]}`), ['function public.usage_report'],
    'one function, and no table, view or trigger: the report reads what the schema already keeps');
  assert.match(body, /^create or replace function public\.usage_report\(since timestamptz default now\(\) - interval '7 days'\)\n/, 'the past 7 days by default');
  assert.ok(sql.includes(`revoke execute on function ${SIGNATURE} from ${API_ROLES};`), `execute is not revoked from ${API_ROLES}`);
  assert.doesNotMatch(code, /^\s*grant\b/im, 'nothing is granted to anyone');
  assert.match(body, /\nlanguage sql stable security invoker\nset search_path = ''\nas \$\$\n/, 'runs as its caller, stable, with a pinned search_path');
  assert.doesNotMatch(code, /security definer/i, 'never with its owner\'s rights');
  assert.doesNotMatch(body.replace(/--.*$/gm, ''), /\b(insert into|update public\.|delete from|truncate)\b/i, 'it writes nothing');
  assert.match(sql, new RegExp(`comment on function ${SIGNATURE.replace(/[.()]/g, '\\$&')} is 'Owner only\\.`), 'its comment says who may run it');
});

test('the columns are the ones this test names, in order, each a count, a time or a value read from a table', () => {
  assert.deepEqual(returned.map(([name]) => name), COLUMNS);
  const types = Object.fromEntries(returned);
  for (const c of ['managers', 'salespeople', 'active_salespeople', 'posts', 'cars_listed_now', 'open_take_downs', 'open_price_changes', 'rewrite_calls']) {
    assert.equal(types[c], 'integer', `${c} is a count`);
  }
  assert.doesNotMatch(COLUMNS.join(' '), /score|rate|ratio|percent|share|health|rank/i, 'no derived metric');
  // each column is explained in the comment above the function
  const doc = sql.slice(sql.indexOf('-- usage_report(since)'), sql.indexOf('create or replace function public.usage_report('));
  for (const c of COLUMNS) assert.ok(doc.includes(c), `the comment above usage_report does not explain ${c}`);
});

test('the plan state is subscription_state()\'s rule, called rather than copied', () => {
  assert.match(body, /public\.subscription_state\(d\.id\) as plan_state,/);
  assert.doesNotMatch(body.replace(/--.*$/gm, ''), /'(trialing|active|lapsed|pilot|none)'/, 'no second copy of the rule to drift from 0004_billing.sql');
  assert.match(body, /left join public\.subscriptions s on s\.dealership_id = d\.id/, 'a dealership with no subscriptions row still has its row');
});

test('the window starts at since, included, has no end, and a null since counts everything', () => {
  assert.match(body, /coalesce\(usage_report\.since, '-infinity'::timestamptz\) as since/);
  const windowed = [...body.matchAll(/(\w+\.\w+) >= w\.since/g)].map((m) => m[1]);
  assert.deepEqual(windowed, ['l.posted_at', 'l.posted_at', 'u.at'], 'active salespeople and posts by posted_at, rewrite calls by at');
  // the one comparison with now() is last_synced_scan_at's clock guard (checked below), not a window's end
  const guard = "x.taken_at <= now() + interval '5 minutes'";
  assert.equal(body.split(guard).length, 2, 'the scan clock guard appears once');
  assert.doesNotMatch(body.replace(/--.*$/gm, '').replace(guard, ''), /[<>]=? ?now\(\)|\bw\.since\b[^\n]*<|>\s*w\.since/, 'no upper end and no strict edge');
  assert.match(body, /\n {2}order by r\.active_salespeople desc, r\.name, r\.dealership_id;\n/, 'the busiest first, then by name');
});

test('active_salespeople counts current members with the salesperson role; the rest count the dealership\'s own rows', () => {
  const active = body.match(/\(select count\(distinct l\.user_id\)([^]*?)\)::integer as active_salespeople/);
  assert.ok(active, 'active_salespeople counts distinct people');
  assert.match(active[1], /join public\.memberships m on m\.dealership_id = l\.dealership_id and m\.user_id = l\.user_id and m\.role = 'salesperson'/);
  assert.match(active[1], /where l\.dealership_id = d\.id and l\.posted_at >= w\.since$/);
  // every subquery is tied to the row's dealership
  const subqueries = [...body.matchAll(/\(select [^]*? from public\.(\w+) (\w+)\b([^]*?)\)(?:::integer)? as (\w+)/g)];
  assert.equal(subqueries.length, 10, subqueries.map((m) => m[4]).join(', '));
  for (const [, table, alias, rest, column] of subqueries) {
    assert.match(rest, new RegExp(`where ${alias}\\.dealership_id = d\\.id\\b`), `${column} (from ${table}) is not limited to the row's dealership`);
  }
  assert.match(body, /count\(distinct l\.vin\) from public\.listings l where l\.dealership_id = d\.id and l\.status = 'listed'\)::integer as cars_listed_now/, 'cars, not listing rows');
  assert.match(body, /t\.done_at is null and t\.kind = 'takeDown'\)::integer as open_take_downs/);
  assert.match(body, /t\.done_at is null and t\.kind = 'price'\)::integer as open_price_changes/);
  assert.match(body, /max\(x\.taken_at\) from public\.scan_summaries x where x\.dealership_id = d\.id and x\.taken_at <= now\(\) \+ interval '5 minutes'\) as last_synced_scan_at/, 'the newest scan, leaving out one stamped more than 5 minutes ahead (the margin /sync gives)');
  assert.match(body, /u\.kind = 'rewrite' and u\.at >= w\.since\)::integer as rewrite_calls/, 'description writer calls, not color guesses');
});

test('tests/usage.sql checks both dealerships, the edges, the zeros and every API role, and rolls back', () => {
  for (const words of [
    '% may execute usage_report', 'usage_report is not security invoker with an empty search_path',
    'the past 7 days', 'usage_report() is not usage_report(now() - interval \'\'7 days\'\')',
    'since a microsecond before the 7 days', 'since exactly a post', 'since a microsecond after a post', 'a null since',
    '% says % where subscription_state() says %', 'a dealership with no activity has no row', 'a dealership with no activity does not read zeros',
    'a signed-in manager ran the usage report', 'anon ran the usage report', 'the service role ran the usage report',
    'a scan stamped just over 5 minutes ahead is the last synced scan: %', 'a scan stamped 5 minutes ahead (ordinary drift) is not the last synced scan: %',
  ]) {
    assert.ok(sqlTest.includes(words), `usage.sql does not check: ${words}`);
  }
  assert.equal((sqlTest.match(/if sqlerrm not like '%usage_report%' then raise; end if;/g) || []).length, 3, 'each API role is refused by the function, not by a table');
  assert.match(sqlTest, /^begin;$/m);
  assert.match(sqlTest, /^rollback;\n\n\\echo 'usage\.sql: every check passed \(all changes rolled back\)'\n$/m);
});

test('supabase/README.md lists the files and runs the test in its plain-Postgres recipe', () => {
  assert.match(readme, /^\| `migrations\/0008_usage\.sql` \| [^\n]*`usage_report\(since\)`[^\n]*"Usage report"/m);
  assert.match(readme, /^\| `tests\/usage\.sql` \| /m);
  const recipe = readme.slice(readme.indexOf('createdb lotsync_test'), readme.indexOf('```', readme.indexOf('createdb lotsync_test')));
  assert.ok(recipe.indexOf('-f supabase/migrations/0008_usage.sql') > recipe.indexOf('-f supabase/migrations/0007_signup.sql'), 'the recipe applies 0008 after 0007');
  assert.ok(recipe.includes('-f supabase/tests/usage.sql'), 'the recipe runs tests/usage.sql');
});

test('supabase/README.md, "Usage report": the three calls, who cannot call it, and every column', () => {
  const s = section(readme, '## Usage report');
  assert.ok(s, 'supabase/README.md has no "Usage report" section');
  for (const line of [
    'select * from public.usage_report();',
    "select * from public.usage_report(now() - interval '30 days');",
    'select * from public.usage_report(null);',
  ]) assert.ok(s.includes(line), `the section does not show ${line}`);
  for (const role of ['public', 'anon', 'authenticated', 'service_role']) assert.ok(s.includes(`\`${role}\``), `the section does not say ${role} cannot call it`);
  assert.match(s, /`SECURITY INVOKER`/);
  // the column table: its first cells name every column once, and nothing else
  const named = s.split('\n').filter((l) => /^\| `/.test(l)).flatMap((l) => [...l.split(' | ')[0].matchAll(/`(\w+)`/g)].map((m) => m[1]));
  const columnRows = named.filter((n) => !/^(migrations|tests|test)$/.test(n));
  assert.deepEqual([...columnRows].sort(), [...COLUMNS].sort(), 'the column table names every column once, and only columns');
  assert.match(s, /A manager who posts is counted in `posts`, not here/, 'what active_salespeople leaves out');
  assert.match(s, /`scan_summaries\.taken_at`/, 'which timestamp stands for the last sync');
  assert.match(s, /The database keeps no log of syncs/, 'and why');
  assert.match(s, /Nothing in the database records a manager opening the manager view/, 'what it cannot say');
});

test('docs/launch-checklist.md: the weekly run with its SQL line, and what two active salespeople means in the columns', () => {
  const partners = section(checklist, '## Design partners');
  assert.ok(partners, 'the checklist has a Design partners group');
  const items = partners.split('\n').filter((l) => /^- \[ \]/.test(l));
  const weekly = items.find((l) => l.includes('**Run usage_report weekly and keep the partner list.**'));
  assert.ok(weekly, 'the M6 items include the weekly run');
  assert.match(weekly, /Done when: `select \* from public\.usage_report\(\);` is run once a week/);
  assert.match(weekly, /pipeline sheet/, 'where the partner list is kept');
  const active = items.find((l) => l.includes('**Each partner is active.**'));
  assert.ok(active, 'the Each partner is active item');
  assert.match(active, /`active_salespeople` of 2 or more and `managers` of 1 or more/);
  assert.match(active, /a manager who posts is counted in `posts`, not there/);
  assert.match(active, /The database records nothing when a manager opens the manager view/);
  // every column the two items name is a real one
  for (const item of [weekly, active]) {
    for (const m of item.matchAll(/`([a-z_]+)`/g)) assert.ok(COLUMNS.includes(m[1]), `the checklist names \`${m[1]}\`, which is not a column of usage_report`);
  }
  // the same weekly line as the migration's header
  assert.ok(sql.includes('--   select * from public.usage_report();'), 'the migration shows the weekly line');
});
