-- Lot Sync: keep_a_manager (0002_rls.sql) with two sessions at the same
-- moment.
--
-- rls.sql proves the rule inside one session: the last manager can neither
-- step down nor leave. One session cannot prove it holds when two managers
-- act at once. Under READ COMMITTED a transaction sees another's change only
-- once that one commits, so if manager m1 steps down while manager m2 leaves,
-- each check still sees the other as a manager. Without a lock both would
-- pass and the dealership would be left with no manager. keep_a_manager
-- locks the dealership row before it looks, so the second change waits for
-- the first, then sees it, and is refused with P0006.
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
-- Unlike the other test files, this one cannot run inside one rolled-back
-- transaction, because the sessions only see each other's committed rows.
-- So the fixture is committed. The end of the file removes every row the
-- test made, pass or fail, and drops dblink again when this file installed
-- it. A failed check is raised only after that clean-up. It first removes
-- rows an interrupted earlier run may have left under the same ids.
-- Only for a throwaway database (scripts/sql-test.mjs, CI): dblink_connect
-- without a password needs a superuser, and the ids below must be this
-- file's alone.
--
--   user  dealership  role
--   m1    C           manager
--   m2    C           manager

\set ON_ERROR_STOP on
\set m1      '00000000-0000-4000-8000-000000cc00a1'
\set m2      '00000000-0000-4000-8000-000000cc00a2'
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

-- ---------------------------------------------------------------------------
-- Fixture (as the owner, committed): dealership C with two managers
-- ---------------------------------------------------------------------------
delete from public.dealerships where id = :'dealer';
delete from auth.users where id in (:'m1', :'m2');

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'m1', 'authenticated', 'authenticated', 'm1@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'m2', 'authenticated', 'authenticated', 'm2@example.test', now(), now());
insert into public.dealerships (id, name, website_origin) values
  (:'dealer', 'Dealership C', 'https://www.dealership-c.test');
insert into public.memberships (user_id, dealership_id, role, name) values
  (:'m1', :'dealer', 'manager', 'Morgan'),
  (:'m2', :'dealer', 'manager', 'Drew');

-- ---------------------------------------------------------------------------
-- The two sessions. Nothing here raises: a failed check is kept in
-- lotsync.concurrency_failure and raised after the clean-up below.
-- ---------------------------------------------------------------------------
select set_config('lotsync.concurrency_failure', '', false) as reset_failure \gset

do $$
declare
  m1 uuid := '00000000-0000-4000-8000-000000cc00a1';
  m2 uuid := '00000000-0000-4000-8000-000000cc00a2';
  d uuid := '00000000-0000-4000-8000-000000cc00d1';
  socket text := trim(split_part(current_setting('unix_socket_directories'), ',', 1));
  conn text;
  pid1 integer;
  pid2 integer;
  waited boolean := false;
  answer text;
  members text;
begin
  if socket = '' then
    raise exception 'this server listens on no unix socket, so dblink cannot connect back to it';
  end if;
  -- libpq conninfo values in single quotes, backslash-escaped
  conn := format('host=''%s'' port=%s dbname=''%s'' user=''%s''',
                 replace(replace(socket, '\', '\\'), '''', '\'''), current_setting('port'),
                 replace(replace(current_database(), '\', '\\'), '''', '\'''),
                 replace(replace(current_user, '\', '\\'), '''', '\'''));
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
-- Clean-up, pass or fail: close both sessions (an open transaction is rolled
-- back), then remove every row this file made. Deleting the dealership takes
-- its memberships with it, as keep_a_manager allows.
-- ---------------------------------------------------------------------------
do $$
declare
  c text;
begin
  foreach c in array coalesce(dblink_get_connections(), '{}') loop
    if c in ('lotsync_s1', 'lotsync_s2') then perform dblink_disconnect(c); end if;
  end loop;
end;
$$;

delete from public.dealerships where id = :'dealer';
delete from auth.users where id in (:'m1', :'m2');

reset search_path;
\if :install_dblink
drop extension dblink;
drop schema concurrency_dblink;
\endif

do $$
begin
  if exists (select 1 from public.dealerships where id = '00000000-0000-4000-8000-000000cc00d1')
     or exists (select 1 from public.memberships where user_id in ('00000000-0000-4000-8000-000000cc00a1', '00000000-0000-4000-8000-000000cc00a2'))
     or exists (select 1 from auth.users where id in ('00000000-0000-4000-8000-000000cc00a1', '00000000-0000-4000-8000-000000cc00a2')) then
    raise exception 'concurrency.sql left rows behind';
  end if;
  if current_setting('lotsync.concurrency_failure') <> '' then
    raise exception '%', current_setting('lotsync.concurrency_failure');
  end if;
end;
$$;

\echo 'concurrency.sql: every check passed (every row it made removed)'
