// Dealer Inspire websites (the Cars Commerce inventory search behind them),
// e.g. ronlewischryslerdodgejeepramwaynesburg.com. This is the adapter the
// popup and the background rescan both use. It never touches the page
// itself: it is given a `search(body)` function, which is either a direct
// fetch to the search service (background rescans, with the host permission)
// or a call made inside the dealer's tab (src/scan.js, no permission needed).
//
// Interface every adapter provides:
//   detect(probe)              -> true if this adapter handles the probed page
//   scan(search, options)      -> { ok, fetchedAt, total, complete, requests, records, confirm }
//   normalize(record)          -> the flat vehicle (src/normalize.js)
//   getDetails(search, vin)    -> one full record (every photo, description, features) or null
//   makeDirectSearch(service)  -> a search(body) that talks to the service from the extension

import { normalizeVehicle } from '../src/normalize.js';

export const PLATFORM = Object.freeze({ id: 'dealerInspire', name: 'Dealer Inspire (Cars Commerce search)' });

export const FIELDS = Object.freeze([
  'vin', 'stock', 'type', 'year', 'make', 'model', 'trim', 'mileage', 'vdp_url', 'status', 'in_transit',
  'is_demo', 'is_loaner', 'date_in_stock', 'history_report', 'pricing', 'media', 'styles', 'body_details',
  'mechanical', 'extra_fields',
  // for the description writer (verified to exist on the live site 2026-09-26)
  'description', 'features',
]);

const DEFAULT_STATUS = ['publish', 'modified', 'pend-sale'];

export function detect(probe) {
  const s = probe && probe.service;
  return Boolean(s && s.search && s.apiKey);
}

// A search(body) that calls the service directly, the way the website's own
// helper does (POST, JSON, x-api-key). Needs the host permission for the
// service's origin when used from the extension.
export function makeDirectSearch(service, fetchImpl = globalThis.fetch) {
  const url = String(service.search || '').replace(/\/+$/, '') + '/search';
  return async (body) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': service.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('inventory search returned ' + res.status);
    const json = await res.json();
    return (json && json.data) || json || {};
  };
}

// The compact record kept per car. The bulk scan keeps 3 photo URLs; a
// post-time fetch (fullRecords) keeps them all.
export function trimRecord(r, { fullRecords = false } = {}) {
  const ef = r.extra_fields || {};
  const lt = ef.lightning || {};
  const hr = r.history_report || {};
  const p = r.pricing || {};
  const m = r.media || {};
  return {
    vin: String(r.vin).toUpperCase(), stock: r.stock, type: r.type, year: r.year, make: r.make, model: r.model, trim: r.trim,
    mileage: r.mileage, vdp_url: r.vdp_url, status: r.status, in_transit: r.in_transit,
    is_demo: r.is_demo, is_loaner: r.is_loaner, date_in_stock: r.date_in_stock,
    history_report: { carfax_url: hr.carfax_url || null, carfax_oneowner: hr.carfax_oneowner ?? null },
    pricing: { price: p.price, our_price: p.our_price, internet_price: p.internet_price, original_price: p.original_price, msrp: p.msrp, original_price_label: p.original_price_label },
    media: { image_count: m.image_count, images: Array.isArray(m.images) ? (fullRecords ? m.images.slice() : m.images.slice(0, 3)) : [] },
    description: typeof r.description === 'string' ? r.description : null,
    features: Array.isArray(r.features) ? r.features.filter((f) => typeof f === 'string') : [],
    styles: { exterior_color: r.styles && r.styles.exterior_color, interior_color: r.styles && r.styles.interior_color },
    body_details: { type: r.body_details && r.body_details.type },
    mechanical: r.mechanical ? { drivetrain: r.mechanical.drivetrain, engine: r.mechanical.engine, transmission: r.mechanical.transmission, fuel_type: r.mechanical.fuel_type } : null,
    extra_fields: {
      readable_type: ef.readable_type, title: ef.title, meta_location: ef.meta_location, location_rt: ef.location_rt,
      availability_rt: ef.availability_rt, our_price_label: ef.our_price_label,
      lightning: { inventoryType: lt.inventoryType, vdp_title: lt.vdp_title, status: lt.status, statusLabel: lt.statusLabel, pricing: lt.pricing },
    },
  };
}

/**
 * Reads the used and certified inventory. The service's paging isn't stable
 * (the same car can show up on two pages while another is skipped), so: ask
 * for big pages, de-duplicate by VIN, and if the count still falls short,
 * re-read in other sort orders until every car has been seen. Cars from the
 * last scan that didn't come back are looked up directly by VIN; only a VIN
 * the service can't find at all counts as gone.
 */
export async function scan(search, options = {}) {
  const opts = {
    types: ['Used', 'Certified Used'], // null = every vehicle, new included
    perPage: 200, // the service accepts up to 250 per request
    maxPages: 20,
    confirmVins: [], // VINs from the last scan / posted list to double-check if missing
    vins: null, // only these VINs (the post-time re-check of one car)
    fullRecords: false, // keep every photo URL instead of the first 3
    status: DEFAULT_STATUS,
    ...options,
  };
  const status = Array.isArray(opts.status) && opts.status.length ? opts.status : DEFAULT_STATUS;
  let requests = 0;
  const call = async (body) => {
    requests += 1;
    return search(body);
  };

  const byVin = new Map();
  let total = null;
  const sortOrders = [
    null,
    [{ field: 'low_price', order: 'asc' }],
    [{ field: 'low_price', order: 'desc' }],
    [{ field: 'miles', order: 'asc' }],
    [{ field: 'miles', order: 'desc' }],
    [{ field: 'year', order: 'asc' }],
  ];
  try {
    for (const sort of sortOrders) {
      for (let page = 1; page <= opts.maxPages; page += 1) {
        const filters = { status };
        if (Array.isArray(opts.types)) filters.type = opts.types;
        if (Array.isArray(opts.vins) && opts.vins.length) filters.vin = opts.vins.map((v) => String(v).toUpperCase());
        const body = { page, perPage: opts.perPage, filters, requestedFields: FIELDS };
        if (sort) body.sort = sort;
        const data = await call(body);
        if (typeof data.total_vehicle_count === 'number') total = data.total_vehicle_count;
        const list = Array.isArray(data.listings) ? data.listings : [];
        for (const r of list) {
          if (r && r.vin && !byVin.has(String(r.vin).toUpperCase())) byVin.set(String(r.vin).toUpperCase(), trimRecord(r, opts));
        }
        if (!list.length || page * opts.perPage >= (total || 0)) break;
      }
      if (total !== null && byVin.size >= total) break;
    }
  } catch (e) {
    return { ok: false, error: 'search-failed', message: "Couldn't read the inventory: " + ((e && e.message) || e), requests };
  }
  const complete = total !== null && byVin.size >= total;

  const confirm = { checked: [], notFound: [], error: null };
  const toCheck = [...new Set((opts.confirmVins || []).map((v) => String(v).toUpperCase()))].filter((v) => !byVin.has(v));
  try {
    for (let i = 0; i < toCheck.length; i += 50) {
      const batch = toCheck.slice(i, i + 50);
      const data = await call({ page: 1, perPage: 100, filters: { vin: batch, status }, requestedFields: FIELDS });
      const found = new Set();
      for (const r of Array.isArray(data.listings) ? data.listings : []) {
        if (!r || !r.vin) continue;
        const vin = String(r.vin).toUpperCase();
        found.add(vin);
        if (!byVin.has(vin)) byVin.set(vin, Object.assign(trimRecord(r, opts), { found_by_vin_lookup: true }));
      }
      for (const vin of batch) {
        confirm.checked.push(vin);
        if (!found.has(vin)) confirm.notFound.push(vin);
      }
    }
  } catch (e) {
    confirm.error = String((e && e.message) || e);
  }

  return { ok: true, fetchedAt: new Date().toISOString(), total, complete, requests, records: [...byVin.values()], confirm };
}

export const normalize = normalizeVehicle;

export async function getDetails(search, vin, options = {}) {
  const wanted = String(vin || '').toUpperCase();
  const res = await scan(search, { vins: [wanted], types: null, fullRecords: true, confirmVins: [], ...(options.status ? { status: options.status } : {}) });
  if (!res.ok) return { ok: false, message: res.message };
  const record = res.records.find((r) => r.vin === wanted) || null;
  return { ok: true, record, fetchedAt: res.fetchedAt };
}

export default { PLATFORM, detect, scan, normalize, getDetails, makeDirectSearch };
