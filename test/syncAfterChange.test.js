// What a salesperson records goes to the dealership's account at once while
// they are signed in, not only with the next rescan: the service worker's
// syncSite (background.js) runs one more sync after the one under way when
// another is asked for meanwhile, so a change made a second after the last
// one is never left behind; and listing upkeep (upkeep.js) asks for a sync
// once it has recorded a take-down or a price update. The popup's own
// requests are clicked through in test/popup.test.js.
//
// Nothing here reaches the network: fetch is a stand-in that answers every
// address, and chrome is a stand-in with local storage only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteKeys, SITES_KEY, GLOBAL_KEYS } from '../extension/src/storageKeys.js';
import { sessionFromTokenResponse } from '../extension/src/account.js';

const ORIGIN = 'https://www.example-motors.test';
const k = siteKeys(ORIGIN);
const VIN_A = 'TESTVIN00000000A1';
const VIN_B = 'TESTVIN00000000B2';

// chrome.storage.local's shape, over a plain object.
function localArea(data) {
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const out = {};
      for (const key of [].concat(keys)) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const session = () => sessionFromTokenResponse({
  access_token: `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`,
  token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-1', user: { id: 'u1', email: 'alex@example.test' },
}, Date.now());

const messages = [];
const listeners = { addListener() {} };
globalThis.chrome = {
  alarms: { onAlarm: listeners },
  runtime: { onMessage: listeners, onInstalled: listeners, onStartup: listeners, sendMessage: async (msg) => { messages.push(msg); return {}; } },
  storage: { local: localArea({}) },
};
const { syncSite } = await import('../extension/background.js');
const { up, handleUpkeepClick } = await import('../extension/upkeep.js');

// A stand-in for the sync function: records what each request sent, and
// holds the first answer until `release` is called.
function syncServer() {
  const sent = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (!String(url).endsWith('/sync')) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
    sent.push(body);
    if (sent.length === 1) await held;
    return { ok: true, status: 200, json: async () => ({ ok: true, serverTime: new Date().toISOString(), dealership: { id: 'd1', name: 'Example Motors', websiteOrigin: ORIGIN }, role: 'salesperson', listings: [], counts: {} }) };
  };
  return { sent, release, fetchImpl };
}

const vinsIn = (body) => JSON.stringify(body.posted);
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('a sync asked for while one is under way runs once more after it, sending what changed meanwhile, and every request gets that result', async () => {
  const area = localArea({ [GLOBAL_KEYS.account]: session(), [k.posted]: { [VIN_A]: { name: 'Car A', price: 10000, postedAt: new Date().toISOString() } }, [SITES_KEY]: { [ORIGIN]: { name: 'Example Motors' } } });
  globalThis.chrome.storage.local = area;
  const server = syncServer();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = server.fetchImpl;
  try {
    const first = syncSite(ORIGIN); // a post confirmed in the side panel
    await until(() => server.sent.length === 1);
    assert.equal(server.sent.length, 1);
    assert.match(vinsIn(server.sent[0]), new RegExp(VIN_A));
    // a second car marked posted in the popup while that sync is out, then a take-down: two requests
    area.data[k.posted] = { ...area.data[k.posted], [VIN_B]: { name: 'Car B', price: 12000, postedAt: new Date().toISOString() } };
    const second = syncSite(ORIGIN);
    const third = syncSite(ORIGIN);
    assert.equal(second, third, 'both requests wait for the same follow-up');
    server.release();
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    assert.equal(r1.ok, true);
    assert.equal(server.sent.length, 2, 'one more sync, not one per request');
    assert.match(vinsIn(server.sent[1]), new RegExp(VIN_B), 'the follow-up carries the car marked meanwhile');
    assert.equal(r2.ok, true);
    assert.equal(r2, r3);
    assert.ok(area.data[SITES_KEY][ORIGIN].lastSync, 'the result is recorded for Settings');

    // nothing under way: a request is one sync
    await syncSite(ORIGIN);
    assert.equal(server.sent.length, 3);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

// ---------- listing upkeep ----------

const ctx = { render() {}, map: () => ({}), onClose() {} };
async function finishUpkeep(kind, local) {
  globalThis.chrome.storage.local = localArea(local);
  messages.length = 0;
  Object.assign(up, { active: true, origin: ORIGIN, vin: VIN_A, kind, price: kind === 'price' ? 9500 : null, basis: null, listingUrl: '', name: 'Car A', listedPrice: 10000, tabId: null, status: 'waiting', note: '', error: '', fills: 0, baseline: null, offTarget: false });
  assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
  assert.equal(up.status, 'done', up.error);
  return globalThis.chrome.storage.local;
}

test('a take-down or price update recorded in the side panel asks the worker to sync while signed in, and not while signed out', async () => {
  const posted = () => ({ [VIN_A]: { name: 'Car A', price: 10000, postedAt: '2026-10-01T08:00:00.000Z' } });
  const diff = () => ({ takeDown: [{ vin: VIN_A, name: 'Car A' }], priceUpdates: [{ vin: VIN_A, name: 'Car A', from: 10000, to: 9500 }] });

  let area = await finishUpkeep('takeDown', { [GLOBAL_KEYS.account]: session(), [k.posted]: posted(), [k.diff]: diff() });
  assert.equal(area.data[k.posted][VIN_A], undefined, 'taken off the posted list');
  assert.deepEqual(messages.filter((m) => m.type === 'syncNow'), [{ type: 'syncNow', origin: ORIGIN }]);

  area = await finishUpkeep('price', { [GLOBAL_KEYS.account]: session(), [k.posted]: posted(), [k.diff]: diff() });
  assert.equal(area.data[k.posted][VIN_A].price, 9500);
  assert.deepEqual(messages.filter((m) => m.type === 'syncNow'), [{ type: 'syncNow', origin: ORIGIN }]);

  await finishUpkeep('takeDown', { [k.posted]: posted(), [k.diff]: diff() }); // signed out
  assert.deepEqual(messages.filter((m) => m.type === 'syncNow'), [], 'nothing to sync with');
  assert.ok(messages.some((m) => m.type === 'updateBadge'), 'the badge is still updated');
});
