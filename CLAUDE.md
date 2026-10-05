# Lot Current: rules for every session

Read this before touching anything. It is the product in one page plus the rules that are not negotiable. The build brief that produced it is summarised in PLAN.md.

## The product

Lot Current helps car dealership salespeople list their store's used cars on Facebook Marketplace and keep those listings accurate. It reads the dealership's own website inventory and only lets pre-owned cars through. It pre-fills Facebook's vehicle listing form so posting takes about 10 seconds. It rescans the website to tell each salesperson which of their listings sold or changed price.

- Customers: dealerships, billed per rooftop (store) per month. Users: salespeople, who post and maintain listings, and managers, who see who posted what.
- Why salespeople post from personal profiles: Marketplace stopped showing vehicle listings from partner catalog feeds in September 2021 and stopped letting business Pages list vehicles in January 2023. Dealers are not allowed to list new vehicles on Marketplace.
- First pilot: Ron Lewis Chrysler Dodge Jeep Ram Waynesburg, 2 to 3 salespeople, with the manager's approval. Dealer Inspire website: https://www.ronlewischryslerdodgejeepramwaynesburg.com/used-vehicles/
- Competitors (Shiftly, CARVID, AutoLander, Relay Autos, ZenLite and others, roughly $39 to $1,299 a month as of Sept 2026) mostly auto-post. Lot Current's angle is careful and accurate: a person posts in seconds, sold cars are flagged the same day, prices always match the website, and new cars never get listed by mistake.

## Non-negotiables (enforce in code, not only in docs)

1. **A person publishes every post and every edit.** Lot Current fills in forms and opens pages. It never clicks Publish, Update, Delete or Mark as sold, and it never posts or edits in the background or while the salesperson is away. `extension/facebook/formMap.js` has no selector for any of those buttons. `test/posting.test.js` checks what is allowed: the form map holds only known keys and fields, none fitting those buttons in any language the form comes in; the fill code submits nothing and clicks only inside its helpers; the extension reaches a page only through the known injected functions; and the dry run, the listing reader and upkeep only read or fill. It reads source text, so deliberate obfuscation could still pass it; the mock form's decoy buttons in `test/e2e/` fail any flow that touches one.
2. **No detection evasion.** No randomized "human-like" delays, no fingerprint or user-agent spoofing, no proxies, no multiple or shared accounts. Never ask for, read or store Facebook passwords, cookies or tokens.
3. **Pre-owned only.** The gate in `extension/src/classify.js` decides. New, demo, loaner and "needs a look" cars can't enter any posting flow. The side panel re-fetches and re-checks the car at post time (`extension/src/vehicleDetails.js`).
4. **Honest prices.** The listed price equals the website price, using the dealer's chosen price basis. Price changes only mirror the website: no fake drops, no raise-then-drop, no delete-and-relist. A real price drop, once updated on the listing, notifies everyone who saved it; that is the honest version of a "ping".
5. **The dealership stays identifiable.** Every description names the dealership and the salesperson's role. First-person tone is the goal, but posing as a private seller is not allowed.
6. **Facts only.** Descriptions state only facts present in the source data, and numbers are checked against the source before the salesperson sees them (`extension/src/rewriteTemplate.js`, `runGuardrails`).
7. **A per-salesperson daily post cap** the dealership chooses and each salesperson enters in Settings (default 10, up to 100, `extension/src/cap.js`). Meta doesn't publish its limits, so it is presented as a safety setting, never as a guarantee.
8. **No affiliation claims.** Never say or imply Lot Current is affiliated with, approved by or partnered with Meta or Facebook. Use "Facebook" and "Marketplace" only as plain names, with no logos.

Meta's Terms prohibit accessing its products "using automated means" without permission. Having a person click Publish is the safest design available, but it is not guaranteed safe. Keep that honest everywhere: product copy, README, marketing, legal.

## How to work

- **Build for any dealer.** The pilot dealer is a fixture, not a default. No dealer-specific value (a name, town, ZIP, state, doc fee, sister store, a person's name) goes into code, prompts, the manifest, placeholders or user-facing copy; Waynesburg and Ron Lewis appear only in `test/fixtures/`, in worked examples marked as such, in the pilot record (`PILOT.md`, `CHANGELOG.md`, `legal/questions-for-attorney.md`) and in this file's product summary. Everything a dealer fills in is a bracket in the `legal/` and `marketing/` templates and a Settings field in the extension, and a person confirms it before it reaches a listing. Settings split by owner: the salesperson's name, role, listing defaults and rewrite-service address follow the person through the synced profile; the dealership's name, address, stores, price basis, price note and daily cap belong to that dealership's website (`settings:<origin>`) and travel to another site only when the profile was saved on that same website (the profile records its origin; the editable dealer name is never the key). Anything learned from one lot (a price gap, a boilerplate share, a store-name pattern, a photo host) is a per-website observation the code re-derives on every site or offers as a suggestion, never a baked-in threshold or fact, and a heuristic keeps an absolute floor so a 3-car lot and a 124-car lot both behave. Region is data too: state law wording, fee phrasing, the form's language and the places the location guard knows are inputs, and when they are unknown the tool says so instead of guessing. Platform code lives under `extension/adapters/` (`src/scan.js` holds only the neutral site probe, `src/normalize.js` only shared helpers); `src/` gains no platform-specific code. Where a rule can be checked, a test checks it (`test/manifest.test.js`, `test/marketing.test.js`, `test/rewriter.test.js`, `test/rescanSchedule.test.js` and `test/askChrome.test.js` for the permissions Lot Current asks for, the guard tests).
- Plain JavaScript ES modules, no build step, unless a real need appears. Manifest V3.
- All Facebook selectors and field-finding rules live in `extension/facebook/formMap.js` (by role and accessible name, never generated class names). All dealer-platform code goes under `extension/adapters/` (`dealerInspire.js` + `dealerInspireNormalize.js`, and `schemaOrg.js` on the shared standard-data readers `schemaOrgParse.js` + `schemaOrgNormalize.js`; the contract is in `extension/adapters/README.md`, and a second platform is one new file there plus its line in `index.js`).
- Code that is injected into a page with `chrome.scripting.executeScript` must stay self-contained (no imports, nothing from outside the function body): `src/scan.js`'s `probeSiteInPage`, every adapter's `probeInPage` and `searchInPage`, and `facebook/fillForm.js`'s injected functions (`test/adapters.test.js` and `test/posting.test.js` check it).
- Add unit tests for every new pure module (`npm test`, node:test, no dependencies). Extend the Playwright end-to-end tests against the mock dealer site and the mock Marketplace form (`test/e2e/`). Never automate the real facebook.com in tests. Never publish a real listing during development without the owner's OK: test the prefill, then close without publishing.
- Ask the owner before: adding paid services, widening extension permissions, doing anything that touches a real Facebook account, or spending money. Widenings so far: `sidePanel`, host permissions for `https://www.facebook.com/marketplace/*` and `https://vehicle-images.carscommerce.inc/*` (Milestone 1, called out in CHANGELOG); optional `https://vpic.nhtsa.dot.gov/*` for the NHTSA VIN check (0.2.0); `alarms`, `notifications` and optional `https://*/*`, asked for per dealer website for automatic rescans (Milestone 2, 0.3.0); a car's photo servers requested from the salesperson's click at post time (`src/photoHosts.js`, approved 2026-09-29). Every request goes through `src/askChrome.js`, and `test/manifest.test.js` ties each permission to the release that recorded it.
- No secrets in git: the backend key lives in `backend/.env` (ignored). Commit after each working step. Keep README (for testers) and CHANGELOG up to date.
- The rewrite service is the only place an Anthropic API key exists: the Supabase `rewrite` function's `ANTHROPIC_API_KEY` secret, or `backend/.env` for the self-hosted `backend/`. Never in the extension or git. The extension only calls it when the dealer turns it on in Settings; the template writer is the default and the fallback.
- Customer-facing copy lives in `marketing/` and must pass `test/marketing.test.js`: a person clicks Publish and Lot Current never does, not affiliated with Meta, no promise of account safety, no Meta-approval or partnership wording, no invented numbers, prices only from `marketing/pricing.json` (a hypothesis until a dealer pays).
- The pilot numbers (`extension/src/pilot.js`) record only what `legal/pilot-agreement.md` section 2 names: post timings, field keys that could not be filled, hours until sold cars and price changes were fixed. Never values, descriptions, buyers or anything from the Facebook account.

## Repo map

| Path | What it is |
|---|---|
| `extension/popup.*` | Toolbar popup: scan, tabs, Post / Mark posted, Settings |
| `extension/sidepanel.*` | Guided one-click-post flow (Chrome side panel) |
| `extension/wizard.js` | The set-up wizard in the side panel: website, store, name and role, optional account, address, price to post, rescan permission, posting rules, Terms, first scan |
| `extension/upkeep.js` | Listing upkeep in the side panel: opens the salesperson's own listing for a To do item and fills the new price; the person clicks Update, Mark as sold or Delete |
| `extension/background.js` | Service worker: downloads photos from the dealer's image host, opens the panel |
| `extension/src/scan.js` | Runs in the dealer tab: the neutral site probe (origin, name, address) before an adapter is chosen |
| `extension/adapters/` | One module per dealer-website platform: in-page probe and search, detect, scan, normaliser, details, direct search, photo hosts; `index.js` lists them |
| `extension/src/normalize.js`, `classify.js`, `rescan.js` | Flat vehicle shape, the pre-owned + ready gate, the rescan diff |
| `extension/src/description.js`, `rewriteTemplate.js`, `rewriter.js` | Strip website boilerplate, template writer + guardrails, optional Claude call |
| `extension/src/listingData.js`, `vehicleDetails.js`, `cap.js`, `settings.js` | Form values, post-time re-check, daily cap, settings defaults |
| `extension/src/scanRunner.js`, `rescanSchedule.js` | What a scan does once the records are back (normalise, assess, snapshot, diff, boilerplate); the automatic rescan's period, badge, notifications and host list |
| `extension/src/panelList.js`, `readyList.js`, `queue.js` | The side panel's own Ready to post list; the list's order, search and New pills; the batch queue, never longer than the day's remaining cap |
| `extension/src/drafts.js`, `takenDown.js` | Cars saved as Facebook drafts and the price each was filled with; posts taken off the posted list (re-post notice, the day's cap) |
| `extension/src/photoHosts.js`, `photoPick.js`, `askChrome.js` | Which servers a car's photos sit on and which still need Chrome's OK; the salesperson's photo pick and order; the one place that asks Chrome for a host permission |
| `extension/src/vehicle.js`, `vin.js` | The one flat vehicle shape every adapter returns; VIN checks (local, plus the optional NHTSA decode) |
| `extension/src/account.js`, `accountConfig.js`, `accountFlow.js`, `sync.js` | Sign-in by emailed code; the account project's address and public key (`npm run set-project`); sign-in, sign-out and one round of sync; the pure half of sync |
| `extension/src/storage.js`, `storageKeys.js` | Read-modify-writes on `chrome.storage.local` under a lock; every storage key in one place (HANDOFF.md 5.1 describes each) |
| `extension/src/postingRules.js`, `legalLinks.js`, `wizardSteps.js` | The posting rules shown on first run (kept equal to `legal/posting-rules.md`); where the legal texts are read and which edition a person accepts; the wizard's pure parts |
| `extension/src/pilot.js` | Pilot numbers: post timings, fill failures per field, hours until to-do items were fixed; summary, CSV; the Numbers tab in the popup (view id and storage key still say pilot) |
| `extension/facebook/formMap.js`, `fillForm.js`, `detectPost.js`, `listingSigns.js` | The one Facebook map, the injected fill code and listing reader, the listing-address watcher, how a listing page reads once the person acted on it |
| `backend/` | Standalone Node rewrite service (Claude Haiku 4.5 by default) |
| `supabase/` | Accounts backend: migrations (0001 to 0008 are in production and never edited; each change is a new numbered file) and the rewrite, sync, billing and lead functions |
| `manager/` | The manager view (a static page): who posted what, to-do items, the last scan, billing |
| `test/` | Unit tests, fixtures (real records from the live site), e2e with mock sites |
| `legal/` | Attorney-review drafts; `posting-rules.md` is shown to salespeople |
| `PILOT.md`, `marketing/` | The pilot runbook and definitions; positioning, pricing hypothesis (`pricing.json`), sales sheet, demo script, pilot offer and onboarding emails |
| `PLAN.md`, `CHANGELOG.md` | The 12-week plan with acceptance criteria; what changed |
