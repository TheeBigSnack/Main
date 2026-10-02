# Stripe billing: the owner's steps

Billing is built (`supabase/functions/billing/`, the manager view's Billing card) and switched off: nothing charges anyone until a Stripe account exists and the billing function has its secrets. This page is the owner's path from no account to a test-mode subscription that works end to end, then the later switch to live mode. `supabase/README.md`, "Billing", is the reference behind it.

Everything here is **test mode** until the last section. Test mode uses test cards and moves no money. Stripe keeps test and live objects apart, but the database does not: the rows the test-mode webhook writes into `public.subscriptions` (Stripe ids, a status such as active, the period's end) stay there until the live switch resets them (the last section, step 5). While the function has a test key, the manager view's Billing card says so to everyone who opens it: "Billing is in Stripe test mode: only Stripe's test cards work, nothing is charged, and a subscription started now does not carry over when real billing starts." Every manager who opens the page then sees that line, including a real pilot dealership's manager on the same project.

Who does what: steps marked **[owner]** need the owner's own account, browser or terminal. Claude prepares the code and checks the output; Claude never holds a Stripe key.

## What you need first

- The Supabase project, with its database and functions deployed (`docs/production-setup.md` steps 1 to 3). The production project has both: its first eight migrations and all four functions, `billing` among them, were deployed outside the Supabase workflow before its first run, so the billing function is there without any of its Stripe secrets, and answers with what is missing until step 5 sets them and redeploys it from this repository. No `supabase` command line is needed: every deploy to the production project goes through that workflow.
- The address the manager view will be served from (for example `https://app.lotcurrent.com`). Stripe sends a manager back there after paying.
- Node 22 or later and this repository on your machine, as for `npm test`.

## 1. Make the Stripe account [owner]

Sign up at stripe.com with the business email. There is no monthly fee; Stripe takes a percentage of each live payment. Test mode needs no company details and no bank account; live mode does (the last section). Stay in test mode (Stripe may call it a sandbox) for everything until then.

## 2. Copy the test secret key [owner]

In the Stripe Dashboard: Developers, API keys, the **Secret key** that starts `sk_test_`. Treat it like a password: it goes into your terminal at a prompt (step 3) and into the Supabase function secrets, never into a chat message, an email, a file in this repository or a command line. A terminal keeps every command typed or pasted into it in a history file on your computer (on Windows PowerShell, `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`; on macOS or Linux, `~/.zsh_history` or `~/.bash_history`), so a key written into a command stays there in plain text.

## 3. Create the products, prices, coupon and portal [owner runs, Claude checks]

In a terminal in the repository folder. On Windows PowerShell:

```
$env:STRIPE_SECRET_KEY = Read-Host 'Stripe secret key'
npm run stripe-setup
```

The first line asks for the key: paste it at the prompt and press Enter. Pasted there, it is an answer, not part of a command, so the history file does not keep it. PowerShell does show the key on screen as you paste it, so do this where nobody can see your screen, and close the window when you are done. It stays set in that window only; `Remove-Item Env:STRIPE_SECRET_KEY` or closing the window clears it.

(On macOS or Linux: `read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY`, paste the key (nothing shows) and press Enter, then `npm run stripe-setup`; `unset STRIPE_SECRET_KEY` clears it.)

If a key was ever typed into a command instead, delete that line from the history file named in step 2, or roll the key in the Stripe Dashboard (Developers, API keys).

That first run only reads. On a new account each object's line says FAIL and "missing": nothing exists yet (the webhook line is a note until step 4). Then create them:

```
npm run stripe-setup -- --apply
```

This makes, from `marketing/pricing.json`:

- the product, named Lot Current, which is what a manager sees on Checkout and on invoices;
- the rooftop price (the monthly price per store, which includes the salespeople `includedSalespeople` names) and the extra-salesperson price, both monthly, with sales tax (once it is turned on) added on top of the price rather than taken out of it;
- the founding-dealer coupon `lotcurrent-founding`: the rooftop price less the founding rate, for the founding months, at most the founding count of dealerships;
- the Billing Portal settings: a manager can update the card, see invoices, change the billing email and address, and cancel at the end of the paid period. A manager cannot change the plan or seats there; seats are changed by a person (`supabase/README.md`, "Adding seats to a running subscription").

Once the legal pages are final (not while they say draft), add `--site-url https://lotcurrent.com` to a run with `--apply` so the portal links the Terms and the Privacy Policy.

It prints a `supabase secrets set ...` line with the ids. Keep it for step 5. Running it again creates nothing new; it reports what exists. Paste the output of a plain `npm run stripe-setup` (no `--apply`) into the thread and Claude will check it: that run never prints a secret.

The prices are a hypothesis until a dealer has agreed to one in writing (`docs/launch-checklist.md`, "Pricing confirmed"); then `pricing.json` says `"hypothesis": false`, and not before. Test mode runs on the hypothesis; live mode waits for it (the last section). If `pricing.json` changes, `npm run stripe-setup` reports the difference and changes nothing; `npm run stripe-setup -- --apply --reprice` makes the new price (subscribers already paying keep theirs), and the printed line has the new id to set. Their seat counts stay right: the billing function counts seats by the `lotcurrent` tag every price the script makes carries, and the old price keeps it.

**One setting by hand: when a card keeps failing.** The script does not read or set it, and its output has a `failed payments` note to remind you. In the Stripe Dashboard, Settings, Billing, Subscriptions and emails (newer Dashboards put it under Billing, Revenue recovery, Retries), find what happens when all retries for a payment fail and set **If all retries for a payment fail** to **Cancel the subscription**. Then a dealership that stops paying ends when Stripe's retries run out: its subscription becomes `canceled`, it appears on the weekly retention list (`supabase/README.md`, "The retention line"), and its records are deleted within 30 days, as the Privacy Policy says. Left on "mark the subscription as unpaid" or "leave the subscription past-due", a dealership that never pays again never ends, never appears on that list, and its records are kept with no end date.

## 4. Create the webhook [owner runs]

With the Supabase project's ref (the 20 letters in `https://<ref>.supabase.co`; the project exists, and its address is the `url` in `extension/src/accountConfig.js`), in the window where step 3 set the key (in a new window, set it again the same way):

```
npm run stripe-setup -- --apply --webhook-url <ref>
```

It creates the endpoint at `https://<ref>.supabase.co/functions/v1/billing/webhook` for exactly the five events billing handles, and prints its signing secret on a line of its own, `STRIPE_WEBHOOK_SECRET: whsec_...`. Stripe shows that secret only this once: copy it into the Supabase Dashboard (step 5) before closing the window, and do not paste it anywhere else, a terminal command included. If it is lost, delete the endpoint in the Dashboard (Developers, Webhooks) and run the command again.

## 5. Give the billing function its secrets and deploy it [owner sets the secrets; Claude runs the deploy with the owner's go]

In the Supabase Dashboard, **Edge Functions, Secrets**, add each name with its value:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the `sk_test_...` key from step 2 |
| `STRIPE_PRICE_ROOFTOP`, `STRIPE_PRICE_SEAT`, `STRIPE_PORTAL_CONFIGURATION` | the ids on the line step 3 printed |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_...` step 4 printed |
| `ALLOWED_RETURN_ORIGINS` | `https://<the manager view's address>` |
| `ALLOWED_ORIGINS` | `https://<the manager view's address>` |

The `supabase secrets set ...` line step 3 printed sets the ids from a terminal where the `supabase` command is signed in, with `--project-ref <ref>` added; the ids are not secret. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` go in the Dashboard only, never into a command, which the terminal's history file would keep. Both origins are the manager view's address with no path. `ALLOWED_RETURN_ORIGINS` is where Stripe may send a manager back to; `ALLOWED_ORIGINS` lets the page call the functions at all: without it the browser blocks the Billing card's calls and the card shows only a network error. If `ALLOWED_ORIGINS` already lists an origin (a local page during development, say), keep it and add this one after a comma. Leave `STRIPE_AUTOMATIC_TAX` unset for now (the last section).

Then the billing function goes up the way every production deploy does: the **Supabase** workflow (`docs/production-setup.md`, step 3), run from the default branch. **plan** first; if it lists a migration (billing's are `0004_billing.sql` and `0009_cancel_at.sql`), **database**; then **functions** with `billing` in the box (the default deploys all four); then **check**, which runs `npm run check-deploy` and should now show every billing line as ok. **database** comes before **functions** every time: the billing function writes `subscriptions.cancel_at`, a column only `0009_cancel_at.sql` adds, so on a database without it every subscription event from Stripe fails to save (the webhook answers 500); the **functions** step deploys nothing while a migration is still to be applied. The line about the manager view's preflight needs that page's address: with the `MANAGER_URL` variable on the `production` environment (`docs/production-setup.md`, step 6) the workflow passes it, or run `LOTSYNC_MANAGER_ORIGIN=https://<the manager view's address> npm run check-deploy` from your own terminal (it only reads). Until then that line is a note, not an ok. Not `supabase db push` or `supabase functions deploy` from your own terminal: the workflow deploys the committed code with the pinned command line, only to the project the config files name, and `supabase/config.toml` already turns the gateway's token check off for billing (`verify_jwt = false`), so Stripe's webhook gets through with no extra flag.

Then the manager view's Billing card is turned on: **[Claude]** sets `billing: true` in `manager/config.js`, changes the line in `test/manager.test.js` that holds it `false` (the Manager view workflow runs that test before it deploys, so it stops there otherwise), and commits, and the Manager view workflow deploys the page (`docs/production-setup.md` step 6). Until then the page calls no billing route: a manager can still start the free pilot (`start_pilot()` is in the database), and the card says paying by card is not open yet, with no **Subscribe** or **Manage billing**. The website says so too (`site-src/pages/for-managers.html` and `pricing.html`): change those pages in the same commit and run `npm run site-pages`.

## 6. Try it as a manager would [owner, about 15 minutes]

Signed in to the manager view as a manager of a test dealership (the Billing card says billing is in Stripe test mode): one made for this test, never the pilot store or any real dealership. A pilot starts once and never restarts, and a test-mode subscription stays on the dealership's row, where it reads as subscribed until the live switch resets it. Make it with the first two statements of `supabase/README.md` step 5 (the dealership and its manager's code, no pilot row, so step 1 below can start the pilot), with a made-up name and a made-up website such as `https://billing-test.invalid`, and redeem the code with a test address of your own (the extension's Settings, Account), not the one `check-deploy` signs in with (`docs/production-setup.md` step 7, item 2): that one must belong to no dealership, and the check's wrong codes stop it redeeming any code for an hour.

1. **Start the free pilot.** The Billing card shows the pilot's end date. No card is asked for.
2. **Subscribe.** Stripe Checkout opens with the price. Pay with the test card `4242 4242 4242 4242`, any future date, any CVC, any ZIP. Back on the manager view the card says Subscribed, with the first charge at the end of the pilot.
3. **Manage billing.** Stripe's portal opens with the card, the invoices and Cancel. Cancel, then come back: the card says Cancelled, with the day it ends and that it does not renew (during the pilot: that it ends before the first charge), once Stripe's webhook has arrived; reload if it still says Subscribed. Renew from the portal if you want to keep testing: the card says Subscribed again.
4. **A failed payment.** With a second test dealership, made the same way with another made-up website (`https://billing-test-2.invalid`, say), start the pilot and subscribe with `4000 0000 0000 0341`: Checkout accepts it, because nothing is charged during the pilot, and any later charge to it fails. A failed charge does not end a running pilot (the free period was promised), so end the pilot first: in the Supabase Dashboard, Table editor, `subscriptions`, set that dealership's `pilot_ends_at` to a time in the past. Then in the Stripe Dashboard open that subscription and end its trial now; the first charge fails. The card says Lapsed, "The last payment did not go through. Update the card with Manage billing; syncing starts again once Stripe takes the payment.", and the extension stops syncing for that dealership (the sync function answers 402) until the card is updated in Manage billing (use 4242 there; Stripe retries the invoice). Skip the Table editor step and the card stays on "Free pilot" with the days left, and syncing carries on: that is the pilot rule, not a missed webhook.
5. **The founding rate.** Dashboard, Product catalog, Coupons, `lotcurrent-founding`, add a promotion code (for example FOUNDING). On Checkout, "Add promotion code" takes it and the total drops.

In the Supabase Dashboard, Table editor, `subscriptions` shows each change; Edge Functions, billing, Logs shows each webhook event arriving. Anything that does not match these steps: paste the card's line and the log line into the thread.

## Later: switching to live mode [owner, money]

Not before the company exists and the attorney has answered the sales-tax question (`docs/launch-checklist.md`), and not before that checklist's "Pricing confirmed" item is done: a dealer has agreed to a price in writing, `marketing/pricing.json` holds that price and says `"hypothesis": false`, and `npm test` passes. Until then `npm run stripe-setup -- --live` refuses to read or create anything, because live prices charge real money and the website tells dealers the price is confirmed with them before any paid subscription starts.

1. Activate the Stripe account: the company's legal name, EIN, address, the business bank account for payouts.
2. Sales tax, as the attorney advises. If tax is to be collected: turn on Stripe Tax, set the default tax behavior to exclusive and add the registrations in the Dashboard (Stripe Tax charges a fee per transaction: decide with the price), then add the function secret `STRIPE_AUTOMATIC_TAX` = `true` (Dashboard, Edge Functions, Secrets). Checkout then asks for the billing address and adds the tax. Until the word `true` is set, no tax is added.
3. With the live secret key (`sk_live_`) set at the prompt as in step 3, never typed into a command: `npm run stripe-setup -- --apply --live --webhook-url <ref>`. The `--live` flag is required; without it a live key is refused before anything is read.
4. Replace the function secrets with the printed ids, the new webhook secret and the live key, as in step 5 (Dashboard, Edge Functions, Secrets); then the Supabase workflow's **plan** and, if it lists a migration, **database** (the reset below sets `cancel_at`, which `0009_cancel_at.sql` adds, and fails on a project without it), and its **check** step. The function itself is the one already deployed: nothing is redeployed for the live switch. From now on the Billing card no longer says test mode, and test-mode events no longer pass the webhook's signature check. In live mode, check the failed-payment setting from step 3 again (the Dashboard keeps it apart for each mode): **If all retries for a payment fail** is **Cancel the subscription**.
5. Reset what test mode wrote, right away and before telling any dealership that billing is live. Supabase Dashboard, SQL editor:

   ```sql
   update public.subscriptions
      set stripe_customer_id = null,
          stripe_subscription_id = null,
          status = case when pilot_ends_at is not null then 'pilot' end,
          current_period_end = null,
          cancel_at = null,
          seats = default,
          updated_at = now()
    where stripe_customer_id is not null
       or stripe_subscription_id is not null
       or (status is not null and status <> 'pilot');
   ```

   Every Stripe id, status and date on the rows came from test mode, which the live key cannot see: left there, a test subscription would read as active for good (syncing with nothing charged), Subscribe would refuse it, and Manage billing would find no customer. Free pilots keep their end dates, so a dealership on its pilot stays on it; one whose pilot has ended reads as lapsed and subscribes again in live mode; one that never had a pilot reads as no plan yet. `billing_events` keeps the test events; they are never applied again.
6. Optional and safer: instead of the full live secret key, give the function a restricted key that may only write customers, Checkout Sessions and portal sessions (Developers, API keys, Create restricted key; check the permission names on that screen). The setup script itself still needs the full key, so run it from your own terminal only.
7. Check one real charge end to end, then undo it, on a dealership of your own. Use one that was never used in test mode, and delete the test dealerships step 6 made (`select public.delete_dealership('<id>', '<its website_origin exactly as stored>');`, `supabase/README.md`, "Delete"): the reset in step 5 took their Stripe ids, but they and their test members are test data that nothing else removes. Not by running step 6 again: a pilot moves the first charge to the pilot's end, so Checkout would charge nothing and there would be nothing to refund; the test cards are declined in live mode; and a subscription left running, or renewed in the portal, would charge your card when the pilot ends and every month after. Instead:
   1. Make a dealership of your own with the first two statements of `supabase/README.md` step 5 (the SQL editor, your own website's address, an invite code for yourself as manager; no pilot row) and sign in to the manager view as its manager. The Billing card says No plan yet. Do not click Start the free pilot: with no pilot, Checkout charges the first month at once.
   2. Click Subscribe and pay with your own real card. Back on the manager view the card says Subscribed with the renewal date; in the Supabase Dashboard, Table editor, `subscriptions` shows the row, and Edge Functions, billing, Logs shows `customer.subscription.created` and `invoice.paid` arriving.
   3. In the Stripe Dashboard, in live mode, refund that payment in full, then open the subscription and cancel it **immediately**, not at the end of the period (Manage billing's Cancel only stops it at the period's end, and until then it would renew and charge again). The card then says Lapsed, "The subscription was cancelled."
   4. Leave out the failed payment (6.4): test mode has shown it, and the live card for it would have to be a real one that fails.
   5. Do not use the founding code (6.5) in a live Checkout: the live `lotcurrent-founding` coupon can be redeemed only `foundingDealerCount` times (`marketing/pricing.json`), the stores the pricing page promises the rate to, and one used on your own test is gone for good. Check in the Dashboard instead that the live coupon and its promotion code exist with the right discount.

## What never happens

- Lot Current never charges a card itself: Stripe Checkout does, after the manager enters it and confirms.
- Nothing changes seats or prices on its own; the webhook only copies what Stripe says.
- No Stripe key is in this repository, in the extension or in the manager page. The billing function holds them as secrets, and the setup script reads the key from your terminal and never prints it.
