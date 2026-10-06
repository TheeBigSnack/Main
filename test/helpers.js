import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeVehicle } from '../extension/adapters/dealerInspireNormalize.js';
import { assessVehicle } from '../extension/src/classify.js';
import { makeSnapshot } from '../extension/src/rescan.js';
import { vinCheckDigit } from '../extension/src/vin.js';

export const fixtures = JSON.parse(readFileSync(new URL('./fixtures/records.json', import.meta.url)));
export const WAYNESBURG = 'Ron Lewis Chrysler Dodge Jeep Ram Waynesburg';
export const MY_STORE = { myStores: [WAYNESBURG] };

function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

export function deepMerge(base, patch) {
  if (!isObject(patch)) return patch;
  const out = { ...base };
  for (const [k, val] of Object.entries(patch)) out[k] = isObject(val) && isObject(base?.[k]) ? deepMerge(base[k], val) : val;
  return out;
}

// A raw record from the fixtures, optionally changed
export function raw(name, patch = {}) {
  return deepMerge(fixtures[name], patch);
}

export function vehicle(name, patch = {}) {
  return normalizeVehicle(raw(name, patch));
}

// A snapshot built from [fixtureName, patch] pairs, run through the real pipeline
export function snapshot(items, settings = MY_STORE, takenAt = '2026-09-26T21:00:00.000Z') {
  const vehicles = items.map(([name, patch]) => vehicle(name, patch));
  const assessments = vehicles.map((v) => assessVehicle(v, settings));
  return makeSnapshot({ site: { origin: 'https://example-dealer.test', name: 'Test' }, takenAt, complete: true, vehicles, assessments });
}

// ---------- a dealer page as the injected code sees it ----------

// The globals a Dealer Inspire look-alike page (test/e2e/mock-dealer-site.mjs)
// offers the functions chrome.scripting.executeScript copies into it:
// window.SEARCH_SERVICE and IDPSearchServiceHelper backed by `records`, a
// document with the og:site_name and a schema.org address, a location.
// `withService: false` gives a page no adapter recognises; `withLd: false`
// a page with no structured address, whose `bodyText` is all there is. The
// result is a vm sandbox for fakeChrome: injected functions run inside it,
// with nothing else in scope, so one that reached outside its own body throws.
export function fakeDealerPage({ records = [], origin = 'https://example-dealer.test', withService = true, name = 'Example Motors', withLd = true, bodyText = 'USED AND CERTIFIED USED FOR SALE' } = {}) {
  const getListings = async (body) => {
    const f = body.filters || {};
    const list = records.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)) && (!f.status || f.status.includes(r.status)));
    const perPage = body.perPage || 50;
    const start = ((body.page || 1) - 1) * perPage;
    return { data: { total_vehicle_count: list.length, listings: list.slice(start, start + perPage) } };
  };
  const window = {};
  if (withService) {
    window.SEARCH_SERVICE = { apiKey: 'test-key', search: '/api/v1/listings/1', visibleStatusValues: ['publish', 'modified', 'pend-sale'] };
    window.IDPSearchServiceHelper = { getListings };
  }
  const ld = { '@context': 'https://schema.org', '@type': 'AutoDealer', name, telephone: '(555) 555-0100', address: { '@type': 'PostalAddress', streetAddress: '1 Example Way', addressLocality: 'Springfield', addressRegion: 'OH', postalCode: '43215' } };
  const document = {
    title: `Used Vehicles for Sale | ${name}`,
    body: { innerText: bodyText },
    querySelector: (sel) => (sel === 'meta[property="og:site_name"]' ? { content: name } : null),
    querySelectorAll: (sel) => (sel === 'script[type="application/ld+json"]' && withLd ? [{ textContent: JSON.stringify(ld) }] : []),
  };
  const location = { origin, hostname: new URL(origin).hostname, href: origin + '/used-vehicles/' };
  return vm.createContext({ window, document, location, URL });
}

// Runs a function's source inside the page sandbox, the way Chrome copies it
// into the tab: nothing from the module it came from is in scope, and the
// result comes back structured-cloned, as executeScript returns it.
export async function runInPage(page, func, ...args) {
  const fn = vm.runInContext('(' + String(func) + ')', page);
  const result = await fn(...args);
  return result === undefined ? undefined : structuredClone(result);
}

// chrome.scripting.executeScript and chrome.storage.local stand-ins for the
// scan runner: injections run in the page sandbox, storage is `store`, and
// chrome.tabs.get answers with the page's own address.
export function fakeChrome(page, store = {}) {
  return {
    store,
    tabs: {
      get: async (id) => ({ id, url: page.location && page.location.href }),
    },
    scripting: {
      executeScript: async ({ func, args = [] }) => [{ result: await runInPage(page, func, ...args) }],
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys === null || keys === undefined) return { ...store }; // everything, as chrome.storage answers get(null)
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  };
}

// ---------- a website that publishes standard vehicle data ----------
// A synthetic dealership ("Sample Motors", as in test/fixtures/structured/)
// written from the public schema.org Car, Offer and ItemList definitions,
// not copied from any website: list pages with an ItemList and rel=next,
// one page per car with its JSON-LD, robots.txt and a sitemap. A test
// changes the Map it returns (a page sold, a server error) before it reads.

export const STANDARD_ORIGIN = 'https://www.sample-motors.test';
const MAKES = [['Honda', 'Civic', 'EX'], ['Toyota', 'Camry', 'SE'], ['Ford', 'Escape', 'SE'], ['Kia', 'Sorento', 'LX'], ['Chevrolet', 'Equinox', 'LT']];
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

// A made-up VIN that spells SAMPL, with the check digit and model-year code vin.js expects.
export function sampleVin(i, year = 2019) {
  const draft = `1HGSAMPL0${YEAR_CODES[(year - 1980) % 30]}H${String(100000 + i).slice(-6)}`;
  return draft.slice(0, 8) + vinCheckDigit(draft) + draft.slice(9);
}

// `count` used cars, numbered from `from` (a second lot can follow a first).
export function standardCars(count, { from = 0 } = {}) {
  return Array.from({ length: count }, (_, n) => {
    const i = from + n;
    const [make, model, trim] = MAKES[i % MAKES.length];
    const year = 2016 + (i % 6);
    const vin = sampleVin(i, year);
    return { vin, stock: `SM${1000 + i}`, year, make, model, trim, price: 15000 + i * 500, miles: 20000 + i * 1000, path: `/inventory/used-${year}-${make}-${model}-${vin}/`.toLowerCase(), photos: 3 };
  });
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => '$' + Number(n).toLocaleString('en-US');
const ldScript = (x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`;
const DEALER_NODE = { '@context': 'https://schema.org', '@type': 'AutoDealer', name: 'Sample Motors', address: { '@type': 'PostalAddress', streetAddress: '1 Sample Way', addressLocality: 'Springfield', addressRegion: 'OH', postalCode: '43215' } };

export function standardCarNode(c, origin = STANDARD_ORIGIN, { availability = 'InStock', price = c.price } = {}) {
  return {
    '@context': 'https://schema.org', '@type': 'Car', name: `Used ${c.year} ${c.make} ${c.model} ${c.trim}`, url: origin + c.path,
    vehicleIdentificationNumber: c.vin, sku: c.stock, vehicleModelDate: String(c.year), brand: { '@type': 'Brand', name: c.make }, model: c.model, vehicleConfiguration: c.trim,
    itemCondition: 'https://schema.org/UsedCondition', mileageFromOdometer: { '@type': 'QuantitativeValue', value: c.miles, unitCode: 'SMI' },
    image: Array.from({ length: c.photos }, (_, n) => `https://photos.sample-cdn.test/${c.vin}/${n + 1}.jpg`),
    description: `A clean ${c.year} ${c.model}.<br>Every car gets a 120-point inspection.`,
    offers: { '@type': 'Offer', price, priceCurrency: 'USD', availability: 'https://schema.org/' + availability, seller: { '@type': 'AutoDealer', name: 'Sample Motors' } },
  };
}

// One car's own page: its node (and, when asked, a carousel of other cars with theirs).
export function standardCarPage(c, { origin = STANDARD_ORIGIN, availability = 'InStock', price = c.price, carousel = [] } = {}) {
  const shown = price === null ? 'Call for price' : money(price);
  const node = standardCarNode(c, origin, { availability, price: price === null ? undefined : price });
  const others = carousel.length ? [ldScript({ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Similar vehicles', itemListElement: carousel.map((o, n) => ({ '@type': 'ListItem', position: n + 1, item: standardCarNode(o, origin) })) })] : [];
  return `<!doctype html><html><head><title>Used ${c.year} ${c.make} ${c.model} | Sample Motors</title>${ldScript(DEALER_NODE)}${ldScript(node)}${others.join('')}</head>
<body><h1>Used ${c.year} ${c.make} ${c.model} ${c.trim}</h1><p>Our price ${shown}</p><p>${c.miles.toLocaleString('en-US')} miles</p>
<p><a href="https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=${c.vin}">Carfax report</a></p>
${carousel.length ? `<aside>${carousel.map((o) => `<a href="${escHtml(o.path)}">${o.year} ${o.make} ${o.model} ${money(o.price)}</a>`).join(' ')}</aside>` : ''}
<a href="/used-vehicles/">Used inventory</a></body></html>`;
}

// One page of the used list: the ItemList of its cars, a card per car that
// shows its price, rel=next when another page follows and rel=prev when one
// comes before.
export function standardListPage(cars, { origin = STANDARD_ORIGIN, next = null, prev = null, numberOfItems = null, listData = true, noPrice = new Set() } = {}) {
  const list = { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Used vehicles', itemListElement: cars.map((c, n) => ({ '@type': 'ListItem', position: n + 1, item: standardCarNode(c, origin, noPrice.has(c.vin) ? { price: undefined } : {}) })) };
  if (numberOfItems !== null) list.numberOfItems = numberOfItems;
  const cards = cars.map((c) => `<div class="card"><a href="${escHtml(c.path)}">Used ${c.year} ${c.make} ${c.model} ${c.trim}</a> <span>${noPrice.has(c.vin) ? 'Call for price' : money(c.price)}</span> <span>${c.miles.toLocaleString('en-US')} miles</span> <a href="https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=${c.vin}">Carfax</a></div>`).join('\n');
  return `<!doctype html><html><head><title>Used Vehicles for Sale | Sample Motors</title>${prev ? `<link rel="prev" href="${escHtml(prev)}">` : ''}${next ? `<link rel="next" href="${escHtml(next)}">` : ''}${ldScript(DEALER_NODE)}${listData ? ldScript(list) : ''}</head>
<body><h1>Used Vehicles for Sale</h1><nav><a href="/">Home</a> <a href="/new-vehicles/">New</a> <a href="/used-vehicles/">Used</a> <a href="/about/">About us</a></nav>
${cards}</body></html>`;
}

const page = (text, extra = {}) => ({ ok: true, status: 200, contentType: 'text/html; charset=utf-8', text, ...extra });
export const httpError = (status, text = '') => ({ ok: false, status, contentType: 'text/plain', text });

/**
 * The whole website as a Map of address -> answer ({ ok, status, finalUrl?,
 * redirected?, contentType, text }), the shape a search(request) returns.
 * @param {object} options  cars (standardCars), perPage, sitemap (list the
 *   car pages in /sitemap.xml, plus a new car and an article), listData
 *   (false: the list pages carry no JSON-LD, only links), numberOfItems
 */
export function standardSite({ cars = standardCars(6), perPage = 4, origin = STANDARD_ORIGIN, sitemap = false, listData = true, numberOfItems = null, noPrice = new Set() } = {}) {
  const site = new Map();
  const pages = Math.max(1, Math.ceil(cars.length / perPage));
  for (let p = 1; p <= pages; p += 1) {
    const at = p === 1 ? origin + '/used-vehicles/' : `${origin}/used-vehicles/?page=${p}`;
    const next = p < pages ? `/used-vehicles/?page=${p + 1}` : null;
    const prev = p > 2 ? `/used-vehicles/?page=${p - 1}` : p === 2 ? '/used-vehicles/' : null;
    site.set(at, page(standardListPage(cars.slice((p - 1) * perPage, p * perPage), { origin, next, prev, numberOfItems, listData, noPrice })));
  }
  for (const c of cars) site.set(origin + c.path, page(standardCarPage(c, { origin, price: noPrice.has(c.vin) ? null : c.price })));
  site.set(origin + '/', page(`<!doctype html><html><head><title>Sample Motors</title>${ldScript(DEALER_NODE)}</head><body><a href="/used-vehicles/">Shop used</a> <a href="/new-vehicles/">Shop new</a></body></html>`));
  if (sitemap) {
    site.set(origin + '/robots.txt', { ok: true, status: 200, contentType: 'text/plain', text: `User-agent: *\nDisallow: /cart/\nSitemap: ${origin}/sitemap.xml\n` });
    const locs = [...cars.map((c) => origin + c.path), `${origin}/inventory/new-2027-kia-telluride-ex-${sampleVin(999, 2027).toLowerCase()}/`, `${origin}/blog/2019-honda-civic-review/`, `${origin}/about/`];
    site.set(origin + '/sitemap.xml', { ok: true, status: 200, contentType: 'application/xml', text: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>` });
  } else {
    site.set(origin + '/robots.txt', httpError(404));
  }
  return site;
}

// A search(request) over such a Map: one answer per address, a 404 for
// anything the Map doesn't have. `calls` lists the addresses asked for, in
// order; `inFlight`/`most` count the requests open at once.
export function fakeSiteSearch(site, { delay = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  const search = async (request) => {
    calls.push(request.url);
    inFlight += 1;
    search.most = Math.max(search.most, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const got = site.get(request.url) || httpError(404, 'Not found');
      return { finalUrl: request.url, redirected: false, ...got };
    } finally {
      inFlight -= 1;
    }
  };
  search.calls = calls;
  search.most = 0;
  return search;
}

// The page as the injected code sees it on such a website: `html` at
// `path`, with the document calls the probes make (JSON-LD scripts,
// itemtype elements, links with their absolute href and text) and a fetch
// that answers from `site`. Like fakeDealerPage, a vm sandbox for
// runInPage and fakeChrome. The answer's body streams its text in chunks
// (`body.getReader()`), as Chrome's fetch does, so the injected search reads
// it the way it does in the browser; `stream: false` gives an answer with
// only `text()`. `fetchCalls` lists the requests, `cancelled` the bodies the
// page stopped reading.
export function fakeStandardPage({ site = standardSite(), path = '/used-vehicles/', origin = STANDARD_ORIGIN, html = null, stream = true, chunk = 65536 } = {}) {
  const url = new URL(path, origin).href;
  const source = html ?? (site.get(url) || {}).text ?? '';
  const scripts = [...source.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => ({ textContent: m[1] }));
  const typed = [...source.matchAll(/\bitemtype="([^"]*)"/g)].map((m) => ({ getAttribute: (name) => (name === 'itemtype' ? m[1] : null) }));
  const links = [...source.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: new URL(m[1].replace(/&amp;/g, '&'), url).href, textContent: m[2].replace(/<[^>]*>/g, '') }));
  const title = (/<title>([\s\S]*?)<\/title>/.exec(source) || [])[1] || '';
  const fetchCalls = [];
  const cancelled = [];
  const bodyOf = (href, text) => {
    const bytes = new TextEncoder().encode(text || '');
    let at = 0;
    return {
      getReader: () => ({
        read: async () => {
          if (at >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(at, at + chunk);
          at += chunk;
          return { done: false, value };
        },
        cancel: async () => { cancelled.push(href); },
      }),
    };
  };
  const fetch = async (href, init) => {
    fetchCalls.push({ url: String(href), init });
    const got = site.get(String(href)) || httpError(404, 'Not found');
    const res = { ok: got.ok, status: got.status, url: got.finalUrl || String(href), redirected: Boolean(got.redirected), headers: { get: (n) => (n.toLowerCase() === 'content-type' ? got.contentType : null) }, text: async () => got.text };
    if (stream) res.body = bodyOf(String(href), got.text);
    return res;
  };
  const document = {
    URL: url,
    title,
    body: { innerText: source.replace(/<[^>]*>/g, ' ') },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'script[type="application/ld+json"]' ? scripts : sel === '[itemtype]' ? typed : sel === 'a[href]' ? links : []),
  };
  const location = { origin, hostname: new URL(origin).hostname, href: url };
  const context = vm.createContext({ window: {}, document, location, URL, fetch, setTimeout, clearTimeout, AbortController, TextDecoder });
  context.fetchCalls = fetchCalls;
  context.cancelled = cancelled;
  return context;
}

// ---------- reading source code the way the guard tests do ----------

// The comment stripper the guard tests read source through (test/posting,
// anyDealer, dataInventory and demo): block comments, whole-line // comments
// and, with trailing, a // comment after code. A // right after ":", a quote
// or a backslash is not cut: that is an address ("https://"), a string ('//')
// or the end of a regex literal (/^https?:\/\//), with code after it.
// It is a regex, so it trusts every "/*" to open a comment; the files it reads
// are held to that by commentStripperBlindSpots below.
export function stripComments(src, { trailing = false } = {}) {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return trailing ? out.replace(/([^:'"`\\])\/\/[^\n]*$/gm, '$1') : out;
}

// Every place in a source file where stripComments would cut real code: a
// "/*" inside a string or template literal, a "/*" inside a // comment that
// is not closed on its line, and a block comment that runs past its line
// after code on its first line (how a "/*" inside a regex literal shows up).
// Each would make the stripper delete everything up to the next "*/", so a
// guard test reading the file would not see that code. [] when the file is safe.
export function commentStripperBlindSpots(src) {
  const out = [];
  let line = 1;
  let state = 'code'; // code | line | block | ' | " | `
  let codeOnLine = false;
  let block = null;
  const holes = []; // the ${ } of the template literals we are inside, innermost last
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    const d = src[k + 1];
    if (c === '\n') {
      line += 1;
      codeOnLine = false;
      if (state === 'line' || state === "'" || state === '"') state = 'code';
      continue;
    }
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; k += 1; continue; }
      if (c === '/' && d === '*') { state = 'block'; block = { line, afterCode: codeOnLine }; k += 1; continue; }
      if (!/\s/.test(c)) codeOnLine = true;
      if (c === "'" || c === '"' || c === '`') state = c;
      else if (c === '{' && holes.length) holes[holes.length - 1] += 1;
      else if (c === '}' && holes.length) {
        if (holes[holes.length - 1] === 0) { holes.pop(); state = '`'; } else holes[holes.length - 1] -= 1;
      }
    } else if (state === 'block') {
      if (c === '*' && d === '/') {
        if (block.afterCode && line > block.line) out.push(`line ${block.line}: a block comment that runs past its line starts after code`);
        state = 'code';
        codeOnLine = true;
        k += 1;
      }
    } else if (state === 'line') {
      if (c === '/' && d === '*') {
        // the stripper cuts from here to the next "*/"; harmless only when that is on this line or nowhere
        const eol = src.indexOf('\n', k);
        const close = src.indexOf('*/', k + 2);
        if (close >= 0 && eol >= 0 && close > eol) out.push(`line ${line}: "/*" inside a // comment`);
      }
    } else if (c === '\\') {
      if (d === '\n') line += 1;
      k += 1;
    } else if (state === '`' && c === '$' && d === '{') {
      holes.push(0);
      state = 'code';
      k += 1;
    } else if (c === state) {
      state = 'code';
      codeOnLine = true;
    } else if (c === '/' && d === '*') {
      out.push(`line ${line}: "/*" inside a ${state === '`' ? 'template literal' : 'string'}`);
    }
  }
  return out;
}

// The source files the guard tests read through stripComments: the extension,
// the rewrite service, the manager view, the website, the Edge Functions and
// the sandbox. Paths relative to the repository root.
export function strippedSourceFiles() {
  const root = new URL('../', import.meta.url);
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      if (d.name === 'node_modules') continue;
      if (d.isDirectory()) walk(dir + d.name + '/');
      else if (/\.(m?js|ts)$/.test(d.name)) out.push(dir + d.name);
    }
  };
  for (const dir of ['extension/', 'backend/', 'manager/', 'site/', 'supabase/functions/', 'demo/']) walk(dir);
  return out;
}

// ---------- reading code: the self-containment and fill-code guards ----------
// test/adapters.test.js and test/posting.test.js check, with these, that a
// function Chrome copies into a page reaches nothing declared around it
// (moduleScopeNames, freeIdentifiers), and test/posting.test.js reads the
// fill code's calls with callArguments. One copy, so the two guards cannot
// drift apart.

// Strings become "", except what a template literal interpolates: the code
// inside each ${...} is kept (scanned the same way, so a string or template
// inside it is handled too), since a name used there is reached like any other.
export function stripStrings(src) {
  const n = src.length;
  const quoted = (q, j) => { // index after the closing quote (a quote string never spans lines)
    for (j += 1; j < n && src[j] !== q && src[j] !== '\n'; j += 1) if (src[j] === '\\') j += 1;
    return j + 1;
  };
  const code = (j, inInterpolation) => { // [code with strings stripped, index of the closing brace or the end]
    let out = '';
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === "'" || c === '"') { out += '""'; j = quoted(c, j); continue; }
      if (c === '`') {
        out += '""';
        for (j += 1; j < n && src[j] !== '`'; j += 1) {
          if (src[j] === '\\') { j += 1; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { const [inner, end] = code(j + 2, true); out += ' (' + inner + ') '; j = end; }
        }
        j += 1;
        continue;
      }
      if (c === '{') depth += 1;
      if (c === '}') { if (inInterpolation && depth === 0) return [out, j]; depth -= 1; }
      out += c;
      j += 1;
    }
    return [out, j];
  };
  return code(0, false)[0];
}
export const JS_KEYWORDS = new Set('async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined'.split(' '));

// Every name declared at the top level of a module file: what an injected
// function must not reach for. The import lines give the imported names
// (default, { named }, * as namespace). Every other top-level name is left to
// the JavaScript parser itself, so a declaration of several names, a
// destructured one, a function or a class is never missed: the file with its
// import and export words taken out compiles as a strict script, and adding
// `let NAME;` to it is a syntax error exactly when NAME is already declared
// at the top. Nothing in the file runs.
export function moduleScopeNames(src) {
  const imported = new Set();
  for (const m of src.matchAll(/^import\s+([^'"]*?)\s*from\s*['"]/gm)) {
    const clause = m[1];
    const named = clause.match(/\{([^}]*)\}/);
    if (named) for (const part of named[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) imported.add(n); }
    const rest = clause.replace(/\{[^}]*\}/, '');
    const namespace = rest.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) imported.add(namespace[1]);
    const byDefault = rest.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (byDefault) imported.add(byDefault[1]);
  }
  const script = "'use strict';\n" + src
    .replace(/^import\s[^'"]*['"][^'"\n]*['"]\s*;?/gm, '')
    .replace(/^export\s*\{[^}]*\}(?:\s*from\s*['"][^'"\n]*['"])?\s*;?/gm, '')
    .replace(/^export\s*\*[^'"\n]*['"][^'"\n]*['"]\s*;?/gm, '')
    .replace(/^export\s+default\s+(?=(?:async\s+)?function\b\s*\*?\s*[A-Za-z_$]|class\s+(?!extends\b)[A-Za-z_$])/gm, '')
    .replace(/^export\s+default\s+/gm, 'void ')
    .replace(/^export\s+/gm, '');
  try {
    new vm.Script(script);
  } catch (e) {
    throw new Error(`the self-containment check cannot read this file's top-level names: ${e.message}`);
  }
  const seen = new Map();
  const declared = (name) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
    if (!seen.has(name)) {
      let clash = false;
      try {
        new vm.Script(`${script}\nlet ${name};`);
      } catch (e) {
        clash = e.name === 'SyntaxError' && /already been declared/.test(e.message);
      }
      seen.set(name, clash);
    }
    return seen.get(name);
  };
  return { has: (name) => imported.has(name) || declared(name) };
}

// Identifiers a function body uses that are not property names.
export function freeIdentifiers(fnSrc, ownName) {
  const code = stripStrings(stripComments(fnSrc, { trailing: true }));
  const out = new Set();
  for (const m of code.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) if (!JS_KEYWORDS.has(m[0]) && m[0] !== ownName) out.add(m[0]);
  return out;
}

// The arguments of every call to `name(` in src (a free call or a method
// call such as h.key(...), not a function of that name being defined), each call's list split at its
// top-level commas, every argument trimmed. Parentheses, brackets, braces,
// strings and template literals are balanced, so
// key(control.closest('[role="button"]'), ' ') gives
// ["control.closest('[role=\"button\"]')", "' '"].
export function callArguments(src, name) {
  const out = [];
  for (const m of src.matchAll(new RegExp(`(?<![\\w$])(?<!\\bfunction\\s+)${name}\\s*\\(`, 'g'))) {
    const args = [];
    let depth = 0;
    let from = m.index + m[0].length;
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        for (i += 1; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i += 1;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth -= 1;
      else if (c === ')') {
        args.push(src.slice(from, i).trim());
        out.push(args.length === 1 && args[0] === '' ? [] : args);
        break;
      } else if (c === ',' && depth === 0) {
        args.push(src.slice(from, i).trim());
        from = i + 1;
      }
    }
  }
  return out;
}
