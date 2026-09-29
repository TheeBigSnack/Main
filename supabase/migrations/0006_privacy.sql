-- Lot Sync: the owner's privacy tools (legal/privacy-policy.md, "Your
-- choices and rights" and "Retention").
--
-- The policy says a customer can ask for its dealership's records to be
-- exported or deleted, that a person has rights of access, correction and
-- deletion, and that a dealership's records are deleted within 30 days of
-- its subscription ending. These functions are how the owner does it, by
-- hand, in the Dashboard's SQL editor (which connects as postgres):
--
--   export_dealership(dealership_id)           every row of one dealership, as one JSON document
--   delete_dealership(dealership_id, confirm)  that dealership and every row it owns, once confirm is its website_origin
--   forget_person(user_id, confirm)            one person's account, memberships and name, once confirm is their email
--   billing_events_of(dealership_id)           the Stripe events that belong to a dealership (used by the two above)
--
-- Who may ask for which, and how a request is verified: docs/support.md,
-- "Privacy requests". What to run and what to hand over:
-- supabase/README.md, "Export or delete a dealership's data". Proven by
-- supabase/tests/privacy.sql.
--
-- No API role may execute any of them. Postgres grants execute on a new
-- function to public, and Supabase's default privileges grant it to anon,
-- authenticated and service_role as well, so the revokes at the end name all
-- four. They are SECURITY INVOKER: they run with the rights of whoever calls
-- them, which is postgres, the owner of every table here, so a grant made by
-- mistake would still give a caller nothing their own rights do not.
--
-- The foreign keys already do the deleting, and these functions let them:
-- every dealership_id references dealerships with on delete cascade
-- (0001_schema.sql, 0004_billing.sql), and memberships.user_id references
-- auth.users with on delete cascade. Nothing here disables a trigger or
-- deletes around one. keep_a_manager (0002_rls.sql) lets a dealership's own
-- deletion take its last manager and refuses anything else that would leave
-- a dealership with none; forget_person checks for that first and says
-- which dealership needs a new manager (P0006, the trigger's own code).
--
-- Tables without a dealership_id, and what happens to them here:
--   billing_events  no foreign key; matched to a dealership by billing_events_of(). Exported with the dealership,
--                   and kept when it is deleted: they are the accounting record the policy's retention line keeps.
--   invite_misses   per account, not per dealership: not exported; forget_person deletes the person's.
--   demo_requests   a visitor's request, sent before any dealership exists: not exported; forget_person deletes
--                   the ones sent from the person's email.
--
-- Error codes: P0002 no such dealership or account; P0007 confirm does not
-- match, nothing changed; P0006 the person is the last manager of a
-- dealership, nothing changed.

-- ---------------------------------------------------------------------------
-- billing_events_of(dealership_id): the webhook events that belong to one
-- dealership. billing_events has no dealership_id (the webhook records an
-- event before, or without, finding a dealership for it), so an event
-- belongs to a dealership when its object's customer is the dealership's
-- Stripe customer, or when a dealership_id anywhere under the event's object
-- is this one: Checkout writes it into the subscription's metadata, and
-- Stripe puts a copy of that metadata on each of the subscription's invoices
-- (subscription_details). The customer match also finds the events of an
-- older subscription on the same customer.
-- Reads billing_events and subscriptions.
-- ---------------------------------------------------------------------------
create or replace function public.billing_events_of(dealership_id uuid)
returns setof public.billing_events
language sql stable security invoker
set search_path = ''
as $$
  select e.*
  from public.billing_events e
  left join public.subscriptions s on s.dealership_id = billing_events_of.dealership_id
  where (s.stripe_customer_id is not null and e.payload #>> '{data,object,customer}' = s.stripe_customer_id)
     or jsonb_path_exists(e.payload, '$.data.object.**.dealership_id ? (@ == $id)', jsonb_build_object('id', billing_events_of.dealership_id::text))
  order by e.received_at, e.id;
$$;
comment on function public.billing_events_of(uuid) is 'Owner only. The Stripe webhook events that belong to a dealership: by its customer id, or by the dealership_id Stripe carries in metadata.';

-- ---------------------------------------------------------------------------
-- export_dealership(dealership_id): one JSON document with every row of that
-- dealership, for a manager who asked for a copy of its records.
--   dealership      the dealerships row
--   memberships     every member, each with the email of their account (auth.users)
--   listings, todo_items, scan_summaries, post_attempts, rewrite_usage,
--   subscriptions   every row, as stored
--   invites         every row; the code of an unused invite is left out (null)
--   billing_events  billing_events_of(), payload included
--   counts          rows per list; notes: what is in the file and what is not
-- Left out on purpose: the code of an unused invite (it may still let
-- someone join for up to 7 days, and an export is a file that gets
-- forwarded; the manager view lists the open codes to managers), the emails
-- of people who are no longer members (their email is theirs, not the
-- dealership's), invite_misses and demo_requests (not the dealership's).
-- A former member's rows stay in the file under their user id and with the
-- salesperson name they posted under: removing a member clears neither, and
-- only forget_person (below) clears the name. The notes say so. Reads every
-- table above and auth.users; writes nothing.
-- ---------------------------------------------------------------------------
create or replace function public.export_dealership(dealership_id uuid)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  d public.dealerships%rowtype;
  doc jsonb;
begin
  select * into d from public.dealerships x where x.id = export_dealership.dealership_id;
  if not found then
    raise exception 'no dealership has the id %', export_dealership.dealership_id using errcode = 'P0002';
  end if;

  doc := jsonb_build_object(
    'exported_at', now(),
    'dealership', to_jsonb(d),
    'memberships', coalesce((
      select jsonb_agg(to_jsonb(m) || jsonb_build_object('email', u.email) order by m.role, m.name, m.user_id)
      from public.memberships m
      left join auth.users u on u.id = m.user_id
      where m.dealership_id = d.id), '[]'::jsonb),
    'listings', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.posted_at, l.id)
      from public.listings l where l.dealership_id = d.id), '[]'::jsonb),
    'todo_items', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.flagged_at, t.id)
      from public.todo_items t where t.dealership_id = d.id), '[]'::jsonb),
    'scan_summaries', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.taken_at, s.id)
      from public.scan_summaries s where s.dealership_id = d.id), '[]'::jsonb),
    'post_attempts', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.started_at, a.id)
      from public.post_attempts a where a.dealership_id = d.id), '[]'::jsonb),
    'rewrite_usage', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.at, r.id)
      from public.rewrite_usage r where r.dealership_id = d.id), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(
               case when i.used_at is null then (to_jsonb(i) - 'code') || jsonb_build_object('code', null) else to_jsonb(i) end
               order by i.created_at, i.code)
      from public.invites i where i.dealership_id = d.id), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(to_jsonb(s))
      from public.subscriptions s where s.dealership_id = d.id), '[]'::jsonb),
    'billing_events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.received_at, e.id)
      from public.billing_events_of(d.id) e), '[]'::jsonb)
  );

  return doc || jsonb_build_object(
    'counts', (select jsonb_object_agg(k.key, jsonb_array_length(k.value)) from jsonb_each(doc) k where jsonb_typeof(k.value) = 'array'),
    'notes', jsonb_build_array(
      'Every row Lot Sync''s database holds for this dealership, one list per table, as stored.',
      'memberships carries each current member''s account email. People who are no longer members have no email here; the rows they made keep their user_id and the salesperson name they posted under, unless they asked to be forgotten.',
      'The code of an unused invite is left out (null): it may still let someone join. Managers see open codes in the manager view.',
      'Not in the database, so not here: what each salesperson''s browser keeps (Settings, the Numbers tab, which form fields could not be filled). Nothing from Facebook beyond the listing links saved in listings.'
    )
  );
end;
$$;
comment on function public.export_dealership(uuid) is 'Owner only. Every row of one dealership as one JSON document, member emails included, unused invite codes left out.';

-- ---------------------------------------------------------------------------
-- delete_dealership(dealership_id, confirm): deletes the dealership row, and
-- with it, through the foreign keys' on delete cascade, every row it owns:
-- memberships (the last manager's included), listings, todo_items,
-- scan_summaries, post_attempts, rewrite_usage, invites, subscriptions.
-- Only when confirm is the dealership's website_origin exactly as stored
-- (scheme, host, no trailing slash, the same case): an id pasted from the
-- wrong row, or an origin typed from memory, is refused with P0007 and
-- nothing is deleted. The row is locked first, so no new row can be added
-- under the dealership (an insert must lock the key it references) between
-- the counts and the delete.
-- Keeps billing_events (the accounting record) and every auth.users row:
-- the answer lists the members who now belong to no dealership, for
-- forget_person when the request covers its people, and names the Stripe
-- customer, which is deleted separately in the Stripe Dashboard.
-- Answers { deleted, dealership, removed: { table: rows }, kept, stripe_customer_id,
-- stripe_subscription_id, accounts_without_a_dealership: [{ user_id, email }], next }.
-- ---------------------------------------------------------------------------
create or replace function public.delete_dealership(dealership_id uuid, confirm text)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  d public.dealerships%rowtype;
  sub public.subscriptions%rowtype;
  members uuid[];
  removed jsonb;
  kept_events bigint;
  orphans jsonb;
  steps jsonb := '[]'::jsonb;
begin
  select * into d from public.dealerships x where x.id = delete_dealership.dealership_id for update;
  if not found then
    raise exception 'no dealership has the id %', delete_dealership.dealership_id using errcode = 'P0002';
  end if;
  if delete_dealership.confirm is distinct from d.website_origin then
    raise exception 'nothing deleted: confirm must be this dealership''s website_origin exactly as stored'
      using errcode = 'P0007', hint = 'select website_origin from public.dealerships where id = ''<the id>''';
  end if;

  select * into sub from public.subscriptions s where s.dealership_id = d.id;
  select coalesce(array_agg(m.user_id), '{}') into members from public.memberships m where m.dealership_id = d.id;
  select count(*) into kept_events from public.billing_events_of(d.id);
  removed := jsonb_build_object(
    'dealerships', 1,
    'memberships', (select count(*) from public.memberships m where m.dealership_id = d.id),
    'listings', (select count(*) from public.listings l where l.dealership_id = d.id),
    'todo_items', (select count(*) from public.todo_items t where t.dealership_id = d.id),
    'scan_summaries', (select count(*) from public.scan_summaries s where s.dealership_id = d.id),
    'post_attempts', (select count(*) from public.post_attempts a where a.dealership_id = d.id),
    'rewrite_usage', (select count(*) from public.rewrite_usage r where r.dealership_id = d.id),
    'invites', (select count(*) from public.invites i where i.dealership_id = d.id),
    'subscriptions', (select count(*) from public.subscriptions s where s.dealership_id = d.id)
  );

  -- the cascades do the rest
  delete from public.dealerships x where x.id = d.id;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email) order by u.email, u.id), '[]'::jsonb)
  into orphans
  from auth.users u
  where u.id = any(members)
    and not exists (select 1 from public.memberships m where m.user_id = u.id);

  if sub.stripe_customer_id is not null then
    steps := steps || to_jsonb('Delete the Stripe customer ' || sub.stripe_customer_id || ' in the Stripe Dashboard; that also cancels any subscription still open on it.');
  end if;
  if jsonb_array_length(orphans) > 0 then
    steps := steps || to_jsonb('The accounts in accounts_without_a_dealership can still sign in and see nothing. When the request covers the dealership''s people, run public.forget_person(user_id, email) for each.'::text);
  end if;

  return jsonb_build_object(
    'deleted', true,
    'dealership', jsonb_build_object('id', d.id, 'name', d.name, 'website_origin', d.website_origin),
    'removed', removed,
    'kept', jsonb_build_object('billing_events', kept_events),
    'stripe_customer_id', sub.stripe_customer_id,
    'stripe_subscription_id', sub.stripe_subscription_id,
    'accounts_without_a_dealership', orphans,
    'next', steps
  );
end;
$$;
comment on function public.delete_dealership(uuid, text) is 'Owner only. Deletes a dealership and every row it owns (the cascades) once confirm is its exact website_origin; keeps billing_events and accounts, and says which.';

-- ---------------------------------------------------------------------------
-- forget_person(user_id, confirm): one person's own request to be deleted.
-- Only when confirm is the email of that account (case aside); anything else
-- is refused with P0007 and nothing changes. When the person is the last
-- manager of a dealership, refused with P0006 naming it: the dealership
-- makes another member a manager first, or, if it is leaving too, it is
-- deleted first (delete_dealership).
-- Removes: their memberships (their unused invite codes go with each, the
-- memberships_forget_invites trigger), any other unused invite code they
-- made, their invite misses, demo requests sent from their email, their
-- entries in Supabase's auth audit log when the project keeps it in the
-- database (auth.audit_log_entries: sign-ins with email and IP address),
-- and finally their auth.users row (Supabase deletes their sessions and
-- identities with it).
-- Clears, keeping the rows: their name from listings.salesperson and
-- post_attempts.salesperson on every row they made, and the listing link
-- from their listings already taken down. The rows themselves are the
-- dealership's records (the policy: customers ask for their dealership's
-- records to be exported or deleted), so they stay as numbers: VIN, price,
-- times, outcome, under a user_id that no longer maps to anyone. A link on a
-- listing still marked up stays: the car is still advertised on the
-- person's profile, the dealership needs the link to see it come down, and
-- only the person can take it down (Lot Sync never does).
-- Keeps: used invite codes (who joined when, under the same bare user id),
-- rewrite_usage, and billing_events, which may carry their email when they
-- opened Checkout: the accounting record. The answer counts those.
-- ---------------------------------------------------------------------------
create or replace function public.forget_person(user_id uuid, confirm text)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  uid uuid := forget_person.user_id;
  their_email text;
  last_of text;
  unused_invites bigint;
  n_memberships bigint;
  n_names_listings bigint;
  n_links bigint;
  n_names_attempts bigint;
  n_misses bigint;
  n_demo bigint;
  n_audit bigint := 0;
  notes jsonb := '[]'::jsonb;
begin
  select u.email into their_email from auth.users u where u.id = uid;
  if not found then
    raise exception 'no account has the id %', uid using errcode = 'P0002';
  end if;
  if their_email is null or forget_person.confirm is null or lower(forget_person.confirm) <> lower(their_email) then
    raise exception 'nothing changed: confirm must be this account''s email'
      using errcode = 'P0007', hint = 'select email from auth.users where id = ''<the id>''';
  end if;

  -- keep_a_manager would refuse the membership delete below; say which dealership first
  select string_agg(format('%s (%s, id %s)', d.name, d.website_origin, d.id), '; ' order by d.name)
  into last_of
  from public.memberships m
  join public.dealerships d on d.id = m.dealership_id
  where m.user_id = uid and m.role = 'manager'
    and not exists (
      select 1 from public.memberships o
      where o.dealership_id = m.dealership_id and o.role = 'manager' and o.user_id <> uid);
  if last_of is not null then
    raise exception 'nothing changed: this person is the last manager of %', last_of
      using errcode = 'P0006', hint = 'make another member of that dealership a manager first, or delete the dealership first if it is leaving too';
  end if;

  select count(*) into unused_invites from public.invites i where i.created_by = uid and i.used_at is null;

  delete from public.memberships m where m.user_id = uid;
  get diagnostics n_memberships = row_count;
  -- the trigger took their unused codes in each dealership they left; this takes any left elsewhere
  delete from public.invites i where i.created_by = uid and i.used_at is null;

  update public.listings l set salesperson = null where l.user_id = uid and l.salesperson is not null;
  get diagnostics n_names_listings = row_count;
  update public.listings l set listing_url = null where l.user_id = uid and l.status = 'taken_down' and l.listing_url is not null;
  get diagnostics n_links = row_count;
  update public.post_attempts a set salesperson = null where a.user_id = uid and a.salesperson is not null;
  get diagnostics n_names_attempts = row_count;

  delete from public.invite_misses x where x.user_id = uid;
  get diagnostics n_misses = row_count;
  delete from public.demo_requests r where lower(trim(r.email)) = lower(their_email);
  get diagnostics n_demo = row_count;

  -- Supabase's own table, present only when the project writes its auth audit log to the database
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      execute 'delete from auth.audit_log_entries a where a.payload ->> ''actor_id'' = $1' using uid::text;
      get diagnostics n_audit = row_count;
    exception when insufficient_privilege then
      n_audit := null;
      notes := notes || to_jsonb('auth.audit_log_entries could not be deleted by this role; Supabase keeps those sign-in entries on its own schedule.'::text);
    end;
  end if;

  delete from auth.users u where u.id = uid;

  return jsonb_build_object(
    'forgotten', true,
    'user_id', uid,
    'removed', jsonb_build_object(
      'memberships', n_memberships,
      'unused_invites', unused_invites,
      'invite_misses', n_misses,
      'demo_requests', n_demo,
      'auth_audit_log_entries', n_audit,
      'auth_users', 1),
    'cleared', jsonb_build_object(
      'listings_salesperson', n_names_listings,
      'listings_link_taken_down', n_links,
      'post_attempts_salesperson', n_names_attempts),
    'kept', jsonb_build_object(
      'listings', (select count(*) from public.listings l where l.user_id = uid),
      'listing_links_still_listed', (select count(*) from public.listings l where l.user_id = uid and l.listing_url is not null),
      'post_attempts', (select count(*) from public.post_attempts a where a.user_id = uid),
      'rewrite_usage', (select count(*) from public.rewrite_usage r where r.user_id = uid),
      'used_invites', (select count(*) from public.invites i where uid in (i.used_by, i.created_by)),
      'billing_events_with_their_email', (select count(*) from public.billing_events e where position(lower(their_email) in lower(e.payload::text)) > 0)),
    'notes', notes
  );
end;
$$;
comment on function public.forget_person(uuid, text) is 'Owner only. Deletes one person''s account, memberships, unused codes and misses, clears their name from the dealership''s rows, once confirm is their email.';

-- Owner only: nobody through the API, the service role included.
revoke execute on function public.billing_events_of(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.export_dealership(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.delete_dealership(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.forget_person(uuid, text) from public, anon, authenticated, service_role;
