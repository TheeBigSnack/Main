-- Lot Sync, Milestone 4: views for the manager page.
--
-- Both views are SECURITY INVOKER (Postgres 15+): they run with the caller's
-- rights, so the row-level security of the tables underneath applies and a
-- manager reading v_salesperson_summary gets their own dealership's people
-- and nobody else's. manager/data.js can compute the same numbers from the
-- raw rows; these are for a quick look in the dashboard or a spreadsheet
-- export without the page.

-- ---------------------------------------------------------------------------
-- v_salesperson_summary: one row per member of each dealership with how
-- many of their listings are up, how many were taken down, and the median
-- seconds per post over their attempts that ended in a post (the pilot's
-- "time per post"; abandoned attempts are not in the median). Managers who
-- never post appear with zeros; role lets the page leave them out.
-- ---------------------------------------------------------------------------
create or replace view public.v_salesperson_summary
with (security_invoker = true) as
select
  m.dealership_id,
  m.user_id,
  m.name,
  m.role,
  (count(l.id) filter (where l.status = 'listed'))::integer as listed,
  (count(l.id) filter (where l.status = 'taken_down'))::integer as taken_down,
  (
    select round((percentile_cont(0.5) within group (order by a.seconds))::numeric, 1)
    from public.post_attempts a
    where a.dealership_id = m.dealership_id
      and a.user_id = m.user_id
      and a.outcome = 'posted'
      and a.seconds is not null
  ) as median_seconds
from public.memberships m
left join public.listings l
  on l.dealership_id = m.dealership_id
 and l.user_id = m.user_id
group by m.dealership_id, m.user_id, m.name, m.role;
comment on view public.v_salesperson_summary is 'Per dealership and member: listings up, taken down, median seconds per post. Runs under the caller''s RLS.';

-- ---------------------------------------------------------------------------
-- v_open_todo: the to-do items still open (done_at is null) with how many
-- hours they have been open, joined to the listing with the same VIN (the
-- one that is up, else the latest) for who posted it and the listing link.
-- Sorted by the page; the longest-open items are the ones a manager wants
-- first.
-- ---------------------------------------------------------------------------
create or replace view public.v_open_todo
with (security_invoker = true) as
select
  t.id,
  t.dealership_id,
  t.vin,
  t.kind,
  t.name,
  t.flagged_at,
  t.from_price,
  t.to_price,
  round((extract(epoch from (now() - t.flagged_at)) / 3600)::numeric, 1) as hours_open,
  l.user_id,
  l.salesperson,
  l.listing_url,
  l.price as listed_price,
  l.posted_at
from public.todo_items t
left join lateral (
  select l.user_id, l.salesperson, l.listing_url, l.price, l.posted_at
  from public.listings l
  where l.dealership_id = t.dealership_id
    and l.vin = t.vin
  order by (l.status = 'listed') desc, l.posted_at desc
  limit 1
) l on true
where t.done_at is null;
comment on view public.v_open_todo is 'Open to-do items with hours open and the listing (who posted, link) they belong to. Runs under the caller''s RLS.';

-- Signed-in members only (through the tables' RLS); the anon key gets nothing,
-- stated here because Supabase's default privileges would otherwise grant it.
revoke all on public.v_salesperson_summary, public.v_open_todo from anon, public;
grant select on public.v_salesperson_summary, public.v_open_todo to authenticated, service_role;
