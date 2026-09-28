import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { startMockSite } from './e2e/mock-dealer-site.mjs';
import dealerInspire, { scan, getDetails, makeDirectSearch, detect, trimRecord, FIELDS, probeInPage, searchInPage, origins, scanOptions, photoOrigins } from '../extension/adapters/dealerInspire.js';
import { ADAPTERS, detectAdapter, adapterById, adapterForService, unsupportedSiteMessage, platformNames } from '../extension/adapters/index.js';
import { VEHICLE_FIELDS } from '../extension/src/vehicle.js';
import { scanWithSearch } from '../extension/src/scanRunner.js';
import { withDefaults } from '../extension/src/settings.js';
import { fixtures, fakeDealerPage, runInPage } from './helpers.js';

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

// Per platform: a real record of its shape, the service its probe returns
// and a search(body) that answers like its service. A new adapter needs its
// entry here (and a record in test/fixtures/).
const PLATFORM_FIXTURES = {
  dealerInspire: {
    record: fixtures.usedNormal,
    service: { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/1', apiKey: 'k', visibleStatusValues: ['publish', 'modified'], hasHelper: true },
    search: () => fakeSearch(records),
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
    const page = fakeDealerPage({ records });
    const service = await runInPage(page, a.probeInPage);
    assert.ok(service && typeof service === 'object', `${a.PLATFORM.id}.probeInPage returns its service on its own platform's page`);
    assert.equal(a.detect({ site: {}, service, adapterId: null }), true, `${a.PLATFORM.id}.detect recognises what its probe returned`);
    const r = await runInPage(page, a.searchInPage, service, { page: 1, perPage: 50, filters: { type: ['Used'] } });
    assert.equal(r.ok, true);
    assert.ok(r.data && Array.isArray(r.data.listings), `${a.PLATFORM.id}.searchInPage answers { ok, data }`);
    assert.equal(await runInPage(fakeDealerPage({ withService: false }), a.probeInPage), null, `${a.PLATFORM.id}.probeInPage is null on a page without its service`);
  }
});

test('scan, getDetails, normalize, origins, scanOptions and photoOrigins return the documented shapes', async () => {
  for (const a of ADAPTERS) {
    const fx = PLATFORM_FIXTURES[a.PLATFORM.id];
    const options = a.scanOptions(fx.service);
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    const res = await a.scan(fx.search(), { ...options, confirmVins: ['NOPE'] });
    assert.deepEqual(Object.keys(res).sort(), ['complete', 'confirm', 'fetchedAt', 'ok', 'records', 'requests', 'total'], `${a.PLATFORM.id}.scan return shape`);
    assert.deepEqual(Object.keys(res.confirm).sort(), ['checked', 'error', 'notFound']);
    assert.equal(res.ok, true);
    assert.ok(!Number.isNaN(Date.parse(res.fetchedAt)));
    assert.equal(typeof res.total, 'number');
    assert.equal(typeof res.complete, 'boolean');
    assert.ok(res.requests >= 1 && Array.isArray(res.records) && res.records.length);
    assert.deepEqual(res.confirm.notFound, ['NOPE']);
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
  assert.deepEqual(platformNames(), ['Dealer Inspire']);
  assert.equal(unsupportedSiteMessage(), "This page doesn't have an inventory search Lot Sync can read (platforms today: Dealer Inspire). Open your dealership's used inventory page and try again.");
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
    const alone = a.normalize(lot[0]);
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
