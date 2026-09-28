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
-- supabase/tests/rls.sql proves it against a running database.

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

-- ---------------------------------------------------------------------------
-- Table privileges. Supabase grants the API roles broad privileges on new
-- tables by default; this narrows them to what the policies below can ever
-- allow, and gives the anon key nothing at all (Lot Sync has no signed-out
-- reads). Stated explicitly so the same file also works on a plain Postgres
-- (supabase/tests/local-shim.sql).
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select, update on public.dealerships to authenticated;
grant select, update, delete on public.memberships to authenticated;
grant select, insert, update, delete on public.listings to authenticated;
grant select, insert, update, delete on public.todo_items to authenticated;
grant select, insert, update, delete on public.scan_summaries to authenticated;
grant select, insert, update, delete on public.post_attempts to authenticated;
grant select on public.rewrite_usage to authenticated;
-- invites: no privileges for any API role; redeem_invite() reads them as its owner.
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role; -- rewrite_usage.id

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
-- table is read only inside redeem_invite() (below), which runs as its owner.
-- Managers get new codes from create_invite(), also below.
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
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- both sides folded (changed in place: no project has applied this file yet)
  select * into inv
  from public.invites i
  where upper(trim(i.code)) = upper(trim(redeem_invite.code))
  for update;
  if not found then
    raise exception 'that invite code was not found' using errcode = 'P0002';
  end if;
  if inv.used_at is not null then
    raise exception 'that invite code was already used' using errcode = 'P0003';
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
comment on function public.redeem_invite(text, text) is 'Makes the signed-in caller a member of the invite''s dealership and marks the code used. The only way in through the API.';

-- ---------------------------------------------------------------------------
-- create_invite(dealership_id, role): a manager of that dealership gets a
-- fresh single-use code for a salesperson or another manager. The code is
-- 12 hex characters taken from the hash of a random uuid (48 bits): short
-- enough to read out over the phone, single use, and never listed anywhere.
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
comment on function public.create_invite(uuid, text) is 'A manager creates a single-use invite code for their dealership.';

-- Only signed-in users may call the two functions (PostgREST exposes them as
-- /rest/v1/rpc/redeem_invite and /rest/v1/rpc/create_invite).
revoke execute on function public.redeem_invite(text, text) from public, anon;
revoke execute on function public.create_invite(uuid, text) from public, anon;
grant execute on function public.redeem_invite(text, text) to authenticated, service_role;
grant execute on function public.create_invite(uuid, text) to authenticated, service_role;
