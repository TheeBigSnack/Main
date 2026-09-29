-- Lot Sync: the owner's usage report (PLAN.md M6: the demo is "the partner
-- list with usage numbers", and acceptance 1 asks that each partner dealer
-- has at least two active salespeople and one manager using the manager
-- view).
--
-- One row per dealership: who it is, where its plan stands, how many people
-- it has and what they did since a given time. The owner runs it by hand,
-- in the Dashboard's SQL editor (which connects as postgres), once a week
-- for the partner list (docs/launch-checklist.md, "Design partners"):
--
--   select * from public.usage_report();                            the past 7 days
--   select * from public.usage_report(now() - interval '30 days');  any other window
--
-- What each column means and how to read it: supabase/README.md, "Usage
-- report". Proven by supabase/tests/usage.sql.
--
-- No API role may execute it: it reads every dealership, and no dealership
-- may see another's numbers. Postgres grants execute on a new function to
-- public, and Supabase's default privileges grant it to anon, authenticated
-- and service_role as well, so the revoke at the end names all four. It is
-- SECURITY INVOKER: it runs with the rights of whoever calls it, which is
-- postgres, the owner of every table here, so a grant made by mistake would
-- still give a caller nothing their own rights do not (a signed-in member
-- would count only the rows row-level security already shows them).
--
-- Every column is read from the tables as they are; nothing is scored,
-- weighted or estimated. It reads dealerships, subscriptions (through
-- subscription_state() too), memberships, listings, todo_items,
-- scan_summaries and rewrite_usage, and writes nothing.
--
-- The window is posted_at >= since (and at >= since for rewrite_usage),
-- with no upper end, so a row stamped exactly at since counts and one a
-- moment earlier does not. A null since counts from the beginning, rather
-- than answering zeros that would read as a quiet week.

-- ---------------------------------------------------------------------------
-- usage_report(since): one row per dealership, the busiest first.
--   dealership_id, name, website_origin, created_at   the dealerships row
--   plan_state          subscription_state(): none, pilot, active or lapsed,
--                       the rule /sync and /rewrite serve by, so it is called
--                       rather than copied
--   pilot_ends_at, current_period_end   the subscriptions row (null without one)
--   managers, salespeople   memberships by role, today
--   active_salespeople  members with the salesperson role who have at least
--                       one listing posted since `since`. A manager who posts
--                       is counted in posts, not here: M6 asks for two
--                       salespeople and a manager, and a manager counted
--                       twice would meet it with one salesperson. Someone
--                       no longer a member is not counted either (their
--                       posts stay in posts: they are the dealership's).
--   posts               listings posted since `since`, whoever posted them
--                       and whatever their status now (a post taken down
--                       later was still a post). posted_at is when the
--                       salesperson's browser recorded the post; created_at
--                       would move a post uploaded late into the week it
--                       reached the server.
--   cars_listed_now     VINs with a listing marked listed
--   open_take_downs     open todo_items of kind takeDown: sold cars still listed
--   open_price_changes  open todo_items of kind price: a website price the
--                       listing does not show yet
--   oldest_open_hours   hours since the oldest open item of either kind was
--                       flagged, as v_open_todo counts them; null when none is open
--   last_synced_scan_at the newest scan_summaries.taken_at. The database
--                       keeps no log of syncs: /sync records no row for a
--                       call as such. What every sync does carry is the
--                       counts of that machine's newest scan (a repeat is
--                       stored once), under the time the scan ran on that
--                       machine's clock, and nothing in Lot Sync but /sync
--                       writes that table. So this is when the newest scan
--                       to reach the database ran; it stops moving when
--                       nobody's extension syncs, or when the plan lapses
--                       (/sync then writes nothing). listings.created_at,
--                       the server's clock, moves only with a new post, so
--                       it would say less.
--   rewrite_calls       rewrite_usage rows of kind rewrite since `since`: the
--                       description writer's calls to the Anthropic API
--                       (kind color, the photo color guess, is not counted)
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
      (select max(x.taken_at) from public.scan_summaries x where x.dealership_id = d.id) as last_synced_scan_at,
      (select count(*) from public.rewrite_usage u where u.dealership_id = d.id and u.kind = 'rewrite' and u.at >= w.since)::integer as rewrite_calls
    from public.dealerships d
    cross join w
    left join public.subscriptions s on s.dealership_id = d.id
  ) r
  order by r.active_salespeople desc, r.name, r.dealership_id;
$$;
comment on function public.usage_report(timestamptz) is 'Owner only. One row per dealership since a time (default 7 days ago): plan, members by role, active salespeople, posts, cars listed, open to-do items, the newest synced scan, rewrite calls.';

-- Owner only: nobody through the API, the service role included.
revoke execute on function public.usage_report(timestamptz) from public, anon, authenticated, service_role;
