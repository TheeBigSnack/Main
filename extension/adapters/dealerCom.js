// Dealer.com websites (Cox Automotive). Their used inventory page
// (/used-inventory/index.htm in the 2026-10-01 page-text survey, which read
// server HTML through a web-fetch tool and saw no scripts; public search
// results name that page INVENTORY_LISTING_DEFAULT_AUTO_USED) draws its cars with scripts that
// ask the website's own origin for the list as JSON (a "getInventory"
// address of the inventory data widget). Car pages are server HTML at
// /used/<Make>/<Year>-<Make>-<Model>-<hash>.htm or /certified/..., with no VIN
// in the address; a sold car's page answers 410 Gone (seen on seven sold
// cars in the survey), which is the sold signal. Photos are on Dealer.com's
// picture servers (pictures.dealer.com in its documentation,
// pictures.web.dealer.com in the survey), asked for from the salesperson's
// click at post time like any photo server (src/photoHosts.js).
//
// The field names are Dealer.com's own published vehicle fields (its Web
// Integration API documentation: vin, stockNumber, year, make, model, trim,
// odometer, inventoryType, certified, link, images, finalPrice, startingPrice,
// address.accountName...) read tolerantly (inventoryJson.js); finalPrice is
// "the price the dealership is willing to sell the vehicle at" there.
//
// NOT YET CHECKED ON A LIVE SITE: this container cannot reach dealer
// websites. The probe takes the inventory address from the request the page
// itself already made (the browser's resource timing list), so no address or
// site id is guessed; "start" as the paging parameter (the first car of the
// page, counted from 0) is the one assumption, and a page that repeats the
// first one ends the scan as not complete. If the page asks for its list
// with a POST, a GET of the same address is refused by the website and the
// scan says so: that is what a survey run must confirm (README.md).
//
// The contract is in README.md. probeInPage and searchInPage are copied into
// the page by chrome.scripting.executeScript, so they are self-contained (no
// imports, nothing from outside the function body) and read-only.

import { normalizeInventoryRecord, photoOriginsOf, scanInventory, detailsFor, directSearch } from './inventoryJson.js';

export const PLATFORM = Object.freeze({ id: 'dealerCom', name: 'Dealer.com' });

// The paging parameter of the list address: the first car of the page,
// counted from 0. Assumed from Dealer.com's list addresses
// (index.htm?start=35); to confirm on a live site.
export const PAGE_PARAM = 'start';

// ---------- in the dealer tab (self-contained, read-only) ----------

// Answers on a Dealer.com page: one that has asked its website for its
// inventory data (a getInventory address), carries the page's DDC object,
// loads files from dealer.com, is on a dealer.com address, or says "Website
// by Dealer.com". The inventory address is the first such request the page
// made (null on a page that made none, such as a car's page: the scan then
// says to open the used inventory page).
export function probeInPage() {
  if (/(^|\.)facebook\.com$/i.test(String(location.hostname || ''))) return null;
  const origin = location.origin;
  const LIST = /\/getinventory(?:\/|$)|\/ws-inv-data\//i;
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
  const ddc = typeof window !== 'undefined' && window && window.DDC && typeof window.DDC === 'object';
  let fromDealerCom = /(^|\.)dealer\.com$/i.test(String(location.hostname || ''));
  for (const el of document.querySelectorAll('script[src], link[href]')) {
    if (/(^|\.)dealer\.com$/i.test(hostOf(el.src || el.href || (el.getAttribute && (el.getAttribute('src') || el.getAttribute('href')))))) fromDealerCom = true;
  }
  const text = String((document.body && document.body.innerText) || '');
  const credit = /(?:website|powered|site)\s+by\s+dealer\.com\b/i.test(text);
  if (!inventoryUrl && !ddc && !fromDealerCom && !credit) return null;
  const here = new URL(document.URL || origin);
  here.hash = '';
  return { kind: 'dealerCom', origin, inventoryUrl, listUrl: here.href };
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
      const text = String(await res.text()).slice(0, LIMIT);
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
  return Boolean(probe && probe.service && probe.service.kind === 'dealerCom');
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

// List page n: page 1 is the address the page itself called (starting
// from the first car if it named a start); later pages start after the cars
// the pages before held (firstCount per page).
export function pageAddress(inventoryUrl, n, firstCount = 0) {
  const u = new URL(inventoryUrl);
  if (n > 1 || u.searchParams.has(PAGE_PARAM)) u.searchParams.set(PAGE_PARAM, String((n - 1) * firstCount));
  return u.href;
}

// Dealer.com car pages carry photos of other cars too (similar vehicles)
// with nothing in their addresses to tell them apart, so only the page's
// standard vehicle data for this VIN and the list's own images are used.
export function pagePhotos() {
  return [];
}

const PLATFORM_READING = { pageAddress, pagePhotos };

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
