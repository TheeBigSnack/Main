-- Lot Sync: row-level security checks (PLAN.md, M4 acceptance 3).
--
-- Plain SQL, no pgTAP. Runs with psql as the database owner against a local
-- database that has the migrations applied (supabase/README.md, "Run the
-- RLS test"): it creates two dealerships and their people straight in
-- auth.users, then for each person sets the JWT claims the way PostgREST
-- does (set local role authenticated; request.jwt.claims) and asserts in
-- DO blocks that raise on anything wrong. Everything happens in one
-- transaction that is rolled back at the end, so the database is left as it
-- was. psql exits non-zero on the first failed assertion.
--
--   user       dealership  role
--   a_sales    A           salesperson
--   a_mgr      A and B     manager of both (sister stores): only the column
--                          grant keeps them from moving a member between them
--   b_sales    B           salesperson
--   c_sales    C           salesperson; a_mgr has nothing in C, so C is the
--                          wall a manager's checks run against
--   newcomer   (none yet)  redeems two invites for B during the test: one
--                          from create_invite's mould and one the owner
--                          typed in lower case

\set ON_ERROR_STOP on
\set a_sales   '00000000-0000-4000-8000-0000000000a1'
\set a_mgr     '00000000-0000-4000-8000-0000000000a2'
\set b_sales   '00000000-0000-4000-8000-0000000000b1'
\set c_sales   '00000000-0000-4000-8000-0000000000c3'
\set newcomer  '00000000-0000-4000-8000-0000000000c1'
\set dealer_a  '00000000-0000-4000-8000-0000000000d1'
\set dealer_b  '00000000-0000-4000-8000-0000000000d2'
\set dealer_c  '00000000-0000-4000-8000-0000000000d3'

begin;

-- ---------------------------------------------------------------------------
-- Privileges (as the owner): what the two API roles hold on every table and
-- view in public, whichever migration made it. Supabase opens every new
-- table, view and sequence to them by default (so does local-shim.sql), so
-- a migration that forgets its revoke fails here, not only in the checks
-- below that name a table.
-- ---------------------------------------------------------------------------
create function pg_temp.api_privileges(who text, rel oid) returns text
language sql stable as $$
  select string_agg(p, ', ' order by p) from (
    select k as p
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) k
    where has_table_privilege(who, rel, k)
    union all
    select k || ' (' || string_agg(a.attname, ', ' order by a.attname) || ')'
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) k
    join pg_attribute a on a.attrelid = rel and a.attnum > 0 and not a.attisdropped
    where not has_table_privilege(who, rel, k) and has_column_privilege(who, rel, a.attnum, k)
    group by k
  ) s;
$$;

do $$
declare
  r record;
  held text;
  wanted text;
begin
  for r in
    select c.oid, c.relname, c.relkind from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by c.relname
  loop
    held := pg_temp.api_privileges('anon', r.oid);
    if held is not null then raise exception 'anon holds % on public.%', held, r.relname; end if;

    held := pg_temp.api_privileges('authenticated', r.oid);
    if r.relkind in ('v', 'm') then
      -- the manager page's views (0003_views.sql), read under the tables' RLS, and only read
      if held is distinct from 'SELECT' then raise exception 'authenticated holds % on public.%, not SELECT', coalesce(held, 'nothing'), r.relname; end if;
      continue;
    end if;
    wanted := case r.relname
      when 'dealerships'    then 'SELECT, UPDATE (name)'
      when 'memberships'    then 'DELETE, SELECT, UPDATE (name, role)'
      when 'listings'       then 'DELETE, INSERT, SELECT, UPDATE'
      when 'todo_items'     then 'DELETE, INSERT, SELECT, UPDATE'
      when 'scan_summaries' then 'DELETE, INSERT, SELECT, UPDATE'
      when 'post_attempts'  then 'DELETE, INSERT, SELECT, UPDATE'
      when 'rewrite_usage'  then 'SELECT'
      when 'subscriptions'  then 'SELECT'
    end; -- every other table, and any new one until it is added here: nothing
    if held is distinct from wanted then
      raise exception 'authenticated holds % on public.%, not %', coalesce(held, 'nothing'), r.relname, coalesce(wanted, 'nothing');
    end if;
  end loop;

  -- every sequence in public (rewrite_usage's, billing_events', demo_requests'):
  -- the service role draws from them, the API roles hold nothing
  for r in select c.oid, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' loop
    if has_sequence_privilege('anon', r.oid, 'USAGE, SELECT, UPDATE') or has_sequence_privilege('authenticated', r.oid, 'USAGE, SELECT, UPDATE') then
      raise exception 'an API role other than the service role holds a privilege on public.%', r.relname;
    end if;
  end loop;
  if not has_sequence_privilege('service_role', 'public.rewrite_usage_id_seq', 'USAGE') then
    raise exception 'the service role cannot draw rewrite_usage ids';
  end if;
  raise notice 'ok: anon holds nothing, and authenticated only what the policies use, on every table, view and sequence';
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture (as the owner role, which is not under RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', :'a_sales',  'authenticated', 'authenticated', 'a-sales@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'a_mgr',    'authenticated', 'authenticated', 'a-mgr@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'b_sales',  'authenticated', 'authenticated', 'b-sales@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'c_sales',  'authenticated', 'authenticated', 'c-sales@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', :'newcomer', 'authenticated', 'authenticated', 'newcomer@example.test', now(), now());

insert into public.dealerships (id, name, website_origin) values
  (:'dealer_a', 'Dealership A', 'https://www.dealership-a.test'),
  (:'dealer_b', 'Dealership B', 'https://www.dealership-b.test'),
  (:'dealer_c', 'Dealership C', 'https://www.dealership-c.test');

insert into public.memberships (user_id, dealership_id, role, name) values
  (:'a_sales', :'dealer_a', 'salesperson', 'Alex'),
  (:'a_mgr',   :'dealer_a', 'manager',     'Jamie'),
  (:'a_mgr',   :'dealer_b', 'manager',     'Jamie'),
  (:'b_sales', :'dealer_b', 'salesperson', 'Sam'),
  (:'c_sales', :'dealer_c', 'salesperson', 'Kim');

insert into public.listings (id, dealership_id, user_id, vin, name, price, posted_at, salesperson) values
  ('00000000-0000-4000-8000-0000000000e1', :'dealer_a', :'a_sales', 'TESTVINA00000001', 'Car A1', 20000, now() - interval '2 days', 'Alex'),
  ('00000000-0000-4000-8000-0000000000e2', :'dealer_a', :'a_mgr',   'TESTVINA00000002', 'Car A2', 21000, now() - interval '1 day',  'Jamie'),
  ('00000000-0000-4000-8000-0000000000e3', :'dealer_b', :'b_sales', 'TESTVINB00000001', 'Car B1', 30000, now() - interval '1 day',  'Sam'),
  ('00000000-0000-4000-8000-0000000000e4', :'dealer_c', :'c_sales', 'TESTVINC00000001', 'Car C1', 25000, now() - interval '1 day',  'Kim');

insert into public.post_attempts (dealership_id, user_id, vin, name, salesperson, started_at, ended_at, outcome, seconds) values
  (:'dealer_a', :'a_sales', 'TESTVINA00000001', 'Car A1', 'Alex', now() - interval '2 days', now() - interval '2 days' + interval '40 seconds', 'posted', 40),
  (:'dealer_a', :'a_sales', 'TESTVINA00000003', 'Car A3', 'Alex', now() - interval '1 day',  now() - interval '1 day' + interval '60 seconds',  'posted', 60),
  (:'dealer_b', :'b_sales', 'TESTVINB00000001', 'Car B1', 'Sam',  now() - interval '1 day',  now() - interval '1 day' + interval '50 seconds',  'posted', 50),
  (:'dealer_c', :'c_sales', 'TESTVINC00000001', 'Car C1', 'Kim',  now() - interval '1 day',  now() - interval '1 day' + interval '45 seconds',  'posted', 45);

insert into public.todo_items (dealership_id, vin, kind, name, flagged_at) values
  (:'dealer_a', 'TESTVINA00000001', 'takeDown', 'Car A1', now() - interval '5 hours'),
  (:'dealer_b', 'TESTVINB00000001', 'price',    'Car B1', now() - interval '3 hours'),
  (:'dealer_c', 'TESTVINC00000001', 'price',    'Car C1', now() - interval '2 hours');

insert into public.rewrite_usage (dealership_id, user_id, model, input_tokens, output_tokens, cost_usd, kind) values
  (:'dealer_a', :'a_sales', 'claude-haiku-4-5', 1500, 200, 0.0025, 'rewrite'),
  (:'dealer_b', :'b_sales', 'claude-haiku-4-5', 1500, 200, 0.0025, 'rewrite');

insert into public.invites (code, dealership_id, role, created_by) values
  ('NEWCOMERB001', :'dealer_b', 'salesperson', null),
  ('made-up-b002', :'dealer_b', 'manager',     null); -- as an owner typed codes before the README minted them: any case
insert into public.invites (code, dealership_id, role, created_by, expires_at) values
  ('EXPIREDB0003', :'dealer_b', 'salesperson', null,       now() - interval '1 minute'), -- past its 7 days
  ('ORPHANA00004', :'dealer_a', 'salesperson', :'a_sales', now() + interval '7 days'),   -- its maker is no manager of A
  ('OPENC0000005', :'dealer_c', 'salesperson', null,       now() + interval '7 days');   -- C's, out of a_mgr's reach

-- ---------------------------------------------------------------------------
-- a_sales: a salesperson of A
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  me uuid := auth.uid();
begin
  if me <> '00000000-0000-4000-8000-0000000000a1' then
    raise exception 'auth.uid() is % (the claims were not picked up)', me;
  end if;

  -- sees A's listings and only A's
  select count(*) into n from public.listings;
  if n <> 2 then raise exception 'a_sales should see the 2 listings of A, saw %', n; end if;
  if exists (select 1 from public.listings where dealership_id = b) then
    raise exception 'a_sales can see a listing of dealership B';
  end if;
  raise notice 'ok: a_sales sees only A''s listings';

  -- and only A's to-do items, post attempts, scans and rewrite usage
  select count(*) into n from public.todo_items where dealership_id = b;
  if n <> 0 then raise exception 'a_sales can see B''s to-do items'; end if;
  select count(*) into n from public.post_attempts where dealership_id = b;
  if n <> 0 then raise exception 'a_sales can see B''s post attempts'; end if;
  select count(*) into n from public.rewrite_usage;
  if n <> 1 then raise exception 'a_sales should see 1 rewrite_usage row (A''s), saw %', n; end if;
  select count(*) into n from public.dealerships;
  if n <> 1 then raise exception 'a_sales should see 1 dealership, saw %', n; end if;
  raise notice 'ok: a_sales sees nothing of B in any table';

  -- their own membership row and nobody else's
  select count(*) into n from public.memberships;
  if n <> 1 then raise exception 'a_sales should see only their own membership, saw % rows', n; end if;
  raise notice 'ok: a_sales sees only their own membership';

  -- cannot insert into B
  begin
    insert into public.listings (dealership_id, user_id, vin, name, price, posted_at)
    values (b, me, 'TESTVINX00000001', 'Sneaky', 1, now());
    raise exception 'a_sales inserted a listing into dealership B';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot insert a listing into B';
  end;

  -- cannot insert a listing in A under someone else's user_id
  begin
    insert into public.listings (dealership_id, user_id, vin, name, price, posted_at)
    values (a, '00000000-0000-4000-8000-0000000000a2', 'TESTVINX00000002', 'Not mine', 1, now());
    raise exception 'a_sales inserted a listing as another user';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot post as another user';
  end;

  -- can insert their own listing in A
  insert into public.listings (dealership_id, user_id, vin, name, price, posted_at, salesperson)
  values (a, me, 'TESTVINA00000004', 'Car A4', 22000, now(), 'Alex');
  raise notice 'ok: a_sales inserted their own listing';

  -- can update their own listing, cannot touch the manager's (RLS filters it out: 0 rows)
  update public.listings set price = 19500, updated_at = now() where id = '00000000-0000-4000-8000-0000000000e1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_sales could not update their own listing'; end if;
  update public.listings set price = 1 where id = '00000000-0000-4000-8000-0000000000e2';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a_sales updated the manager''s listing'; end if;
  raise notice 'ok: a_sales updates only their own listings';

  -- cannot delete anything (only managers delete)
  delete from public.listings where id = '00000000-0000-4000-8000-0000000000e1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a_sales deleted a listing'; end if;
  raise notice 'ok: a_sales cannot delete';

  -- to-do items: any member of A may add and close one, none in B
  insert into public.todo_items (dealership_id, vin, kind, name, flagged_at)
  values (a, 'TESTVINA00000002', 'price', 'Car A2', now());
  update public.todo_items set done_at = now(), how = 'manual' where dealership_id = a and vin = 'TESTVINA00000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_sales could not close a to-do item of A'; end if;
  begin
    insert into public.todo_items (dealership_id, vin, kind, name, flagged_at)
    values (b, 'TESTVINB00000001', 'takeDown', 'Car B1', now());
    raise exception 'a_sales inserted a to-do item into B';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales writes to-do items for A only';
  end;

  -- own post attempts and scans go in; B's do not
  insert into public.post_attempts (dealership_id, user_id, vin, started_at) values (a, me, 'TESTVINA00000004', now());
  insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count)
  values (a, 'https://www.dealership-a.test', now(), 40, 30, 1, 0);
  begin
    insert into public.scan_summaries (dealership_id, website_origin, taken_at, cars, ready, take_down_count, price_update_count)
    values (b, 'https://www.dealership-b.test', now(), 40, 30, 1, 0);
    raise exception 'a_sales recorded a scan for B';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales records attempts and scans for A only';
  end;

  -- invites are never readable (no privilege, or no rows: both are fine)
  begin
    select count(*) into n from public.invites;
    if n <> 0 then raise exception 'a_sales can read invite codes'; end if;
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: a_sales cannot read invites';

  -- cannot create invites
  begin
    perform public.create_invite(a, 'salesperson');
    raise exception 'a_sales created an invite';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot create invites';
  end;

  -- rewrite_usage is written only by the service role
  begin
    insert into public.rewrite_usage (dealership_id, user_id, model, input_tokens, output_tokens, cost_usd, kind)
    values (a, me, 'x', 1, 1, 0, 'rewrite');
    raise exception 'a_sales wrote to rewrite_usage';
  exception when insufficient_privilege then
    raise notice 'ok: a_sales cannot write rewrite_usage';
  end;

  -- demo requests are the lead function's alone
  begin
    perform 1 from public.demo_requests;
    raise exception 'a signed-in dealer can read demo requests';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.demo_requests (name, dealership, website, email) values ('x', 'x', 'x.test', 'x@x.test');
    raise exception 'a signed-in dealer can write a demo request past the lead function';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: a_sales cannot read or write demo requests';
end;
$$;

-- ---------------------------------------------------------------------------
-- a_mgr: a manager of A and of B, nothing in C
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_mgr' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  c uuid := '00000000-0000-4000-8000-0000000000d3';
  a_sales uuid := '00000000-0000-4000-8000-0000000000a1';
  inv jsonb;
begin
  -- sees A's post attempts (both salespeople's, plus the one a_sales just added) and B's, none of C's
  select count(*) into n from public.post_attempts where dealership_id = a;
  if n <> 3 then raise exception 'a_mgr should see 3 post attempts of A, saw %', n; end if;
  select count(*) into n from public.post_attempts;
  if n <> 4 then raise exception 'a_mgr should see the 3 post attempts of A and the 1 of B, saw %', n; end if;
  if exists (select 1 from public.post_attempts where dealership_id = c) then
    raise exception 'a_mgr can see a post attempt of C';
  end if;
  raise notice 'ok: a_mgr sees the post attempts of A and B and none of C''s';

  -- sees everyone in A and in B
  select count(*) into n from public.memberships where dealership_id = a;
  if n <> 2 then raise exception 'a_mgr should see 2 memberships of A, saw %', n; end if;
  select count(*) into n from public.memberships;
  if n <> 4 then raise exception 'a_mgr should see the 2 memberships of A and the 2 of B, saw %', n; end if;
  if exists (select 1 from public.memberships where dealership_id = c) then
    raise exception 'a_mgr can see a membership of C';
  end if;
  raise notice 'ok: a_mgr sees the memberships of A and B only';

  -- sees all of A's listings (3 now) and can update and delete a salesperson's
  select count(*) into n from public.listings where dealership_id = a;
  if n <> 3 then raise exception 'a_mgr should see 3 listings of A, saw %', n; end if;
  update public.listings set listing_url = 'https://www.facebook.com/marketplace/item/1/' where id = '00000000-0000-4000-8000-0000000000e1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not update a salesperson''s listing'; end if;
  delete from public.listings where vin = 'TESTVINA00000004';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not delete a listing of A'; end if;
  raise notice 'ok: a_mgr updates and deletes listings of A';

  -- but still nothing in C
  if exists (select 1 from public.listings where dealership_id = c) then
    raise exception 'a_mgr can see a listing of C';
  end if;
  update public.listings set price = 1 where id = '00000000-0000-4000-8000-0000000000e4';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a_mgr updated a listing of C'; end if;
  begin
    insert into public.listings (dealership_id, user_id, vin, name, price, posted_at)
    values (c, auth.uid(), 'TESTVINX00000003', 'Sneaky', 1, now());
    raise exception 'a_mgr inserted a listing into C';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr cannot write in C';
  end;

  -- can rename their dealership
  update public.dealerships set name = 'Dealership A (renamed)' where id = a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not rename A'; end if;
  -- but not change its website (the key /sync matches on, and unique: an oracle for other customers)
  begin
    update public.dealerships set website_origin = 'https://www.dealership-b.test' where id = a;
    raise exception 'a_mgr changed the website of A';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr renames A but cannot change its website';
  end;

  -- creates invites for A, not for C
  inv := public.create_invite(a, 'salesperson');
  if length(inv ->> 'code') <> 12 then raise exception 'create_invite returned %', inv; end if;
  begin
    perform public.create_invite(c, 'salesperson');
    raise exception 'a_mgr created an invite for C';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr creates invites for their own dealerships only';
  end;

  -- lists A's open codes: the one just made, good for 7 days; not the one a salesperson's id is on (it could
  -- never be redeemed), and never C's
  if exists (select 1 from public.list_invites(a) l where l.code = 'ORPHANA00004') then
    raise exception 'list_invites shows a code whose maker is no manager';
  end if;
  if not exists (select 1 from public.list_invites(a) l where l.code = inv ->> 'code' and l.role = 'salesperson' and l.expires_at > now() + interval '6 days') then
    raise exception 'list_invites does not show the code a_mgr just made, good for 7 days';
  end if;
  if exists (select 1 from public.list_invites(a) l where l.code in ('NEWCOMERB001', 'OPENC0000005')) then
    raise exception 'list_invites(A) shows another dealership''s code';
  end if;
  begin
    perform * from public.list_invites(c);
    raise exception 'a_mgr listed C''s invites';
  exception when insufficient_privilege then
    raise notice 'ok: a_mgr lists their own dealerships'' open codes only';
  end;

  -- revokes A's code once; C's codes and unknown ones read the same: false
  if not public.revoke_invite(lower(inv ->> 'code')) then raise exception 'a_mgr could not revoke A''s code'; end if;
  if public.revoke_invite(inv ->> 'code') then raise exception 'a revoked code was revoked twice'; end if;
  if public.revoke_invite('OPENC0000005') then raise exception 'a_mgr revoked a code of C'; end if;
  if public.revoke_invite('NOSUCHCODE00') then raise exception 'revoke_invite said true for an unknown code'; end if;
  if exists (select 1 from public.list_invites(a) l where l.code = inv ->> 'code') then
    raise exception 'a revoked code is still listed';
  end if;
  raise notice 'ok: a_mgr revokes A''s codes, and nothing else, with one answer';

  -- the team: a manager changes a member's role and name, never who or where they are
  update public.memberships set role = 'manager' where user_id = a_sales and dealership_id = a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not make a_sales a manager'; end if;
  update public.memberships set role = 'salesperson', name = 'Alex R.' where user_id = a_sales and dealership_id = a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a_mgr could not make a_sales a salesperson again'; end if;
  -- a_mgr manages B too, so the update policy's with check would let the row into B: only the column
  -- grant (name and role) stops a manager of two stores moving people between them
  begin
    update public.memberships set dealership_id = b where user_id = a_sales and dealership_id = a;
    raise exception 'a_mgr moved a member to another dealership';
  exception when insufficient_privilege then null;
  end;
  if not exists (select 1 from public.memberships where user_id = a_sales and dealership_id = a)
     or exists (select 1 from public.memberships where user_id = a_sales and dealership_id = b) then
    raise exception 'a_sales is no longer a member of A alone after the refused move';
  end if;
  begin
    update public.memberships set user_id = '00000000-0000-4000-8000-0000000000c1' where user_id = a_sales and dealership_id = a;
    raise exception 'a_mgr rewrote a member''s user id';
  exception when insufficient_privilege then null;
  end;
  -- and A keeps a manager: the last one can neither step down nor leave (being B's manager too changes nothing)
  begin
    update public.memberships set role = 'salesperson' where user_id = auth.uid() and dealership_id = a;
    raise exception 'the last manager of A stepped down';
  exception when others then
    if sqlstate <> 'P0006' then raise; end if;
  end;
  begin
    delete from public.memberships where user_id = auth.uid() and dealership_id = a;
    raise exception 'the last manager of A removed themselves';
  exception when others then
    if sqlstate <> 'P0006' then raise; end if;
  end;
  raise notice 'ok: a_mgr changes roles and names only, and A always keeps a manager';

  -- the views show A and B, never C
  select count(*) into n from public.v_salesperson_summary where dealership_id = a;
  if n <> 2 then raise exception 'v_salesperson_summary should have 2 rows for A, has %', n; end if;
  if exists (select 1 from public.v_salesperson_summary where dealership_id not in (a, b)) then
    raise exception 'v_salesperson_summary shows a dealership a_mgr does not manage';
  end if;
  if (select median_seconds from public.v_salesperson_summary where user_id = a_sales) <> 50 then
    raise exception 'median seconds for a_sales should be 50';
  end if;
  select count(*) into n from public.v_open_todo where dealership_id = a;
  if n <> 1 then raise exception 'v_open_todo should have 1 open item for A, has %', n; end if;
  if (select salesperson from public.v_open_todo where dealership_id = a) <> 'Jamie' then
    raise exception 'v_open_todo should join the open item to the listing it belongs to';
  end if;
  if exists (select 1 from public.v_open_todo where dealership_id not in (a, b)) then
    raise exception 'v_open_todo shows a dealership a_mgr does not manage';
  end if;
  raise notice 'ok: the views show A and B only';
end;
$$;

-- a salesperson cannot list A's codes
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'a_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;
do $$
begin
  begin
    perform * from public.list_invites('00000000-0000-4000-8000-0000000000d1');
    raise exception 'a salesperson listed their dealership''s invites';
  exception when insufficient_privilege then
    raise notice 'ok: only a manager lists invite codes';
  end;
  if public.revoke_invite('ORPHANA00004') then raise exception 'a salesperson revoked a code'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- b_sales: a salesperson of B
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'b_sales' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  a uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  select count(*) into n from public.listings;
  if n <> 1 then raise exception 'b_sales should see the 1 listing of B, saw %', n; end if;
  if exists (select 1 from public.listings where dealership_id = a) then
    raise exception 'b_sales can see a listing of A';
  end if;
  select count(*) into n from public.todo_items where dealership_id = a;
  if n <> 0 then raise exception 'b_sales can see A''s to-do items'; end if;
  raise notice 'ok: b_sales sees only B';
end;
$$;

-- ---------------------------------------------------------------------------
-- newcomer: signed in, not yet a member; redeems an invite for B
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"' || :'newcomer' || '","role":"authenticated"}', true) as claims \gset
set local role authenticated;

do $$
declare
  n bigint;
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  got jsonb;
  code text;
  i integer;
begin
  select count(*) into n from public.listings;
  if n <> 0 then raise exception 'a user with no membership sees % listings', n; end if;
  select count(*) into n from public.memberships;
  if n <> 0 then raise exception 'a user with no membership sees % memberships', n; end if;
  raise notice 'ok: without a membership nothing is visible';

  -- an unknown code: answered, not raised (PostgREST sends it as a 400), so the miss it counts is kept
  got := public.redeem_invite('NOPE', 'Nobody');
  if got ->> 'code' <> 'P0002' or got ->> 'message' <> 'that invite code is not valid' then
    raise exception 'an unknown invite code was answered with %', got;
  end if;
  -- an expired code and one whose maker is no manager get the very same answer
  if public.redeem_invite('EXPIREDB0003', 'Nobody') <> got then raise exception 'an expired code was not refused the same way'; end if;
  if public.redeem_invite('ORPHANA00004', 'Nobody') <> got then raise exception 'a code whose maker is no manager was not refused the same way'; end if;
  select count(*) into n from public.memberships where user_id = auth.uid();
  if n <> 0 then raise exception 'a refused code made the newcomer a member'; end if;
  raise notice 'ok: unknown, expired and orphaned codes get one answer and let nobody in';

  -- the real one (lower case and spaces are tolerated)
  got := public.redeem_invite(' newcomerb001 ', 'Riley');
  if (got ->> 'dealership_id')::uuid <> b or got ->> 'role' <> 'salesperson' or got ->> 'name' <> 'Riley' or got ->> 'website_origin' <> 'https://www.dealership-b.test' then
    raise exception 'redeem_invite returned %', got;
  end if;
  select count(*) into n from public.listings where dealership_id = b;
  if n <> 1 then raise exception 'after redeeming, the newcomer should see B''s listing'; end if;
  select count(*) into n from public.memberships where user_id = auth.uid() and dealership_id = b and role = 'salesperson';
  if n <> 1 then raise exception 'redeem_invite did not create the membership'; end if;
  raise notice 'ok: redeem_invite makes the newcomer a member of B';

  -- single use, and a used code reads like an unknown one
  got := public.redeem_invite('NEWCOMERB001', 'Riley');
  if got ->> 'code' <> 'P0002' or got ->> 'message' <> 'that invite code is not valid' then
    raise exception 'a used invite code was answered with %', got;
  end if;
  raise notice 'ok: an invite code works once';

  -- an owner-made lower-case code, typed the way the extension sends it
  -- (upper case, with spaces around it): found, and rejoining B with it
  -- takes the invite's role and keeps the name
  got := public.redeem_invite(' MADE-UP-B002 ', null);
  if (got ->> 'dealership_id')::uuid <> b or got ->> 'role' <> 'manager' or got ->> 'name' <> 'Riley' then
    raise exception 'redeeming a lower-case owner-made code returned %', got;
  end if;
  select count(*) into n from public.memberships where user_id = auth.uid() and dealership_id = b and role = 'manager';
  if n <> 1 then raise exception 'redeeming the second invite did not update the membership'; end if;
  raise notice 'ok: an invite code is matched ignoring case and surrounding spaces';

  -- the throttle: four misses so far (NOPE, expired, orphaned, used); six more make ten, and then the
  -- function refuses before looking anything up, even a good code
  for i in 1..6 loop
    got := public.redeem_invite('GUESS' || i, null);
    if got ->> 'code' <> 'P0002' then raise exception 'miss % was answered with %', i, got; end if;
  end loop;
  begin
    perform public.redeem_invite('NOPE', null);
    raise exception 'the eleventh try inside an hour was looked up';
  exception when others then
    if sqlstate <> 'P0005' then raise; end if;
  end;
  raise notice 'ok: after 10 misses in an hour redeem_invite refuses with P0005';
end;
$$;

-- the code is marked used (checked as the owner, since nobody else can read invites)
reset role;
do $$
begin
  if not exists (select 1 from public.invites where code = 'NEWCOMERB001' and used_by = '00000000-0000-4000-8000-0000000000c1' and used_at is not null) then
    raise exception 'the redeemed invite was not marked used';
  end if;
  if not exists (select 1 from public.invites where code = 'made-up-b002' and used_by = '00000000-0000-4000-8000-0000000000c1' and used_at is not null) then
    raise exception 'the redeemed lower-case invite was not marked used (it is stored as typed)';
  end if;
  raise notice 'ok: the redeemed invite is marked used';

  -- the failed tries are counted where nobody else can see them
  if (select count(*) from public.invite_misses where user_id = '00000000-0000-4000-8000-0000000000c1') <> 10 then
    raise exception 'invite_misses should hold the newcomer''s 10 misses';
  end if;
  raise notice 'ok: each miss is counted';

  -- a removed manager's unused codes go with them; used ones stay as the record
  -- (a_sales becomes a manager first: A must keep one); the codes a_mgr made for B, where they are still a
  -- manager, stay
  update public.memberships set role = 'manager' where user_id = '00000000-0000-4000-8000-0000000000a1' and dealership_id = '00000000-0000-4000-8000-0000000000d1';
  insert into public.invites (code, dealership_id, role, created_by) values
    ('KEPTBYAMGR05', '00000000-0000-4000-8000-0000000000d1', 'manager',     '00000000-0000-4000-8000-0000000000a2'),
    ('AMGRFORB0006', '00000000-0000-4000-8000-0000000000d2', 'salesperson', '00000000-0000-4000-8000-0000000000a2');
  delete from public.memberships where user_id = '00000000-0000-4000-8000-0000000000a2' and dealership_id = '00000000-0000-4000-8000-0000000000d1';
  if exists (select 1 from public.invites where created_by = '00000000-0000-4000-8000-0000000000a2' and dealership_id = '00000000-0000-4000-8000-0000000000d1' and used_at is null) then
    raise exception 'a removed manager''s unused codes survived their removal';
  end if;
  if not exists (select 1 from public.invites where code = 'AMGRFORB0006') then
    raise exception 'removing a_mgr from A took the code they made for B';
  end if;
  raise notice 'ok: removing a member deletes the codes they made there and nobody used, and no others';

  -- deleting a dealership still cascades to its memberships, last manager included
  delete from public.dealerships where id = '00000000-0000-4000-8000-0000000000d1';
  if exists (select 1 from public.memberships where dealership_id = '00000000-0000-4000-8000-0000000000d1') then
    raise exception 'deleting A left memberships behind';
  end if;
  raise notice 'ok: deleting a dealership removes its members';
end;
$$;

-- ---------------------------------------------------------------------------
-- anon: the public key with no user gets nothing
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true) as claims \gset
set local role anon;

do $$
declare
  n bigint;
begin
  begin
    select count(*) into n from public.listings;
    if n <> 0 then raise exception 'anon can read % listings', n; end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.redeem_invite('NEWCOMERB001', 'Nobody');
    raise exception 'anon could call redeem_invite';
  exception when insufficient_privilege then
    null;
  end;
  begin
    select count(*) into n from public.demo_requests;
    raise exception 'anon can read demo requests';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.demo_requests (name, dealership, website, email) values ('x', 'x', 'x.test', 'x@x.test');
    raise exception 'anon can write a demo request past the lead function';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: anon reads nothing and cannot redeem';
end;
$$;

reset role;
rollback;

\echo 'rls.sql: every check passed (all changes rolled back)'
