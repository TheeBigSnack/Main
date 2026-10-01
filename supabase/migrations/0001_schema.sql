-- Lot Current, Milestone 4: the tables.
--
-- One row per dealership (a rooftop), its members, and only what the
-- extension already keeps per browser: the posted registry (listings), the
-- pilot numbers (post_attempts, todo_items), scan summaries, the rewrite
-- service's cost log, invite codes and the count of failed attempts at
-- redeeming one. Nothing from Facebook beyond the
-- listing link the salesperson saved (legal/privacy-policy.md, "What we
-- collect"). No descriptions, no photos, no buyers.
--
-- Applied by `supabase db push` in file order. 0002_rls.sql locks every table
-- down; until then nothing here is reachable through the API by anyone but
-- the service role. Column names and types are shared with manager/data.js
-- (the manager view reads these rows as they are): keep them.
--
-- Every dealership_id references dealerships with on delete cascade, so
-- deleting a dealership row deletes everything it owns, which is what the
-- privacy policy promises within 30 days of a subscription ending.

-- ---------------------------------------------------------------------------
-- dealerships: one per rooftop. website_origin is the dealer website's origin
-- (https://www.example-motors.com), the same key the extension stores under
-- (posted:<origin>, settings:<origin>), and it is what /sync matches on.
-- ---------------------------------------------------------------------------
create table public.dealerships (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website_origin text not null unique,
  created_at timestamptz not null default now()
);
comment on table public.dealerships is 'One row per rooftop. website_origin is the dealer website''s origin, the key the extension syncs under.';

-- ---------------------------------------------------------------------------
-- memberships: who belongs to which dealership, as what. A person can belong
-- to several dealerships (sister stores) with one row each. name is the
-- display name the manager view shows; the salesperson gives it when they
-- redeem their invite.
-- ---------------------------------------------------------------------------
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  role text not null check (role in ('salesperson', 'manager')),
  name text,
  primary key (user_id, dealership_id)
);
create index memberships_dealership_idx on public.memberships (dealership_id);
comment on table public.memberships is 'Who belongs to which dealership and as what. Rows are created by redeem_invite(), by create_dealership() for a self-serve dealership''s first manager, or by the owner in SQL.';

-- ---------------------------------------------------------------------------
-- listings: the posted registry, one row per post. The extension's local
-- entry posted:<origin>[vin] = { name, price, postedAt, listingUrl,
-- salesperson, updatedAt } becomes one row; a car posted again later is a
-- second row (the unique key includes posted_at). status and taken_down_at
-- move together: a take-down sets both.
-- posted_at is the time the salesperson's browser recorded the post (that
-- machine's clock); created_at is when this database first saw the row (its
-- own clock, when the inserting transaction began). The sync function's
-- take-down rule compares neither with a sync time: it takes down only the
-- posts the caller's machine sent or received at its last sync (`known`),
-- so a slow clock, or a post uploaded late from another of the
-- salesperson's machines, cannot look like a take-down. (created_at was
-- added here in place rather than in a later migration: no project has
-- applied these files yet.)
-- user_id is the poster's auth.users id, kept without a foreign key so the
-- dealership's record survives that account being deleted.
-- ---------------------------------------------------------------------------
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  user_id uuid not null,
  vin text not null,
  name text,
  price integer,
  posted_at timestamptz not null,
  created_at timestamptz not null default now(),
  listing_url text,
  salesperson text,
  updated_at timestamptz,
  taken_down_at timestamptz,
  status text not null default 'listed' check (status in ('listed', 'taken_down')),
  constraint listings_status_matches_taken_down check ((status = 'taken_down') = (taken_down_at is not null)),
  unique (dealership_id, vin, posted_at)
);
create index listings_dealership_vin_idx on public.listings (dealership_id, vin);
create index listings_dealership_posted_idx on public.listings (dealership_id, posted_at);
create index listings_dealership_user_idx on public.listings (dealership_id, user_id);
comment on table public.listings is 'The posted registry: one row per post (VIN, price, times, the listing link the salesperson saved, who posted).';

-- ---------------------------------------------------------------------------
-- todo_items: a sold car to take down or a price to update on one of the
-- dealership's listings, from the extension's rescan (pilot.js flags).
-- Open while done_at is null. how says how it was closed: detected (Lot Current
-- saw the listing change), manual (the person ticked it off), cleared (a
-- clean rescan no longer listed it).
-- ---------------------------------------------------------------------------
create table public.todo_items (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  vin text not null,
  kind text not null check (kind in ('takeDown', 'price')),
  name text,
  flagged_at timestamptz not null,
  done_at timestamptz,
  how text check (how in ('detected', 'manual', 'cleared')),
  from_price integer,
  to_price integer,
  unique (dealership_id, vin, kind, flagged_at)
);
create index todo_items_dealership_vin_idx on public.todo_items (dealership_id, vin);
create index todo_items_open_idx on public.todo_items (dealership_id, flagged_at) where done_at is null;
comment on table public.todo_items is 'Sold cars to take down and prices to update, as the rescan flagged them; open while done_at is null.';

-- ---------------------------------------------------------------------------
-- scan_summaries: counts from each scan of the website, so the manager page
-- can say when the last scan ran and what it found. Counts only, no VINs.
-- ---------------------------------------------------------------------------
create table public.scan_summaries (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  website_origin text not null,
  taken_at timestamptz not null,
  cars integer,
  ready integer,
  take_down_count integer,
  price_update_count integer,
  unique (dealership_id, website_origin, taken_at)
);
create index scan_summaries_dealership_taken_idx on public.scan_summaries (dealership_id, taken_at);
comment on table public.scan_summaries is 'Counts from each scan of the dealer website (cars, ready, to take down, price changes). No VINs.';

-- ---------------------------------------------------------------------------
-- post_attempts: the pilot's time-per-post numbers (pilot.js posts): when a
-- post started and ended and how it went. Field keys and outcomes only,
-- never a description or anything from the Facebook account.
-- ---------------------------------------------------------------------------
create table public.post_attempts (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  user_id uuid not null,
  vin text not null,
  name text,
  salesperson text,
  queue boolean not null default false,
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text,
  seconds integer,
  reason text,
  unique (dealership_id, user_id, vin, started_at)
);
create index post_attempts_dealership_vin_idx on public.post_attempts (dealership_id, vin);
create index post_attempts_dealership_started_idx on public.post_attempts (dealership_id, started_at);
comment on table public.post_attempts is 'Time per post: when each attempt started and ended, its outcome and seconds. Nothing from Facebook.';

-- ---------------------------------------------------------------------------
-- rewrite_usage: one row per call the rewrite function makes to the Anthropic
-- API, with its token counts and cost, so the monthly cap is per dealership.
-- Written only by the function with the service role; members can read it.
-- ---------------------------------------------------------------------------
create table public.rewrite_usage (
  id bigserial primary key,
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  user_id uuid not null,
  at timestamptz not null default now(),
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(10, 6),
  kind text check (kind in ('rewrite', 'color'))
);
create index rewrite_usage_dealership_at_idx on public.rewrite_usage (dealership_id, at);
comment on table public.rewrite_usage is 'One row per Anthropic API call from the rewrite function: model, tokens, cost. The monthly cap sums cost_usd per dealership.';

-- ---------------------------------------------------------------------------
-- invites: single-use codes that put a signed-in person into a dealership.
-- Created by a manager (create_invite) or by the owner in SQL for the first
-- manager; redeemed once (redeem_invite). A code lives 7 days (expires_at,
-- added in place: no project has applied this file yet) and dies with its
-- maker: redeem_invite() refuses a code whose maker (created_by, when set)
-- no longer holds a manager membership of the dealership, and removing a
-- membership deletes that person's unused codes (a trigger in 0002_rls.sql).
-- The table itself is never readable through the API: a manager sees the
-- dealership's open codes through list_invites() and cancels one with
-- revoke_invite(), both in 0002_rls.sql.
-- ---------------------------------------------------------------------------
create table public.invites (
  code text primary key,
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  role text not null default 'salesperson' check (role in ('salesperson', 'manager')),
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_by uuid,
  used_at timestamptz
);
create index invites_dealership_idx on public.invites (dealership_id);
-- redeem_invite() matches a code ignoring case and surrounding spaces (the
-- first manager's code is typed by the owner in SQL, in any case), so two
-- codes may not differ only in those; the index also serves that lookup.
-- (Added in place: no project has applied this file yet.)
create unique index invites_code_folded_idx on public.invites (upper(trim(code)));
comment on table public.invites is 'Single-use invite codes, good for 7 days. Read only inside redeem_invite() and list_invites(); the API never reads the table.';
comment on column public.invites.expires_at is 'After this the code is refused. 7 days from creation; the owner may set it shorter in SQL.';

-- ---------------------------------------------------------------------------
-- invite_misses: one row per failed redeem_invite() call, per account, kept
-- for an hour. The throttle: after 10 misses inside an hour the function
-- refuses every further call from that account before looking anything up,
-- so a guessed code cannot be tried without limit. Written and read only
-- inside redeem_invite(); 0002_rls.sql gives no API role, the service role
-- included, any privilege on it.
-- ---------------------------------------------------------------------------
create table public.invite_misses (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index invite_misses_user_at_idx on public.invite_misses (user_id, at);
comment on table public.invite_misses is 'Failed redeem_invite() calls per account, kept an hour: the throttle. No API role reads or writes it.';
