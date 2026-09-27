// Every Facebook Marketplace selector and field-finding rule lives in this one
// file, so when Facebook changes its page the fix is here and takes minutes.
// Fields are found by role and accessible name (label text, aria-label,
// placeholder), never by generated class names.
//
// STATUS: NOT YET VERIFIED against the live form. This map was written from
// public knowledge of the "Create vehicle listing" form (September 2026) and
// has been proven only against test/e2e/mock-marketplace.mjs, which names its
// fields the same way. The first run on the real form (see README, "Try it on
// one real car") will show which `name` patterns need adjusting: every field
// that can't be found is listed in the side panel with a copy button.
//
// There is deliberately NO entry for Publish, Update, Delete or Mark as sold.
// The fill code can only touch the fields listed here (non-negotiable #1).
//
// Each field:
//   key      the value in listingData.js's `fields`
//   label    what the side panel calls it
//   kind     'text' | 'textarea' | 'typeahead' | 'choice'
//   name     regex sources (case-insensitive) matched against the accessible name
//   options  for 'choice': canonical value -> Facebook wordings to try, in order

export const FORM_MAP = Object.freeze({
  version: '2026-09-27',
  // Two live, unpublished runs on 2026-09-27 filled 12 of 13 fields (Make pending).
  verifiedAgainstFacebook: 'partly',
  createUrl: 'https://www.facebook.com/marketplace/create/vehicle',
  // Where the tab ends up after the salesperson publishes.
  listingUrlPattern: '^https://www\\.facebook\\.com/marketplace/item/(\\d+)',
  afterPublishPatterns: ['^https://www\\.facebook\\.com/marketplace/(you|selling)(/|$|\\?)'],
  // Give the page this long to draw its form after it reports loaded.
  settleMs: 2500,
  // After filling, wait this long and read everything back: the live form
  // restores a saved draft over the fields a few seconds in (seen 2026-09-27).
  recheckMs: 3000,
  // Photos. The page's own limit wording is read first (several spellings);
  // the live form's exact wording is still to be captured (see README).
  fileInput: 'input[type="file"]',
  photoLimitDefault: 20, // NOT VERIFIED; used only if the page text has no limit
  photoLimitTextPatterns: [
    'up to (\\d+) photos',
    '(\\d+) photos? (?:max|maximum|limit)',
    'max(?:imum)?(?: of)? (\\d+) photos',
    'photos?\\D{0,20}?\\d+\\s*(?:/|of)\\s*(\\d+)',
  ],

  fields: [
    {
      key: 'vehicleType', label: 'Vehicle type', kind: 'choice', name: ['^vehicle type\\b'],
      options: { car_truck: ['Car/Truck', 'Car/truck', 'Car or truck', 'Car'], motorcycle: ['Motorcycle', 'Motorcycle/Scooter'] },
    },
    // The VIN goes in first: whatever the form derives from it is then
    // overwritten by the year, make and model from the website.
    { key: 'vin', label: 'VIN', kind: 'text', name: ['^vin\\b', '^vehicle identification number\\b'] },
    { key: 'year', label: 'Year', kind: 'choice', name: ['^year\\b'] },
    // Make and Model are typeahead boxes on the live form (seen 2026-09-27):
    // they show default suggestions (Honda, then Accord) and commit the first
    // one when the box loses focus. So they are typed key by key, only a
    // suggestion containing our text may be picked, and the box is closed
    // with Escape, never blurred. Make may only appear once a year is chosen.
    // A dropdown in their place is handled too.
    { key: 'make', label: 'Make', kind: 'typeahead', name: ['^make\\b', '^brand\\b', '^manufacturer\\b'] },
    { key: 'model', label: 'Model', kind: 'typeahead', name: ['^model\\b'] },
    { key: 'mileage', label: 'Mileage', kind: 'text', name: ['^mileage\\b'] },
    { key: 'price', label: 'Price', kind: 'text', name: ['^price\\b'] },
    {
      key: 'bodyStyle', label: 'Body style', kind: 'choice', name: ['^body style\\b'],
      options: { Truck: ['Truck', 'Pickup'], SUV: ['SUV'], Sedan: ['Sedan'], Coupe: ['Coupe'], Hatchback: ['Hatchback'], Convertible: ['Convertible'], Minivan: ['Minivan', 'Mini-van'], Van: ['Van'], Wagon: ['Wagon', 'Estate'] },
    },
    { key: 'exteriorColor', label: 'Exterior color', kind: 'choice', name: ['^exterior colou?r\\b'], options: { Gray: ['Gray', 'Grey'], 'Off white': ['Off white', 'Off-white'] } },
    { key: 'interiorColor', label: 'Interior color', kind: 'choice', name: ['^interior colou?r\\b'], options: { Gray: ['Gray', 'Grey'], 'Off white': ['Off white', 'Off-white'] } },
    {
      key: 'fuelType', label: 'Fuel type', kind: 'choice', name: ['^fuel type\\b'],
      options: { Gasoline: ['Gasoline', 'Gas', 'Petrol'], Hybrid: ['Hybrid'], 'Plug-in hybrid': ['Plug-in hybrid', 'Plug-in Hybrid', 'Plugin hybrid'], Electric: ['Electric'], Diesel: ['Diesel'], Flex: ['Flex', 'Flex fuel'] },
    },
    { key: 'transmission', label: 'Transmission', kind: 'choice', name: ['^transmission\\b'], options: { Automatic: ['Automatic transmission', 'Automatic'], Manual: ['Manual transmission', 'Manual'] } },
    { key: 'location', label: 'Location', kind: 'typeahead', name: ['^location\\b'] },
    { key: 'description', label: 'Description', kind: 'textarea', name: ['^description\\b'] },
    // The website can't tell us these two. They come from the dealership's
    // defaults in Settings (listingData.js), and the panel shows them as such.
    {
      key: 'condition', label: 'Vehicle condition', kind: 'choice', name: ['^vehicle condition\\b', '^condition\\b'],
      options: { Excellent: ['Excellent'], 'Very good': ['Very good', 'Very Good'], Good: ['Good'], Fair: ['Fair'], Poor: ['Poor'] },
    },
    // On the live form (seen 2026-09-27) the title is a checkbox, "This vehicle
    // has a clean title." It is ticked when the dealership's title default is
    // Clean, left alone when there is no default, and unticked when the
    // website's own text mentions a branded title.
    { key: 'cleanTitle', label: 'Clean title (checkbox)', kind: 'checkbox', name: ['\\bclean title\\b'] },
    // Some forms use a dropdown instead; optional, so its absence is not a failure.
    {
      key: 'titleStatus', label: 'Title status', kind: 'choice', optional: true, name: ['^title status\\b'],
      options: { Clean: ['Clean', 'Clean title'], Rebuilt: ['Rebuilt', 'Rebuilt title'], Salvage: ['Salvage', 'Salvage title'], Lien: ['Lien'], Missing: ['Missing', 'Missing title'] },
    },
  ],

  // Controls whose accessible name matches one of these are off limits to the
  // finder. Empty since the dealership defaults for condition and title were
  // added; kept so a field can be fenced off again in one line.
  neverFill: [],
});
