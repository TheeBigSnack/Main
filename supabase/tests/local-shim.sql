-- Only for a plain Postgres with no Supabase in front of it (a laptop, CI):
-- the few pieces of Supabase's auth schema and API roles that the migrations
-- and rls.sql rely on, so they can run there too. Never run this against
-- `supabase start` or the hosted project: those already have all of it, in
-- fuller form.
--
--   psql -v ON_ERROR_STOP=1 -d lotsync_test \
--     -f supabase/tests/local-shim.sql \
--     -f supabase/migrations/0001_schema.sql \
--     -f supabase/migrations/0002_rls.sql \
--     -f supabase/migrations/0003_views.sql \
--     -f supabase/migrations/0004_billing.sql \
--     -f supabase/migrations/0005_leads.sql \
--     -f supabase/migrations/0006_privacy.sql \
--     -f supabase/migrations/0007_signup.sql \
--     -f supabase/migrations/0008_usage.sql \
--     -f supabase/migrations/0009_cancel_at.sql \
--     -f supabase/tests/rls.sql \
--     -f supabase/tests/billing.sql \
--     -f supabase/tests/privacy.sql \
--     -f supabase/tests/signup.sql \
--     -f supabase/tests/usage.sql
-- (or: node scripts/sql-test.mjs, which applies them all and runs every test file)

create schema if not exists auth;

-- The columns rls.sql inserts, and the ones a real auth.users row has that
-- matter to the foreign key from memberships.
create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  created_at timestamptz,
  updated_at timestamptz
);

-- Supabase's definition: the user id from the request's JWT claims, which
-- PostgREST puts in request.jwt.claims (and older versions in
-- request.jwt.claim.sub). Null when nobody is signed in.
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt()
returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

-- The three API roles. service_role bypasses RLS, as on Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- Supabase's default privileges: every function a migration creates in public
-- is executable by the three API roles until that migration revokes it, and
-- every table, view and sequence is open to them (all privileges) until the
-- migration revokes that. The same here, so a migration that forgets a revoke
-- fails a test instead of passing unnoticed on a database that never granted.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
