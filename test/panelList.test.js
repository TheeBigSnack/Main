// The side panel's own Ready to post list (extension/src/panelList.js): the
// same cars, order, search and New pill as the popup's Ready tab, drafts
// listed without a Post, "Post the next N" held to the day's cap, which
// website the panel opens on, and which website permissions reading a car
// from the panel needs and which of them Chrome has already granted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyRows, nextToPost, siteChoices, defaultOrigin, siteReadOrigins, missingOrigins } from '../extension/src/panelList.js';
import { sortEntries } from '../extension/src/readyList.js';
import { snapshot, fixtures, MY_STORE } from './helpers.js';

const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime();
const entry = (vin, patch = {}) => ({ vin, name: `2020 Make Model ${vin}`, stock: `S${vin}`, price: 20000, decision: 'ready', ...patch });
const snap = (...entries) => ({ takenAt: '2026-10-01T10:00:00.000Z', vehicles: Object.fromEntries(entries.map((e) => [e.vin, e])) });

test('the list is the ready cars not yet posted, in the popup\'s order, with the price on the dealer\'s basis', () => {
  const s = snap(
    entry('AAA', { name: '2021 Honda Civic', price: 21000, dateInStock: '2026-09-20' }),
    entry('BBB', { name: '2019 Ford Escape', price: 18000, priceBeforeFees: 17500, dateInStock: '2026-09-29' }),
    entry('CCC', { name: '2018 Kia Soul', price: 12000 }),
    entry('DDD', { name: '2020 Jeep Wrangler', decision: 'not-ready' }),
    entry('EEE', { name: '2017 Ram 1500', decision: 'review' }),
    entry('FFF', { name: '2016 Toyota Camry', decision: 'skip' }),
    entry('GGG', { name: '2022 Ram 1500', price: 40000 }),
  );
  const out = readyRows(s, { posted: { GGG: { postedAt: '2026-09-30T10:00:00Z' } }, settings: {}, now: NOW });
  assert.equal(out.total, 3, 'only ready cars, and not the posted one');
  assert.equal(out.order, 'newest');
  assert.deepEqual(out.rows.map((r) => r.vin), ['BBB', 'AAA', 'CCC'], 'newest on the lot first, the undated car last');
  assert.deepEqual(out.rows.map((r) => r.price), [18000, 21000, 12000]);
  const byPrice = readyRows(s, { settings: { readySort: 'price', basis: 'beforeFees' }, now: NOW, posted: { GGG: {} } });
  assert.deepEqual(byPrice.rows.map((r) => [r.vin, r.price]), [['CCC', 12000], ['BBB', 17500], ['AAA', 21000]], 'the lower second price when the dealer posts at it');
  const byName = readyRows(s, { settings: { readySort: 'name' }, now: NOW, posted: { GGG: {} } });
  assert.deepEqual(byName.rows.map((r) => r.vin), ['CCC', 'BBB', 'AAA'], 'by name: the year comes first');
  assert.deepEqual(byName.rows.map((r) => r.vin), sortEntries(Object.values(s.vehicles).filter((e) => e.decision === 'ready' && e.vin !== 'GGG'), 'name').map((e) => e.vin), 'the same order sortEntries gives the popup');
  assert.equal(readyRows(s, { settings: { readySort: 'nonsense' }, now: NOW }).order, 'newest');
});

test('each row carries the popup\'s New pill and date line, and a draft is listed without a Post', () => {
  const s = snap(
    entry('AAA', { dateInStock: '2026-09-29' }),
    entry('BBB', { dateInStock: '2026-08-01' }),
    entry('CCC', { firstSeenAt: '2026-09-30T09:00:00.000Z' }),
  );
  const out = readyRows(s, { drafts: { BBB: { savedAt: '2026-09-30T10:00:00Z' } }, settings: { newDays: 7 }, now: NOW });
  const row = Object.fromEntries(out.rows.map((r) => [r.vin, r]));
  assert.equal(row.AAA.isNew, true);
  assert.equal(row.BBB.isNew, false);
  assert.equal(row.CCC.isNew, true, 'a sighting inside the window');
  assert.match(row.AAA.line, /^on the website since .* · 2 days on the lot$/);
  assert.match(row.CCC.line, /^Lot Current first saw it /);
  assert.equal(row.BBB.draft, true);
  assert.equal(row.AAA.draft, false);
  assert.equal(readyRows(s, { settings: { newDays: 1 }, now: NOW }).rows.find((r) => r.vin === 'AAA').isNew, false, 'the website\'s own window setting');
});

test('the search box keeps the cars every word matches, and the total still counts the rest', () => {
  const s = snap(
    entry('1C6RR7FT0KS643289', { name: '2019 Ram 1500 Classic Express', stock: 'R1234' }),
    entry('1FTFW1E50LFA00001', { name: '2020 Ford F-150 XLT', stock: 'F2020' }),
  );
  const ram = readyRows(s, { filter: 'ram classic', now: NOW });
  assert.deepEqual([ram.total, ram.shown, ram.rows[0].vin], [2, 1, '1C6RR7FT0KS643289']);
  assert.deepEqual(readyRows(s, { filter: 'f150', now: NOW }).rows.map((r) => r.vin), ['1FTFW1E50LFA00001']);
  assert.deepEqual(readyRows(s, { filter: '643289', now: NOW }).rows.map((r) => r.vin), ['1C6RR7FT0KS643289'], 'the end of the VIN');
  const none = readyRows(s, { filter: 'corvette', now: NOW });
  assert.deepEqual([none.total, none.shown, none.rows.length], [2, 0, 0]);
});

test('a snapshot from the real scan pipeline lists what the popup\'s Ready tab lists', () => {
  const s = snapshot([['usedNormal'], ['newNormal'], ['certified'], ['usedZeroMiles']], MY_STORE);
  const ready = Object.values(s.vehicles).filter((e) => e.decision === 'ready').map((e) => e.vin).sort();
  assert.ok(ready.length >= 1);
  assert.deepEqual(readyRows(s, { settings: MY_STORE, now: NOW }).rows.map((r) => r.vin).sort(), ready);
  assert.ok(!readyRows(s, { now: NOW }).rows.some((r) => r.vin === fixtures.newNormal.vin.toUpperCase()), 'a new car is never offered');
});

test('nothing breaks on an empty or missing snapshot', () => {
  for (const s of [null, undefined, {}, { vehicles: null }, { vehicles: {} }]) {
    assert.deepEqual(readyRows(s, { now: NOW }), { total: 0, shown: 0, order: 'newest', rows: [] });
  }
});

test('"Post the next N" takes the first cars in the order shown, skips drafts and stops at the day\'s remaining posts', () => {
  const rows = [{ vin: 'A' }, { vin: 'B', draft: true }, { vin: 'C' }, { vin: 'D' }, { vin: 'E' }];
  assert.deepEqual(nextToPost(rows, 3), ['A', 'C', 'D']);
  assert.deepEqual(nextToPost(rows, 10), ['A', 'C', 'D', 'E']);
  assert.deepEqual(nextToPost(rows, 0), []);
  assert.deepEqual(nextToPost(rows, -2), []);
  assert.deepEqual(nextToPost(rows, 2.9), ['A', 'C']);
  assert.deepEqual(nextToPost(rows, 'x'), []);
  assert.deepEqual(nextToPost(null, 5), []);
});

test('the website choice lists every website in the registry by name, and the panel opens on the last one it worked on', () => {
  const sites = {
    'https://www.b-motors.test': { name: 'B Motors', lastScan: '2026-09-30T10:00:00Z' },
    'https://www.a-motors.test': { name: 'A Motors', lastScan: '2026-10-01T09:00:00Z' },
    'https://www.c-motors.test': { site: { name: 'C Motors' } },
  };
  assert.deepEqual(siteChoices(sites).map((c) => c.name), ['A Motors', 'B Motors', 'C Motors']);
  assert.deepEqual(siteChoices(null), []);
  assert.equal(defaultOrigin(sites, 'https://www.b-motors.test'), 'https://www.b-motors.test');
  assert.equal(defaultOrigin(sites, 'https://www.cleared.test'), 'https://www.a-motors.test', 'a website no longer in the registry: the one scanned last');
  assert.equal(defaultOrigin(sites, null), 'https://www.a-motors.test');
  assert.equal(defaultOrigin({}, 'https://www.only-flow.test'), 'https://www.only-flow.test', 'an empty registry keeps the last website');
  assert.equal(defaultOrigin({}, null), null);
  assert.equal(defaultOrigin({ 'https://x.test': {} }, null), 'https://x.test', 'one website with no scan time is still the one');
});

test('reading a car from the panel needs the website and its inventory service, as automatic rescans do', () => {
  const di = { adapter: 'dealerInspire', service: { search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/1', apiKey: 'k' } };
  assert.deepEqual(siteReadOrigins('https://www.example-dealer.test', di).sort(), ['https://websites-search.api.carscommerce.inc/*', 'https://www.example-dealer.test/*']);
  const so = { adapter: 'schemaOrg', service: { kind: 'schemaOrg', origin: 'https://www.sample-motors.test', listUrl: 'https://www.sample-motors.test/used-vehicles/' } };
  assert.deepEqual(siteReadOrigins('https://www.sample-motors.test', so), ['https://www.sample-motors.test/*']);
  assert.deepEqual(siteReadOrigins('https://www.example-dealer.test', { adapter: 'dealerInspire' }), [], 'no service: nothing to read it through');
  assert.deepEqual(siteReadOrigins('https://www.example-dealer.test', null), []);
  assert.deepEqual(siteReadOrigins('', di), []);
  // the adapter is found from the service when the entry does not name it
  assert.equal(siteReadOrigins('https://www.example-dealer.test', { service: di.service }).length, 2);
});

test('which website patterns Chrome has not granted: by Chrome\'s own matching, so only the missing ones are asked for', () => {
  const need = ['https://www.example-dealer.test/*', 'https://websites-search.api.carscommerce.inc/*'];
  assert.deepEqual(missingOrigins(need, []), need);
  assert.deepEqual(missingOrigins(need, ['https://www.example-dealer.test/*']), ['https://websites-search.api.carscommerce.inc/*']);
  assert.deepEqual(missingOrigins(need, ['https://*.carscommerce.inc/*', 'https://www.example-dealer.test/*']), []);
  assert.deepEqual(missingOrigins(need, ['https://*/*']), [], 'every https website granted');
  assert.deepEqual(missingOrigins(need, ['<all_urls>']), []);
  assert.deepEqual(missingOrigins(need, ['https://www.facebook.com/marketplace/*', 'https://vehicle-images.carscommerce.inc/*']), need, 'the manifest\'s own hosts cover neither');
  assert.deepEqual(missingOrigins(['http://127.0.0.1:8080/*'], ['http://127.0.0.1/*']), ['http://127.0.0.1:8080/*'], 'not https: reported missing, and Chrome answers the request without a prompt when it is covered');
  assert.deepEqual(missingOrigins(null, ['https://*/*']), []);
});
