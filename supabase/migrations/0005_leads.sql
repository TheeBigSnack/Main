-- Lot Sync: demo requests from the landing page (PLAN.md M5, acceptance 2:
-- "the demo form lands in Supabase or an inbox").
--
-- One row per request the `lead` Edge Function accepted. Nobody reads this
-- through the API: RLS is on and no API role but the service role (inside
-- the function) has any privilege, so the anon key the landing page could
-- carry gets nothing, and a signed-in dealer sees nothing of another
-- dealer's interest. The owner reads the rows in the Dashboard's Table
-- editor (or a database webhook mails them; supabase/README.md).
--
-- Only what the visitor typed, plus when and from which page: no IP
-- address (the function's per-address brake hashes it in memory and forgets
-- it), no cookie, no tracking.

create table public.demo_requests (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 80),
  dealership text not null check (char_length(dealership) between 1 and 120),
  website text not null check (char_length(website) between 1 and 200),
  email text not null check (char_length(email) between 3 and 200),
  phone text check (phone is null or char_length(phone) <= 40),
  message text check (message is null or char_length(message) <= 2000),
  page_origin text check (page_origin is null or char_length(page_origin) <= 200),
  handled_at timestamptz
);
create index demo_requests_received_idx on public.demo_requests (received_at desc);
comment on table public.demo_requests is 'Demo requests from the landing page, written by the lead function with the service role. No API role reads them; the owner does, in the Dashboard.';
comment on column public.demo_requests.handled_at is 'Set by the owner when the request has been answered.';

alter table public.demo_requests enable row level security;
revoke all on public.demo_requests from anon, authenticated;
revoke all on sequence public.demo_requests_id_seq from anon, authenticated;
grant all on public.demo_requests to service_role;
