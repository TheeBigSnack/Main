# The next website platform: decision memo

A template to fill in during Milestone 6. `PLAN.md` says the next dealer-website platform is picked from demand among Dealer.com, DealerOn, Dealer eProcess and DealerFire, and that the milestone is only done when **the next platform is chosen with a written reason and a named first dealer**. This file is where that gets written.

Today Lot Sync reads one platform: Dealer Inspire websites that use the Cars Commerce inventory search (`extension/adapters/dealerInspire.js`, detected by `window.SEARCH_SERVICE` on the page, service host `websites-search.api.carscommerce.inc`). Each new platform is one file under `extension/adapters/` behind the same interface: `detect(probe)`, `scan(search, options)`, `normalize(record)`, `getDetails(search, vin)`, `makeDirectSearch(service)`, plus `origins(service)` and `photoOrigins(records)` for the permissions. The M6 work in `PLAN.md` ("Wider use") completes that contract with the second platform: probe and search per adapter, normalise inside the adapter, an opaque service, photo hosts.

## What each platform needs before it can be built

From `extension/adapters/README.md`: for each platform, confirm the used/new signal (the three-sign pre-owned check needs an inventory type, a URL condition word and a title condition word, or equivalents), where the description and features live, and the photo host (a host permission). None of that can be confirmed from a description. It needs a real dealer site and, ideally, a dealer who has said yes.

## The candidates

Only what the repository already says is written here. Everything else is marked "to be verified on a real site" and stays that way until someone has opened one.

### Dealer.com

- **Detection**: to be verified on a real site.
- **Inventory**: `extension/adapters/README.md` says inventory comes from its own JSON endpoints behind the search results page, and each page embeds a vehicle data object. It needs a probe for the page's inventory API and a normaliser for its record shape. Which endpoint, what the record looks like, and whether it can be called from the dealer's own tab without a permission: to be verified on a real site.
- **Pre-owned signal (inventory type, URL word, title word)**: to be verified on a real site.
- **Description and features**: to be verified on a real site.
- **Photo host**: to be verified on a real site.
- **Address data (for the Location field)**: to be verified on a real site.
- **Known dealers on it**: none named yet. `HANDOFF.md` records a Dealer.com adapter as an idea the owner has not asked for, "needs a real site to verify".

### DealerOn

- **Detection**: to be verified on a real site.
- **Inventory**: `extension/adapters/README.md` says the listings are server-rendered with a search API used by the search results page's filters, and that VIN, price and status are present in the page's data layer. The API's shape and whether the data layer alone is enough for a scan: to be verified on a real site.
- **Pre-owned signal**: to be verified on a real site.
- **Description and features**: to be verified on a real site.
- **Photo host**: to be verified on a real site.
- **Address data**: to be verified on a real site.
- **Known dealers on it**: none named yet.

### Dealer eProcess

- **Detection**: to be verified on a real site.
- **Inventory**: `extension/adapters/README.md` says inventory JSON sits behind the search results page with a different pricing block, and that the Carfax link is a separate feed. The pricing block matters: Lot Sync's price basis (the main price, or the lower second price when the website shows one) has to map onto it honestly, and the Carfax flag is a supporting sign in the pre-owned check. Both: to be verified on a real site.
- **Pre-owned signal**: to be verified on a real site.
- **Description and features**: to be verified on a real site.
- **Photo host**: to be verified on a real site.
- **Address data**: to be verified on a real site.
- **Known dealers on it**: none named yet.

### DealerFire

- **Detection**: to be verified on a real site.
- **Inventory**: `extension/adapters/README.md` says the platform is WordPress-based with an inventory plugin, and records are in page HTML and a JSON feed. Whether the feed is complete enough for the scan (VIN, price, status, photos) or the HTML has to be read: to be verified on a real site.
- **Pre-owned signal**: to be verified on a real site.
- **Description and features**: to be verified on a real site.
- **Photo host**: to be verified on a real site.
- **Address data**: to be verified on a real site.
- **Known dealers on it**: none named yet.

## The criteria

In this order. The first two decide; the rest say how much work it is.

1. **Demand from named dealers.** Which dealers have asked, or have said yes to a pilot, and which platform their website is on. A platform nobody has asked for is not picked, whatever its technical merits. Write the dealer names in the table below, not in code.
2. **A real site to verify against.** A dealer on the platform who will let us scan their site during the build, and ideally one of the design partners. Without one, the adapter cannot be verified and the platform is not ready to pick.
3. **How the inventory is exposed.** A JSON service the dealer's own page already calls (like Dealer Inspire) is the least work and the most robust. A data layer or a feed is next. Reading page HTML is the most fragile. For each: can it be called from the dealer's tab with no permission for the popup's scan, and from the background with one host permission for the rescans?
4. **The pre-owned signal.** Are there three independent signs (inventory type, a condition word in the URL, a condition word in the title), or equivalents the classifier can use? Fewer than three means a weaker gate, and that must be written down and accepted, or the platform waits.
5. **Photo host.** One host, or many? A host permission is needed to attach photos, and the manifest change goes with the owner's photo-host decision in `PLAN.md`. Many hosts favour the request-at-post-time design.
6. **Address data.** Does the site publish the store's address in structured data the probe can read, so the Location field and the state guard work without typing? If not, the wizard's address step carries it, which is acceptable but must be noted.
7. **Group websites.** Does the platform put several rooftops on one site, and does each record say which store the car is at? The "Other stores" tab and the store tick in Settings depend on that.
8. **Description quality.** Where the write-up and the feature list live, and how much boilerplate the lot shares, so `description.js` can strip it with the same per-website observation it uses today.

## Scoring

Fill in one row per candidate. Use the words in each column, not numbers, so nobody adds them up. "Unknown" is a valid entry and means the platform is not ready to pick.

| Criterion | Dealer.com | DealerOn | Dealer eProcess | DealerFire |
|---|---|---|---|---|
| Demand: dealers who asked (names) | | | | |
| Demand: dealers who said yes to a pilot (names) | | | | |
| A real site we may verify against (which) | | | | |
| How inventory is exposed (service / data layer / feed / HTML) | | | | |
| Callable from the dealer's tab without a permission (yes / no / unknown) | | | | |
| Pre-owned signs available (three / fewer / unknown) | | | | |
| Photo host (one / many / unknown) | | | | |
| Address in structured data (yes / no / unknown) | | | | |
| Group websites with a store per record (yes / no / unknown) | | | | |
| Description and features location (known / unknown) | | | | |
| Estimated work (small / medium / large, and why) | | | | |

## Verification steps for the chosen platform, before the adapter is written

1. Open the first dealer's used inventory page and record what the page exposes: any global inventory object, the network calls the search results page makes when a filter changes, the structured data on the page.
2. Save one real record per edge case into `test/fixtures/` under a name for that platform, with the dealer's agreement: a used car, a certified car, a new car, a demo or loaner if the site has one, a car with no price, a car with no photos, a car at another store if the site is a group site.
3. Write down the three pre-owned signs (or the equivalents) and where each comes from.
4. Write down the photo host or hosts and the address source.
5. Only then write `extension/adapters/<platform>.js` and its tests on those fixtures, and run the popup's scan on the real site with the owner present.

## Required output

This line is the acceptance criterion from `PLAN.md` Milestone 6. The milestone is not done until it is filled in.

> **Chosen platform:** [platform]. **Reason:** [the written reason, in two or three sentences, from the criteria and the table above]. **First dealer:** [dealer name, contact, and the address of their used inventory page]. **Decided by:** [name], on [date].

If no candidate has a named dealer and a real site to verify against, the honest output is "not chosen yet" with what is missing, and the milestone stays open.
