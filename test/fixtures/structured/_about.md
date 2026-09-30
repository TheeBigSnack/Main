# Structured-data fixtures

These pages are synthetic. They were written by hand for `test/schemaOrg.test.js`, from the public schema.org definitions (Car, Vehicle, MotorVehicle, Motorcycle, Product, Offer, AggregateOffer, ItemList, ListItem, QuantitativeValue, EngineSpecification, ItemAvailability, OfferItemCondition, DriveWheelConfigurationValue) and Google's vehicle listing structured-data documentation. No page was copied from a dealer website. The dealership ("Sample Motors" at `www.sample-motors.test`), the prices, the mileages and the VINs are made up; the VINs spell SAMPL and pass the extension's own VIN checks (`extension/src/vin.js`).

None of these pages shows how any named platform marks up its inventory. That is only known once a real site has been scanned, so nothing here may be quoted as "platform X works".

| File | What it exercises |
|---|---|
| `graph-vdp.html` | A vehicle page with an `@graph`: the page's `mainEntity` and the car's `offers` given by `@id`, the seller by `@id`, relative and `ImageObject` photos (one repeated), `numberOfPreviousOwners` (never a Carfax flag), an `og:title`, a canonical link, a Carfax link with the VIN and one without, hidden text, a script and a style that are not visible text |
| `array-product.html` | A top-level array: an organisation, a `Product` with a `vehicleIdentificationNumber` (a vehicle), and a service plan `Product` (not one); `offers` as an array of one; the bare condition name `UsedCondition`; `unitText` "miles" |
| `multitype.html` | `@type: ["Product", "Car"]`; `modelDate` and `manufacturer`; the condition and a `PreOrder` availability on the offer; two offers that agree on one price; an engine given by displacement and type; a `features` list and `additionalProperty` extras |
| `aggregate-offer.html` | An `AggregateOffer` price range: never averaged, no price |
| `list-page.html` | An `ItemList` page: cars inside `ListItem`s and one directly in the list, a `MotorVehicle`, a `Motorcycle`, a gift card (no vehicle); "Call for price"; `SoldOut`; `rel=next`; the same car linked twice; a `#/` route |
| `price-string.html` | The price written as the string "$27,163"; a lower-case VIN; the trim repeated at the end of the model |
| `km.html` | `mileageFromOdometer` in kilometres (`KMT`): never converted |
| `no-condition.html` | No `itemCondition` and a mileage with no unit that the page shows as miles |
| `malformed.html` | A block with a missing comma, a plain `application/json` script, a block inside an HTML comment, an empty block, a bare string, and a raw line break inside a JSON string |
| `entities.html` | HTML entities inside JSON strings, a byte order mark, CDATA sections inside `//` and `/* */` comments, a block escaped as a whole, `&nbsp;` in the visible text |
| `carousel.html` | A vehicle page with a carousel of four other cars (one new), each with its own address and one with its own Carfax link, and the page's car repeated in microdata with an older price |
| `microdata.html` | A microdata-only page (`itemscope`, `itemprop`, `content`, `link href`, `img src` against a `<base href>`), plus a dealer item that is not a vehicle |
| `stale-price.html` | Markup whose price the page no longer shows: no price |
| `stale-price-struck.html` | The same stale markup price, which the page shows only crossed out (`<s>`) beside the new one: no price |
| `stale-price-was.html` | The same, shown only after "Was:" beside "Now:": no price |
| `stale-price-msrp.html` | A markup price the page shows only after "MSRP", beside a lower sale price: no price |
| `stale-price-payment.html` | A markup price the page shows only in a payment estimate ("based on a price of"), beside the current price: no price |
| `price-specification.html` | An offer with no price of its own and two `priceSpecification`s, a `StrikethroughPrice` first and the sale price second, both shown on the page (the old one crossed out by a class): the sale price |
| `no-currency.html` | An offer with no `priceCurrency` whose amount the page shows with a dollar sign ("$17,163.00"): counted as US dollars |

`gate-before.json` is different: it is not a page but the pre-owned gate's decisions, captured on 2026-09-29 before the gate learned schema.org condition values. It covers every record in `test/fixtures/records.json` and every car of the sandbox lot (`demo/site/inventory.js`, day 1 and day 2), each as it is and with one sign taken away at a time. `test/classify.test.js` checks that the gate still decides each of them exactly the same way, for the same reason.
