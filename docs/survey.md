# Surveying a real dealer website

`npm run survey` (`scripts/survey.mjs`, with its pure parts in `scripts/survey-lib.mjs`) answers two questions about a dealer website before anyone writes an adapter for it: **what do its pages look like**, and **what does Lot Sync read from it today**. It is how a platform goes from "to be verified on a real site" (`extension/adapters/README.md`, `docs/next-platform.md`) to a written finding with a site and a date.

It is a polite survey of a few pages, not a crawl. It reads a handful of pages the way a person's browser would, and it stops the moment a website says no.

## What it does

For each used-inventory address you give it, in Playwright's own Chromium with the real Lot Sync extension loaded (a temporary copy, the way the end-to-end tests load it):

1. **robots.txt, once.** A page that robots.txt disallows for every robot (`User-agent: *`) is not read, and the report says so. If the list page itself is disallowed, the site is not surveyed at all. A `Crawl-delay` makes the pause between pages longer, never shorter. If robots.txt answers 401, 403, 429 or a server error, the rules can't be known and the site is not surveyed.
2. **The list page, as the browser shows it**, then **its server HTML once** (the browser context's own request, no scripts run). Comparing the two shows whether the car links and VINs are in the page as the server sends it, or only appear after the page's scripts run. That matters: Lot Sync's standard-data reader and its background rescans read pages without running their scripts.
3. **Up to `--max-car-pages` car pages** (default 5, never more than 10) linked from the list, one at a time. Addresses with a VIN in them are picked first, one per car.
4. **Lot Sync's own scan**: the extension's popup is opened against the list tab, **Scan website** is clicked, and the survey waits for it to finish. Then it records which adapter answered (or the "can't read the cars on this page" message), the car count, how many cars have a VIN, a price, mileage and photos, the warnings shown, and the first three cars as Lot Sync stored them.

For each page it records:

- **Platform fingerprint**: the meta generator, the hosts the page's scripts and assets come from, and known markers for Dealer Inspire, DealerOn, Dealer.com, DealerFire, Dealer eProcess, Sincro, Team Velocity, Carsforsale.com and a few others. The report lists the exact evidence strings. When nothing matches it says **unknown**; the address shape alone (such as `.aspx`) is reported as a hint but never decides the platform. The markers are starting points written from general knowledge, not checked against real sites yet, so read the evidence, not only the name.
- **schema.org data**: the JSON-LD blocks and their `@type` values, whether each vehicle node has a VIN, `offers.price`, `priceCurrency`, `mileageFromOdometer` and `image`, and the microdata item types.
- **Pagination**: `rel=next`, page-number parameters such as `?page=` or `?pt=`, `/page/2/` paths.
- **JSON the page itself asks for**: when the page's own scripts fetch JSON that holds VIN-like strings, the address pattern (query values blanked) and the top-level keys. The data itself is never saved.
- **Photo hosts** on car pages, and **bot-check signs** (Cloudflare, Akamai, Imperva, DataDome, PerimeterX, captcha wording, HTTP 403, 429, 503).

It writes, per site, `survey-out/<host>/report.json` (everything) and `report.md` (a readable summary ending in a one-line verdict), plus `survey-out/summary.md`, one table row per site. The verdict is one of:

- **reads it**: Lot Sync read the cars, and most have a price, mileage and photos.
- **partly**: it read cars, but with a gap the report names (most cars without a price, fewer cars than the list links to, cars that appear only after scripts run, a scan warning).
- **doesn't read it**: no adapter answered, or the scan found no cars. The report says why.
- **not surveyed**: the survey stopped before Lot Sync's scan could run (a refusal, robots.txt, an unreachable site). The reason is in the report.

A car without a price or photos is only a note when it is a few cars: the website may really show none for them ("call for price", a new arrival). Compare a car page before calling it a Lot Sync problem.

## The request cap

Per site, the survey itself asks for **at most 3 + `--max-car-pages` pages** (robots.txt, the list page, the list's server HTML, and up to 5 car pages by default, so 8), **each at least 2 seconds after the one before**. The pause is fixed, never random.

Lot Sync's own scan then runs as a salesperson's click would: two pages at a time, no pauses, as the product does. In the survey's copy of the extension its limits are lowered to **5 list pages, 2 sitemaps and 10 car pages** (`--scan-car-pages` changes the last; as shipped the limits are 40, 5 and 600), so a large lot is not read in full. The report notes when that cap left pages for later, and does not count it as a gap. A Dealer Inspire website is read through its inventory search instead, in a few requests.

While a page is open the browser also loads its scripts and styles, as any visit does. Images, video and fonts are not downloaded, and no photo is ever saved. Every report states the cap and counts what was actually asked for.

## The honesty rules

- **The browser as it is**: Playwright's Chromium with its own user agent. Nothing is spoofed, hidden or randomised; no proxy.
- **No means no**: a 403, 429 or 503, or a challenge page, stops that site at once and is recorded. Nothing is retried and nothing is worked around.
- **robots.txt is respected** for every page the survey itself reads, and Lot Sync's scan is not run on a site whose robots.txt disallows most of the car pages that scan would read.
- **Facebook is never opened**: the survey refuses a Facebook address, and any request to Facebook's servers is blocked and counted. Nothing is posted anywhere.
- **Small excerpts only**: at most one JSON-LD block from one car page, cut at 4 KB. Never a whole page, never a photo, never the body of a JSON answer.

## Running it

You need Node 22 or newer and Playwright's Chromium, the same setup as the end-to-end tests (see README, "For development"). Give it the used-inventory list page, the one a salesperson would open, for example `/searchused.aspx` on a DealerOn site or `/used-inventory/index.htm` on a Dealer.com site.

### Windows (PowerShell)

PowerShell can drop the `--` that `npm run` needs, so call the script with Node directly:

```
cd E:\LotSync
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\ms-playwright'
$env:TEMP = 'D:\lotsync-tmp'; $env:TMP = 'D:\lotsync-tmp'
node scripts\survey.mjs https://www.example-dealer.com/searchused.aspx https://www.example-motors.com/used-inventory/index.htm
```

Add `--headed` to watch the browser, `--max-car-pages 3` to open fewer car pages, `--out D:\survey-out` to write the reports elsewhere. In `cmd.exe`, `npm run survey -- <address> ...` works as well.

### Linux or macOS

```
npm run survey -- https://www.example-dealer.com/searchused.aspx https://www.example-motors.com/used-inventory/index.htm
```

Set `PLAYWRIGHT_BROWSERS_PATH` if Playwright's Chromium lives somewhere other than its default folder. When the Chromium build Playwright expects is not installed, the survey uses the one named by `LOTSYNC_CHROME`, or `/opt/pw-browsers/chromium` when it exists. Branded Google Chrome and Edge 137+ ignore `--load-extension`, so they can't run it.

The survey prints what it is reading as it goes, and the summary's path at the end.

## What to send back

Zip the whole `survey-out` folder and send it. The part that matters most is `summary.md` and each site's `report.md` and `report.json`.

What is in it: the public pages' anatomy (counts, types, hosts, address patterns), the first JSON-LD block of one car page, and the first three cars as Lot Sync read them (VIN, name, price, mileage, photo count, decision), all of it public inventory data from the dealer's own website. No cookies, no passwords, no photos, nothing from Facebook. `survey-out/` is in `.gitignore`, so it is not committed by accident; the findings go into `extension/adapters/README.md` and `docs/next-platform.md` in words, with the site and the date.

If a site was refused or not surveyed, send that report too: a refusal is a finding.
