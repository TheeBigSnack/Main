// Runs inside the dealer's website tab (the extension injects it with
// chrome.scripting.executeScript, world: 'MAIN'). It asks the website's own
// inventory search for its used and certified used vehicles, the same way the
// website's used-inventory page does, and returns trimmed records.
//
// Chrome copies this function's source into the page, so it must stay
// self-contained: no imports and nothing from outside the function body.
//
// Supported today: Dealer Inspire sites that use the Cars Commerce search
// service (window.SEARCH_SERVICE), e.g. ronlewischryslerdodgejeepramwaynesburg.com.

export async function scanInventoryInPage(options) {
  const opts = Object.assign(
    {
      types: ['Used', 'Certified Used'], // null = every vehicle, new included (used for testing)
      perPage: 200, // the service accepts up to 250 per request
      maxPages: 20,
      confirmVins: [], // VINs from the last scan / posted list to double-check if missing
      vins: null, // only these VINs (the post-time re-check of one car)
      fullRecords: false, // keep every photo URL instead of the first 3
    },
    options || {}
  );

  const ogName = document.querySelector('meta[property="og:site_name"]');
  const site = {
    origin: location.origin,
    host: location.hostname.replace(/^www\./, ''),
    name: (ogName && ogName.content) || document.title.split('|').pop().trim(),
    title: document.title,
  };

  const svc = window.SEARCH_SERVICE;
  if (!svc || !svc.search || !svc.apiKey) {
    return {
      ok: false,
      site,
      error: 'unsupported-site',
      message:
        "This page doesn't have the inventory search this tool reads (Dealer Inspire's search service). Open your dealership's website and try again.",
    };
  }

  const FIELDS = [
    'vin', 'stock', 'type', 'year', 'make', 'model', 'trim', 'mileage', 'vdp_url', 'status', 'in_transit',
    'is_demo', 'is_loaner', 'date_in_stock', 'history_report', 'pricing', 'media', 'styles', 'body_details',
    'mechanical', 'extra_fields',
    // for the description writer (verified to exist on the live site 2026-09-26)
    'description', 'features',
  ];
  const status = Array.isArray(svc.visibleStatusValues) && svc.visibleStatusValues.length ? svc.visibleStatusValues : ['publish', 'modified', 'pend-sale'];
  const helper = window.IDPSearchServiceHelper;
  let requests = 0;

  async function search(body) {
    requests += 1;
    if (helper && typeof helper.getListings === 'function') {
      const r = await helper.getListings(body);
      return (r && r.data) || r || {};
    }
    const res = await fetch(svc.search + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': svc.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('inventory search returned ' + res.status);
    const json = await res.json();
    return (json && json.data) || json || {};
  }

  function trim(r) {
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
      media: { image_count: m.image_count, images: Array.isArray(m.images) ? (opts.fullRecords ? m.images.slice() : m.images.slice(0, 3)) : [] },
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

  // The service's paging isn't stable (the same car can show up on two pages
  // while another is skipped), so: ask for big pages, de-duplicate by VIN,
  // and if the count still falls short, re-read in other sort orders until
  // every car has been seen.
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
        const data = await search(body);
        if (typeof data.total_vehicle_count === 'number') total = data.total_vehicle_count;
        const list = Array.isArray(data.listings) ? data.listings : [];
        for (const r of list) {
          if (r && r.vin && !byVin.has(String(r.vin).toUpperCase())) byVin.set(String(r.vin).toUpperCase(), trim(r));
        }
        if (!list.length || page * opts.perPage >= (total || 0)) break;
      }
      if (total !== null && byVin.size >= total) break;
    }
  } catch (e) {
    return { ok: false, site, error: 'search-failed', message: "Couldn't read the inventory: " + ((e && e.message) || e) };
  }
  const complete = total !== null && byVin.size >= total;

  // Double-check cars from last time that didn't come back: look each VIN up
  // directly. Only a VIN the website can't find at all counts as gone.
  const confirm = { checked: [], notFound: [], error: null };
  const toCheck = [...new Set((opts.confirmVins || []).map((v) => String(v).toUpperCase()))].filter((v) => !byVin.has(v));
  try {
    for (let i = 0; i < toCheck.length; i += 50) {
      const batch = toCheck.slice(i, i + 50);
      const data = await search({ page: 1, perPage: 100, filters: { vin: batch, status }, requestedFields: FIELDS });
      const found = new Set();
      for (const r of Array.isArray(data.listings) ? data.listings : []) {
        if (!r || !r.vin) continue;
        const vin = String(r.vin).toUpperCase();
        found.add(vin);
        if (!byVin.has(vin)) byVin.set(vin, Object.assign(trim(r), { found_by_vin_lookup: true }));
      }
      for (const vin of batch) {
        confirm.checked.push(vin);
        if (!found.has(vin)) confirm.notFound.push(vin);
      }
    }
  } catch (e) {
    confirm.error = String((e && e.message) || e);
  }

  return {
    ok: true,
    site,
    fetchedAt: new Date().toISOString(),
    total,
    complete,
    requests,
    records: [...byVin.values()],
    confirm,
  };
}
