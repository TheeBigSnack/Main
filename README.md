# Lot Sync (v0.2)

A Chrome extension for dealership salespeople. It reads your dealership website's used inventory, checks every car is really pre-owned, pre-fills a Facebook Marketplace vehicle listing for you to review and publish, and on each rescan tells you what to take down, what to reprice and what's new.

**You click Publish. Lot Sync never does.** It fills in the form and opens pages; a person publishes every post and every edit, and nothing happens in the background or while you're away. Lot Sync is not affiliated with Meta Platforms, Inc.; "Facebook" and "Marketplace" are used here only as the names of the places you post.

## Install (each tester, about 2 minutes)

1. Unzip this folder somewhere it'll stay, like Documents.
2. In Chrome (version 116 or newer), go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder inside this folder.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Lot Sync**.

Chrome will say the extension can read and change data on `www.facebook.com/marketplace` and on the dealer photo host. That is what filling the form and attaching the car's photos needs; it does not read your Facebook password, cookies or messages.

## Use

1. Open the dealership website's used inventory page, e.g. `ronlewischryslerdodgejeepramwaynesburg.com/used-vehicles/`.
2. Click the Lot Sync icon, then **Settings**: your name and role, your store, the dealership's city and ZIP, and the price to post. Save.
3. Click **Scan website**. The first scan is the starting point.
4. **Ready to post** lists pre-owned cars at your store that have photos and a price. Click **Post** on one. The side panel opens and:
   - re-checks the car on the website (still pre-owned, still on the lot, still priced),
   - writes a description from the website's facts, which you can edit,
   - shows what it will fill in, including **Vehicle condition** and **Title status** from your dealership's defaults (Settings), which you can change on the form.
5. Click **Open the Marketplace form**. A new tab opens on Facebook's create-vehicle-listing page and the fields fill in, photos included. Anything it couldn't fill is listed in the panel with a copy button.
6. On Facebook: check every field, including condition and title, then click **Publish** yourself. The panel notices the listing page and asks you to confirm; paste the listing link if it didn't notice. The car moves to **My listings**.
7. Click **Rescan website** any time (once a day is plenty). **To do** shows what to take down (sold, or gone sale-pending), what to reprice (with your listing price next to the website's), and what's new. Click **Updated** or **Taken down** once you've done it on Facebook.

Already listed a car by hand? Use **Mark posted** so rescans watch it too.

### Try it on one real car without publishing

1. Load the extension (above) and open the Waynesburg used inventory page.
2. Settings: enter your name, tick Waynesburg, enter the city (Waynesburg), state (PA) and ZIP, keep "the website's main price", save. Scan.
3. On **Ready to post**, click **Post** on any car. Read the description in the side panel; edit a line if you like.
4. Click **Open the form and check fields only**. Sign in to Facebook if it asks (Lot Sync never sees that). The panel reports which of the 13 fields it can find on the page and which it can't, without filling anything. If any are missing, click **Copy report** and paste it into a Claude Code session, or fix the name pattern yourself in `extension/facebook/formMap.js`; each fix is one line.
5. When the fields are found, click **Fill it in now** and watch the form fill. Compare the panel's "Filled in" list with the form; note anything under "Couldn't fill" or "Needs a click".
6. **Close the Facebook tab without clicking Publish.** In the panel click **It didn't post**, then **Back**. Nothing was posted or recorded.

Two unpublished live runs on Sept 27, 2026 filled 12 of 13 fields on the real form (Make pending a check). They showed that Facebook draws dropdown lists slowly and one at a time, reformats the price, and suggests same-named towns in other states first; the fill code and the mock form now handle all of that. If a field still fails, the "Couldn't fill" reason says why, and the dry run's report shows what the page calls its controls. Please also note the exact wording next to the photo upload (e.g. "Add up to N photos") so the photo limit can be read from the page.

## Settings

- **You**: name and role, used in every description's sign-off ("I'm Roger, sales consultant at Ron Lewis CDJR Waynesburg"). Posing as a private seller isn't allowed.
- **Your store**: only cars at ticked stores count as ready.
- **Dealership**: name, city, state, ZIP. Enter the ZIP: Marketplace's location box suggests every town with that name (there are Waynesburgs in Ohio and Kentucky too), and Lot Sync only accepts a suggestion in your state.
- **Your profile follows you.** Name, role, dealership, price basis, note and cap are also kept in Chrome's synced storage, so they come back after clearing a website's data or reloading the extension, and appear on any computer where you're signed in to Chrome. A Lot Sync account shared with your manager is Milestone 4.
- **VIN check.** The side panel checks each car's VIN before posting: format and check digit, the model year and the manufacturer encoded in it, against what the website says. "Check with NHTSA" fetches the full free government decode (make, model, body, fuel, engine, drive) and lists every difference. Chrome asks for permission to reach vpic.nhtsa.dot.gov the first time. The VIN never changes what gets posted by itself; it flags what to look at.
- **Price to post**: the website's main price (on this site it includes the $490 doc fee) or the price before fees. The price note explains it in every description; a note is suggested from what the website's prices show.
- **Listing defaults**: title status (Clean by default) and vehicle condition (Very good by default) are filled in on every listing; on Facebook's form that means the "This vehicle has a clean title" box is ticked. A car whose website text mentions rebuilt, salvage or a lien gets no title default and a warning instead. These are statements about each car that your dealership stands behind; choose "Leave blank" to answer them per car.
- **Safety**: posts per day per salesperson (default 10; raise it in Settings if your store expects more, e.g. 30). Meta doesn't publish its limits; this is a safety setting, not a guarantee.
- **Description writer**: off by default. With the rewrite service running (see `backend/README.md`), first drafts come from Claude, and for a car whose website record gives no usable color, the service looks at the photos and guesses one from Facebook's list (shown as a guess, never overriding a stated color). Either way every draft is checked: every number must be on the website, no banned claims ("no accidents", "best price in town"), the dealership must be named, the VIN must be there, 60 to 120 words.

Each salesperson's scans, settings and posted list are kept only in their own browser, separately per website.

## What Lot Sync won't do

- Click Publish, Update, Delete or Mark as sold. Ever. There is no code for it and a test that fails if any appears.
- Post new, demo or loaner cars, or anything the pre-owned check can't confirm.
- Invent prices or price drops. The listed price is the website price, and price changes only mirror the website.
- Make claims the website's data doesn't support, or hide that the car is at a dealership.
- Ask for, read or store your Facebook password, cookies or tokens; use fake delays, proxies or spoofing; or run more than your one account.

Meta's Terms prohibit accessing its products "using automated means" without permission. Having a person click Publish is the safest design available, but it is not guaranteed safe. See `legal/posting-rules.md`.

## How the pre-owned check works

Three separate signs on the dealer website have to agree the car is pre-owned:

1. the inventory type from the dealer's system (Used / Certified Used / New)
2. the condition word in the car's web address (`/inventory/used-2019-...` vs `/inventory/new-2027-...`)
3. the condition word at the start of the listing title ("Pre-Owned 2019 ...")

A demo or loaner flag always means "sold as new". A Carfax report counts as a supporting sign, but a missing one never blocks a car. Mileage is never used to call a car used. Anything that disagrees or looks off, like a used car showing 0 miles, goes to **Needs a look**. A pre-owned car is **ready to post** only if it has photos, a price, is on the lot, isn't sale-pending, and is at your store. The side panel runs the same checks again on a fresh copy of the record right before it fills the form.

## What the first live test found (Ron Lewis CDJR Waynesburg, Sept 26, 2026)

- 124 used and certified cars on the used page, read in one request (about a third of a second); 617 vehicles in all, all 493 new ones skipped.
- 28 at Waynesburg (55 Cranberry, 41 Pleasant Hills); 20 ready to post; 2 need a look (0 miles shown); 7 pre-owned cars have no Carfax link.
- The website's `description` field mixes a pricing disclaimer that repeats on almost every car, raw equipment dumps on cars nobody has written up, and a real paragraph on the rest (6 of 8 sampled). `features` is a clean list. The description writer uses only the paragraph and the features.
- No motorcycle was on the lot, so vehicle-type detection for bikes is a best-effort guess (body type, then bike-only makes).

## Limits

- Works on Dealer Inspire websites that use the Cars Commerce inventory search (`window.SEARCH_SERVICE` on the page). Other platforms come later (`extension/adapters/` in Milestone 2).
- If more than half the cars vanish between scans, nothing is marked gone and a warning shows.
- The Facebook form map needs a live check (above). Photos go in through the form's file input; if that fails, **Download photos** saves them to your Downloads folder to add by hand.

## For development

```
npm test              # 84 unit tests on real records from the site (Node 20+, no dependencies)
npm install           # Playwright, for the end-to-end tests
npx playwright install chromium
npm run test:e2e      # both e2e tests: the popup/rescan flow and the post flow, against mock sites
```

Never run tests against the real facebook.com. The post e2e uses `test/e2e/mock-marketplace.mjs`, a stand-in form with the same field names, and the test itself clicks Publish in place of the salesperson.

The e2e tests need Playwright's own Chromium build (about 450 MB unpacked): branded Google Chrome and Edge 137+ ignore `--load-extension`, so they can't run them. If your system drive is tight, keep the browser and the throwaway test profiles elsewhere:

```
set PLAYWRIGHT_BROWSERS_PATH=D:\ms-playwright
set TEMP=D:\lotsync-tmp
npx playwright install chromium
npm run test:e2e
```

Rewrite service: `backend/README.md`. Rules for every session: `CLAUDE.md`. Plan: `PLAN.md`.

| File | What it does |
|---|---|
| `extension/src/scan.js` | Runs in the dealer tab; reads the used inventory (plus description and features) and double-checks missing VINs |
| `extension/src/normalize.js` | Turns a website record into a flat vehicle |
| `extension/src/classify.js` | The pre-owned check and the ready-to-post check |
| `extension/src/rescan.js` | Compares scans: sold, price changes, new arrivals; the posted registry |
| `extension/src/description.js` | Strips boilerplate, bullets and equipment dumps from the website's description |
| `extension/src/rewriteTemplate.js` | Template description + the guardrails every draft passes through |
| `extension/src/rewriter.js` | Template by default; optional Claude draft via the backend, checked, with fallback |
| `extension/src/listingData.js` | Vehicle to form values (body style, colors, fuel, transmission, location) |
| `extension/src/vehicleDetails.js` | Post-time fetch of one car and the second check |
| `extension/src/cap.js`, `settings.js` | Daily cap; settings defaults |
| `extension/facebook/formMap.js` | The only place Facebook's fields are described |
| `extension/facebook/fillForm.js` | Injected: fills the form, attaches photos, reports everything |
| `extension/facebook/detectPost.js` | Watches the tab address for the listing page |
| `extension/sidepanel.*` | The guided post flow |
| `extension/background.js` | Downloads photos from the dealer's image host |
| `backend/` | The rewrite service (Anthropic API key lives here, never in the extension) |
| `test/fixtures/records.json` | Real records from the Waynesburg site, one per edge case |
