-- Lot Current: self-serve sign-up refuses U+061C ARABIC LETTER MARK in a
-- name, as it refuses the other text-direction marks.
--
-- 0010_backend_review_fixes.sql made create_dealership() refuse a
-- dealership or person name holding a Unicode line or paragraph separator
-- or one of "the marks, embeddings, overrides and isolates that reorder the
-- text after them", and listed U+200E, U+200F, U+202A to U+202E and U+2066
-- to U+2069. Unicode has one more such mark, U+061C ARABIC LETTER MARK
-- (Bidi_Control, like the others), which 0010 left out: a name holding it
-- was stored as typed and shown that way in the extension's account line,
-- the manager view and the usage report, although the error message
-- promises no control characters. The controls class below adds it, so it
-- now holds exactly the C0 and C1 controls, the two separators and every
-- Bidi_Control character. Nothing else changes.
--
-- create or replace replaces the function's whole definition, so its
-- language, security definer and search_path are written out again exactly
-- as before. Postgres keeps its owner and its grants (the revokes and
-- grants in 0007_signup.sql still decide who may execute it;
-- supabase/tests/signup.sql proves it), and its comment, which is restated
-- here unchanged. A change made after the project applied 0001 to 0008; it
-- applies on top of 0010 to 0012 as on a fresh build.

-- ---------------------------------------------------------------------------
-- create_dealership(name, website, your_name): as 0010_backend_review_fixes.sql
-- made it, with U+061C added to what its errors call line breaks and
-- control characters.
-- ---------------------------------------------------------------------------
create or replace function public.create_dealership(name text, website text, your_name text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  ws constant text := '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+';
  -- what the errors call line breaks and control characters: the C0 and C1
  -- controls, the line and paragraph separators, and the marks (U+061C,
  -- U+200E, U+200F), embeddings, overrides and isolates that reorder the
  -- text after them
  controls constant text := '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]';
  closed constant text := 'sign-up is not open: you join Lot Current with an invite code, from Lot Current or from your dealership''s manager';
  taken constant text := 'that website already has a Lot Current dealership: ask its manager for an invite code (if nobody there uses Lot Current, write to Lot Current support)';
  settings public.signup_settings%rowtype;
  dealer_name text;
  person_name text;
  origin text;
  n bigint;
  new_id uuid;
  pilot jsonb;
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
  -- the throttle again: calls sent together all passed c before any of
  -- them wrote its attempt, and here each one sees those ahead of it
  select count(*) into n from public.signup_attempts a where a.user_id = uid and a.at > now() - interval '1 hour';
  if n >= 5 then
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0005', 'message', 'too many attempts; try again in an hour', 'details', null::text, 'hint', null::text);
  end if;
  select count(*) into n from public.signup_attempts a where a.user_id = uid and a.outcome = 'created';
  if n >= settings.per_account then
    raise exception 'this account has already started a dealership; a second one is set up by Lot Current: write to Lot Current support' using errcode = 'P0010';
  end if;
  select count(*) into n from public.signup_attempts a where a.outcome = 'created' and a.at > now() - interval '24 hours';
  if n >= settings.per_day then
    raise exception 'no more new dealerships can start today; try again tomorrow, or write to Lot Current support' using errcode = 'P0011';
  end if;

  -- f. a website that already has a dealership. The stored origin is
  -- folded the way sameOrigin() in functions/_shared/http.ts folds it
  -- (trimmed, trailing slashes dropped, lower case): the owner types it by
  -- hand, and /sync serves a row stored as https://www.Example.com/ to the
  -- extension on https://www.example.com, so that website is taken.
  if exists (select 1 from public.dealerships d
             where lower(rtrim(regexp_replace(d.website_origin, '^' || ws || '|' || ws || '$', '', 'g'), '/')) = origin) then
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
  pilot := public.start_pilot(new_id); -- the caller is its manager now, as start_pilot() requires

  return jsonb_build_object('dealership_id', new_id, 'name', dealer_name, 'website_origin', origin, 'pilot_ends_at', pilot -> 'pilot_ends_at');
end;
$$;
comment on function public.create_dealership(text, text, text) is 'Self-serve sign-up: the signed-in caller creates a dealership, becomes its manager and its free pilot starts, when signup_settings.open and its limits allow. P0008 closed, P0005 throttled, 22023 a bad field, P0010 per account, P0011 per day, P0009 the website is taken.';
