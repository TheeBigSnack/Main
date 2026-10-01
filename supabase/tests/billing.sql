-- Lot Current: billing checks (Milestone 5) against a running database with
-- the migrations applied, in the shape of rls.sql: two dealerships
-- and their people straight in auth.users, the JWT claims set the way
-- PostgREST does, DO blocks that raise on anything wrong, everything rolled
-- back at the end. psql exits non-zero on the first failed assertion.
--
--   user       dealership  role
--   a_sales    A           salesperson
--   a_mgr      A           manager
--   b_mgr      B           manager
--
-- What it proves: a manager starts the pilot once and only once; a
-- salesperson cannot; members read their own dealership's row and nothing
-- else; no signed-in user writes subscriptions or reads billing_events;
-- a scheduled cancellation (cancel_at, 0009_cancel_at.sql) is read by
-- members, written by no signed-in user, and leaves the state active until
-- it ends; subscription_state() says none, pilot, active or lapsed the same
-- way functions/_shared/billing.mjs does; a customer shell does not block the
-- pilot; the anon key gets nothing.

\set ON_ERROR_STOP on
\set a_sales   '00000000-0000-4000-8000-0000000000a1'
\set a_mgr     '00000000-0000-4000-8000-0000000000a2'
\set b_mgr     '00000000-0000-4000-8000-0000000000b2'
\set dealer_a  '00000000-0000-4000-8000-0000000000d1'
\set dealer_b  '00000000-0000-4000-8000-0000000000d2'
\set dealer_c  '00000000-0000-4000-8000-0000000000d3'

begin;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner role, which is not under RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'a_sales', 'authenticated', 'authenticated', 'a-sales@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_mgr',   'authenticated', 'authenticated', 'a-mgr@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_mgr',   'authenticated', 'authenticated', 'b-mgr@example.test',   now(), now());

insert into public.dealerships (id, name, website_origin) values
  (:'dealer_a', 'Dealership A', 'https://www.dealership-a.test'),
  (:'dealer_b', 'Dealership B', 'https://www.dealership-b.test'),
  (:'dealer_c', 'Dealership C', 'https://www.dealership-c.test');

insert into public.memberships (user_id, dealership_id, role, name) values
  (:'a_sales', :'dealer_a', 'salesperson', 'Alex'),
  (:'a_mgr',   :'dealer_a', 'manager',     'Jamie'),
  (:'b_mgr',   :'dealer_b', 'manager',     'Sam');

-- B already pays, and has cancelled in the portal (it ends with the period); C has only the shell of a row (a checkout opened and not finished)
insert into public.subscriptions (dealership_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at, seats) values
  (:'dealer_b', 'cus_b', 'sub_b', 'active', now() + interval '20 days', now() + interval '20 days', 7);
insert into public.subscriptions (dealership_id, stripe_customer_id) values
  (:'dealer_c', 'cus_c');

insert into public.billing_events (stripe_event_id, type, payload) values
  ('evt_test_1', 'customer.subscription.created', '{"id":"evt_test_1"}'::jsonb);

-- ---------------------------------------------------------------------------
-- a_sales: a salesperson of A, before any pilot
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
begin
  if auth.uid() <> '00000000-0000-4000-8000-0000000000a1' then
    raise exception 'auth.uid() is % (the claims were not picked up)', auth.uid();
  end if;

  -- no row yet: none; B's row is invisible, so B reads as none too, and so does a made-up id
  if public.subscription_state(a) <> 'none' then raise exception 'A should be none before the pilot, is %', public.subscription_state(a); end if;
  if public.subscription_state(b) <> 'none' then raise exception 'a_sales learned B''s state: %', public.subscription_state(b); end if;
  if public.subscription_state('00000000-0000-4000-8000-00000000ffff') <> 'none' then raise exception 'an unknown dealership should be none'; end if;
  select count(*) into n from public.subscriptions;
  if n <> 0 then raise exception 'a_sales should see no subscription rows yet, saw %', n; end if;
  raise notice 'ok: a_sales sees no billing standing before the pilot and nothing of B';

  -- a salesperson cannot start the pilot
  begin
    perform public.start_pilot(a);
    raise exception 'a_sales started the pilot';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot start the pilot';
  end;

  -- and cannot write the table
  begin
    insert into public.subscriptions (dealership_id, status, pilot_ends_at) values (a, 'pilot', now() + interval '30 days');
    raise exception 'a_sales inserted a subscription row';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot insert into subscriptions';
  end;

  -- billing_events is nobody's to read
  begin
    select count(*) into n from public.billing_events;
    if n <> 0 then raise exception 'a_sales can read billing_events'; end if;
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: a_sales cannot read billing_events';
end;
$$;

-- ---------------------------------------------------------------------------
-- a_mgr: a manager of A starts the pilot
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  got jsonb;
  ends timestamptz;
begin
  got := public.start_pilot(a);
  if (got ->> 'started')::boolean is not true or got ->> 'status' <> 'pilot' or got ->> 'state' <> 'pilot' then
    raise exception 'start_pilot returned %', got;
  end if;
  ends := (got ->> 'pilot_ends_at')::timestamptz;
  if ends < now() + interval '29 days 23 hours' or ends > now() + interval '30 days 1 hour' then
    raise exception 'the pilot should end 30 days from now, ends %', ends;
  end if;
  if public.subscription_state(a) <> 'pilot' then raise exception 'A should be in the pilot'; end if;
  select count(*) into n from public.subscriptions where dealership_id = a and status = 'pilot' and seats = 5;
  if n <> 1 then raise exception 'the pilot row is missing or has the wrong seats'; end if;
  raise notice 'ok: a_mgr started a 30-day pilot with 5 seats';

  -- a second call changes nothing and says so
  got := public.start_pilot(a);
  if (got ->> 'started')::boolean is not false or (got ->> 'pilot_ends_at')::timestamptz <> ends or got ->> 'state' <> 'pilot' then
    raise exception 'a second start_pilot should report the standing unchanged, returned %', got;
  end if;
  raise notice 'ok: the pilot does not restart';

  -- not for B
  begin
    perform public.start_pilot(b);
    raise exception 'a_mgr started a pilot for B';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr cannot start B''s pilot';
  end;

  -- a manager reads the row but cannot change it (RLS filters it out: 0 rows) or remove it
  select count(*) into n from public.subscriptions;
  if n <> 1 then raise exception 'a_mgr should see exactly A''s row, saw %', n; end if;
  begin
    update public.subscriptions set status = 'active' where dealership_id = a;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'a_mgr updated the subscription row'; end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.subscriptions where dealership_id = a;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'a_mgr deleted the subscription row'; end if;
  exception when insufficient_privilege then
    null;
  end;
  if public.subscription_state(a) <> 'pilot' then raise exception 'the row changed'; end if;
  raise notice 'ok: a_mgr reads the row and cannot write it';

  -- billing_events stays closed to managers too
  begin
    insert into public.billing_events (stripe_event_id, type) values ('evt_by_manager', 'x');
    raise exception 'a_mgr wrote billing_events';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr cannot write billing_events';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- a_sales again: the pilot is visible to every member
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  select count(*) into n from public.subscriptions where dealership_id = a and status = 'pilot' and pilot_ends_at > now();
  if n <> 1 then raise exception 'a_sales should see A''s pilot row'; end if;
  if public.subscription_state(a) <> 'pilot' then raise exception 'a_sales should read A as pilot'; end if;
  raise notice 'ok: a_sales sees the pilot';
end;
$$;

-- ---------------------------------------------------------------------------
-- b_mgr: a paying dealership's manager
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'b_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  got jsonb;
begin
  if public.subscription_state(b) <> 'active' then raise exception 'B should be active'; end if;
  if public.subscription_state(a) <> 'none' then raise exception 'b_mgr learned A''s state'; end if;
  select count(*) into n from public.subscriptions;
  if n <> 1 then raise exception 'b_mgr should see only B''s row, saw %', n; end if;
  if (select seats from public.subscriptions where dealership_id = b) <> 7 then raise exception 'B''s seats should read 7'; end if;
  -- the cancellation B scheduled: readable, still active until it ends, and not the manager's to change
  if (select cancel_at from public.subscriptions where dealership_id = b) is distinct from (select current_period_end from public.subscriptions where dealership_id = b) then
    raise exception 'b_mgr should read the date B''s subscription ends';
  end if;
  begin
    update public.subscriptions set cancel_at = null where dealership_id = b;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'b_mgr cleared the cancellation date'; end if;
  exception when insufficient_privilege then
    null;
  end;
  if (select cancel_at from public.subscriptions where dealership_id = b) is null then raise exception 'the cancellation date changed'; end if;
  -- a paying dealership cannot get a free pilot on top
  got := public.start_pilot(b);
  if (got ->> 'started')::boolean is not false or got ->> 'status' <> 'active' or got ->> 'state' <> 'active' then
    raise exception 'start_pilot on a paying dealership should change nothing, returned %', got;
  end if;
  raise notice 'ok: b_mgr sees B active with the date it ends, nothing of A, cannot change it, and cannot add a pilot to a paid subscription';
end;
$$;

-- ---------------------------------------------------------------------------
-- the state machine, as the owner (no RLS), moving the rows through time
-- ---------------------------------------------------------------------------
reset role;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  c uuid := '00000000-0000-4000-8000-0000000000d3';
  s text;
begin
  -- a shell row (customer only) is none, and the pilot may still start on it
  if public.subscription_state(c) <> 'none' then raise exception 'a customer shell should be none'; end if;

  -- the pilot ends: lapsed
  update public.subscriptions set pilot_ends_at = now() - interval '1 minute' where dealership_id = a;
  if public.subscription_state(a) <> 'lapsed' then raise exception 'an ended pilot should be lapsed, is %', public.subscription_state(a); end if;

  -- the manager subscribed during the pilot: trialing is active, whatever the pilot date says
  update public.subscriptions set status = 'trialing', pilot_ends_at = now() + interval '3 days', stripe_customer_id = 'cus_a', stripe_subscription_id = 'sub_a' where dealership_id = a;
  if public.subscription_state(a) <> 'active' then raise exception 'trialing should be active'; end if;

  -- canceled during the pilot: the promised free period still runs
  update public.subscriptions set status = 'canceled' where dealership_id = a;
  if public.subscription_state(a) <> 'pilot' then raise exception 'a running pilot outranks canceled, got %', public.subscription_state(a); end if;

  -- and then it ends
  update public.subscriptions set pilot_ends_at = now() - interval '1 second' where dealership_id = a;
  if public.subscription_state(a) <> 'lapsed' then raise exception 'canceled after the pilot should be lapsed'; end if;

  -- every Stripe status the row accepts, without a pilot, is active or lapsed and never none
  foreach s in array array['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'] loop
    update public.subscriptions set status = s, pilot_ends_at = null where dealership_id = a;
    if public.subscription_state(a) <> (case when s in ('trialing', 'active') then 'active' else 'lapsed' end) then
      raise exception 'status % should be % but reads %', s, case when s in ('trialing', 'active') then 'active' else 'lapsed' end, public.subscription_state(a);
    end if;
  end loop;

  -- a status outside the list is refused by the check constraint
  begin
    update public.subscriptions set status = 'something_else' where dealership_id = a;
    raise exception 'an unknown status was accepted';
  exception when check_violation then
    null;
  end;

  -- seats below 1 are refused
  begin
    update public.subscriptions set seats = 0 where dealership_id = a;
    raise exception 'zero seats were accepted';
  exception when check_violation then
    null;
  end;

  -- a webhook event is recorded once
  begin
    insert into public.billing_events (stripe_event_id, type) values ('evt_test_1', 'customer.subscription.created');
    raise exception 'a duplicate event id was accepted';
  exception when unique_violation then
    null;
  end;

  -- deleting a dealership takes its billing row with it
  delete from public.dealerships where id = b;
  if exists (select 1 from public.subscriptions where dealership_id = b) then raise exception 'B''s subscription row survived the dealership'; end if;
  raise notice 'ok: the SQL state machine matches billing.mjs and the constraints hold';
end;
$$;

-- ---------------------------------------------------------------------------
-- the shell row: a manager of C would be able to start the pilot on it
-- (start_pilot's on-conflict update). Give C a manager and try.
-- ---------------------------------------------------------------------------
insert into public.memberships (user_id, dealership_id, role, name) values (:'b_mgr', :'dealer_c', 'manager', 'Sam');
select set_config('request.jwt.claims', '{"sub":"' || :'b_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  c uuid := '00000000-0000-4000-8000-0000000000d3';
  got jsonb;
begin
  got := public.start_pilot(c);
  if (got ->> 'started')::boolean is not true or got ->> 'state' <> 'pilot' then
    raise exception 'start_pilot on a customer shell should start the pilot, returned %', got;
  end if;
  if (select stripe_customer_id from public.subscriptions where dealership_id = c) <> 'cus_c' then
    raise exception 'the customer id should survive the pilot start';
  end if;
  raise notice 'ok: a customer shell does not block the pilot';
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
    select count(*) into n from public.subscriptions;
    if n <> 0 then raise exception 'anon can read % subscription rows', n; end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.start_pilot('00000000-0000-4000-8000-0000000000d1');
    raise exception 'anon could call start_pilot';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.subscription_state('00000000-0000-4000-8000-0000000000d1');
    raise exception 'anon could call subscription_state';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: anon reads nothing and cannot call the billing functions';
end;
$$;

reset role;
rollback;

\echo 'billing.sql: every check passed (all changes rolled back)'
