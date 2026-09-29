-- Lot Sync, Milestone 4: row-level security.
--
-- The rule in one line: a signed-in person sees their own dealership and
-- nothing else. Salespeople write their own rows, managers can change any row
-- of their dealership, and only managers delete. Every table has RLS on, so
-- a query with the public anon key and a user's token gets exactly what the
-- policies below allow and nothing more. The service role (used only inside
-- the Edge Functions, never in a browser) bypasses RLS as Supabase always
-- lets it.
--
-- PLAN.md M4 acceptance 3: a user from dealership A cannot read dealership B.
-- supabase/tests/rls.sql proves it against a running database, along with
-- the invite rules at the end of this file (one answer for every bad code,
-- the throttle, codes that die with their maker, list and revoke for
-- managers only).

-- ---------------------------------------------------------------------------
-- Helpers. Both are SECURITY DEFINER so a policy can consult memberships even
-- though memberships is itself under RLS (a salesperson only sees their own
-- row), STABLE so the planner evaluates them once per query, and their
-- search_path is pinned so a caller cannot swap in a look-alike table.
-- The parameter is referenced as is_member.dealership_id because inside a
-- SQL function a bare name that matches a column means the column.
-- ---------------------------------------------------------------------------
create or replace function public.is_member(dealership_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.dealership_id = is_member.dealership_id
      and m.user_id = auth.uid()
  );
$$;
comment on function public.is_member(uuid) is 'True when the signed-in user belongs to this dealership (any role).';

create or replace function public.is_manager(dealership_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.dealership_id = is_manager.dealership_id
      and m.user_id = auth.uid()
      and m.role = 'manager'
  );
$$;
comment on function public.is_manager(uuid) is 'True when the signed-in user is a manager of this dealership.';

-- Only signed-in users (and the functions) may call the helpers; Postgres
-- otherwise grants EXECUTE to everyone.
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.is_manager(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated, service_role;
grant execute on function public.is_manager(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Turn RLS on everywhere. A table with RLS on and no policy for a role lets
-- that role see and change nothing.
-- ---------------------------------------------------------------------------
alter table public.dealerships enable row level security;
alter table public.memberships enable row level security;
alter table public.listings enable row level security;
alter table public.todo_items enable row level security;
alter table public.scan_summaries enable row level security;
alter table public.post_attempts enable row level security;
alter table public.rewrite_usage enable row level security;
alter table public.invites enable row level security;
alter table public.invite_misses enable row level security;

-- ---------------------------------------------------------------------------
-- Table privileges. Supabase grants the API roles broad privileges on new
-- tables and sequences by default; this narrows them to what the policies
-- below can ever allow, and gives the anon key nothing at all (Lot Sync has
-- no signed-out reads). Stated explicitly so the same file also works on a
-- plain Postgres (supabase/tests/local-shim.sql).
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
-- sequences too (rewrite_usage.id): "all tables" does not cover them, and no
-- API role but the service role inserts a row that draws from one
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.dealerships to authenticated;
-- the rename only: website_origin is unique and the key /sync matches on, so
-- an update right on it would let a manager probe which other dealer
-- websites are customers (the unique index says so) and break their own
-- salespeople's sync meanwhile; the owner changes an origin in SQL, as they
-- create the row. A PATCH that names any other column fails with 42501
-- before the policy or a constraint is consulted.
grant update (name) on public.dealerships to authenticated;
grant select, delete on public.memberships to authenticated;
-- a member's name and role only: user_id and dealership_id are who and where,
-- and a manager of two stores must not move people between them
grant update (name, role) on public.memberships to authenticated;
grant select, insert, update, delete on public.listings to authenticated;
grant select, insert, update, delete on public.todo_items to authenticated;
grant select, insert, update, delete on public.scan_summaries to authenticated;
grant select, insert, update, delete on public.post_attempts to authenticated;
grant select on public.rewrite_usage to authenticated;
-- invites: no privileges for any API role; redeem_invite() and list_invites() read them as their owner.
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role; -- rewrite_usage.id
-- invite_misses: nothing for anyone, the service role included; only
-- redeem_invite() (SECURITY DEFINER, below) writes and reads it.
revoke all on public.invite_misses from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- dealerships: members read their own dealership; managers may rename it.
-- Nobody creates or deletes a dealership through the API (the owner does, in
-- SQL, when a rooftop signs up or leaves).
-- ---------------------------------------------------------------------------
create policy "members read their dealership"
  on public.dealerships for select to authenticated
  using (public.is_member(id));

create policy "managers update their dealership"
  on public.dealerships for update to authenticated
  using (public.is_manager(id))
  with check (public.is_manager(id));

-- ---------------------------------------------------------------------------
-- memberships: a person reads their own rows (which dealerships am I in, as
-- what); a manager reads everyone in their dealership (the manager view's
-- list of salespeople). Rows are created only by redeem_invite() below or by
-- the owner in SQL, never by a plain insert. Managers may change a member's
-- name or role and remove a member; nothing else is allowed.
-- ---------------------------------------------------------------------------
create policy "a user reads their own memberships"
  on public.memberships for select to authenticated
  using (user_id = auth.uid());

create policy "managers read their dealership's memberships"
  on public.memberships for select to authenticated
  using (public.is_manager(dealership_id));

create policy "managers update their dealership's memberships"
  on public.memberships for update to authenticated
  using (public.is_manager(dealership_id))
  with check (public.is_manager(dealership_id));

create policy "managers remove members of their dealership"
  on public.memberships for delete to authenticated
  using (public.is_manager(dealership_id));

-- A dealership keeps at least one manager: removing or demoting the last one
-- would leave nobody who can invite, bill or fix a mistake, and only the
-- owner in SQL could recover it. Deleting the dealership itself (which
-- cascades to its memberships) is not stopped: by then its row is gone.
-- Two managers acting at the same moment (both step down, or each removes
-- the other) must not both get through. Under READ COMMITTED each
-- transaction would still see the other as a manager, because neither has
-- committed. So every change that removes or demotes a manager first locks
-- the dealership row, as a statement of its own. The second change waits
-- there until the first commits. Its check then runs as a new statement,
-- sees the first change and refuses. FOR NO KEY UPDATE does not block the
-- key-share locks that inserts referencing the dealership take. In the
-- cascade from a deleted dealership the row is already gone: nothing is
-- locked and nothing is checked. (Changed in place: no project has applied
-- this file yet. supabase/tests/concurrency.sql proves it with two sessions.)
create or replace function public.keep_a_manager()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.role = 'manager' and (tg_op = 'DELETE' or new.role is distinct from 'manager') then
    perform 1 from public.dealerships d where d.id = old.dealership_id for no key update;
    if found and not exists (
         select 1 from public.memberships m
         where m.dealership_id = old.dealership_id and m.role = 'manager' and m.user_id <> old.user_id) then
      raise exception 'a dealership keeps at least one manager: make someone else a manager first' using errcode = 'P0006';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
comment on function public.keep_a_manager() is 'Before a membership is deleted or changed: refuses to leave a dealership with no manager. Locks the dealership row first, so two such changes at once cannot both pass.';
revoke execute on function public.keep_a_manager() from public, anon, authenticated;
create trigger memberships_keep_a_manager
  before update or delete on public.memberships
  for each row execute function public.keep_a_manager();

-- ---------------------------------------------------------------------------
-- listings (the posted registry): every member sees the dealership's whole
-- registry (that is the point of syncing: two salespeople see the same
-- list, and a manager sees both). A salesperson inserts and updates only
-- rows that carry their own user_id, inside their own dealership. A manager
-- updates any row of the dealership (fixing a link, marking a take-down
-- after the salesperson left). Only managers delete.
-- ---------------------------------------------------------------------------
create policy "members read their dealership's listings"
  on public.listings for select to authenticated
  using (public.is_member(dealership_id));

create policy "salespeople insert their own listings"
  on public.listings for insert to authenticated
  with check (public.is_member(dealership_id) and user_id = auth.uid());

create policy "salespeople update their own listings"
  on public.listings for update to authenticated
  using (public.is_member(dealership_id) and user_id = auth.uid())
  with check (public.is_member(dealership_id) and user_id = auth.uid());

create policy "managers update any listing of their dealership"
  on public.listings for update to authenticated
  using (public.is_manager(dealership_id))
  with check (public.is_manager(dealership_id));

create policy "managers delete listings of their dealership"
  on public.listings for delete to authenticated
  using (public.is_manager(dealership_id));

-- ---------------------------------------------------------------------------
-- post_attempts (time per post): the same shape as listings. A salesperson
-- records only their own attempts; a manager sees and can correct all of the
-- dealership's; only managers delete.
-- ---------------------------------------------------------------------------
create policy "members read their dealership's post attempts"
  on public.post_attempts for select to authenticated
  using (public.is_member(dealership_id));

create policy "salespeople insert their own post attempts"
  on public.post_attempts for insert to authenticated
  with check (public.is_member(dealership_id) and user_id = auth.uid());

create policy "salespeople update their own post attempts"
  on public.post_attempts for update to authenticated
  using (public.is_member(dealership_id) and user_id = auth.uid())
  with check (public.is_member(dealership_id) and user_id = auth.uid());

create policy "managers update any post attempt of their dealership"
  on public.post_attempts for update to authenticated
  using (public.is_manager(dealership_id))
  with check (public.is_manager(dealership_id));

create policy "managers delete post attempts of their dealership"
  on public.post_attempts for delete to authenticated
  using (public.is_manager(dealership_id));

-- ---------------------------------------------------------------------------
-- todo_items (sold cars to take down, prices to update): an item belongs to
-- the dealership, not to a person (the listing with the same VIN says who
-- posted), so any member may add one or close one: the rescan that flags it
-- may run on a colleague's machine, and a manager may tick it off. Only
-- managers delete.
-- ---------------------------------------------------------------------------
create policy "members read their dealership's to-do items"
  on public.todo_items for select to authenticated
  using (public.is_member(dealership_id));

create policy "members insert to-do items for their dealership"
  on public.todo_items for insert to authenticated
  with check (public.is_member(dealership_id));

create policy "members update to-do items of their dealership"
  on public.todo_items for update to authenticated
  using (public.is_member(dealership_id))
  with check (public.is_member(dealership_id));

create policy "managers delete to-do items of their dealership"
  on public.todo_items for delete to authenticated
  using (public.is_manager(dealership_id));

-- ---------------------------------------------------------------------------
-- scan_summaries: any member's extension may record a scan; everyone in the
-- dealership reads them; a manager may correct or delete one.
-- ---------------------------------------------------------------------------
create policy "members read their dealership's scans"
  on public.scan_summaries for select to authenticated
  using (public.is_member(dealership_id));

create policy "members insert scans for their dealership"
  on public.scan_summaries for insert to authenticated
  with check (public.is_member(dealership_id));

create policy "managers update scans of their dealership"
  on public.scan_summaries for update to authenticated
  using (public.is_manager(dealership_id))
  with check (public.is_manager(dealership_id));

create policy "managers delete scans of their dealership"
  on public.scan_summaries for delete to authenticated
  using (public.is_manager(dealership_id));

-- ---------------------------------------------------------------------------
-- rewrite_usage: members may see what their dealership's rewrite calls cost
-- this month (a manager watching the cap). Only the rewrite function writes
-- here, with the service role, so there is no insert, update or delete
-- policy for signed-in users.
-- ---------------------------------------------------------------------------
create policy "members read their dealership's rewrite usage"
  on public.rewrite_usage for select to authenticated
  using (public.is_member(dealership_id));

-- ---------------------------------------------------------------------------
-- invites: no policy at all. A code is a secret handed to one person; the
-- table is read only inside redeem_invite() and list_invites() (below),
-- which run as their owner. Managers get new codes from create_invite() and
-- cancel one with revoke_invite(), also below.
-- invite_misses: no policy and no privilege either; redeem_invite() alone
-- writes and reads it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- redeem_invite(code, display_name): the signed-in caller becomes a member of
-- the invite's dealership with the invite's role, and the code is marked
-- used. SECURITY DEFINER because the caller may read neither invites nor
-- insert into memberships. Rejoining an existing membership updates its role
-- and name rather than failing. Returns what the extension needs to store:
-- the dealership's id, name and website origin, and the role.
-- The code is compared ignoring case and surrounding spaces on both sides:
-- create_invite() stores upper-case codes and the extension sends upper
-- case, but the first manager's code is typed by the owner in SQL
-- (supabase/README.md) in whatever case they chose.
-- A code that is unknown, already used, expired, or whose maker
-- (created_by, when set) no longer holds a manager membership of the
-- dealership gets one answer for all four, 'that invite code is not valid'
-- with code P0002, so a guess learns nothing, not even that a code once
-- existed. Every miss is counted in invite_misses, and after 10 misses
-- inside an hour the function raises 'too many attempts; try again in an
-- hour' (P0005) before it looks anything up.
-- The miss is answered, not raised: PostgREST runs the call in one
-- transaction and rolls it back on an error, which would take the row that
-- counts the miss with it. So the function sets response.status to 400 and
-- returns the { code, message, details, hint } object PostgREST builds for
-- a raised error; on the wire, to the extension and to the manager page, a
-- miss looks exactly like a raise, and the count survives. The throttle is
-- a plain raise because nothing has been written by then.
-- Parameters are referenced as redeem_invite.code to avoid the PL/pgSQL
-- name clash with the column of the same name.
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

  -- the throttle, before anything is looked up; misses older than an hour
  -- no longer count and are dropped
  delete from public.invite_misses where invite_misses.user_id = uid and invite_misses.at < now() - interval '1 hour';
  select count(*) into misses from public.invite_misses where invite_misses.user_id = uid;
  if misses >= 10 then
    raise exception 'too many attempts; try again in an hour' using errcode = 'P0005';
  end if;

  -- both sides folded (changed in place: no project has applied this file yet)
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
comment on function public.redeem_invite(text, text) is 'Makes the signed-in caller a member of the invite''s dealership and marks the code used. The only way in through the API. One answer (P0002) for an unknown, used, expired or cancelled code; P0005 after 10 misses in an hour.';

-- ---------------------------------------------------------------------------
-- create_invite(dealership_id, role): a manager of that dealership gets a
-- fresh single-use code for a salesperson or another manager. The code is
-- 12 hex characters taken from the hash of a random uuid (48 bits): short
-- enough to read out over the phone, single use, good for 7 days
-- (invites.expires_at), and listed only to the dealership's managers
-- (list_invites, below).
-- ---------------------------------------------------------------------------
create or replace function public.create_invite(dealership_id uuid, role text default 'salesperson')
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  wanted text := coalesce(create_invite.role, 'salesperson');
  new_code text;
begin
  if uid is null or not public.is_manager(create_invite.dealership_id) then
    raise exception 'only a manager of this dealership can create invites' using errcode = '42501';
  end if;
  if wanted not in ('salesperson', 'manager') then
    raise exception 'role must be salesperson or manager' using errcode = '22023';
  end if;
  new_code := upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12));
  insert into public.invites (code, dealership_id, role, created_by)
  values (new_code, create_invite.dealership_id, wanted, uid);
  return jsonb_build_object('code', new_code, 'dealership_id', create_invite.dealership_id, 'role', wanted);
end;
$$;
comment on function public.create_invite(uuid, text) is 'A manager creates a single-use invite code for their dealership, good for 7 days.';

-- ---------------------------------------------------------------------------
-- list_invites(dealership_id): the dealership's open codes (unused, not yet
-- expired, made by someone who is still a manager there), newest first, for the manager view's Invite codes card. Only a
-- manager of that dealership; anyone else gets 42501 and learns nothing.
-- SECURITY DEFINER because nobody may read invites directly; the manager
-- check is the first line and the query names the dealership, so the answer
-- never crosses the wall. The parameter is referenced as
-- list_invites.dealership_id, as in the other functions.
-- ---------------------------------------------------------------------------
create or replace function public.list_invites(dealership_id uuid)
returns table (code text, role text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_manager(list_invites.dealership_id) then
    raise exception 'only a manager of this dealership can list its invites' using errcode = '42501';
  end if;
  return query
    select i.code, i.role, i.created_at, i.expires_at
    from public.invites i
    where i.dealership_id = list_invites.dealership_id
      and i.used_at is null
      and i.expires_at > now()
      -- a code whose maker is no longer a manager here cannot be redeemed (redeem_invite's maker check), so it is not open
      and (i.created_by is null or exists (
            select 1 from public.memberships m
            where m.user_id = i.created_by and m.dealership_id = i.dealership_id and m.role = 'manager'))
    order by i.created_at desc;
end;
$$;
comment on function public.list_invites(uuid) is 'A manager lists their dealership''s open invite codes (unused, unexpired), newest first. 42501 for anyone else.';

-- ---------------------------------------------------------------------------
-- revoke_invite(code): a manager cancels an unused code of their dealership
-- (the person it was meant for left before using it, or it went to the
-- wrong inbox). True when a row went; false when nothing matched, and never
-- why: an unknown code, a used one and another dealership's all read the
-- same, so the function is no oracle. Matched the way redeem_invite()
-- matches. SECURITY DEFINER because nobody may delete from invites
-- directly; is_manager() on the row's own dealership is the gate.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_invite(code text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.invites i
  where upper(trim(i.code)) = upper(trim(revoke_invite.code))
    and i.used_at is null
    and public.is_manager(i.dealership_id);
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
comment on function public.revoke_invite(text) is 'A manager deletes an unused invite code of their dealership. True when one went, false otherwise, never why.';

-- ---------------------------------------------------------------------------
-- Removing a member deletes the unused invite codes that person made for
-- that dealership, so a code a departing manager kept for themselves, or
-- handed out and never saw used, cannot bring anyone back in. Used codes
-- stay: they are the record of who joined how. SECURITY DEFINER because the
-- manager doing the removing has no privilege on invites; the function only
-- ever touches rows of the deleted membership's own dealership. (A demoted
-- manager keeps their row, so the trigger does not fire for them; their
-- codes are refused by redeem_invite()'s maker check instead.)
-- ---------------------------------------------------------------------------
create or replace function public.forget_invites_of_removed_member()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.invites i
  where i.created_by = old.user_id
    and i.dealership_id = old.dealership_id
    and i.used_at is null;
  return old;
end;
$$;
comment on function public.forget_invites_of_removed_member() is 'After a membership is deleted: drops the unused invite codes that person made for that dealership.';

create trigger memberships_forget_invites
  after delete on public.memberships
  for each row execute function public.forget_invites_of_removed_member();

-- Only signed-in users may call the four functions (PostgREST exposes them
-- as /rest/v1/rpc/redeem_invite, create_invite, list_invites and
-- revoke_invite); the trigger function is the database's alone.
revoke execute on function public.redeem_invite(text, text) from public, anon;
revoke execute on function public.create_invite(uuid, text) from public, anon;
revoke execute on function public.list_invites(uuid) from public, anon;
revoke execute on function public.revoke_invite(text) from public, anon;
revoke execute on function public.forget_invites_of_removed_member() from public, anon, authenticated;
grant execute on function public.redeem_invite(text, text) to authenticated, service_role;
grant execute on function public.create_invite(uuid, text) to authenticated, service_role;
grant execute on function public.list_invites(uuid) to authenticated, service_role;
grant execute on function public.revoke_invite(text) to authenticated, service_role;
