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
| `migrations/0006_privacy.sql` | The owner's privacy tools: `export_dealership`, `delete_dealership`, `forget_person`; no API role may call them (below, "Export or delete a dealership's data"). |
| `migrations/0005_leads.sql` | `demo_requests`, the landing page's demo requests; no API role reads it. |
| `functions/lead/` | `/lead`: the landing page's demo form, anonymous, behind its origin, a honeypot and rate limits. |
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

   `db push` applies the six migrations in order. Nothing in them is reachable through the API until the second one has turned row-level security on, and `db push` applies them all together. Until the first project has applied them, a change to the schema is made in the file that defines it (the files are the schema, not a history yet; `listings.created_at` and the invite-code index were added that way); from then on every change is a new numbered file.

3. **Sign-in settings** (Dashboard, Authentication):
   - Providers, Email: keep it on; passwords are never used, so "Confirm email" can stay off (the magic link is the confirmation).
   - Email templates, Magic Link: keep the link (`{{ .ConfirmationURL }}`, which the manager page uses) and add the six-digit code, `{{ .Token }}`, which is how the extension signs in: the salesperson types it into Settings (`verifyOtp` in `account.js`). The extension needs no redirect address.
   - URL configuration: set **Site URL** to the manager page's own address (for example `https://manage.<your domain>/`) and add the same address under **Redirect URLs**. The manager page asks Supabase to send its magic link back to itself (PKCE flow: the link carries a one-time code, never the tokens), and Supabase only honours a redirect it has on this list; anything else falls back to the Site URL. Never leave the Site URL at the `http://localhost:3000` default on a hosted project: a manager's link would then go to whatever listens on that port of their computer. `config.toml` carries the same setting for a local stack.
   - Rate limits: lower them. With the public anon key anyone can ask for sign-in emails to any address, and one cheap loop would use up the project's email budget and lock every salesperson out of signing in. Set **Rate limit for sending emails** to about 30 an hour and **sign-ups and sign-ins** to about 30 per 5 minutes per IP address (`config.toml`'s `[auth.rate_limit]` block has the same numbers for a local stack), set up **custom SMTP** (Authentication, Emails) before the first dealership so the budget is yours rather than the shared test sender's, and turn on **CAPTCHA protection** (Authentication, Attack protection) once the manager page is public.

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

   -- one single-use code for the first manager, made the way create_invite() makes codes: never type one yourself,
   -- a guessable code is a way in for anyone who signs up; it expires in 7 days (invites.expires_at)
   insert into public.invites (code, dealership_id, role)
   values (upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12)), '<the id returned above>', 'manager')
   returning code;
   ```

   `website_origin` is the dealer website's origin exactly as the extension sees it (scheme and host, no path, no trailing slash): the extension keeps its registry under `posted:<origin>` and the sync function matches on it. The manager signs in with the magic link, redeems the code in the extension's Settings (typed in any case, spaces around it ignored: `redeem_invite` folds both sides, and the extension sends codes in upper case), and from then on makes codes for the salespeople, and for other managers, in the manager view: **Invite a salesperson** and **Invite a manager** in its Invite codes card call `create_invite`, which answers a 12-character upper-case code that works once, shown with a Copy button. The owner's SQL path stays for the first manager (the statement above), and a new one the same way if that code expires unused. The table itself is never readable through the API: a manager sees the dealership's open codes through `list_invites` and cancels one with `revoke_invite`, both in the manager view's Invite codes card, and a code is a secret you hand to one person.

   Invite codes and the rules around them (`0002_rls.sql`): a code works once and for 7 days; it also dies when its maker is no longer a manager of that dealership, and removing a member deletes the codes they made and nobody used (so a departing manager cannot keep a code to come back with). `redeem_invite` gives one answer, `that invite code is not valid` (code `P0002`, HTTP 400), for an unknown, used, expired or cancelled code, so a guess learns nothing, and after 10 misses in an hour it refuses that account with `too many attempts; try again in an hour` (`P0005`) before looking anything up. The misses are counted in `invite_misses`, which no API role can read or write. Because a raised error would roll the count back with the call, a miss is *answered* with status 400 and the same `{ code, message }` body PostgREST gives for an error; check once on the first deploy that a wrong code, tried eleven times, gets the `P0005` answer (it relies on PostgREST committing a call whose function set `response.status`).

   Managers may rename their dealership but not change its `website_origin` (a column-level grant): the origin is the key `/sync` matches on and it is unique, so changing it is the owner's job in SQL, as creating the row is.

6. **Check the deploy.** Fill `extension/src/accountConfig.js` and `manager/config.js` with the project URL and anon key, then from the repository root:

   ```
   npm run check-deploy
   ```

   It looks at the project from the outside and prints a checklist: the config files name the same project, the anon key reads nothing from any table and cannot redeem a code, each function answers the extension's CORS preflight and refuses a call with no token, the billing webhook refuses an unsigned event, and the lead function refuses any page but the landing page (`LOTSYNC_SITE_ORIGIN=https://<where site/ is hosted>` checks its preflight too). With `LOTSYNC_TEST_TOKEN` set to the access token of a signed-in test account that belongs to no dealership (sign in once in the manager view and copy `access_token` from the browser's local storage), it also checks that `/sync` answers 403 and that eleven wrong invite codes end in `P0005`, which proves the throttle counts misses on the real PostgREST. It changes nothing but that test account's miss count, keeps nothing and prints no key; exit code 0 means every check passed.

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

Both take `Authorization: Bearer <the user's access token>` and a JSON body, and answer JSON with `ok`. Errors are `{ ok: false, error: "<a sentence>" }` with 400 (bad request), 401 (no valid token), 402 (the dealership's subscription has lapsed; the answer also carries `code: "lapsed"` and the `plan`, below), 403 (not a member), 404, 429 (rate limit or the monthly cap), 502/503 (the Anthropic API) or 500.

**`POST .../functions/v1/rewrite/rewrite`** (or the bare `/rewrite`): the body is the facts object `extension/src/rewriter.js` builds (`rewriteFacts`: year, make, model, trim, mileage, stock, features, carfaxOneOwner, carfax, colors, engine, transmission, drivetrain, fuelType, narrative, dealer { name, city }, salesperson { name, title }, priceNote). No VIN goes up; the extension adds the VIN line afterwards. The extension also sends the dealer website's `origin` with the facts (the function strips it before the prompt): it picks the dealership for a person who belongs to several, compared as `/sync` compares it (no trailing slash, no case), and an origin that matches none of their dealerships gets 403, so a sister store is never billed or capped for another store's cars; a body without an origin (an older extension) gets the first membership. A dealership whose plan has lapsed (the state machine under Billing, below) gets 402 `{ ok: false, error, code: "lapsed", plan }` on every route of the function, after the membership is picked and before the cost cap and the model call, so nothing is spent for a store that no longer pays; the row is read with the caller's own client, the way `/sync` reads it. Answer: `{ ok, text, model, guardrails: { ok, problems: [{ code, text }], words }, costUsd, error }`, the same as `backend/server.js`: `ok` is false when the draft failed the guardrails twice or the model declined, and the extension then shows its template.

**`POST .../functions/v1/rewrite/color`**: `{ photos: [up to 4 https addresses], options: [Facebook's color words] }`. Answer: `{ ok: true, exterior, interior, confidence, model, costUsd }` or `{ ok: false, error, costUsd }`.

**`GET .../functions/v1/rewrite/health`** (signed in): `{ ok, model, month, usd, capUsd, perMinute, dealership }`, the caller's dealership's spend this month.

**`POST .../functions/v1/sync`**: `{ origin, posted, pilot: { posts, flags }, scan, since, today }` as `syncPayload()` in `extension/src/sync.js` builds it: `origin` is the dealer website's origin; `posted` is the salesperson's own registry entries, whole (`{ [vin]: { name, price, postedAt, listingUrl?, salesperson?, updatedAt? } }`); `posts` and `flags` are the pilot's post attempts and to-do flags that changed since the last sync (all of them the first time); `scan` is `{ takenAt, cars, ready, takeDownCount, priceUpdateCount }` or null; `since` is the `serverTime` of the last answer or null; `today` is `{ from, to }`, two ISO stamps bounding the caller's local calendar day (the extension builds it from its clock; the function takes it only when both parse, `from` is before `to` and the span is at most 48 hours, `todayRange` in `functions/_shared/billing.mjs`). The function first reads the dealership's `subscriptions` row with the caller's own client (a member may read it; no service-role key) and, when the plan has lapsed, answers 402 `{ ok: false, error, code: "lapsed", plan }` and writes nothing. Otherwise it upserts the caller's listings (matched on VIN and posting time; another user's row or a taken-down row is never changed), marks as taken down the caller's listed rows that are missing from the registry among those the server already held at `since` (`listings.created_at`, stamped by the server when the row arrived; the client's `postedAt` is never compared with `since`, so a post uploaded late from another of the salesperson's machines, or one stamped by a slow clock, is not mistaken for a take-down, which would be final), upserts the post attempts (VIN and start time) and the to-do items (VIN, kind and flagging time; closed by an upload, never reopened), stores the scan once, and answers `{ ok, serverTime, dealership: { id, name, websiteOrigin }, role, plan, postsToday, counts, listings, todoItems }`: every listing of the dealership that is up plus the ones taken down since `since` (the last 90 days for a first sync), and every open to-do item plus the ones closed since. `plan` is `{ state, pilotEndsAt, currentPeriodEnd, seats }` from the row (`planOf` in `functions/_shared/billing.mjs`, the same rule as `subscription_state()`; `state` is `none`, `pilot`, `active` or `lapsed`, and a dealership with no plan yet is served, since it is still onboarding). `postsToday` is the number of the caller's own listings rows, any status, whose `posted_at` falls in `today` (counted after the upload, so this call's posts are in it), or null when the request sent no usable `today`. The extension keeps both under `sync:<origin>`, and the daily cap takes the larger of its local count and the server's when the server's range covers the moment, so the cap holds per salesperson across that salesperson's machines. `serverTime` is taken after the upload is written and before that state is read, so it is the right `since` for the next call. A user who is not a member of the dealership for that origin gets 403.

Limits on `/sync`, against one member flooding the dealership's tables (a real registry is a few hundred rows and a few tens of KiB): more than 12 calls by one user in a minute get 429 `too many syncs; try again in a minute` (counted per function instance, like `/rewrite`'s brake); a body over 512 KiB, or more than 2,000 listings, post attempts or to-do flags in one request, gets 400 and nothing is written. A listing stamped more than 5 minutes ahead of the server's clock is not written (`counts.rejected`): a stamp from the future would win every merge. A listing for a VIN that another member currently has up is not written either (`counts.conflicts`): a car is re-posted only by the person who has it listed, or after their row is taken down, so nobody's upload can push a colleague's live listing out of that colleague's registry. The extension keeps the same rule on its side: a colleague's newer row never replaces an entry the salesperson owns (`mergeRegistry`).

The pilot lists are the one place a client clock still meets `since`: `posts` and `flags` are chosen by their own stamps (`syncPayload` sends the ones that changed after `since`), so a clock running far behind can keep an attempt or a flag from going up until it changes again. That can cost a pilot number, never a registry entry, and it is left as is for now.

## Who can see and do what

Every table has row-level security on. In one line: a signed-in person sees their own dealership and nothing else; salespeople write their own rows; managers can change any row of their dealership; only managers delete; the anon key alone gets nothing. Managers change a member's name and role (a column-level grant: never who or which dealership) and remove members, from the manager view's Team card; a dealership always keeps at least one manager (the `keep_a_manager` trigger answers `P0006` to anything that would leave none; deleting the dealership itself still cascades). The full list is in `migrations/0002_rls.sql`, each policy with a comment saying what it is for. The service role (inside the functions only) bypasses these, as it always does on Supabase.

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
  -f supabase/tests/rls.sql \
  -f supabase/tests/billing.sql \
  -f supabase/tests/privacy.sql
```

Either way each file ends with `every check passed` and psql exits 0; a failed check prints the reason and exits non-zero. Never run the shim against a Supabase database; it only exists for Postgres without Supabase.

The two copies in `functions/_shared/` (the prompt and the guardrails) are checked against their originals with

```
node --experimental-strip-types supabase/tests/port-check.mjs
```

and `npm test` covers `extension/src/account.js` and `extension/src/sync.js`.

## What is stored

Only what the extension already keeps in the browser and the privacy policy names (`legal/privacy-policy.md`): the dealership, who belongs to it and as what, the posted registry (VIN, name, price, times, when the server first received the row, the listing link the salesperson saved, who posted), the to-do items, the post attempts (times and outcomes), scan counts, and one row per rewrite call with its token counts and cost. No descriptions, no photos, no buyers, nothing from the Facebook account beyond the listing link. The fill records (which form fields could not be filled) stay in the browser. Deleting a dealership row deletes everything it owns.

## Demo requests (the landing page's form)

The landing page's **Request a demo** form posts to the `lead` function, which stores the request in `demo_requests` (PLAN.md M5, acceptance 2). Until it is set up the form opens the visitor's own mail app instead, so nothing is lost.

```
supabase secrets set LEAD_ORIGINS=https://<where site/ is hosted>
supabase db push                              # applies 0005_leads.sql
supabase functions deploy lead --no-verify-jwt
```

Then put `https://<ref>.supabase.co/functions/v1/lead` in `site/config.js` as `demoEndpoint`. Visitors are anonymous, so the function checks no token; instead the browser's Origin must be one of `LEAD_ORIGINS` (anything else gets 403 and no CORS header), a hidden honeypot field makes a bot's request look accepted while storing nothing, one address may send 5 requests an hour (hashed in the function's memory and forgotten, never stored), and the whole table takes at most 200 an hour. Fields are trimmed and capped (`functions/_shared/lead.mjs`; the table's checks carry the same limits). A request keeps only what the visitor typed, the time and the page's origin: no address, no cookie, no tracking.

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
| `tests/billing.sql` | Proves the pilot rules and the wall between dealerships against a running database (same recipe as `rls.sql`, with `0004_billing.sql` added to the list). |
| `test/billing.test.js` | The unit tests, in `npm test`. |

### What to create in Stripe, once

In the Stripe Dashboard, in **test mode** first (the toggle at the top; everything below exists separately in test and live mode):

1. **A product** called Lot Sync, with two recurring monthly prices, the planned amounts from `marketing/pricing.json`:
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
supabase db push                                # applies 0004_billing.sql
supabase functions deploy billing --no-verify-jwt
```

`--no-verify-jwt` (or a `[functions.billing]` block with `verify_jwt = false` in `config.toml`, like the other two functions) is required: Stripe's webhook carries no Supabase token, and the function checks the caller's token itself on the other three routes.

### Environment variables

| Name | Where | Meaning |
|---|---|---|
| `STRIPE_SECRET_KEY` | function secret | Stripe's secret API key. Only the billing function has it; it goes out only as the bearer on calls to `api.stripe.com`, and it is never logged or answered. |
| `STRIPE_WEBHOOK_SECRET` | function secret | The webhook endpoint's signing secret. Every event's `Stripe-Signature` header is checked against the raw body (HMAC-SHA256, five-minute tolerance) before anything is read from it. |
| `STRIPE_PRICE_ROOFTOP` | function secret | The rooftop price id. Without it `/checkout` answers 500 naming the variable. |
| `STRIPE_PRICE_SEAT` | function secret | The extra-seat price id. Needed only when a dealership asks for more seats than the included count; `/checkout` says so if it is missing then. |
| `ALLOWED_RETURN_ORIGINS` | function secret | Comma-separated origins (scheme and host) Stripe may send the manager back to after Checkout or the portal. The request's `returnUrl` must sit on one of them or `/checkout` and `/portal` answer 400. Until it is set, neither route works. Add the same origin to `ALLOWED_ORIGINS` so the page may call the functions at all. |

### The routes

All three signed-in routes take `Authorization: Bearer <the user's access token>` and pick the dealership from `dealershipId`, from `origin` (the dealer website's origin), or, for a person in one dealership, from nothing.

**`POST .../functions/v1/billing/checkout`** (managers): `{ returnUrl, seats?, dealershipId? | origin? }`. Creates the dealership's Stripe customer if it has none (name, the manager's email, `metadata.dealership_id`), then a Checkout Session in subscription mode with the rooftop price and, above the included count, the seat price times the extra seats, `success_url` and `cancel_url` = `returnUrl` with `?billing=success` or `?billing=canceled`. During a running pilot with more than 48 hours left, the subscription starts as a trial ending when the pilot does, so the card is charged at the end of the free period and not at checkout. Answers `{ ok, url }`: the page sends the manager to `url`. 409 when the dealership already has an active subscription (the portal is the place to change it), and 409 `{ ok: false, error: "update the card in Manage billing; the subscription is still open", code: "open-subscription" }` while Stripe still holds the dealership's subscription open (trialing, active, past_due, unpaid, incomplete, paused): a lapsed card is updated in the portal and Stripe retries the open invoice, whereas a second Checkout would open a second subscription on the same customer (`checkoutRefusal` in `functions/_shared/billing.mjs`).

**`POST .../functions/v1/billing/portal`** (managers): `{ returnUrl, dealershipId? | origin? }`. A Billing Portal session for the dealership's customer; answers `{ ok, url }`. 404 until a checkout has created the customer.

**`GET .../functions/v1/billing/status?dealershipId=|origin=`** (any member): `{ ok, dealership, role, state, subscription, canStartPilot, canSubscribe, canManageBilling, pilotDays, includedSalespeople }`. `state` is one of the four words below; `subscription` is the row or null. The manager page's Billing card reads it; the extension learns the same plan from `/sync`.

**`POST .../functions/v1/billing/webhook`** (Stripe only): verifies the signature, records the event in `billing_events` once (a redelivery of a recorded event is acknowledged and not applied again), and on the five subscribed events updates the dealership's row with the service-role client. Which row: the one carrying the customer or subscription id, else the `dealership_id` Checkout wrote into the subscription's metadata, else the customer's metadata. An event about a customer that is not a Lot Sync dealership is recorded and left alone. An event about another subscription than the row's is ignored (an old subscription's dunning retries or final delete never flip a store that has moved on), except `customer.subscription.created` newer than the row's last change on a row whose subscription is over (canceled, incomplete_expired) or that never had one; invoice events count only for the row's own subscription. A database failure answers 500 so Stripe retries (it does, with backoff, for up to three days); an older event never overwrites a newer one for the same subscription (Stripe does not deliver in order).

### The state machine

`subscription_state(dealership_id)` in SQL and `subscriptionState(row, now)` in `billing.mjs` give the same word from the row; `tests/billing.sql` and `test/billing.test.js` hold both to it.

| State | When | What the product does with it |
|---|---|---|
| `none` | No row, or a row with only a customer id (a checkout opened and not finished). | Everything works (a dealership with no plan yet is still onboarding); the manager page offers "Start the free pilot" and "Subscribe". |
| `pilot` | `pilot_ends_at` is in the future and nothing is paid. Stripe's word does not matter meanwhile: the free period was promised. | Everything works; the page shows the end date and "Subscribe". |
| `active` | Stripe says `trialing` (a subscription whose first charge waits for the pilot to end) or `active`. | Everything works; the page shows the paid-through date, seats, and "Manage billing". |
| `lapsed` | Everything else: the pilot ended unpaid, `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`. | The page says so and offers "Subscribe" (and "Manage billing" when a customer exists). `/sync` and `/rewrite` answer 402 with `code: "lapsed"` and the plan and do nothing else: syncing and the description writer stop until a manager renews. The billing routes are never gated, so renewing always works. |

The row: `status` (`pilot`, or a Stripe status, or null), `pilot_ends_at`, `current_period_end`, `seats` (the included count plus the seat price's quantity; informational for now), `stripe_customer_id`, `stripe_subscription_id`, `updated_at`.

### How the free pilot starts

The manager, signed in, calls `start_pilot(<dealership id>)` (PostgREST: `POST /rest/v1/rpc/start_pilot` with `{ "dealership_id": "..." }`, or `supabase.rpc('start_pilot', { dealership_id })` from the manager page). No card, no Stripe object: the row gets `status = 'pilot'` and `pilot_ends_at` = now plus `pilotDays` from `marketing/pricing.json`. Only a manager of that dealership may call it; it starts the pilot once and never restarts it (a second call, or a call on a dealership that pays or already had its pilot, answers with the standing unchanged and `started: false`). The answer is `{ dealership_id, started, status, pilot_ends_at, state }`.

### The manager page's Billing card

The manager view (`manager/`) has a Billing card fed by `GET /billing/status?dealershipId=<the dealership's id>`. One line says where the dealership stands, and the buttons are the ones the answer allows (`canStartPilot`, `canSubscribe`, `canManageBilling`; salespeople see the line and no buttons):

| State | The line | The buttons |
|---|---|---|
| `none` | "No plan yet. Start the free pilot: `pilotDays` days, `includedSalespeople` salespeople included, no card." (a salesperson reads "A manager can start") | **Start the free pilot**, **Subscribe** |
| `pilot` | "Free pilot: N days left (ends `pilot_ends_at`)." and, for a manager, that subscribing now is first charged when the pilot ends | **Subscribe** |
| `active` | "Subscribed: `seats` salespeople, renews `current_period_end`." ("first charge" while Stripe reports `trialing`) | **Manage billing** |
| `lapsed` | "The subscription has lapsed; salespeople can still post, but nothing syncs and the description writer is off until it is renewed." plus why (the payment failed, it was cancelled or paused, or the free pilot ended on a date) | **Subscribe**, and **Manage billing** when a Stripe customer exists |

What each button calls: **Start the free pilot** runs `supabase.rpc('start_pilot', { dealership_id })` and re-reads the status. **Subscribe** POSTs `{ returnUrl, dealershipId }` to `/billing/checkout` and sends the browser to the `url` in the answer (Stripe Checkout); back on `?billing=success` the page re-reads the status, which the webhook has by then usually updated, and on `?billing=canceled` it says nothing was charged. **Manage billing** POSTs `{ returnUrl, dealershipId }` to `/billing/portal` and sends the browser to its `url` (Stripe's Billing Portal). `returnUrl` is the page's own address, which must sit on an origin in `ALLOWED_RETURN_ORIGINS`.

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
where d.website_origin = 'https://www.<the dealer website>'
order by m.role, m.name;
```

This is also how a manager's request is verified: the address it came from must be the `email` on a `manager` row of that dealership.

### Export: a manager asked for a copy

```sql
select jsonb_pretty(public.export_dealership('<dealership id>'));
```

The answer is one JSON document: `dealership`, then one list per table (`memberships` with each member's account email, `listings`, `todo_items`, `scan_summaries`, `post_attempts`, `rewrite_usage`, `invites`, `subscriptions`, `billing_events`), `counts` per list, and `notes` that say what is in it. Left out on purpose: the code of an unused invite (it may still let someone join, and a file gets forwarded; managers see their open codes in the manager view), the emails of people who are no longer members, `invite_misses` (per account, not per dealership) and `demo_requests` (a visitor's, not the dealership's). What lives only in the salespeople's browsers (Settings, the Numbers tab, which form fields could not be filled) is not in the database, so it is not in the export.

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

   The second argument must be the dealership's `website_origin` exactly as stored (scheme, host, same case, no trailing slash). Anything else is refused with `P0007` and nothing is deleted, so an id pasted from the wrong row cannot take the wrong dealership. The dealership row goes, and the foreign keys' `on delete cascade` takes every row it owns: memberships (the last manager's too: `keep_a_manager` lets a dealership's own deletion through), listings, to-do items, scan summaries, post attempts, rewrite usage, invites and the subscription row. The answer counts what went (`removed`) and names what stayed: the `billing_events` kept as the accounting record (the policy keeps billing records for accounting), the `stripe_customer_id`, and `accounts_without_a_dealership`, the members who now belong to no dealership.
3. **Stripe, separately.** Nothing in the database reaches Stripe. In the Stripe Dashboard (live mode for a real dealership), open Customers, find the `stripe_customer_id` from the answer and delete the customer. Deleting a customer also cancels any subscription still open on it, so the dealership is not charged again.
4. **The people.** The accounts in `accounts_without_a_dealership` can still sign in and see nothing. When the request covers the dealership's people (a store that leaves usually means it does; ask when the request does not say), forget each one with `forget_person` below, with the email the answer gives as the confirm. Someone who also belongs to another Lot Sync dealership is not in the list and stays.

**The retention line.** Once a month, list the dealerships whose subscription has ended:

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

- **Removes** their memberships (with the unused invite codes they made), any other unused code they made, their invite misses, the demo requests sent from their email, their entries in Supabase's auth audit log when the project keeps it in the database (`auth.audit_log_entries`: sign-ins, with email and IP address), and last their `auth.users` row, which takes their sessions and sign-in identities with it.
- **Clears** their name from `listings.salesperson` and `post_attempts.salesperson` on every row they made, and the listing link from their listings already taken down.
- **Keeps** those rows, their rewrite usage and the invite codes they used or made that were used, as the dealership's numbers: VIN, price, times, outcome, under a user id that points at no one once the account is gone. The policy puts those records in the dealership's hands (a customer asks for its dealership's records to be exported or deleted); what is the person's own is their name, their email and their account, and those go. The link on a listing still marked up stays: the car is still advertised on their profile, only they can take it down (Lot Sync never does), and the dealership needs the link to see it come down. `billing_events` that carry their email (the manager who opened Checkout is the billing email) stay as the accounting record; the answer counts them. When they were the billing contact, ask the dealership for a new one and change the customer's email in the Stripe Dashboard.

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
