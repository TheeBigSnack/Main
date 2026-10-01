# Lot Current (v0.5)

A Chrome extension for dealership salespeople. It reads your dealership website's used inventory, checks every car is really pre-owned, pre-fills a Facebook Marketplace vehicle listing for you to review and publish, and on each rescan tells you what to take down, what to reprice and what's new.

**You click Publish. Lot Current never does.** It fills in the form and opens pages; a person publishes every post and every edit, and nothing is posted or edited in the background or while you're away. On its own, and only if you allow it, it re-reads your dealership's website every 3 hours while Chrome is open to keep your to-do count current and, while you are signed in to a Lot Current account, sends that rescan's results (your posted list, post records, to-do items and the scan's counts) to your dealership's account; it never touches Facebook then. Lot Current is not affiliated with Meta Platforms, Inc.; "Facebook" and "Marketplace" are used here only as the names of the places you post.

## Install (each tester, about 2 minutes)

1. Unzip `lot-current-extension-<version>.zip` into a new folder that will stay put, like `Documents\Lot Current`. The zip holds the extension's files themselves (`manifest.json` and the rest), not a folder. Already installed from a folder with the old name? Keep using that folder: Chrome ties the extension's saved data to its folder, so renaming or moving it starts over empty.
2. In Chrome (version 116 or newer), go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose that folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Lot Current**.

Chrome will say the extension can read and change data on `www.facebook.com/marketplace` and on the dealer photo host. That is what filling the form and attaching the car's photos needs; it does not read your Facebook password, cookies or messages.

## Update

When a new zip arrives, unzip it into the same folder, replacing the files, then open `chrome://extensions` and click the reload icon on Lot Current. Your scans, settings and posted list are kept: they live in Chrome's storage, not in the folder. (A new folder would keep Chrome on the old files.)

Which version do I have? `chrome://extensions` shows it under the name, and **Settings** in the popup shows it too.

## Use

1. Open the dealership website's used inventory page, e.g. `ronlewischryslerdodgejeepramwaynesburg.com/used-vehicles/`.
2. Click the Lot Current icon. The first time it offers **Set up Lot Current**: a few steps in the side panel to read the website, pick your store, enter your name, confirm the store's address (read from the website), allow automatic rescans, read the posting rules and, once the Terms of Service and Privacy Policy are published, accept them (the acceptance and its version are kept with your synced profile; Settings shows it and has the same tick). (Or skip it: **Settings** has the same fields.)
3. Click **Scan website** whenever you like. With automatic rescans on, Lot Current also re-reads the website every 3 hours while Chrome is open and shows your to-do count on its icon.
4. **Ready to post** lists pre-owned cars at your store that have photos and a price, newest on the lot first (the menu also offers longest on the lot, price low to high, and name; the choice is remembered for the website). A search box narrows the list as you type, by stock number, the last six characters of the VIN, or the year, make or model. A car that came onto the lot within the last 7 days by the website's in-stock date, or that Lot Current first saw within the last 7 days when the website gives no date (the dealer can change the number in Settings), carries a **New** pill, and under each car one line says where its date comes from: "on the website since [date] · N days on the lot" when the website gives an in-stock date, or "Lot Current first saw it [date]" when only a scan can say, which never counts days on the lot. Click **Post** on one. The side panel opens and:
   - re-checks the car on the website (still pre-owned, still on the lot, still priced),
   - writes a description from the website's facts, which you can edit,
   - shows what it will fill in, including **Vehicle condition** and **Title status** from your dealership's defaults (Settings), which you can change on the form, and under **Assumed: check these on the form** every value that took a reading of the website's words (a mild hybrid listed as Hybrid, a body style from the car's page address), with those words. A word the form has no match for is left blank, with the website's words shown. In a queue, a car with anything assumed besides those two defaults waits at this screen rather than opening the form by itself.
5. Click **Open the Marketplace form**. A new tab opens on Facebook's create-vehicle-listing page and the fields fill in, photos included. Anything it couldn't fill is listed in the panel with a copy button.
6. On Facebook: check every field, including condition and title, then click **Publish** yourself. The panel notices the listing page and asks you to confirm; paste the listing link if it didn't notice. The car moves to **My listings**.
7. Click **Rescan website** any time (or let the automatic rescans do it). **To do** shows what to take down (sold, or gone sale-pending), what to reprice (with your listing price next to the website's), and what's new.
   - **Open & update price** opens your listing in a new tab. Click **Edit listing** on Facebook; the side panel puts the website's new price in the Price box the moment it appears and tells you what the box shows. Click **Update** yourself. The panel notices the new price on the listing and ticks the item off.
   - **Open listing** on a sold car opens your listing. Click **Mark as sold** (or **Delete**) yourself; the panel notices and ticks the item off.
   - **Updated** and **Taken down** tick an item off by hand if you did it another way.

Already listed a car by hand? Use **Mark posted** so rescans watch it too.

8. **Numbers** shows the numbers the pilot agreement lets Lot Current record, kept in this browser: how long each post took (from the click on Post to "It's posted", your review included), which form fields it couldn't fill, and how long sold cars and price changes stayed on your listings. **Download CSV** gives your manager the spreadsheet; **Copy summary** is for the weekly check-in. No customer data, nothing from Facebook beyond your own listings, and never the description text. `PILOT.md` defines each number.

### Several cars at once (the queue)

On **Ready to post**, tick the cars (or **Select the next N**, which ticks the first N in the order shown, after the search box; a tick stays while you search for the next car, and **Post N cars** counts every ticked car) and click **Post N cars** (the button reads **Post selected** until you tick); on **To do**, **Queue all ready arrivals** does the same for new arrivals. The side panel then takes them one at a time: it re-checks the car, writes the description and, when every check passes, opens and fills the Marketplace form straight away (a car with a warning stops at the review screen so you see it). You check the form and click **Publish**; the panel notices the listing, records it and loads the next car. Prefer drafts? Click Facebook's **Save draft** instead, then **Saved as draft, next car** in the panel; the car shows as "Draft on Facebook" on the Ready tab until you publish it there and mark it posted. **Skip**, **Pause** and **Stop** are always in the panel's queue bar, the queue survives closing the panel, and it can't be longer than the day's remaining cap (N in **Select the next N** is what is left today); at the cap the tick boxes and Post buttons go away until tomorrow.

Facebook sometimes opens the create-listing page with a saved draft or an unfinished listing already in it (another car). Lot Current notices, replaces every field it manages, reads each one back and reports what the form actually shows, and puts a red warning in the panel so you remove that car's photos or discard the draft before publishing.

### Try it on one real car without publishing

1. Load the extension (above) and open your dealership's used inventory page (the pilot's is `ronlewischryslerdodgejeepramwaynesburg.com/used-vehicles/`).
2. Settings: enter your name, tick your store; city, state and ZIP are filled from the website, check them; keep "the website's main price", save. Scan.
3. On **Ready to post**, click **Post** on any car. Read the description in the side panel; edit a line if you like.
4. Click **Open the form and check fields only**. Sign in to Facebook if it asks (Lot Current never sees that). The panel reports which of the 13 fields it can find on the page and which it can't, without filling anything. If any are missing, click **Copy report** and paste it into a Claude Code session, or fix the name pattern yourself in `extension/facebook/formMap.js`; each fix is one line.
5. When the fields are found, click **Fill it in now** and watch the form fill. Compare the panel's "Filled in" list with the form; note anything under "Couldn't fill" or "Needs a click".
6. **Close the Facebook tab without clicking Publish.** In the panel click **It didn't post**, then **Back**. Nothing was posted or recorded.

Six live runs on Sept 27, 2026 shaped the fill code: Facebook draws dropdown lists slowly and one at a time, reformats the price, suggests same-named towns in other states first, restores a saved draft over the form a few seconds after it opens, and its Make and Model boxes commit their first suggestion on blur. The fill code and the mock form now handle all of that, and single cars and a queue ran on the real form with nothing under "Couldn't fill". If a field ever fails again, the "Couldn't fill" reason says what the form showed, and the dry run's report lists what the page calls its controls.

## Settings

- **You**: name and role, used in every description's sign-off ("I'm [name], [role] at [dealership]"; at the pilot store that reads "I'm Roger, sales consultant at Ron Lewis CDJR Waynesburg"). Posing as a private seller isn't allowed.
- **Your store**: only cars at ticked stores count as ready.
- **Dealership**: name, city, state, ZIP. The scan fills these from the store's address on the website itself (its structured data), so normally there is nothing to type; what you type wins. Marketplace's location box suggests every town with the same name (many towns share a name across states; the pilot's Waynesburg exists in Ohio and Kentucky too), and Lot Current only accepts a suggestion in your state.
- **Your profile follows you.** Your name, role and listing defaults follow you anywhere; the dealership part (name, address, price basis, price note and daily cap) belongs to that dealership's website and does not travel to another site. Both are kept in Chrome's synced storage, so they come back after clearing a website's data or reloading the extension, and appear on any computer where you're signed in to Chrome. A Lot Current account shared with your manager is Milestone 4.
- **VIN check.** The side panel checks each car's VIN before posting: format and check digit, the model year and the manufacturer encoded in it, against what the website says. "Check with NHTSA" fetches the full free government decode (make, model, body, fuel, engine, drive) and lists every difference. Chrome asks for permission to reach vpic.nhtsa.dot.gov the first time. The VIN never changes what gets posted by itself; it flags what to look at.
- **Price to post**: the website's main price, or the lower second price some websites show (usually the price before the doc fee; only offered when the website shows one). A price note can be typed in Settings and goes into every description; Lot Current suggests one from the gap the website shows but never fills it in for you. Installs from before 0.4.0 keep the note they had; a new machine starts with none until it is typed (the suggestion is one click away).
- **Listing defaults**: title status (Clean by default) and vehicle condition (Very good by default) are filled in on every listing; on Facebook's form that means the "This vehicle has a clean title" box is ticked. A car whose website text mentions rebuilt, salvage or a lien gets no title default and a warning instead. These are statements about each car that your dealership stands behind; choose "Leave blank" to answer them per car.
- **Safety**: posts per day per salesperson (default 10; raise it in Settings if your store expects more, e.g. 30). Meta doesn't publish its limits; this is a safety setting, not a guarantee.
- **Account** (optional, Milestone 4): sign in with a code sent to your email, and your posted list and pilot numbers sync to your dealership's account so a colleague's machine and the manager view see them; a manager's invite code joins you to the dealership. Until the owner has set the account service up (`extension/src/accountConfig.js`), the section only says so and nothing is contacted. The sign-in is kept in your browser's local storage, never in the synced profile.
- **Description writer**: off by default. With the rewrite service running (see `backend/README.md`), first drafts come from Claude, and for a car whose website record gives no usable color, the service looks at the photos and guesses one from Facebook's list (shown as a guess, never overriding a stated color). Either way every draft is checked: every number must be on the website, no banned claims ("no accidents", "best price in town"), the dealership must be named, the VIN must be there, 60 to 120 words.

Each salesperson's scans, settings and posted list are kept only in their own browser, separately per website.

## What Lot Current won't do

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

A demo or loaner flag means "sold as new"; if the website also calls the car pre-owned and nowhere new, it goes to **Needs a look** instead. A trailer, RV, powersport vehicle or boat goes to **Needs a look** too (Lot Current fills in only the car/truck and motorcycle forms), unless it is skipped as new. A car the website lists as damaged or refurbished goes to **Needs a look**, unless it is already skipped as new: a demo or loaner flag, or a new sign with no pre-owned one, decides first. A Carfax report counts as a supporting sign, but a missing one never blocks a car. Mileage is never used to call a car used. Anything that disagrees or looks off, like a used car showing 0 miles, goes to **Needs a look**. A pre-owned car is **ready to post** only if it has photos, a price, is on the lot, isn't sale-pending, and is at your store. The side panel runs the same checks again on a fresh copy of the record right before it fills the form.

## Limits

- Works on Dealer Inspire websites that use the Cars Commerce inventory search (`window.SEARCH_SERVICE` on the page), checked on the pilot dealer's live site. DealerOn and Dealer.com websites have readers of their own, built from public documentation and a survey of local dealer websites and tested only on sample websites: open the used inventory page, wait until the cars show, then Scan. Neither has read a real DealerOn or Dealer.com website yet. Lot Current also tries any other website that publishes standard vehicle data (schema.org) on its car pages; that reader has been tested only on sample websites, so no other platform is known to work until a real site has been scanned. Each platform is one file under `extension/adapters/`.
- Photos on a server Lot Current has not been allowed to download from yet: Chrome asks from your click on **Open the Marketplace form** (or Fill it in now, Fill again, or Download photos) and remembers a yes. Say no and the form is still filled, without those photos; Lot Current doesn't ask about that server again while the side panel stays open, unless you click **Allow photos from ...**.
- If more than half the cars vanish between scans, nothing is marked gone and a warning shows.
- The Facebook form map needs a live check (above). Photos go in through the form's file input; if that fails, **Download photos** saves them to your Downloads folder to add by hand.

## For development

```
npm test              # 939 unit tests, many on real records from the site (Node 22 or newer, no dependencies)
npm install           # Playwright, for the end-to-end tests
npx playwright install chromium
npm run test:e2e      # eight e2e flows against mock sites: popup/rescan, post, queue, wizard + background rescan, upkeep, standard vehicle data, DealerOn + Dealer.com, posting from the side panel
npm run screenshots   # the landing page's product images, taken from the sandbox with sample data (site/screenshots/)
npm run site-pages    # the website's pages, robots.txt, llms.txt (and sitemap.xml, CNAME once config.js has siteUrl) from site-src/pages/ and site/config.js (--check: exit 1 when a file differs)
npm run legal-pages   # the Terms, Privacy Policy and posting rules as site/legal/*/index.html from legal/*.md, plus the redirect stubs at the old addresses (--check: exit 1 when a page differs; legal/legal-status.json says draft)
npm run favicons      # favicon.ico, favicon-32.png and apple-touch-icon.png from site/favicon.svg
npm run social-images # the 1200x630 share image per page (site/social/) from site-src/social/template.html
npm run test:site     # every page of site/ in headless Chromium: no console error or warning, no failed request, title and canonical as generated
npm run test:a11y     # accessibility: labels, names, contrast, a focus ring on every control the Tab key reaches (every page of the website, manager view, popup, side panel, the sandbox page)
npm run test:sql      # the Supabase SQL checks on a local Postgres (PGHOST etc.; CI runs them on Postgres 16)
npm run check-deploy  # after the Supabase deploy: a checklist of what the live project lets a stranger do (supabase/README.md step 6)
npm run set-project -- https://<ref>.supabase.co sb_publishable_...  # point the extension and manager view at the production project (docs/production-setup.md)
npm run check-hosting -- --app https://app.<domain>/ --sender mail.<domain>  # the hosted manager view and the sign-in sender's DNS, from the outside
npm run store-check   # the Chrome Web Store preflight: manifest limits, no code from another host, every module present, the packed zip equals extension/, listing text and image sizes; lists what is still open before a submission (-- --strict: exit 1 while anything is; store/submission.md)
npm run store-screenshots  # fits the owner's captures in store/screenshots/raw/ onto 1280x800 (store/screenshots.md; both folders stay out of git)
npm run extension-icon  # redraws extension/icons/icon128.png from site/favicon.svg with the store's 16-pixel transparent margin
npm run release -- 0.6.0  # stamp a new version in the three files, test and pack; prints the commit, tag and upload steps (docs/release.md)
npm run survey -- <used-inventory URL> [...]  # a polite look at a real dealer website: its platform, its markup, and what Lot Current reads from it (docs/survey.md; reports in survey-out/)
```

Never run tests against the real facebook.com. The post, queue and upkeep e2es use `test/e2e/mock-marketplace.mjs`, a stand-in form (and listing and edit pages) with the same field names, and the test itself clicks Publish, Update and Mark as sold in place of the salesperson.

The e2e tests need Playwright's own Chromium build (about 450 MB unpacked): branded Google Chrome and Edge 137+ ignore `--load-extension`, so they can't run them. Run the flows one at a time (`npm run test:e2e` does; `npm run test:e2e:parallel` runs two at a time on a machine with room), not alongside `npm test`. On Linux, `npx playwright install --with-deps chromium` also installs the system libraries Chromium needs. If your system drive is tight, keep the browser and the throwaway test profiles elsewhere:

```
set PLAYWRIGHT_BROWSERS_PATH=D:\ms-playwright
set TEMP=D:\lotsync-tmp
npx playwright install chromium
npm run test:e2e
```

Rewrite service: `backend/README.md`. Rules for every session: `CLAUDE.md`. Plan: `PLAN.md`. The pilot: `PILOT.md`. Positioning, pricing hypothesis, sales sheet, demo script and emails: `marketing/`. Help for salespeople and managers: `docs/help.md`.

Test drive without installing: `npm run demo`, then open http://127.0.0.1:8765/demo/. The real popup, side panel and service worker run against a sample dealership website and a sample Marketplace form inside one page (`demo/`; sample data only, nothing there is Facebook). `npm run test:demo` drives the whole flow in headless Chromium; CI runs it too.

Website: `site/` is the Lot Current website as served, one committed HTML file per page (home, how it works, pricing, FAQ, for managers, support, the legal documents, a custom 404 page), each written by `npm run site-pages` from a fragment under `site-src/pages/` and by `npm run legal-pages` from `legal/*.md`; plain HTML, CSS and one ES module, no build step, nothing loaded from another host. Everything that needs the site's own address comes from `siteUrl` in `site/config.js`, which stays empty until the owner has the domain (the generator reports "siteUrl is not set" until then). Hosting is GitHub Pages through `.github/workflows/pages.yml`. How to turn Pages on, point the domain and fill in the config: `docs/website.md`.

| File | What it does |
|---|---|
| `extension/src/scan.js` | Injected into the dealer tab: the neutral probe (site name, address); each platform's probe and search live in its adapter |
| `extension/src/normalize.js` | Turns a website record into a flat vehicle |
| `extension/src/classify.js` | The pre-owned check and the ready-to-post check |
| `extension/src/rescan.js` | Compares scans: sold, price changes, new arrivals; the posted registry |
| `extension/src/description.js` | Strips boilerplate, bullets and equipment dumps from the website's description |
| `extension/src/rewriteTemplate.js` | Template description + the guardrails every draft passes through |
| `extension/src/rewriter.js` | Template by default; optional Claude draft via the backend, checked, with fallback |
| `extension/src/listingData.js` | Vehicle to form values (body style, colors, fuel, transmission, location) |
| `extension/src/vehicleDetails.js` | Post-time fetch of one car and the second check |
| `extension/src/cap.js`, `settings.js` | Daily cap; settings defaults |
| `extension/src/pilot.js` | The pilot numbers: post timings, fill failures per field, hours until sold cars and price changes were fixed; the summary and the CSV |
| `extension/facebook/formMap.js` | The only place Facebook's fields are described |
| `extension/facebook/fillForm.js` | Injected: fills the form, attaches photos, reports everything; fills the edit form's price; reads a listing page |
| `extension/facebook/listingSigns.js` | How a listing page reads once it is sold or removed (text only, never a control) |
| `extension/facebook/detectPost.js` | Watches the tab address for the listing page |
| `extension/sidepanel.*` | The guided post flow, the queue, the first-run wizard and listing upkeep |
| `extension/wizard.js`, `upkeep.js` | The wizard steps; the To do follow-through (open the listing, fill the new price, notice the change) |
| `extension/adapters/` | One file per dealer-website platform behind a small interface; `dealerInspire.js` reads the lot in pages, de-duplicates by VIN, double-checks missing VINs and makes the direct service call the background rescan uses |
| `extension/src/scanRunner.js`, `rescanSchedule.js` | The scan pipeline shared by popup, wizard and service worker; when rescans are due and what the badge says |
| `extension/background.js` | Downloads photos; rescans every known website every 3 hours and keeps the badge current |
| `backend/` | The rewrite service (Anthropic API key lives here, never in the extension) |
| `supabase/` | The accounts: schema with row-level security, the `rewrite`, `sync` and `billing` Edge Functions, SQL tests (`supabase/README.md`) |
| `manager/`, `site/`, `demo/` | The manager view, the website (its pages written by `scripts/site-pages.mjs` and `scripts/legal-pages.mjs` from `site-src/` and `legal/`; `docs/website.md`) and the in-browser test drive; static pages, sample-data modes, their own tests |
| `test/fixtures/records.json` | Real records from the Waynesburg site, one per edge case |
