-- Lot Sync, Milestone 5: billing on Stripe.
--
-- One row per dealership says where it stands: a free pilot period Lot Sync
-- grants itself (no card, no Stripe object), or a Stripe subscription whose
-- status the billing function copies in from webhooks. A second table keeps
-- every webhook event once, so a redelivered event is never applied twice.
--
-- Nothing here charges anyone: the Stripe objects, keys and prices are the
-- owner's to create (supabase/README.md, "Billing"). The numbers baked in
-- below (5 included salespeople, a 30-day pilot) come from
-- marketing/pricing.json, a hypothesis until a dealer pays;
-- test/billing.test.js keeps them equal.
--
-- Who writes what: managers start the pilot through start_pilot(); the
-- billing function writes the Stripe columns with the service role; members
-- read their own dealership's row and nothing else; billing_events is the
-- function's alone. subscription_state() turns the row into one word.

-- ---------------------------------------------------------------------------
-- subscriptions: the dealership's billing standing.
--   status  'pilot' is Lot Sync's own; the rest are every status Stripe can
--           put on a subscription, so a webhook never fails this check. Null
--           until the pilot starts or Stripe says something (a row with only
--           a customer id is a checkout that was opened and not finished).
--   pilot_ends_at  when the free period ends; set once by start_pilot().
--   current_period_end  the paid-through date from Stripe.
--   seats   salespeople the subscription covers: the included count plus
--           what the seat price's quantity adds. Informational for now.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  dealership_id uuid primary key references public.dealerships (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text check (status in ('pilot', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
  pilot_ends_at timestamptz,
  current_period_end timestamptz,
  seats integer not null default 5 check (seats >= 1),
  updated_at timestamptz not null default now()
);
comment on table public.subscriptions is 'One row per dealership: the free pilot period or the Stripe subscription''s status, as the billing function copies it in.';
comment on column public.subscriptions.status is 'pilot (Lot Sync''s own free period) or a Stripe subscription status; null until either exists.';
comment on column public.subscriptions.seats is 'Salespeople the subscription covers: the included count (5, marketing/pricing.json) plus the seat price''s quantity.';

-- ---------------------------------------------------------------------------
-- billing_events: every Stripe webhook event the function accepted, once.
-- stripe_event_id is unique, which is the whole deduplication. payload is
-- the event as Stripe sent it (ids, statuses, amounts, the billing email;
-- never a card number, which Stripe does not send). Read by nobody through
-- the API; the owner looks in the SQL editor when something is off.
-- ---------------------------------------------------------------------------
create table public.billing_events (
  id bigserial primary key,
  stripe_event_id text not null unique,
  type text not null,
  received_at timestamptz not null default now(),
  payload jsonb
);
create index billing_events_received_idx on public.billing_events (received_at);
comment on table public.billing_events is 'Stripe webhook events, one row each (stripe_event_id unique): the deduplication and the audit trail. Written by the billing function only.';

-- ---------------------------------------------------------------------------
-- subscription_state(dealership_id): one word from the row.
--   none    no row, or a row with no status and no pilot
--   pilot   pilot_ends_at is in the future and nothing is paid
--   active  trialing or active on Stripe
--   lapsed  everything else (pilot over unpaid, past_due, unpaid, canceled,
--           incomplete, incomplete_expired, paused)
-- SECURITY INVOKER on purpose: the row is read under the caller's RLS, so a
-- person who is not a member of that dealership gets 'none', the same as
-- for a dealership that does not exist, and learns nothing. The function
-- calls it with the service role and sees the truth. Kept equal to
-- subscriptionState() in functions/_shared/billing.mjs.
-- ---------------------------------------------------------------------------
create or replace function public.subscription_state(dealership_id uuid)
returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce((
    select case
      when s.status in ('trialing', 'active') then 'active'
      when s.pilot_ends_at is not null and s.pilot_ends_at > now() then 'pilot'
      when s.status is null and s.pilot_ends_at is null then 'none'
      else 'lapsed'
    end
    from public.subscriptions s
    where s.dealership_id = subscription_state.dealership_id
  ), 'none');
$$;
comment on function public.subscription_state(uuid) is 'none | pilot | active | lapsed for a dealership, from its subscriptions row under the caller''s RLS.';

-- ---------------------------------------------------------------------------
-- start_pilot(dealership_id): a manager starts the free pilot period, no
-- card: status 'pilot', pilot_ends_at 30 days from now (marketing/
-- pricing.json pilotDays). Only when the dealership has no billing standing
-- yet: no row, or the shell of one (a customer id from a checkout that was
-- never finished, no status, no pilot). A second call, or one on a
-- dealership that already pays or already had its pilot, changes nothing
-- and says so with started = false; the pilot never restarts. SECURITY
-- DEFINER because managers have no insert or update right on the table;
-- the manager check is the first line. The parameter shares its name with
-- the column (PostgREST wants it so: rpc/start_pilot takes
-- { "dealership_id": ... }), hence use_column: a bare dealership_id is the
-- column and the parameter is always written start_pilot.dealership_id.
-- ---------------------------------------------------------------------------
create or replace function public.start_pilot(dealership_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  sub public.subscriptions%rowtype;
  started boolean := false;
begin
  if uid is null or not public.is_manager(start_pilot.dealership_id) then
    raise exception 'only a manager of this dealership can start its pilot' using errcode = '42501';
  end if;

  insert into public.subscriptions as s (dealership_id, status, pilot_ends_at, seats, updated_at)
  values (start_pilot.dealership_id, 'pilot', now() + interval '30 days', 5, now())
  on conflict (dealership_id) do update
    set status = 'pilot',
        pilot_ends_at = now() + interval '30 days',
        updated_at = now()
    where s.status is null and s.pilot_ends_at is null
  returning * into sub;
  started := found;

  if not started then
    select * into sub from public.subscriptions s where s.dealership_id = start_pilot.dealership_id;
  end if;

  return jsonb_build_object(
    'dealership_id', start_pilot.dealership_id,
    'started', started,
    'status', sub.status,
    'pilot_ends_at', sub.pilot_ends_at,
    'state', public.subscription_state(start_pilot.dealership_id)
  );
end;
$$;
comment on function public.start_pilot(uuid) is 'A manager starts the dealership''s free 30-day pilot (no card). Once; a later call reports the standing without changing it.';

-- Signed-in users and the functions may call the two; the anon key may not.
revoke execute on function public.subscription_state(uuid) from public, anon;
revoke execute on function public.start_pilot(uuid) from public, anon;
grant execute on function public.subscription_state(uuid) to authenticated, service_role;
grant execute on function public.start_pilot(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row-level security and privileges, in the shape of 0002_rls.sql: RLS on,
-- the anon key gets nothing, signed-in members may only read, the service
-- role (inside the billing function only) does the writing.
-- ---------------------------------------------------------------------------
alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;

revoke all on public.subscriptions from anon, authenticated, public;
revoke all on public.billing_events from anon, authenticated, public;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions, public.billing_events to service_role;
grant usage, select on sequence public.billing_events_id_seq to service_role;

-- subscriptions: every member of the dealership may see where it stands
-- (the extension shows a pilot's end date; the manager page shows the
-- buttons). No insert, update or delete policy for signed-in users at all:
-- the pilot starts through start_pilot() and everything else comes from
-- Stripe through the function's service-role client.
create policy "members read their dealership's subscription"
  on public.subscriptions for select to authenticated
  using (public.is_member(dealership_id));
comment on policy "members read their dealership's subscription" on public.subscriptions is 'Any member sees their own dealership''s billing standing and nobody else''s. Writes go through start_pilot() and the billing function only.';

-- billing_events: no policy at all, so with RLS on no API role sees a row.
-- The billing function reads and writes it with the service role, which
-- bypasses RLS as it always does on Supabase.
