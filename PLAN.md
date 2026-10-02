# Lot Current: 12-week plan

Dates start Monday Sept 28, 2026. Every milestone has acceptance criteria and a demo. The non-negotiables in CLAUDE.md apply to every milestone.

## Status

| Milestone | Weeks | State |
|---|---|---|
| M1 One-click post | Sep 28 – Oct 11 | **Done Sep 27**: single posts run clean on the live form (six live runs drove the fixes) |
| M2 Batch, upkeep, wizard, rescans | Oct 12 – Oct 25 | **Built Sep 27** (all four features, tests green), then a multi-reviewer pass found 29 defects, all fixed the same day. Verified live: the queue. Still to try on the real site: the wizard's permission step, a background rescan, and upkeep's listing pages (the sold/removed wording in `listingSigns.js` and the edit form's Price box) |
| M3 Pilot | Oct 26 – Nov 8 | **Started Sep 28**: the pilot numbers (time per post, fields not filled, hours until sold cars and price changes were fixed) are recorded and exported from the popup's Numbers tab (called Pilot until 0.5.0); the runbook is `PILOT.md`; positioning, the pricing hypothesis, the sales sheet, the demo script, the pilot offer and the onboarding emails are in `marketing/`. Waiting on the owner: the M2 live checks, the attorney's answers (sections 1 and 2), the manager's sign-off |
| M4 Accounts and manager view | Nov 9 – Nov 22 | **Built Sep 28**: Supabase schema with RLS and SQL tests, the `rewrite`, `sync` and `billing` functions, sign-in and sync in Settings and the worker, the manager view with a sample-data mode. **Project created** by the owner (named in `extension/src/accountConfig.js` and `manager/config.js` by `npm run set-project`); it holds the database up to `0008_usage.sql` and all four functions (the three above and the website's `lead`), deployed before the Supabase workflow's first run. Still to do, in `docs/production-setup.md`'s order: the migrations after `0008_usage.sql` and a **verify** run, the sign-in emails and their sender, the hosted manager view and the first dealership; then the two-machine and manager demos can be run for real |
| M5 Billing, site, Web Store | Nov 23 – Dec 6 | **Built Sep 28, code only**: Stripe Checkout and portal through the billing function, the Billing card, the plan state in Settings, the landing page with sandbox screenshots, the store listing draft and the packed zip. Waiting on the owner: the Stripe account, the hosted Terms and Privacy, real screenshots, the attorney's pass, the submission |
| M6 Design partners | Dec 7 – Dec 20 | **Launch kit built Sep 28** (help, support process, launch checklist, next-platform memo, store-install emails). Partners and the next platform need the owner: named dealers and a real site to verify against (this container cannot reach dealer websites) |

## M1, weeks 1–2 (Sep 28 – Oct 11): one-click post

Scope
- Chrome side panel with the guided post flow (`extension/sidepanel.*`).
- One-click post: opens Facebook's create-vehicle-listing page and pre-fills vehicle type, year, make, model, mileage, price, body style, colors, fuel type, transmission, location, description and photos. Title status and condition are filled from the dealership's defaults in Settings (Clean / Very good; added Sep 27 at the owner's request), shown in the panel as assumptions, and left blank with a warning when the website's own text mentions a branded title.
- Fresh single-VIN fetch at post time (all photos, description, features) and a second pass through the pre-owned and ready checks before anything is filled.
- Description source verified on the live site (done Sep 26: the search service's `description` field mixes a lot-wide disclaimer, raw equipment dumps and, on some cars, a real write-up; `features` is a clean list). `description.js` strips text found on 30%+ of the lot, bullets, award lines and equipment dumps.
- Description rewriter: the template version (`rewriteTemplate.js`) with guardrails (every number in the source, banned phrases, dealer name present, 60–120 words, no shouting, "one owner" only with the Carfax flag); the Claude version through `backend/` once an Anthropic API key exists. The extension only calls the backend when it is switched on in Settings.
- Post detection (listing address on the Facebook tab) with a "Did it post?" confirmation and a paste-the-link field; the post is recorded with VIN, listing URL, price, time and salesperson.
- Daily cap (default 10) enforced in the popup and the panel.
- `legal/` drafts and the attorney question list, so attorney review runs in parallel.
- CLAUDE.md, PLAN.md, CHANGELOG.md, README for testers.

Acceptance criteria
1. On a real ready car at Waynesburg, one click on Post opens the Marketplace form filled in within about 10 seconds, with everything except title status and condition, and the panel lists anything it couldn't fill with a copy button.
2. The salesperson clicks Publish (or, during development, closes the tab without publishing); the panel records the post, which appears under My listings with the listing link when it was detectable.
3. No code path can click Publish, Update, Delete or Mark as sold (`test/posting.test.js`).
4. `npm test` passes (85 tests) and the two Playwright end-to-end tests pass against the mock dealer site and the mock Marketplace form. (Both green on 2026-09-26.)
5. The first live run against the real form is done with the owner present, without publishing, and any field-finding fixes are made in `formMap.js` only. (Done: six live runs on Sep 27 found slow one-at-a-time dropdowns, price reformatting, same-named towns, a late-restored draft and typeahead boxes that commit on blur; single cars and a queue now run with nothing under "Couldn't fill".)

Demo: scan the Waynesburg site, click Post on a ready car, watch the form fill, review the description, close the tab without publishing, show the recorded flow and the test run.

What the owner has to do: load the unpacked extension and try one car (README, "Try it on one real car without publishing"); optionally set up the rewrite service (backend/README.md) with an Anthropic API key.

## M2, weeks 3–4 (Oct 12 – Oct 25): batch queue, upkeep, wizard, automatic rescans

Scope
- Batch queue: select several ready cars (or all new arrivals) and "Post 5 cars"; the panel walks through them one at a time (prefill, the salesperson clicks Publish, record, next). Skip, Pause and Stop always available; state in chrome.storage; the queue can't exceed the remaining daily cap.
- Listing upkeep: each To do item gets a button that opens the right listing (saved URL or Marketplace "Your listings") with the new price pre-filled; sold cars open the listing for the salesperson to click Mark as sold or Delete; Lot Current marks the item done, detecting it automatically when possible.
- First-run wizard in the side panel: choose store, enter name, grant the dealer-site permission (`optional_host_permissions`), read `legal/posting-rules.md`, run the first scan.
- Automatic rescans every 3 hours while Chrome is open (`chrome.alarms`), keeping the VIN double-check and the mass-disappearance guard; toolbar badge with the to-do count; optional desktop notification.
- Multi-dealer foundation: move platform code into `extension/adapters/` with detect(page), scan(options), normalize(record), getDetails(vin); `dealerInspire.js` holds today's code; TODO stubs for Dealer.com, DealerOn, Dealer eProcess, DealerFire.

Acceptance criteria
1. 5 cars go out with one start click plus 5 Publish clicks by the salesperson, and the queue survives closing the panel.
2. A sold car and a price change on the To do tab each open the right listing ready to fix, and the item is marked done afterwards.
3. The wizard completes on a fresh profile; rescans run on the alarm with the badge updating; the daily cap blocks the 11th post.
4. Unit tests for the queue, the adapter interface and the alarm scheduling; e2e extended for the queue and an upkeep button.

Demo: fresh profile, wizard, first scan, queue of 5, then the mock site "sells" one and drops a price, badge updates, To do buttons open the listings.

## M3, weeks 5–6 (Oct 26 – Nov 8): pilot at Waynesburg

Scope
- Pilot with 2–3 Waynesburg salespeople, manager's approval first. Track time per post, prefill failures (which field, how often), and how long sold cars stay listed.
- Weekly fixes.
- Positioning (`marketing/positioning.md`), the pricing hypothesis in one config (`marketing/pricing.json`), the sales sheet and the 10-minute demo script, shaped by pilot feedback. (Drafted Sep 28, before feedback; the pilot offer email and the onboarding emails too.)
- The numbers, recorded by the extension itself (`extension/src/pilot.js`, the Numbers tab, CSV export) and defined in `PILOT.md`.

Acceptance criteria
1. Each pilot salesperson posts at least 5 cars through Lot Current and keeps them updated for two weeks.
2. Median time per post under 60 seconds including review; prefill failure rate per field recorded and the top failure fixed.
3. Every sold car flagged within one rescan cycle; the manager confirms the numbers.

Demo: the pilot dashboard numbers (even if from a spreadsheet) and one salesperson posting live.

## M4, weeks 7–8 (Nov 9 – Nov 22): accounts, sync and manager view

Scope
- Supabase: magic-link sign-in, Postgres with row-level security per dealership, Edge Functions for /rewrite (auth, rate limit, monthly cost cap; replaces `backend/`) and /sync.
- Store only what's needed: dealership, users, the posted registry (VIN, listing URL, prices, times, who posted) and scan summaries. No Facebook data beyond listing URLs the salesperson saved.
- Manager view as a simple web page: posts per salesperson, listings still up for sold cars and for how long, price mismatches.

Acceptance criteria
1. Two salespeople on two machines see the same posted registry; a manager sees both.
2. The rewrite endpoint refuses unauthenticated calls and stops at the monthly cap.
3. RLS tests: a user from dealership A cannot read dealership B.

Demo: sign in by magic link, post on one machine, see it on the other and on the manager page.

## M5, weeks 9–10 (Nov 23 – Dec 6): billing, landing page, Web Store

Scope
- Stripe Billing: per-rooftop subscription, free pilot period, customer portal.
- Landing page in `site/` (static, mobile-first): hero, how it works, features, "What Lot Current won't do", pricing, FAQ with an honest "Is this allowed on Facebook?", demo request form, legal links, "Not affiliated with Meta Platforms, Inc."
- Chrome Web Store submission, unlisted first; listing text, 5 screenshots, privacy-practices answers (`legal/chrome-web-store-privacy.md`).
- Legal docs updated from attorney feedback; Terms and Privacy acceptance added to the wizard.

Acceptance criteria
1. A new dealer can subscribe, start a pilot period and manage billing without help.
2. The landing page scores well on mobile and the demo form lands in Supabase or an inbox.
3. The Web Store review passes (or the rejection reasons are logged and fixed).

Demo: sign up from the landing page to a subscribed, installed, posting salesperson.

## M6, weeks 11–12 (Dec 7 – Dec 20): design partners

Scope
- Onboard 3–5 design-partner dealers, sister stores (Cranberry, Pleasant Hills) first.
- Help doc, support inbox, launch checklist.
- Pick the next website platform based on demand (Dealer.com, DealerOn, Dealer eProcess or DealerFire).

Acceptance criteria
1. Each partner dealer has at least two active salespeople and one manager using the manager view.
2. Support requests are answered within one business day and logged.
3. The next platform is chosen with a written reason and a named first dealer.

Demo: the partner list with usage numbers, and the chosen next platform.

## Marketing and legal, running alongside

- `marketing/positioning.md`, the pricing hypothesis config, the Web Store listing plan, the sales sheet, the demo script, the pilot offer email and the 3-email onboarding sequence: M3 and M5. No invented testimonials, logos, reviews or statistics.
- Launch plan: Waynesburg (manager sign-off first), then Cranberry and Pleasant Hills, then nearby western Pennsylvania dealers. Channels: in-person demos, the DealerRefresh forum, LinkedIn outreach to used car managers, local dealer association events. Track demos to pilots to paid customers, time per post, and how long sold cars stay listed.
- `legal/`: drafted in M1 (this repo), attorney review in parallel, updated in M5.

## Wider use (audit of 2026-09-28)

The owner wants Lot Current built for any dealership. An audit for single-dealer, single-platform and single-machine assumptions found 44 items; 21 were fixed in 0.4.0 (CHANGELOG). The rest ride with their milestone:
- M4 (done Sep 28 unless noted): the daily cap per salesperson across machines (the sync answer's post count); one storage-key module (`src/storageKeys.js`); the shared rewrite key replaced by sign-in; local retention (500 entries, 90 days, per list). The pilot runbook for a second dealer on the manager view is in PILOT.md (Sep 28).
- M5: blank Schedule A, the pilot agreement's table, the store-install emails, the wizard's Price step and the Terms and Privacy acceptance (informational until hosted) are done (Sep 28). The Pilot tab is renamed Numbers (Sep 28). Still open: the Web Store answers and legal drafts rewritten with the attorney.
- M6: the adapter contract is complete (probe and search per adapter, normalise inside the adapter, opaque service, photo hosts; Sep 28); readers for DealerOn and Dealer.com were then written from public sources at the owner's request (2026-10-01) and have not read a real website yet: a survey run (`docs/survey.md`) confirms or corrects them, and M6's next platform, chosen with a written reason and a named first dealer, is still open. The store-name heuristic is per website and the boilerplate rule has a floor (Sep 28). Still open: a Spanish form map with a Spanish-speaking partner.
- Decided by the owner on 2026-09-29 (a permission change): a photo server's permission is asked for at post time, from the salesperson's own click in the side panel, with Chrome's prompt (`src/photoHosts.js`; `optional_host_permissions` already has `https://*/*`). The static image host stays in `host_permissions` until the Web Store release. Still open: one run in real Chrome to see the prompt, since the tests can't answer it.

## Open risks

- Facebook's form is a custom React UI that Facebook can change at any time. `formMap.js` was verified on the live form (six runs on 2026-09-27, every field), but a change on Facebook's side can stop a field filling; the "Couldn't fill" reason and the dry run's report say what the form shows, and the design makes the fix a minutes-long one in `formMap.js`.
- Meta's Terms: a person publishing is the safest design available, not a guarantee. This stays in the product copy and the legal drafts until an attorney says otherwise.
- The live inventory had no motorcycle on Sep 26, so vehicle-type detection for bikes is a best-effort guess until a real record can be inspected.
