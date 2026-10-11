// Runs inside the dealer's website tab (chrome.scripting.executeScript,
// world: 'MAIN'). One self-contained, platform-neutral function:
//   probeSiteInPage()  what any dealership page says about itself: origin,
//                      host, name, title and the store's address (schema.org
//                      JSON-LD, or an address-looking line in the page text)
// The platform-specific probe (does this page carry an inventory service the
// adapter knows?) and the search call live in each adapter under
// extension/adapters/ as probeInPage() and searchInPage(service, body);
// src/scanRunner.js injects those the same way, in ADAPTERS order. Chrome
// copies each function's source into the page, so all of them must stay
// self-contained (no imports, nothing from outside the function body) and
// read-only (no clicks, no events, no form values; test/posting.test.js
// checks).

export function probeSiteInPage() {
  // Never a Facebook page: the extension may reach Marketplace pages (its fill
  // code), but it reads nothing else of them, and a dealer tab the salesperson
  // moved to Facebook is no dealer page. The adapters' probes say the same.
  if (/(^|\.)facebook\.com$/i.test(String(location.hostname || ''))) return null;
  // The store's own address, from the page's structured data (schema.org
  // PostalAddress in JSON-LD, which most dealer platforms carry) or, failing
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
    // a street and its town: with a comma between them, or with the street's own suffix (Street, Ave, Rd ...) ending the street, so
    // "100 Main Street Waynesburg, PA" reads as street "100 Main Street" and town "Waynesburg"
    const ADDRESS = /(\d{1,6}\s+[A-Za-z0-9 .'-]{3,60}?),\s*([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b|(\d{1,6}\s+[A-Za-z0-9 .'-]{3,60}?\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Hwy|Highway|Pike|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Rt|Route)\.?)\s+([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/g;
    // a page that gives two or more different addresses (several stores) does not say which is the dealership's, so none is read
    const addresses = new Map();
    for (const m of (document.body.innerText || '').matchAll(ADDRESS)) {
      const parts = m[1] ? [m[1], m[2], m[3], m[4]] : [m[5], m[6], m[7], m[8]];
      addresses.set(parts.join('|').toLowerCase(), parts);
    }
    if (addresses.size === 1) {
      const [street, city, state, zip] = [...addresses.values()][0];
      Object.assign(out, { street: street.trim(), city: city.trim(), state, zip, source: 'page text' });
    }
    return out;
  }

  // The dealership's name from the page title, for a site with no og:site_name: the one part of
  // the title (split on | or a dash) that is not made of page words (Used, Vehicles for Sale,
  // Home), or '' when there is not exactly one, so the wizard asks rather than taking
  // "Used Vehicles" for the name
  function nameFromTitle(title) {
    const pageWords = /\b(used|pre-?owned|certified|new|vehicles?|cars?|trucks?|inventory|sales?|for|in|the|and|our|search|home|shop|specials?|financing|welcome|browse|view|all)\b/gi;
    const parts = String(title || '').split(/\s*[|·•–—]\s*|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
    const names = parts.filter((p) => p.replace(pageWords, '').replace(/[^a-z0-9]/gi, '').length > 0);
    return names.length === 1 ? names[0] : '';
  }

  const ogName = document.querySelector('meta[property="og:site_name"]');
  return {
    origin: location.origin,
    host: location.hostname.replace(/^www\./, ''),
    name: (ogName && ogName.content) || nameFromTitle(document.title),
    title: document.title,
    address: readSiteAddress(),
  };
}
