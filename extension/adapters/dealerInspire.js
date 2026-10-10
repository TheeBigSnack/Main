// Dealer Inspire websites: the Cars Commerce inventory search behind them
// (window.SEARCH_SERVICE on the page; service host
// websites-search.api.carscommerce.inc). This is the adapter the popup, the
// wizard, the side panel's post-time re-check and the background rescan all
// use. The contract every adapter implements is in README.md; in short:
//   PLATFORM                         { id, name, checkedLive? }
//   probeInPage()                    runs IN the dealer tab: this platform's service details, or null
//   searchInPage(service, body)      runs IN the dealer tab: one search, the way the page's own helper makes it
//   detect(probe)                    does this adapter handle the probed page?
//   origins(service)                 host-permission patterns background work needs
//   scanOptions(service)             the options scan() and getDetails() need from the service
//   scan(search, options)            { ok, fetchedAt, total, complete, requests, records, confirm }
//   getDetails(search, vin, options) one full record (every photo, description, features) or null
//   normalize(record)                the flat vehicle (src/vehicle.js VEHICLE_FIELDS; dealerInspireNormalize.js)
//   makeDirectSearch(service)        a search(body) that calls the service from the extension
//   photoOrigins(records)            where the photos are hosted (recorded, never requested)
// The two *InPage functions are copied into the page by
// chrome.scripting.executeScript, so they are self-contained (no imports,
// nothing from outside the function body) and read-only. Everything else
// never touches the page: it is given a search(body), which is either a
// direct fetch to the service (background rescans, with the host permission)
// or a call made inside the dealer's tab (src/scanRunner.js searchViaTab, no
// permission needed).

import { normalizeVehicle } from './dealerInspireNormalize.js';

// checkedLive: this reader has read a real dealership website (the pilot's
// records in test/fixtures/ come from one), so the unsupported-page message
// names it without a caveat.
export const PLATFORM = Object.freeze({ id: 'dealerInspire', name: 'Dealer Inspire', checkedLive: true });

export const FIELDS = Object.freeze([
  'vin', 'stock', 'type', 'year', 'make', 'model', 'trim', 'mileage', 'vdp_url', 'status', 'in_transit',
  'is_demo', 'is_loaner', 'date_in_stock', 'history_report', 'pricing', 'media', 'styles', 'body_details',
  'mechanical', 'extra_fields',
  // for the description writer (verified to exist on the live site 2026-09-26)
  'description', 'features',
]);

const DEFAULT_STATUS = ['publish', 'modified', 'pend-sale'];

// ---------- in the dealer tab (self-contained, read-only) ----------

// What a Dealer Inspire page carries: window.SEARCH_SERVICE with the search
// address and the site's own public key, and (usually) the page's helper
// that makes the request. Returns the service or null on any other page.
export function probeInPage() {
  const svc = window.SEARCH_SERVICE || null;
  const helper = window.IDPSearchServiceHelper;
  if (!svc || !svc.search || !svc.apiKey) return null;
  let search = String(svc.search);
  try { search = new URL(search, location.origin).href; } catch (e) { /* keep as is */ }
  return {
    search, // absolute address of the inventory search, e.g. https://websites-search.api.carscommerce.inc/api/v1/listings/<site id>
    apiKey: svc.apiKey, // the website's own public key for that service
    visibleStatusValues: Array.isArray(svc.visibleStatusValues) && svc.visibleStatusValues.length ? svc.visibleStatusValues : null,
    hasHelper: Boolean(helper && typeof helper.getListings === 'function'),
  };
}

// One search request, made the way the page's own helper makes it (the
// helper when the page has one, else the same POST the helper would send).
export async function searchInPage(service, body) {
  try {
    const helper = window.IDPSearchServiceHelper;
    if (helper && typeof helper.getListings === 'function') {
      const r = await helper.getListings(body);
      return { ok: true, data: (r && r.data) || r || {} };
    }
    const res = await fetch(String(service.search).replace(/\/+$/, '') + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': service.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: 'inventory search returned ' + res.status };
    const json = await res.json();
    return { ok: true, data: (json && json.data) || json || {} };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- in the extension ----------

export function detect(probe) {
  const s = probe && probe.service;
  return Boolean(s && s.search && s.apiKey);
}

// The host-permission patterns the background rescan needs: the search
// service's origin. (The pattern is built in two pieces so the guard tests'
// comment stripper never meets a block-comment opener inside a string.)
export function origins(service) {
  try {
    return [new URL(String(service && service.search)).origin + '/' + '*'];
  } catch (e) {
    return [];
  }
}

// What scan() and getDetails() need from the service: the status values the
// website itself shows (publish, modified, pend-sale on the sites seen so far).
export function scanOptions(service) {
  const v = service && service.visibleStatusValues;
  return Array.isArray(v) && v.length ? { status: v.slice() } : {};
}

// The origins the photos are hosted on, from the records a scan returned.
// Recorded on the site registry entry so the owner can decide about asking
// for them; nothing here requests a permission.
export function photoOrigins(records) {
  const out = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    const images = r && r.media && Array.isArray(r.media.images) ? r.media.images : [];
    for (const u of images) {
      try { out.add(new URL(u).origin); } catch (e) { /* not an absolute URL */ }
    }
  }
  return [...out].sort();
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

// The cars in one answer of the search service. A 200 is not always a list:
// a page helper that swallowed its own error, a session that ran out or an
// error object answer 200 too, and reading one of those as "no cars" would
// call the whole lot, or every car looked up by VIN, gone. So an answer
// without a `listings` array is an error, and an empty list counts only when
// the answer also says the search matched nothing (total_vehicle_count 0);
// `emptyNeedsZero` is off for a later page of the paged read, where an empty
// page is the service's unstable paging, not the lot.
export function listingsOf(data, { emptyNeedsZero = true } = {}) {
  const list = data && Array.isArray(data.listings) ? data.listings : null;
  if (!list) throw new Error('the inventory search answered without a list of cars');
  if (emptyNeedsZero && !list.length && data.total_vehicle_count !== 0) throw new Error('the inventory search answered with no cars and without saying it found none');
  return list;
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
        const list = listingsOf(data, { emptyNeedsZero: requests === 1 }); // the first answer says what the lot is
        if (typeof data.total_vehicle_count === 'number') total = data.total_vehicle_count;
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
      for (const r of listingsOf(data)) { // an answer that is not a list stops the check: nothing is marked gone
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
  const res = await scan(search, { vins: [wanted], types: null, fullRecords: true, confirmVins: [], ...(options && options.status ? { status: options.status } : {}) });
  if (!res.ok) return { ok: false, message: res.message };
  const record = res.records.find((r) => r.vin === wanted) || null;
  return { ok: true, record, fetchedAt: res.fetchedAt };
}

export default { PLATFORM, probeInPage, searchInPage, detect, origins, scanOptions, scan, getDetails, normalize, makeDirectSearch, photoOrigins };
