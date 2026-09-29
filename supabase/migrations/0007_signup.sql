-- Lot Sync, Milestone 5: self-serve sign-up (PLAN.md M5: a new dealer can
-- subscribe, start a pilot period and manage billing without help).
--
-- Until now a dealership existed only because the owner created it in SQL
-- (supabase/README.md, step 5). create_dealership() lets a signed-in person
-- create one and become its first manager, from the manager view's "Start
-- your dealership" form. It is switched off until the owner opens it, and
-- two limits bound it: how many dealerships one account may ever start this
-- way, and how many start across everyone in 24 hours. Every new dealership
-- can start a free pilot with the description writer, so the daily limit
-- bounds what a flood of made-up accounts could cost.
--
--   signup_settings                               one row: the switch and the two limits; the owner changes it in SQL
--   signup_attempts                               one row per sign-up that got as far as looking up its website
--   website_origin_of(address)                    the origin kept for a typed website address, or null when it is refused
--   create_dealership(name, website, your_name)   the sign-up itself
--
-- No API role, the service role included, may read or write either table or
-- the attempts' sequence; create_dealership() reads and writes them as its
-- owner. What a person sees, each refusal and how the owner opens sign-up:
-- supabase/README.md, "Self-serve sign-up". Proven by
-- supabase/tests/signup.sql.
--
-- Error codes: 42501 not signed in; P0008 sign-up is not open; P0005 too
-- many attempts in the past hour; 22023 a field is not usable (the message
-- names it); P0010 this account already started as many dealerships as it
-- may; P0011 the day's new dealerships are used up; P0009 the website
-- already has a dealership.

-- ---------------------------------------------------------------------------
-- signup_settings: exactly one row (id is true, and can only be true).
-- open is the switch, false until the owner opens sign-up. per_account is
-- how many dealerships one account may ever start through
-- create_dealership(); a second one comes from the owner. per_day is how
-- many may start across everyone in the past 24 hours: each can start a
-- free pilot with the description writer, whose cost cap is per dealership
-- (MONTHLY_COST_CAP_USD), so this is what bounds the total.
-- ---------------------------------------------------------------------------
create table public.signup_settings (
  id boolean primary key default true check (id),
  open boolean not null default false,
  per_account int not null default 1,
  per_day int not null default 10
);
insert into public.signup_settings default values;
comment on table public.signup_settings is 'Self-serve sign-up: the switch (open, off by default) and its two limits. One row. The owner changes it in SQL; no API role reads or writes it.';

-- ---------------------------------------------------------------------------
-- signup_attempts: one row per call to create_dealership() that got as far
-- as looking up its website. created: the call made a dealership, whose id
-- is kept. taken: the website already had one; no dealership is linked, so
-- a stranger's question about a customer is not recorded against that
-- customer. The row counts toward the hourly throttle (any outcome), and a
-- created row toward per_account (forever) and per_day. It belongs to the
-- account: it goes with the account (on delete cascade), and outlives the
-- dealership it created (on delete set null), so deleting a dealership does
-- not give its creator another sign-up.
-- ---------------------------------------------------------------------------
create table public.signup_attempts (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  outcome text not null check (outcome in ('created', 'taken')),
  dealership_id uuid references public.dealerships (id) on delete set null
);
-- the caller's attempts in the past hour, and the caller's created ones
create index signup_attempts_user_at_idx on public.signup_attempts (user_id, at);
-- everyone's created ones in the past 24 hours
create index signup_attempts_created_at_idx on public.signup_attempts (at) where outcome = 'created';
-- the foreign key's set null when a dealership is deleted, and the export
create index signup_attempts_dealership_idx on public.signup_attempts (dealership_id);
comment on table public.signup_attempts is 'One row per create_dealership() call that looked up its website: created (with the new dealership) or taken. The throttle and the two limits count them; no API role reads or writes it.';

-- Nothing for anyone through the API: RLS on with no policy, and no
-- privilege for any API role (Supabase grants them all on a new table and
-- sequence by default; so does tests/local-shim.sql).
alter table public.signup_settings enable row level security;
alter table public.signup_attempts enable row level security;
revoke all on public.signup_settings from public, anon, authenticated, service_role;
revoke all on public.signup_attempts from public, anon, authenticated, service_role;
revoke all on sequence public.signup_attempts_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- website_origin_of(address): the origin Lot Sync keeps for a website
-- address a person typed (dealerships.website_origin, the key the extension
-- syncs under), or null when the address is refused. The same rule as
-- websiteOrigin() in manager/data.js; test/fixtures/website-origins.json is
-- the contract for both, and tests/signup.sql checks every case of it here.
-- Trim (the characters JavaScript's trim() removes, so the two copies agree);
-- no scheme means https; only http and https; the host lower-cased and one
-- trailing dot dropped; path, query and fragment dropped; the scheme's
-- default port dropped and any other port refused. Refused: user info, an IP
-- address, localhost, a host without a dot, and a label that is empty,
-- longer than 63 characters, starts or ends with a hyphen, or holds anything
-- but a-z, 0-9 and hyphens (a non-ASCII host is refused: the address bar
-- shows it, but the origin the extension sees is the xn-- form). The
-- characters are checked before the case is folded, so no character whose
-- lower case happens to be ASCII gets through.
-- ---------------------------------------------------------------------------
create or replace function public.website_origin_of(address text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  ws constant text := '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+';
  s text;
  scheme text;
  authority text;
  host text;
  port text;
  label text;
begin
  s := regexp_replace(coalesce(address, ''), '^' || ws || '|' || ws || '$', '', 'g');
  if s = '' then
    return null;
  end if;
  if s !~ '^[A-Za-z][A-Za-z0-9+.-]*://' then
    s := 'https://' || s;
  end if;
  scheme := lower(substring(s from '^([A-Za-z][A-Za-z0-9+.-]*)://'));
  if scheme not in ('http', 'https') then
    return null;
  end if;

  -- the host and port run to the first slash, question mark or hash
  authority := substring(s from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)');
  if position('@' in authority) > 0 then
    return null; -- user info
  end if;
  if authority !~ '^[^:]*(:[^:]*)?$' then
    return null; -- more than one colon: an IPv6 address, or worse
  end if;
  host := split_part(authority, ':', 1);
  port := split_part(authority, ':', 2);
  -- an empty port is no port, as in a browser
  if port <> '' and (port !~ '^0*[0-9]{1,5}$' or port::int <> case scheme when 'https' then 443 else 80 end) then
    return null;
  end if;

  if right(host, 1) = '.' then
    host := left(host, -1);
  end if;
  if host !~ '^[A-Za-z0-9.-]+$' then
    return null;
  end if;
  host := lower(host);
  if position('.' in host) = 0 or host = 'localhost' or host like '%.localhost' then
    return null;
  end if;
  foreach label in array string_to_array(host, '.') loop
    if label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
      return null;
    end if;
  end loop;
  -- a browser reads a host whose last label is a number as an IPv4 address
  if split_part(host, '.', -1) ~ '^([0-9]+|0x[0-9a-f]*)$' then
    return null;
  end if;
  return scheme || '://' || host;
end;
$$;
comment on function public.website_origin_of(text) is 'The origin kept for a typed website address (https unless http is given, host lower-cased, no path, no default port), or null when the address is refused. test/fixtures/website-origins.json is its contract.';

-- ---------------------------------------------------------------------------
-- create_dealership(name, website, your_name): the signed-in caller creates
-- a dealership and becomes its first manager, when sign-up is open and the
-- limits allow. In this order, each step before the next:
--   a. signed in, or 42501
--   b. sign-up is open, or P0008 (the invite code is the way in meanwhile)
--   c. fewer than 5 attempts by the caller in the past hour, or P0005
--   d. the three fields are usable, or 22023 naming the field
--   e. with the signup_settings row locked: the caller's created dealerships
--      are under per_account (P0010) and everyone's in the past 24 hours
--      under per_day (P0011)
--   f. no dealership has that website yet, or P0009 (recorded as taken)
--   g. the dealership, the caller's manager membership and a created
--      attempt, all at once
-- The lock in e is taken on the one settings row, so sign-ups are counted
-- one at a time: two at the same moment cannot both pass a limit that has
-- room for one, and the second sees the first one's website in f. It is
-- held until the call's transaction ends. The owner's own insert takes no
-- such lock, so a dealership with the same website can still appear
-- between f and g; the insert in g then does nothing and the caller gets
-- f's answer.
-- P0005 and P0009 are answered, not raised, the way redeem_invite()
-- answers a miss (0002_rls.sql): response.status 400 and the { code,
-- message, details, hint } body PostgREST gives a raised error, so the
-- attempt row a taken website writes survives the call and the throttle
-- counts it. Everything else is raised before anything is written.
-- P0009 tells anyone signed in that a website already has a Lot Sync
-- dealership. That is accepted: the person needs to know to ask its manager
-- for an invite, and the throttle (5 an hour per account, counted before
-- anything is looked up) and per_account (an account that has started a
-- dealership is refused at e, before any lookup) limit the probing.
-- SECURITY DEFINER because the caller may insert into none of these tables.
-- Parameters are written create_dealership.name and so on: name is also a
-- column of dealerships and memberships.
-- ---------------------------------------------------------------------------
create or replace function public.create_dealership(name text, website text, your_name text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  ws constant text := '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+';
  controls constant text := '[\u0001-\u001f\u007f-\u009f]';
  closed constant text := 'sign-up is not open: you join Lot Sync with an invite code, from Lot Sync or from your dealership''s manager';
  taken constant text := 'that website already has a Lot Sync dealership: ask its manager for an invite code (if nobody there uses Lot Sync, write to Lot Sync support)';
  settings public.signup_settings%rowtype;
  dealer_name text;
  person_name text;
  origin text;
  n bigint;
  new_id uuid;
begin
  -- a. signed in
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;

  -- b. open (no row reads as closed)
  if not coalesce((select s.open from public.signup_settings s where s.id), false) then
    raise exception '%', closed using errcode = 'P0008';
  end if;

  -- c. the throttle, before anything is looked up
  select count(*) into n from public.signup_attempts a where a.user_id = uid and a.at > now() - interval '1 hour';
  if n >= 5 then
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0005', 'message', 'too many attempts; try again in an hour', 'details', null::text, 'hint', null::text);
  end if;

  -- d. the fields, trimmed as website_origin_of() trims. A host longer than
  -- DNS allows (253 characters) is refused too: no real website has one, and
  -- it keeps the unique index on website_origin well under its row size
  -- limit. A long path or query is fine; the origin drops it.
  dealer_name := regexp_replace(coalesce(create_dealership.name, ''), '^' || ws || '|' || ws || '$', '', 'g');
  if length(dealer_name) not between 1 and 120 or dealer_name ~ controls then
    raise exception 'the dealership''s name must be 1 to 120 characters, with no line breaks, tabs or other control characters' using errcode = '22023';
  end if;
  origin := public.website_origin_of(create_dealership.website);
  if origin is null or length(origin) > length(split_part(origin, '://', 1)) + 3 + 253 then
    raise exception 'the website must be the dealership''s own web address, like www.example.com' using errcode = '22023';
  end if;
  person_name := regexp_replace(coalesce(create_dealership.your_name, ''), '^' || ws || '|' || ws || '$', '', 'g');
  if length(person_name) not between 1 and 80 or person_name ~ controls then
    raise exception 'your name must be 1 to 80 characters, with no line breaks, tabs or other control characters' using errcode = '22023';
  end if;

  -- e. the limits, one sign-up at a time; the owner may have closed sign-up
  -- while this call waited for the lock
  select * into settings from public.signup_settings s where s.id for update;
  if not found or not settings.open then
    raise exception '%', closed using errcode = 'P0008';
  end if;
  select count(*) into n from public.signup_attempts a where a.user_id = uid and a.outcome = 'created';
  if n >= settings.per_account then
    raise exception 'this account has already started a dealership; a second one is set up by Lot Sync: write to Lot Sync support' using errcode = 'P0010';
  end if;
  select count(*) into n from public.signup_attempts a where a.outcome = 'created' and a.at > now() - interval '24 hours';
  if n >= settings.per_day then
    raise exception 'no more new dealerships can start today; try again tomorrow, or write to Lot Sync support' using errcode = 'P0011';
  end if;

  -- f. a website that already has a dealership
  if exists (select 1 from public.dealerships d where d.website_origin = origin) then
    insert into public.signup_attempts (user_id, outcome) values (uid, 'taken');
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0009', 'message', taken, 'details', null::text, 'hint', null::text);
  end if;

  -- g. the dealership, its first manager and the record of it
  insert into public.dealerships as d (name, website_origin)
  values (dealer_name, origin)
  on conflict (website_origin) do nothing
  returning d.id into new_id;
  if new_id is null then
    insert into public.signup_attempts (user_id, outcome) values (uid, 'taken');
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0009', 'message', taken, 'details', null::text, 'hint', null::text);
  end if;
  insert into public.memberships (user_id, dealership_id, role, name) values (uid, new_id, 'manager', person_name);
  insert into public.signup_attempts (user_id, outcome, dealership_id) values (uid, 'created', new_id);

  return jsonb_build_object('dealership_id', new_id, 'name', dealer_name, 'website_origin', origin);
end;
$$;
comment on function public.create_dealership(text, text, text) is 'Self-serve sign-up: the signed-in caller creates a dealership and becomes its manager, when signup_settings.open and its limits allow. P0008 closed, P0005 throttled, 22023 a bad field, P0010 per account, P0011 per day, P0009 the website is taken.';

-- Only a signed-in person may sign up (PostgREST: /rest/v1/rpc/create_dealership);
-- the anon key and the service role may not. website_origin_of() is for
-- create_dealership() and the owner; the manager page has its own copy.
revoke execute on function public.create_dealership(text, text, text) from public, anon, service_role;
grant execute on function public.create_dealership(text, text, text) to authenticated;
revoke execute on function public.website_origin_of(text) from public, anon, authenticated, service_role;
