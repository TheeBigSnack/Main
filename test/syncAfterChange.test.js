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
import { noteFlags } from '../extension/src/pilot.js';
import { STORAGE_FULL } from '../extension/src/storage.js';

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
// chrome.alarms as Chrome keeps them: by name, a new one replacing the old.
// The worker's alarm listeners are kept so a test can fire one.
const alarms = new Map();
const alarmListeners = [];
globalThis.chrome = {
  alarms: {
    onAlarm: { addListener(fn) { alarmListeners.push(fn); } },
    async create(name, info) { alarms.set(name, { name, ...info }); },
    async clear(name) { return alarms.delete(name); },
    async get(name) { return alarms.get(name) || null; },
  },
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

// The account server's sync function turns a person's syncs away past a
// dozen a minute (supabase/functions/sync/index.ts, PER_MINUTE) with a 429
// and "try again in a minute". A salesperson marking a lot of cars on day
// one passes that: the sync turned away is tried again a minute later, by a
// one-shot alarm (a timer would not outlive the worker), so the last
// changes are not left waiting for the next scan or post.
function limitedServer() {
  const answered = []; // when each sync got through, by the server's clock
  const sent = [];
  const server = { clock: Date.now(), sent, failNext: 0 };
  server.fetchImpl = async (url, init = {}) => {
    if (!String(url).endsWith('/sync')) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
    if (server.failNext > 0) {
      server.failNext -= 1;
      return { ok: false, status: 500, json: async () => ({ ok: false, error: 'database unavailable' }) };
    }
    if (answered.filter((t) => server.clock - t < 60000).length >= 12) return { ok: false, status: 429, json: async () => ({ ok: false, error: 'too many syncs; try again in a minute' }) };
    answered.push(server.clock);
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, serverTime: new Date(server.clock).toISOString(), dealership: { id: 'd1', name: 'Example Motors', websiteOrigin: ORIGIN }, role: 'salesperson', listings: [], counts: {} }) };
  };
  return server;
}

const retryAlarm = () => [...alarms.values()].find((a) => a.name.includes(ORIGIN)) || null;
const fireAlarm = (alarm) => Promise.all(alarmListeners.map((fn) => fn({ name: alarm.name, scheduledTime: Date.now() })));

test('fourteen take-downs in a row, past the server\'s dozen syncs a minute, all reach the dealership: the sync turned away is tried again a minute later', async () => {
  const vins = Array.from({ length: 14 }, (_, i) => `TESTVIN0000000${String(i).padStart(3, '0')}`);
  const area = localArea({
    [GLOBAL_KEYS.account]: session(),
    [k.posted]: Object.fromEntries(vins.map((vin, i) => [vin, { name: `Car ${i}`, price: 10000, postedAt: new Date().toISOString() }])),
    [SITES_KEY]: { [ORIGIN]: { name: 'Example Motors' } },
  });
  globalThis.chrome.storage.local = area;
  alarms.clear();
  const server = limitedServer();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = server.fetchImpl;
  try {
    const results = [];
    for (const vin of vins) {
      const left = { ...area.data[k.posted] };
      delete left[vin]; // Taken down in the popup
      area.data[k.posted] = left;
      results.push(await syncSite(ORIGIN)); // the popup's request, answered before the next click
      server.clock += 2000; // a click every two seconds
    }
    assert.equal(results.filter((r) => r.ok).length, 12, 'a dozen got through');
    assert.equal(results[12].ok, false);
    assert.equal(results[13].status, 429);
    assert.equal(server.sent.length, 12);
    assert.match(JSON.stringify(server.sent[11].posted), new RegExp(vins[13]), 'the last two take-downs have not reached the server yet');

    const alarm = retryAlarm();
    assert.ok(alarm, 'a sync is set for later');
    assert.equal(alarm.delayInMinutes, 1, 'once the server\'s minute has passed');
    assert.equal(alarm.periodInMinutes, undefined, 'once, not over and over');
    assert.equal(alarms.size, 1, 'one alarm for the website, however many syncs were turned away');
    const entry = area.data[SITES_KEY][ORIGIN];
    assert.equal(entry.lastSyncError, 'too many syncs; try again in a minute');
    assert.ok(Date.parse(entry.lastSyncRetry) > Date.now(), 'Settings can say when it tries again');
    assert.equal(results[13].retryAt, entry.lastSyncRetry, 'Sync now can say so too');

    // a minute later the alarm goes off (Chrome forgets a one-shot alarm once it has fired)
    server.clock += 60000;
    alarms.delete(alarm.name);
    await fireAlarm(alarm);
    assert.equal(server.sent.length, 13, 'one more sync');
    assert.equal(JSON.stringify(server.sent[12].posted), '{}', 'every take-down has reached the dealership');
    const after = area.data[SITES_KEY][ORIGIN];
    assert.equal(after.lastSyncError, null, 'Settings no longer shows the refusal');
    assert.equal(after.lastSyncRetry, null);
    assert.ok(after.lastSync);
    assert.equal(retryAlarm(), null, 'nothing left set');
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test('a sync that gets through before the retry is due cancels it; a sync that fails for another reason sets none', async () => {
  const area = localArea({ [GLOBAL_KEYS.account]: session(), [k.posted]: { [VIN_A]: { name: 'Car A', price: 10000, postedAt: new Date().toISOString() } }, [SITES_KEY]: { [ORIGIN]: { name: 'Example Motors' } } });
  globalThis.chrome.storage.local = area;
  alarms.clear();
  const server = limitedServer();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = server.fetchImpl;
  try {
    for (let i = 0; i < 13; i++) await syncSite(ORIGIN);
    assert.ok(retryAlarm(), 'the thirteenth was turned away: a retry is set');
    server.clock += 61000;
    assert.equal((await syncSite(ORIGIN)).ok, true, 'Sync now, a minute later');
    assert.equal(retryAlarm(), null, 'the retry is cancelled: that sync sent everything');
    assert.equal(area.data[SITES_KEY][ORIGIN].lastSyncRetry, null);

    server.failNext = 1;
    const failed = await syncSite(ORIGIN);
    assert.equal(failed.ok, false);
    assert.equal(failed.retryAt, undefined);
    assert.equal(retryAlarm(), null, 'only the server asking to wait sets a retry');
    assert.equal(area.data[SITES_KEY][ORIGIN].lastSyncError, 'database unavailable');
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

// ---------- listing upkeep ----------

const ctx = { render() {}, map: () => ({}), onClose() {} };
async function finishUpkeep(kind, local) {
  globalThis.chrome.storage.local = localArea(local);
  messages.length = 0;
  Object.assign(up, { active: true, origin: ORIGIN, vin: VIN_A, kind, price: kind === 'price' ? 9500 : null, listingUrl: '', name: 'Car A', listedPrice: 10000, tabId: null, status: 'waiting', note: '', error: '', fills: 0, baseline: null, offTarget: false });
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

// The item's flag in the pilot numbers closes before the item leaves the
// diff, inside the writes whose failure leaves it open: a fix on the posted
// list whose flag stayed open would be lost at the next sync (the sync
// function files no item for an open flag the listing already shows, and
// mergeFlags drops that flag). So a flag that cannot be saved (storage full)
// is shown, the item stays, nothing syncs, and I updated it / I took it down
// closes it once there is room.
// A car flagged both sold and at a new price leaves the diff on both lists
// when it is taken down, so both its flags close, as the popup's Taken down
// closes them: a price flag left open would later close as cleared, or go up
// as an open item for a car that is down.
test('I took it down in the side panel closes the car\'s price item along with its take-down', async () => {
  const pilot = noteFlags(null, { takeDown: [{ vin: VIN_A, name: 'Car A', yours: true, why: 'gone' }], priceUpdates: [{ vin: VIN_A, name: 'Car A', yours: true, from: 10000, to: 9500 }, { vin: VIN_B, name: 'Car B', yours: true, from: 20000, to: 19000 }], warnings: [] }, { at: '2026-10-01T09:00:00.000Z' });
  const area = await finishUpkeep('takeDown', {
    [k.posted]: { [VIN_A]: { name: 'Car A', price: 10000, postedAt: '2026-10-01T08:00:00.000Z' }, [VIN_B]: { name: 'Car B', price: 20000, postedAt: '2026-10-01T08:00:00.000Z' } },
    [k.diff]: { takeDown: [{ vin: VIN_A, name: 'Car A' }], priceUpdates: [{ vin: VIN_A, name: 'Car A', from: 10000, to: 9500 }, { vin: VIN_B, name: 'Car B', from: 20000, to: 19000 }] },
    [k.pilot]: pilot,
  });
  const flags = area.data[k.pilot].flags;
  assert.deepEqual(flags.filter((f) => f.vin === VIN_A).map((f) => [f.kind, Boolean(f.doneAt), f.how]).sort(), [['price', true, 'manual'], ['takeDown', true, 'manual']], 'both of car A\'s items close');
  assert.deepEqual(area.data[k.diff].priceUpdates.map((x) => x.vin), [VIN_B], 'as both leave the diff');
  assert.deepEqual(flags.filter((f) => f.vin === VIN_B).map((f) => [f.kind, f.doneAt]), [['price', undefined]], 'another car\'s item stays open');
});

test('upkeep whose to-do flag cannot be saved says why, leaves the item to do and syncs nothing; the same click closes it once there is room', async () => {
  for (const kind of ['takeDown', 'price']) {
    const flagKind = kind === 'price' ? 'price' : 'takeDown';
    const pilot = noteFlags(null, { takeDown: kind === 'takeDown' ? [{ vin: VIN_A, name: 'Car A', yours: true, why: 'gone' }] : [], priceUpdates: kind === 'price' ? [{ vin: VIN_A, name: 'Car A', yours: true, from: 10000, to: 9500 }] : [], warnings: [] }, { at: '2026-10-01T09:00:00.000Z' });
    const local = {
      [GLOBAL_KEYS.account]: session(),
      [k.posted]: { [VIN_A]: { name: 'Car A', price: 10000, postedAt: '2026-10-01T08:00:00.000Z' } },
      [k.diff]: { takeDown: kind === 'takeDown' ? [{ vin: VIN_A, name: 'Car A' }] : [], priceUpdates: kind === 'price' ? [{ vin: VIN_A, name: 'Car A', from: 10000, to: 9500 }] : [] },
      [k.pilot]: pilot,
    };
    const area = localArea(local);
    const set = area.set;
    let full = true;
    area.set = async (obj) => {
      if (full && k.pilot in obj) throw new Error('QUOTA_BYTES quota exceeded');
      return set(obj);
    };
    globalThis.chrome.storage.local = area;
    messages.length = 0;
    Object.assign(up, { active: true, origin: ORIGIN, vin: VIN_A, kind, price: kind === 'price' ? 9500 : null, listingUrl: '', name: 'Car A', listedPrice: 10000, tabId: null, status: 'waiting', note: '', error: '', fills: 0, baseline: null, offTarget: false });
    const item = () => (area.data[k.diff][kind === 'price' ? 'priceUpdates' : 'takeDown'] || []).some((x) => x.vin === VIN_A);
    const flag = () => area.data[k.pilot].flags.find((f) => f.vin === VIN_A && f.kind === flagKind);

    assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
    assert.equal(up.error, STORAGE_FULL, `${kind}: the reason is shown`);
    assert.notEqual(up.status, 'done', `${kind}: not marked done`);
    assert.ok(item(), `${kind}: the item stays to do`);
    assert.equal(flag().doneAt, undefined, `${kind}: its flag is still open`);
    assert.deepEqual(messages.filter((m) => m.type === 'syncNow'), [], `${kind}: nothing synced`);

    full = false;
    assert.equal(await handleUpkeepClick('upkeepDoneBtn', ctx), true);
    assert.equal(up.status, 'done', up.error);
    assert.equal(flag().how, 'manual', `${kind}: the flag closes`);
    assert.ok(!item(), `${kind}: and the item leaves the diff`);
    assert.deepEqual(messages.filter((m) => m.type === 'syncNow'), [{ type: 'syncNow', origin: ORIGIN }], `${kind}: then it syncs`);
  }
});

