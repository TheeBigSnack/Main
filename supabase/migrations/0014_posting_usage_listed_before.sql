-- Lot Current: the owner's usage report leaves out listings made by hand
-- before the day they were marked posted.
--
-- 0012_posting_listed_before.sql added listings.listed_before: a listing
-- the salesperson made by hand before the day they marked it posted, whose
-- posted_at is the moment of marking. The sync function leaves such rows
-- out of the day's post count and the manager view out of "Posted this
-- week", but usage_report (last made in 0010_backend_review_fixes.sql)
-- still counted them: a salesperson who marked a dozen old listings on
-- their first day showed a dozen posts that week and counted as an active
-- salesperson without posting a car.
--
-- usage_report(since): as 0010_backend_review_fixes.sql made it, with one
-- change.
--   active_salespeople  members with the salesperson role who posted at
--                       least one listing in the window; a listing marked
--                       as made before that day (listed_before) is not a
--                       post and makes no one active.
--   posts               listings posted in the window, by anyone, whatever
--                       their status now, leaving out the ones marked as
--                       made before that day (listed_before).
-- cars_listed_now still counts those listings: they are up. Every other
-- column is as 0008_usage.sql and 0010_backend_review_fixes.sql explain it.
-- The signature, language, security and search_path are 0008's, written out
-- again; Postgres keeps the function's owner and grants (execute stays
-- revoked from every API role). A change made after the project applied
-- 0001 to 0008; it applies on top of 0013 as on a fresh build.

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
         where l.dealership_id = d.id and l.posted_at >= w.since and not l.listed_before)::integer as active_salespeople,
      (select count(*) from public.listings l where l.dealership_id = d.id and l.posted_at >= w.since and not l.listed_before)::integer as posts,
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
comment on function public.usage_report(timestamptz) is 'Owner only. One row per dealership since a time (default 7 days ago): plan, members by role, active salespeople, posts (not listings marked as made before that day), cars listed, open to-do items, the newest synced scan, rewrite calls.';
