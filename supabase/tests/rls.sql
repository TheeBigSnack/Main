-- Lot Sync: row-level security checks (PLAN.md, M4 acceptance 3).
--
-- Plain SQL, no pgTAP. Runs with psql as the database owner against a local
-- database that has the migrations applied (supabase/README.md, "Run the
-- RLS test"): it creates two dealerships and their people straight in
-- auth.users, then for each person sets the JWT claims the way PostgREST
-- does (set local role authenticated; request.jwt.claims) and asserts in
-- DO blocks that raise on anything wrong. Everything happens in one
-- transaction that is rolled back at the end, so the database is left as it
-- was. psql exits non-zero on the first failed assertion.
--
--   user       dealership  role
--   a_sales    A           salesperson
--   a_mgr      A           manager
--   b_sales    B           salesperson
--   newcomer   (none yet)  redeems two invites for B during the test: one
--                          from create_invite's mould and one the owner
--                          typed in lower case

\set ON_ERROR_STOP on
\set a_sales   '00000000-0000-4000-8000-0000000000a1'
\set a_mgr     '00000000-0000-4000-8000-0000000000a2'
\set b_sales   '00000000-0000-4000-8000-0000000000b1'
\set newcomer  '00000000-0000-4000-8000-0000000000c1'
\set dealer_a  '00000000-0000-4000-8000-0000000000d1'
\set dealer_b  '00000000-0000-4000-8000-0000000000d2'

begin;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner role, which is not under RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'a_sales',  'authenticated', 'authenticated', 'a-sales@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_mgr',    'authenticated', 'authenticated', 'a-mgr@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_sales',  'authenticated', 'authenticated', 'b-sales@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'newcomer', 'authenticated', 'authenticated', 'newcomer@example.test', now(), now());

insert into public.dealerships (id, name, website_origin) values
  (:'dealer_a', 'Dealership A', 'https://www.dealership-a.test'),
  (:'dealer_b', 'Dealership B', 'https://www.dealership-b.test');

insert into public.memberships (user_id, dealership_id, role, name) values
  (:'a_sales', :'dealer_a', 'salesperson', 'Alex'),
  (:'a_mgr',   :'dealer_a', 'manager',     'Jamie'),
  (:'b_sales', :'dealer_b', 'salesperson', 'Sam');

insert into public.listings (id, dealership_id, user_id, vin, name, price, posted_at, salesperson) values
  ('00000000-0000-4000-8000-0000000000e1', :'dealer_a', :'a_sales', 'TESTVINA00000001', 'Car A1', 20000, now() - interval '2 days', 'Alex'),
  ('00000000-0000-4000-8000-0000000000e2', :'dealer_a', :'a_mgr',   'TESTVINA00000002', 'Car A2', 21000, now() - interval '1 day',  'Jamie'),
  ('00000000-0000-4000-8000-0000000000e3', :'dealer_b', :'b_sales', 'TESTVINB00000001', 'Car B1', 30000, now() - interval '1 day',  'Sam');

insert into public.post_attempts (dealership_id, user_id, vin, name, salesperson, started_at, ended_at, outcome, seconds) values
  (:'dealer_a', :'a_sales', 'TESTVINA00000001', 'Car A1', 'Alex', now() - interval '2 days', now() - interval '2 days' + interval '40 seconds', 'posted', 40),
  (:'dealer_a', :'a_sales', 'TESTVINA00000003', 'Car A3', 'Alex', now() - interval '1 day',  now() - interval '1 day' + interval '60 seconds',  'posted', 60),
  (:'dealer_b', :'b_sales', 'TESTVINB00000001', 'Car B1', 'Sam',  now() - interval '1 day',  now() - interval '1 day' + interval '50 seconds',  'posted', 50);

insert into public.todo_items (dealership_id, vin, kind, name, flagged_at) values
  (:'dealer_a', 'TESTVINA00000001', 'takeDown', 'Car A1', now() - interval '5 hours'),
  (:'dealer_b', 'TESTVINB00000001', 'price',    'Car B1', now() - interval '3 hours');

insert into public.rewrite_usage (dealership_id, user_id, model, input_tokens, output_tokens, cost_usd, kind) values
  (:'dealer_a', :'a_sales', 'claude-haiku-4-5', 1500, 200, 0.0025, 'rewrite'),
  (:'dealer_b', :'b_sales', 'claude-haiku-4-5', 1500, 200, 0.0025, 'rewrite');

insert into public.invites (code, dealership_id, role, created_by) values
  ('NEWCOMERB001', :'dealer_b', 'salesperson', :'b_sales'),
  ('made-up-b002', :'dealer_b', 'manager',     null); -- as the owner types the first code in SQL: any case

-- ---------------------------------------------------------------------------
-- a_sales: a salesperson of A
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  me uuid := auth.uid();
begin
  if me <> '00000000-0000-4000-8000-0000000000a1' then
    raise exception 'auth.uid() is % (the claims were not picked up)', me;
  end if;

  -- sees A's listings and only A's
  select count(*) into n from public.listings;
  if n <> 2 then raise exception 'a_sales should see the 2 listings of A, saw %', n; end if;
  if exists (select 1 from public.listings where dealership_id = b) then
    raise exception 'a_sales can see a listing of dealership B';
  end if;
  raise notice 'ok: a_sales sees only A''s listings';

  -- and only A's to-do items, post attempts, scans and rewrite usage
  select count(*) into n from public.todo_items where dealership_id = b;
  if n <> 0 then raise exception 'a_sales can see B''s to-do items'; end if;
  select count(*) into n from public.post_attempts where dealership_id = b;
  if n <> 0 then raise exception 'a_sales can see B''s post attempts'; end if;
  select count(*) into n from public.rewrite_usage;
  if n <> 1 then raise exception 'a_sales should see 1 rewrite_usage row (A''s), saw %', n; end if;
  select count(*) into n from public.dealerships;
  if n <> 1 then raise exception 'a_sales should see 1 dealership, saw %', n; end if;
  raise notice 'ok: a_sales sees nothing of B in any table';

  -- their own membership row and nobody else's
  select count(*) into n from public.memberships;
  if n <> 1 then raise exception 'a_sales should see only their own membership, saw % rows', n; end if;
  raise notice 'ok: a_sales sees only their own membership';

  -- cannot insert into B
  begin
    insert into public.listings (dealership_id, user_id, vin, name, price, posted_at)
    values (b, me, 'TESTVINX00000001', 'Sneaky', 1, now());
    raise exception 'a_sales inserted a listing into dealership B';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot insert a listing into B';
  end;

  -- cannot insert a listing in A under someone else's user_id
  begin
    insert into public.listings (dealership_id, user_id, vin, name, price, posted_at)
    values (a, '00000000-0000-4000-8000-0000000000a2', 'TESTVINX00000002', 'Not mine', 1, now());
    raise exception 'a_sales inserted a listing as another user';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot post as another user';
  end;

  -- can insert their own listing in A
  insert into public.listings (dealership_id, user_id, vin, name, price, posted_at, salesperson)
  values (a, me, 'TESTVINA00000004', 'Car A4', 22000, now(), 'Alex');
  raise notice 'ok: a_sales inserted their own listing';

  -- can update their own listing, cannot touch the manager's (RLS filters it out: 0 rows)
  update public.listings set price = 19500, updated_at = now() where id = '00000000-0000-4000-8000-0000000000e1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_sales could not update their own listing'; end if;
  update public.listings set price = 1 where id = '00000000-0000-4000-8000-0000000000e2';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a_sales updated the manager''s listing'; end if;
  raise notice 'ok: a_sales updates only their own listings';

  -- cannot delete anything (only managers delete)
  delete from public.listings where id = '00000000-0000-4000-8000-0000000000e1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a_sales deleted a listing'; end if;
  raise notice 'ok: a_sales cannot delete';

  -- to-do items: any member of A may add and close one, none in B
  insert into public.todo_items (dealership_id, vin, kind, name, flagged_at)
  values (a, 'TESTVINA00000002', 'price', 'Car A2', now());
  update public.todo_items set done_at = now(), how = 'manual' where dealership_id = a and vin = 'TESTVINA00000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_sales could not close a to-do item of A'; end if;
  begin
    insert into public.todo_items (dealership_id, vin, kind, name, flagged_at)
    values (b, 'TESTVINB00000001', 'takeDown', 'Car B1', now());
    raise exception 'a_sales inserted a to-do item into B';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales writes to-do items for A only';
  end;

  -- own post attempts and scans go in; B's do not
  insert into public.post_attempts (dealership_id, user_id, vin, started_at) values (a, me, 'TESTVINA00000004', now());
  insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count)
  values (a, 'https://www.dealership-a.test', now(), 40, 30, 1, 0);
  begin
    insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count)
    values (b, 'https://www.dealership-b.test', now(), 40, 30, 1, 0);
    raise exception 'a_sales recorded a scan for B';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales records attempts and scans for A only';
  end;

  -- invites are never readable (no privilege, or no rows: both are fine)
  begin
    select count(*) into n from public.invites;
    if n <> 0 then raise exception 'a_sales can read invite codes'; end if;
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: a_sales cannot read invites';

  -- cannot create invites
  begin
    perform public.create_invite(a, 'salesperson');
    raise exception 'a_sales created an invite';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot create invites';
  end;

  -- rewrite_usage is written only by the service role
  begin
    insert into public.rewrite_usage (dealership_id, user_id, model, input_tokens, output_tokens, cost_usd, kind)
    values (a, me, 'x', 1, 1, 0, 'rewrite');
    raise exception 'a_sales wrote to rewrite_usage';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot write rewrite_usage';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- a_mgr: a manager of A
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  inv jsonb;
begin
  -- sees A's post attempts (both salespeople's, plus the one a_sales just added) and none of B's
  select count(*) into n from public.post_attempts;
  if n <> 3 then raise exception 'a_mgr should see 3 post attempts of A, saw %', n; end if;
  if exists (select 1 from public.post_attempts where dealership_id = b) then
    raise exception 'a_mgr can see a post attempt of B';
  end if;
  raise notice 'ok: a_mgr sees A''s post attempts and none of B''s';

  -- sees everyone in A
  select count(*) into n from public.memberships;
  if n <> 2 then raise exception 'a_mgr should see 2 memberships of A, saw %', n; end if;
  if exists (select 1 from public.memberships where dealership_id = b) then
    raise exception 'a_mgr can see a membership of B';
  end if;
  raise notice 'ok: a_mgr sees A''s memberships only';

  -- sees all of A's listings (3 now) and can update and delete a salesperson's
  select count(*) into n from public.listings;
  if n <> 3 then raise exception 'a_mgr should see 3 listings of A, saw %', n; end if;
  update public.listings set listing_url = 'https://www.facebook.com/marketplace/item/1/' where id = '00000000-0000-4000-8000-0000000000e1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not update a salesperson''s listing'; end if;
  delete from public.listings where vin = 'TESTVINA00000004';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not delete a listing of A'; end if;
  raise notice 'ok: a_mgr updates and deletes listings of A';

  -- but still nothing in B
  update public.listings set price = 1 where id = '00000000-0000-4000-8000-0000000000e3';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a_mgr updated a listing of B'; end if;
  begin
    insert into public.listings (dealership_id, user_id, vin, name, price, posted_at)
    values (b, auth.uid(), 'TESTVINX00000003', 'Sneaky', 1, now());
    raise exception 'a_mgr inserted a listing into B';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr cannot write in B';
  end;

  -- can rename their dealership
  update public.dealerships set name = 'Dealership A (renamed)' where id = a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not rename A'; end if;

  -- creates invites for A, not for B
  inv := public.create_invite(a, 'salesperson');
  if length(inv ->> 'code') <> 12 then raise exception 'create_invite returned %', inv; end if;
  begin
    perform public.create_invite(b, 'salesperson');
    raise exception 'a_mgr created an invite for B';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr creates invites for A only';
  end;

  -- the views show A only
  select count(*) into n from public.v_salesperson_summary;
  if n <> 2 then raise exception 'v_salesperson_summary should have 2 rows for A, has %', n; end if;
  if exists (select 1 from public.v_salesperson_summary where dealership_id <> a) then
    raise exception 'v_salesperson_summary shows another dealership';
  end if;
  if (select median_seconds from public.v_salesperson_summary where user_id = '00000000-0000-4000-8000-0000000000a1') <> 50 then
    raise exception 'median seconds for a_sales should be 50';
  end if;
  select count(*) into n from public.v_open_todo;
  if n <> 1 then raise exception 'v_open_todo should have 1 open item for A, has %', n; end if;
  if (select salesperson from public.v_open_todo) <> 'Jamie' then
    raise exception 'v_open_todo should join the open item to the listing it belongs to';
  end if;
  raise notice 'ok: the views show A only';
end;
$$;

-- ---------------------------------------------------------------------------
-- b_sales: a salesperson of B
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'b_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  select count(*) into n from public.listings;
  if n <> 1 then raise exception 'b_sales should see the 1 listing of B, saw %', n; end if;
  if exists (select 1 from public.listings where dealership_id = a) then
    raise exception 'b_sales can see a listing of A';
  end if;
  select count(*) into n from public.todo_items where dealership_id = a;
  if n <> 0 then raise exception 'b_sales can see A''s to-do items'; end if;
  raise notice 'ok: b_sales sees only B';
end;
$$;

-- ---------------------------------------------------------------------------
-- newcomer: signed in, not yet a member; redeems an invite for B
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'newcomer' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  got jsonb;
  code text;
begin
  select count(*) into n from public.listings;
  if n <> 0 then raise exception 'a user with no membership sees % listings', n; end if;
  select count(*) into n from public.memberships;
  if n <> 0 then raise exception 'a user with no membership sees % memberships', n; end if;
  raise notice 'ok: without a membership nothing is visible';

  -- an unknown code
  begin
    perform public.redeem_invite('NOPE', 'Nobody');
    raise exception 'an unknown invite code was accepted';
  exception when others then
    if sqlstate <> 'P0002' then raise; end if;
  end;

  -- the real one (lower case and spaces are tolerated)
  got := public.redeem_invite(' newcomerb001 ', 'Riley');
  if (got ->> 'dealership_id')::uuid <> b or got ->> 'role' <> 'salesperson' or got ->> 'name' <> 'Riley' or got ->> 'website_origin' <> 'https://www.dealership-b.test' then
    raise exception 'redeem_invite returned %', got;
  end if;
  select count(*) into n from public.listings where dealership_id = b;
  if n <> 1 then raise exception 'after redeeming, the newcomer should see B''s listing'; end if;
  select count(*) into n from public.memberships where user_id = auth.uid() and dealership_id = b and role = 'salesperson';
  if n <> 1 then raise exception 'redeem_invite did not create the membership'; end if;
  raise notice 'ok: redeem_invite makes the newcomer a member of B';

  -- single use
  begin
    perform public.redeem_invite('NEWCOMERB001', 'Riley');
    raise exception 'a used invite code was accepted again';
  exception when others then
    if sqlstate <> 'P0003' then raise; end if;
  end;
  raise notice 'ok: an invite code works once';

  -- an owner-made lower-case code, typed the way the extension sends it
  -- (upper case, with spaces around it): found, and rejoining B with it
  -- takes the invite's role and keeps the name
  got := public.redeem_invite(' MADE-UP-B002 ', null);
  if (got ->> 'dealership_id')::uuid <> b or got ->> 'role' <> 'manager' or got ->> 'name' <> 'Riley' then
    raise exception 'redeeming a lower-case owner-made code returned %', got;
  end if;
  select count(*) into n from public.memberships where user_id = auth.uid() and dealership_id = b and role = 'manager';
  if n <> 1 then raise exception 'redeeming the second invite did not update the membership'; end if;
  raise notice 'ok: an invite code is matched ignoring case and surrounding spaces';
end;
$$;

-- the code is marked used (checked as the owner, since nobody else can read invites)
reset role;
do $$
begin
  if not exists (select 1 from public.invites where code = 'NEWCOMERB001' and used_by = '00000000-0000-4000-8000-0000000000c1' and used_at is not null) then
    raise exception 'the redeemed invite was not marked used';
  end if;
  if not exists (select 1 from public.invites where code = 'made-up-b002' and used_by = '00000000-0000-4000-8000-0000000000c1' and used_at is not null) then
    raise exception 'the redeemed lower-case invite was not marked used (it is stored as typed)';
  end if;
  raise notice 'ok: the redeemed invite is marked used';
end;
$$;

-- ---------------------------------------------------------------------------
-- anon: the public key with no user gets nothing
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true) as claims \gset
set local role anon;

do $$
declare
  n bigint;
begin
  begin
    select count(*) into n from public.listings;
    if n <> 0 then raise exception 'anon can read % listings', n; end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.redeem_invite('NEWCOMERB001', 'Nobody');
    raise exception 'anon could call redeem_invite';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: anon reads nothing and cannot redeem';
end;
$$;

reset role;
rollback;

\echo 'rls.sql: every check passed (all changes rolled back)'
