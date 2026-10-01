import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { startMockSite } from './e2e/mock-dealer-site.mjs';
import dealerInspire, { scan, getDetails, makeDirectSearch, detect, trimRecord, FIELDS, probeInPage, searchInPage, origins, scanOptions, photoOrigins } from '../extension/adapters/dealerInspire.js';
import { ADAPTERS, detectAdapter, adapterById, adapterForService, unsupportedSiteMessage, platformNames } from '../extension/adapters/index.js';
import { VEHICLE_FIELDS } from '../extension/src/vehicle.js';
import { scanWithSearch, incompleteWarning, searchViaTab } from '../extension/src/scanRunner.js';
import { probeSiteInPage } from '../extension/src/scan.js';
import { withDefaults } from '../extension/src/settings.js';
import schemaOrg, { PAGE_TEXT_LIMIT, CONCURRENCY, MAX_LIST_PAGES, MAX_SITEMAPS, ROBOTS_TEXT_LIMIT, MAX_FAILED_IN_A_ROW, MAX_ADDRESSES_PER_CAR, REQUEST_TIMEOUT_MS, learnCarAddressShape, matchesCarAddressShape, vinInAddress, oneAddressPerCar } from '../extension/adapters/schemaOrg.js';
import { fetchVehicleDetails } from '../extension/src/vehicleDetails.js';
import { cleanDescription } from '../extension/src/description.js';
import { DEALERON_ORIGIN, DEALERON_LIST, DEALERCOM_ORIGIN, DEALERCOM_LIST, platformCars, dealerOnSite, dealerComSite, dealerOnCard, dealerComRecord, dealerOnPath, dealerComPath, platformSearch, fakePlatformPage } from './platformSites.js';
import { fixtures, sampleVin, fakeDealerPage, fakeChrome, runInPage, STANDARD_ORIGIN, standardCars, standardSite, standardCarNode, standardCarPage, standardListPage, httpError, fakeSiteSearch, fakeStandardPage } from './helpers.js';

const records = Object.entries(fixtures).filter(([k]) => k !== '_about').map(([, r]) => ({ ...r, media: { ...r.media, images: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'] } }));

// A stand-in for the search service: filters, pages, counts. `unstable` makes
// page 1 repeat a car and drop another, like the real service sometimes does.
function fakeSearch(all, { unstable = false, fail = false } = {}) {
  const calls = [];
  const search = async (body) => {
    calls.push(body);
    if (fail) throw new Error('boom');
    const f = body.filters || {};
    let list = all.filter((r) => (!f.type || f.type.includes(r.type)) && (!f.vin || f.vin.includes(r.vin)) && (!f.status || f.status.includes(r.status)));
    const total = list.length;
    if (unstable && !body.sort && list.length > 2) list = [list[0], list[0], ...list.slice(2)]; // drops list[1]
    const start = (body.page - 1) * body.perPage;
    return { total_vehicle_count: total, listings: list.slice(start, start + body.perPage) };
  };
  search.calls = calls;
  return search;
}

// ---------- the contract every adapter keeps (README.md) ----------

// Per platform: a record of its shape, the service its probe returns, a
// search(request) that answers like its service, its own page for the
// in-page functions (page), a page it must not claim (bare), one in-page
// search request and what its answer carries, a car the last scan had that
// is gone now (missing: the VIN and the options that let scan check it),
// and a record at a given store (atStore). A new adapter needs its entry
// here (and a record or page in test/fixtures/).
const LOT = standardCars(6);
const GONE = standardCars(1, { from: 50 })[0];
const PLATFORM_LOT = platformCars(6);
const PLATFORM_GONE = platformCars(1, { from: 40 })[0];
const PLATFORM_FIXTURES = {
  dealerInspire: {
    record: fixtures.usedNormal,
    service: { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/1', apiKey: 'k', visibleStatusValues: ['publish', 'modified'], hasHelper: true },
    search: () => fakeSearch(records),
    page: () => fakeDealerPage({ records }),
    bare: () => fakeDealerPage({ withService: false }),
    request: { page: 1, perPage: 50, filters: { type: ['Used'] } },
    answered: (data) => Array.isArray(data.listings),
    missing: { vin: 'NOPE', options: { confirmVins: ['NOPE'] } },
    atStore: (name) => ({ ...records[0], extra_fields: { ...records[0].extra_fields, meta_location: name } }),
  },
  schemaOrg: {
    record: { node: standardCarNode(LOT[0]), url: STANDARD_ORIGIN + LOT[0].path, facts: { title: '', text: `$${LOT[0].price.toLocaleString('en-US')} ${LOT[0].miles.toLocaleString('en-US')} miles`, carfaxLinks: [] } },
    service: { kind: 'schemaOrg', origin: STANDARD_ORIGIN, listUrl: STANDARD_ORIGIN + '/used-vehicles/' },
    search: () => fakeSiteSearch(standardSite({ cars: LOT })),
    page: () => fakeStandardPage({ site: standardSite({ cars: LOT }) }),
    bare: () => fakeStandardPage({ html: '<html><head><title>About us | Sample Motors</title></head><body><a href="/">Home</a> <a href="/about/">About</a></body></html>', path: '/about/' }),
    request: { url: STANDARD_ORIGIN + '/used-vehicles/' },
    answered: (data) => data.status === 200 && /ItemList/.test(data.text),
    missing: { vin: GONE.vin, options: { confirmVins: [GONE.vin], confirmUrls: { [GONE.vin]: STANDARD_ORIGIN + GONE.path } } },
    atStore: (name) => {
      const node = standardCarNode(LOT[0]);
      return { node: { ...node, offers: { ...node.offers, seller: { '@type': 'AutoDealer', name } } }, url: STANDARD_ORIGIN + LOT[0].path, facts: { title: '', text: `$${LOT[0].price.toLocaleString('en-US')}`, carfaxLinks: [] } };
    },
  },
  dealerOn: {
    record: { card: dealerOnCard(PLATFORM_LOT[0]).VehicleCard, origin: DEALERON_ORIGIN },
    service: { kind: 'dealerOn', origin: DEALERON_ORIGIN, inventoryUrl: DEALERON_LIST, listUrl: DEALERON_ORIGIN + '/searchused.aspx' },
    search: () => platformSearch(dealerOnSite({ cars: PLATFORM_LOT, gone: [PLATFORM_GONE] })),
    page: () => fakePlatformPage({ site: dealerOnSite({ cars: PLATFORM_LOT }), origin: DEALERON_ORIGIN, path: '/searchused.aspx', requested: [DEALERON_LIST], text: 'Copyright © 2026 by DealerOn' }),
    bare: () => fakePlatformPage({ origin: DEALERON_ORIGIN, path: '/about-us.aspx', text: 'About us' }),
    request: { url: DEALERON_LIST },
    answered: (data) => data.status === 200 && Array.isArray(data.json.DisplayCards),
    missing: { vin: PLATFORM_GONE.vin, options: { confirmVins: [PLATFORM_GONE.vin], confirmUrls: { [PLATFORM_GONE.vin]: DEALERON_ORIGIN + dealerOnPath(PLATFORM_GONE) } } },
    atStore: (name) => ({ card: { ...dealerOnCard(PLATFORM_LOT[0]).VehicleCard, DealerName: name }, origin: DEALERON_ORIGIN }),
  },
  dealerCom: {
    record: { card: dealerComRecord(PLATFORM_LOT[0]), origin: DEALERCOM_ORIGIN },
    service: { kind: 'dealerCom', origin: DEALERCOM_ORIGIN, inventoryUrl: DEALERCOM_LIST, listUrl: DEALERCOM_ORIGIN + '/used-inventory/index.htm' },
    search: () => platformSearch(dealerComSite({ cars: PLATFORM_LOT, gone: [PLATFORM_GONE] })),
    page: () => fakePlatformPage({ site: dealerComSite({ cars: PLATFORM_LOT }), origin: DEALERCOM_ORIGIN, path: '/used-inventory/index.htm', requested: [DEALERCOM_LIST], windowExtras: { DDC: {} } }),
    bare: () => fakePlatformPage({ origin: DEALERCOM_ORIGIN, path: '/about-us.htm', text: 'About us' }),
    request: { url: DEALERCOM_LIST },
    answered: (data) => data.status === 200 && Array.isArray(data.json.inventory),
    missing: { vin: PLATFORM_GONE.vin, options: { confirmVins: [PLATFORM_GONE.vin], confirmUrls: { [PLATFORM_GONE.vin]: DEALERCOM_ORIGIN + dealerComPath(PLATFORM_GONE) } } },
    atStore: (name) => ({ card: { ...dealerComRecord(PLATFORM_LOT[0]), address: { accountName: name } }, origin: DEALERCOM_ORIGIN }),
  },
};

const CONTRACT = ['probeInPage', 'searchInPage', 'detect', 'origins', 'scanOptions', 'scan', 'getDetails', 'normalize', 'makeDirectSearch', 'photoOrigins'];
const IN_PAGE = ['probeInPage', 'searchInPage'];
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`\\])\/\/[^\n]*$/gm, '$1');
// Strings become "", except what a template literal interpolates: the code
// inside each ${...} is kept (scanned the same way, so a string or template
// inside it is handled too), since a name used there is reached like any other.
function stripStrings(src) {
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
const KEYWORDS = new Set('async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined'.split(' '));

// Every name declared at the top level of a module file: what an injected
// function must not reach for.
function moduleScopeNames(src) {
  const names = new Set();
  for (const m of stripComments(src).matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?/gm)) {
    if (m[1]) names.add(m[1]);
    if (m[2]) for (const part of m[2].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  }
  return names;
}

// Identifiers a function body uses that are not property names.
function freeIdentifiers(fnSrc, ownName) {
  const code = stripStrings(stripComments(fnSrc));
  const out = new Set();
  for (const m of code.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) if (!KEYWORDS.has(m[0]) && m[0] !== ownName) out.add(m[0]);
  return out;
}

test('every adapter has a PLATFORM and every function of the contract', () => {
  assert.ok(ADAPTERS.length >= 1);
  const ids = new Set();
  for (const a of ADAPTERS) {
    assert.match(a.PLATFORM.id, /^[a-z][A-Za-z0-9]*$/, 'PLATFORM.id is a plain key');
    assert.ok(typeof a.PLATFORM.name === 'string' && a.PLATFORM.name.trim(), 'PLATFORM.name is what people see');
    assert.ok(!ids.has(a.PLATFORM.id), `duplicate adapter id ${a.PLATFORM.id}`);
    ids.add(a.PLATFORM.id);
    for (const fn of CONTRACT) assert.equal(typeof a[fn], 'function', `${a.PLATFORM.id}.${fn} is missing`);
    assert.ok(PLATFORM_FIXTURES[a.PLATFORM.id], `${a.PLATFORM.id} needs a record, service and search in PLATFORM_FIXTURES`);
  }
});

// The check itself: a function that reaches a name declared at the top of
// its module, in plain code or inside a template literal's ${...}, is found.
test('the self-containment check sees a module name used in code and inside ${...}, and not one inside a plain string', () => {
  const outside = moduleScopeNames("const LIMIT = 3;\nconst ADDRESS_RE = /x/;\nexport function f() {}\n");
  const reached = (fnSrc) => [...freeIdentifiers(fnSrc, 'g')].filter((id) => outside.has(id));
  assert.deepEqual(reached('function g() { return ADDRESS_RE.exec(document.body.innerText); }'), ['ADDRESS_RE']);
  assert.deepEqual(reached('function g(r) { r.cancel(`${f.name}: cut at ${LIMIT} characters`); }'), ['f', 'LIMIT']);
  assert.deepEqual(reached('function g(r) { r.cancel(`a ${`nested ${LIMIT}`} b`); }'), ['LIMIT']);
  assert.deepEqual(reached('function g(r) { const o = { a: 1 }; return `${o.a} ${({ b: 2 }).b}`; }'), []);
  assert.deepEqual(reached("function g() { return 'LIMIT' + \"ADDRESS_RE\" + `f`; }"), []);
});

// Every function chrome.scripting.executeScript copies into a page: each
// adapter's two, the neutral site probe (src/scan.js) and the Facebook form
// functions (facebook/fillForm.js, every export of which is injected).
test('the in-page functions are self-contained: no import, nothing from the module around them', async () => {
  const dir = new URL('../extension/adapters/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.js$/.test(f) && f !== 'index.js').map((f) => [new URL(f, dir), IN_PAGE]);
  files.push([new URL('../extension/src/scan.js', import.meta.url), ['probeSiteInPage']]);
  const fill = new URL('../extension/facebook/fillForm.js', import.meta.url);
  files.push([fill, Object.keys(await import(fill))]);
  let checked = 0;
  for (const [url, names] of files) {
    const file = url.pathname.split('/extension/').pop();
    const src = readFileSync(url, 'utf8');
    const mod = await import(url);
    const outside = moduleScopeNames(src);
    for (const name of names) {
      if (typeof mod[name] !== 'function') continue;
      const fnSrc = String(mod[name]);
      assert.ok(!/\bimport\b|\brequire\s*\(/.test(stripStrings(stripComments(fnSrc))), `${file} ${name} must not import`);
      const reached = [...freeIdentifiers(fnSrc, name)].filter((id) => outside.has(id));
      assert.deepEqual(reached, [], `${file} ${name} reaches outside its own body for: ${reached.join(', ')}`);
      checked += 1;
    }
  }
  const fillNames = Object.keys(await import(fill));
  assert.ok(fillNames.length >= 5 && fillNames.every((n) => /InPage$/.test(n)), 'fillForm.js exports only injected functions');
  assert.equal(checked, ADAPTERS.length * IN_PAGE.length + 1 + fillNames.length, 'every adapter exports both in-page functions from its own file');
});

// The neutral probe's second way to the store's address, a line of the page
// text, run where Chrome runs it: a page with no structured address.
test('probeSiteInPage reads the address from the page text when the page has no structured address, in a bare page', async () => {
  const page = fakeDealerPage({ records: [], withLd: false, bodyText: 'USED CARS\nVisit us at 200 Main Street, Springfield, OH 43215 today' });
  const site = await runInPage(page, probeSiteInPage);
  assert.deepEqual(site.address, { street: '200 Main Street', city: 'Springfield', state: 'OH', zip: '43215', phone: '', source: 'page text' });
  assert.equal(site.name, 'Example Motors');
});

test('probeInPage and searchInPage run in a bare page with nothing else in scope', async () => {
  for (const a of ADAPTERS) {
    const fx = PLATFORM_FIXTURES[a.PLATFORM.id];
    const page = fx.page();
    const service = await runInPage(page, a.probeInPage);
    assert.ok(service && typeof service === 'object', `${a.PLATFORM.id}.probeInPage returns its service on its own platform's page`);
    assert.equal(a.detect({ site: {}, service, adapterId: null }), true, `${a.PLATFORM.id}.detect recognises what its probe returned`);
    const r = await runInPage(page, a.searchInPage, service, fx.request);
    assert.equal(r.ok, true);
    assert.ok(r.data && fx.answered(r.data), `${a.PLATFORM.id}.searchInPage answers { ok, data }`);
    assert.equal(await runInPage(fx.bare(), a.probeInPage), null, `${a.PLATFORM.id}.probeInPage is null on a page without its service`);
  }
});

// Each probe answers only on its own kind of page, and each detect only for
// its own service, so the order in ADAPTERS decides nothing but which
// adapter reads a page both could read.
test('no adapter claims another\'s page or service', async () => {
  for (const a of ADAPTERS) {
    for (const other of ADAPTERS) {
      if (other === a) continue;
      const fx = PLATFORM_FIXTURES[other.PLATFORM.id];
      assert.equal(a.detect({ site: {}, service: fx.service, adapterId: null }), false, `${a.PLATFORM.id}.detect claims ${other.PLATFORM.id}'s service`);
      assert.equal(adapterForService(fx.service), other, `a stored ${other.PLATFORM.id} service goes back to its own adapter`);
      if (other === schemaOrg) assert.equal(await runInPage(fx.page(), a.probeInPage), null, `${a.PLATFORM.id}.probeInPage answers on ${other.PLATFORM.id}'s page`);
    }
  }
  // the generic reader comes last, so a platform's own probe wins on its pages
  assert.equal(ADAPTERS[ADAPTERS.length - 1], schemaOrg);
});

test('scan, getDetails, normalize, origins, scanOptions and photoOrigins return the documented shapes', async () => {
  for (const a of ADAPTERS) {
    const fx = PLATFORM_FIXTURES[a.PLATFORM.id];
    const options = a.scanOptions(fx.service);
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    const res = await a.scan(fx.search(), { ...options, ...fx.missing.options });
    // the optional keys, each only when there are some: unread (cars still
    // listed whose details this scan did not read), pagesRead (cars whose own
    // page this scan read) and leftForLater (pages the page limit left)
    const { unread, pagesRead, leftForLater, ...shape } = res;
    assert.deepEqual(Object.keys(shape).sort(), ['complete', 'confirm', 'fetchedAt', 'ok', 'records', 'requests', 'total'], `${a.PLATFORM.id}.scan return shape`);
    assert.ok(unread === undefined || (Array.isArray(unread) && unread.length > 0), `${a.PLATFORM.id}.scan unread, when given, lists VINs`);
    assert.ok(pagesRead === undefined || (Array.isArray(pagesRead) && pagesRead.length > 0 && pagesRead.every((v) => res.records.some((r) => a.normalize(r).vin === v))), `${a.PLATFORM.id}.scan pagesRead, when given, lists VINs of this scan's cars`);
    assert.ok(leftForLater === undefined || (Number.isInteger(leftForLater) && leftForLater > 0), `${a.PLATFORM.id}.scan leftForLater, when given, counts pages`);
    assert.deepEqual(Object.keys(res.confirm).sort(), ['checked', 'error', 'notFound']);
    assert.equal(res.ok, true);
    assert.ok(!Number.isNaN(Date.parse(res.fetchedAt)));
    assert.equal(typeof res.total, 'number');
    assert.equal(typeof res.complete, 'boolean');
    assert.ok(res.requests >= 1 && Array.isArray(res.records) && res.records.length);
    assert.deepEqual(res.confirm.notFound, [fx.missing.vin]);
    for (const r of res.records) {
      const v = a.normalize(r);
      assert.deepEqual(Object.keys(v).sort(), [...VEHICLE_FIELDS].sort(), `${a.PLATFORM.id}.normalize returns exactly VEHICLE_FIELDS`);
      assert.equal(v.vin, v.vin.toUpperCase());
    }
    const fixtureVehicle = a.normalize(fx.record);
    assert.deepEqual(Object.keys(fixtureVehicle).sort(), [...VEHICLE_FIELDS].sort());
    assert.equal(a.normalize({}), null, 'no VIN, no vehicle');
    const vin = fixtureVehicle.vin;
    const d = await a.getDetails(fx.search(), vin.toLowerCase(), options);
    assert.deepEqual(Object.keys(d).sort(), ['fetchedAt', 'ok', 'record']);
    assert.equal(d.record && a.normalize(d.record).vin, vin);
    const gone = await a.getDetails(fx.search(), 'NOPE', options);
    assert.equal(gone.ok, true);
    assert.equal(gone.record, null);
    const o = a.origins(fx.service);
    assert.ok(Array.isArray(o) && o.length, `${a.PLATFORM.id}.origins names the hosts background work needs`);
    for (const p of o) assert.match(p, /^https?:\/\/[^/]+\/\*$/, 'a host-permission pattern');
    assert.deepEqual(a.origins(null), []);
    const hosts = a.photoOrigins(res.records);
    assert.ok(Array.isArray(hosts));
    for (const h of hosts) assert.match(h, /^https?:\/\/[^/]+$/, 'an origin, not a pattern: recorded, never requested');
    assert.deepEqual(a.photoOrigins(null), []);
    assert.equal(typeof a.makeDirectSearch(fx.service), 'function');
  }
});

test('the registry: by id, by probe, by stored service, and the unsupported-page message names every platform', () => {
  assert.equal(adapterById('dealerInspire'), dealerInspire);
  assert.equal(adapterById('nope'), null);
  assert.equal(detectAdapter({ site: {}, service: null, adapterId: 'dealerInspire' }), dealerInspire, 'the probe that answered wins');
  assert.equal(detectAdapter({ site: {}, service: { search: 'https://x', apiKey: 'k' }, adapterId: null }), dealerInspire, 'else the service shape');
  assert.equal(detectAdapter({ site: {}, service: null, adapterId: null }), null);
  assert.equal(detectAdapter(null), null);
  assert.equal(adapterForService({ search: 'https://x', apiKey: 'k' }), dealerInspire);
  assert.equal(adapterForService({ nothing: true }), null);
  assert.equal(adapterForService(null), null);
  assert.equal(adapterById('schemaOrg'), schemaOrg);
  assert.equal(detectAdapter({ site: {}, service: { kind: 'schemaOrg', origin: 'https://x.test', listUrl: null }, adapterId: null }), schemaOrg);
  assert.deepEqual(platformNames(), ['Dealer Inspire', 'DealerOn', 'Dealer.com', 'Standard vehicle data (schema.org)']);
  assert.equal(unsupportedSiteMessage(), "Lot Current can't read the cars on this page. What it reads today: Dealer Inspire; DealerOn; Dealer.com; Standard vehicle data (schema.org). Open your dealership's used inventory page and try again.");
  for (const a of ADAPTERS) assert.ok(unsupportedSiteMessage().includes(a.PLATFORM.name));
});

// ---------- Dealer Inspire ----------

test('detect: the probe must show the search service', () => {
  assert.equal(detect({ service: { search: 'https://x/api/v1/listings/1', apiKey: 'k' } }), true);
  assert.equal(detect({ service: { search: 'https://x/api/v1/listings/1' } }), false, 'no key, no service');
  assert.equal(detect({ service: null }), false);
  assert.equal(detect(null), false);
  assert.equal(dealerInspire.PLATFORM.name, 'Dealer Inspire');
});

test('probeInPage reads window.SEARCH_SERVICE the way the page defines it and makes the address absolute', async () => {
  const page = fakeDealerPage({ origin: 'https://dealer.example' });
  const service = await runInPage(page, probeInPage);
  assert.deepEqual(service, { search: 'https://dealer.example/api/v1/listings/1', apiKey: 'test-key', visibleStatusValues: ['publish', 'modified', 'pend-sale'], hasHelper: true });
  const bare = fakeDealerPage();
  bare.window.SEARCH_SERVICE = { apiKey: 'k', search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/9', visibleStatusValues: [] };
  delete bare.window.IDPSearchServiceHelper;
  assert.deepEqual(await runInPage(bare, probeInPage), { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/9', apiKey: 'k', visibleStatusValues: null, hasHelper: false });
  bare.window.SEARCH_SERVICE = { search: 'https://x' };
  assert.equal(await runInPage(bare, probeInPage), null, 'no key, no service');
});

test('searchInPage uses the page helper when there is one, else the same POST with the x-api-key', async () => {
  const page = fakeDealerPage({ records });
  const viaHelper = await runInPage(page, searchInPage, { search: 'https://x', apiKey: 'k' }, { page: 1, perPage: 50, filters: { vin: [fixtures.usedNormal.vin] } });
  assert.equal(viaHelper.ok, true);
  assert.equal(viaHelper.data.listings.length, 1);
  const bare = fakeDealerPage({ withService: false });
  let seen;
  bare.fetch = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ data: { total_vehicle_count: 0, listings: [] } }) }; };
  const viaFetch = await runInPage(bare, searchInPage, { search: 'https://x/api/v1/listings/1/', apiKey: 'KEY' }, { page: 1 });
  assert.deepEqual(viaFetch, { ok: true, data: { total_vehicle_count: 0, listings: [] } });
  assert.equal(seen.url, 'https://x/api/v1/listings/1/search');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-api-key'], 'KEY');
  bare.fetch = async () => ({ ok: false, status: 503 });
  const bad = await runInPage(bare, searchInPage, { search: 'https://x', apiKey: 'k' }, {});
  assert.deepEqual(bad, { ok: false, error: 'inventory search returned 503' });
  bare.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await runInPage(bare, searchInPage, { search: 'https://x', apiKey: 'k' }, {}), { ok: false, error: 'offline' });
});

// The mock dealer site the end-to-end tests drive (a Dealer Inspire
// look-alike): its own page script defines window.SEARCH_SERVICE and the
// helper, so running that script in the sandbox and then the adapter's
// in-page functions is the same detection the popup does in Chrome.
test('the mock dealer site is detected and read through the adapter\'s probe, its in-tab search and its direct search', async () => {
  const server = await startMockSite(0);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(origin + '/used-vehicles/')).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    const page = fakeDealerPage({ withService: false, origin });
    page.fetch = (path, init) => fetch(new URL(path, origin), init); // the helper fetches /inventory.json relative to the page
    vm.runInContext(script, page);
    const service = await runInPage(page, probeInPage);
    assert.deepEqual(service, { search: origin + '/api/v1/listings/153146', apiKey: 'test-key', visibleStatusValues: ['publish', 'modified', 'pend-sale'], hasHelper: true });
    assert.equal(detectAdapter({ site: {}, service, adapterId: null }), dealerInspire);
    assert.deepEqual(origins(service), [origin + '/*']);
    // the popup's way: the search made inside the tab
    const viaTab = async (body) => {
      const r = await runInPage(page, searchInPage, service, body);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    };
    const res = await scan(viaTab, scanOptions(service));
    assert.equal(res.ok, true);
    assert.equal(res.complete, true);
    assert.equal(res.records.length, 6, 'the six used and certified cars of day 1');
    assert.ok(res.records.every((r) => r.type !== 'New'));
    assert.deepEqual(photoOrigins(res.records), [origin], 'the mock serves its own photos');
    // the background rescan's way: the service called directly
    const direct = await scan(makeDirectSearch(service), scanOptions(service));
    assert.equal(direct.ok, true);
    assert.deepEqual(direct.records.map((r) => r.vin).sort(), res.records.map((r) => r.vin).sort());
    const one = await getDetails(viaTab, fixtures.usedNormal.vin, scanOptions(service));
    assert.equal(one.record.media.images.length, 3, 'every photo of the Ram (the mock gives it 3)');
    assert.equal(dealerInspire.normalize(one.record).descriptionRaw.length > 0, true, 'the mock adds a description');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('origins, scanOptions and photoOrigins read the service and the records; nothing else does', () => {
  assert.deepEqual(origins({ search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/153146', apiKey: 'k' }), ['https://websites-search.api.carscommerce.inc/*']);
  assert.deepEqual(origins({ search: 'http://127.0.0.1:5000/api/v1/listings/1' }), ['http://127.0.0.1:5000/*']);
  assert.deepEqual(origins({ search: 'nope' }), []);
  assert.deepEqual(scanOptions({ visibleStatusValues: ['publish', 'pend-sale'] }), { status: ['publish', 'pend-sale'] });
  assert.deepEqual(scanOptions({ visibleStatusValues: null }), {});
  assert.deepEqual(scanOptions(undefined), {});
  const withHosts = records.map((r, i) => ({ ...r, media: { images: [`https://photos-${i % 2}.example-cdn.test/${r.vin}/1.jpg`, 'relative.jpg'] } }));
  assert.deepEqual(photoOrigins(withHosts), ['https://photos-0.example-cdn.test', 'https://photos-1.example-cdn.test']);
  assert.deepEqual(photoOrigins([{ media: {} }, {}]), []);
});

test('scan reads the used and certified cars in one request and asks for description and features', async () => {
  const search = fakeSearch(records);
  const res = await scan(search);
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.equal(res.records.length, 6); // the new ones are never requested
  assert.ok(res.records.every((r) => r.type !== 'New'));
  assert.equal(res.requests, 1);
  assert.deepEqual(search.calls[0].filters.type, ['Used', 'Certified Used']);
  assert.ok(search.calls[0].requestedFields.includes('description') && search.calls[0].requestedFields.includes('features'));
  assert.equal(FIELDS.length, search.calls[0].requestedFields.length);
  assert.equal(res.records[0].media.images.length, 3, 'the bulk scan keeps 3 photos');
});

test('scan asks for the statuses the website shows (scanOptions), else its own default', async () => {
  const search = fakeSearch(records);
  await scan(search, scanOptions({ visibleStatusValues: ['publish', 'pend-sale'] }));
  assert.deepEqual(search.calls[0].filters.status, ['publish', 'pend-sale']);
  await scan(search, scanOptions({}));
  assert.deepEqual(search.calls[1].filters.status, ['publish', 'modified', 'pend-sale']);
});

test('unstable paging: a repeated car is de-duplicated and the missing one is found in another sort order', async () => {
  const search = fakeSearch(records, { unstable: true });
  const res = await scan(search);
  assert.equal(res.complete, true);
  assert.equal(res.records.length, 6);
  assert.ok(res.requests >= 2);
  assert.equal(new Set(res.records.map((r) => r.vin)).size, 6);
});

test('missing VINs from last time are looked up directly; only a VIN the service cannot find is "not found"', async () => {
  const gone = records.filter((r) => r.vin !== fixtures.usedNormal.vin);
  const search = fakeSearch(gone);
  const res = await scan(search, { confirmVins: [fixtures.usedNormal.vin, fixtures.certified.vin] });
  assert.deepEqual(res.confirm.checked, [fixtures.usedNormal.vin]);
  assert.deepEqual(res.confirm.notFound, [fixtures.usedNormal.vin]);
  assert.deepEqual(search.calls[search.calls.length - 1].filters.vin, [fixtures.usedNormal.vin]);
});

test('a failing service is reported, not guessed around', async () => {
  const res = await scan(fakeSearch(records, { fail: true }));
  assert.equal(res.ok, false);
  assert.match(res.message, /boom/);
  const partial = await scan(fakeSearch(records), { confirmVins: ['X'] });
  assert.equal(partial.confirm.error, null);
});

// A 200 that is not a list of cars (an error object, a page helper that
// resolved nothing) on a lot too small for the "more than half vanished"
// rule: nothing may be called gone, and the scan that read it is not saved.
test('a Dealer Inspire answer that is not a list of cars never makes a car gone, on a 3-car or a 9-car lot, through the page\'s helper or the direct search', async () => {
  const lotOf = (n) => Array.from({ length: n }, (_, i) => ({ ...fixtures.usedNormal, vin: `1C6RR7FT0KS64${1000 + i}`, stock: `S${i}` }));
  const site = { origin: 'https://x', host: 'x', name: 'Test', title: 't', adapter: 'dealerInspire' };
  const service = { search: 'https://x/api/v1/listings/1', apiKey: 'k' };
  const bad = [{ error: 'upstream timeout' }, {}, { total_vehicle_count: 5 }, { listings: [] }, { total_vehicle_count: 4, listings: [] }];
  for (const n of [3, 9]) {
    const lot = lotOf(n);
    const settings = withDefaults({});
    const first = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(lot), site, settings });
    assert.equal(Object.keys(first.snapshot.vehicles).length, n);
    const posted = { [lot[0].vin]: { name: 'a', price: 27163 }, [lot[1].vin]: { name: 'b', price: 27163 } };
    for (const answer of bad) {
      // every answer is this one: the scan fails, so nothing is saved or flagged
      const viaDirect = makeDirectSearch(service, async () => ({ ok: true, status: 200, json: async () => answer }));
      const page = fakeDealerPage({ records: lot });
      page.window.IDPSearchServiceHelper = { getListings: async () => answer };
      globalThis.chrome = fakeChrome(page);
      try {
        for (const [how, search] of [['direct', viaDirect], ['helper', searchViaTab(1, dealerInspire, service)]]) {
          const out = await scanWithSearch({ adapter: dealerInspire, search, site, settings, prevSnapshot: first.snapshot, posted });
          assert.equal(out.ok, false, `${n} cars, ${how}, ${JSON.stringify(answer)}`);
          assert.match(out.message, /Couldn't read the inventory: the inventory search answered/);
        }
      } finally {
        delete globalThis.chrome;
      }
      // the lot reads, but the VIN lookup for the two posted cars missing from it answers this: nothing is gone
      const listed = fakeSearch(lot.slice(2));
      const search = async (body) => (body.filters.vin ? answer : listed(body));
      const out = await scanWithSearch({ adapter: dealerInspire, search, site, settings, prevSnapshot: first.snapshot, posted });
      assert.equal(out.ok, true);
      assert.match(out.res.confirm.error, /the inventory search answered/);
      assert.deepEqual(out.diff.takeDown, [], `${n} cars, VIN lookup answering ${JSON.stringify(answer)}`);
      assert.deepEqual(out.diff.needsALook.map((x) => x.vin).sort(), [lot[0].vin, lot[1].vin].sort());
      assert.match(out.diff.warnings.join(' '), /Couldn't double-check missing cars .*Nothing was marked as gone/);
    }
    // a lot that really is empty says so (a count of 0), and is read as empty
    const empty = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch([]), site, settings, prevSnapshot: first.snapshot, posted });
    assert.equal(empty.ok, true);
    assert.deepEqual([empty.res.confirm.error, empty.res.confirm.notFound.length], [null, n], 'the VIN lookup said 0 too');
  }
});

test('getDetails: one car, every photo, any type', async () => {
  const search = fakeSearch(records);
  const r = await getDetails(search, fixtures.usedNormal.vin.toLowerCase());
  assert.equal(r.ok, true);
  assert.equal(r.record.vin, fixtures.usedNormal.vin);
  assert.equal(r.record.media.images.length, 5, 'the post-time fetch keeps every photo');
  assert.equal(search.calls[0].filters.type, undefined, 'no type filter: a car that became New is still found and then refused');
  const missing = await getDetails(search, 'NOPE');
  assert.equal(missing.ok, true);
  assert.equal(missing.record, null);
});

test('the direct search calls the service the way the page does', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ data: { total_vehicle_count: 0, listings: [] } }) }; };
  const search = makeDirectSearch({ search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/153146', apiKey: 'KEY' }, fetchImpl);
  const data = await search({ page: 1 });
  assert.equal(seen.url, 'https://websites-search.api.carscommerce.inc/api/v1/listings/153146/search');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-api-key'], 'KEY');
  assert.equal(JSON.parse(seen.init.body).page, 1);
  assert.deepEqual(data, { total_vehicle_count: 0, listings: [] });
  const bad = makeDirectSearch({ search: 'https://x/api', apiKey: 'k' }, async () => ({ ok: false, status: 503 }));
  await assert.rejects(bad({}), /503/);
});

test('trimRecord keeps only what the extension reads', () => {
  const t = trimRecord(fixtures.usedNormal);
  assert.deepEqual(Object.keys(t.pricing), ['price', 'our_price', 'internet_price', 'original_price', 'msrp', 'original_price_label']);
  assert.equal(t.description, null);
  assert.deepEqual(t.features, []);
});

// ---------- the store label is a per-website read, settled over the lot ----------

test('normalize labels a store from brand words alone; scanWithSearch settles the label over the lot\'s store names', async () => {
  // a group whose store names share no brand word: only the lot can say what differs per store
  const lot = records.map((r, i) => ({ ...r, extra_fields: { ...r.extra_fields, meta_location: i % 2 ? 'Smith Auto Sales South' : 'Smith Auto Sales North' } }));
  for (const a of ADAPTERS) {
    const alone = a.normalize(PLATFORM_FIXTURES[a.PLATFORM.id].atStore('Smith Auto Sales North'));
    assert.equal(alone.locationShort, 'Smith Auto Sales North', `${a.PLATFORM.id}: one record has no lot to compare with, so the full name stands`);
  }
  const site = { origin: 'https://x', host: 'x', name: 'Smith Auto Sales North', title: 't', adapter: 'dealerInspire' };
  const out = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(lot), site, settings: withDefaults({}), prevSnapshot: null, posted: {} });
  assert.equal(out.ok, true);
  const labels = new Map(out.vehicles.map((v) => [v.location, v.locationShort]));
  assert.deepEqual([...labels.entries()].sort(), [['Smith Auto Sales North', 'North'], ['Smith Auto Sales South', 'South']]);
  // the snapshot carries the settled label, so the popup and the panel show the same words
  assert.deepEqual(new Set(Object.values(out.snapshot.vehicles).map((e) => e.locationShort)), new Set(['North', 'South']));
});

// ---------- websites with standard vehicle data (schemaOrg.js) ----------
// The website is test/helpers.js standardSite: synthetic pages written from
// the public schema.org definitions, served from a Map by fakeSiteSearch.

const O = STANDARD_ORIGIN;
const LIST = O + '/used-vehicles/';
const SERVICE = { kind: 'schemaOrg', origin: O, listUrl: LIST };
const scanSite = (site, options = {}) => schemaOrg.scan(fakeSiteSearch(site), { ...schemaOrg.scanOptions(SERVICE), ...options });
const html = (text, extra = {}) => ({ ok: true, status: 200, contentType: 'text/html', text, ...extra });

test('schemaOrg probe: a list of cars, one car\'s page, a page that links to the used list; nothing on other pages or on Facebook', async () => {
  const site = standardSite({ cars: LOT });
  const on = (path, options = {}) => runInPage(fakeStandardPage({ site, path, ...options }), schemaOrg.probeInPage);
  assert.deepEqual(await on('/used-vehicles/'), SERVICE, 'the list page it ran on');
  assert.deepEqual(await on('/used-vehicles/?page=2'), SERVICE, 'page 2 of the list: the list from its start, through the page\'s own link to it');
  assert.deepEqual(await on('/used-vehicles/?make=honda&sort=price', { html: site.get(LIST).text }), SERVICE, 'a sorted, filtered list: the whole list it links to');
  // a home page titled for used cars, with a few featured cars: the used list it links to, not itself
  const home = `<!doctype html><html><head><title>New &amp; Used Cars | Sample Motors</title></head><body><a href="/new-vehicles/">Shop new</a> <a href="/used-vehicles/">Shop used</a>${LOT.slice(0, 3).map((c) => `<a href="${c.path}">${c.year} ${c.make}</a>`).join(' ')}</body></html>`;
  assert.deepEqual(await on('/', { html: home }), SERVICE);
  // a list whose query selects used cars keeps that parameter; only the page number goes
  const byQuery = `<!doctype html><html><head><title>Inventory | Sample Motors</title></head><body><a href="/inventory/">All</a> <a href="/inventory/?condition=used">Used</a> <a href="/inventory/?condition=used&amp;page=1">1</a>${LOT.slice(0, 3).map((c) => `<a href="${c.path}">${c.year} ${c.make}</a>`).join(' ')}</body></html>`;
  assert.deepEqual(await on('/inventory/?condition=used&page=2', { html: byQuery }), { ...SERVICE, listUrl: O + '/inventory/?condition=used' });
  // a list whose address has no used word and that links to no used page: the page it ran on, whatever its title
  const plain = `<!doctype html><html><head><title>Used Cars | Sample Motors</title></head><body>${LOT.slice(0, 3).map((c) => `<a href="${c.path}">${c.year} ${c.make}</a>`).join(' ')}</body></html>`;
  assert.deepEqual(await on('/cars-for-sale/?page=2', { html: plain }), { ...SERVICE, listUrl: O + '/cars-for-sale/?page=2' });
  // a lot that sells only used cars: its whole list at "/inventory/", titled for used cars, is the list,
  // whatever other address with a used word it links (a trade-in page, a page about one model)
  const cards = LOT.slice(0, 3).map((c) => `<a href="${c.path}">${c.year} ${c.make}</a>`).join(' ');
  for (const [label, extra] of [['a trade-in page', '<a href="/sell-your-used-car/">Sell us your car</a>'], ['a page about one model', '<a href="/used-jeep-wrangler/">Used Jeep Wrangler near you</a>'], ['a page about one used make', '<a href="/used-jeep/">Jeep</a>'], ['its certified cars only', '<a href="/certified-pre-owned/">Certified Pre-Owned</a>'], ['one body style', '<a href="/used-trucks/">Used Trucks</a>'], ['a "Used" link to the home page', '<a href="/">Pre-Owned</a>']]) {
    const usedOnly = `<!doctype html><html><head><title>Used Vehicles for Sale | Sample Motors</title></head><body><a href="/financing/">Financing</a> ${extra} ${cards}</body></html>`;
    assert.deepEqual(await on('/inventory/', { html: usedOnly }), { ...SERVICE, listUrl: O + '/inventory/' }, `used-only lot with ${label}`);
  }
  // the home page is not the list whatever its title; nor is a page whose title names new cars as well
  const usedHome = `<!doctype html><html><head><title>Used Cars for Sale | Sample Motors</title></head><body><a href="/inventory/">Our cars</a> <a href="/used/">Used</a> ${cards}</body></html>`;
  assert.deepEqual(await on('/', { html: usedHome }), { ...SERVICE, listUrl: O + '/used/' });
  assert.deepEqual(await on('/index.html', { html: usedHome }), { ...SERVICE, listUrl: O + '/used/' });
  const both = `<!doctype html><html><head><title>New Cars | Used Cars | Sample Motors</title></head><body><a href="/used-vehicles/">Shop used</a> ${cards}</body></html>`;
  assert.deepEqual(await on('/inventory/', { html: both }), SERVICE);
  // a page titled for used cars that links the whole used list (a specials page) is not the list: the list it links is
  const specials = `<!doctype html><html><head><title>Used Car Specials | Sample Motors</title></head><body><a href="/used-vehicles/">Used</a> ${cards}</body></html>`;
  assert.deepEqual(await on('/specials/', { html: specials }), SERVICE);
  // the link to the used list: the one whose words say so, else the one whose address is only inventory words,
  // before a shorter trade-in page or page about one model
  const nav = `<!doctype html><html><head><title>Sample Motors</title></head><body><a href="/sell-used/">Sell your car</a> <a href="/used-jeep/">Jeep</a> <a href="/inventory/?condition=pre-owned">Pre-Owned</a> ${cards}</body></html>`;
  assert.deepEqual(await on('/', { html: nav }), { ...SERVICE, listUrl: O + '/inventory/?condition=pre-owned' }, 'a link whose words say used inventory');
  const byAddress = `<!doctype html><html><head><title>Sample Motors</title></head><body><a href="/sell-used/">Sell your car</a> <a href="/used-jeep/">Jeep</a> <a href="/used-vehicles/">Inventory</a> ${cards}</body></html>`;
  assert.deepEqual(await on('/', { html: byAddress }), SERVICE, 'an address of inventory words only');
  assert.deepEqual(await on(LOT[0].path), SERVICE, "a car's page: the used list it links to");
  const newList = standardListPage(LOT.slice(0, 3)).replace('Used Vehicles for Sale | Sample Motors', 'New Vehicles | Sample Motors');
  assert.deepEqual(await on('/new-vehicles/', { html: newList }), SERVICE, 'a list that is not the used one: the used list it links to');
  // links alone: two car-page links, no data (a list drawn with little markup)
  const linksOnly = standardListPage(LOT.slice(0, 2), { listData: false });
  assert.deepEqual(await on('/used-vehicles/', { html: linksOnly }), SERVICE);
  const oneLink = standardListPage(LOT.slice(0, 1), { listData: false });
  assert.equal(await on('/used-vehicles/', { html: oneLink }), null, 'one car link is not a list');
  assert.equal(await on('/', {}), null, 'the home page links to the list but shows no cars');
  const offSite = `<html><body>${LOT.slice(0, 3).map((c) => `<a href="https://other.example${c.path}">car</a>`).join('')}</body></html>`;
  assert.equal(await on('/links/', { html: offSite }), null, 'car links on another website do not count');
  const fb = fakeStandardPage({ site, origin: 'https://www.facebook.com', path: '/marketplace/', html: standardListPage(LOT) });
  assert.equal(await runInPage(fb, schemaOrg.probeInPage), null, 'never on Facebook');
  const micro = `<html><head><title>Used cars</title></head><body><div itemscope itemtype="https://schema.org/Car"><span itemprop="name">Used 2019 Honda Civic</span></div></body></html>`;
  assert.deepEqual(await on('/used/', { html: micro }), { ...SERVICE, listUrl: O + '/used/' }, 'microdata counts as vehicle data');
});

test('schemaOrg in-page search: one GET on this website the way the page fetches, anything else refused before a request', async () => {
  const site = standardSite({ cars: LOT });
  const page = fakeStandardPage({ site });
  const r = await runInPage(page, schemaOrg.searchInPage, SERVICE, { url: O + LOT[1].path });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data).sort(), ['contentType', 'finalUrl', 'ok', 'redirected', 'status', 'text']);
  assert.equal(r.data.status, 200);
  assert.match(r.data.text, new RegExp(LOT[1].vin));
  assert.equal(page.fetchCalls.length, 1);
  assert.deepEqual(Object.keys(page.fetchCalls[0].init), ['signal'], 'no method, header or credentials of its own: the page\'s defaults');
  const gone = await runInPage(page, schemaOrg.searchInPage, SERVICE, { url: O + '/nope/' });
  assert.deepEqual([gone.ok, gone.data.ok, gone.data.status], [true, false, 404], 'an HTTP error is an answer, for scan to judge');
  for (const url of ['https://other.example/used-vehicles/', 'http://www.sample-motors.test/used-vehicles/', '', null]) {
    const refused = await runInPage(page, schemaOrg.searchInPage, SERVICE, { url });
    assert.equal(refused.ok, false, `refused: ${url}`);
  }
  const elsewhere = await runInPage(page, schemaOrg.searchInPage, { ...SERVICE, origin: 'https://another-dealer.test' }, { url: LIST });
  assert.equal(elsewhere.ok, false, 'a service for another website is refused in this tab');
  assert.equal(page.fetchCalls.length, 2, 'nothing refused was fetched');
  // a page longer than the cap is cut, not refused: read from the body's
  // stream and the rest cancelled, as in Chrome, or from text() where a
  // browser gives no stream; a multi-byte character split between two
  // chunks still reads whole
  const big = new Map([[LIST, html('<html>' + 'x'.repeat(PAGE_TEXT_LIMIT + 10) + '</html>')]]);
  const streamed = fakeStandardPage({ site: big, html: '<html></html>' });
  const cut = await runInPage(streamed, schemaOrg.searchInPage, SERVICE, { url: LIST });
  assert.equal(cut.data.text.length, PAGE_TEXT_LIMIT);
  assert.deepEqual(streamed.cancelled, [LIST], 'the stream past the cap is cancelled');
  const whole = await runInPage(fakeStandardPage({ site: big, html: '<html></html>', stream: false }), schemaOrg.searchInPage, SERVICE, { url: LIST });
  assert.equal(whole.data.text.length, PAGE_TEXT_LIMIT);
  const accents = new Map([[LIST, html('<html>' + 'é'.repeat(5000) + '</html>')]]);
  const split = fakeStandardPage({ site: accents, html: '<html></html>', chunk: 1001 });
  assert.equal((await runInPage(split, schemaOrg.searchInPage, SERVICE, { url: LIST })).data.text, '<html>' + 'é'.repeat(5000) + '</html>');
  assert.deepEqual(split.cancelled, [], 'a page under the cap is read to its end');
  // the in-page copy carries its own number: it must be the module's
  assert.match(String(schemaOrg.searchInPage), new RegExp(`const LIMIT = ${PAGE_TEXT_LIMIT};`));
});

test('schemaOrg direct search: a GET without cookies or headers of its own, only on the website', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, url, redirected: false, headers: { get: () => 'text/html' }, text: async () => '<html>hi</html>' }; };
  const search = schemaOrg.makeDirectSearch(SERVICE, fetchImpl);
  assert.deepEqual(await search({ url: LIST }), { ok: true, status: 200, finalUrl: LIST, redirected: false, contentType: 'text/html', text: '<html>hi</html>' });
  assert.equal(seen[0].init.credentials, 'omit');
  assert.equal(seen[0].init.method, undefined);
  assert.equal(seen[0].init.headers, undefined, 'no user agent or any other header of Lot Current\'s');
  for (const url of ['https://other.example/', 'http://www.sample-motors.test/', 'https://www.sample-motors.test.evil.example/']) await assert.rejects(search({ url }), /reads only https:\/\/www\.sample-motors\.test/);
  assert.equal(seen.length, 1, 'nothing off the website was fetched');
  assert.deepEqual(schemaOrg.origins(SERVICE), [O + '/*'], 'the website itself, which the wizard already asks for');
  assert.deepEqual(schemaOrg.scanOptions(SERVICE), { origin: O, listUrl: LIST });
  assert.deepEqual(schemaOrg.scanOptions({ ...SERVICE, listUrl: 'https://other.example/used/' }), { origin: O, listUrl: null }, 'a list on another website is never read');
});

test('schemaOrg scan: the list and its rel=next pages to the end, then each car\'s page; complete only when every page was read', async () => {
  const cars = standardCars(10);
  const site = standardSite({ cars, perPage: 4 });
  const search = fakeSiteSearch(site);
  const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
  assert.equal(res.ok, true);
  assert.deepEqual([res.total, res.complete, res.records.length, res.requests], [10, true, 10, 13], '3 list pages, 10 car pages');
  assert.deepEqual(search.calls.slice(0, 3), [LIST, LIST + '?page=2', LIST + '?page=3']);
  assert.ok(!search.calls.includes(O + '/robots.txt'), 'no sitemap needed: the list named every car');
  for (const r of res.records) assert.equal(r.url, O + cars.find((c) => c.vin === r.node.vehicleIdentificationNumber).path, 'each record is read from its own page');
  const v = schemaOrg.normalize(res.records[0]);
  assert.deepEqual([v.price, v.mileage, v.photoCount, v.location, v.inventoryType], [cars[0].price, cars[0].miles, 3, 'Sample Motors', 'Used']);
  assert.deepEqual(schemaOrg.photoOrigins(res.records), ['https://photos.sample-cdn.test']);

  // a next link back to a page already read, or a list page that fails: not complete
  const loop = standardSite({ cars, perPage: 4 });
  loop.set(LIST + '?page=3', html(standardListPage(cars.slice(8), { next: '/used-vehicles/' })));
  const looped = await scanSite(loop);
  assert.deepEqual([looped.ok, looped.complete, looped.total], [true, false, 10]);
  const broken = standardSite({ cars, perPage: 4 });
  broken.set(LIST + '?page=2', httpError(500));
  const partial = await scanSite(broken);
  assert.deepEqual([partial.ok, partial.complete, partial.total], [true, false, 4], 'past a broken page 2, the cars on pages 2 and 3 are unknown');
  // a car page that fails: the list's data keeps the car, the scan is not complete
  const flaky = standardSite({ cars, perPage: 4 });
  flaky.set(O + cars[5].path, httpError(500));
  const one = await scanSite(flaky);
  assert.deepEqual([one.ok, one.complete, one.records.length], [true, false, 10]);
  assert.equal(one.records.find((r) => r.node.vehicleIdentificationNumber === cars[5].vin).carried, true);
  // the list page itself fails, or has no car links (a list drawn by scripts)
  const noList = await scanSite(new Map([[LIST, httpError(500)]]));
  assert.deepEqual([noList.ok, noList.error], [false, 'list-failed']);
  const busy = await scanSite(new Map([[LIST, httpError(503)]]));
  assert.deepEqual([busy.ok, busy.error], [false, 'blocked'], 'a 503 is the website asking to be left alone');
  const drawn = await scanSite(new Map([[LIST, html('<html><head><title>Used</title></head><body><div id="app"></div></body></html>')]]));
  assert.deepEqual([drawn.ok, drawn.error], [false, 'no-cars']);
  assert.match(drawn.message, /draws its list with scripts/);
  const unknown = await schemaOrg.scan(fakeSiteSearch(site), { origin: O, listUrl: null });
  assert.deepEqual([unknown.ok, unknown.error, unknown.requests], [false, 'no-list', 0]);
});

test('schemaOrg scan: a list opened past its first page is read from its first page, along its rel=prev links', async () => {
  const cars = standardCars(10);
  const site = standardSite({ cars, perPage: 4 }); // pages 1 to 3
  for (const from of [LIST + '?page=2', LIST + '?page=3']) {
    const search = fakeSiteSearch(site);
    const res = await schemaOrg.scan(search, { origin: O, listUrl: from });
    assert.deepEqual([res.ok, res.total, res.complete, res.records.length], [true, 10, true, 10], from);
    assert.equal(search.calls.filter((u) => u.startsWith(LIST)).length, 3, 'each list page read once');
  }
  // the way back is broken: the read starts at the earliest page reached, and says it is not complete
  const broken = standardSite({ cars, perPage: 4 });
  broken.set(LIST, httpError(500));
  const partial = await schemaOrg.scan(fakeSiteSearch(broken), { origin: O, listUrl: LIST + '?page=2' });
  assert.deepEqual([partial.ok, partial.total, partial.complete], [true, 6, false]);
  // a refusal on the way back stops the scan, as anywhere else
  const refused = standardSite({ cars, perPage: 4 });
  refused.set(LIST, httpError(429));
  const stopped = await schemaOrg.scan(fakeSiteSearch(refused), { origin: O, listUrl: LIST + '?page=3' });
  assert.deepEqual([stopped.ok, stopped.error], [false, 'blocked']);
  // at post time the list is searched from its first page too
  const post = fakeSiteSearch(site);
  const d = await schemaOrg.getDetails(post, cars[0].vin, { origin: O, listUrl: LIST + '?page=3' });
  assert.equal(d.ok, true);
  assert.equal(schemaOrg.normalize(d.record).vin, cars[0].vin);
  // a list whose first page names its last as the one before: read from where it was asked, complete only when every page was read
  const round = standardSite({ cars, perPage: 4 });
  round.set(LIST, { ...round.get(LIST), text: round.get(LIST).text.replace('<link rel="next"', '<link rel="prev" href="/used-vehicles/?page=3"><link rel="next"') });
  const whole = await schemaOrg.scan(fakeSiteSearch(round), { origin: O, listUrl: LIST });
  assert.deepEqual([whole.ok, whole.total, whole.complete], [true, 10, true], 'from its first page');
  const part = await schemaOrg.scan(fakeSiteSearch(round), { origin: O, listUrl: LIST + '?page=2' });
  assert.deepEqual([part.ok, part.total, part.complete], [true, 6, false], 'from page 2 the first page is never reached going forward, and the scan says so');
});

test('schemaOrg probe and scan: a lot that sells only used cars, its list at an address without a used word, is read whole', async () => {
  const cars = standardCars(12);
  const site = standardSite({ cars, perPage: 12 });
  const list = standardListPage(cars).replaceAll('/used-vehicles/', '/inventory/').replace('</body>', '<a href="/sell-your-used-car/">Sell us your car</a> <a href="/used-jeep-wrangler/">Used Jeep Wrangler near you</a></body>');
  site.set(O + '/inventory/', html(list));
  site.set(O + '/sell-your-used-car/', html('<!doctype html><html><head><title>Sell us your car</title></head><body><form></form></body></html>'));
  const service = await runInPage(fakeStandardPage({ site, path: '/inventory/', html: list }), schemaOrg.probeInPage);
  assert.deepEqual(service, { ...SERVICE, listUrl: O + '/inventory/' });
  const res = await schemaOrg.scan(fakeSiteSearch(site), schemaOrg.scanOptions(service));
  assert.deepEqual([res.ok, res.total, res.complete, res.records.length], [true, 12, true, 12], res.message);
});

test('schemaOrg scan: the sitemap adds only addresses shaped like this lot\'s own car pages', async () => {
  const cars = standardCars(8);
  const site = standardSite({ cars, perPage: 8, sitemap: true, numberOfItems: 8 });
  // the list shows only 5 of its 8 cars (the rest behind a "load more" button)
  site.set(LIST, html(standardListPage(cars.slice(0, 5), { numberOfItems: 8 })));
  const search = fakeSiteSearch(site);
  const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
  assert.equal(res.ok, true);
  assert.ok(search.calls.includes(O + '/robots.txt') && search.calls.includes(O + '/sitemap.xml'));
  assert.deepEqual(res.records.map((r) => r.node.vehicleIdentificationNumber).sort(), cars.map((c) => c.vin).sort(), 'the 3 cars not on the list come from the sitemap');
  assert.equal(res.total, 8);
  assert.equal(res.complete, true);
  assert.ok(!search.calls.some((u) => /new-2027|blog|about/.test(u)), 'a new car, an article and the about page are never read');
  // the shape is learned from this website's own car addresses
  const shape = learnCarAddressShape(cars.slice(0, 5).map((c) => O + c.path));
  assert.equal(matchesCarAddressShape(O + cars[7].path, shape), true);
  assert.equal(matchesCarAddressShape(O + '/inventory/new-2027-kia-telluride-ex-1hgsampl0vh100999/', shape), false);
  assert.equal(matchesCarAddressShape(O + '/blog/2019-honda-civic-review/', shape), false);
  assert.equal(vinInAddress(O + cars[0].path), cars[0].vin);
  // asked for, but the list names too few car pages to learn a shape from: no sitemap address is trusted
  const tiny = standardSite({ cars: cars.slice(0, 1), sitemap: true });
  const t = await scanSite(tiny, { sitemap: true });
  assert.deepEqual([t.ok, t.total, t.complete], [true, 1, false]);
});

test('schemaOrg robots.txt: read for its Sitemap lines in linear time, and only as far as search engines read it', async () => {
  const cars = standardCars(8);
  const withRobots = (text) => {
    const site = standardSite({ cars, perPage: 8, sitemap: true, numberOfItems: 8 });
    site.set(LIST, html(standardListPage(cars.slice(0, 5), { numberOfItems: 8 }))); // 5 of 8 on the list: the sitemap is read
    site.set(O + '/robots.txt', { ok: true, status: 200, contentType: 'text/plain', text });
    return site;
  };
  // a long run of blank lines (CRLF) before the next rule, then an indented Sitemap line
  const started = Date.now();
  const padded = await scanSite(withRobots('\r\n'.repeat(60000) + 'User-agent: *\r\nDisallow: /cart/\r\n\t Sitemap :  ' + O + '/sitemap.xml\r\n'));
  assert.ok(Date.now() - started < 2000, `a robots.txt of 60,000 blank lines took ${Date.now() - started} ms`);
  assert.deepEqual([padded.ok, padded.total, padded.complete], [true, 8, true], 'the Sitemap line after the blank lines is still read');
  // a Sitemap line past ROBOTS_TEXT_LIMIT is ignored, as search engines ignore it
  const long = await scanSite(withRobots('#'.repeat(ROBOTS_TEXT_LIMIT) + '\nSitemap: ' + O + '/sitemap.xml\n'));
  assert.deepEqual([long.ok, long.total], [true, 5]);
});

// A car from the last scan is gone from the list; its own page decides.
test('schemaOrg confirm: gone only on 404, 410, a redirect away, SoldOut or the website\'s data without it; a refusal stops the check, any other failure leaves only that car unchecked', async () => {
  const cars = standardCars(5);
  const gone = standardCars(1, { from: 40 })[0];
  const at = O + gone.path;
  const noLongerAvailable = '<html><head><title>Vehicle no longer available</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoDealer","name":"Sample Motors"}</script></head><body><h1>This vehicle is no longer available</h1></body></html>';
  const cases = [
    ['404', httpError(404), 'gone'],
    ['410', httpError(410), 'gone'],
    ['301 to the list', html(standardListPage(cars), { redirected: true, finalUrl: LIST }), 'gone'],
    ['200 SoldOut', html(standardCarPage(gone, { availability: 'SoldOut' })), 'gone'],
    ['200 with the website\'s data but not the car', html(noLongerAvailable), 'gone'],
    ['200 with the car still for sale', html(standardCarPage(gone)), 'found'],
    ['200 with no structured data at all', html('<html><body><h1>Oops</h1></body></html>'), 'unchecked', /its page has no vehicle data/],
    ['200 bot check', html('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>'), 'error'],
    ['200 not a web page', { ok: true, status: 200, contentType: 'application/json', text: '{}' }, 'unchecked', /its page is not a web page \(application\/json\)/],
    ['403', httpError(403), 'error'],
    ['429', httpError(429), 'error'],
    ['503', httpError(503), 'error'],
    ['500', httpError(500), 'unchecked', /its page gave HTTP 500/],
    ['redirect to another website', html(standardCarPage(gone), { redirected: true, finalUrl: 'https://other.example/x' }), 'unchecked', /its page sent Lot Current to another website/],
  ];
  for (const [label, answer, want, why] of cases) {
    const site = standardSite({ cars });
    site.set(at, answer);
    const res = await scanSite(site, { confirmVins: [gone.vin, cars[0].vin, 'NOPE'], confirmUrls: { [gone.vin]: at, [cars[0].vin]: O + cars[0].path } });
    assert.equal(res.ok, true, label);
    const c = res.confirm;
    if (want === 'gone') assert.deepEqual([c.checked, c.notFound, c.error, c.unchecked], [[gone.vin], [gone.vin], null, undefined], label);
    if (want === 'found') {
      assert.deepEqual([c.checked, c.notFound, c.error], [[gone.vin], [], null], label);
      assert.ok(res.records.some((r) => r.node.vehicleIdentificationNumber === gone.vin), 'a car found at its page is back in the records');
    }
    if (want === 'error') {
      assert.ok(c.error, `${label}: an error`);
      assert.deepEqual(c.notFound, [], `${label}: nothing gone`);
    }
    if (want === 'unchecked') {
      // only this car is left unchecked, with the reason; the check as a whole stands
      assert.deepEqual([c.checked, c.notFound, c.error, Object.keys(c.unchecked || {})], [[], [], null, [gone.vin]], label);
      assert.match(c.unchecked[gone.vin], why, label);
    }
  }
  // the scan never asks for a page it has no address for (NOPE), and a car still on the list isn't checked
  const site = standardSite({ cars });
  const search = fakeSiteSearch(site);
  await schemaOrg.scan(search, { ...schemaOrg.scanOptions(SERVICE), confirmVins: ['NOPE', cars[0].vin], confirmUrls: { NOPE: 'https://other.example/nope/' } });
  assert.ok(!search.calls.some((u) => /other\.example/.test(u)), 'a last-known page off the website is never read');
});

test('schemaOrg confirm: a page without the car counts only once this website\'s car pages are known to carry their car', async () => {
  const cars = standardCars(5);
  const gone = standardCars(1, { from: 40 })[0];
  const noLongerAvailable = '<html><head><script type="application/ld+json">{"@type":"AutoDealer","name":"Sample Motors"}</script></head><body>No longer available</body></html>';
  // car pages without any markup: the list's data is all there is, so a page without the car proves nothing
  const bare = standardSite({ cars });
  for (const c of cars) bare.set(O + c.path, html(`<html><head><title>${c.model}</title></head><body>$${c.price}</body></html>`));
  bare.set(O + gone.path, html(noLongerAvailable));
  // a second missing car whose page answers 404 is gone all the same: only the page that proves nothing is held back
  const sold = standardCars(1, { from: 41 })[0];
  bare.set(O + sold.path, httpError(404));
  const res = await scanSite(bare, { confirmVins: [gone.vin, sold.vin], confirmUrls: { [gone.vin]: O + gone.path, [sold.vin]: O + sold.path } });
  assert.deepEqual([res.confirm.checked, res.confirm.notFound, res.confirm.error], [[sold.vin], [sold.vin], null]);
  assert.deepEqual(Object.keys(res.confirm.unchecked), [gone.vin]);
  assert.match(res.confirm.unchecked[gone.vin], /don't mark up their own car/);
  assert.ok(res.records.every((r) => r.carried), 'the cars themselves come from the list\'s data');
});

test('schemaOrg scan: a car page with a carousel of other cars gives only its own car', async () => {
  const cars = standardCars(3);
  const others = standardCars(3, { from: 20 });
  const site = standardSite({ cars });
  site.set(O + cars[0].path, html(standardCarPage(cars[0], { carousel: others })));
  const res = await scanSite(site);
  assert.deepEqual(res.records.map((r) => r.node.vehicleIdentificationNumber).sort(), cars.map((c) => c.vin).sort(), 'the carousel\'s cars are not on the list, so they are not in the lot');
  const own = res.records.find((r) => r.node.vehicleIdentificationNumber === cars[0].vin);
  assert.equal(schemaOrg.normalize(own).price, cars[0].price);
  // the J1 fixture: its own car, never one of the four in the carousel
  const page = readFileSync(new URL('./fixtures/structured/carousel.html', import.meta.url), 'utf8');
  const url = 'https://www.sample-motors.test/inventory/used-2021-kia-sorento-lx-5xysampl6mg000114/';
  const one = await schemaOrg.getDetails(fakeSiteSearch(new Map([[url, html(page)]])), '5XYSAMPL6MG000114', { origin: O, listUrl: null, url });
  assert.equal(one.record.node.vehicleIdentificationNumber, '5XYSAMPL6MG000114');
  assert.equal(schemaOrg.normalize(one.record).price, 24995, 'the page\'s car and the price the page shows');
});

test('schemaOrg scan: a 429 or 403 stops the scan at once and says so; nothing is retried', async () => {
  for (const status of [429, 403]) {
    const cars = standardCars(8);
    const site = standardSite({ cars, perPage: 8 });
    site.set(O + cars[2].path, httpError(status));
    const search = fakeSiteSearch(site);
    const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
    assert.deepEqual([res.ok, res.error], [false, 'blocked']);
    assert.match(res.message, new RegExp(`HTTP ${status}.*stopped`));
    assert.equal(search.calls.filter((u) => u === O + cars[2].path).length, 1, 'asked once, never again');
    assert.ok(search.calls.length <= 1 + 3 + CONCURRENCY, `no new page after the refusal (${search.calls.length} requests)`);
    assert.equal(res.requests, search.calls.length);
  }
  const listBlocked = await scanSite(new Map([[LIST, httpError(429)]]));
  assert.deepEqual([listBlocked.ok, listBlocked.error], [false, 'blocked']);
});

test('schemaOrg scan: two pages at a time, never more', async () => {
  const cars = standardCars(9);
  const search = fakeSiteSearch(standardSite({ cars, perPage: 9 }), { delay: 5 });
  const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
  assert.equal(res.ok, true);
  assert.equal(CONCURRENCY, 2);
  assert.equal(search.most, 2);
});

test('schemaOrg rescan: reads new, posted and unpriced cars and those whose list data changed; the rest come from the list', async () => {
  const cars = standardCars(6);
  const noPrice = new Set([cars[2].vin]);
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const day1 = standardSite({ cars, noPrice });
  const first = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(day1), site, settings, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(first.ok, true);
  assert.equal(first.res.requests, 2 + 6, 'the first scan reads every car\'s page');
  const lines = first.boilerplate;
  assert.ok(lines.length >= 1, 'the lot-wide line in every description');

  const newcomer = standardCars(1, { from: 30 })[0];
  const today = [{ ...cars[0], price: cars[0].price - 500 }, ...cars.slice(1), newcomer];
  const day2 = standardSite({ cars: today, noPrice });
  const search = fakeSiteSearch(day2);
  const posted = { [cars[1].vin]: { name: 'x', price: cars[1].price, postedAt: '2026-09-29T12:00:00Z' } };
  const out = await scanWithSearch({ adapter: schemaOrg, search, site, settings, prevSnapshot: first.snapshot, posted, options: schemaOrg.scanOptions(SERVICE), boilerplate: lines });
  assert.equal(out.ok, true);
  const read = search.calls.filter((u) => u.includes('/inventory/'));
  assert.deepEqual(read.sort(), [cars[0], cars[1], cars[2], newcomer].map((c) => O + c.path).sort(), 'the price change, the posted car, the car without a list price, the new car');
  assert.deepEqual(out.diff.priceUpdates.map((p) => [p.vin, p.to]), [[cars[0].vin, cars[0].price - 500]]);
  assert.deepEqual(out.diff.newArrivals.map((a) => a.vin), [newcomer.vin]);
  assert.equal(out.diff.takeDown.length + out.diff.needsALook.length, 0, 'nothing else changed');
  for (const vin of [cars[3].vin, cars[4].vin, cars[5].vin]) assert.equal(out.snapshot.vehicles[vin].decision, first.snapshot.vehicles[vin].decision, 'a car taken from the list decides as its page did');
  assert.deepEqual(out.boilerplate, lines, 'the lot\'s lines are kept when most descriptions were not read this time');
});

test('schemaOrg scan: one address per car; forms and files that carry a car\'s VIN in their query are never read as its page', async () => {
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const pdf = { ok: true, status: 200, contentType: 'application/pdf', text: '' };
  const leadForm = html('<!doctype html><html><head><title>Get pre-approved</title></head><body><form><input name="name"></form><p>This site is protected by reCAPTCHA.</p></body></html>');
  const isForm = (u) => /\/(?:finance|window-sticker)\//.test(u);
  // every card also links a finance form (before or after the car's own link) and a window sticker, each with the VIN in its query
  const withForms = (siteMap, cars, { first = false } = {}) => {
    for (const [at, answer] of siteMap) {
      if (!at.startsWith(LIST)) continue;
      let text = answer.text;
      for (const c of cars) {
        const forms = `<a href="/finance/apply/?vin=${c.vin}">Get pre-approved</a> <a href="/window-sticker/?vin=${c.vin}">Window sticker</a>`;
        const own = `<a href="${c.path.replace(/&/g, '&amp;')}">`;
        text = first ? text.replace(own, forms + ' ' + own) : text.replace(`?vin=${c.vin}">Carfax</a>`, `?vin=${c.vin}">Carfax</a> ${forms}`);
      }
      siteMap.set(at, { ...answer, text });
    }
    for (const c of cars) {
      siteMap.set(`${O}/finance/apply/?vin=${c.vin}`, leadForm);
      siteMap.set(`${O}/window-sticker/?vin=${c.vin}`, pdf);
    }
    return siteMap;
  };
  const cars = standardCars(6);
  for (const listData of [true, false]) {
    for (const first of [false, true]) {
      const search = fakeSiteSearch(withForms(standardSite({ cars, listData }), cars, { first }));
      const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
      const label = `list data ${listData}, forms ${first ? 'first' : 'last'}`;
      assert.equal(res.ok, true, `${label}: ${res.message}`);
      assert.deepEqual([res.total, res.complete, res.records.length], [6, true, 6], label);
      assert.deepEqual(search.calls.filter(isForm), [], `${label}: no form or sticker is read`);
    }
  }
  // a rescan with nothing changed reads the list only, as on a lot without the forms
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(withForms(standardSite({ cars }), cars)), site, settings, options: schemaOrg.scanOptions(SERVICE) });
  const again = fakeSiteSearch(withForms(standardSite({ cars }), cars));
  const day2 = await scanWithSearch({ adapter: schemaOrg, search: again, site, settings, prevSnapshot: day1.snapshot, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(day2.ok, true);
  assert.deepEqual(again.calls, [LIST, LIST + '?page=2'], 'nothing changed: only the list is read');
  // a lot whose car pages are addressed by the VIN in the query keeps them, and still leaves the forms
  const byQuery = cars.map((c) => ({ ...c, path: `/vehicle-details/?vin=${c.vin}` }));
  for (const listData of [true, false]) {
    const search = fakeSiteSearch(withForms(standardSite({ cars: byQuery, listData }), byQuery));
    const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
    assert.deepEqual([res.ok, res.total, res.complete, res.records.length], [true, 6, true, 6], `?vin= car pages, list data ${listData}`);
    assert.deepEqual(search.calls.filter(isForm), []);
    assert.equal(search.calls.filter((u) => u.includes('/vehicle-details/')).length, 6);
  }
  // window stickers of cars that are not on the list (the only address for their VIN): files, not cars and not a failing website
  const others = standardCars(3, { from: 50 });
  const stray = standardSite({ cars });
  stray.set(LIST, { ...stray.get(LIST), text: stray.get(LIST).text.replace('</body>', others.map((o) => `<a href="/window-sticker/?vin=${o.vin}">Sticker</a>`).join(' ') + '</body>') });
  for (const o of others) stray.set(`${O}/window-sticker/?vin=${o.vin}`, pdf);
  const strayRes = await schemaOrg.scan(fakeSiteSearch(stray), schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([strayRes.ok, strayRes.total, strayRes.complete, strayRes.records.length], [true, 6, true, 6], strayRes.message);
  // at post time, the car's page from a list without data, even when a form with its VIN comes first
  const post = fakeSiteSearch(withForms(standardSite({ cars, listData: false }), cars, { first: true }));
  const d = await schemaOrg.getDetails(post, cars[1].vin, schemaOrg.scanOptions(SERVICE));
  assert.equal(d.ok, true);
  assert.equal(schemaOrg.normalize(d.record).vin, cars[1].vin);
  assert.deepEqual(post.calls, [LIST, O + cars[1].path]);
});

test('oneAddressPerCar keeps the address the list names, else the last read\'s, else one with the VIN in its path, else the first; the rest stay as alternates', () => {
  const vin = standardCars(1)[0].vin;
  const at = { form: `${O}/finance/apply/?vin=${vin}`, details: `${O}/vehicle-details/?vin=${vin}`, sticker: `${O}/window-sticker/${vin}`, page: `${O}/inventory/used-car-${vin}/` };
  const keyOf = (href) => href.replace(/\/(?=\?|$)/, '');
  const run = (hrefs, options = {}) => {
    const cars = new Map(hrefs.map((h) => [keyOf(h), h]));
    const alternates = new Map();
    oneAddressPerCar(cars, { ...options, alternates });
    const [[key, kept]] = [...cars];
    return { kept, others: alternates.get(key) };
  };
  assert.deepEqual(run([at.form, at.details]), { kept: at.form, others: [at.details] }, 'the first the list links, the other kept to try next');
  assert.deepEqual(run([at.form, at.sticker, at.details]).kept, at.sticker, 'the VIN in its path');
  assert.deepEqual(run([at.form, at.sticker, at.details], { lastSeen: { [vin]: { url: at.details } } }), { kept: at.details, others: [at.sticker, at.form] }, 'the page the last read came from, before a VIN in the path');
  assert.equal(run([at.form, at.sticker, at.details], { named: new Map([[keyOf(at.form), vin]]), lastSeen: { [vin]: { url: at.details } } }).kept, at.form, 'the list\'s own data first');
  // run again over what it kept and a new address (the sitemap's), the alternates carry over
  const cars = new Map([[keyOf(at.form), at.form], [keyOf(at.details), at.details]]);
  const alternates = new Map();
  oneAddressPerCar(cars, { alternates });
  cars.set(keyOf(at.page), at.page);
  oneAddressPerCar(cars, { alternates });
  assert.deepEqual([...cars.values()], [at.page]);
  assert.deepEqual(alternates.get(keyOf(at.page)), [at.form, at.details]);
});

test('schemaOrg scan: a car whose kept address is a form or a file is read at its next address, and the lot\'s kind of car page is learned', async () => {
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const pdf = { ok: true, status: 200, contentType: 'application/pdf', text: '' };
  const leadForm = html('<!doctype html><html><head><title>Get pre-approved</title></head><body><nav>' + 'Shop '.repeat(800) + '</nav><form><input name="name"></form></body></html>');
  const cars = standardCars(6).map((c) => ({ ...c, path: `/vehicle-details/?vin=${c.vin}` }));
  // each card links its forms and files before the car's own page; the car pages carry the VIN only in the query
  const withLinks = (siteMap, links) => {
    for (const [at, answer] of siteMap) {
      if (!at.startsWith(LIST)) continue;
      let text = answer.text;
      for (const c of cars) {
        const own = `<a href="${c.path.replace(/&/g, '&amp;')}">`;
        text = text.replace(own, links(c).map(([href, words]) => `<a href="${href}">${words}</a>`).join(' ') + ' ' + own);
      }
      siteMap.set(at, { ...answer, text });
    }
    return siteMap;
  };
  const isCarPage = (u) => u.includes('/vehicle-details/');
  const forms = (c) => [[`/finance/apply/?vin=${c.vin}`, 'Get pre-approved'], [`/window-sticker/?vin=${c.vin}`, 'Window sticker']];
  const formSite = () => {
    const m = withLinks(standardSite({ cars, listData: false }), forms);
    for (const c of cars) {
      m.set(`${O}/finance/apply/?vin=${c.vin}`, leadForm);
      m.set(`${O}/window-sticker/?vin=${c.vin}`, pdf);
    }
    return m;
  };
  // the first scan: each car is found at its page; only the first cars' forms are asked for before the lot's kind of car page is known
  const search = fakeSiteSearch(formSite());
  const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([res.ok, res.total, res.complete, res.records.length], [true, 6, true, 6], res.message);
  assert.deepEqual(res.records.map((r) => r.url).sort(), cars.map((c) => O + c.path).sort(), 'each car read from its own page');
  assert.equal(search.calls.filter(isCarPage).length, 6);
  assert.ok(search.calls.filter((u) => !isCarPage(u) && !u.startsWith(LIST)).length <= CONCURRENCY * 2, `forms read only for the first cars: ${search.calls}`);
  // a rescan reads each car's page from the last scan, and no form
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(formSite()), site, settings, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(day1.vehicles.length, 6);
  const again = fakeSiteSearch(formSite());
  const day2 = await scanWithSearch({ adapter: schemaOrg, search: again, site, settings, prevSnapshot: day1.snapshot, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(day2.ok, true);
  assert.deepEqual(again.calls.filter((u) => !u.startsWith(LIST)).sort(), cars.map((c) => O + c.path).sort(), 'each car read again at its page alone');
  // a window sticker with the VIN in its path: a PDF by its address is never asked for; one without a file ending is passed over for the car's page
  for (const sticker of [(c) => `/window-sticker/${c.vin}.pdf`, (c) => `/window-sticker/${c.vin}`]) {
    const m = withLinks(standardSite({ cars, listData: false }), (c) => [[sticker(c), 'Window sticker']]);
    for (const c of cars) m.set(O + sticker(c), pdf);
    const s = fakeSiteSearch(m);
    const r = await schemaOrg.scan(s, schemaOrg.scanOptions(SERVICE));
    assert.deepEqual([r.ok, r.total, r.complete, r.records.length], [true, 6, true, 6], sticker(cars[0]));
    assert.ok(s.calls.filter((u) => u.includes('/window-sticker/')).length <= CONCURRENCY, `${sticker(cars[0])}: ${s.calls}`);
  }
  // car pages without a VIN in their address, beside window-sticker PDFs that carry it: the PDFs are not taken for the lot's car pages
  const plainCars = standardCars(6).map((c) => ({ ...c, path: `/inventory/used-${c.year}-${c.make}-${c.model}-${c.stock}/`.toLowerCase() }));
  const plainRes = await schemaOrg.scan(fakeSiteSearch(standardSite({ cars: plainCars, listData: false })), schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([plainRes.total, plainRes.complete, plainRes.records.length], [6, true, 6], 'car addresses without a VIN and a list without data: every car, not the first two');
  const pdfLot = standardSite({ cars: plainCars, listData: false });
  pdfLot.set(LIST, { ...pdfLot.get(LIST), text: pdfLot.get(LIST).text.replace(/<a href="https:\/\/www\.carfax\.com[^"]*vin=([A-Z0-9]+)">Carfax<\/a>/g, '<a href="/window-sticker/$1.pdf">Window sticker</a>') });
  pdfLot.set(LIST + '?page=2', { ...pdfLot.get(LIST + '?page=2'), text: pdfLot.get(LIST + '?page=2').text.replace(/<a href="https:\/\/www\.carfax\.com[^"]*vin=([A-Z0-9]+)">Carfax<\/a>/g, '<a href="/window-sticker/$1.pdf">Window sticker</a>') });
  const pdfRes = await schemaOrg.scan(fakeSiteSearch(pdfLot), schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([pdfRes.ok, pdfRes.total, pdfRes.complete, pdfRes.records.length], [true, 6, true, 6], pdfRes.message);
  // the same with files that have no file ending: their shape is not the lot's, and the scan says it is not complete
  const fileLot = new Map([...pdfLot].map(([at, answer]) => [at, at.startsWith(LIST) ? { ...answer, text: answer.text.replace(/\.pdf"/g, '"') } : answer]));
  for (const c of plainCars) fileLot.set(`${O}/window-sticker/${c.vin}`, pdf);
  const fileRes = await schemaOrg.scan(fakeSiteSearch(fileLot), schemaOrg.scanOptions(SERVICE));
  assert.equal(fileRes.ok, true);
  assert.equal(fileRes.complete, false, 'files took the place of the car pages: never a complete read of an empty lot');
  // at post time, without the address the last scan kept: the form linked first is passed over for the car's page
  const post = fakeSiteSearch(formSite());
  const d = await schemaOrg.getDetails(post, cars[1].vin, schemaOrg.scanOptions(SERVICE));
  assert.equal(d.ok, true);
  assert.equal(schemaOrg.normalize(d.record).vin, cars[1].vin);
  assert.deepEqual(post.calls, [LIST, `${O}/finance/apply/?vin=${cars[1].vin}`, `${O}/window-sticker/?vin=${cars[1].vin}`, O + cars[1].path]);
});

test('schemaOrg scan: a car page that answers plain text is a page that failed, not a file that is no car', async () => {
  const cars = standardCars(6);
  const m = standardSite({ cars, listData: false });
  m.set(O + cars[2].path, { ok: true, status: 200, contentType: 'text/plain', text: 'Service temporarily unavailable' });
  const res = await schemaOrg.scan(fakeSiteSearch(m), schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([res.ok, res.total, res.complete, res.records.length], [true, 6, false, 5], res.message);
});

test('schemaOrg scan: a car with more addresses than one scan reads, none of those read its page, is left for later and the scan is not complete', async () => {
  const cars = standardCars(2).map((c) => ({ ...c, path: `/vehicle-details/?vin=${c.vin}` }));
  const m = standardSite({ cars, listData: false });
  const form = html('<!doctype html><html><head><title>Ask us</title></head><body><nav>' + 'Shop '.repeat(800) + '</nav><form></form></body></html>');
  const kinds = Array.from({ length: MAX_ADDRESSES_PER_CAR + 2 }, (_, n) => `/ask-${'abcdefgh'[n]}/`);
  m.set(LIST, { ...m.get(LIST), text: m.get(LIST).text.replace(/<a href="(\/vehicle-details\/\?vin=([A-Z0-9]+))">/g, (all, path, vin) => kinds.map((k) => `<a href="${k}?vin=${vin}">Ask</a>`).join(' ') + ' ' + all) });
  for (const c of cars) for (const k of kinds) m.set(`${O}${k}?vin=${c.vin}`, form);
  const search = fakeSiteSearch(m);
  const res = await schemaOrg.scan(search, schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([res.ok, res.total, res.complete], [true, 2, false], res.message);
  assert.equal(search.calls.length, 1 + 2 * MAX_ADDRESSES_PER_CAR, 'never more than the most addresses per car');
  // at post time too: never more, and a car whose page may be among the links not read is not called gone
  const post = fakeSiteSearch(m);
  const d = await schemaOrg.getDetails(post, cars[0].vin, schemaOrg.scanOptions(SERVICE));
  assert.equal(d.ok, false);
  assert.match(d.message, /Scan the website again/);
  assert.equal(post.calls.length, 1 + MAX_ADDRESSES_PER_CAR);
});

test('schemaOrg getDetails: the car\'s own page from the address the last scan kept; the list when that page is unknown', async () => {
  const cars = standardCars(6);
  const siteMap = standardSite({ cars });
  const search = fakeSiteSearch(siteMap);
  const d = await schemaOrg.getDetails(search, cars[5].vin.toLowerCase(), { ...schemaOrg.scanOptions(SERVICE), url: O + cars[5].path });
  assert.equal(d.ok, true);
  assert.equal(schemaOrg.normalize(d.record).vin, cars[5].vin);
  assert.deepEqual(search.calls, [O + cars[5].path], 'one request: the car\'s page');
  const viaList = fakeSiteSearch(siteMap);
  const d2 = await schemaOrg.getDetails(viaList, cars[5].vin, schemaOrg.scanOptions(SERVICE));
  assert.equal(schemaOrg.normalize(d2.record).descriptionRaw.length > 0, true, 'read from its page, description included');
  assert.deepEqual(viaList.calls, [LIST, LIST + '?page=2', O + cars[5].path]);
  siteMap.set(O + cars[5].path, httpError(404));
  assert.deepEqual((await schemaOrg.getDetails(fakeSiteSearch(siteMap), cars[5].vin, { ...schemaOrg.scanOptions(SERVICE), url: O + cars[5].path })).record, null, 'its page is gone: so is the car');
  siteMap.set(O + cars[5].path, httpError(429));
  const blocked = await schemaOrg.getDetails(fakeSiteSearch(siteMap), cars[5].vin, { ...schemaOrg.scanOptions(SERVICE), url: O + cars[5].path });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /HTTP 429/);
  const off = fakeSiteSearch(siteMap);
  await schemaOrg.getDetails(off, cars[0].vin, { ...schemaOrg.scanOptions(SERVICE), url: 'https://other.example' + cars[0].path });
  assert.ok(!off.calls.some((u) => /other\.example/.test(u)), 'an address off the website is never read');
});

test('fetchVehicleDetails passes the car\'s known page to the adapter, from the dealer tab', async () => {
  const cars = standardCars(6);
  const page = fakeStandardPage({ site: standardSite({ cars }), path: cars[0].path });
  globalThis.chrome = fakeChrome(page);
  try {
    const r = await fetchVehicleDetails(1, cars[4].vin, { url: O + cars[4].path });
    assert.equal(r.ok, true);
    assert.equal(r.vehicle.vin, cars[4].vin);
    assert.deepEqual(page.fetchCalls.map((c) => c.url), [O + cars[4].path], 'straight to its page, from the tab');
    const missing = await fetchVehicleDetails(1, standardCars(1, { from: 70 })[0].vin);
    assert.equal(missing.notFound, true, 'not on its page or on the list: gone');
  } finally {
    delete globalThis.chrome;
  }
});

test('a scan that did not read everything says which way: cars missing, pages that could not be read, or pages left for the next scan', async () => {
  const checked = { checked: ['A'], notFound: [], error: null };
  const failed = { checked: [], notFound: [], error: "one car's page gave HTTP 500" };
  const none = { checked: [], notFound: [], error: null };
  // "double-checked" only when the check ran and checked a car
  assert.equal(incompleteWarning({ records: [1, 2], total: 3 }), 'The website returned 2 of 3 cars.');
  assert.equal(incompleteWarning({ records: [1, 2], total: 3, confirm: checked }), 'The website returned 2 of 3 cars. Missing cars were looked up again on the website.');
  assert.equal(incompleteWarning({ records: [1, 2], total: 3, confirm: failed }), 'The website returned 2 of 3 cars.');
  assert.equal(incompleteWarning({ records: [1, 2, 3], total: 3, confirm: none }), "Some of the website's pages could not be read this time.");
  assert.equal(incompleteWarning({ records: [1, 2, 3], total: 3, confirm: checked }), "Some of the website's pages could not be read this time. Missing cars were looked up again on the website.");
  assert.equal(incompleteWarning({ records: [1, 2], unread: ['A'], total: 3 }), "One car's page could not be read this time, so that car shows what the last scan read.");
  assert.equal(incompleteWarning({ records: [1], unread: ['A', 'B'], total: 4, confirm: failed }), 'The website returned 3 of 4 cars.');
  // pages the page limit left were never asked for: not "could not be read"
  assert.equal(incompleteWarning({ records: [1, 2], total: 6, leftForLater: 4 }), "This lot has more car pages than one scan reads, so 4 cars' pages were left for the next scan.");
  assert.equal(incompleteWarning({ records: [1, 2], unread: ['A'], total: 3, leftForLater: 1, confirm: checked }), "This lot has more car pages than one scan reads, so one car's page was left for the next scan. A car whose page was not read this time shows what the last scan read. Missing cars were looked up again on the website.");

  const cars = standardCars(4);
  const siteMap = standardSite({ cars });
  siteMap.set(O + cars[1].path, httpError(500));
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const out = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(siteMap), site, settings: withDefaults({}, site), options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(out.snapshot.complete, false);
  assert.equal(out.diff.warnings[0], "Some of the website's pages could not be read this time.", 'every car is known from the list; one page failed; nothing was missing, so nothing was double-checked');

  // a bad server day: page 2 of the list fails, and the website refuses a missing posted car's page
  const six = standardCars(6);
  const settings = withDefaults({}, site);
  const posted = { [six[4].vin]: { name: 'x', price: six[4].price, postedAt: '2026-09-29T12:00:00Z' } };
  const day1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars: six })), site, settings, posted, options: schemaOrg.scanOptions(SERVICE) });
  const bad = standardSite({ cars: six });
  bad.set(LIST + '?page=2', httpError(500));
  bad.set(O + six[4].path, httpError(429));
  const day2 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(bad), site, settings, posted, prevSnapshot: day1.snapshot, options: schemaOrg.scanOptions(SERVICE) });
  assert.ok(day2.res.confirm.error);
  assert.equal(day2.diff.warnings[0], "Some of the website's pages could not be read this time.", 'never "double-checked" when the check failed');
  assert.match(day2.diff.warnings[1], /^Couldn't double-check missing cars .*Nothing was marked as gone\.$/);
  assert.deepEqual(day2.diff.takeDown, []);
  // the same car's page answering 500 leaves only that car unchecked, named with the reason
  bad.set(O + six[4].path, httpError(500));
  const day2a = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(bad), site, settings, posted, prevSnapshot: day1.snapshot, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(day2a.res.confirm.error, null);
  assert.match(day2a.res.confirm.unchecked[six[4].vin], /HTTP 500/);
  assert.ok(!day2a.diff.warnings.some((w) => /Couldn't double-check/.test(w)));
  assert.deepEqual(day2a.diff.takeDown, []);
  assert.match(day2a.diff.needsALook.find((n) => n.vin === six[4].vin).text, /its page gave HTTP 500, so it was not marked gone/);
  // the same day with the missing cars' pages answering 404: they were double-checked, and are gone
  const sold = standardSite({ cars: six });
  sold.set(LIST + '?page=2', httpError(500));
  for (const c of six.slice(4)) sold.set(O + c.path, httpError(404));
  const day2b = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(sold), site, settings, posted, prevSnapshot: day1.snapshot, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(day2b.diff.warnings[0], "Some of the website's pages could not be read this time. Missing cars were looked up again on the website.");
  assert.deepEqual(day2b.diff.takeDown.map((t) => t.vin).sort(), [six[4].vin, six[5].vin].sort());
});

test('scanWithSearch keeps the saved lot-wide lines when a scan did not read every description', async () => {
  const site = { origin: 'https://x', host: 'x', name: 'Example Motors', title: 't', adapter: 'dealerInspire' };
  const saved = ['Every car gets a 120-point inspection.'];
  // every description read (Dealer Inspire's search always gives them): this scan's lines replace the saved ones
  const all = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(records), site, settings: withDefaults({}), boilerplate: saved });
  assert.ok(!all.boilerplate.includes(saved[0]));
  // most descriptions not read this time (null): the saved lines stay
  const skim = { ...dealerInspire, normalize: (r) => ({ ...dealerInspire.normalize(r), descriptionRaw: r.vin === records[0].vin ? 'One car.' : null }) };
  const some = await scanWithSearch({ adapter: skim, search: fakeSearch(records), site, settings: withDefaults({}), boilerplate: saved });
  assert.deepEqual(some.boilerplate, saved);
});

test('a rescan that read only the new arrivals\' pages makes no lot-wide line of a sentence those few share', async () => {
  // a schema.org lot of 30: the first scan reads every page; the next reads
  // only the 3 new arrivals, which share one sentence (9% of the lot)
  const site = { origin: STANDARD_ORIGIN, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = schemaOrg.scanOptions(SERVICE);
  const cars = standardCars(30);
  const first = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(standardSite({ cars, perPage: 30 })), site, settings, options });
  assert.deepEqual(first.boilerplate, ['Every car gets a 120-point inspection.'], 'the line on every car');
  const SHARED = 'Rebuilt title after hail damage, fully repaired and inspected.';
  const arrivals = standardCars(3, { from: 40 });
  const today = standardSite({ cars: [...cars, ...arrivals], perPage: 40 });
  for (const c of arrivals) {
    const got = today.get(STANDARD_ORIGIN + c.path);
    today.set(STANDARD_ORIGIN + c.path, { ...got, text: got.text.replace('Every car gets a 120-point inspection.', `Every car gets a 120-point inspection.<br>${SHARED}`) });
  }
  const out = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(today), site, settings, prevSnapshot: first.snapshot, options, boilerplate: first.boilerplate });
  assert.equal(out.vehicles.filter((v) => v.descriptionRaw !== null).length, 3, 'only the new arrivals were read');
  assert.deepEqual(out.boilerplate, first.boilerplate, 'the saved line stays; the arrivals\' sentence is not lot-wide');
  const arrival = out.vehicles.find((v) => v.vin === arrivals[0].vin);
  assert.ok(cleanDescription(arrival.descriptionRaw, new Set(out.boilerplate)).includes(SHARED), 'and it stays in the car\'s description');
});

test('a scan judged a website hiccup, or one that read too few descriptions, keeps the saved lot-wide lines', async () => {
  const site = { origin: 'https://x', host: 'x', name: 'Example Motors', title: 't', adapter: 'dealerInspire' };
  const settings = withDefaults({});
  const LINE = 'All prices plus tax, title and a dealer fee.';
  const lot = Array.from({ length: 12 }, (_, i) => ({ ...records[0], vin: sampleVin(i), stock: `S${i}`, description: `A clean car, number ${i}.<br>${LINE}` }));
  const day1 = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(lot), site, settings });
  assert.deepEqual(day1.boilerplate, [LINE]);
  // the website answers with no cars, then with 2 of the 12: a hiccup, whose snapshot is not saved
  for (const answer of [[], lot.slice(0, 2)]) {
    const out = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(answer), site, settings, prevSnapshot: day1.snapshot, boilerplate: day1.boilerplate });
    assert.equal(out.diff.unreliable, true);
    assert.deepEqual(out.boilerplate, [LINE], `${answer.length} cars back: the saved line stays`);
  }
  // a reliable scan of a 2-car lot reads every description but too few to show any line: the saved line stays
  const small = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(lot.slice(0, 2)), site, settings, boilerplate: [LINE] });
  assert.equal(small.diff.unreliable, false);
  assert.deepEqual(small.boilerplate, [LINE]);
  // a reliable scan that reads the whole lot still works the lines out again (the dealer dropped the line)
  const plain = lot.map((r, i) => ({ ...r, description: `A clean car, number ${i}.` }));
  const again = await scanWithSearch({ adapter: dealerInspire, search: fakeSearch(plain), site, settings, prevSnapshot: day1.snapshot, boilerplate: day1.boilerplate });
  assert.deepEqual(again.boilerplate, []);
});

// ---------- schemaOrg: refusals, look-alike pages, the page limit and the hostile-site limits ----------

const CHALLENGE = '<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>';
const carPageCalls = (search) => search.calls.filter((u) => u.includes('/inventory/'));

test('schemaOrg scan: a 503, a bot check behind any error status, or three failed car pages in a row stop the scan; nothing is retried', async () => {
  const cars = standardCars(40);
  const every = (answer) => {
    const site = standardSite({ cars, perPage: 40 });
    for (const c of cars) site.set(O + c.path, typeof answer === 'function' ? answer(c) : answer);
    return site;
  };
  // a firewall's "checking your browser" page served as 503
  const challenged = fakeSiteSearch(every({ ok: false, status: 503, contentType: 'text/html', text: CHALLENGE }));
  const r503 = await schemaOrg.scan(challenged, schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([r503.ok, r503.error], [false, 'blocked']);
  assert.match(r503.message, /HTTP 503.*stopped/);
  assert.ok(carPageCalls(challenged).length <= CONCURRENCY, `no new page after the 503 (${challenged.calls.length} requests)`);
  // the same page behind another error status is still a bot check
  const other = fakeSiteSearch(every({ ok: false, status: 502, contentType: 'text/html; charset=utf-8', text: CHALLENGE }));
  const r502 = await schemaOrg.scan(other, schemaOrg.scanOptions(SERVICE));
  assert.deepEqual([r502.ok, r502.error], [false, 'blocked']);
  assert.match(r502.message, /bot check/);
  assert.ok(carPageCalls(other).length <= CONCURRENCY, `no new page after the bot check (${other.calls.length} requests)`);
  // plain failures one after another (a 500 on every car page, or the connection reset)
  for (const [label, site, search] of [
    ['500', every(httpError(500, 'Internal server error')), null],
    ['reset', null, async (request) => { if (request.url.includes('/inventory/')) throw new Error('connection reset'); return { finalUrl: request.url, redirected: false, ...standardSite({ cars, perPage: 40 }).get(request.url) }; }],
  ]) {
    const calls = [];
    const s = search ? async (request) => { calls.push(request.url); return search(request); } : fakeSiteSearch(site);
    const res = await schemaOrg.scan(s, schemaOrg.scanOptions(SERVICE));
    const asked = (search ? calls : s.calls).filter((u) => u.includes('/inventory/')).length;
    assert.deepEqual([res.ok, res.error], [false, 'failing'], label);
    assert.match(res.message, new RegExp(`failed ${MAX_FAILED_IN_A_ROW} times in a row.*stopped`), label);
    assert.ok(asked <= MAX_FAILED_IN_A_ROW + CONCURRENCY - 1, `${label}: stopped after ${MAX_FAILED_IN_A_ROW} failures in a row, not after all 40 (${asked} car pages asked for)`);
  }
  // one failure among pages that answer is not a run: the scan goes on
  const flaky = standardSite({ cars, perPage: 40 });
  for (const n of [3, 10, 20]) flaky.set(O + cars[n].path, httpError(500));
  const goesOn = await scanSite(flaky);
  assert.deepEqual([goesOn.ok, goesOn.complete, goesOn.records.length], [true, false, 40]);
  // a sold car's 404 page is its page gone, whatever words it carries (a lead form's captcha notice)
  const sold = standardSite({ cars: cars.slice(0, 5) });
  sold.set(O + cars[2].path, { ok: false, status: 404, contentType: 'text/html', text: '<html><head><title>Page not found</title></head><body>This site is protected by reCAPTCHA. Are you human? Just a moment.</body></html>' });
  const r404 = await scanSite(sold, { confirmVins: [cars[2].vin], confirmUrls: { [cars[2].vin]: O + cars[2].path } });
  assert.equal(r404.ok, true);
  assert.deepEqual(r404.confirm.notFound, [cars[2].vin]);
});

// A car page whose own Car node has no VIN but whose "similar vehicles"
// carousel has two other cars' nodes: the car can't be told from the page.
function carouselSite(cars, perPage = 4) {
  const site = standardSite({ cars, perPage });
  cars.forEach((c, n) => {
    const page = standardCarPage(c, { carousel: [cars[(n + 1) % cars.length], cars[(n + 2) % cars.length]] });
    const own = `"vehicleIdentificationNumber":"${c.vin}",`;
    assert.equal(page.split(own).length, 2, 'the page names its own VIN once, in its own node');
    site.set(O + c.path, html(page.replace(own, '')));
  });
  return site;
}

test('schemaOrg confirm: a live car whose page marks up only other cars, or redirects to such a page, is never called gone', async () => {
  const cars = standardCars(12);
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const posted = { [cars[10].vin]: { name: 'x', price: cars[10].price, postedAt: '2026-09-29T12:00:00Z' } };
  const first = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(carouselSite(cars)), site, settings, posted, options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(Object.keys(first.snapshot.vehicles).length, 12, 'every car read from the list\'s data');
  for (const redirect of [false, true]) {
    // day 2: the last list page fails, so 4 of 12 cars are missing; each car's page still shows it
    const day2 = carouselSite(cars);
    day2.set(LIST + '?page=3', httpError(500));
    if (redirect) {
      // each missing car's address now redirects (a slug change) to the same kind of page
      for (const c of cars.slice(8)) {
        const moved = O + '/inventory/' + c.vin.toLowerCase() + '/';
        day2.set(O + c.path, { ...day2.get(O + c.path), redirected: true, finalUrl: moved });
      }
    }
    const out = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(day2), site, settings, posted, prevSnapshot: first.snapshot, options: schemaOrg.scanOptions(SERVICE) });
    const label = redirect ? 'redirected' : 'at its page';
    assert.deepEqual([out.res.confirm.notFound, out.res.confirm.error], [[], null], label);
    assert.deepEqual(Object.keys(out.res.confirm.unchecked).sort(), cars.slice(8).map((c) => c.vin).sort(), label);
    for (const c of cars.slice(8)) assert.match(out.res.confirm.unchecked[c.vin], /don't mark up their own car/, label);
    assert.deepEqual(out.diff.takeDown, [], `${label}: nothing taken down, the posted car included`);
    assert.deepEqual(out.diff.needsALook.map((n) => n.vin).sort(), cars.slice(8).map((c) => c.vin).sort(), label);
  }
  // where car pages do carry their own VIN, the same pages without the car are proof: gone
  const plain = standardSite({ cars, perPage: 4 });
  const firstPlain = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(plain), site, settings, posted, options: schemaOrg.scanOptions(SERVICE) });
  const soldDay = standardSite({ cars: cars.slice(0, 8), perPage: 4 });
  for (const c of cars.slice(8)) soldDay.set(O + c.path, html(standardListPage(cars.slice(0, 4)), { redirected: true, finalUrl: LIST }));
  const out = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(soldDay), site, settings, posted, prevSnapshot: firstPlain.snapshot, options: schemaOrg.scanOptions(SERVICE) });
  assert.deepEqual(out.diff.takeDown.map((t) => t.vin).sort(), cars.slice(8).map((c) => c.vin).sort());

  // at post time: a page that moved to one without the car leaves the decision to the list
  const moved = carouselSite(cars);
  moved.set(O + cars[1].path, { ...moved.get(O + cars[1].path), redirected: true, finalUrl: O + '/inventory/' + cars[1].vin.toLowerCase() + '/' });
  const d = await schemaOrg.getDetails(fakeSiteSearch(moved), cars[1].vin, { ...schemaOrg.scanOptions(SERVICE), url: O + cars[1].path });
  assert.equal(d.ok, true);
  assert.equal(d.record && d.record.node.vehicleIdentificationNumber, cars[1].vin, 'still on the list: still for sale');
  const gone = await schemaOrg.getDetails(fakeSiteSearch(soldDay), cars[9].vin, { ...schemaOrg.scanOptions(SERVICE), url: O + cars[9].path });
  assert.deepEqual([gone.ok, gone.record], [true, null], 'moved to the list, and not on it: gone');
});

test('schemaOrg scan: past the page limit, the pages read longest ago come first, so every car comes round; the warning says they were left for the next scan', async () => {
  const cars = standardCars(10);
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const settings = withDefaults({}, site);
  const options = { ...schemaOrg.scanOptions(SERVICE), maxCarPages: 6 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5)); // each scan its own time
  const vinsOf = (search) => carPageCalls(search).map((u) => cars.find((c) => O + c.path === u).vin);
  const V = cars.map((c) => c.vin);

  // (a) a list of links only: a car whose page is not read has nothing to show
  const links = standardSite({ cars, perPage: 10, listData: false });
  const s1 = fakeSiteSearch(links);
  const one = await scanWithSearch({ adapter: schemaOrg, search: s1, site, settings, options });
  assert.deepEqual(vinsOf(s1), V.slice(0, 6), 'no more than the limit');
  assert.deepEqual([one.res.leftForLater, one.res.complete, Object.keys(one.snapshot.vehicles).length], [4, false, 6]);
  assert.equal(one.diff.warnings[0], "This lot has more car pages than one scan reads, so 4 cars' pages were left for the next scan.");
  assert.equal(one.snapshot.vehicles[V[0]].pageReadAt, one.res.fetchedAt);
  await tick();
  const s2 = fakeSiteSearch(links);
  const two = await scanWithSearch({ adapter: schemaOrg, search: s2, site, settings, prevSnapshot: one.snapshot, options });
  assert.deepEqual(vinsOf(s2).slice(0, 4).sort(), V.slice(6).sort(), 'the cars never read come first');
  assert.equal(vinsOf(s2).length, 6);
  assert.equal(Object.keys(two.snapshot.vehicles).length, 10, 'every car is in the lot now');
  assert.equal(two.snapshot.vehicles[V[5]].pageReadAt, one.res.fetchedAt, 'a car not read this time keeps when it was read');
  assert.equal(two.diff.warnings[0], "This lot has more car pages than one scan reads, so 4 cars' pages were left for the next scan. A car whose page was not read this time shows what the last scan read.");
  await tick();
  const s3 = fakeSiteSearch(links);
  await scanWithSearch({ adapter: schemaOrg, search: s3, site, settings, prevSnapshot: two.snapshot, options });
  assert.deepEqual(vinsOf(s3).slice(0, 4), V.slice(2, 6), 'then the pages read longest ago');

  // (b) a list without prices: a car whose page is not read is Not ready until it is
  const noPrice = new Set(V);
  const thin = standardSite({ cars, perPage: 10, noPrice: new Set() });
  const unpricedList = standardSite({ cars, perPage: 10, noPrice });
  thin.set(LIST, unpricedList.get(LIST)); // the list shows no price; each car's page does
  const b1 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(thin), site, settings, options });
  assert.equal(b1.snapshot.vehicles[V[8]].price, null, 'from the list: no price yet');
  await tick();
  const b2 = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(thin), site, settings, prevSnapshot: b1.snapshot, options });
  for (const n of [6, 7, 8, 9]) assert.equal(b2.snapshot.vehicles[V[n]].price, cars[n].price, `car ${n}: read from its page on the next scan`);
  for (const n of [2, 3, 4, 5]) assert.equal(b2.snapshot.vehicles[V[n]].price, cars[n].price, `car ${n}: keeps what its page said`);
});

test('schemaOrg: a redirect to another website is followed as a browser would, and its answer is never used', async () => {
  const hits = [];
  const other = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(other.page || '<html></html>');
  });
  const dealer = createServer((req, res) => {
    const got = dealer.site.get(dealer.origin + req.url);
    if (got && got.location) {
      res.writeHead(301, { location: got.location });
      return res.end();
    }
    res.writeHead(got ? got.status : 404, { 'content-type': got ? got.contentType : 'text/plain' });
    res.end(got ? got.text : 'Not found');
  });
  await Promise.all([other, dealer].map((srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))));
  try {
    const otherOrigin = `http://127.0.0.1:${other.address().port}`;
    dealer.origin = `http://127.0.0.1:${dealer.address().port}`;
    const cars = standardCars(4);
    const sold = standardCars(1, { from: 60 })[0];
    dealer.site = standardSite({ cars, origin: dealer.origin });
    // a listed car's page and a missing car's last page both send the reader to another website,
    // which answers with a page that shows each car still for sale
    dealer.site.set(dealer.origin + cars[1].path, { location: otherOrigin + '/tracker?from=dealer' });
    dealer.site.set(dealer.origin + sold.path, { location: otherOrigin + '/tracker?from=dealer' });
    other.page = standardCarPage(cars[1], { origin: otherOrigin }).replace('</head>', `<script type="application/ld+json">${JSON.stringify(standardCarNode(sold, otherOrigin))}</script></head>`);
    const service = { kind: 'schemaOrg', origin: dealer.origin, listUrl: dealer.origin + '/used-vehicles/' };
    const search = schemaOrg.makeDirectSearch(service);
    const res = await schemaOrg.scan(search, { ...schemaOrg.scanOptions(service), confirmVins: [sold.vin], confirmUrls: { [sold.vin]: dealer.origin + sold.path } });
    assert.ok(hits.length >= 1, 'the redirect was followed (the request went out, as it would from a browser)');
    assert.equal(res.ok, true);
    assert.equal(res.confirm.error, null);
    assert.match(res.confirm.unchecked[sold.vin], /another website/, 'the other website\'s answer proves nothing about the missing car');
    assert.deepEqual([res.confirm.checked, res.confirm.notFound], [[], []]);
    assert.ok(!res.records.some((r) => r.node.vehicleIdentificationNumber === sold.vin), 'the missing car is not brought back from the other website');
    const listed = res.records.find((r) => r.node.vehicleIdentificationNumber === cars[1].vin);
    assert.ok(listed && listed.carried && listed.url.startsWith(dealer.origin), 'the listed car comes from the dealer\'s own list, not the other website');
    assert.equal(res.complete, false);
    for (const r of res.records) assert.ok(!JSON.stringify(r).includes(otherOrigin), 'nothing from the other website is kept');
  } finally {
    await Promise.all([other, dealer].map((srv) => new Promise((resolve) => srv.close(resolve))));
  }
});

test('schemaOrg limits: list pages, car pages, sitemaps, the page size and the request timeout all hold against a hostile website', async () => {
  // an endless list: every page links rel=next to one more, each with one car
  const listAt = (n) => (n === 1 ? LIST : `${LIST}?page=${n}`);
  const endless = [];
  const started = Date.now();
  const res = await schemaOrg.scan(async (request) => {
    endless.push(request.url);
    const m = /\?page=(\d+)$/.exec(request.url);
    const n = request.url === LIST ? 1 : m ? Number(m[1]) : 0;
    if (n > 1000) return { ...httpError(500), finalUrl: request.url }; // a safety net so a broken limit fails instead of hanging
    if (n) return html(standardListPage(standardCars(1, { from: n }), { next: listAt(n + 1).slice(O.length) }), { finalUrl: request.url });
    const car = standardCars(1, { from: Number((/(\d{6})\/$/.exec(request.url) || [])[1]) - 100000 })[0];
    return html(standardCarPage(car), { finalUrl: request.url });
  }, schemaOrg.scanOptions(SERVICE));
  const listReads = endless.filter((u) => u.startsWith(LIST)).length;
  assert.equal(listReads, MAX_LIST_PAGES, 'the list stops at MAX_LIST_PAGES pages');
  assert.deepEqual([res.ok, res.complete, res.total], [true, false, MAX_LIST_PAGES]);
  assert.ok(Date.now() - started < 1000, `an endless list is cut short quickly (${Date.now() - started} ms)`);

  // a sitemap index with more children than MAX_SITEMAPS
  const cars = standardCars(3);
  const mapped = standardSite({ cars, sitemap: true });
  mapped.set(O + '/robots.txt', { ok: true, status: 200, contentType: 'text/plain', text: `Sitemap: ${O}/sitemap-index.xml\n` });
  mapped.set(O + '/sitemap-index.xml', { ok: true, status: 200, contentType: 'application/xml', text: `<sitemapindex>${Array.from({ length: 20 }, (_, n) => `<sitemap><loc>${O}/sitemap-${n}.xml</loc></sitemap>`).join('')}</sitemapindex>` });
  for (let n = 0; n < 20; n += 1) mapped.set(`${O}/sitemap-${n}.xml`, { ok: true, status: 200, contentType: 'application/xml', text: '<urlset></urlset>' });
  const sm = fakeSiteSearch(mapped);
  const withMap = await schemaOrg.scan(sm, { ...schemaOrg.scanOptions(SERVICE), sitemap: true });
  const sitemapReads = sm.calls.filter((u) => /sitemap/.test(u)).length;
  assert.equal(sitemapReads, MAX_SITEMAPS, `at most MAX_SITEMAPS sitemaps (${sitemapReads} read)`);
  assert.deepEqual([withMap.ok, withMap.complete], [true, false], 'sitemaps left unread: not complete');

  // more car pages than the limit: no more than the limit are asked for
  const many = fakeSiteSearch(standardSite({ cars: standardCars(10), perPage: 10 }));
  const capped = await schemaOrg.scan(many, { ...schemaOrg.scanOptions(SERVICE), maxCarPages: 4 });
  assert.equal(carPageCalls(many).length, 4);
  assert.deepEqual([capped.complete, capped.leftForLater], [false, 6]);

  // a body far larger than the page limit, streamed: the read stops at the limit
  let reads = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1000000).fill(120); // 'x'
  const streaming = schemaOrg.makeDirectSearch(SERVICE, async (url) => ({
    ok: true, status: 200, url, redirected: false, headers: { get: () => 'text/html' },
    body: { getReader: () => ({ read: async () => (reads >= 10 ? { done: true } : (reads += 1, { done: false, value: chunk })), cancel: async () => { cancelled = true; } }) },
  }));
  const big = await streaming({ url: LIST });
  assert.equal(big.text.length, PAGE_TEXT_LIMIT);
  assert.equal(reads, Math.ceil(PAGE_TEXT_LIMIT / chunk.length), 'nothing is read past the limit');
  assert.equal(cancelled, true, 'the rest of the body is cancelled');

  // a server that never answers: the request gives up after REQUEST_TIMEOUT_MS
  assert.match(String(schemaOrg.searchInPage), new RegExp(`ctrl\\.abort\\(\\), ${REQUEST_TIMEOUT_MS}\\)`), 'the in-page copy waits as long');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const silent = schemaOrg.makeDirectSearch(SERVICE, (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))));
    let settled = null;
    const scanning = schemaOrg.scan(silent, schemaOrg.scanOptions(SERVICE)).then((r) => { settled = r; });
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    await flush();
    mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, null, 'still waiting just before the timeout');
    mock.timers.tick(1);
    for (let n = 0; n < 5 && !settled; n += 1) await flush();
    assert.ok(settled, 'the scan ends once the request times out');
    assert.deepEqual([settled.ok, settled.error], [false, 'list-failed']);
    assert.match(settled.message, /aborted/);
    await scanning;
  } finally {
    mock.timers.reset();
  }
});
