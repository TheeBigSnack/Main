import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { startMockSite } from './e2e/mock-dealer-site.mjs';
import dealerInspire, { scan, getDetails, makeDirectSearch, detect, trimRecord, FIELDS, probeInPage, searchInPage, origins, scanOptions, photoOrigins } from '../extension/adapters/dealerInspire.js';
import { ADAPTERS, detectAdapter, adapterById, adapterForService, unsupportedSiteMessage, platformNames } from '../extension/adapters/index.js';
import { VEHICLE_FIELDS } from '../extension/src/vehicle.js';
import { scanWithSearch, incompleteWarning } from '../extension/src/scanRunner.js';
import { withDefaults } from '../extension/src/settings.js';
import schemaOrg, { PAGE_TEXT_LIMIT, CONCURRENCY, learnCarAddressShape, matchesCarAddressShape, vinInAddress } from '../extension/adapters/schemaOrg.js';
import { fetchVehicleDetails } from '../extension/src/vehicleDetails.js';
import { fixtures, fakeDealerPage, fakeChrome, runInPage, STANDARD_ORIGIN, standardCars, standardSite, standardCarNode, standardCarPage, standardListPage, httpError, fakeSiteSearch, fakeStandardPage } from './helpers.js';

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
};

const CONTRACT = ['probeInPage', 'searchInPage', 'detect', 'origins', 'scanOptions', 'scan', 'getDetails', 'normalize', 'makeDirectSearch', 'photoOrigins'];
const IN_PAGE = ['probeInPage', 'searchInPage'];
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`\\])\/\/[^\n]*$/gm, '$1');
const stripStrings = (src) => src.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
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

test('the in-page functions are self-contained: no import, nothing from the module around them', async () => {
  const dir = new URL('../extension/adapters/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.js$/.test(f) && f !== 'index.js');
  let checked = 0;
  for (const file of files) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    const mod = await import(new URL(file, dir));
    const outside = moduleScopeNames(src);
    for (const name of IN_PAGE) {
      if (typeof mod[name] !== 'function') continue;
      const fnSrc = String(mod[name]);
      assert.ok(!/\bimport\b|\brequire\s*\(/.test(stripStrings(stripComments(fnSrc))), `${file} ${name} must not import`);
      const reached = [...freeIdentifiers(fnSrc, name)].filter((id) => outside.has(id));
      assert.deepEqual(reached, [], `${file} ${name} reaches outside its own body for: ${reached.join(', ')}`);
      checked += 1;
    }
  }
  assert.equal(checked, ADAPTERS.length * IN_PAGE.length, 'every adapter exports both in-page functions from its own file');
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
    // unread is the one optional key: cars still listed whose details this scan could not read
    const { unread, ...shape } = res;
    assert.deepEqual(Object.keys(shape).sort(), ['complete', 'confirm', 'fetchedAt', 'ok', 'records', 'requests', 'total'], `${a.PLATFORM.id}.scan return shape`);
    assert.ok(unread === undefined || (Array.isArray(unread) && unread.length > 0), `${a.PLATFORM.id}.scan unread, when given, lists VINs`);
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
  assert.deepEqual(platformNames(), ['Dealer Inspire', 'Standard vehicle data (schema.org)']);
  assert.equal(unsupportedSiteMessage(), "Lot Sync can't read the cars on this page. What it reads today: Dealer Inspire; Standard vehicle data (schema.org). Open your dealership's used inventory page and try again.");
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
  assert.deepEqual(await on('/used-vehicles/?page=2'), { ...SERVICE, listUrl: O + '/used-vehicles/?page=2' });
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
  // a page longer than the cap is cut, not refused
  const big = new Map([[LIST, html('<html>' + 'x'.repeat(PAGE_TEXT_LIMIT + 10) + '</html>')]]);
  const cut = await runInPage(fakeStandardPage({ site: big, html: '<html></html>' }), schemaOrg.searchInPage, SERVICE, { url: LIST });
  assert.equal(cut.data.text.length, PAGE_TEXT_LIMIT);
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
  assert.equal(seen[0].init.headers, undefined, 'no user agent or any other header of Lot Sync\'s');
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
  const noList = await scanSite(new Map([[LIST, httpError(503)]]));
  assert.deepEqual([noList.ok, noList.error], [false, 'list-failed']);
  const drawn = await scanSite(new Map([[LIST, html('<html><head><title>Used</title></head><body><div id="app"></div></body></html>')]]));
  assert.deepEqual([drawn.ok, drawn.error], [false, 'no-cars']);
  assert.match(drawn.message, /draws its list with scripts/);
  const unknown = await schemaOrg.scan(fakeSiteSearch(site), { origin: O, listUrl: null });
  assert.deepEqual([unknown.ok, unknown.error, unknown.requests], [false, 'no-list', 0]);
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

// A car from the last scan is gone from the list; its own page decides.
test('schemaOrg confirm: gone only on 404, 410, a redirect away, SoldOut or the website\'s data without it; anything else is an error and nothing is gone', async () => {
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
    ['200 with no structured data at all', html('<html><body><h1>Oops</h1></body></html>'), 'error'],
    ['200 bot check', html('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>'), 'error'],
    ['200 not a web page', { ok: true, status: 200, contentType: 'application/json', text: '{}' }, 'error'],
    ['403', httpError(403), 'error'],
    ['429', httpError(429), 'error'],
    ['500', httpError(500), 'error'],
    ['redirect to another website', html(standardCarPage(gone), { redirected: true, finalUrl: 'https://other.example/x' }), 'error'],
  ];
  for (const [label, answer, want] of cases) {
    const site = standardSite({ cars });
    site.set(at, answer);
    const res = await scanSite(site, { confirmVins: [gone.vin, cars[0].vin, 'NOPE'], confirmUrls: { [gone.vin]: at, [cars[0].vin]: O + cars[0].path } });
    assert.equal(res.ok, true, label);
    const c = res.confirm;
    if (want === 'gone') assert.deepEqual([c.checked, c.notFound, c.error], [[gone.vin], [gone.vin], null], label);
    if (want === 'found') {
      assert.deepEqual([c.checked, c.notFound, c.error], [[gone.vin], [], null], label);
      assert.ok(res.records.some((r) => r.node.vehicleIdentificationNumber === gone.vin), 'a car found at its page is back in the records');
    }
    if (want === 'error') {
      assert.ok(c.error, `${label}: an error`);
      assert.deepEqual(c.notFound, [], `${label}: nothing gone`);
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
  const res = await scanSite(bare, { confirmVins: [gone.vin], confirmUrls: { [gone.vin]: O + gone.path } });
  assert.deepEqual(res.confirm.notFound, []);
  assert.match(res.confirm.error, /carry no vehicle data/);
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

test('a scan that did not read everything says which way: cars missing, or pages that could not be read', async () => {
  assert.equal(incompleteWarning({ records: [1, 2], total: 3 }), 'The website returned 2 of 3 cars. Missing cars were double-checked one by one.');
  assert.equal(incompleteWarning({ records: [1, 2, 3], total: 3 }), "Some of the website's pages could not be read this time. Missing cars were double-checked one by one.");
  assert.equal(incompleteWarning({ records: [1, 2], unread: ['A'], total: 3 }), "One car's page could not be read this time, so that car shows what the last scan read.");
  assert.equal(incompleteWarning({ records: [1], unread: ['A', 'B'], total: 4 }), 'The website returned 3 of 4 cars. Missing cars were double-checked one by one.');
  const cars = standardCars(4);
  const siteMap = standardSite({ cars });
  siteMap.set(O + cars[1].path, httpError(503));
  const site = { origin: O, host: 'sample-motors.test', name: 'Sample Motors', title: 'Used', adapter: 'schemaOrg' };
  const out = await scanWithSearch({ adapter: schemaOrg, search: fakeSiteSearch(siteMap), site, settings: withDefaults({}, site), options: schemaOrg.scanOptions(SERVICE) });
  assert.equal(out.snapshot.complete, false);
  assert.equal(out.diff.warnings[0], "Some of the website's pages could not be read this time. Missing cars were double-checked one by one.", 'every car is known from the list; one page failed');
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
