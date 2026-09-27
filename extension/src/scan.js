// Runs inside the dealer's website tab (chrome.scripting.executeScript,
// world: 'MAIN'). Two small self-contained functions:
//   probeSiteInPage()            what the page says about itself and its inventory service
//   searchInPage(service, body)  one search request, made the way the page's own helper makes it
// The scan logic itself lives in extension/adapters/ so the popup and the
// background rescan share it. Chrome copies each function's source into the
// page, so they must stay self-contained: no imports, nothing from outside
// the function body.
//
// Supported today: Dealer Inspire sites that use the Cars Commerce search
// service (window.SEARCH_SERVICE), e.g. ronlewischryslerdodgejeepramwaynesburg.com.

export function probeSiteInPage() {
  // The store's own address, from the page's structured data (schema.org
  // PostalAddress in JSON-LD, which Dealer Inspire sites carry) or, failing
  // that, an address-looking line in the page text. Used for the Marketplace
  // location so the listing lands in the right town.
  function readSiteAddress() {
    const out = { street: '', city: '', state: '', zip: '', phone: '', source: '' };
    const fromNode = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6) return null;
      if (Array.isArray(node)) {
        for (const n of node) { const r = fromNode(n, depth + 1); if (r) return r; }
        return null;
      }
      const a = Array.isArray(node.address) ? node.address[0] : node.address;
      if (a && typeof a === 'object' && (a.postalCode || a.addressLocality)) {
        return { street: String(a.streetAddress || ''), city: String(a.addressLocality || ''), state: String(a.addressRegion || ''), zip: String(a.postalCode || '').slice(0, 5), phone: String(node.telephone || '') };
      }
      for (const key of ['@graph', 'mainEntity', 'publisher', 'provider', 'itemListElement', 'item']) {
        if (node[key]) { const r = fromNode(node[key], depth + 1); if (r) return r; }
      }
      return null;
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const r = fromNode(JSON.parse(s.textContent), 0);
        if (r && (r.zip || r.city)) return Object.assign(out, r, { source: 'structured data' });
      } catch (e) { /* not JSON, try the next one */ }
    }
    const m = /(\d{1,6}\s+[A-Za-z0-9 .'-]{3,60}?),?\s+([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/.exec(document.body.innerText || '');
    if (m) Object.assign(out, { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4], source: 'page text' });
    return out;
  }

  const ogName = document.querySelector('meta[property="og:site_name"]');
  const site = {
    origin: location.origin,
    host: location.hostname.replace(/^www\./, ''),
    name: (ogName && ogName.content) || document.title.split('|').pop().trim(),
    title: document.title,
    address: readSiteAddress(),
  };

  const svc = window.SEARCH_SERVICE || null;
  const helper = window.IDPSearchServiceHelper;
  let service = null;
  if (svc && svc.search && svc.apiKey) {
    let search = String(svc.search);
    try { search = new URL(search, location.origin).href; } catch (e) { /* keep as is */ }
    service = {
      search, // absolute address of the inventory search, e.g. https://websites-search.api.carscommerce.inc/api/v1/listings/153146
      apiKey: svc.apiKey, // the website's own public key for that service
      visibleStatusValues: Array.isArray(svc.visibleStatusValues) && svc.visibleStatusValues.length ? svc.visibleStatusValues : null,
      hasHelper: Boolean(helper && typeof helper.getListings === 'function'),
    };
  }
  return { site, service };
}

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
