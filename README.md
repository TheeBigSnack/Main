# Lot Sync (v0.1)

A Chrome extension that reads your dealership website's used inventory, checks every car is really pre-owned, and on each rescan tells the salesperson what to take down, what to reprice and what's new.

**It doesn't touch Facebook yet.** This version only reads your own dealership website. Posting to Marketplace comes next and will plug into this.

## Install (each tester, about 2 minutes)

1. Unzip this folder somewhere it'll stay, like Documents.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder inside this folder.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Lot Sync**.

## Use

1. Open the dealership website's used inventory page, e.g. `ronlewischryslerdodgejeepramwaynesburg.com/used-vehicles/`.
2. Click the Lot Sync icon, then **Scan website**. The first scan is the starting point.
3. **Ready to post** lists pre-owned cars at your store that have photos and a price. After you list one on Marketplace, click **Mark posted**.
4. Click **Rescan website** any time (once a day is plenty). The **To do** tab shows:
   - **Take down:** cars gone from the website (sold or removed), and posted cars that went sale-pending.
   - **Update price:** website price went up or down. Your listings show the price on Marketplace next to the new website price. Click **Updated** or **Taken down** once you've done it.
   - **New arrivals** and **Just became ready**, e.g. a car that got its photos.
5. **Settings:** pick your store, and whether Marketplace gets the website's main price (includes the $490 doc fee on this site) or the price before fees.

Each salesperson's scans and posted list are kept only in their own browser.

## How the pre-owned check works

Three separate signs on the dealer website have to agree the car is pre-owned:

1. the inventory type from the dealer's system (Used / Certified Used / New)
2. the condition word in the car's web address (`/inventory/used-2019-...` vs `/inventory/new-2027-...`)
3. the condition word at the start of the listing title ("Pre-Owned 2019 ...")

A demo or loaner flag always means "sold as new". A Carfax report counts as a supporting sign, but a missing one never blocks a car. Mileage is never used to call a car used. Anything that disagrees or looks off, like a used car showing 0 miles, goes to **Needs a look** instead of being posted.

After that, a pre-owned car is **ready to post** only if it has photos, a price, is on the lot, isn't sale-pending, and is at your store.

## What the first live test found (Ron Lewis CDJR Waynesburg, Sept 26, 2026)

- 124 used and certified cars on the used page, read in one request (about a third of a second)
- only 28 are at Waynesburg; 55 are at Cranberry and 41 at Pleasant Hills (the used page shows the whole group)
- 20 ready to post at Waynesburg
- 2 need a look: a 2023 Honda Pilot and a 2023 Jeep Renegade both show 0 miles on the website
- 7 pre-owned cars have no Carfax link, so a Carfax-only rule would have skipped them
- across all 617 vehicles, all 493 new ones were skipped, including 18 "new" units with 1,000 to 29,000 miles (demos/loaners the system doesn't flag)
- the website's own paging repeats some cars and skips others, so the scan checks its count against the total, and a car is only called gone after a direct VIN lookup can't find it

## Limits

- Works on Dealer Inspire websites that use the Cars Commerce inventory search (`window.SEARCH_SERVICE` on the page). Other website platforms need their own `normalize.js` and `scan.js`.
- It reads the same inventory search the website itself uses. If Dealer Inspire changes it, the scan stops with an error rather than guessing.
- If more than half the cars vanish between scans, nothing is marked gone and the tool shows a warning. That pattern is almost always a website problem, not a sales day.

## For development

```
npm test          # 40 unit tests on real records from the site (Node 20+)
npm run test:e2e  # loads the extension in Chromium against a mock dealer site (needs Playwright)
```

| File | What it does |
|---|---|
| `extension/src/scan.js` | Runs in the dealer tab; reads the used inventory and double-checks missing VINs |
| `extension/src/normalize.js` | Turns a website record into a flat vehicle (price, location, photos...) |
| `extension/src/classify.js` | The pre-owned check and the ready-to-post check |
| `extension/src/rescan.js` | Compares scans: sold, price changes, new arrivals |
| `extension/popup.*` | The window you see when you click the icon |
| `test/fixtures/records.json` | Real records from the Waynesburg site, one per edge case |
