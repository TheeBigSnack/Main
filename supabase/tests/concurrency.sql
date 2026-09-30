-- Lot Sync: two rules that only a test with sessions acting at the same
-- moment can prove, each with real sessions through dblink:
--
--   keep_a_manager (0002_rls.sql)       two managers acting at once cannot leave a dealership with none
--   create_dealership (0007_signup.sql)  calls from one account sent together get 5 lookups an hour, no more
--
-- keep_a_manager. rls.sql proves the rule inside one session: the last
-- manager can neither step down nor leave. One session cannot prove it
-- holds when two managers act at once. Under READ COMMITTED a transaction
-- sees another's change only once that one commits, so if manager m1 steps
-- down while manager m2 leaves, each check still sees the other as a
-- manager. Without a lock both would pass and the dealership would be left
-- with no manager. keep_a_manager locks the dealership row before it looks,
-- so the second change waits for the first, then sees it, and is refused
-- with P0006.
--
-- Two real sessions through dblink (contrib: in the postgres:16 image CI
-- uses and in every Postgres package), each connected back to this database
-- as the same user over the server's own unix socket:
--
--   session 1  signed in as m1: begin; m1 steps down to salesperson; the transaction stays open
--   session 2  signed in as m2: begin; m2 leaves (deletes their membership), sent without waiting for the answer
--   check      session 2 is waiting for session 1
--   session 1  commit
--   check      session 2 was refused with P0006, and the dealership still has a manager (m2)
--
-- The sign-up throttle. create_dealership() counts the caller's attempts in
-- the past hour before it takes the signup_settings row's lock, so calls
-- from one account sent together all pass that count before any of them
-- has written its attempt. They then queue for the lock, and unless the
-- count is made again under it, each one looks up its website: one burst
-- would tell a stranger whether many websites are Lot Sync customers, not
-- 5 an hour. Here the owner's session holds the lock, standing in for a
-- sign-up in progress, while seven sessions signed in as one account (p)
-- ask for Dealership C's website, which is taken:
--
--   hold       the owner: begin; locks the signup_settings row; the transaction stays open
--   t1 .. t7   signed in as p: create_dealership for C's website, each call its own transaction as an API request is, sent without waiting
--   check      all seven are waiting for the lock
--   hold       commit
--   check      five were answered P0009 and two P0005, and p has five attempts, not seven
--
-- Unlike the other test files, this one cannot run inside one rolled-back
-- transaction, because the sessions only see each other's committed rows.
-- So the fixture is committed, and sign-up is opened for the second case.
-- The end of the file removes every row the test made, pass or fail, sets
-- sign-up's switch back to what it was and drops dblink again when this
-- file installed it. A failed check is raised only after that clean-up. It
-- first removes rows an interrupted earlier run may have left under the
-- same ids.
-- Only for a throwaway database (scripts/sql-test.mjs, CI): dblink_connect
-- without a password needs a superuser, and the ids below must be this
-- file's alone.
--
--   user  dealership  role
--   m1    C           manager
--   m2    C           manager
--   p     (none)      signs up with C's website seven times at once

\set ON_ERROR_STOP on
\set m1      '00000000-0000-4000-8000-000000cc00a1'
\set m2      '00000000-0000-4000-8000-000000cc00a2'
\set p       '00000000-0000-4000-8000-000000cc00a3'
\set dealer  '00000000-0000-4000-8000-000000cc00d1'

-- dblink, in a schema of its own when this file installs it (never in public, where the
-- default privileges would hand its functions to the API roles), and dropped at the end
select not exists (select 1 from pg_extension where extname = 'dblink') as install_dblink \gset
\if :install_dblink
create schema concurrency_dblink;
create extension if not exists dblink with schema concurrency_dblink;
\endif
select n.nspname as dblink_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'dblink' \gset
set search_path = :"dblink_schema", public;

-- libpq conninfo for this database over the server's own unix socket, as
-- the same user: values in single quotes, backslash-escaped
create function pg_temp.conninfo() returns text
language plpgsql as $$
declare
  socket text := trim(split_part(current_setting('unix_socket_directories'), ',', 1));
begin
  if socket = '' then
    raise exception 'this server listens on no unix socket, so dblink cannot connect back to it';
  end if;
  return format('host=''%s'' port=%s dbname=''%s'' user=''%s''',
                replace(replace(socket, '\', '\\'), '''', '\'''), current_setting('port'),
                replace(replace(current_database(), '\', '\\'), '''', '\'''),
                replace(replace(current_user, '\', '\\'), '''', '\'''));
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner, committed): dealership C with two managers; p, who
-- belongs nowhere; sign-up open, its switch kept to be set back at the end
-- ---------------------------------------------------------------------------
delete from public.dealerships where id = :'dealer';
delete from auth.users where id in (:'m1', :'m2', :'p');

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'m1', 'authenticated', 'authenticated', 'm1@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'m2', 'authenticated', 'authenticated', 'm2@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p',  'authenticated', 'authenticated', 'p@example.test',  now(), now());
insert into public.dealerships (id, name, website_origin) values
  (:'dealer', 'Dealership C', 'https://www.dealership-c.test');
insert into public.memberships (user_id, dealership_id, role, name) values
  (:'m1', :'dealer', 'manager', 'Morgan'),
  (:'m2', :'dealer', 'manager', 'Drew');

select open as signup_was_open from public.signup_settings where id \gset
update public.signup_settings set open = true;

-- ---------------------------------------------------------------------------
-- keep_a_manager: the two sessions. Nothing here raises: a failed check is
-- kept in lotsync.concurrency_failure and raised after the clean-up below.
-- ---------------------------------------------------------------------------
select set_config('lotsync.concurrency_failure', '', false) as reset_failure \gset

do $$
declare
  m1 uuid := '00000000-0000-4000-8000-000000cc00a1';
  m2 uuid := '00000000-0000-4000-8000-000000cc00a2';
  d uuid := '00000000-0000-4000-8000-000000cc00d1';
  conn text;
  pid1 integer;
  pid2 integer;
  waited boolean := false;
  answer text;
  members text;
begin
  conn := pg_temp.conninfo();
  perform dblink_connect('lotsync_s1', conn);
  perform dblink_connect('lotsync_s2', conn);
  select p into pid1 from dblink('lotsync_s1', 'select pg_backend_pid()') as t(p integer);
  select p into pid2 from dblink('lotsync_s2', 'select pg_backend_pid()') as t(p integer);

  -- session 1: m1 signed in the way PostgREST signs a request in, steps down; the transaction stays open
  perform dblink_exec('lotsync_s1', 'begin');
  perform dblink_exec('lotsync_s1', format('set local request.jwt.claims = %L', json_build_object('sub', m1, 'role', 'authenticated')::text));
  perform dblink_exec('lotsync_s1', 'set local role authenticated');
  answer := dblink_exec('lotsync_s1', format('update public.memberships set role = %L where user_id = %L and dealership_id = %L', 'salesperson', m1, d));
  if answer <> 'UPDATE 1' then
    raise exception 'session 1: m1 could not step down while m2 is still a manager (%)', answer;
  end if;

  -- session 2: m2 leaves, sent without waiting for the answer; a lock wait gives up after 20 seconds
  perform dblink_exec('lotsync_s2', 'begin');
  perform dblink_exec('lotsync_s2', format('set local request.jwt.claims = %L', json_build_object('sub', m2, 'role', 'authenticated')::text));
  perform dblink_exec('lotsync_s2', 'set local role authenticated');
  perform dblink_exec('lotsync_s2', 'set local lock_timeout = ''20s''');
  if dblink_send_query('lotsync_s2', format('delete from public.memberships where user_id = %L and dealership_id = %L', m2, d)) <> 1 then
    raise exception 'session 2: the removal could not be sent';
  end if;

  -- up to 10 seconds for session 2 to reach session 1's lock, or to finish without one
  for i in 1..200 loop
    if pid1 = any(pg_blocking_pids(pid2)) then
      waited := true;
      exit;
    end if;
    exit when dblink_is_busy('lotsync_s2') = 0;
    perform pg_sleep(0.05);
  end loop;

  perform dblink_exec('lotsync_s1', 'commit');

  -- session 2's answer: its command tag, or the error it raised
  begin
    select status into answer from dblink_get_result('lotsync_s2') as t(status text);
  exception when others then
    answer := sqlstate;
  end;
  perform * from dblink_get_result('lotsync_s2') as t(status text); -- the end of that query's results
  -- a removal that went through is committed, so the check below sees what it would have left
  perform dblink_exec('lotsync_s2', case when answer = 'DELETE 1' then 'commit' else 'rollback' end);

  select string_agg(format('%s %s', m.name, m.role), ', ' order by m.name) into members
  from public.memberships m where m.dealership_id = d;
  if not exists (select 1 from public.memberships m where m.dealership_id = d and m.role = 'manager') then
    raise exception 'two managers acting at once left the dealership with no manager (members: %; session 2 %, answered %)',
      coalesce(members, 'none'), case when waited then 'waited for session 1' else 'did not wait for session 1' end, answer;
  end if;
  if not waited then
    raise exception 'session 2 did not wait for session 1: keep_a_manager took no lock on the dealership (answered %)', answer;
  end if;
  if answer is distinct from 'P0006' then
    raise exception 'session 2 was answered % instead of P0006', answer;
  end if;
  if members is distinct from 'Drew manager, Morgan salesperson' then
    raise exception 'after both sessions the members are % (expected Drew manager, Morgan salesperson)', members;
  end if;
  raise notice 'ok: a manager leaving while another steps down waits for them, then is refused with P0006';
exception when others then
  perform set_config('lotsync.concurrency_failure', sqlerrm, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- The sign-up throttle: the owner holds the lock while seven calls from p
-- queue for it. A failed check is added to lotsync.concurrency_failure.
-- ---------------------------------------------------------------------------
do $$
declare
  p uuid := '00000000-0000-4000-8000-000000cc00a3';
  calls constant integer := 7;
  conn text;
  pids integer[] := '{}';
  pid integer;
  waiting integer := 0;
  answer text;
  answers text[] := '{}';
  attempts bigint;
begin
  conn := pg_temp.conninfo();
  -- the owner locks the settings row, as a sign-up in progress holds it
  perform dblink_connect('lotsync_hold', conn);
  perform dblink_exec('lotsync_hold', 'begin');
  perform * from dblink('lotsync_hold', 'select 1 from public.signup_settings s where s.id for update') as t(one integer);

  -- p's calls, each session signed in the way PostgREST signs a request in; a lock wait gives up after 20 seconds
  for i in 1..calls loop
    perform dblink_connect('lotsync_t' || i, conn);
    select q into pid from dblink('lotsync_t' || i, 'select pg_backend_pid()') as t(q integer);
    pids := pids || pid;
    perform dblink_exec('lotsync_t' || i, format('set request.jwt.claims = %L', json_build_object('sub', p, 'role', 'authenticated')::text));
    perform dblink_exec('lotsync_t' || i, 'set role authenticated');
    perform dblink_exec('lotsync_t' || i, 'set lock_timeout = ''20s''');
    if dblink_send_query('lotsync_t' || i, format('select public.create_dealership(%L, %L, %L)::text', 'Probe Motors ' || i, 'www.dealership-c.test', 'Quinn')) <> 1 then
      raise exception 'call % could not be sent', i;
    end if;
  end loop;

  -- up to 10 seconds for every call to pass the first count and wait for the lock
  for i in 1..200 loop
    select count(*) into waiting from unnest(pids) x where cardinality(pg_blocking_pids(x)) > 0;
    exit when waiting = calls;
    perform pg_sleep(0.05);
  end loop;

  perform dblink_exec('lotsync_hold', 'commit');

  -- each call's answer: the code it answered, or the error it raised
  for i in 1..calls loop
    begin
      select coalesce(r::jsonb ->> 'code', 'a dealership') into answer from dblink_get_result('lotsync_t' || i) as t(r text);
    exception when others then
      answer := sqlstate;
    end;
    perform * from dblink_get_result('lotsync_t' || i) as t(r text); -- the end of that call's results
    answers := answers || answer;
  end loop;
  select array_agg(x order by x) into answers from unnest(answers) x;
  select count(*) into attempts from public.signup_attempts a where a.user_id = p;

  if waiting <> calls then
    raise exception 'only % of % sign-up calls waited for the settings row''s lock (answered %)', waiting, calls, answers;
  end if;
  if attempts > 5 then
    raise exception '% sign-up calls from one account at once looked up % websites in an hour, not 5: the throttle is not counted under the lock (answered %)', calls, attempts, answers;
  end if;
  if answers is distinct from array['P0005', 'P0005', 'P0009', 'P0009', 'P0009', 'P0009', 'P0009'] or attempts <> 5 then
    raise exception 'seven sign-up calls from one account at once were answered % and wrote % attempts (expected five P0009, two P0005 and five attempts)', answers, attempts;
  end if;
  raise notice 'ok: seven sign-up calls from one account at once look up five websites, and the other two get P0005';
exception when others then
  perform set_config('lotsync.concurrency_failure', concat_ws(E'\n', nullif(current_setting('lotsync.concurrency_failure'), ''), sqlerrm), false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Clean-up, pass or fail: close every session (a call still running is
-- cancelled first, and an open transaction is rolled back), then remove
-- every row this file made and set sign-up's switch back. Deleting the
-- dealership takes its memberships with it, as keep_a_manager allows, and
-- deleting p takes p's attempts.
-- ---------------------------------------------------------------------------
do $$
declare
  c text;
begin
  foreach c in array coalesce(dblink_get_connections(), '{}') loop
    if c like 'lotsync\_%' then
      if dblink_is_busy(c) = 1 then perform dblink_cancel_query(c); end if;
      perform dblink_disconnect(c);
    end if;
  end loop;
end;
$$;

delete from public.dealerships where id = :'dealer';
delete from auth.users where id in (:'m1', :'m2', :'p');
update public.signup_settings set open = :'signup_was_open';

reset search_path;
\if :install_dblink
drop extension dblink;
drop schema concurrency_dblink;
\endif

do $$
begin
  if exists (select 1 from public.dealerships where id = '00000000-0000-4000-8000-000000cc00d1')
     or exists (select 1 from public.memberships where user_id in ('00000000-0000-4000-8000-000000cc00a1', '00000000-0000-4000-8000-000000cc00a2'))
     or exists (select 1 from auth.users where id in ('00000000-0000-4000-8000-000000cc00a1', '00000000-0000-4000-8000-000000cc00a2', '00000000-0000-4000-8000-000000cc00a3'))
     or exists (select 1 from public.signup_attempts where user_id = '00000000-0000-4000-8000-000000cc00a3') then
    raise exception 'concurrency.sql left rows behind';
  end if;
  if current_setting('lotsync.concurrency_failure') <> '' then
    raise exception '%', current_setting('lotsync.concurrency_failure');
  end if;
end;
$$;

\echo 'concurrency.sql: every check passed (every row it made removed)'
