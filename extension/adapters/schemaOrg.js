// Any dealer website that publishes standard vehicle data: the schema.org
// markup (JSON-LD or microdata) that search engines read, on its inventory
// list and on each car's own page. Written from the public schema.org
// definitions and Google's vehicle listing documentation, not from any one
// platform's pages, so it names none: which platforms it reads well is only
// known once a real site has been scanned. It comes last in ADAPTERS, so a
// website whose platform has an adapter of its own (Dealer Inspire) is still
// read through that platform's service.
//
// The contract is in README.md. What is particular to this adapter:
//   - There is no inventory service. The service is the website's origin and
//     its used inventory page; a search(request) is one GET of a page on that
//     origin ({ url }) and answers { ok, status, finalUrl, redirected,
//     contentType, text }. searchInPage makes it from the dealer tab the way
//     the page's own fetch would (the page's cookies, no header of Lot
//     Current's); makeDirectSearch makes it from the service worker, without
//     cookies, with the permission for the website that the wizard already
//     asks for. Both refuse to ask for an address off the website. A
//     redirect the website answers with is followed the way a browser follows
//     it, but an answer that lands off the website is never used (judge).
//   - scan() reads the list and the pages its rel=next links lead to, then
//     each car's own page, two at a time, with no pauses and nothing random
//     about its timing. The first 403, 429, 503 or bot check stops the scan
//     and says so, and so do three car pages in a row that fail: it never
//     retries harder and never tries to get past a refusal.
//   - A car is called gone only when its own page says so (confirmOne).
//   - robots.txt is read only for the sitemaps it names (sitemapAddresses):
//     its Disallow and Crawl-delay lines are not applied. Whether they should
//     be is the owner's open question (README.md).
// schemaOrgParse.js reads a page; schemaOrgNormalize.js makes the flat vehicle.

import { parseVehiclePage, extractJsonLd, decodeEntities } from './schemaOrgParse.js';
import { normalizeVehicle } from './schemaOrgNormalize.js';
import { checkPreOwned, DECISION } from '../src/classify.js';

export const PLATFORM = Object.freeze({ id: 'schemaOrg', name: 'Standard vehicle data (schema.org)' });

// The most of one page Lot Current keeps. A car's page is far shorter; a page
// cut at this length is read as far as it goes and the scan says it is not
// complete. searchInPage runs inside the page and can't import this, so it
// carries the same number (test/adapters.test.js checks the two agree).
export const PAGE_TEXT_LIMIT = 3000000;
// Pages read at once. Fixed and small: the dealer's website serves its
// customers first, and nothing about the timing is varied.
export const CONCURRENCY = 2;
export const MAX_LIST_PAGES = 40;
// The most car pages one scan reads. On a larger lot the pages not read are
// left for the next scans, oldest reading first (scan step 3), so every car's
// page is read again within a few scans.
export const MAX_CAR_PAGES = 600;
// Car pages that fail one after another before the scan stops: a website
// that keeps failing is struggling or turning Lot Current away, and the rest
// of the lot is not asked for.
export const MAX_FAILED_IN_A_ROW = 3;
export const MAX_SITEMAPS = 5;
// The most of robots.txt read for its Sitemap lines: what search engines read
// of it (500 KiB); the rest of a longer file is ignored, as they ignore it.
export const ROBOTS_TEXT_LIMIT = 512000;
export const MAX_SITEMAP_ADDRESSES = 20000;
export const REQUEST_TIMEOUT_MS = 30000;

// ---------- in the dealer tab (self-contained, read-only) ----------

// Answers on a page that lists cars (vehicle data in its JSON-LD or
// microdata, or at least two links on this website to car pages: an address
// with a VIN in it, or one that reads like a car page) or on one car's own
// page. The list to scan is, in order: the page it ran on when its own
// address reads as used inventory and names no part of the lot (below); the
// used inventory page it links to when that link reads as the whole used
// list (its words say so, "Used", "Shop pre-owned", or its address is only
// inventory words, "/used-vehicles/", "/inventory/?condition=used"); the
// page it ran on when its title names used cars and not new ones ("Used
// Vehicles for Sale" at "/inventory/", the list of a lot that sells only
// used cars), its address names no part of the lot, and it is not the
// site's home page (a home page titled "New & Used Cars" with a few featured
// cars is not the used list); a link with a used word and an inventory word
// in its address and no other filter ("/used-cars-<town>/"); else the page it
// ran on. The shortest link of each kind. A link is never the list when its
// query holds anything but words that select used cars (certified ones too,
// beside a value that selects used ones) and a page number or sort order (by
// the parameter's name: "page", "sort", "order" and the like), so a filtered
// list ("/used-cars/?make=Jeep") is not; nor when its address names a part
// of the lot by a word this probe knows (SUBSET_WORDS: a make,
// "/used-jeep-cars/", "/used-jeep-wrangler/"; certified cars,
// "/certified-pre-owned-vehicles/"; a body style, a fuel, a price range or a
// deal); nor when it is for selling, trading in or valuing a car
// ("/sell-your-used-car/"). A page about part of the lot named only with
// other words ("/used-wrangler-inventory/") can still be taken. On a used
// list opened past its first page, or sorted or filtered, it is the same
// list with fewer of those parameters when the page links to it (its "Used"
// link, its first page), so a scan reads the whole list; a parameter is
// never removed by its name, so one that selects used inventory stays. On a
// car's page it is the used inventory page it links to, the same way (null
// when it links to none that reads as the whole used list).
export function probeInPage() {
  // Facebook is where listings go, never a website to read. The popup never
  // offers a scan there; this probe refuses too, because any page with car
  // links would otherwise answer.
  if (/(^|\.)facebook\.com$/i.test(String(location.hostname || ''))) return null;
  const TYPES = ['car', 'vehicle', 'motorvehicle', 'motorcycle'];
  const site = location.origin;
  const here = new URL(document.URL || site);
  const isRoute = (u) => /^#!?\//.test(u.hash);
  if (!isRoute(here)) here.hash = '';
  const pageAddress = here.href;

  // 17 letters and digits without I, O or Q, at least one letter, the last
  // three digits: the shape of a VIN inside an address.
  const vinShaped = (value) => {
    const str = String(value || '');
    const re = /(?:^|[^a-z0-9])([a-hj-npr-z0-9]{14}[0-9]{3})(?=[^a-z0-9]|$)/gi;
    let m = re.exec(str);
    while (m) {
      if (/[a-z]/i.test(m[1])) return m[1].toUpperCase();
      m = re.exec(str);
    }
    return '';
  };
  const readable = (u) => {
    const raw = u.pathname + u.search + (isRoute(u) ? u.hash : '');
    try { return decodeURIComponent(raw).toLowerCase(); } catch (e) { return raw.toLowerCase(); }
  };
  // "used-2019-honda-civic" under an inventory word: how car pages are
  // usually addressed when the VIN is not in the address.
  const carShaped = (u) => {
    const p = readable(u);
    return /(?:^|[^a-z0-9])(?:19[5-9][0-9]|20[0-9][0-9])[-_+]+[a-z]/.test(p) && /(?:^|[^a-z])(?:inventory|vehicles?|vdp|details?|used|pre-?owned|preowned|certified|cpo|for-?sale|stock)(?:[^a-z]|$)/.test(p);
  };
  const usedWords = /(?:^|[^a-z])(?:used|pre-?owned|preowned)(?:[^a-z]|$)|used(?:cars|vehicles|inventory)|search-?used/;
  // A title naming used cars and not new ones. "New & Used Cars", "New,
  // Used and Certified" and "New Cars | Used Cars" name both; a place name
  // ("Used Cars near New Haven") is not a new car.
  const title = String(document.title || '');
  const usedTitle = /\b(?:used|pre-?owned|preowned|certified)\b/i.test(title)
    && !/\bnew\s*(?:,|&|&amp;|\+|\/|and|or)\s*(?:used|pre-?owned|preowned|certified)\b|\b(?:used|pre-?owned|preowned|certified)\s*(?:,|&|&amp;|\+|\/|and|or)\s*new\b|\bnew\s+(?:cars|vehicles|trucks|suvs|inventory)\b/i.test(title);
  const routePath = (u) => (isRoute(u) ? u.hash.replace(/^#!?/, '').split('?')[0] : '');
  const atRoot = /^\/?(?:(?:index|default|home)(?:\.[a-z]+)?\/?)?$/i.test(here.pathname) && routePath(here).replace(/\/+$/, '') === '';
  // The words of an address's path, segment by segment.
  const pathWords = (u) => {
    let p = u.pathname + routePath(u);
    try { p = decodeURIComponent(p); } catch (e) { /* as it is */ }
    return p.toLowerCase().split('/').filter(Boolean).map((s) => s.split(/[^a-z0-9]+/).filter(Boolean));
  };
  const LIST_WORDS = new Set(['used', 'pre', 'owned', 'preowned', 'inventory', 'vehicles', 'vehicle', 'cars', 'car', 'autos', 'auto', 'search', 'searchused', 'usedcars', 'usedvehicles', 'usedinventory', 'all', 'for', 'sale', 'forsale', 'shop', 'browse', 'view', 'index', 'default', 'htm', 'html', 'aspx', 'asp', 'php', 'jsp', 'cfm']);
  const usedText = /^\s*(?:(?:shop|view|browse|see|all)\s+)*(?:used|pre-?owned)(?:\s+(?:inventory|vehicles|cars))?\s*$/i;
  // A query that selects nothing but used inventory ("?condition=used",
  // "?type=Pre-Owned", "?condition=used&condition=certified"), or none,
  // besides a page number or a sort order. Any other value (a make, a price,
  // certified cars alone) narrows the list.
  const ORDER_KEY = /^(?:page|p|pg|start|sort|sortby|sort_by|sortorder|sort_order|order|orderby|order_by|dir|direction)$/i;
  const valueWords = ([k, v]) => String(v || k).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const certifiedWord = (w) => w === 'certified' || w === 'cpo';
  const usedQuery = (u) => {
    const values = [...u.searchParams.entries()].filter(([k]) => !ORDER_KEY.test(k)).map(valueWords);
    if (!values.every((words) => words.length > 0 && words.every((w) => LIST_WORDS.has(w) || certifiedWord(w)))) return false;
    return !values.some((words) => words.some(certifiedWord)) || values.some((words) => !words.some(certifiedWord) && words.some((w) => /^(?:used|pre|owned|preowned|usedcars|usedvehicles|usedinventory|searchused)$/.test(w)));
  };
  // Words that name part of a lot: a make, certified cars, a body style, a
  // fuel, a price range or a deal. An address with one of them in its path
  // is about those cars only. Every make the VIN check knows is here
  // (test/adapters.test.js checks it); a make or a place sharing a name
  // ("Lincoln") makes the probe keep to the page it ran on.
  const SUBSET_WORDS = new Set([
    'acura', 'alfa', 'romeo', 'aprilia', 'aston', 'audi', 'bentley', 'benz', 'bmw', 'buick', 'cadillac', 'chevrolet', 'chevy', 'chrysler', 'datsun', 'dodge', 'ducati', 'eagle', 'ferrari', 'fiat', 'fisker', 'ford', 'genesis', 'gmc', 'guzzi', 'harley', 'davidson', 'honda', 'hummer', 'hyundai', 'indian', 'infiniti', 'isuzu', 'jaguar', 'jeep', 'kawasaki', 'kia', 'lamborghini', 'land', 'rover', 'landrover', 'rangerover', 'lexus', 'lincoln', 'lotus', 'lucid', 'maserati', 'mazda', 'mclaren', 'mercedes', 'mercedesbenz', 'mercury', 'mini', 'mitsubishi', 'motorrad', 'nissan', 'oldsmobile', 'plymouth', 'polestar', 'pontiac', 'porsche', 'ram', 'renault', 'rivian', 'rolls', 'royce', 'saab', 'saturn', 'scion', 'smart', 'subaru', 'suzuki', 'tesla', 'toyota', 'triumph', 'vespa', 'volkswagen', 'vw', 'volvo', 'yamaha',
    'certified', 'cpo',
    'truck', 'trucks', 'pickup', 'pickups', 'suv', 'suvs', 'sedan', 'sedans', 'coupe', 'coupes', 'convertible', 'convertibles', 'hatchback', 'hatchbacks', 'wagon', 'wagons', 'van', 'vans', 'minivan', 'minivans', 'crossover', 'crossovers', '4x4', 'awd', '4wd', 'sports', 'luxury', 'commercial', 'work', 'motorcycle', 'motorcycles', 'rv', 'rvs',
    'electric', 'ev', 'evs', 'hybrid', 'hybrids', 'diesel', 'diesels',
    'under', 'below', 'budget', 'cheap', 'bargain', 'bargains', 'deal', 'deals', 'special', 'specials', 'clearance', 'priced', 'reduced', 'discount', 'discounted', 'outlet',
  ]);
  const partOfLot = (u) => pathWords(u).some((words) => words.some((w) => SUBSET_WORDS.has(w)));
  // A page for selling or trading a car in, or for its value: never the list.
  const sellWords = /(?:^|[^a-z])(?:sell|selling|trade|trades|tradein|trade-in|value|valuation|apprais[a-z]*|we-?buy|instant-?offer|cash-?offer|kbb)(?:[^a-z]|$)/;
  const inventoryWord = /(?:^|[^a-z])(?:inventory|vehicles?|cars?|autos?)(?:[^a-z]|$)/;
  // 0: its words say used inventory; 1: its address is only inventory
  // words; 2: an address with a used word and an inventory word
  // ("/used-cars-<town>/"); 3: any other (a filtered list, part of the lot,
  // the home page), never taken over the page itself. Ranks 0 to 2 only
  // with a query that selects used cars at most and an address that names
  // no part of the lot.
  const usedRank = (u, text) => {
    const path = pathWords(u);
    if (!path.length || !usedQuery(u) || partOfLot(u)) return 3;
    if (usedText.test(text)) return 0;
    if (path.every((words) => words.every((w) => LIST_WORDS.has(w)))) return 1;
    return inventoryWord.test(path.map((words) => words.join('-')).join('/')) ? 2 : 3;
  };
  const samePage = (href) => {
    try {
      const u = new URL(href, pageAddress);
      return u.origin === here.origin && u.pathname.replace(/\/+$/, '') === here.pathname.replace(/\/+$/, '');
    } catch (e) {
      return false;
    }
  };

  // The vehicle nodes in the page's JSON-LD: their VIN and address.
  const nodes = [];
  const visit = (x, depth) => {
    if (!x || typeof x !== 'object' || depth > 8 || nodes.length > 500) return;
    if (Array.isArray(x)) {
      for (const y of x) visit(y, depth + 1);
      return;
    }
    const types = [].concat(x['@type'] || []).map((t) => String(t).trim().replace(/\/+$/, '').split(/[/#:]/).pop().toLowerCase());
    const vin = String([].concat(x.vehicleIdentificationNumber || '')[0] || '').replace(/\s+/g, '').toUpperCase();
    if (types.some((t) => TYPES.includes(t)) || (types.includes('product') && vin)) {
      const address = [].concat(x.url || '')[0];
      nodes.push({ vin, address: typeof address === 'string' ? address : '' });
      return;
    }
    for (const k of ['@graph', 'itemListElement', 'item', 'mainEntity', 'itemOffered', 'makesOffer', 'hasOfferCatalog']) if (x[k]) visit(x[k], depth + 1);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(s.textContent), 0); } catch (e) { /* not JSON: the next block */ }
  }
  let micro = 0;
  for (const el of document.querySelectorAll('[itemtype]')) {
    const kinds = String(el.getAttribute('itemtype') || '').split(/\s+/).map((t) => t.replace(/\/+$/, '').split(/[/#:]/).pop().toLowerCase());
    if (kinds.some((t) => TYPES.includes(t))) micro += 1;
  }

  // The same list as this page with only some of its query parameters
  // (each with this page's value): its first page, unsorted, unfiltered.
  const hereParams = [...here.searchParams.entries()];
  const fewerParams = (u) => {
    if (isRoute(here) || u.pathname.replace(/\/+$/, '') !== here.pathname.replace(/\/+$/, '')) return false;
    const theirs = [...u.searchParams.entries()];
    return theirs.length < hereParams.length && theirs.every(([k, v]) => here.searchParams.getAll(k).includes(v));
  };

  // Links on this website to car pages, the best link to used inventory,
  // and the same used list with fewer parameters.
  const carLinks = new Set();
  let usedLink = '';
  let usedLinkRank = 3;
  let wholeList = null;
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href, pageAddress); } catch (e) { continue; }
    if (u.origin !== here.origin || (u.protocol !== 'https:' && u.protocol !== 'http:')) continue;
    if (!isRoute(u)) u.hash = '';
    if (u.href === pageAddress) continue;
    if (fewerParams(u) && usedWords.test(readable(u))) {
      const count = [...u.searchParams.keys()].length;
      if (!wholeList || count < wholeList.count || (count === wholeList.count && u.href.length < wholeList.href.length)) wholeList = { href: u.href, count };
    }
    if (vinShaped(readable(u)) || carShaped(u)) carLinks.add(u.href);
    else if ((usedWords.test(readable(u)) || usedText.test(String(a.textContent || ''))) && !sellWords.test(readable(u)) && !sellWords.test(String(a.textContent || '').toLowerCase())) {
      const rank = usedRank(u, String(a.textContent || ''));
      if (rank < usedLinkRank || (rank === usedLinkRank && u.href.length < usedLink.length)) {
        usedLink = u.href;
        usedLinkRank = rank;
      }
    }
  }

  const own = nodes.filter((n) => !n.address || samePage(n.address));
  const onePage = Boolean(vinShaped(readable(here)))
    || (carShaped(here) && (own.length > 0 || micro > 0))
    || (own.length === 1 && Boolean(own[0].vin));
  const aList = !onePage && (carLinks.size >= 2 || nodes.length > 0 || micro > 0);
  if (!onePage && !aList) return null;
  const usedList = usedLink && usedLinkRank < 3 ? usedLink : '';
  if (onePage) return { kind: 'schemaOrg', origin: site, listUrl: usedList || null };
  if (usedWords.test(readable(here)) && !partOfLot(here)) return { kind: 'schemaOrg', origin: site, listUrl: wholeList ? wholeList.href : pageAddress };
  if (usedList && usedLinkRank < 2) return { kind: 'schemaOrg', origin: site, listUrl: usedList };
  if (usedTitle && !atRoot && !partOfLot(here)) return { kind: 'schemaOrg', origin: site, listUrl: pageAddress };
  return { kind: 'schemaOrg', origin: site, listUrl: usedList || pageAddress };
}

// One GET of a page on this website, made the way the page's own fetch makes
// it: no header of Lot Current's, the page's cookies as a same-site fetch sends
// them. An address off the website is refused before anything is sent. A
// redirect the website answers with is followed as the browser follows any
// redirect (cookies go only to the website's own origin); scan() never uses
// an answer that landed off the website.
export async function searchInPage(service, request) {
  const LIMIT = 3000000;
  try {
    if (!request || typeof request.url !== 'string' || !request.url.trim()) return { ok: false, error: 'no page address to read' };
    const target = new URL(request.url, location.origin);
    const allowed = service && service.origin ? String(service.origin) : location.origin;
    if (target.origin !== location.origin || target.origin !== allowed) {
      return { ok: false, error: 'Lot Current reads only ' + allowed + ', not ' + target.origin };
    }
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
      let text = '';
      if (!contentType || /text\/|html|xml/i.test(contentType)) {
        if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let chunk = await reader.read();
          while (!chunk.done && text.length < LIMIT) {
            text += decoder.decode(chunk.value, { stream: true });
            if (text.length < LIMIT) chunk = await reader.read();
          }
          if (!chunk.done) reader.cancel().catch(() => {});
          else text += decoder.decode();
        } else {
          text = await res.text();
        }
      }
      return { ok: true, data: { ok: res.ok, status: res.status, finalUrl: res.url || target.href, redirected: Boolean(res.redirected), contentType, text: text.slice(0, LIMIT) } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- in the extension ----------

export function detect(probe) {
  return Boolean(probe && probe.service && probe.service.kind === 'schemaOrg');
}

function originOf(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch (e) {
    return null;
  }
}

// An address resolved against another, when it is on the given origin.
function onSite(href, base, origin) {
  if (typeof href !== 'string' || !href.trim() || !origin) return null;
  try {
    const u = new URL(href.trim(), base || undefined);
    return u.origin === origin ? u : null;
  } catch (e) {
    return null;
  }
}

// Two spellings of one page share this key: no fragment (a single-page
// site's "#/" route is kept, it is a page of its own), no trailing slash.
function pageKey(href) {
  try {
    const u = new URL(String(href));
    const route = /^#!?\//.test(u.hash) ? u.hash : '';
    return u.origin + u.pathname.replace(/\/+$/, '') + u.search + route;
  } catch (e) {
    return '';
  }
}

// The page's key without its query: a car's address with a tracking or print
// query added ("?srp=1") is that car's page (carKeys).
function queryless(href) {
  try {
    const u = new URL(String(href));
    u.search = '';
    return pageKey(u.href);
  } catch (e) {
    return '';
  }
}

// The same without the query: where a redirect went, compared with where it started.
function pathKey(href) {
  try {
    const u = new URL(String(href));
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// The only host permission background rescans need: the website itself,
// which the wizard asks for anyway (rescanSchedule.js originsFor), so a
// website read this way needs no new permission. (The pattern is built in
// two pieces so the guard tests' comment stripper never meets a
// block-comment opener inside a string.)
export function origins(service) {
  const origin = originOf(service && service.origin);
  return origin ? [origin + '/' + '*'] : [];
}

// What scan() and getDetails() need from the service: the website and its list.
export function scanOptions(service) {
  const origin = originOf(service && service.origin);
  if (!origin) return {};
  const list = onSite(service.listUrl, null, origin);
  return { origin, listUrl: list ? list.href : null };
}

// Reads a response body up to the limit, without reading the rest.
async function cappedText(res, limit) {
  if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return out + decoder.decode();
      out += decoder.decode(chunk.value, { stream: true });
      if (out.length >= limit) {
        reader.cancel().catch(() => {});
        return out.slice(0, limit);
      }
    }
  }
  return String(await res.text()).slice(0, limit);
}

// A search(request) from the service worker: one GET of a page on this
// website, without the browser's cookies (a website that turns such a read
// away fails the background rescan with its reason; the Scan button still
// reads it from the tab). No header of Lot Current's is added. An address off
// the website throws before anything is sent. A redirect the website answers
// with is followed as a browser follows it (still without cookies), and
// scan() never uses an answer that landed off the website (judge).
export function makeDirectSearch(service, fetchImpl = globalThis.fetch) {
  const origin = originOf(service && service.origin);
  return async (request) => {
    const href = request && request.url;
    const target = onSite(typeof href === 'string' ? href : '', origin, origin);
    if (!target) throw new Error(`Lot Current reads only ${origin || 'the dealership website'}, not ${String(href || 'an empty address').slice(0, 80)}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(target.href, { credentials: 'omit', signal: ctrl.signal });
      const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
      const text = !contentType || /text\/|html|xml/i.test(contentType) ? await cappedText(res, PAGE_TEXT_LIMIT) : '';
      return { ok: Boolean(res.ok), status: res.status, finalUrl: res.url || target.href, redirected: Boolean(res.redirected), contentType, text };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------- car addresses ----------

const VIN_IN_ADDRESS = /(?:^|[^A-Za-z0-9])([A-HJ-NPR-Za-hj-npr-z0-9]{14}[0-9]{3})(?![A-Za-z0-9])/g;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

function addressText(href) {
  try {
    const u = new URL(String(href));
    const raw = u.pathname + u.search + (/^#!?\//.test(u.hash) ? u.hash : '');
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  } catch (e) {
    return '';
  }
}

// Every VIN an address carries, upper case, once each.
function vinsInAddress(href) {
  const out = new Set();
  for (const m of addressText(href).matchAll(VIN_IN_ADDRESS)) if (/[A-Za-z]/.test(m[1])) out.add(m[1].toUpperCase());
  return [...out];
}

/** The VIN in a car page's address ("/used-2019-honda-civic-2hgsampl8kh000101/"), upper case, or ''. */
export function vinInAddress(href) {
  return vinsInAddress(href)[0] || '';
}

// The VIN in an address's path, leaving its query out: a form about a car
// ("/finance/apply/?vin=...") carries the VIN only in its query.
function vinInPath(href) {
  try {
    const u = new URL(String(href));
    u.search = '';
    return vinInAddress(u.href);
  } catch (e) {
    return '';
  }
}

/**
 * One address per car. A list's card often links forms and files about its
 * car as well as the car's page ("Get pre-approved", "Check availability", a
 * window sticker), each with the car's VIN in its address; a car is counted
 * once, and read at the address most likely to be its page, so a form is not
 * fetched on every scan. For each VIN with several addresses in `cars` (page
 * key -> address) the one kept is, in order: the address the list's own
 * data names for that car (named: page key -> VIN), the page the last read
 * of the car came from (lastSeen), one with the VIN in its path rather than
 * only in its query, else the first the list links. The others are not
 * dropped from the car: `alternates` (page key -> addresses, best first)
 * keeps them for the kept address, and the scan reads them in turn when the
 * kept one turns out not to be the car's page (a form linked before the
 * car's own link on a lot whose car pages carry the VIN in the query, a
 * file with the VIN in its path). A car with one address keeps it.
 */
export function oneAddressPerCar(cars, { named = new Map(), lastSeen = {}, alternates = new Map() } = {}) {
  const byVin = new Map();
  let order = 0;
  for (const [key, href] of cars) {
    const vin = named.get(key) || vinInAddress(href);
    if (!vin) continue;
    if (!byVin.has(vin)) byVin.set(vin, []);
    byVin.get(vin).push({ key, href, order: (order += 1) });
  }
  for (const [vin, all] of byVin) {
    if (all.length < 2) continue;
    const last = lastSeen && lastSeen[vin] && typeof lastSeen[vin].url === 'string' ? pageKey(lastSeen[vin].url) : '';
    const rank = (a) => [named.get(a.key) === vin ? 0 : 1, last && a.key === last ? 0 : 1, vinInPath(a.href) === vin ? 0 : 1, a.order];
    const ranked = all.slice().sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    });
    const keep = ranked[0];
    const others = [];
    for (const a of ranked) {
      for (const href of [a.href, ...(alternates.get(a.key) || [])]) if (href !== keep.href && !others.includes(href)) others.push(href);
      if (a !== keep) {
        cars.delete(a.key);
        alternates.delete(a.key);
      }
    }
    alternates.set(keep.key, others);
  }
  return cars;
}

// A file (a window sticker, a brochure, a photo) by its address, before it
// is asked for: never a car's web page.
const FILE_ADDRESS = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|bmp|tiff?|docx?|xlsx?|pptx?|csv|zip|mp4|mov)$/i;
function fileAddress(href) {
  try {
    return FILE_ADDRESS.test(new URL(String(href)).pathname);
  } catch (e) {
    return false;
  }
}

// The kind of address a lot's car page, form or file is, for telling which
// of a car's addresses is its page once a car or two has been read: the
// path with any segment holding a digit (a year, a VIN, a stock number)
// stood in for, and the query's names.
function addressPattern(href) {
  try {
    const u = new URL(String(href));
    return u.pathname.toLowerCase().split('/').filter(Boolean).map((s) => (/\d/.test(s) ? '*' : s)).join('/') + '?' + [...new Set(u.searchParams.keys())].sort().join('&');
  } catch (e) {
    return '';
  }
}

// The most addresses read for one car in one scan, its kept one included.
export const MAX_ADDRESSES_PER_CAR = 4;

/** An address that reads like a car's page without a VIN in it: a model year joined to words, under an inventory word. */
export function looksLikeCarAddress(href) {
  const p = addressText(href).toLowerCase();
  return /(?:^|[^a-z0-9])(?:19[5-9][0-9]|20[0-9][0-9])[-_+]+[a-z]/.test(p) && /(?:^|[^a-z])(?:inventory|vehicles?|vdp|details?|used|pre-?owned|preowned|certified|cpo|for-?sale|stock)(?:[^a-z]|$)/.test(p);
}

// For the cards of a page (carKeys): an address that reads like any car's
// page, a new car's ("/new/2027-...") as well as a used one's.
function readsLikeAnyCar(href) {
  if (looksLikeCarAddress(href)) return true;
  const p = addressText(href).toLowerCase();
  return /(?:^|[^a-z0-9])(?:19[5-9][0-9]|20[0-9][0-9])[-_+]+[a-z]/.test(p) && /(?:^|[^a-z])new(?:[^a-z]|$)/.test(p);
}

/**
 * The shape this website gives its own car pages, learned from the car
 * addresses its list links to: the number of path segments most of them
 * have, the segments they all share, the start each varying segment shares
 * ("used-" when every car address starts that way), the query names, and
 * whether a VIN is in every one. Learned again on every scan, from this
 * website only; null from fewer than two addresses.
 */
export function learnCarAddressShape(hrefs) {
  const samples = [];
  for (const href of Array.isArray(hrefs) ? hrefs : []) {
    try {
      const u = new URL(href);
      samples.push({ segments: u.pathname.split('/').filter(Boolean), keys: [...new Set(u.searchParams.keys())].sort().join('&'), vin: Boolean(vinInAddress(href)) });
    } catch (e) { /* not an address */ }
  }
  if (samples.length < 2) return null;
  const lengths = new Map();
  for (const s of samples) lengths.set(s.segments.length, (lengths.get(s.segments.length) || 0) + 1);
  const depth = [...lengths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const alike = samples.filter((s) => s.segments.length === depth);
  if (alike.length < 2) return null;
  const segments = [];
  for (let i = 0; i < depth; i += 1) {
    const values = alike.map((s) => s.segments[i].toLowerCase());
    if (values.every((v) => v === values[0])) {
      segments.push({ exact: values[0] });
      continue;
    }
    let start = values[0];
    for (const v of values) while (!v.startsWith(start)) start = start.slice(0, -1);
    const cut = Math.max(start.lastIndexOf('-'), start.lastIndexOf('_'));
    segments.push({ startsWith: cut === -1 ? '' : start.slice(0, cut + 1) });
  }
  const keys = alike.every((s) => s.keys === alike[0].keys) ? alike[0].keys : null;
  return { segments, keys, vin: alike.every((s) => s.vin) };
}

export function matchesCarAddressShape(href, shape) {
  if (!shape) return false;
  let u;
  try {
    u = new URL(href);
  } catch (e) {
    return false;
  }
  const segments = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length !== shape.segments.length) return false;
  for (let i = 0; i < segments.length; i += 1) {
    const want = shape.segments[i];
    if (want.exact !== undefined ? segments[i] !== want.exact : !segments[i].startsWith(want.startsWith)) return false;
  }
  if (shape.keys !== null && [...new Set(u.searchParams.keys())].sort().join('&') !== shape.keys) return false;
  return !shape.vin || Boolean(vinInAddress(href));
}

// ---------- what one answer from the website means ----------

const firstText = (value) => {
  const v = Array.isArray(value) ? value.find((x) => typeof x === 'string') : value;
  return typeof v === 'string' ? v.trim() : '';
};

function nodeVin(node) {
  const vin = firstText(node && node.vehicleIdentificationNumber).replace(/\s+/g, '').toUpperCase();
  return VIN.test(vin) ? vin : '';
}

function soldOut(node) {
  const offers = [].concat((node && node.offers) || []);
  return offers.some((o) => o && typeof o === 'object' && [].concat(o.availability || []).some((a) => {
    const name = typeof a === 'string' ? a : a && typeof a === 'object' ? a['@id'] || a.name : '';
    return typeof name === 'string' && name.trim().replace(/\/+$/, '').split(/[/#:]/).pop().toLowerCase() === 'soldout';
  }));
}

// Words a bot check or a block page shows instead of the website's page.
const BOT_CHECK = /captcha|are you (?:a )?(?:human|robot)|verify(?:ing)? (?:that )?you are (?:a )?human|checking your browser|checking if the site connection is secure|access denied|request unsuccessful|enable (?:javascript and )?cookies to continue|just a moment/i;

const STOPPED = {
  403: 'The website refused a page to Lot Current (HTTP 403), so the scan stopped.',
  429: 'The website asked Lot Current to slow down (HTTP 429), so the scan stopped. Nothing was retried; try again later.',
  503: 'The website said it was too busy or unavailable (HTTP 503), so the scan stopped. Nothing was retried; try again later.',
  check: 'The website showed a bot check instead of its page, so the scan stopped. Lot Current never tries to get past one.',
};

const isHtmlAnswer = (contentType, text) => /html/i.test(contentType) || (!contentType && /<(?:!doctype html|html|head|body)[\s>]/i.test(text));

// A short page with no car on it whose words are a bot check's.
const isBotCheck = (parsed) => !parsed.vehicles.length && parsed.facts.text.length < 3000 && BOT_CHECK.test(parsed.facts.title + ' ' + parsed.facts.text);

// 503 is how an overloaded website answers, and the status some firewalls
// give their "checking your browser" page: either way the scan stops. Any
// other error page is read for a bot check too, since a firewall may send
// one with a 5xx of its own. A 404 or 410 page is not: it is the car's page
// gone, and a lead form's captcha notice on it must not stop every scan.
function judge(answer, origin) {
  if (!answer || answer.failed !== undefined) return { kind: 'error', message: (answer && answer.failed) || 'no answer' };
  const status = Number(answer.status) || 0;
  if (status === 403 || status === 429 || status === 503) return { kind: 'blocked', status, message: STOPPED[status] };
  if (status === 404 || status === 410) return { kind: 'gone', status };
  if (!answer.ok) {
    const text = String(answer.text || '');
    if (isHtmlAnswer(String(answer.contentType || ''), text) && isBotCheck(parseVehiclePage(text, String(answer.finalUrl || '')))) return { kind: 'blocked', status, message: STOPPED.check };
    return { kind: 'error', status, message: `HTTP ${status || 'error'}` };
  }
  if (!onSite(String(answer.finalUrl || ''), null, origin)) return { kind: 'error', status, message: 'it sent Lot Current to another website' };
  return { kind: 'page', status, finalUrl: answer.finalUrl, redirected: Boolean(answer.redirected), contentType: String(answer.contentType || ''), text: String(answer.text || '') };
}

// A document, an image or a download by its content type (a window
// sticker's PDF): not a web page, and not a page that failed either. Plain
// text, JSON and an answer without a type are not files: a car page that
// answers with one is a page that failed.
const isFileType = (contentType) => /^\s*(?:application\/(?:pdf|octet-stream|zip|msword|vnd\.)|image\/|video\/|audio\/|font\/)/i.test(String(contentType || ''));

// A page's cars and facts, read once however many times it is asked for.
// A bot check reads as a stop; anything that isn't a web page as an error
// (file: true when it is a file, isFileType).
// Its text is cut into cards by car with what the scan knows of this
// website's car pages by then (carKeys, siteReader's cars), and with the
// car the caller reads it for (vin: its own page's car, whatever address
// its markup gives), so it is read once for each car asked about.
function pageOf(outcome, vin = '') {
  if (outcome.kind !== 'page') return outcome;
  if (!isHtmlAnswer(outcome.contentType, outcome.text)) {
    if (!outcome.read) outcome.read = { kind: 'error', message: `not a web page (${outcome.contentType || 'no type'})`, file: isFileType(outcome.contentType) };
    return outcome.read;
  }
  if (!outcome.reads) outcome.reads = new Map();
  const forCar = typeof vin === 'string' ? vin.toUpperCase() : '';
  if (!outcome.reads.has(forCar)) {
    const parsed = parseVehiclePage(outcome.text, outcome.finalUrl, { carKey: carKeys(outcome.finalUrl, outcome.cars, forCar) });
    outcome.reads.set(forCar, isBotCheck(parsed) ? { kind: 'blocked', message: STOPPED.check } : { kind: 'html', parsed, truncated: outcome.text.length >= PAGE_TEXT_LIMIT });
  }
  return outcome.reads.get(forCar);
}

// Every page read once per scan: the requests are counted, and a page asked
// for twice (a missing car's page this scan already read) is not fetched again.
// `cars` is what the scan has learned of this website's car pages once it
// has read the list (scan step 2): known, each car page's key -> its car,
// and shape, the shape of their addresses. A page read after that is cut
// into cards with it (pageOf).
function siteReader(search, origin) {
  const answers = new Map();
  const reader = {
    requests: 0,
    cars: { known: null, shape: null },
    async read(href) {
      const key = pageKey(href);
      if (answers.has(key)) return answers.get(key);
      reader.requests += 1;
      let answer;
      try {
        answer = await search({ url: href });
      } catch (e) {
        answer = { failed: String((e && e.message) || e) };
      }
      const outcome = judge(answer, origin);
      if (outcome.kind === 'page') outcome.cars = reader.cars;
      answers.set(key, outcome);
      return outcome;
    },
  };
  return reader;
}

// Work through a list two at a time, in order; work returns false to stop.
async function twoAtATime(items, work) {
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < items.length) {
      const item = items[next];
      next += 1;
      if ((await work(item)) === false) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

// Which car a link on a page goes to, for the cards schemaOrgParse.js cuts
// the page's text into (a car's tile in a "similar vehicles" carousel, its
// card on a list): all of a card's links to one car make one card, and a
// link to anything else (a contact form, financing, a search) shapes none.
// A link goes to a car when its address carries one VIN (that car: a
// "Check availability" form with the VIN in its query goes with the car's
// page; an address with several VINs, a comparison, is none of them); when
// this page's markup names a car at that address (by its VIN, else by the
// address); when the scan's list named it as a car page (cars.known); when
// it is one of those addresses with a query added ("?srp=1", "?print=1"),
// for a car whose own address has no query, so a lot whose car pages differ
// only by their query is never read as one car; or when it reads like a car
// page, new or used (readsLikeAnyCar). On one car's own page (the car the
// page is read for, `vin`, else the car its markup puts at this address),
// such an address that names no car but that one (namesOnlyThisCar: "See
// all 2016 Honda Civic", "Shop new 2027 Honda Civic", another address of
// this same car) goes to no car, so the car's own price box is not cut out;
// any other one is another car's, so its tile does not pass for this car's
// text, whether or not this website's car addresses carry their VIN. On a
// page that is no one car's own (a list), a VIN-less address that reads
// like a car page goes to a car only when it has the shape of this lot's
// car addresses (cars.shape, the addresses the list linked to, else those
// of the cars this page's markup names): a card's "More like this" search
// ("/used-vehicles/2016-honda-civic/") does not split it, and on a lot
// whose car addresses carry their VIN no VIN-less one is a car. Without a
// shape it is a car unless this page's own address carries a VIN. Keys:
// "vin:" and the VIN, else the page's key.
function carKeys(pageUrl, cars, vin = '') {
  const known = cars && cars.known instanceof Map ? cars.known : null;
  return (vehicles) => {
    const origin = originOf(pageUrl);
    const nodes = Array.isArray(vehicles) ? vehicles : [];
    const named = new Map();
    for (const node of nodes) {
      const at = onSite(firstText(node && node.url), pageUrl, origin);
      const key = at ? pageKey(at.href) : '';
      const vin = nodeVin(node);
      if (key && !named.has(key)) named.set(key, vin ? 'vin:' + vin : key);
    }
    const shape = (cars && cars.shape) || learnCarAddressShape([...named.keys()]);
    const vinPages = shape ? shape.vin : Boolean(vinInAddress(pageUrl));
    const own = (vin && nodes.find((n) => nodeVin(n) === vin)) || ownNode(nodes, pageUrl);
    const ownCar = own ? normalizeVehicle(own, { url: pageUrl }) : null;
    const carOf = (href) => {
      const vins = vinsInAddress(href);
      if (vins.length) return vins.length === 1 ? 'vin:' + vins[0] : null;
      const key = pageKey(href);
      if (!key) return null;
      if (named.has(key)) return named.get(key);
      if (known && known.has(key)) return known.get(key);
      const plain = queryless(href);
      if (plain && plain !== key) {
        if (named.has(plain)) return named.get(plain);
        if (known && known.has(plain)) return known.get(plain);
      }
      if (!readsLikeAnyCar(href)) return null;
      if (own) return namesOnlyThisCar(href, ownCar) ? null : key;
      if (shape) return matchesCarAddressShape(href, shape) ? key : null;
      return vinPages ? null : key;
    };
    const seen = new Map(); // a page links to one car many times
    const carFor = (href) => {
      if (seen.has(href)) return seen.get(href);
      const car = carOf(href);
      if (seen.size < 100000) seen.set(href, car);
      return car;
    };
    // the page's own car, so a link to it is never counted as another car's (schemaOrgParse.js visibleText)
    carFor.own = own ? 'vin:' + nodeVin(own) : null;
    return carFor;
  };
}

// Does an address name no car but this one? Every word of it is one of this
// car's own (its make, or the short name people use for it, its model,
// trim, body style, drive or stock number, also run together: "f150" for an
// F-150, "crv" for a CR-V), a model year, or a word of the website's
// inventory and search pages ("used", "vehicles", "shop", "sedan", "awd").
// So "See all 2016 Honda Civic", "Shop new 2027 Honda Civic", a breadcrumb
// to "2016 Chevy" and another address of this same car ("/used/2016-honda-
// civic-sm1000/") name only this car, and an address with any other word
// ("/used/2017-toyota-camry-sm1001/", "/used/2016-honda-civic-sm1001/")
// names another. Two cars of one model whose addresses carry no stock
// number or other word of their own can't be told apart this way.
const wordsOf = (value) => String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const MAKE_NAMES = new Map([['chevrolet', ['chevy']], ['volkswagen', ['vw']], ['mercedesbenz', ['mb']]]);
const SEARCH_WORDS = new Set([
  'used', 'new', 'pre', 'owned', 'preowned', 'certified', 'cpo', 'inventory', 'vehicle', 'vehicles', 'car', 'cars', 'auto', 'autos', 'truck', 'trucks', 'suv', 'suvs', 'van', 'vans',
  'for', 'sale', 'forsale', 'search', 'all', 'shop', 'browse', 'view', 'see', 'more', 'similar', 'like', 'results', 'listing', 'listings', 'srp', 'vdp', 'detail', 'details', 'stock',
  'make', 'makes', 'model', 'models', 'year', 'years', 'trim', 'trims', 'body', 'type', 'style', 'condition', 'en', 'es', 'index', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp',
  'sedan', 'sedans', 'coupe', 'coupes', 'hatchback', 'hatchbacks', 'hatch', 'wagon', 'wagons', 'convertible', 'convertibles', 'crossover', 'crossovers', 'minivan', 'minivans', 'pickup', 'pickups',
  'cab', 'crew', 'crewcab', 'extended', 'double', 'quad', 'supercrew', 'supercab', 'crewmax', 'door', 'doors', '2dr', '4dr', 'awd', 'fwd', 'rwd', '4wd', '2wd', '4x4', '4x2',
]);
const MODEL_YEAR_WORD = /^(?:19[5-9][0-9]|20[0-9][0-9])$/;
function namesOnlyThisCar(href, car) {
  if (!car) return false;
  const mine = new Set();
  for (const value of [car.make, car.model, car.trim, car.bodyType, car.drivetrain, car.stock]) {
    const w = wordsOf(value);
    for (const x of w) mine.add(x);
    if (w.length > 1) mine.add(w.join(''));
  }
  for (const short of MAKE_NAMES.get(wordsOf(car.make).join('')) || []) mine.add(short);
  const words = wordsOf(addressText(href));
  for (let i = 0; i < words.length;) {
    let step = 0;
    // the longest run of words from here that is one word of this car's ("f-150"), else one word the address may hold anyway
    for (let j = Math.min(words.length, i + 4); j > i && !step; j -= 1) if (mine.has(words.slice(i, j).join(''))) step = j - i;
    if (!step && (SEARCH_WORDS.has(words[i]) || MODEL_YEAR_WORD.test(words[i]))) step = 1;
    if (!step) return false;
    i += step;
  }
  return true;
}

// The car whose own page this is, from its markup: the node with a VIN at
// this page's address (or at it without the query the page was read with),
// else the one node with a VIN and no address of its own; null on a list.
function ownNode(nodes, pageUrl) {
  const here = pageKey(pageUrl);
  const plain = queryless(pageUrl);
  const origin = originOf(pageUrl);
  const withVin = nodes.filter((n) => nodeVin(n));
  const at = (n) => onSite(firstText(n.url), pageUrl, origin);
  const own = withVin.find((n) => at(n) && pageKey(at(n).href) === here)
    || withVin.find((n) => at(n) && !at(n).search && pageKey(at(n).href) === plain);
  if (own) return own;
  const bare = withVin.filter((n) => !firstText(n.url));
  return bare.length === 1 ? bare[0] : null;
}

// What normalize needs from a page besides the car's node, with the text
// its price and mileage are checked against cut down to this car's own
// (schemaOrgParse.js visibleText gives the page's text in segments, each
// tied to the car whose card holds it, as carKeys names cars). On the car's
// own page: the page without other cars' cards, so a "similar vehicles"
// tile at the price this car's markup still carries does not pass for this
// car's price. For a car read from a list (list: true): its own card; a car
// without one has no text, so the list's data shows no price and its own
// page is read instead. A card is this car's when its car is this VIN or
// one of this car's addresses. On a list, the text a card's tile was cut
// from (a segment near this car: on a car's page, the page's own) is this
// car's too.
function factsForCar(facts, { urls = [], vin = '', list = false } = {}) {
  const out = { title: facts.title, text: facts.text, carfaxLinks: facts.carfaxLinks };
  if (!Array.isArray(facts.segments)) return out;
  const own = new Set(urls.filter((u) => typeof u === 'string' && u).map(pageKey).filter(Boolean));
  if (vin) own.add('vin:' + vin);
  const kept = list ? facts.segments.filter((g) => (g.car !== null && own.has(g.car)) || (g.near !== undefined && own.has(g.near))) : facts.segments.filter((g) => g.car === null || own.has(g.car));
  out.text = kept.map((g) => g.text).join(' ');
  return out;
}

// The car a page is about. With its VIN known, only the node with that VIN
// (a carousel of other cars never stands in for it). Without, the node whose
// address is this page, else the one VIN node without an address of its own.
function carOnPage(nodes, { vin, pageUrl }) {
  if (vin) return nodes.find((n) => nodeVin(n) === vin) || null;
  const withVin = nodes.filter((n) => nodeVin(n));
  const here = pageKey(pageUrl);
  const own = withVin.find((n) => firstText(n.url) && pageKey(new URL(firstText(n.url), pageUrl).href) === here);
  if (own) return own;
  const bare = withVin.filter((n) => !firstText(n.url));
  return bare.length === 1 ? bare[0] : null;
}

// A car read from the list's data rather than from its own page.
function listRecord(listed, carUrl, carried) {
  const record = { node: { ...listed.node, url: carUrl }, url: listed.page, facts: factsForCar(listed.facts, { urls: [carUrl, (onSite(firstText(listed.node.url), listed.page, originOf(listed.page)) || {}).href], vin: nodeVin(listed.node), list: true }) };
  if (carried) record.carried = true;
  return record;
}

const same = (a, b) => (a ?? null) === (b ?? null);

// Does the list's data for a car say exactly what the last read of its own
// page recorded (src/rescan.js snapshotEntry), and would the pre-owned check
// decide the same on it? Only then is the car's page not read again.
function agreesWithLastRead(v, entry) {
  if (!v || !entry || v.price === null) return false;
  for (const [now, then] of [[v.price, entry.price], [v.name, entry.name], [v.stock, entry.stock], [v.inventoryType, entry.type], [v.mileage, entry.mileage], [v.location, entry.location], [v.status, entry.status], [v.statusLabel, entry.statusLabel], [v.availability, entry.availability]]) {
    if (!same(now, then)) return false;
  }
  if (Boolean(v.carfaxUrl) !== Boolean(entry.carfax) || Boolean(v.photoCount) !== Boolean(entry.photoCount)) return false;
  const pre = checkPreOwned(v);
  const passed = entry.decision === DECISION.READY || entry.decision === DECISION.NOT_READY;
  if (passed !== (pre.verdict === 'pre-owned')) return false;
  return entry.decision === DECISION.NOT_READY || pre.reason === entry.reason;
}

// The list's own count of its cars (an ItemList's numberOfItems), or 0.
function listedCount(html) {
  let most = 0;
  const visit = (x, depth) => {
    if (!x || typeof x !== 'object' || depth > 6) return;
    if (Array.isArray(x)) {
      for (const y of x) visit(y, depth + 1);
      return;
    }
    const n = Number(x.numberOfItems);
    if ([].concat(x['@type'] || []).some((t) => /ItemList$/.test(String(t))) && Number.isFinite(n)) most = Math.max(most, n);
    if (x['@graph']) visit(x['@graph'], depth + 1);
    if (x.mainEntity) visit(x.mainEntity, depth + 1);
  };
  visit(extractJsonLd(html), 0);
  return most;
}

// ---------- the sitemap ----------

// The car pages the sitemaps named in robots.txt list, kept only when they
// have the shape of this lot's own car addresses (learnCarAddressShape): a
// sitemap also lists new cars, articles and every other page.
async function sitemapAddresses(site, origin, shape) {
  const found = [];
  if (!shape) return { found, clean: false };
  const robots = await site.read(origin + '/robots.txt');
  if (robots.kind === 'blocked') return { stopped: robots.message };
  if (robots.kind === 'gone') return { found, clean: true }; // no robots.txt, so no sitemap is named
  if (robots.kind !== 'page') return { found, clean: false };
  const queue = [];
  // spaces and tabs only around the words: a whitespace class that also
  // takes line breaks makes a long run of blank lines take quadratic time
  for (const m of robots.text.slice(0, ROBOTS_TEXT_LIMIT).matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)/gim)) {
    const u = onSite(m[1], origin, origin);
    if (u && !queue.includes(u.href)) queue.push(u.href);
  }
  let clean = true;
  const done = new Set();
  while (queue.length && done.size < MAX_SITEMAPS) {
    const at = queue.shift();
    if (done.has(at)) continue;
    done.add(at);
    const got = await site.read(at);
    if (got.kind === 'blocked') return { stopped: got.message };
    if (got.kind !== 'page' || !/<(?:urlset|sitemapindex)[\s>]/i.test(got.text)) {
      clean = false; // gone, broken, compressed or not a sitemap
      continue;
    }
    const locs = [...got.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
    if (/<sitemapindex[\s>]/i.test(got.text)) {
      // sitemaps whose address names the inventory first
      const children = locs.map((loc) => onSite(loc, null, origin)).filter(Boolean).map((u) => u.href);
      const first = (href) => (/inventor|vehicle|used|pre-?owned|cars?\b/i.test(href) ? 0 : 1);
      queue.push(...children.sort((a, b) => first(a) - first(b)));
      continue;
    }
    for (const loc of locs) {
      if (found.length >= MAX_SITEMAP_ADDRESSES) {
        clean = false;
        break;
      }
      const u = onSite(loc, null, origin);
      if (u && matchesCarAddressShape(u.href, shape)) found.push(u.href);
    }
  }
  return { found, clean: clean && !queue.length };
}

// ---------- confirming a missing car ----------

// A car from the last scan that this scan did not find, checked at the page
// it was last seen on. Gone when that page says so: 404 or 410, or the car's
// node marked SoldOut. A refusal (403, 429, 503, a bot check) stops the
// whole check, and the rescan then marks nothing gone (refused). Anything
// else that isn't the car's page (5xx, a timeout, a file that isn't a web
// page, a page with no structured data at all, an answer from another
// website) leaves this car unchecked, with the reason, and the other
// missing cars are still checked: one car's broken page must not hold back
// every other car's verdict, scan after scan. A redirect to a page without a
// node for this VIN, or the page itself with the website's own structured
// data and no node for this VIN (a "no longer available" page, or one that
// shows only other cars) is "unsure": it counts as gone only once this
// website's car pages are known to carry their own car's VIN
// (confirmMissing). Until then it proves nothing, since a car page that
// marks up only a "similar vehicles" carousel looks the same while its car
// is still for sale.
function pageProblem(message) {
  const m = String(message || 'no answer');
  if (/^HTTP\b/.test(m)) return `its page gave ${m}`;
  if (/^it sent Lot Current to another website/.test(m)) return 'its page sent Lot Current to another website';
  if (/^not a web page/.test(m)) return `its page is ${m}`;
  return `its page could not be read (${m})`;
}
async function confirmOne(site, vin, href) {
  const got = await site.read(href);
  const page = pageOf(got, vin);
  if (page.kind === 'gone') return { gone: true };
  if (page.kind === 'blocked') return { refused: page.message.replace(/, so the scan stopped.*$/, '') };
  if (page.kind === 'error') return { unchecked: pageProblem(page.message) };
  const node = page.parsed.vehicles.find((n) => nodeVin(n) === vin);
  if (node) return soldOut(node) ? { gone: true } : { found: { node, url: got.finalUrl, facts: factsForCar(page.parsed.facts, { urls: [got.finalUrl, href], vin }) } };
  if (got.redirected && pathKey(got.finalUrl) !== pathKey(href)) return { unsure: true };
  if (page.parsed.vehicles.length || hasStructuredData(got.text)) return { unsure: true };
  return { unchecked: 'its page has no vehicle data to check against' };
}

// Does a page carry any schema.org data of the website's own (a JSON-LD
// block or a microdata item)? A bot check or a bare error page carries none.
function hasStructuredData(html) {
  return extractJsonLd(html).length > 0 || /\bitemtype\s*=\s*["']?https?:\/\/schema\.org\//i.test(html);
}

// confirm: { checked, notFound, error }, plus unchecked ({ vin: reason })
// when a missing car's own check failed without stopping the others
// (confirmOne). error is set only when the website refused (a 403, 429,
// 503 or bot check, on a car's page or on the sample page): then nothing is
// recorded and the rescan marks nothing gone. The cars the last snapshot
// still listed are checked first, then those missing for longer (a posted
// car kept in missingPages), so a long-broken page does not go first.
async function confirmMissing(site, { vins, urls, records, origin, evidence, samples, lastSeen = {} }) {
  const confirm = { checked: [], notFound: [], error: null };
  const unchecked = {};
  const wanted = [...new Set((Array.isArray(vins) ? vins : []).map((v) => String(v || '').toUpperCase()).filter(Boolean))].filter((v) => !records.has(v));
  // a car with no known page on this website can't be checked: it stays "missing, not confirmed gone"
  const items = [];
  for (const vin of wanted) {
    const at = urls && typeof urls[vin] === 'string' ? onSite(urls[vin], null, origin) : null;
    if (at) items.push({ vin, href: at.href, verdict: null });
  }
  items.sort((a, b) => Number(Boolean(lastSeen[b.vin])) - Number(Boolean(lastSeen[a.vin])));
  let failedInARow = 0;
  await twoAtATime(items, async (item) => {
    if (confirm.error) return false;
    if (failedInARow >= MAX_FAILED_IN_A_ROW) {
      // a failing website is not asked for page after page: the rest wait for the next scan
      item.verdict = { unchecked: `not checked this time: the website's car pages failed ${failedInARow} times in a row` };
      return true;
    }
    item.verdict = await confirmOne(site, item.vin, item.href);
    if (item.verdict.refused) {
      confirm.error = item.verdict.refused;
      return false;
    }
    failedInARow = item.verdict.unchecked ? failedInARow + 1 : 0;
    return true;
  });
  if (!confirm.error && items.some((i) => i.verdict && i.verdict.unsure) && !evidence.ownNode) {
    // Does this website's car page carry its car's data? One car still on the list says.
    const sample = samples.find(Boolean);
    const got = sample ? pageOf(await site.read(sample.href), sample.vin) : null;
    if (got && got.kind === 'html' && got.parsed.vehicles.some((n) => nodeVin(n) === sample.vin)) evidence.ownNode = true;
    else if (got && got.kind === 'blocked') confirm.error = got.message.replace(/, so the scan stopped.*$/, '');
    else {
      // without that, a page that doesn't show the car proves nothing: only those cars stay unchecked
      const why = got && got.kind !== 'html' ? `a car page used for comparison gave ${got.message || 'no answer'}` : "this website's car pages don't mark up their own car, which leaves nothing to check against";
      for (const item of items) if (item.verdict && item.verdict.unsure) item.verdict = { unchecked: why };
    }
  }
  if (confirm.error) return confirm;
  for (const item of items) {
    if (!item.verdict) continue;
    if (item.verdict.unchecked) {
      unchecked[item.vin] = item.verdict.unchecked;
      continue;
    }
    if (item.verdict.found) records.set(item.vin, item.verdict.found);
    confirm.checked.push(item.vin);
    if (item.verdict.gone || item.verdict.unsure) confirm.notFound.push(item.vin);
  }
  if (Object.keys(unchecked).length) confirm.unchecked = unchecked;
  return confirm;
}

// ---------- the list's first page ----------

// A list opened past its first page (page 2 of the used list, or a service
// a probe stored from such a page) starts there, and rel=next only goes
// forward: the list's first page is found by following its rel=prev links
// back to a page without one. Those pages are read once (siteReader), and
// the forward read takes them again from there. clean is false when the way
// back could not be followed to its end (a page that failed, an address off
// the website, a loop, more pages than the list may have): the read then
// starts at the earliest page reached, and the scan says it is not complete.
// A way back that comes round to the page it started from is a list whose
// first page points to its last: the read starts where it was asked to, and
// walked (every page the way back read) lets the scan say it is not
// complete unless its forward read reaches each of them too.
async function firstListPage(site, startHref, origin, maxPages) {
  const seen = new Set();
  let reached = startHref; // the earliest page that read
  for (let at = startHref, n = 0; ; n += 1) {
    seen.add(pageKey(at));
    const page = pageOf(await site.read(at));
    if (page.kind === 'blocked') return { stopped: page.message };
    if (page.kind !== 'html') return { href: reached, clean: n === 0 }; // a failing start page: the forward read says so
    reached = at;
    const prevHref = page.parsed.facts.prev;
    if (!prevHref) return { href: at, clean: true };
    const prev = onSite(prevHref, null, origin);
    if (prev && pageKey(prev.href) === pageKey(at)) return { href: at, clean: true }; // a page that names itself as the one before
    if (prev && n > 0 && pageKey(prev.href) === pageKey(startHref)) return { href: startHref, clean: true, walked: seen };
    if (!prev || seen.has(pageKey(prev.href)) || n + 1 >= maxPages) return { href: at, clean: false };
    at = prev.href;
  }
}

// ---------- scan ----------

/**
 * Reads the lot: the used inventory page (options.listUrl) and its rel=next
 * pages, the sitemap when asked for (options.sitemap true) or when the list's
 * own count says it links fewer cars than it holds, then each car's page.
 * The first scan reads every car's page. Later scans (options.lastSeen, the
 * last snapshot's entries) read a car's page only when it is new, posted
 * (options.postedVins), has no price in the list's data, or the list's data
 * no longer agrees with what its page said last time; the rest are taken
 * from the list's data (records marked carried). At most options.maxCarPages
 * car pages are read: posted cars first, then the pages read longest ago
 * (lastSeen entries' pageReadAt; never read counts as oldest). Cars from the
 * last scan that didn't come back are checked at their last page
 * (options.confirmVins with options.confirmUrls).
 * @returns the contract's shape. total is the number of car addresses found;
 *   complete means the list ended cleanly and every page to read was read.
 *   records are { node, url, facts, carried? }. Only when there are some:
 *   pagesRead lists the VINs of the cars whose own page this scan read
 *   (scanRunner stamps their snapshot entries with pageReadAt);
 *   descriptionsUnread the VINs of the carried records, whose description
 *   this scan did not read (scanRunner keeps the lot-wide lines); unread the
 *   VINs of cars still on the list whose page was read before but not this
 *   time; leftForLater the number of car pages the page limit left for the
 *   next scan.
 */
export async function scan(search, options = {}) {
  const opts = { listUrl: null, origin: null, confirmVins: [], confirmUrls: {}, postedVins: [], lastSeen: null, sitemap: undefined, maxListPages: MAX_LIST_PAGES, maxCarPages: MAX_CAR_PAGES, ...options };
  const origin = originOf(opts.origin) || originOf(opts.listUrl);
  const site = siteReader(search, origin);
  const fail = (error, message) => ({ ok: false, error, message, requests: site.requests });
  const start = onSite(opts.listUrl, null, origin);
  if (!start) return fail('no-list', "Lot Current doesn't know this website's used inventory page yet. Open that page and click Scan website there.");

  // 1. the list from its first page, and its rel=next pages
  const first = await firstListPage(site, start.href, origin, opts.maxListPages);
  if (first.stopped) return fail('blocked', first.stopped);
  const visited = new Set();
  const byKey = new Map(); // car page key -> the list's data for it
  const byVin = new Map();
  const strong = new Map(); // car pages the list names by its data or with a VIN in the address
  const weak = new Map(); // links that only read like car pages
  let listClean = first.clean;
  let listed = 0;
  let firstList = null;
  for (let at = first.href, n = 0; ; n += 1) {
    if (n >= opts.maxListPages) {
      listClean = false;
      break;
    }
    visited.add(pageKey(at));
    const got = await site.read(at);
    const page = pageOf(got);
    if (page.kind === 'blocked') return fail('blocked', page.message);
    if (page.kind !== 'html') {
      if (n === 0) return fail('list-failed', `Couldn't read the inventory page (${page.kind === 'gone' ? `HTTP ${page.status}` : page.message}).`);
      listClean = false;
      break;
    }
    if (!firstList) firstList = got.finalUrl;
    if (page.truncated) listClean = false;
    listed = Math.max(listed, listedCount(got.text));
    for (const node of page.parsed.vehicles) {
      const vin = nodeVin(node);
      const carAt = onSite(firstText(node.url), got.finalUrl, origin);
      const listedCar = { node, vin, page: got.finalUrl, facts: page.parsed.facts };
      if (vin && !byVin.has(vin)) byVin.set(vin, listedCar);
      if (carAt) {
        const key = pageKey(carAt.href);
        if (!byKey.has(key)) byKey.set(key, listedCar);
        if (!strong.has(key)) strong.set(key, carAt.href);
      }
    }
    for (const href of page.parsed.facts.links) {
      const key = pageKey(href);
      if (fileAddress(href)) continue; // a window sticker's PDF, a photo: not a car's page
      if (vinInAddress(href)) {
        if (!strong.has(key)) strong.set(key, href);
      } else if (looksLikeCarAddress(href) && !weak.has(key)) weak.set(key, href);
    }
    const next = page.parsed.facts.next ? onSite(page.parsed.facts.next, null, origin) : null;
    if (!page.parsed.facts.next) break;
    if (!next || visited.has(pageKey(next.href))) {
      listClean = false; // off the website, or back to a page already read
      break;
    }
    at = next.href;
  }
  // a list that goes round: complete only when the forward read reached every page the way back did
  if (first.walked) for (const key of first.walked) if (!visited.has(key)) listClean = false;

  // 2. the car pages: the strong ones, and links that only read like car
  // pages when they have the shape of the strong ones
  const lastSeen = opts.lastSeen && typeof opts.lastSeen === 'object' ? opts.lastSeen : {};
  const named = new Map(); // car page key -> the VIN the list's data gives it
  for (const [key, listedCar] of byKey) if (listedCar.vin) named.set(key, listedCar.vin);
  const cars = new Map();
  const alternates = new Map(); // a car's kept page key -> its other addresses, best first (oneAddressPerCar)
  for (const [key, href] of strong) if (!visited.has(key)) cars.set(key, href);
  oneAddressPerCar(cars, { named, lastSeen, alternates });
  // with fewer than two strong ones there is no shape to hold the others to,
  // and every one is taken (counted before any is, so all of them are)
  const fewStrong = cars.size < 2;
  const strongShape = fewStrong ? null : learnCarAddressShape([...cars.values()]);
  let shapeLeftOut = 0; // links that read like car pages, left out for not having the shape of the others
  for (const [key, href] of weak) {
    if (visited.has(key) || cars.has(key)) continue;
    if (fewStrong || matchesCarAddressShape(href, strongShape)) cars.set(key, href);
    else shapeLeftOut += 1;
  }

  let sitemapClean = true;
  if (opts.sitemap === true || (opts.sitemap !== false && listed > cars.size)) {
    const r = await sitemapAddresses(site, origin, learnCarAddressShape([...cars.values()]));
    if (r.stopped) return fail('blocked', r.stopped);
    sitemapClean = r.clean;
    for (const href of r.found) {
      const key = pageKey(href);
      if (!visited.has(key) && !cars.has(key)) cars.set(key, href);
    }
    oneAddressPerCar(cars, { named, lastSeen, alternates });
  }
  // what a car page read from here on knows of the others (carKeys)
  const knownCars = new Map();
  for (const [key, href] of cars) {
    const listedCar = byKey.get(key);
    const vin = (listedCar && listedCar.vin) || vinInAddress(href);
    knownCars.set(key, vin ? 'vin:' + vin : key);
  }
  site.cars.known = knownCars;
  site.cars.shape = learnCarAddressShape([...cars.values()]);
  if (!cars.size) {
    return fail('no-cars', `Lot Current found no links to car pages on the inventory page (${firstList}). A page that draws its list with scripts shows none to Lot Current's plain read of it.`);
  }

  // 3. which car pages to read
  const firstScan = Object.keys(lastSeen).length === 0;
  const posted = new Set((Array.isArray(opts.postedVins) ? opts.postedVins : []).map((v) => String(v || '').toUpperCase()));
  const plan = [];
  for (const [key, href] of cars) {
    const listedCar = byKey.get(key) || byVin.get(vinInAddress(href)) || null;
    const vin = (listedCar && listedCar.vin) || vinInAddress(href);
    const entry = vin ? lastSeen[vin] : null;
    // named: the list's own data names this address as the car's, so no other address is tried
    const item = { key, href, vin, listedCar, record: null, named: named.has(key), lastPage: Boolean(entry && pageKey(entry.url) === key), others: alternates.get(key) || [] };
    if (!firstScan && entry && listedCar && listedCar.vin && !posted.has(vin) && pageKey(entry.url) === key) {
      const record = listRecord(listedCar, href, true);
      if (agreesWithLastRead(normalize(record), entry)) item.record = record;
    }
    plan.push(item);
  }
  // Posted cars first: their listings must match the website. Then the
  // page read longest ago, a car never read from its own page first, so on
  // a lot larger than the page limit every car's page comes round in turn
  // instead of the same cars being skipped on every scan. (sort is stable:
  // otherwise the list's order.)
  const readAt = (i) => {
    const at = i.vin && lastSeen[i.vin] ? lastSeen[i.vin].pageReadAt : '';
    return typeof at === 'string' ? at : '';
  };
  const toRead = plan.filter((i) => !i.record).sort((a, b) => Number(posted.has(b.vin)) - Number(posted.has(a.vin)) || (readAt(a) < readAt(b) ? -1 : readAt(a) > readAt(b) ? 1 : 0));
  const reading = toRead.slice(0, Math.max(0, opts.maxCarPages));

  // A car the list still names whose own page was not read this time. When
  // its page was read before, that reading stands (unread: scanRunner.js
  // keeps its last snapshot entry): the list's data is often thinner than
  // the page (no price, no mileage), and a bad server day must not show a
  // car as having lost its price. Otherwise the list's data stands in, so
  // the car does not look missing.
  const unread = new Set();
  const standIn = (item) => {
    if (item.vin && lastSeen[item.vin]) unread.add(item.vin);
    else if (item.listedCar && item.listedCar.vin) item.record = listRecord(item.listedCar, item.href, true);
  };

  // 4. read them, two at a time; the first refusal stops everything, and so
  // do MAX_FAILED_IN_A_ROW failures in a row (a timeout, a reset, a 500).
  // A car with other addresses (oneAddressPerCar) whose kept one is not its
  // page (a form or a page without its node, a file, a 404, an error) is
  // read at the next, at most MAX_ADDRESSES_PER_CAR in all, unless the
  // list's own data or the last read of the car named the kept one. Which
  // kind of address (addressPattern) gives cars is learned as the scan goes,
  // from the last scan's pages first, and that kind is tried first; a kind
  // that twice gave no car and never one is tried last, and not at all for
  // a car once one of its addresses of a kind that gives cars was read and
  // was not its page (that page then answers for the car, as a car's only
  // address does). Until then every address is read: a run of first car
  // pages without vehicle data (cars in transit, a "no longer available"
  // page) makes the lot's own kind of car page look like a dead end too.
  // A page of a kind that has given cars that fails ends the car's turn;
  // any other link that fails is passed over for the car's next address, and
  // a car found at one of them is not a failure. Nor is a car whose page of
  // a kind that gives cars answered without it (a car in transit) or as gone
  // while its other link failed (a form that answers 500): that page answers
  // for it. Which kind gives cars is known only once one has, so a car read
  // before then, one link failing and another answering, is settled when the
  // reading is done and never counts towards MAX_FAILED_IN_A_ROW. A car none
  // of whose addresses gave it, one of them failing and none of a kind that
  // gives cars answering, keeps its last reading and makes the scan not
  // complete; while the reading goes on it counts towards MAX_FAILED_IN_A_ROW
  // unless another of its addresses answered. A car some of whose addresses
  // were left unread, none of the others its page, keeps its last reading
  // and makes the scan not complete.
  let stopped = null;
  let readErrors = 0;
  let failedInARow = 0;
  let notCarPages = 0;
  let untried = 0; // cars left with addresses not read, none of those read being their page
  let carsFound = 0; // cars found at their own page this scan
  let noneShown = 0; // cars whose pages read showed no car, and neither does the list's data
  const pagesRead = new Set();
  const evidence = { ownNode: false };
  const gave = new Map(); // address kind -> cars its pages gave
  const gaveNone = new Map(); // address kind -> pages of it that gave no car
  for (const entry of Object.values(lastSeen)) {
    const kind = entry && typeof entry.url === 'string' ? addressPattern(entry.url) : '';
    if (kind) gave.set(kind, (gave.get(kind) || 0) + 1);
  }
  const deadEnd = (href) => !gave.get(addressPattern(href)) && (gaveNone.get(addressPattern(href)) || 0) >= 2;
  const likely = (href) => (gave.get(addressPattern(href)) ? 0 : deadEnd(href) ? 2 : 1);
  const noCar = (href) => gaveNone.set(addressPattern(href), (gaveNone.get(addressPattern(href)) || 0) + 1);
  const gives = (href) => Boolean(href && gave.get(addressPattern(href)));
  // A car whose addresses were read, none of them its page: what that means
  // for the scan. during: while the reading goes on, when a run of failing
  // cars stops it; after it, a car is counted and nothing stops.
  const settle = (o, { during }) => {
    const { item } = o;
    if (o.error) {
      // the scan is not complete, and the car is still on the list
      readErrors += 1;
      standIn(item);
      if (!during) return true;
      failedInARow += 1;
      if (failedInARow >= MAX_FAILED_IN_A_ROW && !stopped) {
        stopped = { error: 'failing', message: `The website's car pages failed ${failedInARow} times in a row (the last: ${o.error.message}), so the scan stopped. Nothing was retried; try again later.` };
        return false;
      }
      return true;
    }
    if (during) failedInARow = 0;
    if (o.left) {
      // the addresses read were not its page and some were not read: not known this time
      untried += 1;
      standIn(item);
      return true;
    }
    if (o.goneAt) return true; // its page is gone: a car from the last scan is checked below
    if (o.html) {
      if (item.vin) pagesRead.add(item.vin);
      if (item.listedCar && item.listedCar.vin) item.record = listRecord(item.listedCar, item.href, true); // the page doesn't mark the car up; the list does
      else if (o.html.page.truncated) readErrors += 1;
      else noneShown += 1;
      return true;
    }
    if (o.files && !item.listedCar && !(item.vin && lastSeen[item.vin])) {
      // only files (a window sticker, a brochure) at addresses neither the
      // list's data nor the last scan knows a car by: links that are not a
      // car's page, so not a car and not the website failing
      notCarPages += 1;
      return true;
    }
    // a car the list or the last scan knows whose page is a file: not read this time
    readErrors += 1;
    standIn(item);
    return true;
  };
  // a failing link beside an address of the car's that answered: settled when the reading is done
  const doubtful = [];
  const answeredOwnKind = (o) => gives(o.html && o.html.href) || gives(o.goneAt);
  const addressesOf = (item) => {
    if (item.named || item.lastPage || !item.others.length) return [item.href];
    return [item.href, ...item.others].map((href, n) => ({ href, n })).sort((a, b) => likely(a.href) - likely(b.href) || a.n - b.n).map((a) => a.href);
  };
  await twoAtATime(reading, async (item) => {
    if (stopped) return false;
    let found = null; // { got, page, node, href }
    let html = null; // the first page that read but showed no node for this car
    let error = null; // the first page that failed
    let errorAt = ''; // its address
    let goneAt = ''; // the first address that answered 404 or 410
    let files = 0;
    let read = 0;
    let left = false;
    const readHere = []; // the addresses read for this car
    const ownKindRead = () => readHere.some((h) => gave.get(addressPattern(h)));
    const addresses = addressesOf(item);
    for (let n = 0; n < addresses.length && !found; n += 1) {
      const href = addresses[n];
      if (n > 0 && deadEnd(href) && ownKindRead()) continue;
      if (stopped) return false;
      if (read >= MAX_ADDRESSES_PER_CAR) {
        left = true;
        break;
      }
      read += 1;
      readHere.push(href);
      const got = await site.read(href);
      const page = pageOf(got, item.vin);
      if (page.kind === 'blocked') {
        stopped = { error: 'blocked', message: page.message };
        return false;
      }
      if (page.kind === 'gone') {
        if (!goneAt) goneAt = href;
      } else if (page.kind !== 'html') {
        if (page.file) {
          files += 1;
          noCar(href);
        } else {
          if (!error) {
            error = page;
            errorAt = href;
          }
          // the lot's own kind of car page failing is the website failing:
          // nothing more is asked about this car
          if (gave.get(addressPattern(href))) break;
          // any other link that fails (a finance form that sends Lot Current
          // to a lender's website, a report link, a 500 or JSON from a form)
          // may not be the car's page: its next address is read
          noCar(href);
        }
      } else {
        const node = carOnPage(page.parsed.vehicles, { vin: item.vin, pageUrl: got.finalUrl });
        if (node && nodeVin(node)) {
          found = { got, page, node, href };
          const kind = addressPattern(href);
          gave.set(kind, (gave.get(kind) || 0) + 1);
        } else {
          if (!html) html = { page, href };
          noCar(href);
        }
      }
    }
    if (found) {
      failedInARow = 0;
      carsFound += 1;
      if (item.vin) pagesRead.add(item.vin);
      evidence.ownNode = true;
      item.href = found.href;
      item.record = { node: found.node, url: found.got.finalUrl, facts: factsForCar(found.page.parsed.facts, { urls: [found.got.finalUrl, found.href], vin: nodeVin(found.node) }) };
      return true;
    }
    const o = { item, html, error, goneAt, files, left };
    if (error && (html || goneAt) && !gives(errorAt)) {
      // a link that failed, of a kind that has given no car, beside an
      // address of the car's that answered: when that one is of a kind that
      // gives cars it is the car's page and answers for it; until a kind has
      // given cars, which was the car's page is not known yet
      if (!answeredOwnKind(o)) {
        doubtful.push({ ...o, errorAt });
        return true;
      }
      o.error = null;
    }
    return settle(o, { during: true });
  });
  if (stopped) return fail(stopped.error, stopped.message);
  // the cars whose failing link and answering page were read before the
  // kind of page that gives cars was known: the answering page is the car's
  // when it is of that kind and the failing link is not; else the car was
  // not read this time
  for (const o of doubtful) settle(!gives(o.errorAt) && answeredOwnKind(o) ? { ...o, error: null } : o, { during: false });
  // pages the limit left for the next scan: the same stand-ins
  const leftForLater = toRead.length - reading.length;
  for (const item of toRead.slice(reading.length)) standIn(item);

  const records = new Map();
  for (const item of plan) {
    const vin = item.record && nodeVin(item.record.node);
    if (vin && !records.has(vin)) records.set(vin, item.record);
  }

  // 5. cars from the last scan that did not come back
  const samples = plan.filter((i) => i.record && i.record.carried).map((i) => ({ href: i.href, vin: nodeVin(i.record.node) }));
  for (const vin of records.keys()) unread.delete(vin);
  const confirm = await confirmMissing(site, { vins: (Array.isArray(opts.confirmVins) ? opts.confirmVins : []).filter((v) => !unread.has(String(v || '').toUpperCase())), urls: opts.confirmUrls, records, origin, evidence, samples, lastSeen });

  // a missing car found at its last page was read from that page too
  for (const vin of confirm.checked) if (!confirm.notFound.includes(vin)) pagesRead.add(vin);

  // Files with a VIN in their address that are no car's page leave the
  // learned shape of this lot's car addresses in doubt, so a link that read
  // like a car page but was left out for not having that shape may be one.
  // So do links with a VIN none of which gave a car, only web pages without
  // one (forms that carry the VIN where the car pages don't).
  const shapeInDoubt = shapeLeftOut > 0 && (notCarPages > 0 || (carsFound === 0 && noneShown > 0));
  const total = cars.size - notCarPages;
  // a lot that counted cars and gave none is never a complete read of it
  const complete = listClean && sitemapClean && readErrors === 0 && untried === 0 && leftForLater === 0 && !shapeInDoubt && !(total > 0 && records.size === 0);
  const out = { ok: true, fetchedAt: new Date().toISOString(), total, complete, requests: site.requests, records: [...records.values()], confirm };
  if (unread.size) out.unread = [...unread];
  const readCars = [...pagesRead].filter((vin) => records.has(vin));
  if (readCars.length) out.pagesRead = readCars;
  const notDescribed = [...records].filter(([, r]) => r.carried).map(([vin]) => vin);
  if (notDescribed.length) out.descriptionsUnread = notDescribed;
  if (leftForLater) out.leftForLater = leftForLater;
  return out;
}

// A record -> the flat vehicle (schemaOrgNormalize.js). A car this scan took
// from the list's data without reading its page has no description this
// time: descriptionRaw is null, the scan lists it in descriptionsUnread, and
// scanRunner.js keeps the lot's boilerplate from the pages read before.
export function normalize(record) {
  if (!record || typeof record !== 'object' || !record.node || typeof record.node !== 'object') return null;
  const v = normalizeVehicle(record.node, { url: record.url, facts: record.facts });
  if (v && record.carried) v.descriptionRaw = null;
  return v;
}

// ---------- one car at post time ----------

// A car's page: its record, "gone" (404 or 410), an error to show, or
// "none": the page is there but doesn't mark the car up, or it moved to a
// page without it. For "none" the list decides (getDetails), because a page
// that marks up only other cars says nothing about this one.
async function carFromPage(site, vin, href) {
  const got = await site.read(href);
  const page = pageOf(got, vin);
  if (page.kind === 'gone') return { gone: true };
  if (page.kind === 'blocked') return { error: page.message.replace(/, so the scan stopped.*$/, '.'), blocked: true };
  if (page.kind !== 'html') return { error: `Couldn't read the car's page on the website (${page.message}).`, file: Boolean(page.file) };
  const node = page.parsed.vehicles.find((n) => nodeVin(n) === vin);
  if (node) return { record: { node, url: got.finalUrl, facts: factsForCar(page.parsed.facts, { urls: [got.finalUrl, href], vin }) } };
  return { none: true };
}

/**
 * The car's full record for the post-time re-check, read from its own page:
 * options.url (the address the last scan kept, which the side panel passes
 * through vehicleDetails.fetchVehicleDetails) when known, else the page the
 * list links to for this VIN. record null when the website no longer has the car.
 * options.carPages ([{ url, vin }], the car pages the last scan kept) tells
 * the pages read here which links go to the lot's other cars, as a scan
 * knows them (carKeys), so another car's tile is cut out of this car's text
 * at post time too, even on a lot whose car addresses neither carry a VIN
 * nor read like a car page ("/vdp/7001/").
 * A list read that stopped before its end (MAX_LIST_PAGES pages, a next link
 * off the website or back to a page already read, a page cut at
 * PAGE_TEXT_LIMIT, a first page firstListPage could not walk back to), the
 * same ways the scan calls a list not clean, adds complete: false, so a car
 * on the unread part is never called gone. A car the list still links to
 * whose page shows no vehicle data for it is not gone either: it can't be
 * checked (ok false, noData). An answer that is not the car carries why:
 * refused (a 403, 429, 503 or bot check: nothing more may be asked of the
 * website now) or carPage (the car's own page or links failed or showed no
 * data; reading another list would not change that); a list that could not
 * be read carries neither.
 */
export async function getDetails(search, vin, options = {}) {
  const wanted = String(vin || '').toUpperCase();
  const opts = options || {};
  const origin = originOf(opts.origin) || originOf(opts.listUrl) || originOf(opts.url);
  const site = siteReader(search, origin);
  const known = new Map();
  for (const car of Array.isArray(opts.carPages) ? opts.carPages : []) {
    const at = car && typeof car === 'object' ? onSite(typeof car.url === 'string' ? car.url : '', null, origin) : null;
    if (!at) continue;
    const key = pageKey(at.href);
    const vin = typeof car.vin === 'string' ? car.vin.toUpperCase() : '';
    if (!known.has(key)) known.set(key, VIN.test(vin) ? 'vin:' + vin : key);
  }
  if (known.size) {
    site.cars.known = known;
    site.cars.shape = learnCarAddressShape([...known.keys()]);
  }
  const done = (record) => ({ ok: true, record, fetchedAt: new Date().toISOString() });
  const pageFailed = (r) => ({ ok: false, message: r.error, ...(r.blocked ? { refused: true } : { carPage: true }) });
  const noData = "The website still lists this car, but its page has no vehicle data Lot Current can read, so the car couldn't be checked.";
  let pageWithoutData = false;
  const own = onSite(typeof opts.url === 'string' ? opts.url : '', null, origin);
  if (own) {
    const r = await carFromPage(site, wanted, own.href);
    if (r.error) return pageFailed(r);
    if (r.record) return done(r.record);
    if (r.gone) return done(null);
    pageWithoutData = true;
  }
  const start = onSite(opts.listUrl, null, origin);
  if (!start) {
    return pageWithoutData
      ? { ok: false, message: "The car's page on the website has no vehicle data Lot Current can read.", carPage: true, noData: true }
      : { ok: false, message: "Lot Current doesn't know where this car's page is. Scan the website again, then post." };
  }
  const first = await firstListPage(site, start.href, origin, MAX_LIST_PAGES);
  if (first.stopped) return { ok: false, message: `Couldn't read the inventory page (${first.stopped}).`, refused: true };
  const visited = new Set();
  let whole = false;
  let cut = !first.clean; // a list whose first page could not be found is read only in part, as the scan's listClean says
  for (let at = first.href, n = 0; n < MAX_LIST_PAGES; n += 1) {
    visited.add(pageKey(at));
    const got = await site.read(at);
    const page = pageOf(got);
    if (page.kind !== 'html') return { ok: false, message: `Couldn't read the inventory page (${page.message || `HTTP ${page.status}`}).`, ...(page.kind === 'blocked' ? { refused: true } : {}) };
    if (page.truncated) cut = true;
    const listedNode = page.parsed.vehicles.find((x) => nodeVin(x) === wanted) || null;
    const listPage = got.finalUrl;
    const named = listedNode ? onSite(firstText(listedNode.url), listPage, origin) : null;
    if (named) {
      const r = await carFromPage(site, wanted, named.href);
      if (r.error) return pageFailed(r);
      if (r.record) return done(r.record);
      return done(listRecord({ node: listedNode, page: listPage, facts: page.parsed.facts }, named.href, false));
    }
    // The car's page among the links with its VIN, a form or a file with
    // its VIN in the query not taken for it (oneAddressPerCar): those with
    // the VIN in their path first, then in the list's order, until one
    // shows the car. A file is passed over, and so is a link that fails (a
    // report link that sends Lot Current to another website, a form's 500):
    // when no link shows the car, the first failure is the answer, since the
    // car's own page may be the one failing. A refusal stops at once. The
    // car is gone only when a link said so (404 or 410) and none was a page
    // without its data or a file: a car the list still links to is not.
    const withVin = page.parsed.facts.links.map((h) => onSite(h, null, origin)).filter((u) => u && !fileAddress(u.href) && vinInAddress(u.href) === wanted);
    const ordered = [...withVin.filter((u) => vinInPath(u.href) === wanted), ...withVin.filter((u) => vinInPath(u.href) !== wanted)];
    const links = ordered.slice(0, MAX_ADDRESSES_PER_CAR);
    let failed = null;
    let shown = false; // a page or a file at one of its links, without the car's data
    let goneLink = false;
    for (const link of links) {
      const r = await carFromPage(site, wanted, link.href);
      if (r.record) return done(r.record);
      if (r.blocked) return pageFailed(r);
      if (r.error && !r.file && !failed) failed = r;
      if (r.none || r.file) shown = true;
      if (r.gone) goneLink = true;
    }
    if (failed) return pageFailed(failed);
    // links left unread may hold its page: never "gone" on that
    if (ordered.length > links.length && !listedNode) return { ok: false, message: "Couldn't tell which of this car's links on the website is its page. Scan the website again, then post.", carPage: true };
    if (links.length && !listedNode) return goneLink && !shown ? done(null) : { ok: false, message: noData, carPage: true, noData: true };
    if (listedNode) return done(listRecord({ node: listedNode, page: listPage, facts: page.parsed.facts }, links.length ? links[0].href : listPage, false));
    if (!page.parsed.facts.next) {
      whole = !cut; // the list ended where it says it ends
      break;
    }
    const next = onSite(page.parsed.facts.next, null, origin);
    if (!next || visited.has(pageKey(next.href))) break; // off the website, or back to a page already read
    at = next.href;
  }
  return whole ? done(null) : { ...done(null), complete: false };
}

// ---------- photos ----------

// The origins the lot's photos are on, from a scan's records. Recorded on
// the site registry entry; the side panel asks Chrome for a photo server
// from the salesperson's click (src/photoHosts.js). Nothing here asks.
export function photoOrigins(records) {
  const out = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    const v = normalize(r);
    for (const href of (v && v.photos) || []) {
      const origin = originOf(href);
      if (origin) out.add(origin);
    }
  }
  return [...out].sort();
}

export default { PLATFORM, probeInPage, searchInPage, detect, origins, scanOptions, scan, getDetails, normalize, makeDirectSearch, photoOrigins };
