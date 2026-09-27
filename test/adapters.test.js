import { test } from 'node:test';
import assert from 'node:assert/strict';
import dealerInspire, { scan, getDetails, makeDirectSearch, detect, trimRecord, FIELDS } from '../extension/adapters/dealerInspire.js';
import { detectAdapter, adapterById } from '../extension/adapters/index.js';
import { fixtures } from './helpers.js';

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

test('detect: the probe must show the search service', () => {
  assert.equal(detect({ service: { search: 'https://x/api/v1/listings/1', apiKey: 'k' } }), true);
  assert.equal(detect({ service: null }), false);
  assert.equal(detect(null), false);
  assert.equal(detectAdapter({ service: { search: 'https://x', apiKey: 'k' } }), dealerInspire);
  assert.equal(adapterById('dealerInspire').PLATFORM.name, 'Dealer Inspire (Cars Commerce search)');
  assert.equal(adapterById('nope'), null);
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
