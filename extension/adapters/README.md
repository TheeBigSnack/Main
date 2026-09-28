# Dealer-website adapters

Every platform Lot Sync reads lives here, one file per platform (plus a normaliser file next to it when that reads better), behind one contract. `index.js` lists the built adapters in `ADAPTERS`, in the order their in-page probes are tried. Nothing outside this folder knows a platform's name, its service, its record shape or its photo host: `src/scanRunner.js`, `src/vehicleDetails.js`, `src/rescanSchedule.js` and `background.js` only ever call the functions below.

Adding a platform: one new file here, its line in `ADAPTERS`, a real record of its shape in `test/fixtures/` and its entry in `PLATFORM_FIXTURES` in `test/adapters.test.js`. The contract test then checks everything in the table. No new permission: the site's own origin is what the popup already has (`activeTab`), the service origin is asked for by the wizard (`optional_host_permissions`), and photo hosts are recorded, never requested (a permission change is the owner's call).

## The contract

| Function | What it does |
|---|---|
| `PLATFORM` | `{ id, name }`. `id` is the key stored on the site registry entry, the snapshot and the settings (`dealerInspire`); `name` is what people see (the unsupported-page message lists every adapter's `name`: "platforms today: Dealer Inspire"). |
| `probeInPage()` | Runs **inside the dealer tab** (`chrome.scripting.executeScript`, world MAIN, injected by `scanRunner.probeTab` after the neutral `src/scan.js probeSiteInPage`). Returns this platform's `service` (whatever the adapter needs later: addresses, keys, status values) or `null` when the page is not this platform. The service is the adapter's own data: it is stored as-is on the site registry entry (`sites[origin].service`) and no code outside the adapter reads its fields. |
| `searchInPage(service, body)` | Runs **inside the dealer tab** (injected by `scanRunner.searchViaTab`): one search request made the way the page's own code makes it, so no host permission is needed. Returns `{ ok: true, data }` or `{ ok: false, error }`. |
| `detect(probe)` | Does this adapter handle a probe? The probe is `{ site, service, adapterId }` from `scanRunner.probeTab`; `index.js detectAdapter` prefers `adapterId` (the probe that answered) and falls back to `detect`, which also finds the adapter for a stored service (`adapterForService`). |
| `origins(service)` | The host-permission patterns (`https://host/*`) background rescans need to reach the service directly. `src/rescanSchedule.js originsFor(site, list)` adds the website's own origin; it also accepts the stored service (the wizard and the popup pass it) and asks the site's adapter for the list. |
| `scanOptions(service)` | The options `scan` and `getDetails` need from the service (Dealer Inspire: `{ status: service.visibleStatusValues }`). `scanWithSearch` spreads it into `scan`'s options. |
| `scan(search, { status, vins, confirmVins, fullRecords })` | Reads the used and certified inventory through `search(body)`. Returns exactly `{ ok, fetchedAt, total, complete, requests, records, confirm: { checked, notFound, error } }` on success and `{ ok: false, error, message, requests }` on failure. `records` are the platform's own compact records (Dealer Inspire: `trimRecord`); `confirmVins` are VINs from the last scan and the posted list to look up one by one when they did not come back (`confirm.notFound` is the only "gone" signal); `vins` limits the read to those cars; `fullRecords` keeps every photo. |
| `getDetails(search, vin, options)` | One full record (every photo, description, features) for the post-time re-check, any inventory type so a car that became New is found and then refused: `{ ok, record, fetchedAt }` with `record: null` when the car is gone, or `{ ok: false, message }`. `options` is `scanOptions(service)`. |
| `normalize(record)` | A platform record → the flat vehicle with exactly the fields in `src/vehicle.js VEHICLE_FIELDS` (one line per field says who reads it), or `null` without a VIN. Everything downstream (the pre-owned gate, the ready check, the rescan diff, the listing form, the description writer) reads only that shape. `location` is the store name exactly as the website gives it; `locationShort` is the normaliser's guess at the store's own part from brand words alone (`src/normalize.js shortLocation(location)`), because one record has no lot to compare with. `scanRunner.scanWithSearch` then settles every label over the lot's store names (`shortLocation(location, storeNames(vehicles))`: the words all stores share are the group and brand part, what differs is the short name), so nothing about one dealer's naming is baked in. |
| `makeDirectSearch(service)` | A `search(body)` that calls the service from the extension (the service worker's background rescan; needs `origins(service)` granted). |
| `photoOrigins(records)` | The origins the lot's photos are hosted on, from a scan's records. Recorded on the site registry entry as `photoOrigins` by `performScan` and the background rescan; nothing requests them (the manifest names one image host; a photo on another host fails to download and the error names the host). |

Two kinds of code in an adapter:

- `probeInPage` and `searchInPage` are copied into the page by Chrome, so they are **self-contained** (no imports, no identifier from outside the function body) and **read-only** (no clicks, no events, no form values, no submit). `test/adapters.test.js` runs both in a bare sandbox and checks they reach nothing in the module; `test/posting.test.js` checks the read-only rule and that `scanRunner.js` injects nothing else.
- Everything else never touches the page. It is given a `search(body)` from one of two places: `scanRunner.searchViaTab(tabId, adapter, service)` (the popup, the wizard and the post-time re-check: the call runs inside the tab through `searchInPage`) or `makeDirectSearch(service)` (the background rescan, with the host permission the wizard asked for).

Who calls what:

| Caller | Calls |
|---|---|
| `scanRunner.probeTab` | `probeSiteInPage` (neutral), then each adapter's `probeInPage` until one answers → `{ site, service, adapterId }` |
| `scanRunner.performScan` (popup Scan, wizard) | `detectAdapter`, `searchViaTab` → `searchInPage`, `scanOptions`, `scan`, `normalize` (then `shortLocation` over the lot's store names, and `matchStore` for the first-run store choice), `photoOrigins`; stores `{ adapter, service, photoOrigins }` on the site registry entry |
| `vehicleDetails.fetchVehicleDetails` (side panel, at post time) | `probeTab`, `scanOptions`, `getDetails`, `normalize` |
| `background.runRescan` (alarm) | `adapterById`, `origins` (permission check), `makeDirectSearch`, `scanOptions`, `scan`, `normalize`, `photoOrigins` |
| `rescanSchedule.originsFor` (wizard, popup, worker) | `origins` through the site's adapter |

## Built

- **Dealer Inspire** (`dealerInspire.js` + `dealerInspireNormalize.js`): the Cars Commerce inventory search behind Dealer Inspire websites. Probe: `window.SEARCH_SERVICE` (`search` address, the site's own public `apiKey`, `visibleStatusValues`) and the page helper `window.IDPSearchServiceHelper.getListings`. Search: the helper when present, else the same `POST <search>/search` with `x-api-key`. Service host `websites-search.api.carscommerce.inc`; photo host seen so far `vehicle-images.carscommerce.inc` (the manifest's static image host). Verified on the pilot dealer's live site (2026-09-26/27) and mirrored by `test/e2e/mock-dealer-site.mjs`.

## TODO (pick the next one from pilot demand)

None of these has been looked at on a real site yet; every line below is a starting point to confirm, not a finding. For each: find the page's inventory service (what `probeInPage` can read), the record shape (for `normalize` and a fixture), the used/new signals (the pre-owned gate needs an inventory type, a URL condition word and a title condition word, or equivalents), where the description and features live, and the photo host (recorded as `photoOrigins`; asking for it is the owner's call).

- **Dealer.com**: believed to serve the SRP from its own JSON endpoints with a vehicle data object embedded in the page; how to detect it: to be verified on a real site.
- **DealerOn**: believed to render listings server-side with a search API behind the SRP filters and VIN, price and status in the page's data layer; how to detect it: to be verified on a real site.
- **Dealer eProcess**: believed to load inventory JSON behind the SRP with its own pricing block and a separate Carfax feed; how to detect it: to be verified on a real site.
- **DealerFire**: believed to be WordPress-based with an inventory plugin, records in the page HTML and a JSON feed; how to detect it: to be verified on a real site.
