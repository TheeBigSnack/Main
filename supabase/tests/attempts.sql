-- Lot Current: who reads the post attempts (0011_ui_post_attempts_read.sql),
-- in the shape of rls.sql: people straight in auth.users, the JWT claims set
-- the way PostgREST sets them, DO blocks that raise on anything wrong,
-- everything in one transaction rolled back at the end. psql exits non-zero
-- on the first failed assertion.
--
--   user    dealership  role
--   p_mgr   P           manager, posted once too
--   p_s1    P           salesperson, two attempts
--   p_s2    P           salesperson, one attempt
--   q_s1    Q           salesperson, one attempt
--
-- What it proves: a salesperson reads their own post attempts and no
-- colleague's (their manager's included), and the summary view gives them
-- their own median only; the sync function's upsert of their own attempt
-- still goes through; a manager reads every attempt of their dealership and
-- none of another; one select policy is left on the table.

\set ON_ERROR_STOP on
\set p_mgr     '00000000-0000-4000-8000-0000000000f2'
\set p_s1      '00000000-0000-4000-8000-0000000000f1'
\set p_s2      '00000000-0000-4000-8000-0000000000f3'
\set q_s1      '00000000-0000-4000-8000-0000000000f4'
\set dealer_p  '00000000-0000-4000-8000-0000000000e1'
\set dealer_q  '00000000-0000-4000-8000-0000000000e2'

begin;

do $$
declare
  n bigint;
begin
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'post_attempts' and cmd = 'SELECT';
  if n <> 1 then raise exception 'post_attempts should have one select policy, has %', n; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'post_attempts' and policyname = 'members read their dealership''s post attempts') then
    raise exception 'the member-wide select policy on post_attempts is still there';
  end if;
  raise notice 'ok: one select policy on post_attempts, the member-wide one is gone';
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner, which is not under RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'p_mgr', 'authenticated', 'authenticated', 'p-mgr@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p_s1',  'authenticated', 'authenticated', 'p-s1@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p_s2',  'authenticated', 'authenticated', 'p-s2@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'q_s1',  'authenticated', 'authenticated', 'q-s1@example.test',  now(), now());

insert into public.dealerships (id, name, website_origin) values
  (:'dealer_p', 'Dealership P', 'https://www.attempts-p.test'),
  (:'dealer_q', 'Dealership Q', 'https://www.attempts-q.test');

insert into public.memberships (user_id, dealership_id, role, name) values
  (:'p_mgr', :'dealer_p', 'manager',     'Pat'),
  (:'p_s1',  :'dealer_p', 'salesperson', 'Robin'),
  (:'p_s2',  :'dealer_p', 'salesperson', 'Casey'),
  (:'q_s1',  :'dealer_q', 'salesperson', 'Drew');

insert into public.post_attempts (dealership_id, user_id, vin, name, salesperson, started_at, ended_at, outcome, seconds, reason) values
  (:'dealer_p', :'p_s1',  'TESTVINP00000001', 'Car P1', 'Robin', '2026-10-01 10:00:00+00', '2026-10-01 10:00:40+00', 'posted', 40, null),
  (:'dealer_p', :'p_s1',  'TESTVINP00000002', 'Car P2', 'Robin', '2026-10-01 11:00:00+00', '2026-10-01 11:01:00+00', 'posted', 60, null),
  (:'dealer_p', :'p_s2',  'TESTVINP00000003', 'Car P3', 'Casey', '2026-10-01 12:00:00+00', null,                     'abandoned', null, 'closed the tab'),
  (:'dealer_p', :'p_s2',  'TESTVINP00000004', 'Car P4', 'Casey', '2026-10-01 13:00:00+00', '2026-10-01 13:01:30+00', 'posted', 90, null),
  (:'dealer_p', :'p_mgr', 'TESTVINP00000005', 'Car P5', 'Pat',   '2026-10-01 14:00:00+00', '2026-10-01 14:00:30+00', 'posted', 30, null),
  (:'dealer_q', :'q_s1',  'TESTVINQ00000001', 'Car Q1', 'Drew',  '2026-10-01 10:00:00+00', '2026-10-01 10:00:45+00', 'posted', 45, null);

-- ---------------------------------------------------------------------------
-- p_s1: a salesperson of P
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"' || :'p_s1' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  p uuid := '00000000-0000-4000-8000-0000000000e1';
  me uuid := auth.uid();
  median numeric;
begin
  if me <> '00000000-0000-4000-8000-0000000000f1' then
    raise exception 'auth.uid() is % (the claims were not picked up)', me;
  end if;

  select count(*) into n from public.post_attempts;
  if n <> 2 then raise exception 'p_s1 should see their own 2 post attempts, saw %', n; end if;
  if exists (select 1 from public.post_attempts where user_id <> me) then
    raise exception 'p_s1 can see a colleague''s post attempt';
  end if;
  raise notice 'ok: p_s1 reads their own post attempts and no colleague''s or manager''s';

  select median_seconds into median from public.v_salesperson_summary where dealership_id = p and user_id = me;
  if median is distinct from 50.0 then raise exception 'p_s1''s own median should be 50, was %', median; end if;
  if exists (select 1 from public.v_salesperson_summary where user_id <> me and median_seconds is not null) then
    raise exception 'the summary view gives p_s1 a colleague''s median';
  end if;
  raise notice 'ok: the summary view gives p_s1 their own median only';

  -- the sync function's upsert of an attempt already stored (user_id is in the key)
  insert into public.post_attempts (dealership_id, user_id, vin, name, salesperson, started_at, ended_at, outcome, seconds)
  values (p, me, 'TESTVINP00000001', 'Car P1', 'Robin', '2026-10-01 10:00:00+00', '2026-10-01 10:00:41+00', 'posted', 41)
  on conflict (dealership_id, user_id, vin, started_at) do update
    set ended_at = excluded.ended_at, outcome = excluded.outcome, seconds = excluded.seconds;
  select seconds into n from public.post_attempts where user_id = me and vin = 'TESTVINP00000001';
  if n <> 41 then raise exception 'p_s1''s upsert of their own attempt did not land (seconds %)', n; end if;
  -- and a new one
  insert into public.post_attempts (dealership_id, user_id, vin, started_at)
  values (p, me, 'TESTVINP00000006', '2026-10-01 15:00:00+00')
  on conflict (dealership_id, user_id, vin, started_at) do nothing;
  select count(*) into n from public.post_attempts;
  if n <> 3 then raise exception 'p_s1 should now see 3 post attempts, saw %', n; end if;
  raise notice 'ok: p_s1 still records and corrects their own attempts the way sync does';

  -- a colleague's attempt cannot be changed either (unchanged rule)
  update public.post_attempts set seconds = 1 where vin = 'TESTVINP00000004';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'p_s1 changed a colleague''s post attempt'; end if;
  raise notice 'ok: p_s1 cannot change a colleague''s attempt';
end;
$$;

-- ---------------------------------------------------------------------------
-- p_mgr: the manager of P
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'p_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  p uuid := '00000000-0000-4000-8000-0000000000e1';
  q uuid := '00000000-0000-4000-8000-0000000000e2';
  median numeric;
begin
  select count(*) into n from public.post_attempts where dealership_id = p;
  if n <> 6 then raise exception 'p_mgr should see the 6 post attempts of P, saw %', n; end if;
  if exists (select 1 from public.post_attempts where dealership_id = q) then
    raise exception 'p_mgr can see a post attempt of Q';
  end if;
  select median_seconds into median from public.v_salesperson_summary where dealership_id = p and user_id = '00000000-0000-4000-8000-0000000000f3';
  if median is distinct from 90.0 then raise exception 'p_mgr should see p_s2''s median of 90, saw %', median; end if;
  raise notice 'ok: p_mgr reads every post attempt of P, each salesperson''s median, and nothing of Q';
end;
$$;

-- ---------------------------------------------------------------------------
-- q_s1: a salesperson of Q
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'q_s1' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
begin
  select count(*) into n from public.post_attempts;
  if n <> 1 then raise exception 'q_s1 should see their own 1 post attempt, saw %', n; end if;
  raise notice 'ok: q_s1 reads their own attempt and nothing of P';
end;
$$;

reset role;
rollback;

\echo 'attempts.sql: every check passed (all changes rolled back)'
