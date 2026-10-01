# The stack test: Lot Current against a real local Supabase

The unit tests run the four functions' handlers, the extension's account and sync modules and the manager page's data code against fakes: a fake database, a fake auth server, a fake PostgREST. The SQL tests run the migrations on a plain Postgres with no PostgREST in front. Neither can show what the real pieces answer when they meet. The stack test can: `scripts/stack-test.mjs` runs against a local Supabase stack started by the Supabase CLI, with the real Postgres, PostgREST, GoTrue (the auth server), mail catcher, gateway and Edge Runtime, and prints what each of them answered.

It runs in CI as the job `stack` (`.github/workflows/ci.yml`), where Docker is available. It changes nothing in the repository and never talks to a hosted project: the script refuses any address but `http://127.0.0.1` or `localhost`.

## What it proves

Each file in `test/stack/` is one part of `supabase/README.md`, checked against the stack. Every check prints one line, `ok`, `FAIL` or `note`, and `info` lines say what the stack really answered, so a difference from the README is written in the log even when the check passes.

| File | What it checks |
|---|---|
| `01-sync.stack.mjs` | A dealership made the owner's way (SQL, README step 5), its manager signed in from the real sign-in email, two salespeople invited through `create_invite` and joined through `redeem_invite`, all with the extension's own `account.js` and `accountFlow.js`. Then the real `/sync`: each salesperson's post reaches the other, marked as a colleague's; the manager sees both, in the extension and in the rows the manager page reads; a take-down on one machine reaches the other; the scan's counts are stored; the server counts today's posts for the daily cap; a signed-in stranger gets 403 and reads nothing. |
| `02-invite-throttle.stack.mjs` | Ten wrong invite codes each get HTTP 400 with `{ code: "P0002" }`, all ten misses are still in `invite_misses` after the calls returned, and the eleventh gets `P0005`. This is the check README step 5 asks the owner to make by hand: it proves PostgREST commits a call whose function set `response.status`. |
| `03-last-manager.stack.mjs` | The last manager can neither step down nor leave: the requests the manager page's Team card sends get `P0006` and the trigger's sentence, and the Team card's code shows `error.message`. With a second manager in place, the first may step down. |
| `04-signup.stack.mjs` | Self-serve sign-up closed (`P0008`), then opened in SQL: a signed-in person starts a dealership, becomes its manager, its free pilot starts, and their extension syncs with it on the pilot plan. A website that already has a dealership, however it is typed, gets HTTP 400 with `P0009` five times and the sixth try gets `P0005`, which proves the throttle counts those answers. The switch is set back afterwards. |
| `05-lead.stack.mjs` | The lead function with `LEAD_ORIGINS` set: another page's Origin gets 403 (and no CORS header, unless the local gateway adds its own), the honeypot is answered 200 and stores nothing, a real request is stored with the page's origin. Then, for information only, which address headers (`cf-connecting-ip`, `x-real-ip`, `X-Forwarded-For`) reach the per-sender brake through the local gateway. |
| `06-check-deploy.stack.mjs` | `npm run check-deploy` pointed at the stack with a signed-in account in no dealership (`LOTSYNC_URL`, `LOTSYNC_ANON_KEY`, `LOTSYNC_TEST_TOKEN`, `LOTSYNC_SITE_ORIGIN`): none of its live lines may read FAIL, and the lines that need the test token, `LEAD_ORIGINS` and the webhook's signing secret must read ok. Its lines about the three config files are the hosted project's, and its CORS preflight lines are the local gateway's answers; both are listed, not judged. |

Before the files run, the script checks the stack is ready: the gateway and GoTrue answer, every file in `supabase/migrations` is in the CLI's migration history, and each function answers a request that reaches its own code: sync and rewrite refuse a call with no token, billing refuses an unsigned webhook for its signature and lead takes an empty form from the landing page's origin, which shows the env file is loaded. It also looks at who answers a CORS preflight. The CLI's local gateway (Kong, with its `cors` plugin) answers every preflight itself and puts `allow-origin *` on every answer, so the functions' own CORS answers cannot be seen through it; the script says so in a note, and the lines that would judge those answers are listed and not counted.

Nobody signs in with a password, because Lot Current has none. A person gets in with the admin API's magic link (`generate_link`, with the service key), either typing its six-digit code into the extension's `signInFinish` or handing its token hash to the extension's `exchangeTokenFromUrl`, or, for the manager in `01`, with the email the local mail catcher received: its six-digit code when the email carries one (the local stack uses the sign-in template `config.toml` names, if any), else the token in its link, and the log says which.

A raised refusal (`P0005` from `redeem_invite`, `P0006`, `P0008`) reaches the client with whatever HTTP status PostgREST gives it; PostgREST's rule sends PL/pgSQL codes other than `P0001` as 500, and the README names no status for them. The test checks the `code` and the sentence and prints the status it got, so a change there shows in the log.

## Run it on a machine with Docker

You need Docker and the Supabase CLI (`npx supabase`, or the CLI installed; CI pins the version in the `stack` job).

1. Start the stack with only what Lot Current uses. `start` applies `supabase/migrations` in order:

   ```
   supabase start -x studio,storage-api,imgproxy,realtime,logflare,vector,supavisor,postgres-meta
   ```

2. Write the functions' env file somewhere outside the repository, for example `/tmp/lotsync-functions.env`. These are the variables `supabase/README.md` lists for the functions; the CLI sets `SUPABASE_URL` and the two keys itself. `ANTHROPIC_API_KEY` and `STRIPE_SECRET_KEY` stay out: the two services' addresses are fixed in the functions' code, so no stand-in can take their calls, and without a key those routes answer 500 without calling out. The signing secret is made up, so the webhook's signature check runs.

   ```
   MONTHLY_COST_CAP_USD=25
   RATE_LIMIT_PER_MINUTE=20
   ALLOWED_ORIGINS=http://127.0.0.1:8787
   STRIPE_WEBHOOK_SECRET=whsec_<any random letters and digits>
   STRIPE_PRICE_ROOFTOP=price_local_rooftop
   STRIPE_PRICE_SEAT=price_local_seat
   ALLOWED_RETURN_ORIGINS=http://127.0.0.1:8787
   LEAD_ORIGINS=https://site.lotsync-stack.test
   ```

3. Serve the functions with it, in a second terminal, and leave it running:

   ```
   supabase functions serve --env-file /tmp/lotsync-functions.env
   ```

4. Run the test from the repository root:

   ```
   npm run test:stack
   ```

   It asks `supabase status -o env` for the address, keys, database and mail catcher when `LOTSYNC_STACK_URL`, `LOTSYNC_STACK_ANON_KEY`, `LOTSYNC_STACK_SERVICE_KEY`, `LOTSYNC_STACK_DB_URL` and `LOTSYNC_STACK_MAIL_URL` are not set. `LOTSYNC_STACK_SITE_ORIGIN` must match `LEAD_ORIGINS` (it defaults to the value above). `node scripts/stack-test.mjs 03` runs only the files whose names contain `03`. SQL goes through `psql`, or through `docker exec` into the database container when `psql` is not installed.

Every account, dealership, invite miss and demo request a run makes carries the run's id and is deleted at the end, and the sign-up switch is set back, so the test can run again on the same stack. One thing lasts longer: the lead function's per-sender brake lives in the function's memory, so a second run within the same worker's life may find the local address used up. Restart `supabase functions serve` and run again; the lead lines say so when that happens. GoTrue also allows 30 sign-in verifications per 5 minutes from one address unless `config.toml` sets `[auth.rate_limit] token_verifications`, and each run signs ten people in, so a fourth run within five minutes can be refused there. `supabase stop --no-backup` removes the stack when you are done.

## Reading a failure

The lines under each check are what it rests on: `>` lines are the HTTP requests and the start of each answer, `$` lines the SQL, with every key and token replaced by `<hidden>` or `<token>`. A file that stops early prints `FAIL <file> ran to the end (stopped: ...)` with the reason, and the next file still runs. In CI, the step "What the stack logged" prints the functions' log and each container's recent log when anything failed, and a failed `supabase start` is retried once with `--debug`.

The job counts like the others: a failure fails the workflow. Its first CI run (2026-09-30) passed 61 checks with none failed. Through the local gateway, a client-written `cf-connecting-ip` reached the lead function's brake while `x-real-ip` and `X-Forwarded-For` did not; the hosted gateway may differ, which is why supabase/README.md's "Demo requests" asks for the check on the first deploy.

## What it does not prove

- **The hosted gateway.** Which address headers reach the lead function on the hosted project, behind Supabase's own proxies, can differ from the local gateway. `05` reports the local answer for information only; the check in `supabase/README.md`, "Demo requests", on the first deploy is the one that counts.
- **The functions' own CORS answers.** The local gateway answers preflights and sets `allow-origin` itself, so a function that answered CORS wrongly would pass here. `test/fn-*.test.js` hold each function's CORS answer, and `npm run check-deploy` checks them on the hosted project after each deploy.
- **Stripe.** No Stripe call is made: checkout, the billing portal and real webhook events stay untested here. Stripe's test mode is the place for them (`supabase/README.md`, "Testing with Stripe's test mode and the CLI").
- **The description writer's model calls.** `/rewrite` and `/color` are not called; `test/fn-rewrite.test.js` covers them against a fake model API.
- **Real email delivery.** The local mail catcher keeps every email; nothing shows whether a real message reaches an inbox or a spam folder, or how the hosted project's templates and custom SMTP behave.
- **The hosted project's settings**: the Site URL and redirect list, the rate limits and CAPTCHA set in the Dashboard, and the Postgres and PostgREST versions it runs. `npm run check-deploy` against the hosted project, after each deploy, covers what can be seen from outside.
- **The extension and the manager page as screens.** The modules they use run here; their buttons and pages are covered by the end-to-end flows against the mock sites (`test/e2e/`).
