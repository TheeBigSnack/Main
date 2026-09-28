# Lot Sync on Supabase: accounts, sync and the rewrite service (Milestone 4)

This folder is everything the owner deploys to give a dealership shared
accounts: sign-in by magic link, one database per Lot Sync with a row-level
wall between dealerships, and two small server functions. Nothing in it runs
until the owner creates a Supabase project and pushes it; the extension works
without it as before (everything stays in the browser).

What is here:

| Path | What it is |
|---|---|
| `config.toml` | The Supabase CLI's project file. Minimal; the CLI's defaults apply to everything left out. |
| `migrations/0001_schema.sql` | The tables: dealerships, memberships, listings (the posted registry), todo_items, scan_summaries, post_attempts, rewrite_usage, invites. |
| `migrations/0002_rls.sql` | Row-level security on every table, the `is_member` / `is_manager` helpers, `redeem_invite` and `create_invite`. |
| `migrations/0003_views.sql` | `v_salesperson_summary` and `v_open_todo` for the manager page. |
| `functions/rewrite/` | The rewrite service (replaces `backend/`): `/rewrite` and `/color` behind sign-in, a rate limit and a monthly cost cap. |
| `functions/sync/` | `/sync`: the posted registry and the pilot numbers up, the dealership's current state down. |
| `functions/_shared/` | The prompt and the guardrails, copied from `backend/rewritePrompt.js` and `extension/src/rewriteTemplate.js`; CORS, JSON and sign-in helpers. |
| `tests/rls.sql` | Proves the wall between dealerships against a running database (below). |
| `tests/local-shim.sql` | Lets the migrations and the test run on a plain Postgres with no Supabase. |
| `tests/port-check.mjs` | Checks the two `_shared` copies against their originals in Node. |

On the extension side, `extension/src/account.js` (sign-in, the session, invite codes) and `extension/src/sync.js` (what goes up, how the answer is merged) are pure and unit-tested; the Settings fields and the buttons that call them arrive with the UI wiring.

## What to create, once

You need the Supabase CLI (`npm install -g supabase` or the installer from supabase.com) and an Anthropic API key if you want the rewrite service.

1. **A project.** At supabase.com create a project (any region near the dealers; the free plan is enough to start, and paid features stay off until you switch them on). Note from Project settings, API: the **Project URL** and the **anon (public) key**. The anon key is meant to be shipped to browsers; the database policies are what keep a person inside their own dealership. The **service_role key** on the same page is secret: it goes into the functions only (step 4), never into the extension, the manager page or git.

2. **The database.** From the repository root:

   ```
   supabase login
   supabase link --project-ref <the ref from the project URL>
   supabase db push
   ```

   `db push` applies the three migrations in order. Nothing in them is reachable through the API until the second one has turned row-level security on, and `db push` applies all three together.

3. **Sign-in settings** (Dashboard, Authentication):
   - Providers, Email: keep it on; passwords are never used, so "Confirm email" can stay off (the magic link is the confirmation).
   - Email templates, Magic Link: the extension can finish a sign-in two ways. The simplest is the six-digit code: put `{{ .Token }}` in the template and the salesperson types it into the extension (`verifyOtp`). A link also works when it points at the extension's own sign-in page with `{{ .TokenHash }}` (`...?token_hash={{ .TokenHash }}&type=magiclink`); then add that page's address (`chrome-extension://<the extension id>/signin.html`) under URL configuration, Redirect URLs. Both are handled by `account.js`.
   - Rate limits: the defaults are fine for a dealership.

4. **Secrets and the two functions.** The functions get `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase automatically. Set the rest:

   ```
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase secrets set REWRITE_MODEL=claude-haiku-4-5 MONTHLY_COST_CAP_USD=25 RATE_LIMIT_PER_MINUTE=20
   supabase functions deploy rewrite
   supabase functions deploy sync
   ```

   `config.toml` turns the gateway's own token check off for both functions (`verify_jwt = false`) because each function checks the caller's token itself and answers 401 with a sentence the extension can show; that also lets the browser's CORS preflight through. The functions' addresses are `https://<ref>.supabase.co/functions/v1/rewrite` and `.../functions/v1/sync`.

5. **The first dealership and its manager**, in the Dashboard's SQL editor (there is no sign-up form; a dealership exists because you created it):

   ```sql
   insert into public.dealerships (name, website_origin)
   values ('<the dealership''s name>', 'https://www.<the dealer website>')
   returning id;

   -- one single-use code for the first manager; any text works as a code
   insert into public.invites (code, dealership_id, role)
   values ('<a code you make up>', '<the id returned above>', 'manager');
   ```

   `website_origin` is the dealer website's origin exactly as the extension sees it (scheme and host, no path, no trailing slash): the extension keeps its registry under `posted:<origin>` and the sync function matches on it. The manager signs in with the magic link, redeems the code, and from then on creates codes for the salespeople with `create_invite` (a button on the manager page; or `select public.create_invite('<dealership id>', 'salesperson');` while signed in as the manager in the SQL editor's role switcher). A code works once. Invites are never listed through the API; a code is a secret you hand to one person.

## Environment variables

| Name | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | function secret | The Anthropic API key. The only place it exists. Without it `/rewrite` answers 500 and the extension uses its template. |
| `REWRITE_MODEL` | function secret | The model for both endpoints. Default `claude-haiku-4-5`; `claude-sonnet-5` for better prose at a higher price. |
| `MONTHLY_COST_CAP_USD` | function secret | Per dealership per calendar month (UTC), summed from `rewrite_usage`. Default 25. At the cap `/rewrite` and `/color` answer 429 with a plain sentence until the month turns. |
| `RATE_LIMIT_PER_MINUTE` | function secret | Calls per signed-in user per minute. Default 20. Counted in each function instance's memory, so with several instances a burst can exceed it by that factor; it is a brake, not a ledger. |
| `ALLOWED_ORIGINS` | function secret, optional | Comma-separated page origins allowed to call the functions from a browser besides the extension's own `chrome-extension://` origin (a local manager page during development, say). |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | set by Supabase | The functions read them; nothing to do. The service-role key is used for exactly one thing, writing `rewrite_usage`, and only inside the rewrite function. |

## How the extension is configured

A Settings section for the account (arriving with the UI wiring) takes the **project URL** and the **anon key** from step 1; both are safe to type into every salesperson's extension. Then:

1. **Sign in**: the salesperson enters their email and gets a link and a code. The session (a token, its refresh token, expiry, the user's id and email) is kept in `chrome.storage.local` under `account`, never in Chrome's synced storage; it stays on that computer. No password anywhere.
2. **Join the dealership**: they enter the invite code once (`redeemInvite`). The answer carries the dealership's name and website origin, which the extension stores next to its per-website settings.
3. **Sync**: after a scan, a post, a price update or a take-down, the extension POSTs `syncPayload(...)` to `.../functions/v1/sync` with the session's token and merges the answer (`mergeRegistry`, `mergeFlags`). Two salespeople then see the same posted registry, and the manager page sees both.
4. **Description writer**: in Settings, the rewrite service address becomes `https://<ref>.supabase.co/functions/v1/rewrite` and the key field is the session's token (the UI wiring fills it from the session; the shared `REWRITE_KEY` of `backend/` is gone). `extension/src/rewriter.js` already calls `<address>/rewrite` and `<address>/color` with `Authorization: Bearer <key>`.

## The two functions

Both take `Authorization: Bearer <the user's access token>` and a JSON body, and answer JSON with `ok`. Errors are `{ ok: false, error: "<a sentence>" }` with 400 (bad request), 401 (no valid token), 403 (not a member), 404, 429 (rate limit or the monthly cap), 502/503 (the Anthropic API) or 500.

**`POST .../functions/v1/rewrite/rewrite`** (or the bare `/rewrite`): the body is the facts object `extension/src/rewriter.js` builds (`rewriteFacts`: year, make, model, trim, mileage, stock, features, carfaxOneOwner, carfax, colors, engine, transmission, drivetrain, fuelType, narrative, dealer { name, city }, salesperson { name, title }, priceNote). No VIN goes up; the extension adds the VIN line afterwards. An optional `origin` picks the dealership for a person who belongs to several. Answer: `{ ok, text, model, guardrails: { ok, problems: [{ code, text }], words }, costUsd, error }`, the same as `backend/server.js`: `ok` is false when the draft failed the guardrails twice or the model declined, and the extension then shows its template.

**`POST .../functions/v1/rewrite/color`**: `{ photos: [up to 4 https addresses], options: [Facebook's color words] }`. Answer: `{ ok: true, exterior, interior, confidence, model, costUsd }` or `{ ok: false, error, costUsd }`.

**`GET .../functions/v1/rewrite/health`** (signed in): `{ ok, model, month, usd, capUsd, perMinute, dealership }`, the caller's dealership's spend this month.

**`POST .../functions/v1/sync`**: `{ origin, posted, pilot: { posts, flags }, scan, since }` as `syncPayload()` in `extension/src/sync.js` builds it: `origin` is the dealer website's origin; `posted` is the salesperson's own registry entries, whole (`{ [vin]: { name, price, postedAt, listingUrl?, salesperson?, updatedAt? } }`); `posts` and `flags` are the pilot's post attempts and to-do flags that changed since the last sync (all of them the first time); `scan` is `{ takenAt, cars, ready, takeDownCount, priceUpdateCount }` or null; `since` is the `serverTime` of the last answer or null. The function upserts the caller's listings (matched on VIN and posting time; another user's row or a taken-down row is never changed), marks the caller's listed rows that are missing from the registry and were posted before `since` as taken down, upserts the post attempts (VIN and start time) and the to-do items (VIN, kind and flagging time; closed by an upload, never reopened), stores the scan once, and answers `{ ok, serverTime, dealership: { id, name, websiteOrigin }, role, counts, listings, todoItems }`: every listing of the dealership that is up plus the ones taken down since `since` (the last 90 days for a first sync), and every open to-do item plus the ones closed since. A user who is not a member of the dealership for that origin gets 403.

## Who can see and do what

Every table has row-level security on. In one line: a signed-in person sees their own dealership and nothing else; salespeople write their own rows; managers can change any row of their dealership; only managers delete; the anon key alone gets nothing. The full list is in `migrations/0002_rls.sql`, each policy with a comment saying what it is for. The service role (inside the functions only) bypasses these, as it always does on Supabase.

## Run the RLS test

The test is plain SQL: it creates two dealerships and four people, sets each person's token claims the way the API does, and raises on the first thing a person can see or do that they should not. It rolls everything back at the end. PLAN.md's acceptance criterion 3 for M4 is this script passing.

Against the local Supabase stack (Docker required):

```
supabase start
supabase db reset            # applies the migrations to the local database
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
```

Against a plain Postgres (a laptop, CI) with no Supabase at all, the shim first, then the migrations, then the test:

```
createdb lotsync_test
psql -v ON_ERROR_STOP=1 -d lotsync_test \
  -f supabase/tests/local-shim.sql \
  -f supabase/migrations/0001_schema.sql \
  -f supabase/migrations/0002_rls.sql \
  -f supabase/migrations/0003_views.sql \
  -f supabase/tests/rls.sql
```

Either way the last line is `rls.sql: every check passed` and psql exits 0; a failed check prints the reason and exits non-zero. Never run the shim against a Supabase database; it only exists for Postgres without Supabase.

The two copies in `functions/_shared/` (the prompt and the guardrails) are checked against their originals with

```
node --experimental-strip-types supabase/tests/port-check.mjs
```

and `npm test` covers `extension/src/account.js` and `extension/src/sync.js`.

## What is stored

Only what the extension already keeps in the browser and the privacy policy names (`legal/privacy-policy.md`): the dealership, who belongs to it and as what, the posted registry (VIN, name, price, times, the listing link the salesperson saved, who posted), the to-do items, the post attempts (times and outcomes), scan counts, and one row per rewrite call with its token counts and cost. No descriptions, no photos, no buyers, nothing from the Facebook account beyond the listing link. The fill records (which form fields could not be filled) stay in the browser. Deleting a dealership row deletes everything it owns.

## What replaces backend/ and when

`functions/rewrite` is `backend/server.js` moved behind real accounts: the same two endpoints, the same guardrails, the same model and cost table, but a per-user token instead of one shared key, and a cost cap per dealership instead of one for the whole service. The prompt and the guardrails are copies (not imports, since the function is its own bundle) kept equal by `tests/port-check.mjs`.

`backend/` stays until the first dealership is signed in through the extension and its rewrite address points at the function; then `backend/` can go (the README, CLAUDE.md and the Settings copy that mention it change with it). During the pilot both can run: a salesperson without an account keeps using `backend/` with the shared key; one with an account uses the function.
