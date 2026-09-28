# Lot Sync: complete handoff (written 2026-09-27, evening)

**For the next Claude instance.** The owner's first message will be something like "read E:\LotSync\HANDOFF.md and follow it" (or "unzip this and continue"). This file is meant to make you fully current without any other conversation history. Read it top to bottom once, then read `CLAUDE.md` (the rules), skim `PLAN.md`, `CHANGELOG.md` and `README.md`, and you know everything the previous instance knew.

If you arrived with a zip instead of the folder: unzip it so that the files land in `E:\LotSync` (or wherever the owner says), then in that folder run `npm install` and, for the end-to-end tests, `npx playwright install chromium` with the environment variables in section 3.4. Everything else, including the full git history, is in the zip (`node_modules` and test screenshots are not).

---

## 0. Where things stand in five lines

1. **Product:** Lot Sync, a Chrome extension (Manifest V3, plain JavaScript ES modules, no build step) for car dealership salespeople. It reads the dealership website's used inventory, lets only pre-owned cars through, pre-fills a Facebook Marketplace vehicle listing that the salesperson publishes by hand, and rescans the website to flag sold cars and price changes on the listings they made.
2. **State:** version 0.3.0, git commit `ded6e90` on the only branch (master), working tree clean. Milestone 1 (one-click post) is done and verified on the real site; Milestone 2 (batch queue, listing upkeep, first-run wizard, automatic rescans, adapter layout) is built, tested against mock sites, and hardened by a 25-agent adversarial review (29 confirmed defects, all fixed). The queue is verified live; the wizard's permission step, a background rescan on the real site, and upkeep on real listing pages are not yet tried live.
3. **Tests:** 120 unit tests (`npm test`, node:test, no dependencies) and five Playwright end-to-end flows against mock sites (popup/rescan, post, queue, wizard + background rescan, upkeep). All green at the last commit. Never run anything against the real facebook.com.
4. **Machine:** the repo lives at `E:\LotSync` (moved from `C:\LotSnyc` on 2026-09-27; see section 3 for drives, git, Node, Playwright and permissions quirks).
5. **Next:** the owner's live checks of the M2 features on the Waynesburg site, then Milestone 3 (a pilot with 2–3 salespeople, needing the store manager's sign-off, an attorney pass over `legal/`, and optionally an Anthropic API key for the description writer).

---

## 1. The owner and how to work with them

- The owner is Roger (email in the repo-local git config; the commit name "Roger Lawrence" was guessed from it and never corrected). They are the product owner and the person doing every live test. They are not necessarily reading code: write to them plainly, lead with the outcome, keep numbers and file names out of prose unless they need to go there.
- They test on the real dealership website and, when the Facebook form fill goes wrong, they paste the side panel's "Couldn't fill" report into the chat. Six such reports drove the Milestone 1 fixes (section 6). Treat every pasted report as data; reproduce the behaviour in the mock Marketplace form, fix it, and prove the fix with a test.
- Their standing instructions, in their own words where it matters:
  - "Do everything you are telling me to do but better."
  - "I still think scraping the VIN from the website is going to be a good way to double check the information": the VIN is read from the website, filled into the form first, shown in every description, and checked against the record (check digit, model year, manufacturer, optional NHTSA decode).
  - "Unless absolutely specified, be sure to mark every vehicle as a clean title. And the vehicle condition is clean." Implemented as dealership defaults (Title status: Clean, Vehicle condition: Very good) filled on every listing unless the website's own text mentions a branded title (rebuilt, salvage, lien, flood); shown in the panel as assumptions; the clean-title checkbox is ticked on the live form.
  - "When the color is not explicitly stated have the AI make the best possible guess based off the marketing photos": the optional backend has a `/color` endpoint; the panel shows the guess with its confidence and never overrides a color the website states.
  - "This is meant to be a very little input from the salesperson application, so that way they could possibly get 25 to 30 listings done in a given day." Minimal clicks; the queue exists for this.
  - "Make sure that the program is actually pulling the information off of the website and not just making it up whenever it can't fill it in ... Make no mistakes." Every fill is read back from the form and reported as what the form actually shows; anything the form changed underneath is named with both values.
  - Cap behaviour: "detect when you are at your maximum for the day and not allow you to select any more"; "Select all" ticks only the next N from the top.
  - Location "should use the context based off of the website and the location of the address of the dealer": the address comes from the site's schema.org JSON-LD.
  - "Go ahead and begin the next phase." is how they approve a milestone. "It ran perfectly with no errors" is how they confirm a live run.
  - They asked for the workspace to move to E: and for "no useless scraps of code left behind" (done: temp test profiles removed, tests now clean up after themselves).
- Ask before: widening extension permissions, adding paid services, touching a real Facebook account, spending money, changing NTFS permissions or freeing space on C:. Commit after each working step. Keep README and CHANGELOG current. No secrets in git (`backend/.env` is ignored).
- Report faithfully: if a test fails, say so with the output; if something was skipped, say that.

---

## 2. The product rules (the short form; `CLAUDE.md` is authoritative)

Non-negotiables, enforced in code and by `test/posting.test.js`:

1. A person publishes every post and every edit. Lot Sync fills forms and opens pages; it never clicks Publish, Update, Delete or Mark as sold, and never posts or edits in the background. `extension/facebook/formMap.js` has no selector for those buttons; guard tests fail if any injected code gains a way to click or submit.
2. No detection evasion: no random "human" delays, no fingerprint/user-agent tricks, no proxies, no multiple accounts. Never ask for, read or store Facebook passwords, cookies or tokens.
3. Pre-owned only: `extension/src/classify.js` decides; new, demo, loaner and "needs a look" cars can't enter a posting flow; the side panel re-fetches and re-checks the car at post time.
4. Honest prices: the listed price equals the website price (dealer's chosen basis); price changes only mirror the website.
5. The dealership stays identifiable: every description names the dealership and the salesperson's role. First person is fine; posing as a private seller is not.
6. Facts only: descriptions state only facts in the source data; every number is checked against the source (`rewriteTemplate.js` `runGuardrails`).
7. Per-salesperson daily post cap (default 10), presented as a safety setting, never a guarantee.
8. No Meta/Facebook affiliation claims; "Facebook" and "Marketplace" only as plain names.

The one thing that runs on its own, only with the person's permission: re-reading the dealership website every 3 hours while Chrome is open to keep the to-do count current. It never touches Facebook then. Product copy, README and legal drafts say exactly that.

---

## 3. This machine (Windows 10 Home, PowerShell 5.1)

### 3.1 Drives and folders
- **`E:\LotSync`**: the repo. The only live copy. The owner created it in an elevated shell and granted `DESKTOP-GU84RKK\Alero` full control on that folder only.
- The rest of **E:** is read-only to a non-elevated session (root ACL: Users and Authenticated Users have RX only). Don't try to write anywhere else on E:.
- **`C:\LotSnyc`** (typo intended): the previous working copy. Its contents were deleted by the owner; an empty folder remains only because the session that started there held it open. It can be removed with `rmdir C:\LotSnyc` once that session is closed. Nothing of value is there.
- **`E:\lot-sync`** and **`E:\lot-sync-v0.1.zip`**: the original v0.1 drop; deleted by the owner on 2026-09-27.
- **C: has only a few GB free** (3.4 GB on 2026-09-27). Anything that writes hundreds of MB to C: fails in confusing ways (a truncated Playwright download once produced a bogus "side-by-side configuration is incorrect" error).
- **D:** (600+ GB free) is writable without elevation. `D:\ms-playwright` holds Playwright 1.63's Chromium; `D:\lotsync-tmp` is the throwaway temp folder for test runs (the tests clean it themselves now).
- Claude Code's per-project memory for this repo lives under `C:\Users\Alero\.claude\projects\E--LotSync\memory\` (one file, machine setup). The old `C--LotSnyc` memory folder says the repo moved.

### 3.2 Tools
- **Node v24.21.0** (installed on E:), npm 11.19. Playwright is the only dev dependency.
- **git**: MinGit (portable) at `C:\Users\Alero\AppData\Local\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd\git.exe`. Call it by full path; shells spawned by the desktop app may not see the PATH change. Repo-local identity is set.
- No remote: the repo has never been pushed anywhere. All history is local (and in the handoff zip).

### 3.3 PowerShell 5.1 gotchas (they bit repeatedly)
- No `&&` or `||`; use `;` or `if ($?) { }`.
- **Commit messages must not contain double quotes** (they split the argument). Use a single-quoted here-string (`@' ... '@` with the closing `'@` at column 0).
- Don't `2>&1` native executables (wraps stderr lines as errors).
- The desktop-app sandbox blocks `Remove-Item` on "protected" paths (the session's original working directory, drive roots). For a temp file you own, `[System.IO.File]::Delete(path)` works; for anything bigger, tell the owner the exact command instead of working around the block.
- The tool resets the shell's working directory before each command; use absolute paths.

### 3.4 Running the tests
```
npm test                                  # 120 unit tests, seconds
set PLAYWRIGHT_BROWSERS_PATH=D:\ms-playwright
set TEMP=D:\lotsync-tmp
set TMP=D:\lotsync-tmp
npm run test:e2e                          # all five flows, about 4 minutes
npm run test:e2e:popup | :post | :queue | :wizard | :upkeep
```
In PowerShell: `$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\ms-playwright'; $env:TEMP = 'D:\lotsync-tmp'; $env:TMP = 'D:\lotsync-tmp'`.

Run the e2e flows one at a time and not concurrently with `npm test`: the queue flow has 60-second waits that time out when two Chromiums and the unit suite compete for the machine (seen once; passed twice in a row alone). Branded Google Chrome/Edge 137+ ignore `--load-extension`, so only Playwright's Chromium can run them.

The e2e harness (`test/e2e/*.e2e.mjs`): copies `extension/` to a temp dir, rewrites `manifest.json` to `host_permissions: ['http://127.0.0.1/*']` and strips the `sidePanel` permission and `side_panel` key (headless `chrome.sidePanel.open` otherwise opens a second panel instance), launches a persistent context with `--load-extension`, finds the extension id via `chrome.management.getAll()` on `chrome://extensions`, opens `popup.html` and `sidepanel.html` as ordinary pages (the popup's `chrome.tabs.query` is overridden to return the mock dealer tab), and points the fill code at the mock Marketplace through `devOverrides` in storage. Each test deletes its profile dir and extension copy in `finally`.

---

## 4. The repo

```
E:\LotSync
  CLAUDE.md              rules for every session (read it)
  PLAN.md                12-week plan, milestone status, acceptance criteria
  CHANGELOG.md           what changed, including every live-run fix and the review pass
  README.md              for testers: install, use, develop, file table
  HANDOFF.md             this file
  package.json           scripts: test, test:e2e, test:e2e:<flow>; devDependency playwright ^1.56
  .gitignore             backend/.env, node_modules, usage.json, screenshots, *.zip
  extension/             the Chrome extension (load unpacked from here)
    manifest.json        v0.3.0; permissions activeTab, scripting, storage, sidePanel, alarms, notifications;
                         host_permissions facebook.com/marketplace/* and vehicle-images.carscommerce.inc/*;
                         optional_host_permissions vpic.nhtsa.dot.gov/* and https://*/*; MV3 module worker; min Chrome 116
    popup.html/css/js    toolbar popup: Scan, tabs (To do, Ready to post, Not ready, Other stores, Needs a look, My listings), Settings
    sidepanel.html/css/js  the side panel: post flow, queue, wizard, upkeep
    wizard.js            first-run wizard steps and state
    upkeep.js            listing upkeep (open listing, fill new price, notice the change)
    background.js        service worker: photo downloads, side panel opening, rescans, badge, notifications
    icons/
    adapters/            dealer-website platforms behind one interface
      index.js           ADAPTERS, detectAdapter(probe), adapterById(id)
      dealerInspire.js   the only adapter today
      README.md          interface + TODO platforms (Dealer.com, DealerOn, Dealer eProcess, DealerFire)
    facebook/
      formMap.js         the ONLY place Facebook's fields are described (by role + accessible name)
      fillForm.js        injected: fillFormInPage, probeFormInPage, fillPriceInPage, readListingInPage, attachPhotosInPage
      detectPost.js      watches the tab address for a listing page
      listingSigns.js    text patterns for a sold/removed listing page (never controls)
    src/
      scan.js            injected into the dealer tab: probeSiteInPage(), searchInPage(service, body)
      scanRunner.js      probeTab, searchViaTab, scanWithSearch, performScan, rememberSite, SITES_KEY
      normalize.js       website record -> flat vehicle
      classify.js        pre-owned gate + ready check (DECISION ready/not-ready/review/skip)
      rescan.js          snapshots, diffScans, posted registry (markPosted/markPriceUpdated/markTakenDown), basisPrice
      rescanSchedule.js  alarm name/period, todoCountFor, badgeText, notificationFor, isDue, latestOf, originsFor
      description.js     strips lot-wide boilerplate, bullets, awards, equipment dumps
      rewriteTemplate.js template description + runGuardrails + ensureVinLine
      rewriter.js        template by default; optional backend rewrite and color guess
      listingData.js     vehicle -> form values (colors, body style, fuel, transmission, location, defaults)
      vehicleDetails.js  post-time single-VIN fetch + recheck
      vin.js             check digit, model year, manufacturer, NHTSA vPIC decode, compareVin
      queue.js           the batch queue (pure)
      cap.js             daily cap
      settings.js        withDefaults, defaultSettings, synced profile
      postingRules.js    the 10 posting rules shown in the wizard (kept equal to legal/posting-rules.md by a test)
  backend/               optional rewrite service (Node, Anthropic SDK): server.js, rewritePrompt.js, .env.example, README.md
  legal/                 attorney-review drafts: terms-of-service, privacy-policy, posting-rules, pilot-agreement,
                         dealer-subscription-agreement, chrome-web-store-privacy, trademark-note, questions-for-attorney
  test/
    *.test.js            unit tests (node:test); helpers.js; fixtures/records.json = real records from the live site
    e2e/                 mock-dealer-site.mjs, mock-marketplace.mjs, five *.e2e.mjs flows, screenshots/ (ignored)
```

Git history (newest first): `ded6e90` e2e cleanup · `8b57080` M2 review fixes · `8e4554f` README count · `bb1e6a7` upkeep · `e39a755` wizard/scan runner/0.3.0 · `4d6115c` adapters + background rescans · `0511008` Milestone 1 verified live · then the six live-run fix commits, the M1 feature commits, docs, and `6fac374` v0.1.

---

## 5. How the extension works (every flow, with the exact identifiers)

### 5.1 Storage (chrome.storage.local unless noted), all keyed per dealer website origin
- `settings:<origin>`: see `withDefaults` in `src/settings.js`: `{ version: 2, myStores[], basis: 'website'|'beforeFees', salesperson: {name, title}, dealer: {name, city, state, zip}, priceNote, dailyCap, rewrite: {enabled, endpoint, key}, defaults: {titleStatus, condition}, autoRescan, notify, rulesReadAt }`. Blank dealer city/state/zip are filled from the website's address at read time.
- `snapshot:<origin>`: `{ version: 1, site: {origin, host, name, title, address, adapter}, takenAt, complete, vehicles: { [vin]: snapshotEntry } }` where `snapshotEntry` has vin, name, stock, url, price, priceLabel, priceBeforeFees, status, statusLabel, availability, location, locationShort, photoCount, mileage, type, carfax, decision, reason, blockers[].
- `diff:<origin>`: from `diffScans`: `{ firstScan, unreliable, warnings[], takeDown[], priceUpdates[], newArrivals[], becameReady[], needsALook[], takenAt, requests }`. Items carry `vin, name, stock, url, yours` plus `why/text/lastPrice` (takeDown), `from/to/change` (priceUpdates), `decision/reason/price` (newArrivals). `unreliable` is set when a previous scan of 10+ cars lost more than half at once (`MASS_DISAPPEARANCE_SHARE = 0.5`): the popup, wizard and worker then keep the previous snapshot.
- `posted:<origin>`: `{ [vin]: { name, price, postedAt, listingUrl?, salesperson?, updatedAt? } }`. "Mark posted" (by hand) records no listingUrl; the panel's confirm-posted records the detected or pasted link.
- `boilerplate:<origin>`: lot-wide description sentences to strip.
- `postQueue:<origin>`: `{ vins[], index, status: 'running'|'paused'|'done', results: {vin: 'posted'|'draft'|'skipped'|'blocked'}, dealerTabId, windowId, startedAt }`.
- `drafts:<origin>`: cars saved as Facebook drafts during a queue.
- `postFlow:<origin>`: the side panel's in-progress post (FLOW_FIELDS) so the panel can be closed and reopened.
- `wizard:<origin>`: the wizard's persisted state (`active`, `step`, answers); `wizardDone:<origin>`: ISO string when finished, or `{skipped: true, at}` when the popup's "Not now" was clicked.
- `sites` (one object for all origins): `{ [origin]: { name, adapter, service: {search, apiKey, visibleStatusValues, hasHelper}, site, auto, lastScan, lastAttempt, lastError, lastReason, lastNotifiedCount } }`. The service worker rescans entries with `auto: true`.
- Requests from popup to panel: `postRequest`, `setupRequest`, `upkeepRequest` (each `{ origin, dealerTabId, windowId, at, ... }`), plus `lastPostOrigin`.
- `devOverrides`: test-only overrides merged over `FORM_MAP` (createUrl, listingUrlPattern, yourListingsUrl, settleMs, recheckMs, ...).
- chrome.storage.sync `profile`: the salesperson's own details (`profileFrom`), used to seed settings on a new website when the dealer name matches.

### 5.2 Messages to the service worker (`chrome.runtime.sendMessage({ type })`)
`downloadPhotos` (urls, offset) · `openSidePanel` (windowId|tabId) · `updateBadge` · `rescanNow` (origin, reason) · `ensureAlarm`.

### 5.3 Scan (popup "Scan website", the wizard, and the worker)
`performScan({ tabId, origin, settings, settingsFromProfile, snapshot, posted })` in `src/scanRunner.js`: inject `probeSiteInPage` (MAIN world) to read the site name, the schema.org address and `window.SEARCH_SERVICE` (`search` URL, `apiKey`, `visibleStatusValues`); `detectAdapter(probe)`; build `search = searchViaTab(tabId, service)` (each request is made inside the dealer tab by `searchInPage`, through the page's own `IDPSearchServiceHelper.getListings` or a fetch with `x-api-key`); `scanWithSearch({ adapter, search, site, settings, prevSnapshot, posted, status })` runs `adapter.scan`, normalizes, assesses (`assessVehicle`), builds the snapshot, `diffScans`, and the boilerplate; on a first scan or profile-seeded settings it settles the store choice (`defaultSettings`) and re-assesses; then `rememberSite(origin, {...})` records the service for background rescans. The popup keeps the previous snapshot when `diff.unreliable`.

`adapters/dealerInspire.js` `scan(search, { status, vins, confirmVins, fullRecords })`: POSTs `{ type: ['Used','Certified Used'], perPage: 200, page, sort..., filters }` (fields listed in `FIELDS`), walks pages, retries in other sort orders when paging is unstable, de-duplicates by VIN, then looks up VINs from the previous snapshot that the paged search missed (`confirmVins`, batches of 50) so a car is only called "gone" when a direct lookup fails too (`confirm: { checked, notFound, error }`). `getDetails(search, vin)` fetches one full record (all photos, description, features) for post time. `makeDirectSearch(service)` is the same POST from the worker (verified live: the Cars Commerce service answers direct requests from outside the page with HTTP 200).

### 5.4 The pre-owned gate (`src/classify.js`)
Three signs from the website are compared: inventory type ("Used"/"Certified Used"/"New"), the condition word in the vehicle page URL, and the condition word at the start of the title. Demo/loaner flags always win (sold as new). A Carfax link supports pre-owned but its absence never blocks. Mileage never makes a car "used" (the live site has "New" units with thousands of miles). Disagreement or oddity -> `review` ("Needs a look"). Ready check: photos, a price, on the lot, not sale-pending, at one of `myStores`. Blocker codes: `no-photos`, `no-price`, `sale-pending`, `not-on-lot`, `other-store`.

### 5.5 Post flow (side panel, `sidepanel.js`)
Popup "Post" -> `chrome.sidePanel.open` (must be straight from the click) -> writes `postRequest` -> panel `startFlow`: `fetchVehicleDetails(dealerTabId, vin)` (fresh record), `recheck`, `localVinCheck`, price by basis, optional color guess, `generateDescription` (template or backend, then `runGuardrails`), step `review` (description editable, checks shown, assumptions listed, VIN check, "Check VIN online" via NHTSA with an optional-permission request), "Open the Marketplace form" -> opens `FORM_MAP.createUrl` -> `runFill` injects `fillFormInPage(map, data)` then `attachPhotosInPage` with photos downloaded by the worker (the Facebook page can't fetch the dealer's image host) -> step `publish`: the panel lists filled / needs-a-click / couldn't-fill with copy buttons, `watchForListing` polls the tab address (`listingUrlPattern`, `afterPublishPatterns`) and resolves `listing | probably | closed | timeout | cancelled`; the person clicks Publish; "Yes, it posted" (`confirmPosted`) records `markPosted` with the listing link; "Saved as draft" records a draft. A "check fields only" dry run (`probeFormInPage`) exists for a first live run on a new form.

Steps: `idle, checking, blocked, review, filling, probe, publish, done, queueDone, wizard, upkeep`.

### 5.6 Queue
Popup Ready tab: tick boxes (`.pick`), "Select the next N" (`#pickAll` ticks the first N from the top, N = today's remaining cap), "Post N cars"; at the cap the boxes and Post buttons disappear. `createQueue` caps the length at the remaining posts. The panel walks the queue: a car that passes every check (`canAutoOpen`: guardrails ok, VIN check ok, no blockers besides title fields, cap not reached) opens and fills the form without stopping at review; a car with a warning waits at review. After Publish the watcher sees the listing address -> `confirmPosted` -> next car. Skip / Pause / Stop in the queue bar; "Saved as draft, next car" for Facebook's Save draft. The queue survives closing the panel.

### 5.7 First-run wizard (`wizard.js`, steps `welcome, scan, store, you, address, permission, rules, done`)
Offered by the popup's To do tab (`#setup`, `data-action="setup"`) until `wizardDone:<origin>` exists or the person clicks "Not now" (`skipSetup`); shows "Continue set-up" when `wizard:<origin>` is active (that hands the wizard a live dealer tab id, which matters after a Chrome restart). Reads the website with default settings, pre-ticks the store from the site name, takes name/role, shows the address read from the site, asks `chrome.permissions.request({ origins: originsFor(site, service) })` straight from the click (the site's origin and its search service's origin, both `/*`), shows the posting rules with a "read" tick, then `finish()`: saves settings (autoRescan = granted, rulesReadAt), the synced profile, `rememberSite(origin, { auto })`, runs the final read, writes `wizardDone`, sends `ensureAlarm`.

### 5.8 Automatic rescans (`background.js`, `rescanSchedule.js`)
`chrome.alarms` `lot-sync-rescan`, period 180 minutes, created on install/startup and by `ensureAlarm`. On alarm: for each `sites[origin]` with `auto`, if `isDue(latestOf(lastAttempt, lastScan))` (period minus 5 minutes slack), `runRescan(origin, { reason: 'alarm' })`: requires the entry's service, an adapter, `chrome.permissions.contains` for the origins, and existing `settings:<origin>` (never invents defaults, never writes settings); `scanWithSearch` with `adapter.makeDirectSearch(service)`; saves diff and boilerplate (snapshot only when not unreliable); `updateBadge` (sum of `todoCountFor(diff)` over all sites: the person's own take-downs, price updates and needs-a-look items); a desktop notification (`chrome.notifications.create`, icon `icons/icon128.png`) when the count rose above the person's outstanding list (`todoCountFor(previous diff)`), `settings.notify !== false`, and the reason is the alarm. Failures are recorded as `lastAttempt`/`lastError` and the popup shows them on To do (`#scheduleWarning`), including "no permission" with an "Allow automatic rescans" button. Settings also has that button; ticking the rescan box asks Chrome from the Save click and stays off if refused.

### 5.9 Listing upkeep (`upkeep.js`)
Popup To do: "Open listing" (take-down) or "Open & update price" (`data-action="upkeep"`, `data-kind`), which writes `upkeepRequest` (`kind: 'takeDown'|'price'`, price, listingUrl, name, listedPrice). The panel opens the saved listing link (or `FORM_MAP.yourListingsUrl` with a note when none was saved) in a new tab and polls it every 1.5 s with `readListingInPage(map, LISTING_SIGNS, { id, name })`, which returns `{ url, title, prices[], sold, unavailable, matchesId, matchesName, hasPriceBox, priceBoxValue }` from the page's static text (buttons, links, menus, tabs and dialogs skipped; the sold sign only in chunks of 40 characters or less). Nothing happens unless `matchesId || matchesName` (the listing id in the address, or the car's year/make/model in the title/text); otherwise the panel says which listing to open. Price: when this car's edit form shows a Price box, `fillPriceInPage(map, price)` sets it (up to 4 times if the loading form overwrites it) and reads it back; when the box is gone and the page shows the new price, the item is finished (`markPriceUpdated`, dropped from `diff.priceUpdates`). Take-down: finished when sold/unavailable flips from false on the first read of that page to true (`markTakenDown`, dropped from takeDown/priceUpdates/needsALook). "I updated it" / "I took it down" finish by hand; "Not now" cancels. The panel refuses an upkeep request while a post is under way (steps checking/review/filling/probe/publish) and stops a waiting upkeep when a post or the wizard starts. Each panel instance acts only on requests for its own window and ignores requests older than 10 minutes.

### 5.10 Descriptions
`description.js`: the site's `description` field mixes a lot-wide disclaimer, raw equipment dumps and sometimes a real write-up; `findBoilerplate` finds sentences on 30%+ of the lot; `cleanDescription` strips them plus bullets, award lines and comma dumps. `rewriteTemplate.js` `buildTemplateDescription` writes 60–120 words in first person with 4–6 features (priority list), the price note, the sign-off "I'm [name], [role] at [dealer]", and a VIN line (`ensureVinLine`). `runGuardrails` checks: every number in the text is in the source (vehicle, dealer, price note, price), no banned phrases, dealer named, length, no shouting, "one owner" only with the Carfax flag. `rewriter.js` asks the backend when Settings enables it, regenerates once on a failed check, then falls back to the template.

### 5.11 Backend (`backend/`, optional)
Express-style Node server with the Anthropic SDK. `.env`: `ANTHROPIC_API_KEY`, `REWRITE_KEY` (shared secret the extension sends), `REWRITE_MODEL` (default `claude-haiku-4-5`; `claude-sonnet-5` optional), `MONTHLY_COST_CAP_USD` (25), `RATE_LIMIT_PER_MINUTE` (20), `PORT` (8787). Endpoints: `/health`, `POST /rewrite` (facts -> description, guardrails re-run server-side), `POST /color` (up to 4 photo URLs + Facebook's color words -> exterior/interior guess with confidence). Stores only `usage.json`. Not deployed anywhere; the owner has not set an API key. Milestone 4 replaces it with a Supabase Edge Function.

---

## 6. What the live Facebook form taught us (six live runs on 2026-09-27; all handled in `fillForm.js`)
1. Dropdowns are slow, custom comboboxes that open one at a time; the option list is drawn late. The fill waits up to 6 s per popup, scopes the option search to the open popup, and retries a dropdown on the spot when its read-back disagrees.
2. Price and mileage are reformatted by the form (commas); the read-back accepts digit-equal values.
3. Location suggestions include same-named towns in other states ("Waynesburg, Ohio"); the fill picks the suggestion matching the dealer's state (`locationExpect`), types the ZIP when known, and the state comes from the site's address. Sending Escape to the location box clears it: Escape is only ever sent to `document.body`.
4. **Facebook restores a saved draft ("2020 Honda Accord EX-L") a few seconds after the create page opens, over whatever was filled.** The fill waits until the identity fields have been still for 2 s (up to 6), fills the VIN first, re-checks every field after `recheckMs` (3 s) and re-applies anything changed underneath, and the panel names what Facebook changed and asks the person to delete that draft (Your listings -> Drafts). The owner's stale draft may still exist; ask them to delete it.
5. Make and Model are typeaheads that show default suggestions (Honda, then Accord) and **commit the first suggestion on blur**. They are typed one key at a time, only a suggestion containing the typed text is picked, the box is closed with Escape (never blurred). Make may be a dropdown-style control on some loads.
6. The clean-title control is a checkbox labelled by nearby text; the photo limit text reads "up to 20 photos"; the read-back of a box that empties itself after a pick uses the visible text beside it.
7. After these fixes, single cars and a queue ran with nothing under "Couldn't fill" (`formMap.js` `verifiedAgainstFacebook: 'live runs 2026-09-27, all fields'`).

Not yet verified on the live site: `yourListingsUrl` (`/marketplace/you/selling`), the listing page's sold/removed wording (`listingSigns.js`), the edit page's URL shape (the code accepts the listing id anywhere in the URL, or the car's name on the page) and its Price box; the wizard's permission prompt; a real alarm rescan and notification.

---

## 7. The M2 adversarial review (2026-09-27) and what it changed
Seven reviewers (wizard, background rescans, adapter regressions, upkeep, Chrome API correctness, rules/docs/tests, storage consistency) produced 36 findings; two independent skeptics per file confirmed 29, split on 4, refuted 3. Everything confirmed was fixed in commit `8b57080` (details in CHANGELOG under "Fixed"). Decisions on the rest:
- Refuted, left as is: wizard address fields refilling from the site address when blanked (intended: blanks mean "use the website's"); "auto-detection can't fire after the fills give up" (the manual button is the fallback); "executeScript failures are swallowed" (they are, while the tab is on a page the extension may not read; the panel keeps waiting and the manual buttons remain).
- Split, done anyway (cheap hardening): stale popup->panel requests are expired after 10 minutes and the newest wins; guard tests now cover `scanRunner.js`/`scan.js` injections; the popup treats facebook.com as never a dealer site.
- Split, deliberately not done: re-fetching the website price at upkeep time (F20). The filled price is the last scan's number (at most 3 hours old with rescans on); a second drop after the scan produces a new To do item at the next rescan. Worth revisiting if the owner wants "update" to re-read the site first.

---

## 8. Known gaps, risks and open questions
- The M2 features still need the owner's live checks (section 6, last paragraph). Expect `listingSigns.js` and possibly `yourListingsUrl` to need adjustment; the design keeps such fixes in one file.
- Facebook's form is a custom React UI that can change any day; every field that can't be found is listed in the panel with a copy button, and `formMap.js` is the only file to touch.
- Meta's Terms prohibit "automated means" without permission. A person clicking Publish is the safest available design, not a guarantee; the copy and legal drafts say so. An attorney has not reviewed `legal/`.
- The live inventory had no motorcycle when inspected; motorcycle handling in `listingData.js` (`vehicleKind`) is best-effort.
- The rescan period is fixed at 3 hours; the notification wording is generic ("N of your listings need attention"). Both are easy to change.
- Two side panels (one per window) are handled by window id; two Chrome profiles are not shared at all (Milestone 4: accounts).
- The e2e queue flow is timing-sensitive under machine load (section 3.4).

---

## 9. What's next
Immediately (with the owner):
1. Reload the unpacked extension from `E:\LotSync\extension` in Chrome (chrome://extensions, Developer mode, Load unpacked, or Reload).
2. On the Waynesburg used-inventory page: click the icon, "Set up Lot Sync", walk the wizard including "Allow automatic rescans"; confirm the badge and, after 3 hours or a `rescanNow`, a rescan.
3. One real upkeep item each way (a price change and a sold car) on a listing they made; fix `listingSigns.js`/`formMap.js` from what the page shows.
4. Delete the stale Honda Accord draft on Facebook.

Milestone 3 (pilot, PLAN.md): manager's approval, 2–3 salespeople, track time per post, prefill failures per field, and how long sold cars stay listed; weekly fixes; positioning/pricing/demo materials. Prerequisites the owner must supply: manager sign-off, attorney review, optionally an Anthropic API key and a host for `backend/`.

Milestone 4+ (accounts via Supabase, manager view, billing, landing page, Web Store, design partners) is planned in PLAN.md and not started.

Engineering ideas the owner has not asked for (mention, don't build unasked): a Dealer.com adapter (needs a real site to verify), an "update re-reads the website first" option for upkeep, a manager summary export, a Web Store packaging script.

---

## 10. Test map (what proves what)
Unit (`test/*.test.js`): adapters (interface, scan paging/confirm, trimRecord, direct search), classify (gate cases from real records), description, detectPost, listingData (colors, location, defaults, branded titles), posting (cap, registry, and the **guard tests**: formMap has no publish/submit/delete/sold values; fillForm.js never submits, clicks only `control|option|trigger` receivers, dispatches no click events, probe/reader are read-only; sidepanel.js injects only the three fill functions and clicks only its own download link; upkeep.js injects only the price filler and the reader and never clicks; scanRunner.js injects only the probe and the search call and scan.js only reads; no guarded file has `/*` inside a string; background.js and detectPost.js never act on a page), postingRules (equal to legal/posting-rules.md), queue, rescan (diffs, mass-disappearance guard, registry), rescanSchedule (badge, notification, isDue with slack, latestOf, originsFor, scanWithSearch end to end), rewriter, rewriteTemplate (guardrails), settings (defaults, profile round trip), vehicleDetails, vin.

E2E (`test/e2e/`): `mock-dealer-site.mjs` serves a Dealer Inspire-like page with JSON-LD address, `window.SEARCH_SERVICE`, `POST /api/v1/listings/:id/search`, `/inventory.json`, `/photo/*`, and `/scenario?name=day2` (the Ram sells, the Wagoneer drops $1,500, a Silverado arrives, a Hellcat becomes ready). `mock-marketplace.mjs` imitates the live form's quirks (late-drawn comboboxes, blur-committing typeaheads, price reformatting, same-named towns, a restored draft via `/prefill?name=honda[&late=ms]`), counts Publish clicks at `/published` and `/publish-count`, and serves listing pages `/marketplace/item/424242/` (Ram) and `/515151/` (Wagoneer) with edit pages, Mark as sold / Delete forms, a "Sold" filter tab, a description containing "Sold as-is", and `/listing-state`. Flows: popup (scan, day2 diff, mark posted, to-do counts, settings), post (single car incl. photos, publish detection, registry), queue (two cars, restored-draft recovery incl. the late variant, drafts, cap), wizard (banner -> all steps -> settings/sites/alarm asserted -> `rescanNow` from the worker with no tab -> badge), upkeep (price update on the right car only, wrong edit form untouched, take-down not triggered by the button/tab/description, badge cleared).

---

## 11. Quick reference
```
# tests
npm test
$env:PLAYWRIGHT_BROWSERS_PATH='D:\ms-playwright'; $env:TEMP='D:\lotsync-tmp'; $env:TMP='D:\lotsync-tmp'; npm run test:e2e

# git (MinGit by full path; no double quotes in messages)
& "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd\git.exe" -C E:\LotSync status --short
& "...\git.exe" -C E:\LotSync commit -q -m @'
message here
'@

# backend (optional)
cd backend; copy .env.example .env; (edit .env); npm install; npm start   # http://localhost:8787/health

# rescan from the worker without waiting for the alarm (from any extension page's console)
chrome.runtime.sendMessage({ type: 'rescanNow', origin: 'https://www.ronlewischryslerdodgejeepramwaynesburg.com' }).then(console.log)
```

Live site: https://www.ronlewischryslerdodgejeepramwaynesburg.com/used-vehicles/ (Dealer Inspire; search service `https://websites-search.api.carscommerce.inc/api/v1/listings/153146`, key on the page; 108 used cars on 2026-09-27; sister stores Cranberry and Pleasant Hills appear as other locations).
