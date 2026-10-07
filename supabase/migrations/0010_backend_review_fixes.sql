-- Lot Current: changes from the review of 0001 to 0008, made after the
-- production project had applied those files.
--
-- 0001 to 0008 are applied in production, so they are never edited again,
-- not even their comments: `supabase db push` skips a file it has applied,
-- so an edit would reach a fresh build and never production
-- (supabase/README.md, step 2; test/supabase.test.js holds each of the
-- eight to its SHA-256). Every later change is a new numbered file like
-- this one. This one changes three functions:
--   redeem_invite()      one account's calls take turns at the throttle, the
--                        throttle is answered rather than raised, and a code
--                        never lowers a role (P0012)
--   create_dealership()  refuses a name holding a Unicode line break or a
--                        text-direction control
--   usage_report()       leaves a scan stamped ahead of the clock out of
--                        last_synced_scan_at
-- and corrects, just below, comments in the earlier files that no longer
-- say what the code does. Where an earlier comment and this file disagree,
-- this file is right.
--
-- create or replace replaces a function's whole definition, so each one's
-- language, security definer or invoker and search_path are written out
-- again exactly as before. Postgres keeps its owner and its grants (the
-- revokes and grants in 0002, 0007 and 0008 still decide who may execute
-- it; supabase/tests prove it for each), and its comment, which is
-- restated here with each function, in new words only where the behaviour
-- changed.

-- ---------------------------------------------------------------------------
-- Comments in earlier files that this file corrects (nothing to run)
--   0002_rls.sql, listings: the policies let a manager update any row of
--     the dealership (fixing a link, marking a take-down after the
--     salesperson left), but the manager view has no such action yet: it
--     lists a former member's listed cars for the manager to chase.
--   0002_rls.sql, post_attempts: its select policy lets every member read
--     all of the dealership's, not only a manager.
--     0011_ui_post_attempts_read.sql replaces that policy: a salesperson
--     reads their own attempts and a manager all of the dealership's, as
--     the privacy texts say. A salesperson records only their own attempts;
--     a manager can correct any; only managers delete.
--   0002_rls.sql, todo_items: the policies let any member add or close an
--     item, but today only the poster's own extension does either (its
--     rescan flags the salesperson's own listings, extension/src/pilot.js
--     noteFlags), and the manager view has no tick-off.
--   0002_rls.sql, redeem_invite(): replaced below, where its changes are
--     described.
--   0004_billing.sql, subscription_state(dealership_id): No Edge Function
--     calls it, with the service role or otherwise. It is called by
--     start_pilot() and by the owner's usage_report() (0008_usage.sql).
--     /sync, /rewrite and billing compute the same word from the row they
--     read, with subscriptionState() and planOf() in
--     functions/_shared/billing.mjs. A change to the rule goes into both;
--     supabase/tests/billing.sql and test/billing.test.js hold them to it.
--   0008_usage.sql, usage_report(): replaced below, where its column notes
--     are corrected.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- redeem_invite(code, display_name): as 0002_rls.sql made it, with three
-- changes.
--   1. One account's calls take turns at the throttle: a transaction lock
--      per account, taken before the count and held until the call's
--      transaction ends, so the next call's count sees this call's miss.
--      Calls sent together would otherwise each count before any of them
--      had written its miss, and every one of them would be looked up
--      (supabase/tests/concurrency.sql).
--   2. The throttle's 'too many attempts; try again in an hour' (P0005) is
--      answered, not raised, the way a miss is: by then the call has
--      dropped every account's misses older than an hour, and a raise
--      would bring them back.
--   3. A code can raise a member's role, never lower it. A salesperson who
--      redeems a manager code becomes a manager (and may take a new name),
--      but a member whose role is already the code's or above (a manager
--      given a salesperson code meant for a new hire, say) changes nothing.
--      That caller is answered 'you are already a <role> of this
--      dealership; the code was not used' (P0012, status 400, answered like
--      a miss but not counted as one), and the code stays unused for the
--      person it was made for.
-- Everything else is as 0002_rls.sql describes it: one answer (P0002) for
-- an unknown, used, expired or cancelled code, every miss counted in
-- invite_misses and answered rather than raised so the count survives, the
-- code compared ignoring case and surrounding spaces on both sides.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_invite(code text, display_name text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv public.invites%rowtype;
  dealer public.dealerships%rowtype;
  member public.memberships%rowtype;
  misses bigint;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- the throttle, before anything is looked up, one call of this account at
  -- a time: the lock is held until this call's transaction ends, so the
  -- next call's count, a statement that starts after it gets the lock, sees
  -- this call's miss. Misses older than an hour no longer count and are
  -- dropped, everyone's, so an account that never tries again does not
  -- keep its misses; a throttled call is answered, not raised, so that
  -- delete is kept
  perform pg_advisory_xact_lock(hashtext('redeem_invite'), hashtext(uid::text));
  delete from public.invite_misses where invite_misses.at < now() - interval '1 hour';
  select count(*) into misses from public.invite_misses where invite_misses.user_id = uid;
  if misses >= 10 then
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0005', 'message', 'too many attempts; try again in an hour', 'details', null::text, 'hint', null::text);
  end if;

  -- both sides folded
  select * into inv
  from public.invites i
  where upper(trim(i.code)) = upper(trim(redeem_invite.code))
  for update;
  if not found
     or inv.used_at is not null
     or inv.expires_at <= now()
     or (inv.created_by is not null and not exists (
           select 1 from public.memberships m
           where m.user_id = inv.created_by
             and m.dealership_id = inv.dealership_id
             and m.role = 'manager')) then
    insert into public.invite_misses (user_id) values (uid);
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0002', 'message', 'that invite code is not valid', 'details', null::text, 'hint', null::text);
  end if;

  -- already a member at the code's role or above: nothing changes, the
  -- code stays unused, and no miss is counted (the code was a real one)
  select * into member from public.memberships m
  where m.user_id = uid and m.dealership_id = inv.dealership_id;
  if found and (member.role = 'manager' or member.role = inv.role) then
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'P0012', 'message', format('you are already a %s of this dealership; the code was not used', member.role), 'details', null::text, 'hint', null::text);
  end if;

  insert into public.memberships as m (user_id, dealership_id, role, name)
  values (uid, inv.dealership_id, inv.role, nullif(trim(coalesce(redeem_invite.display_name, '')), ''))
  on conflict (user_id, dealership_id) do update
    set role = excluded.role,
        name = coalesce(excluded.name, m.name)
  returning * into member;

  update public.invites
  set used_by = uid, used_at = now()
  where invites.code = inv.code;

  select * into dealer from public.dealerships d where d.id = inv.dealership_id;
  return jsonb_build_object(
    'dealership_id', dealer.id,
    'dealership_name', dealer.name,
    'website_origin', dealer.website_origin,
    'role', member.role,
    'name', member.name
  );
end;
$$;
comment on function public.redeem_invite(text, text) is 'Makes the signed-in caller a member of the invite''s dealership and marks the code used. The only way in through the API. One answer (P0002) for an unknown, used, expired or cancelled code; P0005 after 10 misses in an hour; P0012, with the code left unused, for a member whose role is already the code''s or above (a code never lowers a role).';

-- ---------------------------------------------------------------------------
-- create_dealership(name, website, your_name): as 0007_signup.sql made it,
-- with one change. What its errors call line breaks and control characters
-- now covers, beside the C0 and C1 controls, the line and paragraph
-- separators (U+2028, U+2029) and the marks, embeddings, overrides and
-- isolates that reorder the text after them (U+200E, U+200F, U+202A to
-- U+202E, U+2066 to U+2069). A dealership or person name holding one is
-- refused with 22023, as a name with a line break always was, instead of
-- being stored as typed and shown that way in the extension's account
-- line, the manager view and the usage report.
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
  -- controls, the line and paragraph separators, and the marks,
  -- embeddings, overrides and isolates that reorder the text after them
  controls constant text := '[\u0001-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]';
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

-- ---------------------------------------------------------------------------
-- usage_report(since): as 0008_usage.sql made it, with one change, and a
-- correction to its column notes there.
--   last_synced_scan_at  leaves out a scan stamped more than 5 minutes
--                        ahead of the database's clock (a machine whose
--                        clock ran ahead; /sync refuses one now, with the
--                        same margin), so such a scan cannot pin the figure
--                        until its date comes.
--   open_take_downs      (the correction) open todo_items of kind takeDown:
--                        sold cars the poster's own extension flagged, not
--                        yet marked down. A car left listed by a former
--                        member is never flagged, so it is not in this count.
-- Every other column is as 0008_usage.sql explains it.
-- ---------------------------------------------------------------------------
create or replace function public.usage_report(since timestamptz default now() - interval '7 days')
returns table (
  dealership_id uuid,
  name text,
  website_origin text,
  created_at timestamptz,
  plan_state text,
  pilot_ends_at timestamptz,
  current_period_end timestamptz,
  managers integer,
  salespeople integer,
  active_salespeople integer,
  posts integer,
  cars_listed_now integer,
  open_take_downs integer,
  open_price_changes integer,
  oldest_open_hours numeric,
  last_synced_scan_at timestamptz,
  rewrite_calls integer
)
language sql stable security invoker
set search_path = ''
as $$
  with w as (
    select coalesce(usage_report.since, '-infinity'::timestamptz) as since
  )
  select
    r.dealership_id, r.name, r.website_origin, r.created_at,
    r.plan_state, r.pilot_ends_at, r.current_period_end,
    r.managers, r.salespeople, r.active_salespeople, r.posts, r.cars_listed_now,
    r.open_take_downs, r.open_price_changes, r.oldest_open_hours,
    r.last_synced_scan_at, r.rewrite_calls
  from (
    select
      d.id as dealership_id,
      d.name,
      d.website_origin,
      d.created_at,
      public.subscription_state(d.id) as plan_state,
      s.pilot_ends_at,
      s.current_period_end,
      (select count(*) from public.memberships m where m.dealership_id = d.id and m.role = 'manager')::integer as managers,
      (select count(*) from public.memberships m where m.dealership_id = d.id and m.role = 'salesperson')::integer as salespeople,
      (select count(distinct l.user_id)
         from public.listings l
         join public.memberships m on m.dealership_id = l.dealership_id and m.user_id = l.user_id and m.role = 'salesperson'
         where l.dealership_id = d.id and l.posted_at >= w.since)::integer as active_salespeople,
      (select count(*) from public.listings l where l.dealership_id = d.id and l.posted_at >= w.since)::integer as posts,
      (select count(distinct l.vin) from public.listings l where l.dealership_id = d.id and l.status = 'listed')::integer as cars_listed_now,
      (select count(*) from public.todo_items t where t.dealership_id = d.id and t.done_at is null and t.kind = 'takeDown')::integer as open_take_downs,
      (select count(*) from public.todo_items t where t.dealership_id = d.id and t.done_at is null and t.kind = 'price')::integer as open_price_changes,
      (select round((extract(epoch from (now() - min(t.flagged_at))) / 3600)::numeric, 1)
         from public.todo_items t where t.dealership_id = d.id and t.done_at is null) as oldest_open_hours,
      (select max(x.taken_at) from public.scan_summaries x where x.dealership_id = d.id and x.taken_at <= now() + interval '5 minutes') as last_synced_scan_at,
      (select count(*) from public.rewrite_usage u where u.dealership_id = d.id and u.kind = 'rewrite' and u.at >= w.since)::integer as rewrite_calls
    from public.dealerships d
    cross join w
    left join public.subscriptions s on s.dealership_id = d.id
  ) r
  order by r.active_salespeople desc, r.name, r.dealership_id;
$$;
comment on function public.usage_report(timestamptz) is 'Owner only. One row per dealership since a time (default 7 days ago): plan, members by role, active salespeople, posts, cars listed, open to-do items, the newest synced scan, rewrite calls.';
