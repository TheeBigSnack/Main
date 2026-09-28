// Dealer Inspire's record -> the flat vehicle. The record is the compact one
// scan() keeps (trimRecord in dealerInspire.js), which has the same field
// names as the search service's own listing. The flat shape is
// src/vehicle.js (VEHICLE_FIELDS says what each field is for); the contract
// test checks that normalize() returns exactly that set. Nothing here is
// generic: a second platform writes its own version of this file next to its
// adapter, using the neutral helpers from src/normalize.js.

import { toNumber, shortLocation } from '../src/normalize.js';

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
    price: price.value, // the website's main price, under the dealer's own label
    priceLabel: price.label,
    priceBeforeFees: positive(pricing.internet_price) || positive(pricing.price),
    status: raw.status || '', // "publish", "modified", "pend-sale"
    statusLabel: display.statusLabel || '',
    availability, // "In-Stock", "In-Transit"
    inTransit: raw.in_transit === 'yes' || (typeof availability === 'string' && /transit/i.test(availability)),
    location,
    locationShort: shortLocation(location), // a guess from brand words: one record has no lot to compare with; scanWithSearch settles it over the lot's store names
    photoCount: toNumber(media.image_count) ?? images.length,
    photos: images, // the bulk scan keeps 3 per car; a post-time fetch keeps them all
    dateInStock: raw.date_in_stock || null,

    // Text for the description writer. Not kept in the compact snapshot.
    descriptionRaw: typeof raw.description === 'string' ? raw.description : '',
    features: Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()) : [],

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

export const normalize = normalizeVehicle;
