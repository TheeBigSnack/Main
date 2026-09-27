# Changelog

## 0.2.0 (2026-09-26, Milestone 1)

One-click post to Facebook Marketplace, with a person clicking Publish.

Added
- **Side panel** (`extension/sidepanel.*`): the guided post flow. Re-fetches the car by VIN (all photos, description, features), re-runs the pre-owned and ready checks, writes the description, shows what will be filled and what the salesperson must fill (vehicle condition, title status), opens the Marketplace form, fills it, attaches photos, waits for the person to click Publish, records the post with the listing link.
- **Facebook form map** (`extension/facebook/formMap.js`): every selector and field rule in one file, by role and accessible name. No entry for Publish, Update, Delete or Mark as sold, and a unit test that keeps it that way. Not yet verified against the live form (see README).
- **Fill code** (`extension/facebook/fillForm.js`): injected into the tab; reports filled / needs-a-click / couldn't-fill, never fails silently. Reads the page's "up to N photos" limit. A read-only probe (`probeFormInPage`) backs the panel's "check fields only" dry run for the first live run: it reports which fields the map finds and lists the page's controls, without filling or clicking anything.
- **Publish detection** (`extension/facebook/detectPost.js`): watches the tab's address for a listing page; always confirmed by the person.
- **Description writer**: `description.js` strips lot-wide boilerplate, bullets, award lines and equipment dumps (verified on the live site); `rewriteTemplate.js` writes a 60–120 word first-person description from the facts and runs the guardrails (numbers in source, banned phrases, dealer named, length, no shouting, one-owner only with Carfax); `rewriter.js` optionally asks the backend for a Claude draft and falls back to the template.
- **Backend** (`backend/`): standalone Node rewrite service using the Anthropic SDK, Claude Haiku 4.5 by default, switchable to Sonnet 5; shared key, per-minute rate limit, monthly cost cap. Off by default in the extension.
- **Daily cap** (`cap.js`): per-salesperson posts per day, default 10, configurable, enforced before the form opens.
- **Settings**: your name and role, dealership name / city / state / ZIP, price note (suggested from the site's doc fee gap), daily cap, rewrite service. Old settings keep working.
- **Popup**: "Post" button on ready cars opens the side panel; "Mark posted" kept for listings made by hand; My listings shows the saved listing link.
- **Scan**: also reads `description` and `features` (one request as before); lot-wide boilerplate is computed per scan and saved separately; snapshots stay compact.
- **Tests**: 44 new unit tests (84 total); a mock Marketplace form and a second Playwright test that drives the whole post flow, with the test standing in for the person's Publish click.
- CLAUDE.md, PLAN.md, `legal/` drafts (8 files), backend README, `.gitignore`.

Fixed
- Fill code, from the first live run on the real form (2026-09-27): a dropdown whose option list is drawn slowly (Facebook's Year list) was given up on after 2 seconds, then opened late and stayed open, so every later dropdown click only closed it and the page-wide option lookup kept seeing the year list. Dropdowns are now handled one at a time: close anything open, open with real pointer events, wait up to 6 seconds for that control's own popup (`aria-controls`, or the popup that newly appeared), choose inside it, close it. A reformatted number ("36,603" for "36603") now counts as accepted. Fields are also found by their label anywhere in the accessible name as a second chance. The mock Marketplace form reproduces all of this, so the e2e guards it.
- Popup: a click on Scan during the popup's own start-up could finish, render, and then be wiped by the start-up's saved-data load, leaving "No scan yet" on screen. The button now stays disabled until start-up finishes and the scan waits for it. Found by the end-to-end test.

Changed
- `manifest.json`: version 0.2.0; new permission `sidePanel`; new host permissions `https://www.facebook.com/marketplace/*` (to fill the form and see the listing address) and `https://vehicle-images.carscommerce.inc/*` (to download the car's photos); background service worker; side panel; minimum Chrome 116.
- `normalize.js`: `photos` now keeps every URL it is given (the bulk scan still passes 3); new `descriptionRaw` and `features`.
- `rescan.js`: `markPosted` accepts an extra object (listing URL, salesperson) without changing existing callers.
- `test/e2e/popup.e2e.mjs`: repo path fixed for Windows; prints the popup's status and console errors on failure; `LOTSYNC_E2E_CHANNEL` can point both e2e tests at another Chromium build.

## 0.1.0 (2026-09-26)

Scan a Dealer Inspire website's used inventory, the three-sign pre-owned check, the ready check, rescans with take-down / price-update / new-arrival lists, the popup, 40 unit tests and a Playwright end-to-end test against a mock dealer site.
