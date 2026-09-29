-- Lot Sync: self-serve sign-up (0007_signup.sql) against a running database
-- with the migrations applied, in the shape of rls.sql: people straight in
-- auth.users, the JWT claims set the way PostgREST does, DO blocks that
-- raise on anything wrong, everything in one transaction rolled back at the
-- end. psql exits non-zero on the first failed assertion.
--
--   user     what they do
--   e_mgr    manager of Existing Motors, which the owner made in SQL; started a dealership 25 hours ago
--   p1       signs up New Motors and becomes its manager; then refused a second one (per_account)
--   p2       redeems the invite p1 made
--   p3       asks for Existing Motors' website five times, then is throttled
--   p4       five attempts two hours ago, which no longer count; signs up Fourth Motors
--   p5       signs up the third dealership of the past 24 hours, with the longest names and host allowed
--   p6       refused by per_day; then loses a race for a website to the owner's own insert
--
-- What it proves: website_origin_of() holds every case of
-- test/fixtures/website-origins.json; the settings row is one row, closed,
-- with the default limits; no API role holds anything on the two tables or
-- the sequence, and only a signed-in person may call create_dealership();
-- the checks run in their order (signed in, open, throttle, fields, limits,
-- website); a sign-up makes a dealership whose manager can invite, start
-- the pilot and read the Billing card's rows, and whose invite a second
-- person can redeem; per_account, per_day and the hourly throttle hold, the
-- throttle counting the answered P0009s; a website that is taken, or taken
-- between the check and the insert, gets P0009 and nothing else.

\set ON_ERROR_STOP on
\encoding UTF8
\set e_mgr     '00000000-0000-4000-8000-0000000000e2'
\set p1        '00000000-0000-4000-8000-0000000000a1'
\set p2        '00000000-0000-4000-8000-0000000000a2'
\set p3        '00000000-0000-4000-8000-0000000000a3'
\set p4        '00000000-0000-4000-8000-0000000000a4'
\set p5        '00000000-0000-4000-8000-0000000000a5'
\set p6        '00000000-0000-4000-8000-0000000000a6'
\set dealer_e  '00000000-0000-4000-8000-0000000000d1'

begin;

-- ---------------------------------------------------------------------------
-- website_origin_of(): every case of test/fixtures/website-origins.json, as
-- the owner (no API role may call it). test/signup.test.js checks that each
-- case of the fixture is written here with its expected origin.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  n integer := 0;
begin
  for c in
    select * from (values
      ('smithford.com', 'https://smithford.com'),
      ('www.smithford.com', 'https://www.smithford.com'),
      ('https://www.smithford.com/', 'https://www.smithford.com'),
      ('  HTTPS://WWW.SmithFord.COM/used-inventory/index.htm?x=1#top  ', 'https://www.smithford.com'),
      ('smithford.com/inventory', 'https://smithford.com'),
      ('https://www.smithford.com/?', 'https://www.smithford.com'),
      ('http://www.smithford.com', 'http://www.smithford.com'),
      ('https://www.smithford.com:443/', 'https://www.smithford.com'),
      ('http://www.smithford.com:80', 'http://www.smithford.com'),
      ('www.smithford.com.', 'https://www.smithford.com'),
      ('https://used.dealer-group.example.co.uk/path', 'https://used.dealer-group.example.co.uk'),
      ('https://xn--bcher-kva.de', 'https://xn--bcher-kva.de'),
      ('https://www.smithford.com:8443', null),
      ('https://smithford.com:abc', null),
      ('', null),
      ('   ', null),
      ('smithford', null),
      ('localhost', null),
      ('http://localhost:3000', null),
      ('192.168.1.10', null),
      ('https://10.0.0.1/', null),
      ('https://[::1]/', null),
      ('ftp://smithford.com', null),
      ('javascript:alert(1)', null),
      ('https://user:pass@smithford.com', null),
      ('https://smith ford.com', null),
      ('https://smithford..com', null),
      ('https://-smithford.com', null),
      ('https://smithford-.com', null),
      ('https://smith_ford.com', null),
      ('https://bücher.de', null),
      ('https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com', null)
    ) as f(input, origin)
  loop
    if public.website_origin_of(c.input) is distinct from c.origin then
      raise exception 'website_origin_of(%) is %, not %', quote_literal(c.input), coalesce(public.website_origin_of(c.input), 'null'), coalesce(c.origin, 'null');
    end if;
    n := n + 1;
  end loop;
  if n <> 32 then raise exception 'checked % cases, the fixture has 32', n; end if;
  if (select provolatile from pg_proc where oid = 'public.website_origin_of(text)'::regprocedure) <> 'i' then
    raise exception 'website_origin_of is not immutable';
  end if;
  raise notice 'ok: website_origin_of holds every case of the fixture';
end;
$$;

-- Beyond the fixture: the trim removes what JavaScript's trim() removes
-- (tabs, line breaks, a no-break space, a byte-order mark), and a character
-- whose lower case is ASCII (the Kelvin sign folds to k, the capital I with
-- a dot to i, in most locales) is refused like any other non-ASCII host,
-- because the characters are checked before the case is folded.
do $$
begin
  if public.website_origin_of(E'\t' || chr(160) || 'smithford.com/' || chr(65279) || E'\r\n') is distinct from 'https://smithford.com' then
    raise exception 'website_origin_of does not trim what JavaScript trims';
  end if;
  if public.website_origin_of('https://smithford.' || chr(8490) || 'om') is not null
     or public.website_origin_of('https://' || chr(304) || 'nventory-motors.com') is not null then
    raise exception 'a host with a character whose lower case is ASCII was accepted';
  end if;
  raise notice 'ok: the trim is JavaScript''s, and a host is checked for ASCII before its case is folded';
end;
$$;

-- ---------------------------------------------------------------------------
-- The settings row and the privileges (as the owner)
-- ---------------------------------------------------------------------------
do $$
declare
  who text;
  t text;
  k text;
begin
  if (select count(*) from public.signup_settings) <> 1
     or (select row(open, per_account, per_day)::text from public.signup_settings) is distinct from '(f,1,10)' then
    raise exception 'signup_settings is not one closed row with per_account 1 and per_day 10: %', (select jsonb_agg(s) from public.signup_settings s);
  end if;
  begin
    insert into public.signup_settings default values;
    raise exception 'a second settings row went in';
  exception when unique_violation then null;
  end;
  begin
    insert into public.signup_settings (id) values (false);
    raise exception 'a settings row with id false went in';
  exception when check_violation then null;
  end;
  raise notice 'ok: signup_settings is one row, closed, with the default limits';

  foreach who in array array['public', 'anon', 'authenticated', 'service_role'] loop
    foreach t in array array['public.signup_settings', 'public.signup_attempts'] loop
      foreach k in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(who, t, k) then raise exception '% holds % on %', who, k, t; end if;
      end loop;
      if has_any_column_privilege(who, t, 'SELECT, INSERT, UPDATE, REFERENCES') then raise exception '% holds a column privilege on %', who, t; end if;
    end loop;
    if has_sequence_privilege(who, 'public.signup_attempts_id_seq', 'USAGE, SELECT, UPDATE') then
      raise exception '% holds a privilege on signup_attempts_id_seq', who;
    end if;
    if has_function_privilege(who, 'public.website_origin_of(text)', 'execute') then
      raise exception '% may execute website_origin_of', who;
    end if;
    if has_function_privilege(who, 'public.create_dealership(text, text, text)', 'execute') <> (who = 'authenticated') then
      raise exception 'execute on create_dealership for %: %', who, has_function_privilege(who, 'public.create_dealership(text, text, text)', 'execute');
    end if;
  end loop;
  if not (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.create_dealership(text, text, text)'::regprocedure) then
    raise exception 'create_dealership is not security definer with an empty search_path';
  end if;
  raise notice 'ok: no API role holds anything on the two tables or the sequence; only authenticated may call create_dealership';
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner, which is not under RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'e_mgr', 'authenticated', 'authenticated', 'e-mgr@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p1',    'authenticated', 'authenticated', 'p1@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p2',    'authenticated', 'authenticated', 'p2@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p3',    'authenticated', 'authenticated', 'p3@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p4',    'authenticated', 'authenticated', 'p4@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p5',    'authenticated', 'authenticated', 'p5@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'p6',    'authenticated', 'authenticated', 'p6@example.test',    now(), now());

insert into public.dealerships (id, name, website_origin) values
  (:'dealer_e', 'Existing Motors', 'https://www.existing-motors.test');
insert into public.memberships (user_id, dealership_id, role, name) values
  (:'e_mgr', :'dealer_e', 'manager', 'Jordan');

-- e_mgr started a dealership 25 hours ago (outside per_day's window); p4
-- tried five times two hours ago (outside the throttle's hour)
insert into public.signup_attempts (user_id, at, outcome, dealership_id) values
  (:'e_mgr', now() - interval '25 hours', 'created', :'dealer_e');
insert into public.signup_attempts (user_id, at, outcome)
  select :'p4', now() - interval '2 hours', 'taken' from generate_series(1, 5);

-- One call to create_dealership as whoever is signed in: its answer, or
-- { raised, message } when it raised (in a subtransaction, so a raise
-- leaves nothing behind, as it does through the API). The answers that set
-- response.status report it as status, and it is cleared for the next call.
create function pg_temp.sign_up(dealer text, website text, person text) returns jsonb
language plpgsql as $$
declare
  got jsonb;
begin
  begin
    got := public.create_dealership(dealer, website, person);
  exception when others then
    return jsonb_build_object('raised', sqlstate, 'message', sqlerrm);
  end;
  if coalesce(current_setting('response.status', true), '') <> '' then
    got := got || jsonb_build_object('status', current_setting('response.status', true));
    perform set_config('response.status', '', true);
  end if;
  return got;
end;
$$;

-- ---------------------------------------------------------------------------
-- Signed out: the anon key may not call it at all, and a call with no user
-- (checked before the switch: sign-up is still closed here) is refused
-- first. Neither may touch the tables or the sequence.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true) as claims \gset
set local role anon;
do $$
begin
  begin
    perform public.create_dealership('Anon Motors', 'www.anon-motors.test', 'Nobody');
    raise exception 'anon called create_dealership';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.signup_settings;
    raise exception 'anon read signup_settings';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.signup_settings set open = true;
    raise exception 'anon opened sign-up';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.signup_attempts;
    raise exception 'anon read signup_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.signup_attempts (user_id, outcome) values ('00000000-0000-4000-8000-0000000000a1', 'taken');
    raise exception 'anon wrote signup_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform nextval('public.signup_attempts_id_seq');
    raise exception 'anon drew from signup_attempts_id_seq';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: anon can call create_dealership no more than it can touch the tables or the sequence';
end;
$$;

reset role;
set local role authenticated;
do $$
declare
  got jsonb := pg_temp.sign_up('Nobody Motors', 'www.nobody-motors.test', 'Nobody');
begin
  if auth.uid() is not null then raise exception 'the claims still carry a user'; end if;
  if got is distinct from jsonb_build_object('raised', '42501', 'message', 'sign in first') then
    raise exception 'a call with no user was answered with %', got;
  end if;
  raise notice 'ok: with no user, create_dealership says sign in first (before it looks at the switch)';
end;
$$;

-- ---------------------------------------------------------------------------
-- p1: sign-up is closed; the tables stay out of reach
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'p1' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  got jsonb := pg_temp.sign_up('New Motors', 'www.new-motors.test', 'Pat');
begin
  if got ->> 'raised' is distinct from 'P0008' or got ->> 'message' not like 'sign-up is not open%invite code%from Lot Sync or from your dealership''s manager' then
    raise exception 'a sign-up while closed was answered with %', got;
  end if;
  raise notice 'ok: while sign-up is closed, P0008 points at an invite code';

  begin
    perform 1 from public.signup_settings;
    raise exception 'a signed-in person read signup_settings';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.signup_settings set open = true, per_account = 100;
    raise exception 'a signed-in person opened sign-up';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.signup_attempts;
    raise exception 'a signed-in person read signup_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.signup_attempts;
    raise exception 'a signed-in person deleted signup_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.signup_attempts (user_id, outcome) values (auth.uid(), 'taken');
    raise exception 'a signed-in person wrote signup_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform setval('public.signup_attempts_id_seq', 1);
    raise exception 'a signed-in person set signup_attempts_id_seq';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.website_origin_of('www.new-motors.test');
    raise exception 'a signed-in person called website_origin_of';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: a signed-in person cannot read or write the two tables or the sequence';
end;
$$;

-- nothing was written by the refusal; then the owner opens sign-up
reset role;
do $$
begin
  if exists (select 1 from public.signup_attempts where user_id = '00000000-0000-4000-8000-0000000000a1')
     or exists (select 1 from public.dealerships where website_origin = 'https://www.new-motors.test') then
    raise exception 'a refused sign-up wrote something';
  end if;
end;
$$;
update public.signup_settings set open = true;

-- ---------------------------------------------------------------------------
-- p1: each field is checked and named; then the sign-up
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
declare
  c record;
  got jsonb;
  d uuid;
  inv jsonb;
  pilot jsonb;
  n bigint;
begin
  for c in
    select * from (values
      ('',                       'www.new-motors.test',                            'Pat',            'dealership''s name'),
      ('   ',                    'www.new-motors.test',                            'Pat',            'dealership''s name'),
      (repeat('N', 121),         'www.new-motors.test',                            'Pat',            'dealership''s name'),
      (E'New\nMotors',           'www.new-motors.test',                            'Pat',            'dealership''s name'),
      (null,                     'www.new-motors.test',                            'Pat',            'dealership''s name'),
      ('New Motors',             'localhost',                                      'Pat',            'website'),
      ('New Motors',             'https://www.new-motors.test:8443',               'Pat',            'website'),
      ('New Motors',             'https://' || repeat('a.', 125) || 'test',         'Pat',            'website'),
      ('New Motors',             null,                                             'Pat',            'website'),
      ('New Motors',             'www.new-motors.test',                            '',               'your name'),
      ('New Motors',             'www.new-motors.test',                            repeat('y', 81),  'your name'),
      ('New Motors',             'www.new-motors.test',                            E'Pat\tQuinn',    'your name'),
      ('New Motors',             'www.new-motors.test',                            null,             'your name')
    ) as f(dealer, website, person, field)
  loop
    got := pg_temp.sign_up(c.dealer, c.website, c.person);
    if got ->> 'raised' is distinct from '22023' or position(c.field in got ->> 'message') = 0 then
      raise exception 'sign_up(%, %, %) was answered with %, not 22023 naming the %', quote_nullable(c.dealer), quote_nullable(left(c.website, 40)), quote_nullable(c.person), got, c.field;
    end if;
  end loop;
  raise notice 'ok: a bad name, website or your name is refused with 22023 naming the field';

  -- trimmed, the address reduced to its origin
  got := pg_temp.sign_up('  New Motors  ', '  HTTPS://WWW.New-Motors.test/used-inventory/?page=2  ', ' Pat ');
  if got ? 'status' or got ? 'raised' or got - 'dealership_id' - 'pilot_ends_at' is distinct from jsonb_build_object('name', 'New Motors', 'website_origin', 'https://www.new-motors.test')
     or (got ->> 'pilot_ends_at')::timestamptz not between now() + interval '30 days' - interval '1 minute' and now() + interval '30 days' then
    raise exception 'the sign-up was answered with %', got;
  end if;
  d := (got ->> 'dealership_id')::uuid;

  -- the new manager sees their dealership and no other, and is its manager under the name they gave
  if (select array_agg(id) from public.dealerships) is distinct from array[d] then raise exception 'p1 sees dealerships %, not only their new one', (select array_agg(name) from public.dealerships); end if;
  if not exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.dealership_id = d and m.role = 'manager' and m.name = 'Pat') then
    raise exception 'p1 is not the manager of their new dealership, as Pat';
  end if;
  if not public.is_manager(d) then raise exception 'is_manager says no for the new manager'; end if;
  raise notice 'ok: the sign-up made New Motors with p1 as its manager';

  -- its free pilot started with it (a self-serve dealership never sits in the none state), and it
  -- starts once: the Billing card's button then changes nothing
  select count(*) into n from public.subscriptions s where s.dealership_id = d and s.status = 'pilot' and s.pilot_ends_at = (got ->> 'pilot_ends_at')::timestamptz;
  if n <> 1 or public.subscription_state(d) is distinct from 'pilot' then raise exception 'the new dealership''s pilot did not start with it'; end if;
  pilot := public.start_pilot(d);
  if (pilot ->> 'started')::boolean is not false or pilot ->> 'state' is distinct from 'pilot' then raise exception 'start_pilot answered %', pilot; end if;

  -- and does what a manager does: invites (the Invite codes card), reads the Billing card's rows
  inv := public.create_invite(d, 'salesperson');
  if length(inv ->> 'code') <> 12 then raise exception 'create_invite answered %', inv; end if;
  if not exists (select 1 from public.list_invites(d) l where l.code = inv ->> 'code') then raise exception 'list_invites does not show the new code'; end if;
  perform set_config('signup_test.invite', inv ->> 'code', true);
  raise notice 'ok: the new dealership is on its pilot; its manager creates an invite and reads the plan';
end;
$$;

-- what the sign-up wrote (as the owner, who alone reads the attempts)
reset role;
do $$
declare
  d uuid := (select id from public.dealerships where website_origin = 'https://www.new-motors.test');
begin
  if (select name from public.dealerships where id = d) is distinct from 'New Motors' then raise exception 'the dealership''s name was not stored trimmed'; end if;
  if (select jsonb_agg(jsonb_build_object('outcome', a.outcome, 'dealership_id', a.dealership_id)) from public.signup_attempts a where a.user_id = '00000000-0000-4000-8000-0000000000a1')
     is distinct from jsonb_build_array(jsonb_build_object('outcome', 'created', 'dealership_id', d)) then
    raise exception 'p1''s attempts are not one created row for New Motors: the refusals wrote, or the sign-up did not';
  end if;
  raise notice 'ok: one created attempt, with the dealership, and nothing from the refusals';
end;
$$;

-- ---------------------------------------------------------------------------
-- p2 redeems the new manager's invite
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"' || :'p2' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  got jsonb := public.redeem_invite(current_setting('signup_test.invite'), 'Robin');
begin
  if got ->> 'website_origin' is distinct from 'https://www.new-motors.test' or got ->> 'role' is distinct from 'salesperson' or got ->> 'name' is distinct from 'Robin' then
    raise exception 'redeeming the new manager''s invite answered %', got;
  end if;
  if (select count(*) from public.dealerships) <> 1 or not exists (select 1 from public.dealerships where name = 'New Motors') then
    raise exception 'p2 does not see New Motors, or sees more';
  end if;
  raise notice 'ok: a second person joins the new dealership with its manager''s invite';
end;
$$;

-- ---------------------------------------------------------------------------
-- p1 again: per_account, and the order around it
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'p1' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  got jsonb;
begin
  got := pg_temp.sign_up('Second Store', 'www.second-store.test', 'Pat');
  if got ->> 'raised' is distinct from 'P0010' or got ->> 'message' not like 'this account has already started a dealership%' then
    raise exception 'a second sign-up by p1 was answered with %', got;
  end if;
  -- the fields come before the limits
  got := pg_temp.sign_up('', 'www.second-store.test', 'Pat');
  if got ->> 'raised' is distinct from '22023' then raise exception 'a bad name from an account at its limit was answered with %', got; end if;
  -- the limits come before the website is looked up: an account that has started a dealership learns nothing about another website
  got := pg_temp.sign_up('Copy Motors', 'www.existing-motors.test', 'Pat');
  if got ->> 'raised' is distinct from 'P0010' then raise exception 'a taken website from an account at its limit was answered with %', got; end if;
  raise notice 'ok: per_account refuses a second dealership with P0010, after the fields and before the website is looked up';
end;
$$;

-- ---------------------------------------------------------------------------
-- p3: a taken website, five times; then the throttle
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'p3' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  got jsonb;
  i integer;
begin
  got := pg_temp.sign_up('Copy Motors', 'https://WWW.Existing-Motors.test/inventory', 'Lee');
  if got is distinct from jsonb_build_object('code', 'P0009', 'details', null, 'hint', null, 'status', '400',
       'message', 'that website already has a Lot Sync dealership: ask its manager for an invite code (if nobody there uses Lot Sync, write to Lot Sync support)') then
    raise exception 'a taken website was answered with %', got;
  end if;
  if exists (select 1 from public.dealerships) or exists (select 1 from public.memberships) then
    raise exception 'asking for a taken website let p3 see or join something';
  end if;
  raise notice 'ok: a taken website is answered with P0009 and status 400, and lets nobody in';

  for i in 2..5 loop
    got := pg_temp.sign_up('Copy Motors ' || i, 'www.existing-motors.test/', 'Lee');
    if got ->> 'code' is distinct from 'P0009' then raise exception 'try % was answered with %', i, got; end if;
  end loop;

  -- five attempts in the hour, all answered: the sixth is refused before anything is looked up, even a free website
  got := pg_temp.sign_up('P3 Motors', 'www.p3-motors.test', 'Lee');
  if got is distinct from jsonb_build_object('code', 'P0005', 'message', 'too many attempts; try again in an hour', 'details', null, 'hint', null, 'status', '400') then
    raise exception 'the sixth attempt in an hour was answered with %', got;
  end if;
  -- and before the fields
  got := pg_temp.sign_up('', '', '');
  if got ->> 'code' is distinct from 'P0005' then raise exception 'a throttled bad call was answered with %', got; end if;
  raise notice 'ok: after five attempts in an hour, answered P0009s included, P0005 comes before the fields';
end;
$$;

-- the switch comes before the throttle
reset role;
update public.signup_settings set open = false;
set local role authenticated;
do $$
begin
  if pg_temp.sign_up('P3 Motors', 'www.p3-motors.test', 'Lee') ->> 'raised' is distinct from 'P0008' then
    raise exception 'a throttled account was not told sign-up is closed first';
  end if;
  raise notice 'ok: a closed switch is checked before the throttle';
end;
$$;
reset role;
update public.signup_settings set open = true;

do $$
begin
  if (select count(*) from public.signup_attempts where user_id = '00000000-0000-4000-8000-0000000000a3' and outcome = 'taken' and dealership_id is null) <> 5
     or exists (select 1 from public.signup_attempts where user_id = '00000000-0000-4000-8000-0000000000a3' and (outcome <> 'taken' or dealership_id is not null)) then
    raise exception 'p3''s attempts are not five taken rows with no dealership';
  end if;
  if exists (select 1 from public.dealerships where website_origin = 'https://www.p3-motors.test')
     or (select count(*) from public.memberships where dealership_id = '00000000-0000-4000-8000-0000000000d1') <> 1 then
    raise exception 'a refused call made a dealership, or a taken website gained a member';
  end if;
  raise notice 'ok: each answered P0009 is kept as a taken attempt, linked to no dealership';
end;
$$;

-- ---------------------------------------------------------------------------
-- p4: attempts older than an hour do not count
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"' || :'p4' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  got jsonb := pg_temp.sign_up('Fourth Motors', 'fourth-motors.test/used/?q=' || repeat('x', 3000), 'Kim');
begin
  if got ->> 'website_origin' is distinct from 'https://fourth-motors.test' then
    raise exception 'p4, with five attempts two hours ago, was answered with %', got;
  end if;
  raise notice 'ok: the throttle counts the past hour only (and a long query is dropped, not refused)';
end;
$$;

-- ---------------------------------------------------------------------------
-- per_day: New Motors and Fourth Motors started in the past 24 hours;
-- Existing Motors' attempt, 25 hours old, does not count. With per_day at
-- 3, p5 starts the third, and p6 is refused.
-- ---------------------------------------------------------------------------
reset role;
update public.signup_settings set per_day = 3;
select set_config('request.jwt.claims', '{"sub":"' || :'p5' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  -- a host of 253 characters, the most DNS allows
  got jsonb := pg_temp.sign_up(repeat('F', 120), repeat('a.', 124) || 'tests', repeat('G', 80));
begin
  if got ->> 'website_origin' is distinct from 'https://' || repeat('a.', 124) || 'tests' or length(got ->> 'name') <> 120 then
    raise exception 'the third sign-up of the day, with a 120-character name, an 80-character person and a 253-character host, was answered with %', got;
  end if;
  raise notice 'ok: the longest names and host are accepted, and a created attempt 25 hours old is outside per_day';
end;
$$;

reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'p6' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
declare
  got jsonb := pg_temp.sign_up('Sixth Motors', 'www.sixth-motors.test', 'Sky');
begin
  if got ->> 'raised' is distinct from 'P0011' or got ->> 'message' <> 'no more new dealerships can start today; try again tomorrow, or write to Lot Sync support' then
    raise exception 'the fourth sign-up in 24 hours with per_day 3 was answered with %', got;
  end if;
  raise notice 'ok: per_day refuses with P0011';
end;
$$;

-- ---------------------------------------------------------------------------
-- A dealership with the same website appears between the check (f) and the
-- insert (g), as when the owner's own SQL gets there first: a trigger stands
-- in for it. p6 gets P0009 and joins nothing.
-- ---------------------------------------------------------------------------
reset role;
update public.signup_settings set per_day = 100;
create function pg_temp.got_there_first() returns trigger
language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and new.website_origin = 'https://www.race-motors.test' then
    insert into public.dealerships (name, website_origin) values ('Got There First', new.website_origin);
  end if;
  return new;
end;
$$;
create trigger signup_test_got_there_first before insert on public.dealerships
  for each row execute function pg_temp.got_there_first();
set local role authenticated;
do $$
declare
  got jsonb := pg_temp.sign_up('Race Motors', 'www.race-motors.test', 'Sky');
begin
  if got ->> 'code' is distinct from 'P0009' or got ->> 'status' is distinct from '400' then
    raise exception 'a website taken between the check and the insert was answered with %', got;
  end if;
  if exists (select 1 from public.memberships) then raise exception 'p6 joined a dealership'; end if;
  raise notice 'ok: a website taken between the check and the insert is answered with P0009';
end;
$$;
reset role;
drop trigger signup_test_got_there_first on public.dealerships;
do $$
begin
  if (select array_agg(name) from public.dealerships where website_origin = 'https://www.race-motors.test') is distinct from array['Got There First'] then
    raise exception 'the race left % for its website', (select array_agg(name) from public.dealerships where website_origin = 'https://www.race-motors.test');
  end if;
  if (select array_agg(outcome) from public.signup_attempts where user_id = '00000000-0000-4000-8000-0000000000a6') is distinct from array['taken'] then
    raise exception 'p6''s attempts are %, not one taken (the P0011 wrote nothing)', (select array_agg(outcome) from public.signup_attempts where user_id = '00000000-0000-4000-8000-0000000000a6');
  end if;
  raise notice 'ok: the race leaves the first dealership alone and records p6''s attempt as taken';
end;
$$;

rollback;

\echo 'signup.sql: every check passed (all changes rolled back)'
