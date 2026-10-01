// DealerOn websites. Their used inventory page (/searchused.aspx on the sites
// seen in the 2026-10-01 page-text survey, which read server HTML through
// a web-fetch tool and saw no scripts) arrives as an empty shell and draws its cars with
// scripts that ask the website's own origin for the list as JSON
// (/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/..., "Cosmos" list pages;
// the answer carries DisplayCards[].VehicleCard records with VehicleVin,
// VehicleYear, VehicleDetailUrl, VehicleInternetPrice and Mileage, per a
// public write-up). Car pages are server HTML with the VIN in the address
// (/used-<Town>-<Year>-<Make>-<Model>-<Trim>-<VIN>) and the photos on the
// website itself (/inventoryphotos/<id>/<vin>/ip/<n>.jpg).
//
// NOT YET CHECKED ON A LIVE SITE: this container cannot reach dealer
// websites. The probe takes the inventory address from the request the page
// itself already made (the browser's resource timing list), so no address,
// dealer id or parameter is guessed; the list's field names are read
// tolerantly (inventoryJson.js); "pt" as the page-number parameter is the
// one assumption, and a page that repeats the first one ends the scan as not
// complete instead of reading wrong. README.md says what a survey run must
// confirm.
//
// The contract is in README.md. probeInPage and searchInPage are copied into
// the page by chrome.scripting.executeScript, so they are self-contained (no
// imports, nothing from outside the function body) and read-only.

import { normalizeInventoryRecord, photoOriginsOf, scanInventory, detailsFor, directSearch } from './inventoryJson.js';

export const PLATFORM = Object.freeze({ id: 'dealerOn', name: 'DealerOn' });

// The page-number parameter of the list address. Assumed from DealerOn's
// list addresses (searchused.aspx?pt=2); to confirm on a live site.
export const PAGE_PARAM = 'pt';

// ---------- in the dealer tab (self-contained, read-only) ----------

// Answers on a DealerOn page: one that has asked its website for the
// Cosmos list data, loads scripts from dealeron.com, is on a dealeron.com
// address, or says DealerOn in its copyright line. The inventory address
// is the first list request the page made (null on a page that made none,
// such as a car's page: the scan then says to open the used inventory page).
export function probeInPage() {
  if (/(^|\.)facebook\.com$/i.test(String(location.hostname || ''))) return null;
  const origin = location.origin;
  const LIST = /\/api\/vhcliaa\/vehicle-pages\/cosmos\/srp\/vehicles\//i;
  const hostOf = (href) => {
    try { return new URL(String(href || ''), origin).hostname; } catch (e) { return ''; }
  };
  let inventoryUrl = null;
  try {
    const entries = typeof performance !== 'undefined' && performance && typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
    for (const e of entries) {
      let u;
      try { u = new URL(String(e && e.name), origin); } catch (err) { continue; }
      if (u.origin === origin && LIST.test(u.pathname)) {
        inventoryUrl = u.href;
        break;
      }
    }
  } catch (e) {
    inventoryUrl = null;
  }
  let fromDealerOn = /(^|\.)dealeron\.com$/i.test(String(location.hostname || ''));
  for (const el of document.querySelectorAll('script[src], link[href]')) {
    if (/(^|\.)dealeron\.com$/i.test(hostOf(el.src || el.href || (el.getAttribute && (el.getAttribute('src') || el.getAttribute('href')))))) fromDealerOn = true;
  }
  const text = String((document.body && document.body.innerText) || '');
  const credit = /(?:©|copyright|website|powered|site)[^\n]{0,80}\bdealeron\b/i.test(text);
  if (!inventoryUrl && !fromDealerOn && !credit) return null;
  const here = new URL(document.URL || origin);
  here.hash = '';
  return { kind: 'dealerOn', origin, inventoryUrl, listUrl: here.href };
}

// One GET on this website, made the way the page's own fetch makes it (its
// cookies, no header of its own). An address off the website is
// refused before anything is sent. JSON comes back parsed; a web page comes
// back as text (a car's page, for its photos and for the sold check).
export async function searchInPage(service, request) {
  const LIMIT = 3000000;
  try {
    if (!request || typeof request.url !== 'string' || !request.url.trim()) return { ok: false, error: 'no address to read' };
    const target = new URL(request.url, location.origin);
    const allowed = service && service.origin ? String(service.origin) : location.origin;
    if (target.origin !== location.origin || target.origin !== allowed) return { ok: false, error: 'reads only ' + allowed + ', not ' + target.origin };
    const init = {};
    let timer = null;
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), 30000);
      init.signal = ctrl.signal;
    }
    try {
      const res = await fetch(target.href, init);
      const contentType = (res.headers && res.headers.get('content-type')) || '';
      // the body up to the limit, without reading the rest
      let text = '';
      if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            text += decoder.decode();
            break;
          }
          text += decoder.decode(chunk.value, { stream: true });
          if (text.length >= LIMIT) {
            reader.cancel().catch(() => {});
            break;
          }
        }
        text = text.slice(0, LIMIT);
      } else {
        text = String(await res.text()).slice(0, LIMIT);
      }
      let json = null;
      if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
        try { json = JSON.parse(text); } catch (e) { json = null; }
      }
      return { ok: true, data: { ok: res.ok, status: res.status, finalUrl: res.url || target.href, redirected: Boolean(res.redirected), contentType, json, text: json ? '' : text } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- in the extension ----------

function originOf(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch (e) {
    return null;
  }
}

export function detect(probe) {
  return Boolean(probe && probe.service && probe.service.kind === 'dealerOn');
}

// The website itself: the list data and the car pages are on its own
// origin, which the wizard asks for anyway, so no new permission.
export function origins(service) {
  const origin = originOf(service && service.origin);
  return origin ? [origin + '/' + '*'] : [];
}

export function scanOptions(service) {
  const origin = originOf(service && service.origin);
  if (!origin) return {};
  const inventoryUrl = service.inventoryUrl && originOf(service.inventoryUrl) === origin ? String(service.inventoryUrl) : null;
  return { origin, inventoryUrl };
}

// List page n: page 1 is the address the page itself called (with the page
// number set back to 1 if it had one); later pages set the page number.
export function pageAddress(inventoryUrl, n) {
  const u = new URL(inventoryUrl);
  if (n > 1 || u.searchParams.has(PAGE_PARAM)) u.searchParams.set(PAGE_PARAM, String(n));
  return u.href;
}

// Every photo of this car its page carries, in order: the website's own
// /inventoryphotos/<id>/<vin>/ip/<n>.jpg addresses (thumbnails left out).
export function pagePhotos(html, vin, pageUrl) {
  const found = new Map();
  const re = /(?:https?:)?(?:\/\/[^\s"'<>/]+)?\/inventoryphotos\/[^\s"'<>]*?\/([a-z0-9]{17})\/ip\/(\d+)\.(?:jpe?g|png|webp)/gi;
  for (const m of String(html || '').matchAll(re)) {
    if (m[1].toUpperCase() !== String(vin).toUpperCase() || /\/thumbs?\//i.test(m[0])) continue;
    const n = Number(m[2]);
    if (found.has(n)) continue;
    try { found.set(n, new URL(m[0], pageUrl).href); } catch (e) { /* not an address */ }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, href]) => href);
}

// The gap between car pages read one by one (a missing car's sold check)
// is the Crawl-delay the website's own robots.txt asks for, read at the scan
// (inventoryJson.js scanInventory). This is only the gap kept when
// robots.txt can't be read: the DealerOn sites in the page-text survey asked
// for 10 seconds. The list itself takes a few requests and does not wait.
export const PAGE_GAP_MS = 10000;

const PLATFORM_READING = { pageAddress, pagePhotos, pageGapMs: PAGE_GAP_MS };

export function scan(search, options = {}) {
  return scanInventory(search, options, PLATFORM_READING);
}

export function getDetails(search, vin, options = {}) {
  return detailsFor(search, vin, options, PLATFORM_READING);
}

export function normalize(record) {
  return record && record.card ? normalizeInventoryRecord(record.card, { origin: record.origin, page: record.page || null }) : null;
}

export function photoOrigins(records) {
  return photoOriginsOf(records);
}

// The same GET from the service worker (inventoryJson.js directSearch).
export function makeDirectSearch(service, fetchImpl = globalThis.fetch) {
  return directSearch(service, fetchImpl);
}

export default { PLATFORM, probeInPage, searchInPage, detect, origins, scanOptions, scan, getDetails, normalize, makeDirectSearch, photoOrigins };
