-- Lot Current: the owner's usage report (0008_usage.sql) against a running
-- database with the migrations applied, in the shape of privacy.sql: people
-- straight in auth.users, DO blocks that raise on anything wrong,
-- everything in one transaction rolled back at the end. psql exits non-zero
-- on the first failed assertion.
--
--   dealership  plan    people and what they did (the default window is the 7 days before now())
--   A           active  a_mgr manager, posts (a post, not an active salesperson);
--                       a_s1 posted twice, once exactly 7 days ago; a_s2 posted a
--                       microsecond before the window; a_s3 posted 10 minutes ago;
--                       x_both, a salesperson here too, posts only in B;
--                       a_gone posted and is no longer a member
--   B           pilot   b_mgr manager, posts; b_s1, b_s2 and x_both post
--   C           none    nobody and nothing: the row of zeros
--   D           lapsed  d_mgr manager, a closed to-do item and an old scan
--
-- A also holds a scan stamped a month ahead (a machine whose clock ran
-- ahead, stored before /sync refused such scans): last_synced_scan_at
-- leaves out a scan more than 5 minutes ahead of the database's clock.
--
-- now() is the same all through one transaction, so "exactly 7 days ago"
-- here is exactly what the report's default since is.
--
-- What it proves: each row counts its own dealership's rows only, a person
-- in two dealerships counts where they posted; active_salespeople counts
-- current members with the salesperson role who posted in the window; the
-- window includes since and excludes a microsecond before it, for posts
-- and rewrite calls alike, and a null since counts everything; the plan
-- matches subscription_state(); the rows come busiest first, then by name;
-- a dealership with no activity has its row, with zeros; a scan stamped
-- more than 5 minutes ahead of the database's clock is never
-- last_synced_scan_at; a listing marked as made by hand before that day
-- (listed_before) is no post and makes no one active; public, anon,
-- authenticated and service_role cannot execute it, and it runs as its
-- caller with an empty search_path.

\set ON_ERROR_STOP on
\set a_mgr     '00000000-0000-4000-8000-0000000000a2'
\set a_s1      '00000000-0000-4000-8000-0000000000a1'
\set a_s2      '00000000-0000-4000-8000-0000000000a3'
\set a_s3      '00000000-0000-4000-8000-0000000000a4'
\set a_gone    '00000000-0000-4000-8000-0000000000a9'
\set x_both    '00000000-0000-4000-8000-0000000000a5'
\set b_mgr     '00000000-0000-4000-8000-0000000000b2'
\set b_s1      '00000000-0000-4000-8000-0000000000b1'
\set b_s2      '00000000-0000-4000-8000-0000000000b3'
\set d_mgr     '00000000-0000-4000-8000-0000000000c2'
\set dealer_a  '00000000-0000-4000-8000-0000000000d1'
\set dealer_b  '00000000-0000-4000-8000-0000000000d2'
\set dealer_c  '00000000-0000-4000-8000-0000000000d3'
\set dealer_d  '00000000-0000-4000-8000-0000000000d4'

begin;

-- ---------------------------------------------------------------------------
-- Privileges: no API role can execute it; the owner can. It runs as its
-- caller, with an empty search_path.
-- ---------------------------------------------------------------------------
do $$
declare
  who text;
begin
  foreach who in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(who, 'public.usage_report(timestamptz)', 'execute') then
      raise exception '% may execute usage_report', who;
    end if;
  end loop;
  if not has_function_privilege(current_user, 'public.usage_report(timestamptz)', 'execute') then
    raise exception 'the owner (%) cannot execute usage_report', current_user;
  end if;
  if (select prosecdef or proconfig is distinct from array['search_path=""'] from pg_proc where oid = 'public.usage_report(timestamptz)'::regprocedure) then
    raise exception 'usage_report is not security invoker with an empty search_path';
  end if;
  raise notice 'ok: execute is revoked from public, anon, authenticated and service_role; it runs as its caller';
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner, which is not under RLS). D goes in before C, so a
-- report that came back in the order the rows were made would put D first.
-- a_gone has no auth.users row and no membership: an account deleted after
-- it posted (listings.user_id has no foreign key, for exactly that).
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'a_mgr',  'authenticated', 'authenticated', 'a-mgr@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_s1',   'authenticated', 'authenticated', 'a-s1@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_s2',   'authenticated', 'authenticated', 'a-s2@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_s3',   'authenticated', 'authenticated', 'a-s3@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'x_both', 'authenticated', 'authenticated', 'x-both@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_mgr',  'authenticated', 'authenticated', 'b-mgr@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_s1',   'authenticated', 'authenticated', 'b-s1@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_s2',   'authenticated', 'authenticated', 'b-s2@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'d_mgr',  'authenticated', 'authenticated', 'd-mgr@example.test',  now(), now());

insert into public.dealerships (id, name, website_origin, created_at) values
  (:'dealer_a', 'Dealership A', 'https://www.usage-a.test', now() - interval '60 days'),
  (:'dealer_b', 'Dealership B', 'https://www.usage-b.test', now() - interval '20 days'),
  (:'dealer_d', 'Dealership D', 'https://www.usage-d.test', now() - interval '90 days'),
  (:'dealer_c', 'Dealership C', 'https://www.usage-c.test', now() - interval '1 day');

insert into public.memberships (user_id, dealership_id, role, name) values
  (:'a_mgr',  :'dealer_a', 'manager',     'Jamie'),
  (:'a_s1',   :'dealer_a', 'salesperson', 'Alex'),
  (:'a_s2',   :'dealer_a', 'salesperson', 'Casey'),
  (:'a_s3',   :'dealer_a', 'salesperson', 'Drew'),
  (:'x_both', :'dealer_a', 'salesperson', 'Morgan'),
  (:'x_both', :'dealer_b', 'salesperson', 'Morgan'),
  (:'b_mgr',  :'dealer_b', 'manager',     'Sam'),
  (:'b_s1',   :'dealer_b', 'salesperson', 'Robin'),
  (:'b_s2',   :'dealer_b', 'salesperson', 'Taylor'),
  (:'d_mgr',  :'dealer_d', 'manager',     'Lee');

insert into public.listings (dealership_id, user_id, vin, name, price, posted_at, salesperson, status, taken_down_at) values
  -- A: the same car posted twice by a_s1 and both still up (one car listed), once exactly at the window's start
  (:'dealer_a', :'a_s1',   'TESTVINA00000001', 'Car A1', 20000, now() - interval '1 day',                              'Alex',   'listed',     null),
  (:'dealer_a', :'a_s1',   'TESTVINA00000001', 'Car A1', 20000, now() - interval '7 days',                             'Alex',   'listed',     null),
  (:'dealer_a', :'a_s2',   'TESTVINA00000002', 'Car A2', 21000, now() - interval '7 days' - interval '1 microsecond',  'Casey',  'listed',     null),
  (:'dealer_a', :'a_s3',   'TESTVINA00000003', 'Car A3', 22000, now() - interval '10 minutes',                         'Drew',   'taken_down', now() - interval '5 minutes'),
  (:'dealer_a', :'a_mgr',  'TESTVINA00000004', 'Car A4', 23000, now() - interval '2 days',                             'Jamie',  'listed',     null),
  (:'dealer_a', :'a_gone', 'TESTVINA00000005', 'Car A5', 24000, now() - interval '3 days',                             'Former', 'taken_down', now() - interval '2 days'),
  -- B: three salespeople and the manager, one post from before the window
  (:'dealer_b', :'b_s1',   'TESTVINB00000001', 'Car B1', 30000, now() - interval '1 hour',                             'Robin',  'listed',     null),
  (:'dealer_b', :'x_both', 'TESTVINB00000002', 'Car B2', 31000, now() - interval '2 hours',                            'Morgan', 'listed',     null),
  (:'dealer_b', :'b_mgr',  'TESTVINB00000003', 'Car B3', 32000, now() - interval '3 hours',                            'Sam',    'listed',     null),
  (:'dealer_b', :'b_s2',   'TESTVINB00000005', 'Car B5', 33000, now() - interval '4 hours',                            'Taylor', 'listed',     null),
  (:'dealer_b', :'b_s1',   'TESTVINB00000004', 'Car B4', 34000, now() - interval '8 days',                             'Robin',  'taken_down', now() - interval '6 days');

insert into public.todo_items (dealership_id, vin, kind, name, flagged_at, done_at, how, from_price, to_price) values
  (:'dealer_a', 'TESTVINA00000001', 'takeDown', 'Car A1', now() - interval '30 hours', null,                      null,     null,  null),
  (:'dealer_a', 'TESTVINA00000003', 'takeDown', 'Car A3', now() - interval '50 hours', now() - interval '5 minutes', 'detected', null, null),
  (:'dealer_a', 'TESTVINA00000002', 'price',    'Car A2', now() - interval '5 hours',  null,                      null,     21000, 20500),
  (:'dealer_a', 'TESTVINA00000004', 'price',    'Car A4', now() - interval '1 hour',   null,                      null,     23000, 22500),
  (:'dealer_b', 'TESTVINB00000001', 'price',    'Car B1', now() - interval '90 minutes', null,                    null,     30000, 29500),
  (:'dealer_b', 'TESTVINB00000004', 'takeDown', 'Car B4', now() - interval '7 days',   now() - interval '6 days', 'manual', null,  null),
  (:'dealer_d', 'TESTVIND00000001', 'takeDown', 'Car D1', now() - interval '45 days',  now() - interval '44 days', 'cleared', null, null);

insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count) values
  (:'dealer_a', 'https://www.usage-a.test', now() - interval '2 days',   40, 30, 0, 0),
  (:'dealer_a', 'https://www.usage-a.test', now() - interval '3 hours',  41, 31, 1, 2),
  -- stored from a machine whose clock ran a month ahead: it must not pin A's last scan
  (:'dealer_a', 'https://www.usage-a.test', now() + interval '30 days',  41, 31, 0, 0),
  (:'dealer_b', 'https://www.usage-b.test', now() - interval '20 minutes', 90, 70, 0, 1),
  (:'dealer_d', 'https://www.usage-d.test', now() - interval '40 days',  12, 9, 0, 0);

insert into public.rewrite_usage (dealership_id, user_id, at, model, input_tokens, output_tokens, cost_usd, kind) values
  (:'dealer_a', :'a_s1', now() - interval '7 days',                            'test-model', 1500, 200, 0.0025, 'rewrite'),
  (:'dealer_a', :'a_s1', now() - interval '7 days' - interval '1 microsecond', 'test-model', 1500, 200, 0.0025, 'rewrite'),
  (:'dealer_a', :'a_s3', now() - interval '1 hour',                            'test-model', 1500, 200, 0.0025, 'rewrite'),
  (:'dealer_a', :'a_s3', now() - interval '1 day',                             'test-model', 900,  40,  0.0011, 'color'),
  (:'dealer_b', :'b_s1', now() - interval '2 days',                            'test-model', 1500, 200, 0.0025, 'rewrite');

insert into public.subscriptions (dealership_id, stripe_customer_id, stripe_subscription_id, status, pilot_ends_at, current_period_end) values
  (:'dealer_a', 'cus_a', 'sub_a', 'active', null,                      now() + interval '20 days'),
  (:'dealer_b', null,    null,    'pilot',  now() + interval '10 days', null),
  (:'dealer_d', null,    null,    'pilot',  now() - interval '1 day',   null);

-- The report for the fixture's four dealerships, one line each in the
-- report's order: name, plan_state, managers, salespeople,
-- active_salespeople, posts, cars_listed_now, open_take_downs,
-- open_price_changes, oldest_open_hours, hours since last_synced_scan_at,
-- rewrite_calls ("-" for null). Only the fixture's rows, found by origin.
create function pg_temp.report(since timestamptz) returns text
language sql stable as $$
  select string_agg(concat_ws(' ', u.name, u.plan_state, u.managers, u.salespeople, u.active_salespeople, u.posts, u.cars_listed_now,
                              u.open_take_downs, u.open_price_changes, coalesce(u.oldest_open_hours::text, '-'),
                              coalesce((extract(epoch from now() - u.last_synced_scan_at) / 3600)::numeric(10, 2)::text, '-'), u.rewrite_calls),
                    E'\n' order by u.ordinality)
  from public.usage_report(since) with ordinality u
  where u.website_origin like 'https://www.usage-_.test';
$$;

create function pg_temp.expect(since timestamptz, want text, what text) returns void
language plpgsql as $$
declare
  got text := pg_temp.report(since);
begin
  if got is distinct from want then
    raise exception E'%:\ngot\n%\nwant\n%', what, got, want;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The default window: the 7 days before now(), busiest first, then by name.
-- A: a_s1 and a_s3 are active (a_s2 posted a microsecond early, a_mgr is a
-- manager, a_gone is no longer a member, x_both posted only in B); 5 posts
-- (a_s1's two, a_s3's, a_mgr's, a_gone's); 3 cars up (A1 twice, A2, A4);
-- one sold car still listed, two price changes, the oldest open 30 hours;
-- its newest scan 3 hours ago (not the one a month ahead); 2 rewrite calls (the one at the window's
-- start, the one an hour ago; not the one a microsecond early, not the
-- color call). B: b_s1, b_s2 and x_both; 4 posts in the window.
-- ---------------------------------------------------------------------------
do $$
declare
  by_default jsonb;
  by_hand jsonb;
begin
  perform pg_temp.expect(now() - interval '7 days',
    E'Dealership B pilot 1 3 3 4 4 0 1 1.5 0.33 1\n'
    'Dealership A active 1 4 2 5 3 1 2 30.0 3.00 2\n'
    'Dealership C none 0 0 0 0 0 0 0 - - 0\n'
    'Dealership D lapsed 1 0 0 0 0 0 0 - 960.00 0',
    'the past 7 days');

  select jsonb_agg(to_jsonb(u) order by u.ordinality) into by_default from public.usage_report() with ordinality u;
  select jsonb_agg(to_jsonb(u) order by u.ordinality) into by_hand from public.usage_report(now() - interval '7 days') with ordinality u;
  if by_default is distinct from by_hand then
    raise exception 'usage_report() is not usage_report(now() - interval ''7 days'')';
  end if;
  raise notice 'ok: the past 7 days by default, each dealership counting its own rows, busiest first, then by name';
end;
$$;

-- ---------------------------------------------------------------------------
-- The window's edges, and a null since
-- ---------------------------------------------------------------------------
do $$
begin
  -- a microsecond earlier takes in a_s2's post and the rewrite call stamped then
  perform pg_temp.expect(now() - interval '7 days' - interval '1 microsecond',
    E'Dealership A active 1 4 3 6 3 1 2 30.0 3.00 3\n'
    'Dealership B pilot 1 3 3 4 4 0 1 1.5 0.33 1\n'
    'Dealership C none 0 0 0 0 0 0 0 - - 0\n'
    'Dealership D lapsed 1 0 0 0 0 0 0 - 960.00 0',
    'since a microsecond before the 7 days');

  -- exactly at a_s3's post: it counts; a microsecond later it does not
  perform pg_temp.expect(now() - interval '10 minutes',
    E'Dealership A active 1 4 1 1 3 1 2 30.0 3.00 0\n'
    'Dealership B pilot 1 3 0 0 4 0 1 1.5 0.33 0\n'
    'Dealership C none 0 0 0 0 0 0 0 - - 0\n'
    'Dealership D lapsed 1 0 0 0 0 0 0 - 960.00 0',
    'since exactly a post');
  perform pg_temp.expect(now() - interval '10 minutes' + interval '1 microsecond',
    E'Dealership A active 1 4 0 0 3 1 2 30.0 3.00 0\n'
    'Dealership B pilot 1 3 0 0 4 0 1 1.5 0.33 0\n'
    'Dealership C none 0 0 0 0 0 0 0 - - 0\n'
    'Dealership D lapsed 1 0 0 0 0 0 0 - 960.00 0',
    'since a microsecond after a post');

  -- null counts everything, B's post from 8 days ago included
  perform pg_temp.expect(null,
    E'Dealership A active 1 4 3 6 3 1 2 30.0 3.00 3\n'
    'Dealership B pilot 1 3 3 5 4 0 1 1.5 0.33 1\n'
    'Dealership C none 0 0 0 0 0 0 0 - - 0\n'
    'Dealership D lapsed 1 0 0 0 0 0 0 - 960.00 0',
    'a null since');
  raise notice 'ok: since is inclusive, a microsecond before it is out, and null counts from the beginning';
end;
$$;

-- ---------------------------------------------------------------------------
-- The columns the lines above leave out, the plan against
-- subscription_state(), and the row of zeros
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  c uuid := '00000000-0000-4000-8000-0000000000d3';
  d uuid := '00000000-0000-4000-8000-0000000000d4';
  r record;
  n int := 0;
begin
  for r in select * from public.usage_report() u where u.dealership_id in (a, b, c, d) loop
    n := n + 1;
    if r.plan_state is distinct from public.subscription_state(r.dealership_id) then
      raise exception '% says % where subscription_state() says %', r.name, r.plan_state, public.subscription_state(r.dealership_id);
    end if;
    if not exists (select 1 from public.dealerships x
                   where x.id = r.dealership_id and (x.name, x.website_origin, x.created_at) is not distinct from (r.name, r.website_origin, r.created_at)) then
      raise exception '% does not carry its dealerships row', r.name;
    end if;
  end loop;
  if n <> 4 then raise exception 'the report has % rows for the fixture''s 4 dealerships', n; end if;

  select * into r from public.usage_report() u where u.dealership_id = a;
  if r.current_period_end is distinct from now() + interval '20 days' or r.pilot_ends_at is not null then raise exception 'A''s dates are wrong'; end if;
  select * into r from public.usage_report() u where u.dealership_id = b;
  if r.pilot_ends_at is distinct from now() + interval '10 days' or r.current_period_end is not null then raise exception 'B''s dates are wrong'; end if;
  select * into r from public.usage_report() u where u.dealership_id = d;
  if r.pilot_ends_at is distinct from now() - interval '1 day' then raise exception 'D''s pilot end is wrong'; end if;

  -- C: made yesterday, nothing since: a row, with zeros where a count is and nulls where a time is
  select * into r from public.usage_report() u where u.dealership_id = c;
  if not found then raise exception 'a dealership with no activity has no row'; end if;
  if (r.managers, r.salespeople, r.active_salespeople, r.posts, r.cars_listed_now, r.open_take_downs, r.open_price_changes, r.rewrite_calls)
     is distinct from (0, 0, 0, 0, 0, 0, 0, 0) then
    raise exception 'a dealership with no activity does not read zeros: %', to_jsonb(r);
  end if;
  if r.oldest_open_hours is not null or r.last_synced_scan_at is not null or r.pilot_ends_at is not null or r.current_period_end is not null or r.plan_state <> 'none' then
    raise exception 'a dealership with no activity has a time or a plan: %', to_jsonb(r);
  end if;
  raise notice 'ok: the plan is subscription_state()''s, the dates are the subscription''s, and a quiet dealership reads zeros';
end;
$$;

-- ---------------------------------------------------------------------------
-- last_synced_scan_at and the clock: a scan more than 5 minutes ahead of the
-- database's clock is left out, one within 5 minutes (ordinary drift) counts
-- ---------------------------------------------------------------------------
do $$
declare
  c uuid := '00000000-0000-4000-8000-0000000000d3';
  r record;
begin
  insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count)
    values (c, 'https://www.usage-c.test', now() + interval '5 minutes' + interval '1 microsecond', 5, 4, 0, 0);
  select * into r from public.usage_report() u where u.dealership_id = c;
  if r.last_synced_scan_at is not null then
    raise exception 'a scan stamped just over 5 minutes ahead is the last synced scan: %', r.last_synced_scan_at;
  end if;
  insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count)
    values (c, 'https://www.usage-c.test', now() + interval '5 minutes', 5, 4, 0, 0);
  select * into r from public.usage_report() u where u.dealership_id = c;
  if r.last_synced_scan_at is distinct from now() + interval '5 minutes' then
    raise exception 'a scan stamped 5 minutes ahead (ordinary drift) is not the last synced scan: %', r.last_synced_scan_at;
  end if;
  raise notice 'ok: last_synced_scan_at leaves out a scan more than 5 minutes ahead of the database''s clock';
end;
$$;

-- ---------------------------------------------------------------------------
-- A listing marked as made by hand before that day (listed_before,
-- 0012_posting_listed_before.sql) is not a post: it adds nothing to posts
-- and makes no one an active salesperson, but the car is listed now. a_s2
-- (not active in the window) marks two such listings an hour ago, a_s1 one
-- (already active); B's b_s1 marks one. Then the rows go.
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  a_s1 uuid := '00000000-0000-4000-8000-0000000000a1';
  a_s2 uuid := '00000000-0000-4000-8000-0000000000a3';
  b_s1 uuid := '00000000-0000-4000-8000-0000000000b1';
  r record;
begin
  insert into public.listings (dealership_id, user_id, vin, name, price, posted_at, salesperson, status, taken_down_at, listed_before) values
    (a, a_s2, 'TESTVINA00000011', 'Car A11', 25000, now() - interval '1 hour', 'Casey', 'listed', null, true),
    (a, a_s2, 'TESTVINA00000012', 'Car A12', 26000, now() - interval '1 hour', 'Casey', 'listed', null, true),
    (a, a_s1, 'TESTVINA00000013', 'Car A13', 27000, now() - interval '1 hour', 'Alex',  'taken_down', now() - interval '5 minutes', true),
    (b, b_s1, 'TESTVINB00000011', 'Car B11', 35000, now() - interval '1 hour', 'Robin', 'listed', null, true);
  select * into r from public.usage_report() u where u.dealership_id = a;
  if (r.active_salespeople, r.posts, r.cars_listed_now) is distinct from (2, 5, 5) then
    raise exception 'listings marked as made before that day count as posts: A reads % active, % posts, % cars listed (want 2, 5, 5)', r.active_salespeople, r.posts, r.cars_listed_now;
  end if;
  select * into r from public.usage_report(null) u where u.dealership_id = b;
  if (r.active_salespeople, r.posts, r.cars_listed_now) is distinct from (3, 5, 5) then
    raise exception 'listings marked as made before that day count as posts: B reads % active, % posts, % cars listed (want 3, 5, 5)', r.active_salespeople, r.posts, r.cars_listed_now;
  end if;
  delete from public.listings l where l.listed_before;
  raise notice 'ok: a listing marked as made before that day is no post and makes no one active; its car is listed';
end;
$$;

-- ---------------------------------------------------------------------------
-- Called through the API: every role is refused, a manager's token included,
-- and by the function itself (the error names it), not by a table it reads
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"' || :'a_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
begin
  perform public.usage_report();
  raise exception 'a signed-in manager ran the usage report';
exception when insufficient_privilege then
  if sqlerrm not like '%usage_report%' then raise; end if;
  raise notice 'ok: a signed-in manager cannot run it';
end;
$$;
reset role;

set local role anon;
do $$
begin
  perform public.usage_report();
  raise exception 'anon ran the usage report';
exception when insufficient_privilege then
  if sqlerrm not like '%usage_report%' then raise; end if;
  raise notice 'ok: anon cannot run it';
end;
$$;
reset role;

set local role service_role;
do $$
begin
  perform public.usage_report();
  raise exception 'the service role ran the usage report';
exception when insufficient_privilege then
  if sqlerrm not like '%usage_report%' then raise; end if;
  raise notice 'ok: the service role cannot run it';
end;
$$;
reset role;

rollback;

\echo 'usage.sql: every check passed (all changes rolled back)'
