# Production setup: accounts, sign-in email and the manager view

The step-by-step for turning on Lot Current's accounts for real: the Supabase project that holds dealerships, salespeople and the posted list; the email sender that delivers sign-in codes; and the host that serves the manager view at its own address. Written 2026-10-01 for the launch plan's week 2.

Every step that creates an account, costs money or needs a password is the owner's (**[Owner]**). Everything else is prepared in the repository and run by Claude once the owner says go (**[Claude]**). `supabase/README.md` stays the reference for what each setting means; this page is the order to do them in, with the choices made.

**Never paste a password, a secret key or an access token into a chat, an email or a file in the repository.** The only values Claude needs from you are public by design: the project URL and the publishable key. Everything secret goes straight into the Supabase Dashboard or GitHub's secret settings, where only the deploy can read it.

---

## The choices, and why

| What | Choice | Cost (checked 2026-10-01; confirm on the provider's page before paying) |
|---|---|---|
| Database, sign-in and server functions | **Supabase**, one project | Free plan to start. A free project is paused after about a week with little database activity and must be resumed by hand in the Dashboard, which would stop every salesperson from signing in. Fine while nobody uses it; move to the paid plan (about $25 a month when last checked) the week the pilot starts. |
| Sign-in email sender | **Resend**, sending from the subdomain `mail.lotcurrent.com` | Free plan: 3,000 emails a month, at most 100 a day, 3 domains. A salesperson gets one email per sign-in, not per post, so this covers the pilot and the first dealers. The next plan is $20 a month. |
| Manager view host | **Cloudflare Pages** at `app.lotcurrent.com` | Free plan. One new account and one DNS record. |

Why not the alternatives:

- **The GoDaddy mailbox as the sender.** Possible in principle, but it puts the mailbox's own password inside Supabase, mailboxes have low sending limits, and GoDaddy's Microsoft 365 mailboxes usually have SMTP sign-in turned off. (Not tested from here: GoDaddy's pages can't be opened from this environment.) Keep the mailbox for people writing to you; let a sending service send codes.
- **Supabase's built-in sender.** It only delivers to the project's own team and a few emails an hour (`supabase/README.md`, "The sender"). Testing only.
- **The manager view on GitHub Pages next to the website.** No new account, but GitHub's terms say Pages is not for running a business's online service, and it would tie the app to the repository staying public. The launch plan recommends Cloudflare.
- **Supabase's legacy "anon" and "service_role" keys.** Supabase is retiring them by the end of 2026, the month Lot Current goes live. Use the new **publishable** key (starts `sb_publishable_`) in the extension and the manager view; the server functions already prefer the new keys and fall back to the old ones (`supabase/functions/_shared/auth.ts`).

---

## Step 1. The Supabase project [Owner]

1. Go to supabase.com and sign up (signing in with GitHub is simplest).
2. Create an organization named **Lot Current** on the **Free** plan.
3. Create a project:
   - Name: `lot-current`
   - Database password: press **Generate a password**, save it in your password manager. You'll paste it once into GitHub (step 2). Don't send it to anyone.
   - Region: **East US (North Virginia)**, the closest to Pennsylvania dealers.
4. When the project is ready, open **Project settings, API Keys**. Copy the **publishable** key (starts `sb_publishable_`). If the page only shows the legacy "anon" key, use that for now; it works until Supabase retires it, and switching later is one command.
5. Open **Project settings, Data API** (older Dashboards: API) and copy the **Project URL** (`https://<20 letters and digits>.supabase.co`).

**Send Claude:** the Project URL and the publishable key. Both are safe to share; the secret key on the same page is not, and is never needed.

**[Claude] then:** runs `npm run set-project -- <project URL> <publishable key>`, which writes both values into `extension/src/accountConfig.js` and `manager/config.js` (it refuses a secret key and never prints it), runs the tests and commits.

**From then on every build offers sign-in.** With the project named in `extension/src/accountConfig.js`, set-up has its account step and Settings its sign-in, and both reach this project. Until steps 3 to 5 are done and `npm run check-deploy` shows no `FAIL`, a sign-in cannot complete: the email that arrives is Supabase's stock one, not the six-digit code the extension asks for, and the built-in sender mails only the project's own team. So no build goes to a pilot tester before then (the launch checklist's "No tester build before sign-in works"), unless the owner decides otherwise and the tester is told to click **Skip for now**. The test drive (`demo/`) never reaches the project: its `chrome-shim.js` answers every request to it.

## Step 2. Let GitHub deploy to it [Owner]

1. In Supabase: your avatar, **Account preferences, Access Tokens**, **Generate new token**, name it `github-deploy`. Copy it.
2. In GitHub: the repository, **Settings, Environments, New environment**, name it `production`:
   - **Deployment branches and tags**: choose **Selected branches and tags** and add the default branch only. Until this is set, a workflow on any branch that names this environment can read the secrets below.
   - **Required reviewers**: tick it and add yourself. Every deploy to the real database then waits for your click. Without it nothing waits: a run of the Supabase workflow starts the moment anyone who can start it (you, or a session working with your GitHub access) does. Only an admin of the repository can turn it on, and it is off until one does. To check it, start the workflow's **plan** step: the run should stop at "Waiting for review" until you approve it. The approval is yours to give: a session working with your GitHub access could approve a run through GitHub's API too, and leaves that to you.
   - **Environment secrets**, Add secret: `SUPABASE_ACCESS_TOKEN` = the token from 1; `SUPABASE_DB_PASSWORD` = the database password from step 1.
   - **Environment variables**, Add variable: `SUPABASE_PROJECT_REF` = the 20 lower-case letters and digits between `https://` and `.supabase.co`.

Put them on the environment, not under the repository's own Secrets: a repository secret can be read by a workflow on any branch, an environment secret only by a run the environment lets through. GitHub never shows a secret once saved, and only people with write access can start the deploy.

## Step 3. The database and the functions [Claude, with the owner's go]

The **Supabase** workflow (`.github/workflows/supabase.yml`) runs by hand only, from the repository's **Actions** tab or by Claude through GitHub, and only on the default branch: started on any other branch, its job is skipped and nothing is deployed. That guards against a mistake only (a branch's own copy of the workflow could leave the check out), so step 2's branch limit on the `production` environment is still what keeps the secrets from other branches. It refuses to start unless the committed config files name the project in `SUPABASE_PROJECT_REF`, and it ends every run with `npm run check-deploy`.

**Where production stands.** The production project already has the database up to `0008_usage.sql` and all four functions (`rewrite`, `sync`, `billing` and `lead`): they were deployed outside this workflow, before its first run (a **plan** on 2026-10-01 that found nothing to apply). So this step is no longer a first deploy but the order for every later change: **plan** lists the migrations production has not applied (those after `0008_usage.sql`, until **database** applies them), and a function changed in the repository goes up with **functions** after that. Run **verify** before the first deploy from here: what was deployed by hand has not been compared with the repository yet.

1. **plan**: shows the migrations in `supabase/migrations` the project has not applied yet. Changes nothing.
2. **database**: applies them. When a change brings a new migration, run this before **functions**: a function may write the column it adds (`0009_cancel_at.sql` and the `billing` function, for one). **functions** checks: it deploys nothing while a migration is still to be applied.

   A `FAIL` from the outside check turns any run red. On a brand-new project some of its lines fail after plan and database on purpose (no tables yet, then no functions yet): start those two runs with **new project** ticked, and their `FAIL` lines still print but leave the run green. Production is past that (its tables and functions exist), so leave the box unticked there.
3. **functions**: deploys the functions named in the box. The default is all four: `rewrite` (the description writer), `sync` (the sync between machines), `billing` (Stripe) and `lead` (the website's demo form). Each one's settings stay where `supabase/README.md` puts them; a function without its secrets answers with what is missing. Until billing has its secrets and the manager view's address in `ALLOWED_ORIGINS` (`docs/stripe-setup.md` step 5), `billing: false` in `manager/config.js` keeps the manager view from calling it: a manager can still start the free pilot there (`start_pilot()` is in the database), the Billing card says paying by card is not open yet, and that step turns it on.
4. **verify**: compares production with the repository and changes nothing. It fails, and prints the difference, when production has applied other migrations than the ones in `supabase/migrations`, when its public schema differs from the one those migrations build (a table, column, policy or function changed by hand), or when a deployed function's source differs from `supabase/functions`. Run it before the first deploy from this workflow, and again after anything is changed outside it: a deploy from a laptop with the Supabase CLI, or an edit in the Dashboard's SQL editor or Table editor. `check-deploy` cannot see any of that: it only looks at the project from the outside.
5. **check**: the outside check on its own, any time.

After step 3, `check-deploy` should show no `FAIL`; the billing webhook line reads `note` until `STRIPE_WEBHOOK_SECRET` is set. The line for the manager view's billing preflight stays a `note` until the workflow's check has the manager view's address to try it from (the `MANAGER_URL` variable on the `production` environment, step 6), or until you run that check from your own terminal with `LOTSYNC_MANAGER_ORIGIN`, as `docs/stripe-setup.md` step 5 says.

The description writer needs an Anthropic API key only if you turn Claude-written descriptions on; the built-in template writer works without it. That is a separate money decision (capped at $25 a month in the settings); without the key the extension simply uses the template.

## Step 4. Sign-in settings in the Dashboard [Owner, about 10 minutes]

In the Supabase Dashboard, **Authentication**:

1. **URL Configuration**: Site URL `https://app.lotcurrent.com/`; under Redirect URLs add `https://app.lotcurrent.com/`. (Never leave the Site URL on `localhost`.)
2. **Email Templates**: paste `supabase/templates/magic_link.html` into **Magic link or OTP** and `supabase/templates/confirmation.html` into **Confirm sign up**, each with the subject in `supabase/config.toml` ("Your Lot Current sign-in code"). Both templates already carry the Lot Current name, so they can be pasted now; Claude will give you the exact text.
3. **Sign In / Providers, Email**: leave it on; check the email OTP length is **6** and the expiry **3600** seconds.
4. **Rate limits**: emails sent about **30 an hour**; sign-ups and sign-ins about **30 per 5 minutes**. These cap the email bill; they do not stop a lockout. Anyone can use up the hour's emails from one address in minutes, and new sign-ins then wait for the hour to roll over (people already signed in stay signed in; `supabase/README.md` step 3).
5. **Attack protection**: leave CAPTCHA off. Neither the extension nor the manager view sends a captcha token, so with CAPTCHA on every new sign-in would be refused. The two rate limits above and your own email sender (Step 5 below) cap what sign-in email costs; CAPTCHA can come later, once both send a token.

## Step 5. The sign-in email sender [Owner]

Resend sees every sign-in email (the address and the code or link), so it is a processor: `legal/privacy-policy.md` (Processors) and `docs/data-inventory.md` (Who receives data) already name it. Using another sender means changing both first, in the same commit, before it is switched on.

1. Sign up at resend.com (Free plan).
2. **Domains, Add domain**: `mail.lotcurrent.com`. If it asks for a region, pick **North Virginia (us-east-1)**, next to the Supabase project. A subdomain keeps sign-in mail separate from your own mailbox's reputation and leaves the GoDaddy mailbox's records untouched.
3. Resend lists the DNS records to add. In GoDaddy (**My Products, lotcurrent.com, DNS, Add new record**) add each one, typing in GoDaddy's **Name** box only the part before `.lotcurrent.com` (GoDaddy adds the domain itself). For `mail.lotcurrent.com` that is, per Resend's GoDaddy guide (checked 2026-10-01):

   | Type | Name | Value | Priority |
   |---|---|---|---|
   | MX | `send.mail` | copied from Resend (like `feedback-smtp.us-east-1.amazonses.com`) | 10 |
   | TXT | `send.mail` | copied from Resend (like `v=spf1 include:amazonses.com ~all`) | |
   | TXT | `resend._domainkey.mail` | copied from Resend (a long value starting `p=`) | |

   No DMARC record is needed: lotcurrent.com already has one (`_dmarc`, `p=quarantine` with relaxed alignment, seen 2026-10-01), and it covers `mail.lotcurrent.com`, whose Resend mail passes it once the three records above are in. Leave it as it is. Then press **Verify** in Resend. It can take from minutes to a few hours.
4. In the domain's settings, make sure **click tracking** and **open tracking** are off: tracking rewrites the sign-in link and breaks it.
5. **API Keys, Create API key**: name `supabase-smtp`, permission **Sending access**, domain `mail.lotcurrent.com`. Copy it.
6. In Supabase, **Authentication, Emails, SMTP Settings**, turn on custom SMTP:
   - Sender email `sign-in@mail.lotcurrent.com`, sender name `Lot Current`
   - Host `smtp.resend.com`, port `465`, username `resend`, password = the API key from 5 (Resend's SMTP page, checked 2026-10-01)
7. In GitHub, on the `manager-view` environment of step 6 (create it now if step 6 isn't done yet), add the **Environment variable** `SENDER_DOMAIN` = `mail.lotcurrent.com`. **[Claude]** then runs the **Manager view** workflow with **Check only** (from the default branch, once this setup is merged), which runs `npm run check-hosting` and says which of the records above it can see.
8. Test: sign in with two addresses at two different mail services (say Gmail and Outlook). The manager view has no address until step 6, so either come back to this after step 6 and sign in there, or test now from the extension loaded from an up-to-date copy of the repository: **Settings**, **Account**, **Send me a sign-in code**. Each email should arrive in the inbox, not spam, with the six-digit code and the link (the link opens the manager view only once step 6 is done).

## Step 6. The manager view at app.lotcurrent.com [Owner, then Claude]

Cloudflare's access logs see every manager's IP address and browser, so it is a processor: `legal/privacy-policy.md` and `docs/data-inventory.md` already name it as the manager view's host. Another host means changing both first, in the same commit.

1. **[Owner]** Sign up at cloudflare.com (Free plan). You don't need to move lotcurrent.com's DNS to Cloudflare.
2. **[Owner]** Your profile, **API Tokens, Create Token, Create Custom Token**: name `github-manager-deploy`, permission **Account, Cloudflare Pages, Edit**, your account only. Copy it. Also copy the **Account ID** (on the account's home page, right-hand column, or Workers & Pages overview).
3. **[Owner]** In GitHub, **Settings, Environments, New environment** `manager-view`, deployment branches: the default branch only; its environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the **Environment variable** `SUPABASE_PROJECT_REF`, the same project ref as on the `production` environment (step 2).
4. **[Claude]** Run the **Manager view** workflow (`.github/workflows/manager.yml`). It refuses to upload a page whose `manager/config.js` names any project but the one in `SUPABASE_PROJECT_REF`, or that is not otherwise ready (`npm run set-project -- --check --project-ref`), runs every unit test (`npm test`, the suite CI's unit job runs), creates the Cloudflare project `lotcurrent-app` on the first run, uploads `manager/` without the local demo server, and ends by checking the project's `.pages.dev` address from the outside (`npm run check-hosting`: the page, its security headers, the committed project in its `config.js`, and the supabase-js copy that `config.js` names, served as JavaScript and byte for byte the committed one). It reads that address from the project in Cloudflare: usually `https://lotcurrent-app.pages.dev/`, but Cloudflare gives a suffixed one (say `lotcurrent-app-4xk.pages.dev`) when the name is already taken there, and the run log says which (`the project lotcurrent-app answers at ...`). It also runs by itself when a change to the page reaches the default branch, and that deploy waits for no one: the environment has no required reviewer, and the workflow does not wait for CI, so its own `npm test` is what stops a page that breaks a rule. Before the Cloudflare secrets exist it says so and stops without failing.
5. **[Owner]** In Cloudflare, **Workers & Pages, lotcurrent-app, Custom domains, Set up a custom domain**: `app.lotcurrent.com`. Do this **before** the DNS record: Cloudflare's docs say a CNAME added first will not resolve.
6. **[Owner]** In GoDaddy DNS, add **CNAME**, name `app`, value the `.pages.dev` address Cloudflare shows for the project (usually `lotcurrent-app.pages.dev`; the one in the workflow's log line from 4 if it differs). Never point it at an address Cloudflare does not show for your project, whatever a check line says.
7. **[Owner]** On the `manager-view` environment add the **Environment variable** `MANAGER_URL` = `https://app.lotcurrent.com/`, and the same variable on the `production` environment: the Supabase workflow's check then also tries the page's own call to the billing function, which works only once that origin is in the `ALLOWED_ORIGINS` function secret (`docs/stripe-setup.md`, step 5). Until that step, the check's line `billing: answers the manager view's CORS preflight` reads `FAIL` and every run of the Supabase workflow (step 3) ends red, **plan** and **database** included, so add the variable on `production` when you reach that step; on `manager-view` it can go now.
8. **[Claude]** Runs the workflow with **Check only**: `https://app.lotcurrent.com/` loads with its security headers (`manager/_headers`) and its CNAME points at the project's `.pages.dev` address, the one the workflow read from Cloudflare. Every later deploy checks it too. Run by hand, `npm run check-hosting -- --app https://app.lotcurrent.com/ --pages-host <the address Cloudflare shows>` does the same. Then a sign-in link should land back on it (step 7 below).

## Step 7. The first dealership and the end-to-end check [Claude, then the owner]

1. **[Claude]** Prepares the first SQL statement of `supabase/README.md` step 5 for the pilot dealership, the dealership alone, for the check in 3 (its manager's invite code and its pilot row come when 3 makes it again); **[Owner]** runs it in the Dashboard's SQL editor.
2. **[Owner]** The signed-in checks, run in your own terminal so the token never goes into the chat. Sign in once in the manager view with a test address that belongs to no dealership. In the browser's developer tools (F12, **Application**, **Local storage**, the manager view's address) open the entry `sb-<project ref>-auth-token` and copy only the value of its `access_token` field (the long text starting `eyJ`), never the whole entry: it also holds the refresh token, which keeps that session open. It works for an hour. Then, in Windows PowerShell in the repository folder, run these three lines one at a time, and paste the token at the prompt the first one shows (it is not typed into a command, which keeps it out of the terminal's history file but shows it on screen, so do this where nobody can see your screen):

   ```
   $env:LOTSYNC_TEST_TOKEN = Read-Host 'access_token'
   npm run check-deploy
   Remove-Item Env:LOTSYNC_TEST_TOKEN
   ```

   (On macOS or Linux: `read -rs LOTSYNC_TEST_TOKEN`, paste the token and press Enter (nothing shows), then `export LOTSYNC_TEST_TOKEN`, `npm run check-deploy` and `unset LOTSYNC_TEST_TOKEN`.) Then click **Sign out** in the manager view, which ends that test session. Paste only the printed `ok`, `FAIL` and `note` lines into the thread for Claude to read; `check-deploy` never prints the token or a key. Done when no line reads `FAIL`.
3. **[Owner]** On two computers, two test salespeople sign in and redeem invite codes; a car marked posted on one goes to the dealership's account at once (while signed in, **Mark posted** syncs right away), shows on the other computer after that computer's next scan or its **Sync now** (Settings, Account), and the manager view shows both salespeople. That is the launch checklist's "Supabase project live" and "The posted registry syncs". Run it with test addresses of your own, not step 2's, and codes made for the test with step 5's invite statement: two salesperson codes (`'salesperson'` in place of `'manager'`) and a manager code for the address you open the manager view with. The test's members, posts and scans land in the pilot dealership's Team card, seat count and numbers (a car recorded with **Mark posted** records no post timing), and a removed member's posts stay in the numbers. A browser's first sync to a dealership sends, under whichever account is signed in, the post timings, the to-do items and the posts not synced yet that it holds for that website, and a test browser keeps its copy of the test afterwards. So:
   - **Run the check in a Chrome profile made for it** on each computer: add a Chrome profile without signing in to Chrome there, so Chrome sync stays off and a test name typed in Settings never reaches your synced profile, and load Lot Current into it as `README.md` says. Read the emailed sign-in codes on your phone, not in that profile: if Chrome offers to sign the profile in (it does when you sign in to a Google mailbox there), say no. Open the manager view for the check in one of those test profiles too, signed in with the manager code's test address, not in the browser profile you use every day. Never run the check in a browser that has used Lot Current on the store's website, such as your own at the store. The check would send that browser's real posts and post timings into the test dealership, to be deleted with it. And **Clear everything for this website** removes everything Lot Current holds for the website in that browser, the real posted list and Numbers included, after which nothing flags those listings when a car sells or its price changes. If the check already ran in such a browser, stop and ask Claude before clearing anything or deleting the dealership.
   - **Record the test's car with Mark posted** (Ready to post tab), not by publishing it on Marketplace. If a test car was published, take that listing down on Facebook yourself before the profile goes: nothing will flag it afterwards.
   - **When the check is done**, before the store's manager first signs in, **delete the Chrome profile made for the check on each test computer**. That removes everything Lot Current kept in it.
   - **Delete the dealership** (`supabase/README.md`, "Delete": `select public.delete_dealership('<id>', '<its website_origin exactly as stored>');`) and make it again with step 5's three statements: the dealership, the manager's invite code, which you keep for the manager, and its pilot row with the signed agreement's start date and length. If the agreement is not signed yet, run the pilot row the day it is; until then the weekly list of dealerships with no plan (`supabase/README.md`, "Dealerships with no plan") shows the dealership.

---

## What's in the repository for this

| File | What it does |
|---|---|
| `scripts/set-project.mjs` (`npm run set-project`) | Writes the project URL and publishable key into both config files; `--check` says whether the manager view may deploy |
| `.github/workflows/supabase.yml` | The by-hand database and functions deploy, and **verify**, the read-only comparison of production with the repository; every run ends in `check-deploy` |
| `.github/workflows/manager.yml` | The manager view's deploy to Cloudflare Pages |
| `manager/_headers` | The manager view's security headers on Cloudflare (the page's own policy plus "no site may frame this page") |
| `scripts/check-hosting.mjs` (`npm run check-hosting`) | The outside check for the hosted manager view (address, headers, project, its supabase-js copy, CNAME) and the sender's DNS records; the Manager view workflow runs it after every deploy, and on its own with **Check only** |
| `scripts/check-deploy.mjs` | The outside check; tells publishable, anon and secret keys apart and fails if a secret key is in a file browsers read |
| `supabase/functions/_shared/auth.ts` | The functions prefer the new publishable and secret keys and fall back to the legacy ones |
