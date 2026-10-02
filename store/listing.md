# Chrome Web Store listing: draft

The text and the answers for the Developer Dashboard, kept here so they are reviewed like code. `test/manifest.test.js` checks that the summary below is the manifest's description word for word, that every permission in `extension/manifest.json` is justified here, and that nothing here promises what Lot Current cannot promise. The submission itself is Milestone 5 (PLAN.md): unlisted first.

The homepage, the support page and the support address are filled in: the website is `https://lotcurrent.com/` (it answers there once the Pages workflow has deployed it: `docs/launch-checklist.md`, "The domain and `siteUrl`") and the support inbox is `blawrence@lotcurrent.com`, the owner's own mailbox until a role address exists (`docs/support.md`). The three legal addresses are still the `lotcurrent.example` placeholders that `extension/src/legalLinks.js` holds, which the set-up wizard and Settings link to: the texts are attorney drafts, and the addresses become `https://lotcurrent.com/legal/terms/`, `https://lotcurrent.com/legal/privacy/` and `https://lotcurrent.com/legal/posting-rules/` only once they are final (`docs/website.md`, "After a deploy"); change this file and `legalLinks.js` together then. The other placeholders in [brackets] are filled in as their items under "Before submitting" are done.

## Item name

Lot Current

## Summary

Up to 132 characters. It is the manifest's `description`, the one source; edit `extension/manifest.json` and paste it here (the test fails when they differ).

Pre-fills Marketplace listings from your dealership's pre-owned inventory for you to publish, and flags sold cars and price changes.

## Detailed description

Lot Current is for car dealership salespeople who list their store's used cars on Facebook Marketplace from their own accounts. It reads your dealership website's used inventory, checks that every car is really pre-owned, pre-fills a Marketplace vehicle listing for you to review and publish, and on each rescan tells you what to take down, what to reprice and what's new.

You click Publish. Lot Current never does. It fills in the form and opens pages; a person publishes every post and every edit, and nothing is posted or edited in the background or while you're away. On its own, and only if you allow it, it re-reads your dealership's website every 3 hours while Chrome is open to keep your to-do count current and, while you are signed in to a Lot Current account, sends that rescan's results (your posted list, post records, to-do items and the scan's counts) to your dealership's account; it never opens or reads Marketplace then.

What it does

- Scans the dealership website's used inventory and shows the cars at your store that are pre-owned, priced and photographed as ready to post.
- Pre-fills the Marketplace vehicle listing: year, make, model, mileage, price, body style, colors, fuel type, transmission, location, a description written from the website's own facts, and the car's photos. You check every field and click Publish yourself.
- Writes the description from the website's data only, names the dealership and your role, and checks every number against the website before you see it.
- Rescans the website, by hand or every 3 hours while Chrome is open, and shows which of your listings to take down (sold, or sale-pending), which to reprice, and what's new. A button opens the right listing with the new price ready for you to apply; you click Update, Mark as sold or Delete.
- Keeps a daily post cap per salesperson that your dealership sets (10 by default). Meta doesn't publish its limits; this is a safety setting, not a guarantee.

What it won't do

- Click Publish, Update, Delete or Mark as sold. Ever. There is no code for it and a test that fails if any appears.
- Post new, demo or loaner cars, or anything the pre-owned check can't confirm.
- Invent prices or price drops. The listed price is the website price, and price changes only mirror the website.
- Make claims the website's data doesn't support, or hide that the car is at a dealership.
- Ask for, read or store your Facebook password, cookies or tokens; use fake delays, proxies or spoofing; or run more than your one account.

What it needs

- Chrome 116 or newer.
- A dealership website Lot Current can read. Checked on a real dealership website: Dealer Inspire websites that use the Cars Commerce inventory search. Also tries, not yet checked on a real dealership website: DealerOn and Dealer.com websites, and websites that publish standard vehicle data (schema.org) on their used-inventory pages; those readers have been tested only on sample websites so far. Other platforms come later.
- Your own Facebook account, signed in as usual. Lot Current never sees the login.
- A dealership that has signed up for Lot Current, and your manager's go-ahead. Your dealership stands behind every listing: the price, the fees and the dealer identification are its responsibility under advertising law.

Meta's Terms prohibit accessing its products "using automated means" without permission. Having a person click Publish is the most careful design available, but it is not a guarantee: we make no promise about how Meta treats any account or listing, and if Facebook ever warns you about your listings, stop and tell your manager. Lot Current is not affiliated with Meta Platforms, Inc. "Facebook" and "Marketplace" are used only as the names of the places you post.

Support: blawrence@lotcurrent.com and https://lotcurrent.com/support/. Terms of Service and Privacy Policy: [links, same as below].

## Category

Productivity. Lot Current is a work tool for people who sell cars: it prepares listings and keeps them accurate. Shopping is the other candidate because the listings end up on Marketplace, but that category is for extensions that help people buy (price comparison, coupons), and a reviewer landing there would expect one. If the dashboard asks for a subcategory, choose the one nearest to workflow tools.

## Language

English (United States).

## Screenshots

Five, 1280 x 800 pixels, PNG or JPEG. The end-to-end flows write reference screenshots to `test/e2e/screenshots/` (`npm run test:e2e`; the folder is not in git). They show what each store screenshot must show, but they are taken at the popup's and the side panel's own sizes against the mock dealer site and the mock Marketplace form, with the pilot fixtures as data, so they are not the store images. The owner takes the real ones at 1280 x 800 on a real dealership website with a real listing, with that dealership's OK, and blurs anything personal: the salesperson's name and Facebook profile, the listing address, and any customer detail on the page. No Facebook or Meta logo, wordmark or brand colour in any image, the real form's included: the owner crops each capture of a Facebook page below Facebook's top bar and covers any logo, wordmark or Facebook-blue button left in the frame with a solid box (`store/screenshots.md`).

Until then, `npm run screenshots` draws five draft images at 1280 x 800 from the in-browser sandbox (`demo/`) with its sample data into `site/screenshots/`, one per row of the table below, and the landing page shows them as what the sandbox looks like. The owner replaces them with the real ones per the table before submission; the drafts never go to the store.

| # | Shows | Reference from the e2e flows | Caption |
|---|---|---|---|
| 1 | The popup's Ready to post tab after a scan: pre-owned cars at the store with a Post button each, the counts on the tabs | `post-1-ready-post.png` (post flow) | Scan your website. Only pre-owned cars at your store are ready to post. |
| 2 | The side panel's review screen: the car re-checked on the website, the description drafted from the website's facts, the fields it will fill, condition and title from the dealership's defaults | `post-2-review.png` (post flow) | Read the description, then open the Marketplace form. |
| 3 | The Marketplace vehicle-listing form filled in, photos attached, Publish untouched | `post-4-mock-form.png` (post flow; the store image comes from a live run on the real form, with the account details covered, Facebook's top bar cropped off and any Facebook-blue button covered) | Every field filled in. You check it and click Publish. |
| 4 | The popup's To do tab after a rescan: a sold car to take down, a price change with the website's price next to the listing price, a new arrival | `5-rescan-todo.png` (popup flow) or `upkeep-1-todo.png` (upkeep flow) | Rescans flag sold cars and price changes on your listings. |
| 5 | The Numbers tab: time per post, fields that could not be filled, hours until to-do items were fixed, the CSV button | `post-7-pilot.png` (post flow) or `upkeep-4-pilot.png` (upkeep flow) | The numbers your manager sees: kept in your browser, and in your dealership's account while you are signed in. |

## Promo tile

Small promo tile, 440 x 280 (the dashboard says which sizes it takes at submission; the 1400 x 560 marquee is optional): the Lot Current icon and name on a plain background with the one line "You click Publish. Lot Current never does." No Facebook or Meta logo, wordmark, brand colour or screenshot in the tile (`legal/trademark-note.md`).

Drafts of both are generated by `node scripts/store-images.mjs` into `store/images/`: `promo-small-440x280.png` and `promo-marquee-1400x560.png`, drawn from `store/images/tile.html`. They show the extension's own mark (`site/favicon.svg`, drawn edge to edge; the 128 x 128 icon in the package carries the store's padding), the name and that line in white on the product's green, and nothing else. The script stops when the page's text differs from the line above, and checks each file's width and height in its PNG header before writing it; `test/storeImages.test.js` checks the sizes, that each file is under 1 MB, and that the page has no other words. To change the line, change it here and in `tile.html` together, then run the script again. The owner may replace either file with their own design under the same name and size, within the rules above.

## Single purpose

Lot Current helps a car dealership salesperson prepare Facebook Marketplace listings for the dealership's pre-owned vehicles from the dealership's own website inventory, and tells them when a listed car sold or changed price. The person publishes every listing.

## Permission justifications

From `extension/manifest.json`; this file follows the manifest, never the other way round. The longer answers are in `legal/chrome-web-store-privacy.md`; `test/manifest.test.js` checks that every pattern has one row of its own, with its reason, in the table below and in that file's, and that neither table has a row the manifest does not ask for. The bullet list is a summary and counts for nothing.

- Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, `alarms`, `notifications`
- Host permissions: `https://www.facebook.com/marketplace/*`, `https://vehicle-images.carscommerce.inc/*`
- Optional host permissions: `https://vpic.nhtsa.dot.gov/*`, `https://*/*`

| Pattern | One line for the dashboard |
|---|---|
| `activeTab` | Reads the inventory search on the dealership website tab the person is looking at when they click Scan website. |
| `scripting` | Runs the read-only scan in that tab; fills the Marketplace create-listing form Lot Current opens from the person's click (in a queue they started, each car's form in turn without another click, the next one once they have published the previous one); and, for a to-do item they open, reads that listing's page and puts the new price into its edit form. |
| `storage` | Scans, settings, the posted list and the usage numbers, per website, and the Lot Current sign-in session, in the person's browser; the profile (name, role, closing line, dealership details, listing defaults, the rewrite-service address, the Terms acceptance) in Chrome's sync storage under their own Google account, removable in Settings. |
| `sidePanel` | The guided post flow and the set-up wizard run in the side panel so they stay open while the person moves between the dealership tab and the Marketplace tab. |
| `alarms` | Re-reads a dealership website the person allowed every 3 hours while Chrome is open, to keep the to-do count on the icon current, and, while they are signed in to a Lot Current account, sends that rescan's results to their dealership's account; while signed in, it also tries a sync again a minute after the Lot Current server asked it to wait (more than a dozen syncs in a minute). It never touches Facebook. |
| `notifications` | One desktop notification when a background rescan adds to the person's to-do list; off in Settings if they prefer. |
| `https://www.facebook.com/marketplace/*` | Fills the vehicle listing form and attaches the car's photos on the create-listing page Lot Current opens for a post (or, for Open the form and check fields only, lists that form's fields without filling them); fills the new price on the listing's edit form; notices when the tab shows the published listing's address; and, while a to-do item the person opened is open, reads every 1.5 seconds the Marketplace page in the tab Lot Current opened for it (the listing, or Marketplace's Your listings page when no link was saved) for its title, prices and a sold sign. What is read is sent nowhere. Only the tab Lot Current opened is read, while that post or to-do item is open. |
| `https://vehicle-images.carscommerce.inc/*` | Downloads the car's own photos from Cars Commerce's photo server, which the Dealer Inspire dealership websites checked so far use for their cars' photos, so they can be attached to the form. Photos on any other server are requested under the optional pattern below, from the person's click. |
| `https://vpic.nhtsa.dot.gov/*` (optional) | Requested when the person clicks "Check with NHTSA": the free government VIN decode, compared with what the website says. |
| `https://*/*` (optional) | Never requested as such. The set-up wizard, and the popup's Settings when the person saves with the rescan box ticked or clicks Allow automatic rescans (a button the To do tab also shows when rescans are on but the permission was removed), request only the chosen dealership's website origin and its inventory-service origin, for background rescans; the side panel requests the same two origins from the person's click on Post, Post the next N or Rescan the website in its own Ready to post list (or Allow reading on a post stopped for it), so it can re-check the car or rescan without the dealership tab open; it also requests only the https servers the car being posted keeps its photos on, from the person's click on Open the Marketplace form, Fill it in now, Fill again or Download photos, so those photos can be attached to the form. |

Internal note, not for the dashboard: any other photo server is requested at post time from the person's click (owner's decision, 2026-09-29), and the static `https://vehicle-images.carscommerce.inc/*` host stays until the release that goes to the store; if it is dropped then, its row goes from the manifest, this table and `legal/chrome-web-store-privacy.md` together, and the install steps that name it (`README.md`, `docs/help.md`, `marketing/onboarding-store.md`) change with them (`test/manifest.test.js` checks they name exactly the manifest's hosts). The optional `https://*/*` is a broad host pattern, which the store says can mean a longer, in-depth review even though it is never requested as such (`store/submission.md`).

## Privacy practices

The answers are in `legal/chrome-web-store-privacy.md`: the single purpose, what the extension sends and to whom, the data-use ticks, the Limited Use certifications and "no remote code"; all of it follows `docs/data-inventory.md`. In short: personally identifiable information, yes (the person's name and role and any closing line they write, typed into Settings for the listing sign-off, and, when they sign in to a Lot Current account, the email address they sign in with); website content, yes (the dealership's inventory, the Marketplace form the person is filling in, and, while a to-do item is open, the title, prices and sold sign of the listing page or Your listings page Lot Current opened for it); personal communications, health and financial, no. Authentication information [Pending attorney answer: questions-for-attorney.md 8.1], location [Pending attorney answer: questions-for-attorney.md 8.2], web history [Pending attorney answer: questions-for-attorney.md 8.3] and user activity [Pending attorney answer: questions-for-attorney.md 8.4] wait for the attorney's answers, and so does the submission. What leaves the browser: reads of the dealership's website, requests for the car's photos to the servers the website names for them when the person fills a form or downloads the photos, and when the side panel's review screen shows them as pictures so the person can pick which to post, the VIN to NHTSA when the person asks, the car's facts to Anthropic through our rewrite service only with the description writer on, and, when the person signs in, their posted list, post timings, to-do items and scan counts to their dealership's records. Data is not sold, not used for anything unrelated to the single purpose, and not used for creditworthiness. Privacy policy URL: `https://lotcurrent.example/privacy` (the placeholder `extension/src/legalLinks.js` holds until the text is final; the text is `legal/privacy-policy.md`, an attorney draft, and its final address will be `https://lotcurrent.com/legal/privacy/`).

## Test instructions

Everything after the line below goes into the dashboard's "Test instructions" box for the reviewer, as plain text. No account details are given: Lot Current has no login of its own that the reviewer needs, and a shared Facebook account would break the product's own rule of one person, one account. Kept to what a reviewer can do on public pages with their own browser.

---

Lot Current needs no account or sign-in for this test.

1. Open this dealership's used-inventory page: [a public used-inventory page on a Dealer Inspire website that uses the Cars Commerce inventory search, picked by the owner with that dealership's OK]. Please use that page: Dealer Inspire is the one website platform Lot Current has been checked on with a real dealership website, and its readers for other platforms have been tested only on sample websites so far.
2. Click the Lot Current icon in the toolbar. The first time, click Set up Lot Current and follow the few steps in the side panel (the website, the store, a name and role for the listing's sign-off; any test name works). Set-up reads the website and ends with one more read, so when it is done, click the Lot Current icon again: the Ready to post tab already lists the pre-owned cars at that store (Rescan website, at the top of the popup, reads the website again). New, demo and loaner cars never appear under Ready to post.
3. Click Post on any car. The side panel opens, re-checks that car on the website and shows the description it wrote from the website's facts, with the dealership's name.
4. To see the form fill, sign in to your own Facebook account in the same window and click "Open the Marketplace form" in the side panel. Lot Current opens the vehicle listing page and fills in the fields and photos. It does not click Publish, and there is no code for it to do so. Close the tab without publishing; nothing is posted unless a person clicks Publish.
5. Settings (a button at the top of the popup) shows the daily post cap and what is kept in the browser. Background rescans happen only for a website you allow, in the set-up wizard or in Settings (Chrome asks for the permission first), every 3 hours while Chrome is open; while you are signed in each one also syncs your posted list, post timings and to-do items with your dealership's account, and none opens or reads Marketplace.

Lot Current is not affiliated with Meta Platforms, Inc.

## Support and homepage

- Homepage: `https://lotcurrent.com/`
- Support: `blawrence@lotcurrent.com` (the owner's own until a support address exists; it must receive mail before the submission) and `https://lotcurrent.com/support/`
- Privacy Policy: `https://lotcurrent.example/privacy`
- Terms of Service: `https://lotcurrent.example/terms`
- Posting rules: `https://lotcurrent.example/posting-rules`

The three document addresses must equal `LEGAL` in `extension/src/legalLinks.js`: placeholders while the texts are drafts, the `https://lotcurrent.com/legal/...` pages once they are final.

## Before submitting

- [ ] The questions in section 8 of `legal/questions-for-attorney.md` answered, and no "[Pending attorney answer" mark left in `legal/privacy-policy.md`, `legal/chrome-web-store-privacy.md`, this file or `docs/data-inventory.md`.
- [ ] Attorney sign-off on `legal/terms-of-service.md`, `legal/privacy-policy.md`, `legal/posting-rules.md` and `legal/chrome-web-store-privacy.md`; the texts hosted at their real addresses (`npm run legal-pages` with `"draft": false` in `legal/legal-status.json`, then `site/` deployed: `/legal/terms/`, `/legal/privacy/`, `/legal/posting-rules/`); `extension/src/legalLinks.js` updated (the three addresses and `version`, which re-asks every salesperson to accept).
- [ ] Real screenshots: five at 1280 x 800, taken by the owner on a real dealership website with a real listing, personal data blurred, per the table above.
- [ ] Promo images: `store/images/promo-small-440x280.png` and, if the dashboard takes it, `store/images/promo-marquee-1400x560.png`; the drafts from `node scripts/store-images.mjs` regenerated after any change to the line or the icon, or the owner's replacements at the same sizes, per the Promo tile section above.
- [ ] The photo-host permission checked by hand in real Chrome (`docs/launch-checklist.md`), and a decision on whether `https://vehicle-images.carscommerce.inc/*` leaves `host_permissions` at this release (PLAN.md, "Decided by the owner on 2026-09-29"); if it does, change the manifest, `legal/chrome-web-store-privacy.md`, this file and the install steps in `README.md`, `docs/help.md` and `marketing/onboarding-store.md` together.
- [ ] `npm test` and `npm run test:e2e` green, then `npm run pack`: the zip in `dist/` is what the dashboard takes, and the version in `manifest.json`, `package.json` and `package-lock.json` is one and the same (tested).
- [ ] Visibility: Unlisted for the pilot and the design partners; Public only after the review passes and the owner says so.
- [ ] The summary above still equals the manifest description (tested), and the detailed description says who publishes, that Lot Current is not affiliated with Meta Platforms, Inc., and nothing about what will happen to anyone's account.
- [ ] Every [bracketed] placeholder filled in, and no Meta logo, wordmark or brand colour in the icon, the tile or the screenshots.
- [ ] The support address under "Support and homepage" receives mail: send it a message from another account and see it arrive. `npm run store-check` accepts the inbox `site/config.js` names (`supportEmail`) or a `support@` address there, but it cannot see a mailbox.
- [ ] `npm run store-check -- --strict` passes: nothing wrong with the package or the listing, and nothing left before a submission (`store/submission.md` walks the dashboard).
