-- Lot Sync: the owner's privacy tools (0006_privacy.sql) against a running
-- database with the migrations applied, in the shape of rls.sql: people
-- straight in auth.users, DO blocks that raise on anything wrong,
-- everything in one transaction rolled back at the end. psql exits non-zero
-- on the first failed assertion.
--
--   user      dealership  role
--   a_mgr     A           manager (the only one)
--   a_sales   A           salesperson, asks to be forgotten
--   x_both    A and B     salesperson in both (sister stores)
--   b_mgr     B           manager
--   b_sales   B           salesperson
--
-- What it proves: export_dealership(A) holds every row of A in every table,
-- member emails included, and the time A was signed up (not by whom), and
-- nothing of B; no API role, the service role included, can execute any of
-- the functions; forget_person refuses a wrong email and the last manager,
-- then removes a_sales's account, memberships, codes, misses, sign-up
-- attempt and demo request, clears their name and leaves every other row as
-- it was; delete_dealership refuses anything but A's exact website_origin,
-- then takes A and everything it owns, keeps the billing events, the
-- accounts and a_mgr's sign-up attempt (without A, so a_mgr's per_account
-- still counts it), says which accounts belong to no dealership now, and
-- leaves B as it was.

\set ON_ERROR_STOP on
\set a_mgr     '00000000-0000-4000-8000-0000000000a2'
\set a_sales   '00000000-0000-4000-8000-0000000000a1'
\set x_both    '00000000-0000-4000-8000-0000000000a3'
\set b_mgr     '00000000-0000-4000-8000-0000000000b2'
\set b_sales   '00000000-0000-4000-8000-0000000000b1'
\set dealer_a  '00000000-0000-4000-8000-0000000000d1'
\set dealer_b  '00000000-0000-4000-8000-0000000000d2'

begin;

-- Supabase keeps its auth audit log here when the project writes it to the
-- database; a plain Postgres has no such table, so the test makes one with
-- Supabase's columns (rolled back with the rest).
create table if not exists auth.audit_log_entries (
  instance_id uuid,
  id uuid not null primary key,
  payload json,
  created_at timestamptz,
  ip_address varchar(64) not null default ''
);

-- ---------------------------------------------------------------------------
-- Fixture (as the owner): two dealerships with rows in every table
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'a_mgr',   'authenticated', 'authenticated', 'a-mgr@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_sales', 'authenticated', 'authenticated', 'a-sales@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'x_both',  'authenticated', 'authenticated', 'x-both@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_mgr',   'authenticated', 'authenticated', 'b-mgr@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_sales', 'authenticated', 'authenticated', 'b-sales@example.test', now(), now());

insert into public.dealerships (id, name, website_origin) values
  (:'dealer_a', 'Dealership A', 'https://www.dealership-a.test'),
  (:'dealer_b', 'Dealership B', 'https://www.dealership-b.test');

insert into public.memberships (user_id, dealership_id, role, name) values
  (:'a_mgr',   :'dealer_a', 'manager',     'Jamie'),
  (:'a_sales', :'dealer_a', 'salesperson', 'Alex'),
  (:'x_both',  :'dealer_a', 'salesperson', 'Casey'),
  (:'x_both',  :'dealer_b', 'salesperson', 'Casey'),
  (:'b_mgr',   :'dealer_b', 'manager',     'Sam'),
  (:'b_sales', :'dealer_b', 'salesperson', 'Robin');

insert into public.listings (id, dealership_id, user_id, vin, name, price, posted_at, listing_url, salesperson, status, taken_down_at) values
  ('00000000-0000-4000-8000-0000000000e1', :'dealer_a', :'a_sales', 'TESTVINA00000001', 'Car A1', 20000, now() - interval '3 days', 'https://www.facebook.com/marketplace/item/1001/', 'Alex',  'listed',     null),
  ('00000000-0000-4000-8000-0000000000e2', :'dealer_a', :'a_sales', 'TESTVINA00000002', 'Car A2', 21000, now() - interval '4 days', 'https://www.facebook.com/marketplace/item/1002/', 'Alex',  'taken_down', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000000e3', :'dealer_a', :'a_mgr',   'TESTVINA00000003', 'Car A3', 22000, now() - interval '2 days', 'https://www.facebook.com/marketplace/item/1003/', 'Jamie', 'listed',     null),
  ('00000000-0000-4000-8000-0000000000e4', :'dealer_a', :'x_both',  'TESTVINA00000004', 'Car A4', 23000, now() - interval '1 day',  null,                                              'Casey', 'listed',     null),
  ('00000000-0000-4000-8000-0000000000e5', :'dealer_b', :'b_sales', 'TESTVINB00000001', 'Car B1', 30000, now() - interval '1 day',  'https://www.facebook.com/marketplace/item/2001/', 'Robin', 'listed',     null),
  ('00000000-0000-4000-8000-0000000000e6', :'dealer_b', :'x_both',  'TESTVINB00000002', 'Car B2', 31000, now() - interval '2 days', 'https://www.facebook.com/marketplace/item/2002/', 'Casey', 'taken_down', now() - interval '1 hour');

insert into public.todo_items (dealership_id, vin, kind, name, flagged_at, done_at, how, from_price, to_price) values
  (:'dealer_a', 'TESTVINA00000002', 'takeDown', 'Car A2', now() - interval '2 days', now() - interval '1 day', 'manual', null, null),
  (:'dealer_a', 'TESTVINA00000003', 'price',    'Car A3', now() - interval '5 hours', null, null, 22000, 21500),
  (:'dealer_b', 'TESTVINB00000001', 'price',    'Car B1', now() - interval '3 hours', null, null, 30000, 29500);

insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count) values
  (:'dealer_a', 'https://www.dealership-a.test', now() - interval '1 day', 40, 30, 1, 0),
  (:'dealer_a', 'https://www.dealership-a.test', now(),                    41, 31, 0, 1),
  (:'dealer_b', 'https://www.dealership-b.test', now(),                    90, 70, 0, 1);

insert into public.post_attempts (dealership_id, user_id, vin, name, salesperson, started_at, ended_at, outcome, seconds) values
  (:'dealer_a', :'a_sales', 'TESTVINA00000001', 'Car A1', 'Alex',  now() - interval '3 days', now() - interval '3 days' + interval '40 seconds', 'posted', 40),
  (:'dealer_a', :'a_sales', 'TESTVINA00000002', 'Car A2', 'Alex',  now() - interval '4 days', now() - interval '4 days' + interval '55 seconds', 'posted', 55),
  (:'dealer_a', :'x_both',  'TESTVINA00000004', 'Car A4', 'Casey', now() - interval '1 day',  now() - interval '1 day' + interval '30 seconds',  'posted', 30),
  (:'dealer_b', :'b_sales', 'TESTVINB00000001', 'Car B1', 'Robin', now() - interval '1 day',  now() - interval '1 day' + interval '50 seconds',  'posted', 50);

insert into public.rewrite_usage (dealership_id, user_id, model, input_tokens, output_tokens, cost_usd, kind) values
  (:'dealer_a', :'a_sales', 'test-model', 1500, 200, 0.0025, 'rewrite'),
  (:'dealer_a', :'x_both',  'test-model', 900,  40,  0.0011, 'color'),
  (:'dealer_b', :'b_sales', 'test-model', 1500, 200, 0.0025, 'rewrite');

insert into public.invites (code, dealership_id, role, created_by, created_at, used_by, used_at) values
  ('AUNUSED00001', :'dealer_a', 'salesperson', :'a_mgr',   now() - interval '1 day',  null,       null),                    -- open: its code stays out of the export
  ('AUSED0000002', :'dealer_a', 'salesperson', :'a_mgr',   now() - interval '9 days', :'a_sales', now() - interval '8 days'), -- how a_sales joined
  ('ASALES000003', :'dealer_a', 'salesperson', :'a_sales', now() - interval '2 days', null,       null),                    -- made by the owner in a_sales's name
  ('BUNUSED00001', :'dealer_b', 'salesperson', :'b_mgr',   now() - interval '1 day',  null,       null);

insert into public.invite_misses (user_id, at) values
  (:'a_sales', now() - interval '10 minutes'),
  (:'a_sales', now() - interval '5 minutes'),
  (:'b_sales', now() - interval '5 minutes');

insert into public.subscriptions (dealership_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, seats) values
  (:'dealer_a', 'cus_a', 'sub_a', 'active', now() + interval '20 days', 5),
  (:'dealer_b', 'cus_b', 'sub_b', 'active', now() + interval '10 days', 7);

-- A's events: one by customer and metadata, one by the metadata Stripe copies onto an invoice (another customer id,
-- as after a customer was recreated), one by customer only that carries a_sales's email; then B's, and one of nobody's
insert into public.billing_events (stripe_event_id, type, payload) values
  ('evt_a1', 'customer.subscription.updated', jsonb_build_object('id', 'evt_a1', 'data', jsonb_build_object('object', jsonb_build_object('object', 'subscription', 'id', 'sub_a', 'customer', 'cus_a', 'metadata', jsonb_build_object('dealership_id', :'dealer_a'))))),
  ('evt_a2', 'invoice.paid',                  jsonb_build_object('id', 'evt_a2', 'data', jsonb_build_object('object', jsonb_build_object('object', 'invoice', 'customer', 'cus_a_before', 'parent', jsonb_build_object('subscription_details', jsonb_build_object('metadata', jsonb_build_object('dealership_id', :'dealer_a'))))))),
  ('evt_a3', 'invoice.payment_failed',        jsonb_build_object('id', 'evt_a3', 'data', jsonb_build_object('object', jsonb_build_object('object', 'invoice', 'customer', 'cus_a', 'customer_email', 'a-sales@example.test')))),
  ('evt_b1', 'customer.subscription.created', jsonb_build_object('id', 'evt_b1', 'data', jsonb_build_object('object', jsonb_build_object('object', 'subscription', 'id', 'sub_b', 'customer', 'cus_b', 'metadata', jsonb_build_object('dealership_id', :'dealer_b'))))),
  ('evt_x1', 'customer.subscription.created', jsonb_build_object('id', 'evt_x1', 'data', jsonb_build_object('object', jsonb_build_object('object', 'subscription', 'id', 'sub_x', 'customer', 'cus_x'))));

insert into public.demo_requests (name, dealership, website, email) values
  ('Alex', 'Dealership A', 'https://www.dealership-a.test', ' A-Sales@Example.test '),
  ('Sam',  'Dealership B', 'https://www.dealership-b.test', 'b-mgr@example.test');

-- a_mgr signed A up and b_mgr B (0007_signup.sql); a_sales once asked for a website that was taken
insert into public.signup_attempts (user_id, at, outcome, dealership_id) values
  (:'a_mgr',   now() - interval '40 days', 'created', :'dealer_a'),
  (:'b_mgr',   now() - interval '30 days', 'created', :'dealer_b'),
  (:'a_sales', now() - interval '20 days', 'taken',   null);

insert into auth.audit_log_entries (id, payload, created_at) values
  ('00000000-0000-4000-8000-0000000000f1', json_build_object('action', 'login', 'actor_id', :'a_sales', 'actor_username', 'a-sales@example.test'), now()),
  ('00000000-0000-4000-8000-0000000000f2', json_build_object('action', 'token_refreshed', 'actor_id', :'a_sales', 'actor_username', 'a-sales@example.test'), now()),
  ('00000000-0000-4000-8000-0000000000f3', json_build_object('action', 'login', 'actor_id', :'a_mgr', 'actor_username', 'a-mgr@example.test'), now());

-- Everything that is not A's and not a_sales's, as one hash: it must read
-- the same after the forget and after the delete. (The ids are spelled out:
-- psql variables do not reach inside a function body.)
create function pg_temp.others() returns text
language sql stable as $$
  select md5(string_agg(r, E'\n' order by r))
  from (
    select 'dealerships ' || to_jsonb(x)::text r from public.dealerships x where x.id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'memberships ' || to_jsonb(x)::text from public.memberships x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'listings ' || to_jsonb(x)::text from public.listings x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'todo_items ' || to_jsonb(x)::text from public.todo_items x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'scan_summaries ' || to_jsonb(x)::text from public.scan_summaries x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'post_attempts ' || to_jsonb(x)::text from public.post_attempts x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'rewrite_usage ' || to_jsonb(x)::text from public.rewrite_usage x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'invites ' || to_jsonb(x)::text from public.invites x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'subscriptions ' || to_jsonb(x)::text from public.subscriptions x where x.dealership_id <> '00000000-0000-4000-8000-0000000000d1'
    union all select 'billing_events ' || to_jsonb(x)::text from public.billing_events x
    union all select 'invite_misses ' || to_jsonb(x)::text from public.invite_misses x where x.user_id <> '00000000-0000-4000-8000-0000000000a1'
    union all select 'demo_requests ' || to_jsonb(x)::text from public.demo_requests x where lower(trim(x.email)) <> 'a-sales@example.test'
    -- a_mgr's is A's (it created A; checked by name after the delete)
    union all select 'signup_attempts ' || to_jsonb(x)::text from public.signup_attempts x
      where x.user_id not in ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2')
    union all select 'auth.users ' || to_jsonb(x)::text from auth.users x where x.id <> '00000000-0000-4000-8000-0000000000a1'
    union all select 'audit ' || x.id::text || x.payload::text from auth.audit_log_entries x where x.payload ->> 'actor_id' <> '00000000-0000-4000-8000-0000000000a1'
  ) s;
$$;
create temp table snapshot as select pg_temp.others() as others;

-- ---------------------------------------------------------------------------
-- No API role can execute the functions; the owner can
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  who text;
begin
  foreach fn in array array['public.export_dealership(uuid)', 'public.delete_dealership(uuid, text)', 'public.forget_person(uuid, text)', 'public.billing_events_of(uuid)'] loop
    foreach who in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(who, fn, 'execute') then
        raise exception '% may execute %', who, fn;
      end if;
    end loop;
    if not has_function_privilege(current_user, fn, 'execute') then
      raise exception 'the owner (%) cannot execute %', current_user, fn;
    end if;
  end loop;
  raise notice 'ok: execute is revoked from public, anon, authenticated and service_role';
end;
$$;

-- a signed-in manager of A, calling as the API would
select set_config('request.jwt.claims', '{"sub":"' || :'a_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  begin
    perform public.export_dealership(a);
    raise exception 'a signed-in manager exported their dealership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.delete_dealership(a, 'https://www.dealership-a.test');
    raise exception 'a signed-in manager deleted their dealership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.forget_person('00000000-0000-4000-8000-0000000000a1', 'a-sales@example.test');
    raise exception 'a signed-in manager forgot a salesperson';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.billing_events_of(a);
    raise exception 'a signed-in manager read billing events';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: a signed-in manager can call none of them';
end;
$$;

-- the service role, as inside an Edge Function
reset role;
select set_config('request.jwt.claims', '', true) as claims \gset
set local role service_role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  begin
    perform public.export_dealership(a);
    raise exception 'the service role exported a dealership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.delete_dealership(a, 'https://www.dealership-a.test');
    raise exception 'the service role deleted a dealership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.forget_person('00000000-0000-4000-8000-0000000000a1', 'a-sales@example.test');
    raise exception 'the service role forgot a person';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: the service role can call none of them';
end;
$$;

-- the anon key
reset role;
set local role anon;
do $$
begin
  begin
    perform public.export_dealership('00000000-0000-4000-8000-0000000000d1');
    raise exception 'anon exported a dealership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.forget_person('00000000-0000-4000-8000-0000000000a1', 'a-sales@example.test');
    raise exception 'anon forgot a person';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: anon can call none of them';
end;
$$;
reset role;

-- nothing the refused calls could have touched has changed
do $$
begin
  if (select others from snapshot) <> pg_temp.others() then raise exception 'a refused call changed something'; end if;
  if not exists (select 1 from public.dealerships where id = '00000000-0000-4000-8000-0000000000d1') then raise exception 'A is gone'; end if;
  if not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000000a1') then raise exception 'a_sales is gone'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- export_dealership(A), as the owner
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  e jsonb;
  t text;
  n bigint;
  txt text;
begin
  e := public.export_dealership(a);
  if e -> 'dealership' <> (select to_jsonb(d) from public.dealerships d where d.id = a) then
    raise exception 'the export''s dealership is not A''s row: %', e -> 'dealership';
  end if;

  -- every row of A, as stored, in the tables exported as they are; and no more
  foreach t in array array['listings', 'todo_items', 'scan_summaries', 'post_attempts', 'rewrite_usage', 'subscriptions'] loop
    execute format('select count(*) from public.%I x where x.dealership_id = $1', t) into n using a;
    if n = 0 then raise exception 'the fixture has no % row for A', t; end if;
    if jsonb_array_length(e -> t) <> n or (e -> 'counts' ->> t)::bigint <> n then
      raise exception 'the export has % % rows (counts says %), A has %', jsonb_array_length(e -> t), t, e -> 'counts' ->> t, n;
    end if;
    execute format('select count(*) from public.%I x where x.dealership_id = $1 and not ($2 -> %L) @> jsonb_build_array(to_jsonb(x))', t, t) into n using a, e;
    if n <> 0 then raise exception '% of A''s % rows are not in the export as stored', n, t; end if;
    if exists (select 1 from jsonb_array_elements(e -> t) x where (x ->> 'dealership_id')::uuid <> a) then
      raise exception 'the export''s % holds a row of another dealership', t;
    end if;
  end loop;
  raise notice 'ok: the export holds every listing, to-do item, scan, post attempt, rewrite call and subscription of A';

  -- memberships: A's three, each with its account's email, and x_both's B membership left out
  if jsonb_array_length(e -> 'memberships') <> 3 then raise exception 'the export has % memberships, A has 3', jsonb_array_length(e -> 'memberships'); end if;
  if exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
             where m.dealership_id = a
               and not (e -> 'memberships') @> jsonb_build_array(to_jsonb(m) || jsonb_build_object('email', u.email))) then
    raise exception 'a membership of A is missing from the export, or its email is';
  end if;
  if exists (select 1 from jsonb_array_elements(e -> 'memberships') x where (x ->> 'dealership_id')::uuid <> a) then
    raise exception 'the export holds a membership of another dealership';
  end if;
  raise notice 'ok: the export holds A''s members with their emails';

  -- invites: all three of A; the used code is there, the unused codes are not
  if jsonb_array_length(e -> 'invites') <> 3 then raise exception 'the export has % invites, A has 3', jsonb_array_length(e -> 'invites'); end if;
  if exists (select 1 from jsonb_array_elements(e -> 'invites') x where x ->> 'used_at' is null and x ->> 'code' is not null) then
    raise exception 'the export carries the code of an unused invite';
  end if;
  if not (e -> 'invites') @> jsonb_build_array(jsonb_build_object('code', 'AUSED0000002', 'used_by', '00000000-0000-4000-8000-0000000000a1')) then
    raise exception 'the export lacks the used invite';
  end if;
  if (select count(*) from jsonb_array_elements(e -> 'invites') x where x ->> 'used_at' is null and x -> 'created_by' is not null and x ? 'expires_at') <> 2 then
    raise exception 'the unused invites are not in the export without their codes';
  end if;
  raise notice 'ok: the export holds A''s invites, the unused ones without their codes';

  -- billing events: A's three (by customer, by the invoice''s copied metadata, by customer only), nobody else's
  if (select array_agg(x ->> 'stripe_event_id' order by x ->> 'stripe_event_id') from jsonb_array_elements(e -> 'billing_events') x) <> array['evt_a1', 'evt_a2', 'evt_a3'] then
    raise exception 'the export''s billing events are %, not evt_a1, evt_a2 and evt_a3', (select array_agg(x ->> 'stripe_event_id') from jsonb_array_elements(e -> 'billing_events') x);
  end if;
  raise notice 'ok: the export holds A''s billing events, matched by customer and by metadata';

  -- the time A was signed up and the outcome, and not who did it: that is a_mgr's account's record
  if e -> 'signup_attempts' is distinct from (select jsonb_agg(jsonb_build_object('at', x.at, 'outcome', 'created')) from public.signup_attempts x where x.dealership_id = a)
     or (e -> 'counts' ->> 'signup_attempts')::int is distinct from 1 then
    raise exception 'the export''s signup_attempts is %, not the time A was signed up', e -> 'signup_attempts';
  end if;
  if position('00000000-0000-4000-8000-0000000000a2' in (e -> 'signup_attempts')::text) > 0 then
    raise exception 'the export says which account signed A up';
  end if;
  raise notice 'ok: the export says when A was signed up, and not by whom';

  -- nothing of B anywhere in the document, and nothing that is not the dealership's
  txt := e::text;
  foreach t in array array[b::text, 'Dealership B', 'dealership-b.test', 'TESTVINB', 'Robin', 'Sam', 'b-mgr@example.test', 'b-sales@example.test',
                           'BUNUSED00001', 'AUNUSED00001', 'ASALES000003', 'cus_b', 'sub_b', 'evt_b1', 'evt_x1'] loop
    if position(t in txt) > 0 then raise exception 'the export of A contains "%"', t; end if;
  end loop;
  foreach t in array array['memberships', 'listings', 'todo_items', 'scan_summaries', 'post_attempts', 'rewrite_usage', 'invites', 'subscriptions', 'billing_events', 'signup_attempts'] loop
    if not e ? t then raise exception 'the export has no % list', t; end if;
  end loop;
  if e ? 'invite_misses' or e ? 'demo_requests' then raise exception 'the export holds rows that are not the dealership''s'; end if;
  raise notice 'ok: the export of A holds nothing of B';

  -- an id that is no dealership
  begin
    perform public.export_dealership('00000000-0000-4000-8000-00000000ffff');
    raise exception 'an unknown dealership was exported';
  exception when others then
    if sqlstate <> 'P0002' then raise; end if;
  end;
  raise notice 'ok: an unknown id is refused';
end;
$$;

-- A member a manager removes (the Team card's Remove) leaves the export's
-- memberships, email and all, but the rows they made keep their user_id and
-- their name, and the export's notes say so. Undone at once: the steps
-- below need x_both in A.
savepoint removed_member;
delete from public.memberships where user_id = :'x_both' and dealership_id = :'dealer_a';
do $$
declare
  x text := '00000000-0000-4000-8000-0000000000a3';
  e jsonb := public.export_dealership('00000000-0000-4000-8000-0000000000d1');
begin
  if exists (select 1 from jsonb_array_elements(e -> 'memberships') m where m ->> 'user_id' = x) or position('x-both@example.test' in e::text) > 0 then
    raise exception 'the export still lists a removed member, or their email';
  end if;
  if not exists (select 1 from jsonb_array_elements(e -> 'listings') l where l ->> 'user_id' = x and l ->> 'salesperson' = 'Casey')
     or not exists (select 1 from jsonb_array_elements(e -> 'post_attempts') a where a ->> 'user_id' = x and a ->> 'salesperson' = 'Casey') then
    raise exception 'a removed member''s rows lost their user_id or name';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(e -> 'notes') n
                 where n like '%no longer members have no email here; the rows they made keep their user_id and the salesperson name they posted under%') then
    raise exception 'the export''s notes do not say that a former member''s rows keep their name: %', e -> 'notes';
  end if;
  raise notice 'ok: a removed member''s rows keep their user_id and name in the export, as its notes say';
end;
$$;
rollback to savepoint removed_member;

-- ---------------------------------------------------------------------------
-- forget_person, as the owner
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  a_sales uuid := '00000000-0000-4000-8000-0000000000a1';
  a_mgr uuid := '00000000-0000-4000-8000-0000000000a2';
  bad text;
  got jsonb;
  e jsonb;
begin
  -- a wrong email, somebody else's, none: refused, nothing changed
  foreach bad in array array['a-sales@example.tes', 'b-sales@example.test', '', ' a-sales@example.test'] loop
    begin
      perform public.forget_person(a_sales, bad);
      raise exception 'forget_person accepted "%" as a-sales@example.test', bad;
    exception when others then
      if sqlstate <> 'P0007' then raise; end if;
    end;
  end loop;
  begin
    perform public.forget_person(a_sales, null);
    raise exception 'forget_person accepted no confirm';
  exception when others then
    if sqlstate <> 'P0007' then raise; end if;
  end;
  begin
    perform public.forget_person('00000000-0000-4000-8000-00000000ffff', 'a-sales@example.test');
    raise exception 'forget_person found an account that does not exist';
  exception when others then
    if sqlstate <> 'P0002' then raise; end if;
  end;
  if not exists (select 1 from public.memberships where user_id = a_sales) or not exists (select 1 from auth.users where id = a_sales) then
    raise exception 'a refused forget_person changed something';
  end if;
  raise notice 'ok: forget_person refuses anything but the account''s email';

  -- the last manager of A: refused with the trigger's code, naming A, nothing changed
  begin
    perform public.forget_person(a_mgr, 'a-mgr@example.test');
    raise exception 'forget_person removed the last manager of A';
  exception when others then
    if sqlstate <> 'P0006' then raise; end if;
    if position('Dealership A' in sqlerrm) = 0 then raise exception 'the refusal does not name the dealership: %', sqlerrm; end if;
  end;
  if not exists (select 1 from public.memberships where user_id = a_mgr and role = 'manager') or not exists (select 1 from auth.users where id = a_mgr) then
    raise exception 'the refused forget changed the last manager';
  end if;
  raise notice 'ok: forget_person refuses the last manager of a dealership and names it';

  -- the person's own request (their email, in another case)
  got := public.forget_person(a_sales, 'A-Sales@Example.TEST');
  if (got ->> 'forgotten')::boolean is not true
     or got -> 'removed' <> jsonb_build_object('memberships', 1, 'unused_invites', 1, 'invite_misses', 2, 'demo_requests', 1, 'signup_attempts', 1, 'auth_audit_log_entries', 2, 'auth_users', 1)
     or got -> 'cleared' <> jsonb_build_object('listings_salesperson', 2, 'listings_link_taken_down', 1, 'post_attempts_salesperson', 2)
     or got -> 'kept' <> jsonb_build_object('listings', 2, 'listing_links_still_listed', 1, 'post_attempts', 2, 'rewrite_usage', 1, 'used_invites', 1, 'billing_events_with_their_email', 1) then
    raise exception 'forget_person answered %', got;
  end if;

  -- gone: the account, the membership, the code made in their name, the misses, the demo request, the audit entries
  if exists (select 1 from auth.users where id = a_sales) then raise exception 'the auth row survived'; end if;
  if exists (select 1 from public.memberships where user_id = a_sales) then raise exception 'a membership survived'; end if;
  if exists (select 1 from public.invites where code = 'ASALES000003') then raise exception 'their unused code survived'; end if;
  if exists (select 1 from public.invite_misses where user_id = a_sales) then raise exception 'their invite misses survived'; end if;
  if exists (select 1 from public.signup_attempts where user_id = a_sales) then raise exception 'their sign-up attempt survived'; end if;
  if exists (select 1 from public.demo_requests where lower(trim(email)) = 'a-sales@example.test') then raise exception 'their demo request survived'; end if;
  if exists (select 1 from auth.audit_log_entries where payload ->> 'actor_id' = a_sales::text) then raise exception 'their audit entries survived'; end if;

  -- kept as the dealership's numbers, without their name; the link only where the car is still listed
  if (select count(*) from public.listings where user_id = a_sales and salesperson is null) <> 2 then raise exception 'their listings lost rows or kept the name'; end if;
  if (select listing_url from public.listings where id = '00000000-0000-4000-8000-0000000000e2') is not null then raise exception 'the link of a taken-down listing survived'; end if;
  if (select listing_url from public.listings where id = '00000000-0000-4000-8000-0000000000e1') is null then raise exception 'the link of a listing still up was cleared'; end if;
  if (select count(*) from public.post_attempts where user_id = a_sales and salesperson is null and seconds is not null) <> 2 then raise exception 'their post attempts lost rows or kept the name'; end if;
  if not exists (select 1 from public.invites where code = 'AUSED0000002' and used_by = a_sales) then raise exception 'the used invite (how they joined) went'; end if;
  if (select count(*) from public.rewrite_usage where user_id = a_sales) <> 1 then raise exception 'their rewrite usage went'; end if;

  -- A's other people untouched
  if (select salesperson from public.listings where id = '00000000-0000-4000-8000-0000000000e3') <> 'Jamie'
     or (select salesperson from public.listings where id = '00000000-0000-4000-8000-0000000000e4') <> 'Casey'
     or not exists (select 1 from public.invites where code = 'AUNUSED00001') then
    raise exception 'forgetting a_sales changed another person''s rows';
  end if;

  -- and nothing that is not A's changed at all
  if (select others from snapshot) <> pg_temp.others() then raise exception 'forgetting a_sales changed a row of B or of another person'; end if;

  -- their name and email are nowhere in A's records any more, bar the billing event kept for accounting
  e := public.export_dealership(a);
  if position('Alex' in (e - 'billing_events')::text) > 0 or position('a-sales@example.test' in lower((e - 'billing_events')::text)) > 0 then
    raise exception 'the export still names a_sales';
  end if;
  raise notice 'ok: forget_person removes a_sales, clears their name, keeps the dealership''s numbers and changes nothing else';
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_dealership, as the owner
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  bad text;
  got jsonb;
  t text;
  n bigint;
  before jsonb;
begin
  before := jsonb_build_object(
    'dealerships', 1,
    'memberships', (select count(*) from public.memberships where dealership_id = a),
    'listings', (select count(*) from public.listings where dealership_id = a),
    'todo_items', (select count(*) from public.todo_items where dealership_id = a),
    'scan_summaries', (select count(*) from public.scan_summaries where dealership_id = a),
    'post_attempts', (select count(*) from public.post_attempts where dealership_id = a),
    'rewrite_usage', (select count(*) from public.rewrite_usage where dealership_id = a),
    'invites', (select count(*) from public.invites where dealership_id = a),
    'subscriptions', (select count(*) from public.subscriptions where dealership_id = a));

  -- anything but A's exact origin: refused, nothing deleted
  foreach bad in array array['https://www.dealership-a.test/', 'https://WWW.dealership-a.test', ' https://www.dealership-a.test', 'www.dealership-a.test',
                             'https://www.dealership-b.test', 'Dealership A', ''] loop
    begin
      perform public.delete_dealership(a, bad);
      raise exception 'delete_dealership accepted "%" for A', bad;
    exception when others then
      if sqlstate <> 'P0007' then raise; end if;
    end;
  end loop;
  begin
    perform public.delete_dealership(a, null);
    raise exception 'delete_dealership accepted no confirm';
  exception when others then
    if sqlstate <> 'P0007' then raise; end if;
  end;
  begin
    perform public.delete_dealership('00000000-0000-4000-8000-00000000ffff', 'https://www.dealership-a.test');
    raise exception 'delete_dealership found a dealership that does not exist';
  exception when others then
    if sqlstate <> 'P0002' then raise; end if;
  end;
  if (select count(*) from public.listings where dealership_id = a) <> (before ->> 'listings')::bigint
     or not exists (select 1 from public.dealerships where id = a) then
    raise exception 'a refused delete_dealership deleted something';
  end if;
  raise notice 'ok: delete_dealership refuses anything but the exact website_origin';

  -- the right one
  got := public.delete_dealership(a, 'https://www.dealership-a.test');
  if (got ->> 'deleted')::boolean is not true or got -> 'removed' <> before then
    raise exception 'delete_dealership removed %, A had %', got -> 'removed', before;
  end if;
  if got ->> 'stripe_customer_id' <> 'cus_a' or got ->> 'stripe_subscription_id' <> 'sub_a' or (got -> 'kept' ->> 'billing_events')::bigint <> 3 then
    raise exception 'delete_dealership does not name the Stripe customer or the kept events: %', got;
  end if;
  -- a_mgr now belongs to no dealership; x_both still works at B
  if got -> 'accounts_without_a_dealership' <> jsonb_build_array(jsonb_build_object('user_id', '00000000-0000-4000-8000-0000000000a2', 'email', 'a-mgr@example.test')) then
    raise exception 'accounts_without_a_dealership is %', got -> 'accounts_without_a_dealership';
  end if;
  if jsonb_array_length(got -> 'next') <> 2 then raise exception 'the answer does not give the two next steps: %', got -> 'next'; end if;

  -- A is gone from every table
  foreach t in array array['memberships', 'listings', 'todo_items', 'scan_summaries', 'post_attempts', 'rewrite_usage', 'invites', 'subscriptions'] loop
    execute format('select count(*) from public.%I x where x.dealership_id = $1', t) into n using a;
    if n <> 0 then raise exception '% % rows of A survived', n, t; end if;
  end loop;
  if exists (select 1 from public.dealerships where id = a) then raise exception 'A survived'; end if;

  -- kept: the accounting record and the accounts
  if (select count(*) from public.billing_events where stripe_event_id in ('evt_a1', 'evt_a2', 'evt_a3')) <> 3 then raise exception 'A''s billing events were deleted'; end if;
  if not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000000a2') then raise exception 'a_mgr''s account was deleted'; end if;
  if (select array_agg(outcome || ' ' || coalesce(dealership_id::text, 'none')) from public.signup_attempts where user_id = '00000000-0000-4000-8000-0000000000a2') is distinct from array['created none'] then
    raise exception 'a_mgr''s sign-up attempt did not stay, without A: it is what per_account counts';
  end if;

  -- B, and everything else, exactly as before
  if (select others from snapshot) <> pg_temp.others() then raise exception 'deleting A changed a row of B or of another person'; end if;
  if (select count(*) from public.memberships where user_id = '00000000-0000-4000-8000-0000000000a3') <> 1 then raise exception 'x_both lost their B membership'; end if;
  raise notice 'ok: delete_dealership takes A and all it owns, keeps billing events and accounts, and leaves B as it was';

  begin
    perform public.export_dealership(a);
    raise exception 'a deleted dealership was exported';
  exception when others then
    if sqlstate <> 'P0002' then raise; end if;
  end;
end;
$$;

rollback;

\echo 'privacy.sql: every check passed (all changes rolled back)'
