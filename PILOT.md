# Pilot runbook (Milestone 3): the first pilot at Waynesburg

Written for the first pilot; the bracketed values and the checklist apply to any dealer. The popup tab that shows the numbers is called **Numbers** (it was called Pilot until 0.5.0; the view id and the storage key still say `pilot`). A second dealership runs on the accounts and the manager view: the last section.

Two weeks of real posting by 2 or 3 salespeople at Ron Lewis CDJR Waynesburg, with the used car manager's sign-off, weekly fixes, and numbers the manager can confirm. The plan and acceptance criteria are in `PLAN.md` (M3); the rules in `CLAUDE.md` apply throughout. This file is the checklist and the definitions.

## What "done" means (from PLAN.md)

1. Each pilot salesperson posts at least 5 cars through Lot Current and keeps them updated for two weeks.
2. Median time per post under 60 seconds including review; the prefill failure rate per field is recorded and the top failure fixed.
3. Every sold car is flagged within one rescan cycle, and the manager confirms the numbers.

Demo at the end: the pilot numbers (the Numbers tab's CSV, even if it ends up in a spreadsheet) and one salesperson posting live.

## Before the pilot starts

Owner's list, in order. Nothing under "Before every pilot" runs until the one-time items and the manager's sign-off are done.

### Once, before the first pilot

- [ ] **Live checks of Milestone 2** on the Waynesburg site (HANDOFF.md section 9): the wizard with "Allow automatic rescans", a background rescan and the badge, one price update and one take-down on real listings. Fix `listingSigns.js` / `formMap.js` from what the pages show.
- [ ] **Attorney answers**, at least on section 1 (Meta's Terms, how to describe the risk) and section 2 (the founder's employment at the pilot dealer) of `legal/questions-for-attorney.md`, before the pilot agreement is signed.

### Before every pilot

- [ ] **Manager's sign-off** at [dealer]: `legal/pilot-agreement.md` filled in and signed, the [N salespeople] named in it. Send `marketing/pilot-offer-email.md` first; demo with `marketing/demo-script.md`.
- [ ] Each of the [N salespeople] gets `lot-current-extension-<version>.zip` (`npm run pack`) and the Install steps (in `README.md`, and written out in the day-0 email, since the README is not in the zip; later zips come with the Update steps), runs the wizard including the rescan permission and the posting rules, and deletes old Marketplace drafts. `marketing/onboarding-emails.md` days 0, 2 and 7 cover this.
- [ ] Settings on each machine: name and role, [dealer]'s store ticked, address from the website (check it), the price note (Settings suggests wording from the website's price gap; accept it, or the manager's wording, and save before the first post: a new machine starts with none), defaults Clean / Very good, cap [10] unless the manager wants otherwise, rescans on.
- [ ] Optional: the rewrite service (`backend/README.md`) with an Anthropic API key, if the owner wants Claude-drafted descriptions in the pilot. Off by default; the template writer is the fallback either way.

## During the pilot

**Daily (each salesperson):** post from Ready to post, clear To do items the day they appear (Open listing → Mark as sold; Open & update price → Update), and when the panel shows **Couldn't fill**, copy the report and send it.

**Weekly (owner, with the manager):**
1. Collect the numbers: each salesperson clicks **Numbers → Download CSV** (or **Copy summary** for the chat). Without accounts the numbers live in each salesperson's own browser, per website, so the first pilot is one CSV per person; a pilot on the accounts reads the manager view instead ("Running a pilot at a second dealership", below).
2. Fill in the log below.
3. Fix the top prefill failure that week (one line in `formMap.js` when Facebook changed a name; `listingSigns.js` when a listing page reads differently), re-run `npm test` and the e2e flows, and send the new `lot-current-extension-<version>.zip` (`npm run pack`) and the Update steps in `README.md`.
4. Ask the manager to confirm sold cars against the store's own records: did every one show up on To do within 3 hours of leaving the website?

**Pilot log** (copy a row per week into this file or a spreadsheet):

| Week | Salesperson | Posts (posted / drafts / not posted) | Median s per post | Within 60 s | Top field failure (rate) | Sold cars flagged / taken down / median h | Price changes flagged / updated / median h | Fix shipped |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |

## What the numbers mean (so the manager can check them)

Recorded by `extension/src/pilot.js`, per website, in the salesperson's browser, under `pilot:<origin>`. The Numbers tab shows them; the CSV has every row.

- **Time per post:** from the click on **Post** in the popup or in the side panel's own list (or the queue loading the car) to **It's posted** in the side panel. That includes the website re-check, the description, the salesperson's review, the form filling, their own check of the form and their click on Publish. A car left open (the panel closed on it, Back, Stop queue) is recorded as abandoned and is not in the median. **Saved as draft** and **It didn't post** are recorded as such.
- **Reason (blocked posts):** why the panel stopped before the form opened: `not-on-website` (the car was no longer on the site at post time), `site-unreachable` (the website could not be read), `check-not-ready`, `check-review` or `check-skip` (the post-time re-check found something missing, signs that disagree, or a car the website now calls new), `no-price` (the website showed no price), `no-permission` (a post started from the side panel without the dealership tab, and Chrome had not been allowed to read the website).
- **Fields:** one entry per fill of the Marketplace form (a "check fields only" dry run is not a fill). Per field: filled, needed a click, couldn't fill, and changed by the form afterwards (a restored draft). Field keys only; no values, no description, nothing about the car.
- **Sold cars and price changes:** a flag starts at the scan (popup, wizard or background) that first put the item on To do for one of the salesperson's own listings. It ends when Lot Current sees the listing page show the change (upkeep, "detected"), when the person clicks Taken down / Updated ("manual"), or when a complete, confirmed scan no longer lists it ("cleared": the car came back or the price went back; not counted in the medians). A scan with a warning (incomplete, or the VIN double-check failed) never clears a flag. The hours are from the flagging scan, so with rescans every 3 hours a car sold at 9:00 and flagged at 11:50 reads from 11:50; the acceptance criterion is about the flag arriving within one cycle, which the manager confirms from the store's records.
- **What is not recorded:** anything about buyers, messages, or the Facebook account; listing links beyond what the posted registry already keeps; the description text.

**Pruning:** each list (post attempts, fills, flags) keeps its newest 500 entries and nothing older than 90 days (`MAX_ENTRIES` and `PILOT_RETENTION_DAYS` in `extension/src/pilot.js`), applied each time a number is recorded; an open flag stays until it is closed. A two-week pilot is never affected, but a longer engagement must collect the CSV weekly, since the CSV is the only complete record.

**Clearing:** **Numbers → Clear the numbers** (two clicks), or **Settings → Clear everything for this website**. The pilot agreement (section 6) says pilot records Lot Current holds are deleted within 30 days of the end unless the dealer subscribes; those records are the CSVs the owner collected and, for a dealership on accounts, its rows in the database (`supabase/README.md`, "Export or delete a dealership's data": the weekly retention line, a pilot ended early, and the dealerships with no plan).

## Weekly fixes: the loop

1. A **Couldn't fill** report arrives (pasted from the panel). Reproduce it in `test/e2e/mock-marketplace.mjs` if the mock doesn't already behave that way.
2. Fix it in `extension/facebook/formMap.js` (a name pattern) or `fillForm.js` (a behaviour), never anywhere else on the Facebook side.
3. `npm test`, then the e2e flow that covers it (`npm run test:e2e:post` for a fill, `:upkeep` for a listing page).
4. Commit, note it in `CHANGELOG.md` under the pilot week, send the new `lot-current-extension-<version>.zip` (`npm run pack`) and the Update steps in `README.md` to the salespeople.

## After two weeks

- Put the final CSVs and the manager's confirmation in the log above.
- Decide with the manager: continue into a subscription (`legal/dealer-subscription-agreement.md`, pricing from `marketing/pricing.json`, billing in Milestone 5), extend the pilot, or stop. A pilot on the accounts is extended by the owner's statement in `supabase/README.md` step 5 ("A pilot of the length a signed pilot agreement names") with the new end date; nothing in the manager view or the extension can extend one.
- For a dealership on accounts that stops, or whose pilot either party ends early on notice: record the end in the database that day (`supabase/README.md`, "A pilot ended early"), offer its manager the export, and delete its records within 30 days of the end (pilot agreement section 6); the weekly retention line lists it until then.
- With the store's written permission (pilot agreement section 3), the confirmed numbers go into `marketing/sales-sheet.md`. Without it, nothing about the store is published.
- Update `PLAN.md` (M3 state). The next dealership runs on the accounts and the manager view, which replace one CSV per person: the section below.

## Running a pilot at a second dealership

The first pilot ran without accounts, so its numbers were one CSV per person. A second dealership runs on the Milestone 4 accounts (`supabase/`) and the manager view (`manager/`). Everything above still applies: the one-time items, the manager's sign-off, the daily list, the definitions, the pruning and the weekly fixes. What is different:

1. **The account, once** (owner; `supabase/README.md`, "The first dealership and its manager"): insert the dealership with its website's origin, one single-use invite code for the manager, made by the statement in the README (it expires in 7 days), and its pilot row with the signed agreement's start date and length (the README's pilot statement, "A pilot of the length a signed pilot agreement names", with the agreed end date, run before the manager signs in whatever the length), so the dealership is on its pilot until the agreement's end and lapses then unless the dealer subscribes; the manager's **Start the free pilot** is then not offered. The manager redeems that code in the extension's Settings (**Account**: **Send me a sign-in code**, **Sign in**, the code, **Join**), signs in to the manager view (**Send me a sign-in link**; no password), and from then on makes one code per salesperson there: **Invite a salesperson** in its Invite codes card (`create_invite`). A code works once and for 7 days and goes to one person; never forward one. The card lists the open codes with their expiry and can **Revoke** one; the owner's first-manager code is minted in SQL, never typed by hand.
2. **Salespeople install and join** with the emails in `marketing/onboarding-store.md` ("To each salesperson"): install, then set-up on the dealership's website, which asks for **Send me a sign-in code**, **Sign in**, the invite code and **Join** (Settings → Account does the same later). From the first sign-in each person's posted list and numbers sync to the dealership's account after every rescan and every recorded post; two machines signed in as one person share one daily cap.
3. **Settings on each machine** as in "Before every pilot", and the price note typed once: Lot Current suggests wording from the website's price gap and never fills it in; the manager's wording is typed into Settings once per person and follows them through their synced profile. That is the only place a dealer fact is typed. Nothing about the store (a name, a town, a fee, a store pattern) goes into code, the manifest or the copy; the pilot dealer is a fixture, and what Lot Current learned from one lot it re-derives on every website.
4. **The weekly loop reads the manager view**, not a CSV per person: the **Salespeople** table (posted this week, median seconds per post), **Sold cars still listed** (hours open, red past the overdue line) and **Price changes not yet updated** (the same), with the last-scan line above them. The day-7 email in `marketing/onboarding-store.md` walks the manager through the three tables; fill in the pilot log from them (the view's **Download CSV** gives the same rows in a spreadsheet). The Numbers tab's **Download CSV** is only for a machine that is offline: no account yet, or a sync that keeps failing (the Account line in Settings says when it last synced). The form-field records never leave the browser, so the top prefill failure still comes from the panel's **Couldn't fill** reports and the Numbers tab's field table.
5. **Fixes ship the same way**: `formMap.js` or `listingSigns.js`, `npm test`, the e2e flow, then a new zip, or the Web Store update once the listing is live.
