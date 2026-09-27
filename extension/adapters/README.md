# Dealer-website adapters

Every platform Lot Sync reads lives here, behind one small interface (see `dealerInspire.js`):

| Function | What it does |
|---|---|
| `detect(probe)` | Does this adapter handle the page the popup probed? (`src/scan.js` gathers the probe inside the dealer tab: site name, address, and the inventory service's details.) |
| `scan(search, options)` | Reads the used and certified inventory through `search(body)`, de-duplicating by VIN across sort orders and confirming missing VINs one by one. |
| `normalize(record)` | Turns a platform record into the flat vehicle everything else works on. |
| `getDetails(search, vin)` | One full record (every photo, description, features) for the post-time re-check. |
| `makeDirectSearch(service)` | A `search(body)` that calls the platform's service from the extension (background rescans; needs the host permission). |

`search(body)` comes from one of two places: a direct fetch to the service (background rescans, with the host permission the wizard asks for) or a call made inside the dealer's own tab (`src/scan.js`, no permission needed, used by the popup's Scan button).

## Built

- **Dealer Inspire** (`dealerInspire.js`): the Cars Commerce search service (`window.SEARCH_SERVICE` on the page; service host `websites-search.api.carscommerce.inc`). Verified on ronlewischryslerdodgejeepramwaynesburg.com.

## TODO (pick the next one from pilot demand)

- **Dealer.com**: inventory comes from its own JSON endpoints behind the SRP; each page embeds a vehicle data object. Needs a probe for the page's inventory API and a normaliser for its record shape.
- **DealerOn**: server-rendered listings with a search API used by the SRP filters; VIN, price and status are present in the page's data layer.
- **Dealer eProcess**: inventory JSON behind the SRP with a different pricing block; Carfax link is a separate feed.
- **DealerFire**: WordPress-based with an inventory plugin; records are in page HTML and a JSON feed.

For each: confirm the used/new signal (the three-sign pre-owned check needs an inventory type, a URL condition word and a title condition word, or equivalents), where the description and features live, and the photo host (a host permission).
