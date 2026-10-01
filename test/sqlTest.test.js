// scripts/sql-test.mjs: the shim first, then the migrations in number order,
// then every test file but the shim, each of which must leave the database
// as it found it; concurrency.sql (real sessions through dblink) commits,
// cleans up after itself and sets sign-up's switch back; and CI runs it all
// on Postgres 16.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { plan, FINGERPRINT, changed } from '../scripts/sql-test.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the SQL plan: shim, migrations in order, every test file but the shim', () => {
  const p = plan(['0002_rls.sql', '0001_schema.sql', 'notes.md', '0010_later.sql'], ['rls.sql', 'local-shim.sql', 'billing.sql', 'port-check.mjs']);
  assert.deepEqual(p.setup.map((f) => f.split('/').pop()), ['local-shim.sql', '0001_schema.sql', '0002_rls.sql', '0010_later.sql']);
  assert.deepEqual(p.tests.map((f) => f.split('/').pop()), ['billing.sql', 'rls.sql']);
  // the real folders: every migration and every test file is picked up
  const real = plan(readdirSync(new URL('../supabase/migrations', import.meta.url)), readdirSync(new URL('../supabase/tests', import.meta.url)));
  assert.ok(real.setup.length >= 6, 'the shim and at least five migrations');
  assert.ok(real.tests.some((f) => f.endsWith('rls.sql')) && real.tests.some((f) => f.endsWith('billing.sql')));
  assert.ok(real.tests.some((f) => f.endsWith('/concurrency.sql')), 'the two-session keep_a_manager check runs too');
});

test('after each test file the script compares the database with how it was: every table\'s rows, the extensions, the schemas', () => {
  assert.match(FINGERPRINT, /from pg_tables t where t\.schemaname in \('public', 'auth'\)/);
  assert.match(FINGERPRINT, /select count\(\*\) as n from %I\.%I/);
  assert.match(FINGERPRINT, /from pg_extension e/);
  assert.match(FINGERPRINT, /from pg_namespace n where n\.nspname !~ '\^pg_\(toast_\)\?temp_'/);
  assert.deepEqual(changed('public.dealerships 0\nextensions plpgsql', 'public.dealerships 0\nextensions plpgsql'), []);
  assert.deepEqual(changed('public.dealerships 0\nextensions plpgsql', 'public.dealerships 1\nextensions dblink plpgsql'),
    ['- public.dealerships 0', '- extensions plpgsql', '+ public.dealerships 1', '+ extensions dblink plpgsql']);
  const script = read('../scripts/sql-test.mjs');
  assert.match(script, /if \(r\.status === 0 && left\.length === 0\) console\.log/, 'a file passes only when psql succeeded and nothing was left behind');
});

// review 5 (G1): keep_a_manager proved with two sessions at once, which one rolled-back transaction cannot do
test('tests/concurrency.sql: two dblink sessions, the second waits for the first and gets P0006, and every row it made is removed, pass or fail', () => {
  const sql = read('../supabase/tests/concurrency.sql');
  assert.match(sql, /^\\if :install_dblink\ncreate schema concurrency_dblink;\ncreate extension if not exists dblink with schema concurrency_dblink;\n\\endif$/m, 'dblink, never in public');
  assert.match(sql, /^\\if :install_dblink\ndrop extension dblink;\ndrop schema concurrency_dblink;\n\\endif$/m, 'and dropped again when this file installed it');
  assert.doesNotMatch(sql, /^begin;$/m, 'no enclosing transaction: the sessions must see each other\'s commits');
  const flow = [
    "perform dblink_connect('lotsync_s1', conn);",
    "perform dblink_connect('lotsync_s2', conn);",
    "perform dblink_exec('lotsync_s1', 'begin');",
    "perform dblink_exec('lotsync_s1', 'set local role authenticated');",
    "format('update public.memberships set role = %L where user_id = %L and dealership_id = %L', 'salesperson', m1, d)",
    "perform dblink_exec('lotsync_s2', 'begin');",
    "perform dblink_exec('lotsync_s2', 'set local role authenticated');",
    "dblink_send_query('lotsync_s2', format('delete from public.memberships where user_id = %L and dealership_id = %L', m2, d))",
    'if pid1 = any(pg_blocking_pids(pid2)) then',
    "perform dblink_exec('lotsync_s1', 'commit');",
    "from dblink_get_result('lotsync_s2')",
    "if answer is distinct from 'P0006' then",
    "exception when others then\n  perform set_config('lotsync.concurrency_failure', sqlerrm, false);",
    "perform dblink_disconnect(c);",
    "delete from public.dealerships where id = :'dealer';",
    "delete from auth.users where id in (:'m1', :'m2', :'p', :'r');",
    'drop extension dblink;',
    "raise exception 'concurrency.sql left rows behind';",
    "raise exception '%', current_setting('lotsync.concurrency_failure');",
    "\\echo 'concurrency.sql: every check passed",
  ];
  let at = -1;
  for (const step of flow) {
    const next = sql.indexOf(step, at + 1);
    assert.ok(next > at, `concurrency.sql: "${step}" is missing or out of order`);
    at = next;
  }
  for (const words of ['two managers acting at once left the dealership with no manager', 'session 2 did not wait for session 1']) {
    assert.ok(sql.includes(words), `concurrency.sql checks: ${words}`);
  }
});

// round H review: create_dealership counted its hourly throttle before the settings row's lock, so calls from
// one account sent together all passed it and each looked up a website
test('tests/concurrency.sql: more than five sign-up calls from one account queue behind the settings row\'s lock, and only five look up a website', () => {
  const sql = read('../supabase/tests/concurrency.sql');
  const calls = Number((sql.match(/^  calls constant integer := (\d+);$/m) || [])[1]);
  assert.ok(calls > 5, 'more calls than the throttle allows in an hour');
  const flow = [
    'select open as signup_was_open from public.signup_settings where id \\gset',
    'update public.signup_settings set open = true;',
    "perform dblink_connect('lotsync_hold', conn);",
    "perform dblink_exec('lotsync_hold', 'begin');",
    "perform * from dblink('lotsync_hold', 'select 1 from public.signup_settings s where s.id for update') as t(one integer);",
    'for i in 1..calls loop',
    "json_build_object('sub', p, 'role', 'authenticated')",
    "perform dblink_exec('lotsync_t' || i, 'set role authenticated');",
    "dblink_send_query('lotsync_t' || i, format('select public.create_dealership(%L, %L, %L)::text', 'Probe Motors ' || i, 'www.dealership-c.test', 'Quinn'))",
    'select count(*) into waiting from unnest(pids) x where cardinality(pg_blocking_pids(x)) > 0;',
    "perform dblink_exec('lotsync_hold', 'commit');",
    "from dblink_get_result('lotsync_t' || i)",
    'select count(*) into attempts from public.signup_attempts a where a.user_id = p;',
    'if waiting <> calls then',
    'if attempts > 5 then',
    `if answers is distinct from array[${[...Array(calls - 5).fill("'P0005'"), ...Array(5).fill("'P0009'")].join(', ')}] or attempts <> 5 then`,
    "perform set_config('lotsync.concurrency_failure', concat_ws(E'\\n', nullif(current_setting('lotsync.concurrency_failure'), ''), sqlerrm), false);",
    "if c like 'lotsync\\_%' then",
    "if dblink_is_busy(c) = 1 then perform dblink_cancel_query(c); end if;",
    "delete from auth.users where id in (:'m1', :'m2', :'p', :'r');",
    "update public.signup_settings set open = :'signup_was_open';",
    "or exists (select 1 from public.signup_attempts where user_id = '00000000-0000-4000-8000-000000cc00a3')",
    "raise exception 'concurrency.sql left rows behind';",
  ];
  let at = -1;
  for (const step of flow) {
    const next = sql.indexOf(step, at + 1);
    assert.ok(next > at, `concurrency.sql: "${step}" is missing or out of order`);
    at = next;
  }
  assert.ok(sql.includes('the throttle is not counted under the lock'), 'the failure names the cause');
});

// review (B1a-db-r1-4's fix): redeem_invite counted an account's misses with no lock, so wrong codes sent
// together each passed the count before any miss was committed, and all were looked up
test('tests/concurrency.sql: invite codes one account sends together take turns at the throttle, and none is looked up past 10 misses', () => {
  const sql = read('../supabase/tests/concurrency.sql');
  const flow = [
    "insert into public.invite_misses (user_id, at) select :'r', now() - interval '5 minutes' from generate_series(1, 9);",
    "perform dblink_connect('lotsync_rhold', conn);",
    "perform dblink_exec('lotsync_rhold', 'begin');",
    "select public.redeem_invite(''WRONGCODE000'', null) ->> ''code''",
    'for i in 1..calls loop',
    "perform dblink_exec('lotsync_r' || i, 'set role authenticated');",
    "dblink_send_query('lotsync_r' || i, format('select public.redeem_invite(%L, null)::text', 'WRONGCODE00' || i))",
    'select count(*) into waiting from unnest(pids) x where cardinality(pg_blocking_pids(x)) > 0;',
    "perform dblink_exec('lotsync_rhold', 'commit');",
    "from dblink_get_result('lotsync_r' || i)",
    'select count(*) into misses from public.invite_misses m where m.user_id = r;',
    'if misses > 10 then',
    'if waiting <> calls then',
    "if answers is distinct from array['P0005', 'P0005', 'P0005'] or misses <> 10 then",
    "delete from public.invite_misses where user_id = :'r';",
    "or exists (select 1 from public.invite_misses where user_id = '00000000-0000-4000-8000-000000cc00a4')",
    "raise exception 'concurrency.sql left rows behind';",
  ];
  let at = -1;
  for (const step of flow) {
    const next = sql.indexOf(step, at + 1);
    assert.ok(next > at, `concurrency.sql: "${step}" is missing or out of order`);
    at = next;
  }
  // and the function takes the account's lock before it counts
  const rls = read('../supabase/migrations/0002_rls.sql');
  const redeem = rls.slice(rls.indexOf('create or replace function public.redeem_invite'), rls.indexOf('comment on function public.redeem_invite'));
  const lock = redeem.indexOf("perform pg_advisory_xact_lock(hashtext('redeem_invite'), hashtext(uid::text));");
  assert.ok(lock > 0 && lock < redeem.indexOf('select count(*) into misses'), 'redeem_invite locks the account before counting its misses');
});

test('CI runs the SQL checks on a Postgres 16 service container', () => {
  const ci = read('../.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('  sql:'), ci.indexOf('  pack:'));
  assert.match(job, /image: postgres:16/);
  assert.match(job, /run: node scripts\/sql-test\.mjs/);
  assert.match(job, /PGHOST: 127\.0\.0\.1/);
});
