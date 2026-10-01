# Stripe billing: the owner's steps

Billing is built (`supabase/functions/billing/`, the manager view's Billing card) and switched off: nothing charges anyone until a Stripe account exists and the billing function has its secrets. This page is the owner's path from no account to a test-mode subscription that works end to end, then the later switch to live mode. `supabase/README.md`, "Billing", is the reference behind it.

Everything here is **test mode** until the last section. Test mode uses test cards and moves no money. Stripe keeps test and live objects apart, but the database does not: the rows the test-mode webhook writes into `public.subscriptions` (Stripe ids, a status such as active, the period's end) stay there until the live switch resets them (the last section, step 5). While the function has a test key, the manager view's Billing card says so to everyone who opens it: "Billing is in Stripe test mode: only Stripe's test cards work, nothing is charged, and a subscription started now does not carry over when real billing starts." Every manager who opens the page then sees that line, including a real pilot dealership's manager on the same project.

Who does what: steps marked **[owner]** need the owner's own account, browser or terminal. Claude prepares the code and checks the output; Claude never holds a Stripe key.

## What you need first

- The Supabase project and the `supabase` command line (`supabase/README.md` steps 1 to 6). Billing can be prepared before that (steps 1 to 3 below); the webhook and the deploy wait for the project.
- The address the manager view will be served from (for example `https://app.lotcurrent.com`). Stripe sends a manager back there after paying.
- Node 22 or later and this repository on your machine, as for `npm test`.

## 1. Make the Stripe account [owner]

Sign up at stripe.com with the business email. There is no monthly fee; Stripe takes a percentage of each live payment. Test mode needs no company details and no bank account; live mode does (the last section). Stay in test mode (Stripe may call it a sandbox) for everything until then.

## 2. Copy the test secret key [owner]

In the Stripe Dashboard: Developers, API keys, the **Secret key** that starts `sk_test_`. Treat it like a password: it goes into your terminal and into the Supabase function secrets, never into a chat message, an email or a file in this repository.

## 3. Create the products, prices, coupon and portal [owner runs, Claude checks]

In a terminal in the repository folder. On Windows PowerShell:

```
$env:STRIPE_SECRET_KEY = 'sk_test_...'
npm run stripe-setup
```

(On macOS or Linux: `STRIPE_SECRET_KEY=sk_test_... npm run stripe-setup`.)

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

The prices are a hypothesis until a dealer pays. If `pricing.json` changes, `npm run stripe-setup` reports the difference and changes nothing; `npm run stripe-setup -- --apply --reprice` makes the new price (subscribers already paying keep theirs), and the printed line has the new id to set.

## 4. Create the webhook [owner runs]

With the Supabase project's ref (the 20 letters in `https://<ref>.supabase.co`; the project exists, and its address is the `url` in `extension/src/accountConfig.js`):

```
npm run stripe-setup -- --apply --webhook-url <ref>
```

It creates the endpoint at `https://<ref>.supabase.co/functions/v1/billing/webhook` for exactly the five events billing handles, and prints a second line, `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...`. Stripe shows that signing secret only this once: run the line before closing the window, and do not paste it anywhere else. If it is lost, delete the endpoint in the Dashboard (Developers, Webhooks) and run the command again.

## 5. Give the billing function its secrets and deploy it [owner runs]

```
supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_PRICE_ROOFTOP=price_... STRIPE_PRICE_SEAT=price_... STRIPE_PORTAL_CONFIGURATION=bpc_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set ALLOWED_RETURN_ORIGINS=https://<the manager view's address>
supabase secrets set ALLOWED_ORIGINS=https://<the manager view's address>
supabase db push                                # applies any migration the project lacks, such as 0009_cancel_at.sql
supabase functions deploy billing --no-verify-jwt
$env:LOTSYNC_MANAGER_ORIGIN = 'https://<the manager view's address>'
npm run check-deploy
```

The second and third lines are the ones step 3 and step 4 printed. `supabase db push` comes before the deploy, every time: the billing function writes `subscriptions.cancel_at`, a column only `0009_cancel_at.sql` adds, so on a database without it every subscription event from Stripe fails to save (the webhook answers 500) until the push. On a project that has every migration it changes nothing. `ALLOWED_RETURN_ORIGINS` and `ALLOWED_ORIGINS` are both the manager view's address with no path: the first lets Stripe send a manager back there, the second lets the page call the billing function at all (the extension is always allowed). If `ALLOWED_ORIGINS` already lists other addresses, keep them in the same line, comma-separated. Leave `STRIPE_AUTOMATIC_TAX` unset for now (the last section). `check-deploy` should now show every billing line as ok, including "billing: answers the manager view's CORS preflight" (on macOS or Linux: `LOTSYNC_MANAGER_ORIGIN=https://<the manager view's address> npm run check-deploy`).

Then the manager view's Billing card is turned on: **[Claude]** sets `billing: true` in `manager/config.js`, changes the line in `test/manager.test.js` that holds it `false` (the Manager view workflow runs that test before it deploys, so it stops there otherwise), and commits, and the Manager view workflow deploys the page (`docs/production-setup.md` step 6). Until then the page calls no billing route: a manager can still start the free pilot (`start_pilot()` is in the database), and the card says paying by card is not open yet, with no **Subscribe** or **Manage billing**. The website says so too (`site-src/pages/for-managers.html` and `pricing.html`): change those pages in the same commit and run `npm run site-pages`.

## 6. Try it as a manager would [owner, about 15 minutes]

Signed in to the manager view as a manager of a test dealership (the Billing card says billing is in Stripe test mode):

1. **Start the free pilot.** The Billing card shows the pilot's end date. No card is asked for.
2. **Subscribe.** Stripe Checkout opens with the price. Pay with the test card `4242 4242 4242 4242`, any future date, any CVC, any ZIP. Back on the manager view the card says Subscribed, with the first charge at the end of the pilot.
3. **Manage billing.** Stripe's portal opens with the card, the invoices and Cancel. Cancel, then come back: the card says Cancelled, with the day it ends and that it does not renew (during the pilot: that it ends before the first charge), once Stripe's webhook has arrived; reload if it still says Subscribed. Renew from the portal if you want to keep testing: the card says Subscribed again.
4. **A failed payment.** With a second test dealership, start the pilot and subscribe with `4000 0000 0000 0341`: Checkout accepts it, because nothing is charged during the pilot, and any later charge to it fails. In the Stripe Dashboard open that subscription and end its trial now; the first charge fails. The card says the payment failed, and the extension stops syncing for that dealership until the card is updated in Manage billing (use 4242 there; Stripe retries the invoice).
5. **The founding rate.** Dashboard, Product catalog, Coupons, `lotcurrent-founding`, add a promotion code (for example FOUNDING). On Checkout, "Add promotion code" takes it and the total drops.

In the Supabase Dashboard, Table editor, `subscriptions` shows each change; Edge Functions, billing, Logs shows each webhook event arriving. Anything that does not match these steps: paste the card's line and the log line into the thread.

## Later: switching to live mode [owner, money]

Not before the company exists and the attorney has answered the sales-tax question (`docs/launch-checklist.md`).

1. Activate the Stripe account: the company's legal name, EIN, address, the business bank account for payouts.
2. Sales tax, as the attorney advises. If tax is to be collected: turn on Stripe Tax, set the default tax behavior to exclusive and add the registrations in the Dashboard (Stripe Tax charges a fee per transaction: decide with the price), then `supabase secrets set STRIPE_AUTOMATIC_TAX=true`. Checkout then asks for the billing address and adds the tax. Until the word `true` is set, no tax is added.
3. With the live secret key (`sk_live_`): `npm run stripe-setup -- --apply --live --webhook-url <ref>`. The `--live` flag is required; without it a live key is refused before anything is read.
4. Set the printed ids, the new webhook secret and the live key in the function secrets, as in step 5; run `supabase db push` (the reset below sets `cancel_at`, which `0009_cancel_at.sql` adds, and fails on a project without it; on a project that has every migration it changes nothing); `npm run check-deploy`. From now on the Billing card no longer says test mode, and test-mode events no longer pass the webhook's signature check.
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
7. Run step 6 once with a real card and a real dealership of your own, then refund it from the Dashboard.

## What never happens

- Lot Current never charges a card itself: Stripe Checkout does, after the manager enters it and confirms.
- Nothing changes seats or prices on its own; the webhook only copies what Stripe says.
- No Stripe key is in this repository, in the extension or in the manager page. The billing function holds them as secrets, and the setup script reads the key from your terminal and never prints it.
