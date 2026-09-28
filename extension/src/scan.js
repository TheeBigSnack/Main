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
    const m = /(\d{1,6}\s+[A-Za-z0-9 .'-]{3,60}?),?\s+([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/.exec(document.body.innerText || '');
    if (m) Object.assign(out, { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4], source: 'page text' });
    return out;
  }

  const ogName = document.querySelector('meta[property="og:site_name"]');
  return {
    origin: location.origin,
    host: location.hostname.replace(/^www\./, ''),
    name: (ogName && ogName.content) || document.title.split('|').pop().trim(),
    title: document.title,
    address: readSiteAddress(),
  };
}
