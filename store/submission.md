# Submitting to the Chrome Web Store: the walk-through

What the owner does in Google's Chrome Web Store Developer Dashboard, in order, and where each answer comes from. Nothing here is done by a script: `npm run store-check` only reads the repository and says what is wrong or still missing. Creating the developer account, paying its fee, the trader declaration and pressing Submit are the owner's, every time.

The texts to paste live in `store/listing.md` (listing, test instructions, permission lines) and `legal/chrome-web-store-privacy.md` (privacy answers). This page says which box each goes in and what to watch for.

## Sources, and how current they are

The store's rules were read on 2026-10-01 from Google's developer documentation (developer.chrome.com, "Chrome Web Store" section: Prepare your extension, Supplying images, Complete your listing information, Fill out the privacy fields, Program policies, Review process, Distribution, Register your developer account, Trader disclosure). The live pages could not be opened from the build environment, so the facts come from the published source of those pages and from search results quoting the live ones. Where they disagreed or a figure could not be confirmed, this page says so. The dashboard itself is the final word: if it asks for something this page does not cover, follow the dashboard and update this page.

## 0. Before the first visit (once)

1. **A Google account for the business**, not a personal one, with 2-Step Verification turned on (the store requires it before publishing or updating). Use an address on `lotcurrent.com` once its mailbox receives mail; the dashboard sends review results there.
2. **Register as a developer** at the Chrome Web Store Developer Dashboard and pay the one-time registration fee. The fee was reported as US$5 when last checked; Google's page shows the current amount. This costs money: owner only.
3. **Verify the contact email** the dashboard asks for.
4. **Trader or non-trader (EU Digital Services Act).** Every developer declares one. Lot Current sells subscriptions to dealerships, so it is a trader. A trader gives a legal name, address, phone number and email (and a D-U-N-S number for an organisation); Google verifies them and **shows them on the store listing**. Before the company exists that would be the owner's own name and address. This is a question for the attorney (`legal/questions-for-attorney.md`, section 6) before the declaration is made. Whether the details are shown only to people in the EU or to everyone could not be confirmed; plan for everyone.
5. **Optional: verify `lotcurrent.com`** in Google Search Console with the same Google account. The listing's "Official URL" field accepts only a verified site; without it, the Homepage URL field still links to the website.

## 1. Package

1. `npm test`, `npm run test:e2e`, `npm run test:demo` green; for a release, `npm run release -- <version>` (`docs/release.md`).
2. `npm run pack`, then `npm run store-check -- --strict`. Strict mode also fails while anything it can see is still open (placeholders, the attorney's pending answers, draft legal pages, missing screenshots, a support address on the listing that is neither the inbox `site/config.js` names nor a `support@` one). It cannot see the attorney's answers on the Developer Agreement and the trader declaration, whether the support address receives mail, or whether all five screenshots are the right ones; those stay on the "Before submitting" list in `store/listing.md`.
3. Dashboard: **Add new item** (first time) or the item's **Package** page, upload `dist/lot-current-extension-<version>.zip`. The manifest is at the zip's top level (`npm run store-check` checks the zip against `extension/`).

The summary on the store comes from the manifest's `description` and cannot be edited in the dashboard; change it in `extension/manifest.json` and `store/listing.md` together.

## 2. Store listing tab

| Field | From |
|---|---|
| Description (detailed) | `store/listing.md`, Detailed description: everything under the heading, as plain text |
| Category | Productivity (`store/listing.md`, Category) |
| Language | English (United States) |
| Store icon | Taken from the package (`extension/icons/icon128.png`: the mark at 96 x 96 inside 16 transparent pixels, as the store's image guidance asks; `npm run extension-icon` redraws it) |
| Screenshots | `store/screenshots/1.png` to `5.png` (`store/screenshots.md`), 1280 x 800 |
| Small promo tile | `store/images/promo-small-440x280.png` (required; items without one are shown after items with one) |
| Marquee promo tile | `store/images/promo-marquee-1400x560.png` (optional; only used if Google features the item) |
| Promo video | None for now |
| Official URL | `https://lotcurrent.com` once verified in Search Console, else leave empty |
| Homepage URL | `https://lotcurrent.com/` |
| Support URL | `https://lotcurrent.com/support/` |
| Mature content | No |

## 3. Privacy tab

| Field | From |
|---|---|
| Single purpose | `store/listing.md`, Single purpose (the same text is in `legal/chrome-web-store-privacy.md`) |
| Permission justification, one box per permission | `store/listing.md`, Permission justifications: the right-hand cell for each row, without the backticks |
| Host permission justification | The rows for `https://www.facebook.com/marketplace/*`, `https://vehicle-images.carscommerce.inc/*`, and the two optional patterns, if the dashboard asks for them separately |
| Are you using remote code? | **No, I am not using remote code.** True by design: the extension runs only the files in its package, and `npm run store-check` fails a content security policy that would let other code in. The same check scans the package's source text for the usual ways to load or run outside code: a script, import or stylesheet from another host, a dynamic import of a computed address, `eval` (called or passed on), `new Function`, `importScripts`, a timer given a string, a `<script>` written into a page or built in code, and a worker from another host. A text scan cannot catch every form (a script element whose tag name sits in a variable, for one), so before a release read any new code that runs inside a web page with this in mind |
| Data usage: what the item collects | `legal/chrome-web-store-privacy.md`, Data use disclosures. Four answers (authentication information, location, web history, user activity) wait for the attorney (questions 8.1 to 8.4); nothing is submitted until they are answered |
| The three certifications | Tick all three; the wording is in `legal/chrome-web-store-privacy.md`, Certifications |
| Privacy policy URL | `https://lotcurrent.com/legal/privacy/`, once the attorney has approved the text and it is published there as final (`legal/legal-status.json` says `"draft": false`) |

The answers here are shown to users on the listing, so they must say what the Privacy Policy says. `docs/data-inventory.md` is the source for both.

## 4. Distribution tab

- **Visibility: Unlisted.** Anyone with the link can install; the item is not in search. Unlisted items get the same review as public ones. Public only after the review passes and the owner says so (`docs/release.md`).
- **Regions:** United States, unless the attorney advises otherwise; the product, the address handling and the legal texts are written for US dealerships.
- **Pricing:** free to install. Dealerships pay through Lot Current's own billing, not through the store.
- **Test instructions:** `store/listing.md`, Test instructions. Fill the one bracket (a public dealership page the extension reads, picked by the owner with that dealership's OK) before pasting. No account details are given to the reviewer: Lot Current has no login a reviewer needs, and a shared Facebook account would break the product's own rule.

## 5. Submit

Press **Submit for review** only when `npm run store-check -- --strict` passes and every box in `store/listing.md`, "Before submitting", is ticked. After approval the dashboard can publish at once or let the owner publish later (it holds an approved item for a limited time; the dashboard shows the deadline).

## What can slow or fail the review, and what we did about each

| Risk | Where it comes from | Where we stand |
|---|---|---|
| Longer, in-depth review | A new developer account, a new item, and broad host permissions (`https://*/*` is listed as one, even though ours is optional and never requested as such) | Expected for the first submission; the permission line explains that only the dealership's own website and the car's photo servers are ever requested, from the person's click. Leave time for it in the launch plan |
| Deceptive behaviour or impersonation | Implying the item is made, endorsed or approved by another company | The listing says Lot Current is not affiliated with Meta Platforms, Inc., uses "Facebook" and "Marketplace" only as plain names, and no Meta logo is anywhere (`legal/trademark-note.md`, `test/manifest.test.js`, `test/storeImages.test.js`) |
| Keyword spam | Repeating brand names or keywords, lists of sites or places | `npm run store-check` fails when the detailed description names another company more than 5 times; no list of dealer websites or towns anywhere in the listing |
| Spam and abuse | Sending messages or posts for the user without letting them confirm the content | The person reviews every field and clicks Publish themselves; the extension has no code to publish (`test/posting.test.js`) |
| Developer Agreement and third-party terms | Google's agreement forbids an item that knowingly violates a third party's terms of service; Meta's Terms prohibit automated access without permission | Not something the code can settle: it is on the attorney's list (`legal/questions-for-attorney.md`, section 1) and must be answered before the owner accepts the agreement and submits |
| Use of permissions | Asking for more than the feature needs | Every permission is justified per pattern, and `test/manifest.test.js` fails on any permission not in the approved list. Dropping the static photo host before the store release is the owner's open decision (`store/listing.md`, Before submitting) |
| Remote code, obfuscation | Code from another host, or code made hard to read | None: plain, unminified ES modules. `npm run store-check` scans the source text for the usual forms, which cannot catch every one (the remote-code answer above says which it looks for) |
| Missing privacy policy or mismatched disclosures | User data handled without a matching policy | The policy, the store answers and the data inventory follow one another; the policy is published as final only after the attorney's approval |

## After a rejection

The email and the dashboard name the policy. Log it in the support log (`docs/support.md`), fix it on a branch, release a new version (`docs/release.md`; the store only takes a higher version) and submit again. If the fix is in the listing or privacy answers only, edit them in the repository first, then paste.
