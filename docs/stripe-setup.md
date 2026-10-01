# Stripe billing: the owner's steps

Billing is built (`supabase/functions/billing/`, the manager view's Billing card) and switched off: nothing charges anyone until a Stripe account exists and the billing function has its secrets. This page is the owner's path from no account to a test-mode subscription that works end to end, then the later switch to live mode. `supabase/README.md`, "Billing", is the reference behind it.

Everything here is **test mode** until the last section. Test mode uses test cards and moves no money. Stripe keeps test and live objects apart, so nothing made here leaks into live mode.

Who does what: steps marked **[owner]** need the owner's own account, browser or terminal. Claude prepares the code and checks the output; Claude never holds a Stripe key.

## What you need first

- The Supabase project, with its database and functions deployed by the Supabase workflow (`docs/production-setup.md` steps 1 to 3). Billing can be prepared before that (steps 1 to 3 below); the webhook and the deploy wait for the project. No `supabase` command line is needed: every deploy to the production project goes through that workflow.
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

The prices are a hypothesis until a dealer pays. If `pricing.json` changes, `npm run stripe-setup` reports the difference and changes nothing; `npm run stripe-setup -- --apply --reprice` makes the new price (subscribers already paying keep theirs), and the printed line has the new id to set. Their seat counts stay right: the billing function counts seats by the `lotcurrent` tag every price the script makes carries, and the old price keeps it.

## 4. Create the webhook [owner runs]

With the Supabase project's ref (the 20 letters in `https://<ref>.supabase.co`; the project exists, and its address is the `url` in `extension/src/accountConfig.js`):

```
npm run stripe-setup -- --apply --webhook-url <ref>
```

It creates the endpoint at `https://<ref>.supabase.co/functions/v1/billing/webhook` for exactly the five events billing handles, and prints a second line, `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...`. Stripe shows that signing secret only this once: put it in the function's secrets (step 5) before closing the window, and do not paste it anywhere else. If it is lost, delete the endpoint in the Dashboard (Developers, Webhooks) and run the command again.

## 5. Give the billing function its secrets and deploy it [owner sets the secrets; Claude runs the deploy with the owner's go]

In the Supabase Dashboard, **Edge Functions, Secrets**, add each name with its value:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the `sk_test_...` key from step 2 |
| `STRIPE_PRICE_ROOFTOP`, `STRIPE_PRICE_SEAT`, `STRIPE_PORTAL_CONFIGURATION` | the ids on the line step 3 printed |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_...` on the line step 4 printed |
| `ALLOWED_RETURN_ORIGINS` | `https://<the manager view's address>` |

The `supabase secrets set ...` lines steps 3 and 4 printed do the same from a terminal where the `supabase` command is signed in, with `--project-ref <ref>` added to each. `ALLOWED_RETURN_ORIGINS` is the manager view's address with no path; it must also be in `ALLOWED_ORIGINS`. Leave `STRIPE_AUTOMATIC_TAX` unset for now (the last section).

Then the billing function goes up the way every production deploy does: the **Supabase** workflow (`docs/production-setup.md`, step 3), run from the default branch. **plan** first; if it lists a migration (billing's are `0004_billing.sql` and `0009_cancel_at.sql`), **database**; then **functions** with `billing` in the box (the default deploys all four); then **check**, which runs `npm run check-deploy` and should now show every billing line as ok. Not `supabase db push` or `supabase functions deploy` from your own terminal: the workflow deploys the committed code with the pinned command line, only to the project the config files name, and `supabase/config.toml` already turns the gateway's token check off for billing (`verify_jwt = false`), so Stripe's webhook gets through with no extra flag.

## 6. Try it as a manager would [owner, about 15 minutes]

Signed in to the manager view as a manager of a test dealership:

1. **Start the free pilot.** The Billing card shows the pilot's end date. No card is asked for.
2. **Subscribe.** Stripe Checkout opens with the price. Pay with the test card `4242 4242 4242 4242`, any future date, any CVC, any ZIP. Back on the manager view the card says Subscribed, with the first charge at the end of the pilot.
3. **Manage billing.** Stripe's portal opens with the card, the invoices and Cancel. Cancel, then come back: the card says "cancelled: it ends" with the date, instead of "first charge" or "renews". Undo the cancellation in the portal if you want to keep testing: the card goes back to the renewal date.
4. **A failed payment.** With a second test dealership, start the pilot and subscribe with `4000 0000 0000 0341`: Checkout accepts it, because nothing is charged during the pilot, and any later charge to it fails. A failed charge does not end a running pilot (the free period was promised), so end the pilot first: in the Supabase Dashboard, Table editor, `subscriptions`, set that dealership's `pilot_ends_at` to a time in the past. Then in the Stripe Dashboard open that subscription and end its trial now; the first charge fails. The card says Lapsed, "The last payment did not go through.", and the extension stops syncing for that dealership (the sync function answers 402) until the card is updated in Manage billing (use 4242 there; Stripe retries the invoice). Skip the Table editor step and the card stays on "Free pilot" with the days left, and syncing carries on: that is the pilot rule, not a missed webhook.
5. **The founding rate.** Dashboard, Product catalog, Coupons, `lotcurrent-founding`, add a promotion code (for example FOUNDING). On Checkout, "Add promotion code" takes it and the total drops.

In the Supabase Dashboard, Table editor, `subscriptions` shows each change; Edge Functions, billing, Logs shows each webhook event arriving. Anything that does not match these steps: paste the card's line and the log line into the thread.

## Later: switching to live mode [owner, money]

Not before the company exists and the attorney has answered the sales-tax question (`docs/launch-checklist.md`).

1. Activate the Stripe account: the company's legal name, EIN, address, the business bank account for payouts.
2. Sales tax, as the attorney advises. If tax is to be collected: turn on Stripe Tax, set the default tax behavior to exclusive and add the registrations in the Dashboard (Stripe Tax charges a fee per transaction: decide with the price), then add the function secret `STRIPE_AUTOMATIC_TAX` = `true` (Dashboard, Edge Functions, Secrets). Checkout then asks for the billing address and adds the tax. Until the word `true` is set, no tax is added.
3. With the live secret key (`sk_live_`): `npm run stripe-setup -- --apply --live --webhook-url <ref>`. The `--live` flag is required; without it a live key is refused before anything is read.
4. Replace the function secrets with the printed ids, the new webhook secret and the live key, as in step 5 (Dashboard, Edge Functions, Secrets); then the Supabase workflow's **check** step. The function itself is the one already deployed: nothing is redeployed for the live switch.
5. Optional and safer: instead of the full live secret key, give the function a restricted key that may only write customers, Checkout Sessions and portal sessions (Developers, API keys, Create restricted key; check the permission names on that screen). The setup script itself still needs the full key, so run it from your own terminal only.
6. Run step 6 once with a real card and a real dealership of your own, then refund it from the Dashboard.

## What never happens

- Lot Current never charges a card itself: Stripe Checkout does, after the manager enters it and confirms.
- Nothing changes seats or prices on its own; the webhook only copies what Stripe says.
- No Stripe key is in this repository, in the extension or in the manager page. The billing function holds them as secrets, and the setup script reads the key from your terminal and never prints it.
