# Lot Current on Supabase: accounts, sync and the rewrite service (Milestone 4)

This folder is everything the owner deploys to give a dealership shared
accounts: sign-in by magic link, one database per Lot Current with a row-level
wall between dealerships, and two small server functions. Nothing in it runs
until the owner creates a Supabase project and pushes it; the extension works
without it as before (everything stays in the browser).

What is here:

| Path | What it is |
|---|---|
| `config.toml` | The Supabase CLI's project file. Minimal; the CLI's defaults apply to everything left out. |
| `templates/` | The two sign-in emails in Lot Current's words; `config.toml` points the local stack at them, and the hosted project needs them pasted in (below, "Sign-in emails"). |
| `migrations/0001_schema.sql` | The tables: dealerships, memberships, listings (the posted registry), todo_items, scan_summaries, post_attempts, rewrite_usage, invites. |
| `migrations/0002_rls.sql` | Row-level security on every table, the `is_member` / `is_manager` helpers, `redeem_invite` and `create_invite`. |
| `migrations/0003_views.sql` | `v_salesperson_summary` and `v_open_todo` for the manager page. |
| `migrations/0006_privacy.sql` | The owner's privacy tools: `export_dealership`, `delete_dealership`, `forget_person`; no API role may call them (below, "Export or delete a dealership's data"). |
| `migrations/0005_leads.sql` | `demo_requests`, the landing page's demo requests; no API role reads it. |
| `migrations/0007_signup.sql` | Self-serve sign-up: `signup_settings` (the switch, off until you open it, and two limits), `signup_attempts`, `website_origin_of` and `create_dealership`; no API role reads either table (below, "Self-serve sign-up"). |
| `migrations/0008_usage.sql` | The owner's usage report, `usage_report(since)`: one row per dealership with its plan and activity; no API role may call it (below, "Usage report"). |
| `migrations/0009_cancel_at.sql` | `subscriptions.cancel_at`: the date a cancellation scheduled in the Billing Portal ends the subscription, so the manager view says so instead of a renewal. The first change made after the project applied the first eight; apply it (`db push`, or the workflow's database step) before deploying the `billing` function that writes it. |
| `functions/lead/` | `/lead`: the landing page's demo form, anonymous, behind its origin, a honeypot and rate limits. |
| `functions/rewrite/` | The rewrite service (replaces `backend/`): `/rewrite` and `/color` behind sign-in, a rate limit and a monthly cost cap. |
| `functions/sync/` | `/sync`: the posted registry and the pilot numbers up, the dealership's current state down. |
| `functions/_shared/` | The prompt and the guardrails, copied from `backend/rewritePrompt.js` and `extension/src/rewriteTemplate.js`; CORS, JSON and sign-in helpers. |
| `tests/rls.sql` | Proves the wall between dealerships against a running database (below). |
| `tests/signup.sql` | Proves self-serve sign-up: every case of `test/fixtures/website-origins.json`, the switch, the order of the checks, both limits and the throttle, that the free pilot starts with the dealership, and that the new manager can invite. |
| `tests/usage.sql` | Proves the usage report counts each dealership's own activity only and that no API role can call it. |
| `tests/concurrency.sql` | Proves with real sessions (dblink) that two managers stepping down at once cannot leave a dealership with none, and that sign-up calls from one account sent together get no more than 5 website lookups an hour. Plain Postgres only: it needs a superuser and commits rows (and opens sign-up), then removes them and sets the switch back. |
| `tests/local-shim.sql` | Lets the migrations and the test run on a plain Postgres with no Supabase. It grants what Supabase grants by default (execute on functions, all on tables and sequences), so a missing revoke fails a test. |
| `tests/port-check.mjs` | Checks the two `_shared` copies against their originals in Node. |

On the extension side, `extension/src/account.js` (sign-in, the session, invite codes) and `extension/src/sync.js` (what goes up, how the answer is merged) are pure and unit-tested; the Settings fields and the buttons that call them arrive with the UI wiring.

## What to create, once

You need the Supabase CLI (`npm install -g supabase` or the installer from supabase.com) and an Anthropic API key if you want the rewrite service.

`docs/production-setup.md` is the owner's order of work for the production project (which steps need the owner, the email sender and the manager view's host, the deploy workflows). This section stays the reference for what each setting means.

**API keys.** Supabase is retiring the legacy `anon` and `service_role` keys by the end of 2026. Where this README says anon key, use the project's **publishable** key (`sb_publishable_...`, Project settings, API Keys) when it has one; the legacy anon key keeps working until Supabase turns it off. The functions read the new publishable and secret keys when the runtime provides them and fall back to the legacy ones (`functions/_shared/auth.ts`), and `npm run check-deploy` tells the kinds apart and fails on a secret key in a file a browser reads.

1. **A project.** At supabase.com create a project (any region near the dealers; the free plan is enough to start, and paid features stay off until you switch them on). Note from Project settings, API: the **Project URL** and the **anon (public) key**. The anon key is meant to be shipped to browsers; the database policies are what keep a person inside their own dealership. The **service_role key** on the same page is secret: it goes into the functions only (step 4), never into the extension, the manager page or git.

2. **The database.** From the repository root:

   ```
   supabase login
   supabase link --project-ref <the ref from the project URL>
   supabase db push
   ```

   `db push` applies the nine migrations in order. Nothing in them is reachable through the API until the second one has turned row-level security on, and `db push` applies them all together. The production project has applied `0001_schema.sql` to `0008_usage.sql`, so those files never change again, not even a comment: Supabase records a migration by its number and never reads it twice, so a change made inside one would reach a fresh build and never production. Every change is a new numbered file that applies on top (`0009_cancel_at.sql` was the first), and `test/supabase.test.js` fails if an applied file changes.

3. **Sign-in settings** (Dashboard, Authentication):
   - Providers, Email: keep it on; passwords are never used, so "Confirm email" can be off (the magic link is the confirmation). A new hosted project starts with it on; either way works, because both sign-in templates carry the code and the link (below, "Sign-in emails").
   - Email templates: paste Lot Current's two sign-in templates into **Magic link or OTP** and **Confirm sign up** (below, "Sign-in emails"). Each carries the link (`{{ .ConfirmationURL }}`, which the manager page uses) and the six-digit code (`{{ .Token }}`), which is how the extension signs in: the salesperson types it into Settings (`verifyOtp` in `account.js`). The extension needs no redirect address.
   - URL configuration: set **Site URL** to the manager page's own address (for example `https://app.<your domain>/`, where `docs/production-setup.md` hosts it) and add the same address under **Redirect URLs**. The manager page asks Supabase to send its magic link back to itself (PKCE flow: the link carries a one-time code, never the tokens), and Supabase only honours a redirect it has on this list; anything else falls back to the Site URL. The extension asks for no redirect, so the link in its emails lands on the Site URL too; it sends a PKCE challenge whose verifier nobody keeps, so that link also brings only a code, which no page can exchange. Should an address still arrive with `#access_token=...` (a link asked for without a challenge), the manager page takes it out of the address bar, ends the session it carried and says why (`authFragment` in `manager/data.js`). A link the auth server refused (expired, used, or replaced by a newer email) comes back with `error`, `error_code` and `error_description` in the fragment and, for the page's own PKCE links, in the query too; the page takes both out before supabase-js starts, so a session the browser already has is kept, and says the link did not work (`authQueryError`). Never leave the Site URL at the `http://localhost:3000` default on a hosted project: a manager's link would then go to whatever listens on that port of their computer. `config.toml` carries the same setting for a local stack.
   - Rate limits: lower them. With the public anon key anyone can ask for sign-in emails to any address, and one cheap loop would use up the project's email budget and lock every salesperson out of signing in. Set **Rate limit for sending emails** to about 30 an hour and **sign-ups and sign-ins** to about 30 per 5 minutes per IP address (`config.toml`'s `[auth.rate_limit]` block has the same numbers for a local stack), and set up **custom SMTP** (Authentication, Emails) before the first dealership so the budget is yours rather than the shared test sender's. Those limits and your own sender are what protect the budget. Leave **CAPTCHA protection** (Authentication, Attack protection) off: neither the extension's code request nor the manager page's link request sends a captcha token, so with it on every new sign-in would be refused (sessions already signed in keep refreshing). It can come later, as its own piece of work, once both send one.

4. **Secrets and the two functions.** The functions get `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase automatically. Set the rest:

   ```
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase secrets set REWRITE_MODEL=claude-haiku-4-5 MONTHLY_COST_CAP_USD=25 RATE_LIMIT_PER_MINUTE=20
   supabase functions deploy rewrite
   supabase functions deploy sync
   ```

   `config.toml` turns the gateway's own token check off for both functions (`verify_jwt = false`) because each function checks the caller's token itself and answers 401 with a sentence the extension can show; that also lets the browser's CORS preflight through. The functions' addresses are `https://<ref>.supabase.co/functions/v1/rewrite` and `.../functions/v1/sync`.

5. **The first dealership and its manager**, in the Dashboard's SQL editor (until you open self-serve sign-up, below, a dealership exists only because you created it):

   ```sql
   insert into public.dealerships (name, website_origin)
   values ('<the dealership''s name>', public.website_origin_of('<the dealer website''s address>'))
   returning id;

   -- one single-use code for the first manager, made the way create_invite() makes codes: never type one yourself,
   -- a guessable code is a way in for anyone who signs up; it expires in 7 days (invites.expires_at)
   insert into public.invites (code, dealership_id, role)
   values (upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12)), '<the id returned above>', 'manager')
   returning code;
   ```

   `website_origin` is the dealer website's origin exactly as the extension sees it (scheme and host, no path, no trailing slash): the extension keeps its registry under `posted:<origin>` and the sync function matches on it. `website_origin_of` makes it from any address you paste, the way sign-up does; an address it refuses gives null, and the insert fails. The manager signs in with the magic link, redeems the code in the extension's Settings (typed in any case, spaces around it ignored: `redeem_invite` folds both sides, and the extension sends codes in upper case), and from then on makes codes for the salespeople, and for other managers, in the manager view: **Invite a salesperson** and **Invite a manager** in its Invite codes card call `create_invite`, which answers a 12-character upper-case code that works once, shown with a Copy button. The owner's SQL path stays for the first manager (the statement above), and a new one the same way if that code expires unused. The table itself is never readable through the API: a manager sees the dealership's open codes through `list_invites` and cancels one with `revoke_invite`, both in the manager view's Invite codes card, and a code is a secret you hand to one person.

   Invite codes and the rules around them (`0002_rls.sql`): a code works once and for 7 days; it also dies when its maker is no longer a manager of that dealership, and removing a member, or making a manager a salesperson, deletes the codes they made and nobody used (so a departing or demoted manager cannot keep a code to come back with). `redeem_invite` gives one answer, `that invite code is not valid` (code `P0002`, HTTP 400), for an unknown, used, expired or cancelled code, so a guess learns nothing, and after 10 misses in an hour it refuses that account with `too many attempts; try again in an hour` (`P0005`) before looking anything up. The misses are counted in `invite_misses`, which no API role can read or write. Because a raised error would roll the count back with the call, a miss is *answered* with status 400 and the same `{ code, message }` body PostgREST gives for an error; check once on the first deploy that a wrong code, tried eleven times, gets the `P0005` answer (it relies on PostgREST committing a call whose function set `response.status`). The CI job `stack` makes the same check against a local stack (`docs/stack-test.md`). The throttle's own `P0005` is raised, so it arrives with PostgREST's status for PL/pgSQL codes other than `P0001`, HTTP 500; the extension shows its sentence all the same.

   Managers may rename their dealership but not change its `website_origin` (a column-level grant): the origin is the key `/sync` matches on and it is unique, so changing it is the owner's job in SQL, as creating the row is.

   **A pilot of the length a signed pilot agreement names.** The manager's **Start the free pilot** (`start_pilot`) always gives `pilotDays` from `marketing/pricing.json`, the standard length in `legal/pilot-agreement.md`, and takes no length from the caller, so no manager can grant themselves a longer one. A dealership you create here sits in the `none` state, and its manager's Getting started card asks for **Start the free pilot**. When the signed agreement names another length, record the pilot yourself before the manager signs in, with the end date the agreement gives: the dealership then arrives on its pilot with that date, the Billing card shows it, and neither card offers **Start the free pilot**. The same statement with a later date extends a running or ended pilot by agreement (`PILOT.md`, "After two weeks"). It changes nothing for a dealership that has a Stripe subscription (no row comes back): its trial and billing are changed in Stripe.

   ```sql
   -- owner only: a free pilot that ends when the signed pilot agreement says, or a pilot extended by agreement
   insert into public.subscriptions as s (dealership_id, status, pilot_ends_at)
   values ('<the id returned above>', 'pilot', '<the agreed end with its UTC offset, for example 2027-01-31 23:59:59+00>')
   on conflict (dealership_id) do update
     set status = 'pilot', pilot_ends_at = excluded.pilot_ends_at, updated_at = now()
     where s.stripe_subscription_id is null
   returning dealership_id, status, pilot_ends_at;
   ```

6. **Check the deploy.** Fill `extension/src/accountConfig.js` and `manager/config.js` with the project URL and publishable (or anon) key, both at once with `npm run set-project -- <project URL> <key>`, then from the repository root:

   ```
   npm run check-deploy
   ```

   It looks at the project from the outside and prints a checklist: the config files name the same project, the anon key reads nothing from any table and cannot redeem a code (a table that answers 404 is missing, a migration not pushed, and fails), each function answers the extension's CORS preflight and refuses a call with no token, the billing webhook refuses an unsigned event, and the lead function refuses any page but the landing page (`LOTSYNC_SITE_ORIGIN=https://<where site/ is hosted>` checks its preflight too; `LOTSYNC_MANAGER_ORIGIN=https://<where the manager view is hosted>` checks billing's preflight from the manager view, which needs that address in `ALLOWED_ORIGINS`; without it that line is a note). With `LOTSYNC_TEST_TOKEN` set to the access token of a signed-in test account that belongs to no dealership (sign in once in the manager view and copy only the `access_token` field of the `sb-<project ref>-auth-token` entry in the browser's local storage, never the whole entry, which also holds the refresh token; set it in your own terminal, never in a chat, and sign that test account out afterwards; `docs/production-setup.md` step 7 has the commands), it also checks that `/sync` answers 403 and that eleven wrong invite codes end in `P0005`, which proves the throttle counts misses on the real PostgREST. It changes nothing but that test account's miss count, keeps nothing and prints no key.

   Each line reads `ok`, `FAIL` or `note`. At this step only `rewrite` and `sync` are deployed, so the lines of the two functions this README deploys later read `note` with `404, not deployed yet`: billing's preflight, no-token and webhook lines until "Billing" below, and the lead lines until "Demo requests" below; the manager view's billing preflight stays a note until `LOTSYNC_MANAGER_ORIGIN` is set, as "Billing" below does. Run it again after each of those sections: its lines then read `ok`, except the webhook line, which stays a note (`500, STRIPE_WEBHOOK_SECRET is not set yet`) until that secret is set. A line still marked `note` after its section is done is a step missed there. Exit code 0 means nothing failed; notes do not fail the run, and the last line says "Every check passed." only when there is no note either.

## Sign-in emails

Lot Current signs people in with no password, and both ways in come from one email: the extension asks for the six-digit code in it (`verifyOtp` in `extension/src/account.js`), and the manager page uses its link, in the PKCE flow, so the link works only in the browser that asked for it. The extension's request carries a PKCE challenge too, one nobody can answer (`unanswerableChallenge`), so the link in an email it asked for brings no token to the page it lands on. Both ask with `signInWithOtp`, and which of Supabase's templates answers depends on "Confirm email":

| | "Confirm email" off (`config.toml`: `enable_confirmations = false`) | "Confirm email" on (how a new hosted project starts) |
|---|---|---|
| An address's first sign-in | Magic link or OTP | Confirm sign up |
| Every sign-in after that | Magic link or OTP | Magic link or OTP |

Supabase's default emails carry only the link, so without Lot Current's templates a salesperson gets no code to type. Both are in `templates/`: `magic_link.html` and `confirmation.html`, each with the subject "Your Lot Current sign-in code": the code, large; the link; a line saying where each is used; that they work once, for one hour, and that a newer email replaces an older one; and "If you did not ask to sign in, ignore this email: nobody can sign in without it." `confirmation.html` adds that using either also confirms the address. They load nothing from anywhere and set no text or background colour (the code box's mid-grey border shows in light and dark), so a mail app's dark mode works; `test/emailTemplates.test.js` holds them to that, to each other, and to the code length and lifetime below.

**On a local stack** `config.toml` names both (`[auth.email.template.magic_link]` and `[auth.email.template.confirmation]`, a `subject` and a `content_path` each; the path starts at the folder that holds `supabase/`), and `supabase start` sends them. Nothing leaves the machine: the CLI's mail catcher shows every email at `http://127.0.0.1:54324`. `config.toml` sets no `otp_length` or `otp_expiry`, so the CLI's defaults apply: a 6-digit code that works for 3600 seconds, which is what the extension's code box and the emails say.

**On the hosted project** the templates are not read from `config.toml`: paste them in (Dashboard, Authentication, Email Templates):

- **Magic link or OTP** (older Dashboards: Magic Link): subject "Your Lot Current sign-in code", body `templates/magic_link.html`.
- **Confirm sign up** (older Dashboards: Confirm signup): subject "Your Lot Current sign-in code", body `templates/confirmation.html`.

Then, under Authentication, Sign In / Providers, Email, check that the email OTP length is 6 and the email OTP expiration is 3600 seconds; a change to either needs the same change in the extension's code box or in the emails' "one hour". `supabase config push` would send the templates too, but it sends the rest of `config.toml` with them, the local Site URL and rate limits included, so paste instead.

**The sender.** Supabase's built-in sender is for testing: it delivers only to the addresses of the project's own team, and only a few emails an hour. Before the first dealership, set up the owner's own SMTP provider (Authentication, Emails, SMTP Settings: host, port, user, password, sender address and sender name); it is a paid service and the owner's choice. Add the SPF and DKIM records the provider gives for the sending domain, and turn its link and open tracking off: Supabase's docs warn that tracking rewrites the sign-in link so it no longer works. `docs/launch-checklist.md` has both steps ("Paste the sign-in email templates into the hosted project", "Choose the sender") with their "done when".

**A known limit.** Some work mail systems may open the links in an email to scan them (Supabase's docs name Microsoft Defender's Safe Links). That uses the sign-in up before the manager clicks: the link then says it has expired, and the code in the same email stops working with it. If a manager's link always says so, that is the likely cause; the manager page has no box for the code yet.

## Environment variables

| Name | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | function secret | The Anthropic API key. The only place it exists. Without it `/rewrite` answers 500 and the extension uses its template. |
| `REWRITE_MODEL` | function secret | The model for both endpoints. Default `claude-haiku-4-5`; `claude-sonnet-5` for better prose at a higher price. |
| `MONTHLY_COST_CAP_USD` | function secret | Per dealership per calendar month (UTC), summed from `rewrite_usage`. Default 25. At the cap `/rewrite` and `/color` answer 429 with a plain sentence until the month turns. |
| `RATE_LIMIT_PER_MINUTE` | function secret | Calls per signed-in user per minute. Default 20. Counted in each function instance's memory, so with several instances a burst can exceed it by that factor; it is a brake, not a ledger. |
| `ALLOWED_ORIGINS` | function secret | Comma-separated page origins allowed to call the functions from a browser besides the extension's own `chrome-extension://` origin. The hosted manager view's origin must be in it (the same origin as `ALLOWED_RETURN_ORIGINS`), or its Billing card cannot call `/billing` at all; a local manager page during development is added after a comma. `LOTSYNC_MANAGER_ORIGIN=<the manager view's address> npm run check-deploy` checks it. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | set by Supabase | The functions read them; nothing to do. The service-role key is used only inside the functions and only for the writes a caller's own token may not make, with the reads that go with them: `rewrite_usage` (the rewrite function's usage log and monthly cap), `subscriptions` and `billing_events` in the billing function, with its lookup in `dealerships` for a Stripe event, which comes with no caller, and `demo_requests` in the lead function. With their own token a member may still read their own dealership's rows of `dealerships`, `subscriptions` and `rewrite_usage`; no caller's token reaches `billing_events` or `demo_requests` at all. `/sync`, the membership and plan checks and the billing status's seat count use the caller's own token. |

## How the extension is configured

A Settings section for the account (arriving with the UI wiring) takes the **project URL** and the **anon key** from step 1; both are safe to type into every salesperson's extension. Then:

1. **Sign in**: the salesperson enters their email and gets a link and a code. The session (a token, its refresh token, expiry, the user's id and email) is kept in `chrome.storage.local` under `account`, never in Chrome's synced storage; it stays on that computer. No password anywhere.
2. **Join the dealership**: they enter the invite code once (`redeemInvite`). The answer carries the dealership's name and website origin, which the extension stores next to its per-website settings.
3. **Sync**: after a scan, a post, a price update or a take-down, the extension POSTs `syncPayload(...)` to `.../functions/v1/sync` with the session's token and merges the answer (`mergeRegistry`, `mergeFlags`). Two salespeople then see the same posted registry, and the manager page sees both.
4. **Description writer**: in Settings, the rewrite service address becomes `https://<ref>.supabase.co/functions/v1/rewrite` and the key field is the session's token (the UI wiring fills it from the session; the shared `REWRITE_KEY` of `backend/` is gone). `extension/src/rewriter.js` already calls `<address>/rewrite` and `<address>/color` with `Authorization: Bearer <key>`.

## The two functions

Both take `Authorization: Bearer <the user's access token>` and a JSON body, and answer JSON with `ok`. Errors are `{ ok: false, error: "<a sentence>" }` with 400 (bad request), 401 (no valid token), 402 (the dealership's subscription has lapsed; the answer also carries `code: "lapsed"` and the `plan`, below), 403 (not a member), 404, 429 (rate limit or the monthly cap), 502/503 (the Anthropic API) or 500.

**`POST .../functions/v1/rewrite/rewrite`** (or the bare `/rewrite`): the body is the facts object `extension/src/rewriter.js` builds (`rewriteFacts`: year, make, model, trim, mileage, stock, features, carfaxOneOwner, carfax, colors, engine, transmission, drivetrain, fuelType, narrative, dealer { name, city }, salesperson { name, title }, priceNote). No VIN goes up; the extension adds the VIN line afterwards. The extension also sends the dealer website's `origin` with the facts (the function strips it before the prompt): it picks the dealership for a person who belongs to several, compared as `/sync` compares it (no trailing slash, no case), and an origin that matches none of their dealerships gets 403, so a sister store is never billed or capped for another store's cars; a body without an origin (an older extension) gets the first membership. A dealership whose plan has lapsed (the state machine under Billing, below) gets 402 `{ ok: false, error, code: "lapsed", plan }` on every route of the function, after the membership is picked and before the cost cap and the model call, so nothing is spent for a store that no longer pays; the row is read with the caller's own client, the way `/sync` reads it. Answer: `{ ok, text, model, guardrails: { ok, problems: [{ code, text }], words }, costUsd, error }`, the same as `backend/server.js`: `ok` is false when the draft failed the guardrails twice or the model declined, and the extension then shows its template.

**`POST .../functions/v1/rewrite/color`**: `{ photos: [up to 4 https addresses], options: [Facebook's color words], origin }`, the `origin` picking the store as it does for `/rewrite` (without it, a person in two dealerships would be billed and capped against whichever came first). Answer: `{ ok: true, exterior, interior, confidence, model, costUsd }` or `{ ok: false, error, costUsd }`.

**`GET .../functions/v1/rewrite/health`** (signed in): `{ ok, model, month, usd, capUsd, perMinute, dealership }`, the caller's dealership's spend this month.

**`POST .../functions/v1/sync`**: `{ origin, posted, known, pilot: { posts, flags }, scan, since, today }` as `syncPayload()` in `extension/src/sync.js` builds it: `origin` is the dealer website's origin; `posted` is the salesperson's own registry entries, whole (`{ [vin]: { name, price, postedAt, listingUrl?, salesperson?, updatedAt? } }`); `known` is the keys (`VIN@postedAt`, the time as ISO text) of the salesperson's own posts this machine sent or received listed at its last sync, kept in `sync:<origin>` (none on a first sync); `posts` and `flags` are the pilot's post attempts and to-do flags that changed since the last sync (all of them the first time); `scan` is `{ takenAt, cars, ready, takeDownCount, priceUpdateCount }` or null; `since` is the `serverTime` of the last answer or null; `today` is `{ from, to }`, two ISO stamps bounding the caller's local calendar day (the extension builds it from its clock; the function takes it only when both parse, `from` is before `to` and the span is at most 48 hours, `todayRange` in `functions/_shared/billing.mjs`). The function first reads the dealership's `subscriptions` row with the caller's own client (a member may read it; no service-role key) and, when the plan has lapsed, answers 402 `{ ok: false, error, code: "lapsed", plan }` and writes nothing. Otherwise it upserts the caller's listings (matched on VIN and posting time; another user's row or a taken-down row is never changed), marks as taken down the caller's listed rows whose key is in `known` and missing from `posted` (no time decides it: a post that reached the server from another of the salesperson's machines during or after this machine's last sync was never received here, so it is not in `known` and stays up, whatever its `created_at` or `postedAt` say; a request without `known` takes nothing down, because a missed take-down comes back into the registry and can be done again while a wrong one is final; an entry still in `posted` is never taken down), upserts the post attempts (VIN and start time) and the to-do items (VIN, kind and flagging time; closed by an upload, never reopened), stores the scan once, and answers `{ ok, serverTime, dealership: { id, name, websiteOrigin }, role, plan, postsToday, counts, listings, todoItems }`: every listing of the dealership that is up plus the ones taken down since 10 minutes before `since` (the last 90 days for a first sync), and every open to-do item plus the ones closed since then. `plan` is `{ state, pilotEndsAt, currentPeriodEnd, seats }` from the row (`planOf` in `functions/_shared/billing.mjs`, the same rule as `subscription_state()`; `state` is `none`, `pilot`, `active` or `lapsed`, and a dealership with no plan yet is served, since it is still onboarding). `postsToday` is the number of the caller's own listings rows, any status, whose `posted_at` falls in `today` (counted after the upload, so this call's posts are in it), or null when the request sent no usable `today`. The extension keeps both under `sync:<origin>`, and the daily cap takes the larger of its local count and the server's when the server's range covers the moment, so the cap holds per salesperson across that salesperson's machines. `serverTime` is the function's clock after the upload is written; the next call sends it back as `since`, and it only picks which take-downs and closed to-do items come back. The reads after it are separate requests: a take-down stamped just before it by another call can commit only after them, and a closed to-do item carries the closing machine's clock, so the answer looks back 10 minutes before `since`, longer than any request runs; a take-down or a closed item sent twice changes nothing in the extension (`mergeRegistry`, `mergeFlags`), and an entry the salesperson removes while a sync is out is not put back by that sync's answer. A user who is not a member of the dealership for that origin gets 403.

Limits on `/sync`, against one member flooding the dealership's tables (a real registry is a few hundred rows and a few tens of KiB): more than 12 calls by one user in a minute get 429 `too many syncs; try again in a minute` (counted per function instance, like `/rewrite`'s brake); a body over 512 KiB, or more than 2,000 listings, `known` keys, post attempts or to-do flags in one request, gets 400 and nothing is written. A listing stamped more than 5 minutes ahead of the server's clock is not written (`counts.rejected`): a stamp from the future would win every merge. A listing for a VIN that another member currently has up is not written either (`counts.conflicts`): a car is re-posted only by the person who has it listed, or after their row is taken down, so nobody's upload can push a colleague's live listing out of that colleague's registry. The extension keeps the same rule on its side: a colleague's newer row never replaces an entry the salesperson owns (`mergeRegistry`).

The pilot lists are the one place a client clock still meets `since`: `posts` and `flags` are chosen by their own stamps (`syncPayload` sends the ones that changed after `since`), so a clock running far behind can keep an attempt or a flag from going up until it changes again. That can cost a pilot number, never a registry entry, and it is left as is for now.

## Who can see and do what

Every table has row-level security on. In one line: a signed-in person sees their own dealership and nothing else; salespeople write their own rows; managers can change any row of their dealership; only managers delete; the anon key alone gets nothing. Managers change a member's role and remove members, from the manager view's Team card (a column-level grant: `name` and `role` only, never who or which dealership; the card has no rename, so a member's name is corrected by the owner in SQL, `docs/support.md`, "Privacy requests"); a dealership always keeps at least one manager (the `keep_a_manager` trigger answers `P0006` to anything that would leave none, even two managers stepping down at the same moment, because it locks the dealership row before it checks; deleting the dealership itself still cascades; through PostgREST the refusal arrives as HTTP 500 with `{ code: "P0006", message }`, and the manager view's Team card shows the sentence). A salesperson name, once stored on a listing or a post attempt, stays as stored through the API (the `keep_stored_salesperson` trigger), so a full sync cannot write an old name back over the owner's correction; an empty one may still be filled. The full list is in `migrations/0002_rls.sql`, each policy with a comment saying what it is for. The service role (inside the functions only) bypasses these, as it always does on Supabase.

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
  -f supabase/migrations/0004_billing.sql \
  -f supabase/migrations/0005_leads.sql \
  -f supabase/migrations/0006_privacy.sql \
  -f supabase/migrations/0007_signup.sql \
  -f supabase/migrations/0008_usage.sql \
  -f supabase/migrations/0009_cancel_at.sql \
  -f supabase/tests/rls.sql \
  -f supabase/tests/billing.sql \
  -f supabase/tests/privacy.sql \
  -f supabase/tests/signup.sql \
  -f supabase/tests/usage.sql \
  -f supabase/tests/concurrency.sql
```

Either way each file ends with `every check passed` and psql exits 0; a failed check prints the reason and exits non-zero. Never run the shim against a Supabase database; it only exists for Postgres without Supabase.

The two copies in `functions/_shared/` (the prompt and the guardrails) are checked against their originals with

```
node --experimental-strip-types supabase/tests/port-check.mjs
```

and `npm test` covers `extension/src/account.js` and `extension/src/sync.js`, and runs the four functions' real handlers under Node against a fake database, a fake Stripe and a fake Anthropic API (`test/fn-*.test.js`, `test/functions/`): each route's status codes, the order of its checks and its answer's fields, with no network.

The CI job `stack` then runs Lot Current against a real local stack (`supabase start`, the functions served with a test env file): the extension's own account and sync modules against the real `/sync`, the invite and sign-up throttles through the real PostgREST, the last-manager rule, the lead function and `npm run check-deploy` (`docs/stack-test.md`; `npm run test:stack` on a machine with Docker). The local gateway answers CORS preflights itself, so the functions' own CORS answers are checked by the unit tests and by `check-deploy` on the hosted project.

## What is stored

Only what the extension already keeps in the browser and the privacy policy names (`legal/privacy-policy.md`): the dealership, who belongs to it and as what, the posted registry (VIN, name, price, times, when the server first received the row, the listing link the salesperson saved, who posted), the to-do items, the post attempts (times and outcomes), scan counts, one row per rewrite call with its token counts and cost, and each self-serve sign-up attempt (the account, the time, and whether it made a dealership or found the website taken; below, "Self-serve sign-up"). No descriptions, no photos, no buyers, nothing from the Facebook account beyond the listing link. The fill records (which form fields could not be filled) stay in the browser. Deleting a dealership row deletes everything it owns.

## Demo requests (the landing page's form)

The landing page's **Request a demo** form posts to the `lead` function, which stores the request in `demo_requests` (PLAN.md M5, acceptance 2). Until it is set up the form opens the visitor's own mail app instead, so nothing is lost.

```
supabase secrets set LEAD_ORIGINS=https://<where site/ is hosted>
supabase db push                              # applies 0005_leads.sql
supabase functions deploy lead --no-verify-jwt
```

Then put `https://<ref>.supabase.co/functions/v1/lead` in `site/config.js` as `demoEndpoint`. Visitors are anonymous, so the function checks no token; instead the browser's Origin must be one of `LEAD_ORIGINS` (anything else gets 403 and no CORS header), a hidden honeypot field makes a bot's request look accepted while storing nothing, and two brakes slow a flood: one sender may send about 5 requests an hour per function instance (the address is hashed in that instance's memory and forgotten, never stored; instances do not share it, so it is a brake, not a lock), and the function stops accepting at about 200 in the past hour across every instance (a count, then the insert, so a burst can pass it by a few). Fields are trimmed and capped (`functions/_shared/lead.mjs`; the table's checks carry the same limits). A request keeps only what the visitor typed, the time and the page's origin: no address, no cookie, no tracking.

The per-sender brake trusts, in this order, `cf-connecting-ip`, then `x-real-ip`, then the rightmost `X-Forwarded-For` entry (the one the nearest proxy appended), and never the leftmost, which the client writes (`clientAddress` in `functions/_shared/lead.mjs`). Which of these Supabase's gateway overwrites is not documented, so confirm it on the first deploy: six requests from the landing page's origin, each claiming a different address in all three headers, with an empty form so nothing is stored,

```
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<ref>.supabase.co/functions/v1/lead \
    -H 'Origin: https://<where site/ is hosted>' -H 'Content-Type: application/json' \
    -H "cf-connecting-ip: 192.0.2.$i" -H "x-real-ip: 192.0.2.$i" -H "X-Forwarded-For: 192.0.2.$i" -d '{}'
done
```

should print `400` five times and then `429`: the brake keyed on an address the platform wrote. A sixth `400` means a header the client wrote reached the brake (or the requests met two instances: run it once more); then vary one header at a time to find the one the platform overwrites, put it first in `clientAddress`, and pin that order in `test/lead.test.js`. The brake is per instance, so this uses up your own 5 for the hour on that instance only.

The loop cannot tell a brake keyed per visitor from one keyed on something every visitor shares (the gateway's own hop at the right of `X-Forwarded-For`, or no header at all, which is the key `unknown`): both print `400` five times and then `429`. So, right after it, send one request from a different network (a phone on mobile data, say) with no address headers:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<ref>.supabase.co/functions/v1/lead \
  -H 'Origin: https://<where site/ is hosted>' -H 'Content-Type: application/json' -d '{}'
```

It must print `400`. A `429` means every visitor shares one key, and the first five mistakes of the hour would turn every visitor away: change the order in `clientAddress` before the landing page goes live.

Then `npm run check-deploy` with `LOTSYNC_SITE_ORIGIN` set (step 6): both lead lines now read `ok`.

Reading them: Dashboard, Table editor, `demo_requests`, newest first; set `handled_at` when you have answered one. To get an email for each new request, add a database webhook (Database, Webhooks) on inserts into `demo_requests` pointing at your mail service; no API role, the anon key included, can read the table, so the page itself never shows one back.

## What replaces backend/ and when

`functions/rewrite` is `backend/server.js` moved behind real accounts: the same two endpoints, the same guardrails, the same model and cost table, but a per-user token instead of one shared key, and a cost cap per dealership instead of one for the whole service. The prompt and the guardrails are copies (not imports, since the function is its own bundle) kept equal by `tests/port-check.mjs`.

`backend/` stays until the first dealership is signed in through the extension and its rewrite address points at the function; then `backend/` can go (the README, CLAUDE.md and the Settings copy that mention it change with it). During the pilot both can run: a salesperson without an account keeps using `backend/` with the shared key; one with an account uses the function.

## Billing (Milestone 5)

Billing runs on Stripe: a subscription per rooftop per month, a free pilot period a manager starts without a card, and Stripe's own Billing Portal for the card, the invoices and cancelling. What is in the repo is code the owner deploys; nothing in it is switched on, and nothing charges anyone until the owner creates the Stripe objects below and sets the secrets. The prices are the ones in `marketing/pricing.json`, which stays a hypothesis until a dealer pays.

| Path | What it is |
|---|---|
| `migrations/0004_billing.sql` | `subscriptions` (one row per dealership: the pilot or the Stripe status), `billing_events` (every webhook event once), `subscription_state()` and `start_pilot()`, RLS. |
| `functions/billing/` | `/checkout`, `/portal`, `/status` behind sign-in, `/webhook` behind Stripe's signature. Talks to Stripe's REST API with `fetch`; no SDK. |
| `functions/_shared/billing.mjs` | The pure parts, plain JavaScript so Node tests them: the state machine, the line items, the form encoding, what each event does to the row, the signature check. |
| `tests/billing.sql` | Proves the pilot rules, the wall between dealerships and who may read and write a scheduled cancellation against a running database (same recipe as `rls.sql`, with `0004_billing.sql` and `0009_cancel_at.sql` added to the list). |
| `test/billing.test.js` | The unit tests, in `npm test`. |

### What to create in Stripe, once

`npm run stripe-setup` makes steps 1 to 3 from `marketing/pricing.json` and checks them on every later run (`scripts/stripe-setup-lib.mjs`; the owner's walk-through is `docs/stripe-setup.md`): it reads the secret key from the environment, refuses a live key without `--live`, creates only with `--apply`, and prints the `supabase secrets set` lines for the ids, `STRIPE_PORTAL_CONFIGURATION` included. By hand instead:

In the Stripe Dashboard, in **test mode** first (the toggle at the top; everything below exists separately in test and live mode):

1. **A product** called Lot Current, with two recurring monthly prices, the planned amounts from `marketing/pricing.json`:
   - the rooftop price: `perRooftopMonthly` per month, quantity 1 per dealership (`includedSalespeople` salespeople are included in it);
   - the extra-seat price: `extraSalespersonMonthly` per month, quantity = seats above the included count.

   Note each price's id (`price_...`). The founding-dealer rate (`foundingDealerMonthly` for `foundingDealerMonths` months, the first `foundingDealerCount` stores) is not a third price: Checkout has promotion codes switched on, so the owner creates a coupon with that discount and a code, and hands the code to the dealer. The pilot period is not a Stripe trial either; it lives in the database (below).

2. **The Billing Portal configuration**: Settings, Billing, Customer portal. Turn on updating the payment method, viewing invoices and cancelling; save. Without a saved configuration the `/portal` route gets an error from Stripe saying so.

3. **A webhook endpoint** pointing at `https://<ref>.supabase.co/functions/v1/billing/webhook`, subscribed to these five events and no others: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Note its signing secret (`whsec_...`).

4. The **secret key** from Developers, API keys (`sk_test_...` in test mode, `sk_live_...` in live mode). It only ever goes into the function secrets.

Then the secrets and the function:

```
supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_PRICE_ROOFTOP=price_... STRIPE_PRICE_SEAT=price_...
supabase secrets set ALLOWED_RETURN_ORIGINS=https://<where the manager page is served>
supabase secrets set ALLOWED_ORIGINS=https://<where the manager page is served>
supabase db push                                # applies 0004_billing.sql and 0009_cancel_at.sql
supabase functions deploy billing --no-verify-jwt
```

`--no-verify-jwt` (or a `[functions.billing]` block with `verify_jwt = false` in `config.toml`, like the other two functions) is required: Stripe's webhook carries no Supabase token, and the function checks the caller's token itself on the other three routes.

Then `npm run check-deploy` again (step 6), with `LOTSYNC_MANAGER_ORIGIN` set to the manager view's address: the billing lines now read `ok`, the webhook's once `STRIPE_WEBHOOK_SECRET` is set and the manager view's preflight once its origin is in `ALLOWED_ORIGINS`.

### Environment variables

| Name | Where | Meaning |
|---|---|---|
| `STRIPE_SECRET_KEY` | function secret | Stripe's secret API key. Only the billing function has it; it goes out only as the bearer on calls to `api.stripe.com`, and it is never logged or answered. |
| `STRIPE_WEBHOOK_SECRET` | function secret | The webhook endpoint's signing secret. Every event's `Stripe-Signature` header is checked against the raw body (HMAC-SHA256, five-minute tolerance) before anything is read from it. |
| `STRIPE_PRICE_ROOFTOP` | function secret | The rooftop price id. Without it `/checkout` answers 500 naming the variable. |
| `STRIPE_PRICE_SEAT` | function secret | The extra-seat price id. Needed only when a dealership asks for more seats than the included count; `/checkout` says so if it is missing then. |
| `STRIPE_PORTAL_CONFIGURATION` | function secret, optional | The Billing Portal configuration (`bpc_...`) `/portal` opens, as `npm run stripe-setup` made it. Unset, Stripe uses the account's default portal settings, which exist only once someone has saved them in the Dashboard (step 2 above). |
| `STRIPE_AUTOMATIC_TAX` | function secret, optional | The word `true` turns on Stripe Tax for new Checkouts: Checkout asks for the billing address, saves it on the customer and adds the tax. Anything else leaves tax off. Set it only once the attorney has said what to collect and Stripe Tax has the registrations (`docs/stripe-setup.md`, live mode). |
| `ALLOWED_RETURN_ORIGINS` | function secret | Comma-separated origins (scheme and host) Stripe may send the manager back to after Checkout or the portal. The request's `returnUrl` must sit on one of them or `/checkout` and `/portal` answer 400. Until it is set, neither route works. Add the same origin to `ALLOWED_ORIGINS` so the page may call the functions at all. |

### The routes

All three signed-in routes take `Authorization: Bearer <the user's access token>` and pick the dealership from `dealershipId`, from `origin` (the dealer website's origin), or, for a person in one dealership, from nothing.

**`POST .../functions/v1/billing/checkout`** (managers): `{ returnUrl, seats?, dealershipId? | origin? }`. Creates the dealership's Stripe customer if it has none (name, the manager's email, `metadata.dealership_id`), then a Checkout Session in subscription mode with the rooftop price and, above the included count, the seat price times the extra seats, `success_url` and `cancel_url` = `returnUrl` with `?billing=success` or `?billing=canceled`. During a running pilot with more than 48 hours left, the subscription starts as a trial ending when the pilot does, so the card is charged at the end of the free period and not at checkout. Answers `{ ok, url }`: the page sends the manager to `url`. 409 when the dealership already has an active subscription (the Billing Portal updates its card or cancels it; seats are changed by hand, below, "Adding seats to a running subscription"), and 409 `{ ok: false, error: "update the card in Manage billing; the subscription is still open", code: "open-subscription" }` while Stripe still holds the dealership's subscription open (trialing, active, past_due, unpaid, incomplete, paused): a lapsed card is updated in the portal and Stripe retries the open invoice, whereas a second Checkout would open a second subscription on the same customer (`checkoutRefusal` in `functions/_shared/billing.mjs`).

**`POST .../functions/v1/billing/portal`** (managers): `{ returnUrl, dealershipId? | origin? }`. A Billing Portal session for the dealership's customer; answers `{ ok, url }`. 404 until a checkout has created the customer, and 404 with "Stripe has no billing account for this dealership any more (one made while billing was in test mode does not carry over): ask your Lot Current contact" when Stripe no longer has the customer on the row (deleted, or made with a test-mode key the function no longer has); the row is left as it is (`docs/stripe-setup.md`, "switching to live mode", step 5 resets it).

**`GET .../functions/v1/billing/status?dealershipId=|origin=`** (any member): `{ ok, dealership, role, state, subscription, canStartPilot, canSubscribe, canManageBilling, pilotDays, includedSalespeople, salespeople, testMode }`. `testMode` is true while `STRIPE_SECRET_KEY` is a test-mode key (`sk_test_` or `rk_test_`; only its mode is read), and the Billing card then says "Billing is in Stripe test mode: only Stripe's test cards work, nothing is charged, and a subscription started now does not carry over when real billing starts." to everyone. `state` is one of the four words below; `subscription` is the row or null. `salespeople` is how many members take a seat now: the members with the salesperson role, each person once (`seatCount` in `functions/_shared/billing.mjs`; `marketing/pricing.json`, the sales sheet and Schedule A of the subscription agreement price salespeople, never a manager). It is counted for a manager's call, with the caller's own client, so row-level security decides what is read; a salesperson's call is not counted and gets `null` (row-level security shows a salesperson only their own membership), and a failed count is `null` while the rest of the answer stands. The status never calls Stripe and changes nothing. The manager page's Billing card reads it; the extension learns the same plan from `/sync`.

**`POST .../functions/v1/billing/webhook`** (Stripe only): verifies the signature, records the event in `billing_events` once (a redelivery of a recorded event is acknowledged and not applied again), and on the five subscribed events updates the dealership's row with the service-role client. Which row: the one carrying the customer or subscription id, else the `dealership_id` Checkout wrote into the subscription's metadata, else the customer's metadata. An event about a customer that is not a Lot Current dealership is recorded and left alone. An event about another subscription than the row's is ignored (an old subscription's dunning retries or final delete never flip a store that has moved on), except `customer.subscription.created` newer than the row's last change on a row whose subscription is over (canceled, incomplete_expired) or that never had one; invoice events count only for the row's own subscription. A database failure answers 500 so Stripe retries (it does, with backoff, for up to three days); an older event never overwrites a newer one for the same subscription (Stripe does not deliver in order).

### The state machine

`subscription_state(dealership_id)` in SQL and `subscriptionState(row, now)` in `billing.mjs` give the same word from the row; `tests/billing.sql` and `test/billing.test.js` hold both to it.

| State | When | What the product does with it |
|---|---|---|
| `none` | No row, or a row with only a customer id (a checkout opened and not finished). | Everything works (a dealership with no plan yet is still onboarding); the manager page offers "Start the free pilot" and "Subscribe". |
| `pilot` | `pilot_ends_at` is in the future and nothing is paid. Stripe's word does not matter meanwhile: the free period was promised. | Everything works; the page shows the end date and "Subscribe". |
| `active` | Stripe says `trialing` (a subscription whose first charge waits for the pilot to end) or `active`. | Everything works; the page shows the paid-through date, seats, and "Manage billing". |
| `lapsed` | Everything else: the pilot ended unpaid, `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`. | The page says so and offers "Subscribe" (and "Manage billing" when a customer exists). `/sync` and `/rewrite` answer 402 with `code: "lapsed"` and the plan and do nothing else: syncing and the description writer stop until a manager renews. The billing routes are never gated, so renewing always works. |

The row: `status` (`pilot`, or a Stripe status, or null), `pilot_ends_at`, `current_period_end`, `seats` (the included count plus the seat price's quantity, copied from Stripe by the webhook; the Billing card shows it against the salespeople, and nothing in Lot Current changes it in Stripe), `cancel_at` (when Stripe will end a subscription whose cancellation the dealership scheduled in the Billing Portal, which cancels at the end of the paid period and keeps the status `trialing` or `active` until then: Stripe's `cancel_at`, or the period end when it sends only `cancel_at_period_end`; null otherwise, written on every subscription event so undoing the cancellation clears it; `0009_cancel_at.sql`), `stripe_customer_id`, `stripe_subscription_id`, `updated_at`.

### How the free pilot starts

The manager, signed in, calls `start_pilot(<dealership id>)` (PostgREST: `POST /rest/v1/rpc/start_pilot` with `{ "dealership_id": "..." }`, or `supabase.rpc('start_pilot', { dealership_id })` from the manager page). No card, no Stripe object: the row gets `status = 'pilot'` and `pilot_ends_at` = now plus `pilotDays` from `marketing/pricing.json`. Only a manager of that dealership may call it; it starts the pilot once and never restarts it (a second call, or a call on a dealership that pays or already had its pilot, answers with the standing unchanged and `started: false`). The answer is `{ dealership_id, started, status, pilot_ends_at, state }`.


### Adding seats to a running subscription

Nothing in Lot Current changes a subscription's seats; the webhook only copies what Stripe says. When a manager asks for more, in the Stripe Dashboard open the dealership's customer, its subscription, **Update subscription**, add the seat price or raise its quantity to the salespeople above the included count, and choose whether to prorate; `customer.subscription.updated` then sets `seats` and the card's warning goes away. The Billing Portal is not the place: it is configured (Stripe step 2 above) to update the card, show invoices and cancel, not to change a subscription, so a manager cannot change seats there. If you ever turn subscription updates on in the portal, `SEATS_NOT_ADDED` in `manager/data.js` can point at **Manage billing** instead.

### The manager page's Billing card

The manager view (`manager/`) has a Billing card fed by `GET /billing/status?dealershipId=<the dealership's id>`, once `billing: true` in `manager/config.js` says the function is deployed with its secrets and the page's address is in `ALLOWED_ORIGINS` (`docs/stripe-setup.md` step 5). Until then the page calls no billing route: it reads the dealership's `subscriptions` row and `subscription_state()` as any member may. **Start the free pilot** still shows for a manager when `pilotAvailable` would allow it (it calls `start_pilot()` in the database, not the function), and **Subscribe** and **Manage billing** do not. The card adds "Paying by card is not open yet, so nothing is charged; to carry on after the free pilot, ask your Lot Current contact." under no plan and a running pilot (one the owner recorded shows its end date), a lapsed plan adds "Billing is not open yet: ask your Lot Current contact.", and Getting started's first step reads **Start the free pilot**. One line says where the dealership stands, and the buttons are the ones the answer allows (`canStartPilot`, `canSubscribe`, `canManageBilling`; salespeople see the line and no buttons):

| State | The line | The buttons |
|---|---|---|
| `none` | "No plan yet. Start the free pilot: `pilotDays` days, `includedSalespeople` salespeople included, no card." (a salesperson reads "A manager can start") | **Start the free pilot**, **Subscribe** |
| `pilot` | "Free pilot: N days left (ends `pilot_ends_at`)." and, for a manager, that subscribing now is first charged when the pilot ends | **Subscribe** |
| `active` | "Subscribed: `seats` seats, renews `current_period_end`." ("first charge" while Stripe reports `trialing`). Once it is cancelled in the portal (Stripe keeps it `trialing` or `active` until the end, and the webhook records the date it ends in `cancel_at`), the pill says Cancelled and the line "Cancelled: `seats` seats, ends `cancel_at` and does not renew." ("before the first charge" while `trialing`), with "Manage billing can renew it." | **Manage billing** |
| `lapsed` | "The subscription has lapsed; salespeople can still post, but nothing syncs and the description writer is off until it is renewed." plus why (the payment failed, it was cancelled or paused, or the free pilot ended on a date). While Stripe still holds the subscription open (`past_due`, `unpaid`, `incomplete`, `paused`) it adds what renews it, for a manager: after a failed payment "Update the card with Manage billing; syncing starts again once Stripe takes the payment.", after a pause or an unfinished first payment Manage billing or the Lot Current contact; Getting started's first step says the same instead of "subscribe" | **Subscribe** once the subscription is over (cancelled, expired, or the free pilot ended), and **Manage billing** when a Stripe customer exists |

A manager also reads the seats under the line: "N salespeople; the plan includes M." (`salespeople` and `includedSalespeople` from the status; a salesperson gets no seat line). Next to **Subscribe** it says how many seats Subscribe asks for, and that Checkout shows the price before you pay: the status carries no price, so the card shows none. While subscribed, when there are more salespeople than `seats`, a warning says "N salespeople and S seats paid for. Lot Current never adds seats or changes what you pay on its own: to add seats, ask your Lot Current contact."

What each button calls: **Start the free pilot** runs `supabase.rpc('start_pilot', { dealership_id })` and re-reads the status. **Subscribe** POSTs `{ returnUrl, dealershipId, seats }` to `/billing/checkout` (`seats` is the status's `salespeople`, never fewer than `includedSalespeople`: `billingBody` in `manager/data.js`) and sends the browser to the `url` in the answer (Stripe Checkout); back on `?billing=success` the page re-reads the status, which the webhook has by then usually updated, and on `?billing=canceled` it says nothing was charged. **Manage billing** POSTs `{ returnUrl, dealershipId }` to `/billing/portal` and sends the browser to its `url` (Stripe's Billing Portal). `returnUrl` is the page's own address with `?dealership=<id>` (so a manager of more than one dealership comes back to the one they paid for, and the note lands on its card), which must sit on an origin in `ALLOWED_RETURN_ORIGINS`.

### Testing with Stripe's test mode and the CLI

Everything above in test mode uses test keys and test cards (`4242 4242 4242 4242`, any future date, any CVC; `4000 0000 0000 0341` attaches and then fails the payment, which is how to see `past_due` arrive). With the Stripe CLI:

```
stripe login
stripe listen --forward-to https://<ref>.supabase.co/functions/v1/billing/webhook
```

`listen` prints a signing secret of its own (`whsec_...`); while it runs, set that as `STRIPE_WEBHOOK_SECRET` (and set the endpoint's own secret back afterwards). Then `stripe trigger customer.subscription.created` and the other four event names send test events through; the function's log (Dashboard, Edge Functions, billing, Logs) shows each one recorded and, when the customer belongs to a dealership, applied. A triggered event's customer belongs to no dealership, so it is recorded and not applied; to see a row change, complete a real test-mode checkout from the manager page (or from `curl` with a manager's token) and watch `subscriptions` in the Table editor.

The `psql` command under "Run the RLS test" runs `tests/billing.sql` too; its last line is `billing.sql: every check passed`.

### What is stored

`subscriptions`: the ids Stripe gave the dealership's customer and subscription, the status, the dates and the seat count. `billing_events`: each webhook event as Stripe sent it (ids, statuses, amounts, the billing email; Stripe never sends a card number). The privacy policy already names billing details and Stripe as the processor. Deleting a dealership row deletes its subscription row; `billing_events` keeps the accounting trail, which is what the retention line of the privacy policy allows.

Pricing is a hypothesis until a dealer pays: the amounts in Stripe are copied from `marketing/pricing.json` by hand, and the first paying dealer is the moment to revisit that file, the sales sheet and the prices in Stripe together.

## Self-serve sign-up

Until you open it, a dealership exists because you created it (step 5). `migrations/0007_signup.sql` adds the other way in, for PLAN.md M5 ("a new dealer can subscribe, start a pilot period and manage billing without help"): a signed-in person creates a dealership and becomes its first manager. It is **off** until you open it.

| Path | What it is |
|---|---|
| `migrations/0007_signup.sql` | `signup_settings` (one row: `open`, `per_account`, `per_day`), `signup_attempts` (one row per sign-up that looked up its website), `website_origin_of(address)` and `create_dealership(name, website, your_name)`. |
| `tests/signup.sql` | Proves it against a running database (same recipe as `rls.sql`, with `0007_signup.sql` in the list); its last line is `signup.sql: every check passed`. |
| `test/signup.test.js` | Holds the source to the order of the checks, the lock and the grants, and `tests/signup.sql` to every case of the fixture, in `npm test`. |
| `test/fixtures/website-origins.json` | The website-address rule as a table, the contract for both copies: `website_origin_of` here and `websiteOrigin()` in `manager/data.js`. |

### Open it, close it, change the limits

**Before you open it:** a dealership started here has signed nothing. Neither the manager view nor Stripe Checkout shows or records acceptance of the Terms, the Privacy Policy or the Dealer Subscription Agreement yet, and that agreement's section 2 is the dealer's written authorisation to read its website. Keep sign-up closed until the attorney has answered `legal/questions-for-attorney.md` question 9 and the manager view records each manager's acceptance the way that answer says (`docs/launch-checklist.md`, "Self-serve sign-up stays closed until a manager's acceptance is recorded"). Until then create each dealership yourself (step 5) once it has signed the Pilot Agreement or the Dealer Subscription Agreement.

In the Dashboard's SQL editor. No API role can read or change `signup_settings`, the service role included; only you, in SQL:

```sql
select * from public.signup_settings;                -- where it stands
update public.signup_settings set open = true;       -- open sign-up
update public.signup_settings set open = false;      -- close it; dealerships already made stay
update public.signup_settings set per_account = 1;   -- dealerships one account may ever start this way
update public.signup_settings set per_day = 10;      -- new dealerships across everyone in the past 24 hours
```

The values shown are the defaults. Then set `selfServeSignup: true` in `manager/config.js`, so the manager view shows the form, and `signupUrl` in `site/config.js` to the manager view's address, so the landing page shows **Start a free pilot** (empty it again when you close sign-up). The page setting only shows or hides the form; the database switch is the real gate. With `open` false every call is refused, whatever the page shows, and with `open` true any signed-in person can call `create_dealership` through the API, form or no form. Turn both on together, and both off.

### What a person sees

In the manager view, with `selfServeSignup` true, a signed-in person who belongs to no dealership gets a **Start your dealership** form: the dealership's name, its website and their own name. It calls `supabase.rpc('create_dealership', { name, website, your_name })` (PostgREST: `POST /rest/v1/rpc/create_dealership`). The names are trimmed; the website is kept as its origin, the key the extension syncs under: `https://` when no scheme is typed, the host in lower case, no path, no default port (`website_origin_of`, whose rules are in the fixture). The answer is `{ dealership_id, name, website_origin, pilot_ends_at }`: the person is now its manager, and its free pilot has started (`start_pilot`, called by `create_dealership` itself), so a dealership that signs itself up is on the pilot's clock from its first day and lapses at the pilot's end unless someone subscribes. The manager then does everything a manager does: **Subscribe** in the Billing card, the invite codes for salespeople and other managers (`create_invite`), the Team card. Salespeople join as before, with a code.

### The refusals

Checked in this order, each before the next, so a refusal says nothing about what a later check would have found:

| Code | When | The message |
|---|---|---|
| `42501` | Nobody is signed in. (The anon key cannot call the function at all.) | sign in first |
| `P0008` | Sign-up is not open. | sign-up is not open: you join Lot Current with an invite code, from Lot Current or from your dealership's manager |
| `P0005` | This account made 5 attempts in the past hour: dealerships made, or websites found taken. | too many attempts; try again in an hour |
| `22023` | A field is not usable: the dealership's name (1 to 120 characters) or the person's (1 to 80), trimmed, holds a line break or other control character or is the wrong length, or the website is one `website_origin_of` refuses (an IP address, localhost, a port, a user name, anything but a plain web address) or has a host longer than the 253 characters DNS allows. | names the field: "the dealership's name must be ...", "the website must be ...", "your name must be ..." |
| `P0010` | This account already started `per_account` dealerships this way. | this account has already started a dealership; a second one is set up by Lot Current: write to Lot Current support |
| `P0011` | `per_day` dealerships started in the past 24 hours, across everyone. | no more new dealerships can start today; try again tomorrow, or write to Lot Current support |
| `P0009` | The website already has a dealership (its stored origin compared without case, spaces or trailing slashes, as `/sync` compares it). | that website already has a Lot Current dealership: ask its manager for an invite code (if nobody there uses Lot Current, write to Lot Current support) |

Each reaches the page as `{ code, message }`, the call's `error` in supabase-js. The raised ones get the status PostgREST gives their code: 400 for `22023`, 500 for `P0008`, `P0010` and `P0011` (its rule for PL/pgSQL codes other than `P0001`); the page reads the sentence, never the status. `P0005` and `P0009` are answered rather than raised, the way `redeem_invite` answers a miss: the function sets status 400 and returns the body PostgREST gives a raised error, so the attempt row a taken website writes is kept and the throttle counts it (a raised error would roll it back with the call). Check once on the first deploy, as for the invite throttle, that PostgREST commits such a call: with a test account, ask six times in a row for a website that is already a dealership; the first five answers are `P0009` and the sixth is `P0005`. They make no dealership, and after an hour they no longer count against the test account.

The two limits are counted with the `signup_settings` row locked, so sign-ups go through that step one at a time: two at the same moment cannot both pass a limit that has room for one, and the second sees the first one's website. The hourly throttle is counted there again: calls from one account sent together all pass its first count before any of them has written its attempt, and the second count holds them to 5 lookups an hour.

**What `P0009` gives away.** It tells anyone who is signed in that a website already has a Lot Current dealership, so a stranger can learn whether a store is a customer. That is accepted: the person needs to know where to go (the manager there, or support when nobody there uses Lot Current), and the probing is limited. The throttle allows 5 attempts an hour per account and is checked before anything is looked up; an account that has started a dealership is refused by `per_account` before any website is looked up; and making many accounts is held back by the sign-in email limits (step 3). The attempt row keeps no link to the dealership that was asked about.

### Why per_day, and what it bounds

Every new dealership can start a free pilot, and during it the description writer (`/rewrite`) calls the Anthropic API on Lot Current's bill. `MONTHLY_COST_CAP_USD` caps that per dealership per calendar month, not in total, so the most an open sign-up can cost grows with the number of dealerships made, and a flood of made-up accounts would make many. `per_day` is what bounds that number: at most that many new dealerships in any 24 hours, however many accounts someone has. At the defaults, a month of sign-ups at the limit is 10 a day, about 300 dealerships, each able to spend up to its cap every month it is served. Each of them is on its pilot from the day it is made, and when the pilot ends unpaid it lapses and `/rewrite` answers 402. The cap starts again when the UTC calendar month turns, so a made-up dealership can spend up to its cap in each month its 30-day pilot touches: twice the cap for a pilot that crosses the end of a month, as nearly every one does, and at most three times `MONTHLY_COST_CAP_USD` for one that starts at the very end of January and so runs through all of February. (A dealership you create yourself in SQL can sit in the `none` state, which `/sync` and `/rewrite` serve as onboarding with no end date; that is yours to watch.) Read the usage report (the "Usage report" section) while sign-up is open, and lower `per_day` or close sign-up if it shows dealerships nobody runs.

### Your SQL stays the way in

While sign-up is closed, step 5 (a dealership row and a first-manager code) is how a dealership starts. It stays the way to give an account a second dealership (`P0010`), to let a dealer in on a day `per_day` is used up (`P0011`), and to sort out a website that was taken by someone who does not run the store (`docs/support.md`, "A website is already taken").

### What is stored

`signup_attempts`: for each call that got as far as looking up its website, the account, the time, and whether it made a dealership (with that dealership's id) or found the website taken (with none). A row stays as long as the account: `per_account` counts the account's made ones forever, even after the dealership is deleted, when the row loses the dealership's id. `forget_person` removes an account's attempts with the account, and `export_dealership` includes the time and outcome of the dealership's own sign-up, not the account (below). `signup_settings` is the switch and the limits, nobody's data.

## Export or delete a dealership's data

The privacy policy (`legal/privacy-policy.md`) says a customer can ask for its dealership's records to be exported or deleted, that a person can ask for their own data to be deleted, and that a dealership's records are deleted within 30 days of its subscription ending. `migrations/0006_privacy.sql` gives the owner three functions for it. Who may ask for what, and how a request is verified, is in `docs/support.md` ("Privacy requests"); this section is what to run once it is.

| Path | What it is |
|---|---|
| `migrations/0006_privacy.sql` | `export_dealership`, `delete_dealership`, `forget_person` and their helper `billing_events_of`, each with a comment saying what it reads, deletes and keeps. |
| `tests/privacy.sql` | Proves them against a running database: the export holds every row of one dealership and nothing of another, no API role can call them, a wrong confirm changes nothing, the right one deletes only what it should. |
| `test/privacy.test.js` | Holds the source to those rules and this section to the functions, in `npm test`. |

The functions run only as the owner, in the Dashboard's SQL editor (it connects as `postgres`). Execute is revoked from `public`, `anon`, `authenticated` and `service_role`, so no key, no signed-in user and no Edge Function can call them. They are `SECURITY INVOKER`: they can do only what the caller's own role may do.

**One number: 30 days.** Finish every request within 30 days of verifying it, the same 30 days the policy gives for deleting a dealership's records after its subscription ends. The first reply still goes out within one business day, like every support request.

### Find the dealership and its people

```sql
select d.id, d.name, d.website_origin, m.role, m.name as member_name, m.user_id, u.email
from public.dealerships d
left join public.memberships m on m.dealership_id = d.id
left join auth.users u on u.id = m.user_id
where public.website_origin_of(d.website_origin) = public.website_origin_of('<the dealer website''s address>')
order by m.role, m.name;
```

This is also how a manager's request is verified: the address it came from must be the `email` on a `manager` row of that dealership.

### Export: a manager asked for a copy

```sql
select jsonb_pretty(public.export_dealership('<dealership id>'));
```

The answer is one JSON document: `dealership`, then one list per table (`memberships` with each member's account email, `listings`, `todo_items`, `scan_summaries`, `post_attempts`, `rewrite_usage`, `invites`, `subscriptions`, `billing_events`, and `signup_attempts`: when the dealership was started through self-serve sign-up, the time and outcome only), `counts` per list, and `notes` that say what is in it. Left out on purpose: the code of an unused invite (it may still let someone join, and a file gets forwarded; managers see their open codes in the manager view), which account signed the dealership up (that is the account's record, not the dealership's: it stays with the account after the dealership is deleted and goes when the person is forgotten), the emails of people who are no longer members, `invite_misses` (per account, not per dealership) and `demo_requests` (a visitor's, not the dealership's). What lives only in the salespeople's browsers (Settings, the Numbers tab, which form fields could not be filled) is not in the database, so it is not in the export.

To hand it over, save the answer as `<dealership>-export-<yyyy-mm-dd>.json`: copy the cell from the SQL editor, or write the file with `psql` and the connection string the Dashboard's **Connect** button shows:

```
psql "<connection string>" -At -c "select jsonb_pretty(public.export_dealership('<dealership id>'))" > export.json
```

Send it as a reply to the verified manager's address and to no one else, then delete your copy. The support log records that it was sent and its `counts`, never the file.

### Delete: a manager asked, or 30 days after the subscription ended

1. If they asked for a copy too, export first: the delete cannot be undone.
2. Run it with the id and the website origin from the lookup above:

   ```sql
   select public.delete_dealership('<dealership id>', 'https://www.<the dealer website>');
   ```

   The second argument must be the dealership's `website_origin` exactly as stored: copy it from the lookup above, which shows it as it is. Anything else is refused with `P0007` and nothing is deleted, so an id pasted from the wrong row cannot take the wrong dealership. The dealership row goes, and the foreign keys' `on delete cascade` takes every row it owns: memberships (the last manager's too: `keep_a_manager` lets a dealership's own deletion through), listings, to-do items, scan summaries, post attempts, rewrite usage, invites and the subscription row. The sign-up attempt that created the dealership, if it was started through self-serve sign-up, stays with its account without the dealership's id, so that account's `per_account` still counts it. The answer counts what went (`removed`) and names what stayed: the `billing_events` kept as the accounting record (the policy keeps billing records for accounting), the `stripe_customer_id`, and `accounts_without_a_dealership`, the members who now belong to no dealership.
3. **Stripe, separately.** Nothing in the database reaches Stripe. In the Stripe Dashboard (live mode for a real dealership), open Customers, find the `stripe_customer_id` from the answer and delete the customer. Deleting a customer also cancels any subscription still open on it, so the dealership is not charged again.
4. **The people.** The accounts in `accounts_without_a_dealership` can still sign in and see nothing. When the request covers the dealership's people (a store that leaves usually means it does; ask when the request does not say), forget each one with `forget_person` below, with the email the answer gives as the confirm. Someone who also belongs to another Lot Current dealership is not in the list and stays.

**The retention line.** Once a week, list the dealerships whose subscription has ended (weekly, so one that ended just after a run is on the next list within a week, with more than three weeks left to offer the export and delete it; a monthly run could first list it on or after the day it is due):

```sql
select d.id, d.name, d.website_origin, s.status, greatest(s.pilot_ends_at, s.updated_at) as ended_about
from public.dealerships d
join public.subscriptions s on s.dealership_id = d.id
where public.subscription_state(d.id) = 'lapsed'
  and coalesce(s.status, 'pilot') in ('pilot', 'canceled', 'incomplete_expired')
order by ended_about;
```

Each row is a dealership whose free pilot ended unpaid or whose Stripe subscription was cancelled or expired. `past_due`, `unpaid` and `paused` are left out: those have not ended, Stripe is still collecting. Offer each one's managers an export, delete it within 30 days of `ended_about`, and forget the accounts its answer lists in `accounts_without_a_dealership` (step 4): with no dealership they serve no purpose.

### Forget a person: the person asked

```sql
select id, email from auth.users where lower(email) = lower('<their email>');
select public.forget_person('<user id>', '<their email>');
```

The second argument must be that account's email (case does not matter); anything else is refused with `P0007` and nothing changes. What it does:

- **Removes** their memberships (with the unused invite codes they made), any other unused code they made, their invite misses, their self-serve sign-up attempts, the demo requests sent from their email, their entries in Supabase's auth audit log when the project keeps it in the database (`auth.audit_log_entries`: sign-ins, with email and IP address), and last their `auth.users` row, which takes their sessions and sign-in identities with it.
- **Clears** their name from `listings.salesperson` and `post_attempts.salesperson` on every row they made, and the listing link from their listings already taken down.
- **Keeps** those rows, their rewrite usage and the invite codes they used or made that were used, as the dealership's numbers: VIN, price, times, outcome, under a user id that points at no one once the account is gone. The policy puts those records in the dealership's hands (a customer asks for its dealership's records to be exported or deleted); what is the person's own is their name, their email and their account, and those go. The link on a listing still marked up stays: the car is still advertised on their profile, only they can take it down (Lot Current never does), and the dealership needs the link to see it come down. `billing_events` that carry their email (the manager who opened Checkout is the billing email) stay as the accounting record; the answer counts them. When they were the billing contact, ask the dealership for a new one and change the customer's email in the Stripe Dashboard.

When they are the last manager of a dealership, it refuses with `P0006` and names the dealership. Ask that dealership who takes over, make that member a manager, then run it again:

```sql
update public.memberships set role = 'manager'
where dealership_id = '<dealership id>' and user_id = '<user id of the next manager>';
```

When nobody is left to take over, or the dealership is leaving too, delete the dealership first (above).

What the database cannot reach: copies in browsers and in files. Tell the person to clear their own browser (Settings, **Clear everything for this website** and **Forget my synced profile**, then remove the extension) and to delete their Marketplace listings on Facebook themselves. Copies the dealership already holds (colleagues' extensions, a CSV a manager downloaded) are the dealership's; say so in the reply rather than promise otherwise.

A person with no account, who only sent a demo request:

```sql
delete from public.demo_requests where lower(trim(email)) = lower('<their email>');
```

`tests/privacy.sql` runs with the other SQL tests (the `psql` command under "Run the RLS test"); its last line is `privacy.sql: every check passed`.

## Usage report

PLAN.md M6 asks that each partner dealer has at least two active salespeople and one manager using the manager view, and its demo is the partner list with usage numbers. `migrations/0008_usage.sql` gives the owner one function for that list, `usage_report(since)`: one row per dealership, every column read from the tables as they are, and no score or estimate made from them. Run it once a week and keep the partner list from it (`docs/launch-checklist.md`, "Design partners").

| Path | What it is |
|---|---|
| `migrations/0008_usage.sql` | `usage_report(since)`, with a comment saying where each column comes from. |
| `tests/usage.sql` | Proves it against a running database: two dealerships with different activity each count only their own rows, `since` is inclusive to the microsecond, a dealership with no activity still has its row, with zeros, and no API role can call it. |
| `test/usage.test.js` | Holds the source to the revoke, the pinned search path and the column list, and this section and the launch checklist to the columns, in `npm test`. |

It runs only as the owner, in the Dashboard's SQL editor (it connects as `postgres`), like the privacy tools. Execute is revoked from `public`, `anon`, `authenticated` and `service_role`, so no key, no signed-in user and no Edge Function can call it, and no dealership sees another's numbers. It is `SECURITY INVOKER`: it can read only what the caller's own role may read.

```sql
select * from public.usage_report();                            -- the past 7 days
select * from public.usage_report(now() - interval '30 days');  -- any other window
select * from public.usage_report(null);                        -- everything, from the start
```

The window starts at `since`, a row stamped exactly then included, and has no end. The dealerships with the most active salespeople come first, then the rest by name. The columns:

| Column | What it is |
|---|---|
| `dealership_id`, `name`, `website_origin`, `created_at` | The dealership's row. |
| `plan_state` | `none`, `pilot`, `active` or `lapsed`: `subscription_state()`, the rule `/sync` and `/rewrite` go by (under Billing, "The state machine"). |
| `pilot_ends_at`, `current_period_end` | From its `subscriptions` row; empty when it has none. |
| `managers`, `salespeople` | Its members by role, today. |
| `active_salespeople` | Members with the salesperson role who posted at least one listing in the window. A manager who posts is counted in `posts`, not here, and so is someone who is no longer a member: M6 asks for two salespeople and a manager, and a posting manager counted twice would meet it with one salesperson. |
| `posts` | Listings posted in the window, by anyone, whatever their status now. The time is `posted_at`, when the salesperson's browser recorded the post. |
| `cars_listed_now` | Cars (VINs) with a listing still marked listed. |
| `open_take_downs` | Sold cars still listed: open to-do items of kind `takeDown`. |
| `open_price_changes` | Website prices a listing does not show yet: open to-do items of kind `price`. |
| `oldest_open_hours` | Hours since the oldest open to-do item of either kind was flagged; empty when none is open. |
| `last_synced_scan_at` | When the newest scan to reach the database ran (`scan_summaries.taken_at`, on the clock of the machine that scanned). The database keeps no log of syncs, but every sync carries the counts of that machine's newest scan, so this is the nearest thing it holds to the dealership's last sync. It stops moving when nobody's extension syncs, and when the plan lapses (`/sync` then writes nothing). A sync with no newer scan to bring leaves it where it was. |
| `rewrite_calls` | Description writer calls in the window: `rewrite_usage` rows of kind `rewrite`. The photo color guesses (kind `color`) are not counted. |

**What it cannot say.** Nothing in the database records a manager opening the manager view, so `managers` counts people with the role, not people using the page: ask the manager at the weekly check-in. The numbers that stay in the salespeople's browsers (the Numbers tab's seconds per post, the fields that could not be filled) are not here either.

**While self-serve sign-up is open**, look for rows in the `none` or `pilot` state with no `posts` and an empty `last_synced_scan_at` well after `created_at`: those are dealerships nobody runs (above, "Why per_day, and what it bounds").

`tests/usage.sql` runs with the other SQL tests (the `psql` command under "Run the RLS test"); its last line is `usage.sql: every check passed`.
