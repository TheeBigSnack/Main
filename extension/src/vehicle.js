// The one flat vehicle shape every adapter's normalize(record) returns and
// the only shape the rest of the extension reads (the pre-owned gate, the
// ready check, the rescan diff, the listing form, the description writer).
// One line per field says who reads it, so a new platform's normaliser knows
// what each value is for. The contract test (test/adapters.test.js) checks
// that every adapter returns exactly this set.

export const VEHICLE_FIELDS = Object.freeze([
  // --- identity ---
  'vin', // upper-case string, the key everywhere: the snapshot, the posted registry, the queue, the VIN check (vin.js)
  'stock', // stock number: the popup and panel labels, the photo file names, the VIN line in the description
  'year', // number: the listing form (listingData.js), the VIN check
  'make', // the listing form, the VIN check
  'model', // the listing form, the VIN check
  'trim', // the listing form, the description writer (rewriteTemplate.js)
  'name', // "year make model trim": every list, the posted registry (rescan.js markPosted), the description

  // --- the pre-owned gate (classify.js checkPreOwned): three signs must agree ---
  'inventoryType', // "Used" / "Certified Used" / "New": sign 1; the rescan flags a retype
  'siteTitle', // the website's own title for the car ("Pre-Owned 2019 ..."): sign 2 (titleConditionWords); branded-title words (listingData.js)
  'readableType', // "Pre-Owned" / "Certified Pre-Owned" / "New": backs up sign 2 when the title has no condition word
  'url', // the car's page on the website: the popup, the panel and upkeep link to it; the rescan keeps it
  'urlConditionWord', // the condition word in that address ("used", "certified used", "new"): sign 3
  'isDemo', // true blocks posting (classify.js)
  'isLoaner', // true blocks posting (classify.js)
  'carfaxUrl', // the ready check (no report = needs a look) and the Carfax line in the description
  'carfaxOneOwner', // "one owner" is written only when this is true (rewriteTemplate.js guardrails)
  'mileage', // number or null: zero/odd miles = needs a look (classify.js); the listing form; the description

  // --- the ready check (classify.js assessVehicle) and the rescan diff (rescan.js) ---
  'price', // the website's main price, number or null: the ready check, the honest-price diff, the listing form
  'priceLabel', // what the website calls that price (its own label, or "Call for price"): shown next to it
  'priceBeforeFees', // the lower price when the site shows one: the dealer's price basis (settings.js chooseBasis, rescan.js basisPrice)
  'status', // the site's status word ("publish", "pend-sale"...): the sale-pending check, the rescan
  'statusLabel', // the site's status text for people: shown in blockers, read by the rescan
  'availability', // "In-Stock" / "In-Transit" text: blockers, the rescan's "arrived on the lot"
  'inTransit', // true = not on the lot yet, blocks posting (classify.js)
  'location', // the store name the site gives the car: the store choice (settings.js, the wizard), the "at another store" check
  'locationShort', // the store's own part of that name (normalize.js shortLocation): labels in the popup and the panel. The normaliser sees one record and guesses from brand words; scanRunner.js scanWithSearch settles it over the lot's store names
  'photoCount', // number: no photos = not ready (classify.js); the rescan's "photos added"
  'photos', // photo URLs: 3 per car from the bulk scan, all from getDetails; the panel attaches them
  'dateInStock', // ISO date or null: kept from the site; no check reads it today (new arrivals come from the VIN diff)

  // --- text for the description writer (description.js, rewriteTemplate.js, rewriter.js) ---
  'descriptionRaw', // the site's own description text; scanRunner.js findBoilerplate strips lot-wide lines from it
  'features', // a clean list of feature strings

  // --- listing form details (listingData.js) and description facts (rewriteTemplate.js, vin.js compares them) ---
  'exteriorColor', // the form's exterior colour
  'interiorColor', // the form's interior colour
  'bodyType', // the form's body style
  'drivetrain', // description fact, VIN comparison
  'engine', // description fact, VIN comparison
  'transmission', // the form's transmission
  'fuelType', // the form's fuel type
]);
