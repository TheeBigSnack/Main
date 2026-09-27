// Turns a raw record from the dealer website's inventory search into a flat,
// predictable vehicle object. Everything downstream (the pre-owned check,
// the rescan) works on this shape, so a different website platform only
// needs its own version of this file.

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function positive(value) {
  const n = toNumber(value);
  return n !== null && n > 0 ? n : null;
}

// The price the website shows as its main price. On Dealer Inspire sites the
// display pricing lives in extra_fields.lightning.pricing; when that says
// "Please call for price" there is no price, even if a number exists elsewhere
// in the record.
export function websitePrice(raw) {
  const display = raw?.extra_fields?.lightning?.pricing;
  if (display && typeof display === 'object') {
    const low = display.low && positive(display.low.value);
    if (low) return { value: low, label: display.low.label || 'Price' };
    const high = display.high && positive(display.high.value);
    if (high) return { value: high, label: display.high.label || 'Price' };
    const text = display.high && typeof display.high.value === 'string' ? display.high.value : '';
    return { value: null, label: text || 'Call for price' };
  }
  const p = raw?.pricing || {};
  const value = positive(p.our_price) || positive(p.price) || positive(p.internet_price);
  return { value, label: value ? raw?.extra_fields?.our_price_label || 'Price' : 'Call for price' };
}

// Reads the condition word out of a vehicle page address, e.g.
// /inventory/certified-used-2022-jeep-... -> "certified used".
export function conditionWordFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/inventory\/([a-z-]+?)-(?:19|20)\d{2}-/i);
  return m ? m[1].replace(/-/g, ' ').toLowerCase() : null;
}

const BRANDS =
  'Chrysler|Dodge|Jeep|Ram|Fiat|Alfa Romeo|Ford|Lincoln|Chevrolet|Buick|GMC|Cadillac|Toyota|Lexus|Honda|Acura|Nissan|Infiniti|Hyundai|Genesis|Kia|Subaru|Mazda|Volkswagen|Audi|BMW|Mercedes-Benz|Volvo';

export function shortLocation(location) {
  if (!location) return '';
  // "Ron Lewis Chrysler Dodge Jeep Ram Cranberry" -> "Cranberry" (text after the last brand name)
  const m = location.match(new RegExp(`^.*\\b(?:${BRANDS})\\s+(.+)$`));
  return m ? m[1].trim() : location;
}

export function normalizeVehicle(raw) {
  if (!raw || !raw.vin) return null;
  const extra = raw.extra_fields || {};
  const display = extra.lightning || {};
  const history = raw.history_report || {};
  const pricing = raw.pricing || {};
  const media = raw.media || {};
  const images = Array.isArray(media.images) ? media.images.filter((u) => typeof u === 'string' && u) : [];
  const price = websitePrice(raw);
  const mileage = toNumber(raw.mileage);
  const availability = extra.availability_rt || null;
  const location = extra.meta_location || extra.location_rt || (typeof extra.location === 'string' && extra.location) || null;

  return {
    vin: String(raw.vin).toUpperCase(),
    stock: raw.stock || '',
    year: toNumber(raw.year),
    make: raw.make || '',
    model: raw.model || '',
    trim: raw.trim || '',
    name: [raw.year, raw.make, raw.model, raw.trim].filter(Boolean).join(' '),

    // Everything the pre-owned check looks at
    inventoryType: raw.type || display.inventoryType || null, // "Used", "Certified Used", "New"
    siteTitle: extra.title || display.vdp_title || null, // "Pre-Owned 2019 Ram 1500 ..."
    readableType: extra.readable_type || null, // "Pre-Owned", "Certified Pre-Owned", "New"
    url: raw.vdp_url || null,
    urlConditionWord: conditionWordFromUrl(raw.vdp_url), // "used", "certified used", "new"
    isDemo: raw.is_demo === true,
    isLoaner: raw.is_loaner === true,
    carfaxUrl: history.carfax_url || null,
    carfaxOneOwner: history.carfax_oneowner === true,
    mileage,

    // Everything the "ready to post" check and the rescan look at
    price: price.value, // the website's main price, e.g. "Ron Lewis Real Price"
    priceLabel: price.label,
    priceBeforeFees: positive(pricing.internet_price) || positive(pricing.price),
    status: raw.status || '', // "publish", "modified", "pend-sale"
    statusLabel: display.statusLabel || '',
    availability, // "In-Stock", "In-Transit"
    inTransit: raw.in_transit === 'yes' || (typeof availability === 'string' && /transit/i.test(availability)),
    location,
    locationShort: shortLocation(location),
    photoCount: toNumber(media.image_count) ?? images.length,
    photos: images.slice(0, 3),
    dateInStock: raw.date_in_stock || null,

    // Details for the eventual listing
    exteriorColor: raw.styles?.exterior_color || '',
    interiorColor: raw.styles?.interior_color || '',
    bodyType: raw.body_details?.type || '',
    drivetrain: raw.mechanical?.drivetrain || '',
    engine: raw.mechanical?.engine || '',
    transmission: raw.mechanical?.transmission || '',
    fuelType: raw.mechanical?.fuel_type || '',
  };
}
