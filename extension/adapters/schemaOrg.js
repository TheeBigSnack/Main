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
export const MAX_SITEMAP_ADDRESSES = 20000;
export const REQUEST_TIMEOUT_MS = 30000;

// ---------- in the dealer tab (self-contained, read-only) ----------

// Answers on a page that lists cars (vehicle data in its JSON-LD or
// microdata, or at least two links on this website to car pages: an address
// with a VIN in it, or one that reads like a car page) or on one car's own
// page. The list to scan is the page it ran on, unless that page doesn't
// read as used inventory and links to a page that does; on a car's page it
// is the used inventory page it links to (null when it links to none).
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

  // Links on this website to car pages, and the best link to used inventory.
  const carLinks = new Set();
  let usedLink = '';
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href, pageAddress); } catch (e) { continue; }
    if (u.origin !== here.origin || (u.protocol !== 'https:' && u.protocol !== 'http:')) continue;
    if (!isRoute(u)) u.hash = '';
    if (u.href === pageAddress) continue;
    if (vinShaped(readable(u)) || carShaped(u)) carLinks.add(u.href);
    else if (usedWords.test(readable(u)) || /^\s*(?:(?:shop|view|browse|see|all)\s+)*(?:used|pre-?owned)(?:\s+(?:inventory|vehicles|cars))?\s*$/i.test(String(a.textContent || ''))) {
      if (!usedLink || u.href.length < usedLink.length) usedLink = u.href;
    }
  }

  const own = nodes.filter((n) => !n.address || samePage(n.address));
  const onePage = Boolean(vinShaped(readable(here)))
    || (carShaped(here) && (own.length > 0 || micro > 0))
    || (own.length === 1 && Boolean(own[0].vin));
  const aList = !onePage && (carLinks.size >= 2 || nodes.length > 0 || micro > 0);
  if (!onePage && !aList) return null;
  if (onePage) return { kind: 'schemaOrg', origin: site, listUrl: usedLink || null };
  const usedHere = usedWords.test(readable(here)) || /\b(?:used|pre-?owned|certified)\b/i.test(String(document.title || ''));
  return { kind: 'schemaOrg', origin: site, listUrl: usedHere || !usedLink ? pageAddress : usedLink };
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

/** The VIN in a car page's address ("/used-2019-honda-civic-2hgsampl8kh000101/"), upper case, or ''. */
export function vinInAddress(href) {
  for (const m of addressText(href).matchAll(VIN_IN_ADDRESS)) if (/[A-Za-z]/.test(m[1])) return m[1].toUpperCase();
  return '';
}

/** An address that reads like a car's page without a VIN in it: a model year joined to words, under an inventory word. */
export function looksLikeCarAddress(href) {
  const p = addressText(href).toLowerCase();
  return /(?:^|[^a-z0-9])(?:19[5-9][0-9]|20[0-9][0-9])[-_+]+[a-z]/.test(p) && /(?:^|[^a-z])(?:inventory|vehicles?|vdp|details?|used|pre-?owned|preowned|certified|cpo|for-?sale|stock)(?:[^a-z]|$)/.test(p);
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

// A page's cars and facts, read once however many times it is asked for.
// A bot check reads as a stop; anything that isn't a web page as an error.
function pageOf(outcome) {
  if (outcome.kind !== 'page') return outcome;
  if (!outcome.read) {
    if (!isHtmlAnswer(outcome.contentType, outcome.text)) outcome.read = { kind: 'error', message: `not a web page (${outcome.contentType || 'no type'})` };
    else {
      const parsed = parseVehiclePage(outcome.text, outcome.finalUrl);
      outcome.read = isBotCheck(parsed) ? { kind: 'blocked', message: STOPPED.check } : { kind: 'html', parsed, truncated: outcome.text.length >= PAGE_TEXT_LIMIT };
    }
  }
  return outcome.read;
}

// Every page read once per scan: the requests are counted, and a page asked
// for twice (a missing car's page this scan already read) is not fetched again.
function siteReader(search, origin) {
  const answers = new Map();
  const reader = {
    requests: 0,
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

// What normalize needs from a page besides the car's node.
const factsForCar = (facts) => ({ title: facts.title, text: facts.text, carfaxLinks: facts.carfaxLinks });

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
  const record = { node: { ...listed.node, url: carUrl }, url: listed.page, facts: factsForCar(listed.facts) };
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
  for (const m of robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) {
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
// node marked SoldOut. Anything else that isn't the car's page (403, 429,
// 5xx, a timeout, a bot check, a file that isn't a web page, a page with no
// structured data at all) is an error, and the rescan then marks nothing
// gone. A redirect to a page without a node for this VIN, or the page itself
// with the website's own structured data and no node for this VIN (a "no
// longer available" page, or one that shows only other cars) is "unsure":
// it counts as gone only once this website's car pages are known to carry
// their own car's VIN (confirmMissing). Until then it proves nothing, since
// a car page that marks up only a "similar vehicles" carousel looks the same
// while its car is still for sale.
async function confirmOne(site, vin, href) {
  const got = await site.read(href);
  const page = pageOf(got);
  if (page.kind === 'gone') return { gone: true };
  if (page.kind === 'blocked') return { error: page.message.replace(/, so the scan stopped.*$/, '') };
  if (page.kind === 'error') return { error: `one car's page gave ${page.message}` };
  const node = page.parsed.vehicles.find((n) => nodeVin(n) === vin);
  if (node) return soldOut(node) ? { gone: true } : { found: { node, url: got.finalUrl, facts: factsForCar(page.parsed.facts) } };
  if (got.redirected && pathKey(got.finalUrl) !== pathKey(href)) return { unsure: true };
  if (page.parsed.vehicles.length || hasStructuredData(got.text)) return { unsure: true };
  return { error: "one car's page had no structured data to check against" };
}

// Does a page carry any schema.org data of the website's own (a JSON-LD
// block or a microdata item)? A bot check or a bare error page carries none.
function hasStructuredData(html) {
  return extractJsonLd(html).length > 0 || /\bitemtype\s*=\s*["']?https?:\/\/schema\.org\//i.test(html);
}

async function confirmMissing(site, { vins, urls, records, origin, evidence, samples }) {
  const confirm = { checked: [], notFound: [], error: null };
  const wanted = [...new Set((Array.isArray(vins) ? vins : []).map((v) => String(v || '').toUpperCase()).filter(Boolean))].filter((v) => !records.has(v));
  // a car with no known page on this website can't be checked: it stays "missing, not confirmed gone"
  const items = [];
  for (const vin of wanted) {
    const at = urls && typeof urls[vin] === 'string' ? onSite(urls[vin], null, origin) : null;
    if (at) items.push({ vin, href: at.href, verdict: null });
  }
  await twoAtATime(items, async (item) => {
    if (confirm.error) return false;
    item.verdict = await confirmOne(site, item.vin, item.href);
    if (item.verdict.error) {
      confirm.error = item.verdict.error;
      return false;
    }
    return true;
  });
  if (!confirm.error && items.some((i) => i.verdict && i.verdict.unsure) && !evidence.ownNode) {
    // Does this website's car page carry its car's data? One car still on the list says.
    const sample = samples.find(Boolean);
    const got = sample ? pageOf(await site.read(sample.href)) : null;
    if (got && got.kind === 'html' && got.parsed.vehicles.some((n) => nodeVin(n) === sample.vin)) evidence.ownNode = true;
    else confirm.error = got && got.kind !== 'html' ? `a car's page gave ${got.message || 'no answer'}` : "this website's car pages don't mark up their own car, so there is nothing to check against";
  }
  if (confirm.error) return confirm;
  for (const item of items) {
    if (!item.verdict) continue;
    if (item.verdict.found) records.set(item.vin, item.verdict.found);
    confirm.checked.push(item.vin);
    if (item.verdict.gone || item.verdict.unsure) confirm.notFound.push(item.vin);
  }
  return confirm;
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
 *   (scanRunner stamps their snapshot entries with pageReadAt); unread the
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

  // 1. the list and its rel=next pages
  const visited = new Set();
  const byKey = new Map(); // car page key -> the list's data for it
  const byVin = new Map();
  const strong = new Map(); // car pages the list names by its data or with a VIN in the address
  const weak = new Map(); // links that only read like car pages
  let listClean = true;
  let listed = 0;
  let firstList = null;
  for (let at = start.href, n = 0; ; n += 1) {
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

  // 2. the car pages: the strong ones, and links that only read like car
  // pages when they have the shape of the strong ones
  const cars = new Map();
  for (const [key, href] of strong) if (!visited.has(key)) cars.set(key, href);
  const strongShape = cars.size >= 2 ? learnCarAddressShape([...cars.values()]) : null;
  for (const [key, href] of weak) if (!visited.has(key) && !cars.has(key) && (cars.size < 2 || matchesCarAddressShape(href, strongShape))) cars.set(key, href);

  let sitemapClean = true;
  if (opts.sitemap === true || (opts.sitemap !== false && listed > cars.size)) {
    const r = await sitemapAddresses(site, origin, learnCarAddressShape([...cars.values()]));
    if (r.stopped) return fail('blocked', r.stopped);
    sitemapClean = r.clean;
    for (const href of r.found) {
      const key = pageKey(href);
      if (!visited.has(key) && !cars.has(key)) cars.set(key, href);
    }
  }
  if (!cars.size) {
    return fail('no-cars', `Lot Current found no links to car pages on the inventory page (${firstList}). A page that draws its list with scripts shows none to Lot Current's plain read of it.`);
  }

  // 3. which car pages to read
  const lastSeen = opts.lastSeen && typeof opts.lastSeen === 'object' ? opts.lastSeen : {};
  const firstScan = Object.keys(lastSeen).length === 0;
  const posted = new Set((Array.isArray(opts.postedVins) ? opts.postedVins : []).map((v) => String(v || '').toUpperCase()));
  const plan = [];
  for (const [key, href] of cars) {
    const listedCar = byKey.get(key) || byVin.get(vinInAddress(href)) || null;
    const vin = (listedCar && listedCar.vin) || vinInAddress(href);
    const item = { key, href, vin, listedCar, record: null };
    const entry = vin ? lastSeen[vin] : null;
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
  // do MAX_FAILED_IN_A_ROW failures in a row (a timeout, a reset, a 500)
  let stopped = null;
  let readErrors = 0;
  let failedInARow = 0;
  const pagesRead = new Set();
  const evidence = { ownNode: false };
  await twoAtATime(reading, async (item) => {
    if (stopped) return false;
    const got = await site.read(item.href);
    const page = pageOf(got);
    if (page.kind === 'blocked') {
      stopped = { error: 'blocked', message: page.message };
      return false;
    }
    if (page.kind === 'gone') {
      failedInARow = 0;
      return true; // its page is gone: a car from the last scan is checked below
    }
    if (page.kind !== 'html') {
      // the scan is not complete, and the car is still on the list
      readErrors += 1;
      standIn(item);
      failedInARow += 1;
      if (failedInARow >= MAX_FAILED_IN_A_ROW && !stopped) {
        stopped = { error: 'failing', message: `The website's car pages failed ${failedInARow} times in a row (the last: ${page.message}), so the scan stopped. Nothing was retried; try again later.` };
        return false;
      }
      return true;
    }
    failedInARow = 0;
    if (item.vin) pagesRead.add(item.vin);
    const node = carOnPage(page.parsed.vehicles, { vin: item.vin, pageUrl: got.finalUrl });
    if (node && nodeVin(node)) {
      evidence.ownNode = true;
      item.record = { node, url: got.finalUrl, facts: factsForCar(page.parsed.facts) };
    } else if (item.listedCar && item.listedCar.vin) {
      item.record = listRecord(item.listedCar, item.href, true); // the page doesn't mark the car up; the list does
    } else if (page.truncated) readErrors += 1;
    return true;
  });
  if (stopped) return fail(stopped.error, stopped.message);
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
  const confirm = await confirmMissing(site, { vins: (Array.isArray(opts.confirmVins) ? opts.confirmVins : []).filter((v) => !unread.has(String(v || '').toUpperCase())), urls: opts.confirmUrls, records, origin, evidence, samples });

  // a missing car found at its last page was read from that page too
  for (const vin of confirm.checked) if (!confirm.notFound.includes(vin)) pagesRead.add(vin);

  const complete = listClean && sitemapClean && readErrors === 0 && leftForLater === 0;
  const out = { ok: true, fetchedAt: new Date().toISOString(), total: cars.size, complete, requests: site.requests, records: [...records.values()], confirm };
  if (unread.size) out.unread = [...unread];
  const readCars = [...pagesRead].filter((vin) => records.has(vin));
  if (readCars.length) out.pagesRead = readCars;
  if (leftForLater) out.leftForLater = leftForLater;
  return out;
}

// A record -> the flat vehicle (schemaOrgNormalize.js). A car this scan took
// from the list's data without reading its page has no description this
// time: descriptionRaw is null, and scanRunner.js keeps the lot's
// boilerplate from the pages read before.
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
  const page = pageOf(got);
  if (page.kind === 'gone') return { gone: true };
  if (page.kind === 'blocked') return { error: page.message.replace(/, so the scan stopped.*$/, '.') };
  if (page.kind !== 'html') return { error: `Couldn't read the car's page on the website (${page.message}).` };
  const node = page.parsed.vehicles.find((n) => nodeVin(n) === vin);
  if (node) return { record: { node, url: got.finalUrl, facts: factsForCar(page.parsed.facts) } };
  return { none: true };
}

/**
 * The car's full record for the post-time re-check, read from its own page:
 * options.url (the address the last scan kept, which the side panel passes
 * through vehicleDetails.fetchVehicleDetails) when known, else the page the
 * list links to for this VIN. record null when the website no longer has the car.
 */
export async function getDetails(search, vin, options = {}) {
  const wanted = String(vin || '').toUpperCase();
  const opts = options || {};
  const origin = originOf(opts.origin) || originOf(opts.listUrl) || originOf(opts.url);
  const site = siteReader(search, origin);
  const done = (record) => ({ ok: true, record, fetchedAt: new Date().toISOString() });
  let pageWithoutData = false;
  const own = onSite(typeof opts.url === 'string' ? opts.url : '', null, origin);
  if (own) {
    const r = await carFromPage(site, wanted, own.href);
    if (r.error) return { ok: false, message: r.error };
    if (r.record) return done(r.record);
    if (r.gone) return done(null);
    pageWithoutData = true;
  }
  const start = onSite(opts.listUrl, null, origin);
  if (!start) {
    return pageWithoutData
      ? { ok: false, message: "The car's page on the website has no vehicle data Lot Current can read." }
      : { ok: false, message: "Lot Current doesn't know where this car's page is. Scan the website again, then post." };
  }
  const visited = new Set();
  for (let at = start.href, n = 0; n < MAX_LIST_PAGES; n += 1) {
    visited.add(pageKey(at));
    const got = await site.read(at);
    const page = pageOf(got);
    if (page.kind !== 'html') return { ok: false, message: `Couldn't read the inventory page (${page.message || `HTTP ${page.status}`}).` };
    const listedNode = page.parsed.vehicles.find((x) => nodeVin(x) === wanted) || null;
    const listPage = got.finalUrl;
    const link = (listedNode && onSite(firstText(listedNode.url), listPage, origin)) || page.parsed.facts.links.map((h) => onSite(h, null, origin)).find((u) => u && vinInAddress(u.href) === wanted) || null;
    if (link) {
      const r = await carFromPage(site, wanted, link.href);
      if (r.error) return { ok: false, message: r.error };
      if (r.record) return done(r.record);
      if (!listedNode) return done(null);
    }
    if (listedNode) return done(listRecord({ node: listedNode, page: listPage, facts: page.parsed.facts }, link ? link.href : listPage, false));
    const next = page.parsed.facts.next ? onSite(page.parsed.facts.next, null, origin) : null;
    if (!next || visited.has(pageKey(next.href))) break;
    at = next.href;
  }
  return done(null);
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
