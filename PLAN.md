# Lot Sync: 12-week plan

Dates start Monday Sept 28, 2026. Every milestone has acceptance criteria and a demo. The non-negotiables in CLAUDE.md apply to every milestone.

## Status

| Milestone | Weeks | State |
|---|---|---|
| M1 One-click post | Sep 28 – Oct 11 | Built on Sep 26, unit and e2e tests green; awaiting the first live (unpublished) check on the real form |
| M2 Batch, upkeep, wizard, rescans | Oct 12 – Oct 25 | Not started |
| M3 Pilot | Oct 26 – Nov 8 | Needs the Waynesburg manager's sign-off |
| M4 Accounts and manager view | Nov 9 – Nov 22 | Not started |
| M5 Billing, site, Web Store | Nov 23 – Dec 6 | Not started |
| M6 Design partners | Dec 7 – Dec 20 | Not started |

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
5. The first live run against the real form is done with the owner present, without publishing, and any field-finding fixes are made in `formMap.js` only.

Demo: scan the Waynesburg site, click Post on a ready car, watch the form fill, review the description, close the tab without publishing, show the recorded flow and the test run.

What the owner has to do: load the unpacked extension and try one car (README, "Try it on one real car without publishing"); optionally set up the rewrite service (backend/README.md) with an Anthropic API key.

## M2, weeks 3–4 (Oct 12 – Oct 25): batch queue, upkeep, wizard, automatic rescans

Scope
- Batch queue: select several ready cars (or all new arrivals) and "Post 5 cars"; the panel walks through them one at a time (prefill, the salesperson clicks Publish, record, next). Skip, Pause and Stop always available; state in chrome.storage; the queue can't exceed the remaining daily cap.
- Listing upkeep: each To do item gets a button that opens the right listing (saved URL or Marketplace "Your listings") with the new price pre-filled; sold cars open the listing for the salesperson to click Mark as sold or Delete; Lot Sync marks the item done, detecting it automatically when possible.
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
- Positioning (`marketing/positioning.md`), the pricing hypothesis in one config, the sales sheet and the 10-minute demo script, shaped by pilot feedback.

Acceptance criteria
1. Each pilot salesperson posts at least 5 cars through Lot Sync and keeps them updated for two weeks.
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
- Landing page in `site/` (static, mobile-first): hero, how it works, features, "What Lot Sync won't do", pricing, FAQ with an honest "Is this allowed on Facebook?", demo request form, legal links, "Not affiliated with Meta Platforms, Inc."
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

## Open risks

- Facebook's form is a custom React UI; `formMap.js` was written from public knowledge and is verified only against the mock. Expect to adjust a few name patterns on the first live run. The design makes that a minutes-long fix.
- Meta's Terms: a person publishing is the safest design available, not a guarantee. This stays in the product copy and the legal drafts until an attorney says otherwise.
- The live inventory had no motorcycle on Sep 26, so vehicle-type detection for bikes is a best-effort guess until a real record can be inspected.
