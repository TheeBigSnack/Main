// The side panel's own list starts posts and queues on the same state the
// popup's posts use, so these run sidepanel.js's own functions, as written,
// with the rest of the panel replaced by stubs (the way photoHosts.test.js
// runs canAutoOpen):
//   - a queue reads cars through the tab it was started from, and never
//     through a tab an earlier post or to-do item left behind;
//   - a car already marked as posted never gets a second Marketplace form;
//   - one list action at a time, with the action still called inside the click;
//   - a load for a website the panel has moved away from is dropped;
//   - a car this person took down while the website still listed it reaches
//     review with a notice (posting rule 3), and a queue waits there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentVin } from '../extension/src/queue.js';
import { noteTakenDown, relistNotice } from '../extension/src/takenDown.js';
import { POSTING_RULES } from '../extension/src/postingRules.js';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
// A top-level function's text, from its declaration to the closing brace at the start of a line.
function fnText(name) {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}
// The function, compiled with the given names in scope (stubs, or the real module's exports).
function compile(name, scope) {
  const names = Object.keys(scope);
  return new Function(...names, `${fnText(name)}\nreturn ${name};`)(...names.map((n) => scope[n]));
}
const never = (what) => () => {
  throw new Error(`${what} must not run`);
};

test('a queue reads its cars through the tab it was started from, or through none', async () => {
  const run = async (queue, leftover) => {
    const started = [];
    const state = { origin: 'https://www.example-dealer.test', queue, dealerTabId: leftover, windowId: 3 };
    const startNextInQueue = compile('startNextInQueue', {
      state, currentVin, dailyCap: () => ({ reached: false }),
      pauseQueue: never('pauseQueue'), saveQueue: never('saveQueue'), clearFlow: never('clearFlow'), setStatus: never('setStatus'), render: never('render'),
      startFlow: async (req) => started.push(req),
    });
    await startNextInQueue();
    assert.equal(started.length, 1);
    return started[0];
  };
  const fromPanel = { vins: ['AAA', 'BBB'], index: 0, status: 'running', results: {}, dealerTabId: null, windowId: 9 };
  const req = await run(fromPanel, 41);
  assert.equal(req.dealerTabId, null, 'a queue from the panel\'s list never reads through a tab an earlier post left behind');
  assert.deepEqual([req.vin, req.queue, req.windowId], ['AAA', true, 9]);
  const fromPopup = { ...fromPanel, dealerTabId: 7 };
  assert.equal((await run(fromPopup, 41)).dealerTabId, 7, 'the popup\'s queue keeps its own dealer tab');
  assert.equal((await run({ ...fromPanel, dealerTabId: undefined }, 41)).dealerTabId, null, 'a queue that names no tab reads without one');
});

test('clearing a finished post forgets the tab and the window it came from', async () => {
  const state = { origin: 'https://www.example-dealer.test', vin: null, dealerTabId: 41, windowId: 3, step: 'done' };
  const clearFlow = compile('clearFlow', {
    state, watcher: null, pilotNote: never('pilotNote'), endPost: never('endPost'), FORM_MAP: {},
    siteKeys: (o) => ({ flow: 'postFlow:' + o }),
    chrome: { storage: { local: { remove: async () => {} } } },
  });
  await clearFlow();
  assert.deepEqual([state.dealerTabId, state.windowId, state.step], [null, null, 'idle']);
});

// startFlow up to the posted check: the stubs after it throw, so a car
// already posted must leave before the website is read or a post is begun.
function startFlowWith({ posted, queue }) {
  const calls = [];
  const state = { origin: 'https://www.example-dealer.test', posted, snapshotVehicles: { AAA: { name: '2020 Make Model' } } };
  const startFlow = compile('startFlow', {
    state,
    chrome: { storage: { local: { remove: async () => {} } } },
    GLOBAL_KEYS: { postRequest: 'postRequest' },
    endUpkeep: () => {},
    clearFlow: async () => calls.push('clearFlow'),
    loadSaved: async () => true,
    nameOf: (vin) => state.snapshotVehicles[vin].name,
    afterQueueStep: async (outcome) => {
      calls.push('afterQueueStep:' + outcome);
      state.step = 'queueDone';
    },
    setStatus: (text) => calls.push('status:' + text),
    render: () => calls.push('render'),
    refreshGranted: never('refreshGranted'),
    pilotNote: never('pilotNote'),
    readCarForPost: never('readCarForPost'),
  });
  return { calls, run: () => startFlow({ origin: state.origin, vin: 'aaa', dealerTabId: null, queue }) };
}

test('a car already marked as posted never gets a second form: the queue skips it, a single post stops', async () => {
  const q = startFlowWith({ posted: { AAA: { postedAt: '2026-10-01T10:00:00Z' } }, queue: true });
  await q.run();
  assert.deepEqual(q.calls, ['clearFlow', 'afterQueueStep:skipped', 'status:2020 Make Model is already marked as posted, so the queue skipped it.']);

  const one = startFlowWith({ posted: { AAA: {} }, queue: false });
  await one.run();
  assert.equal(one.calls[0], 'clearFlow');
  assert.equal(one.calls[1], 'clearFlow', 'the started post is cleared again, with no attempt recorded');
  assert.match(one.calls[2], /^status:2020 Make Model is already marked as posted on this website, so it isn't posted again\./);
  assert.equal(one.calls[3], 'render');

  // not posted: it goes on to read the website (the first stub that throws)
  await assert.rejects(startFlowWith({ posted: {}, queue: false }).run(), /refreshGranted must not run/);
});

test('one list action at a time, and the action itself still runs inside the click', async () => {
  const oneAtATime = new Function(`let listBusy = false;\n${fnText('oneAtATime')}\nreturn oneAtATime;`)();
  let release;
  let ranSync = false;
  const first = oneAtATime(() => {
    ranSync = true; // Chrome's prompt is asked from here: it must be before any await
    return new Promise((resolve) => (release = resolve));
  });
  assert.equal(ranSync, true, 'the action is called straight away, inside the click');
  let second = false;
  assert.equal(oneAtATime(async () => (second = true)), undefined, 'a second click while the first runs is ignored');
  assert.equal(second, false);
  release('done');
  assert.equal(await first, 'done');
  let third = false;
  await oneAtATime(async () => (third = true));
  assert.equal(third, true, 'free again once the first has finished');
  await assert.rejects(oneAtATime(async () => { throw new Error('boom'); }), /boom/);
  let fourth = false;
  await oneAtATime(async () => (fourth = true));
  assert.equal(fourth, true, 'free again after an action that failed');
});

test('a load for a website the panel has moved away from is dropped, so its cars never show under another', async () => {
  const B = 'https://www.b-motors.test';
  const C = 'https://www.c-motors.test';
  const pending = new Map();
  const state = { origin: B };
  const loadSaved = compile('loadSaved', {
    state,
    siteKeys: (o) => ({ settings: 's:' + o, snapshot: 'n:' + o, posted: 'p:' + o, boilerplate: 'b:' + o, queue: 'q:' + o, drafts: 'd:' + o, sync: 'y:' + o }),
    GLOBAL_KEYS: { sites: 'sites' },
    chrome: { storage: { local: { get: (keys) => new Promise((resolve) => pending.set(keys[0].slice(2), resolve)) } } },
    withDefaults: (s) => ({ ...s }),
    settingsFromProfile: never('settingsFromProfile'),
    loadProfile: never('loadProfile'),
  });
  const data = (o, vin) => ({ ['s:' + o]: { dailyCap: 10 }, ['n:' + o]: { site: { name: o }, vehicles: { [vin]: { vin } } }, ['p:' + o]: { [vin]: {} }, sites: { [o]: { name: o } } });
  const loadB = loadSaved();
  state.origin = C;
  const loadC = loadSaved();
  pending.get(C)(data(C, 'CCC'));
  assert.equal(await loadC, true);
  pending.get(B)(data(B, 'BBB'));
  assert.equal(await loadB, false, 'the slower load for the website left behind is dropped');
  assert.deepEqual(Object.keys(state.snapshotVehicles), ['CCC']);
  assert.deepEqual(Object.keys(state.posted), ['CCC']);
  assert.equal(state.siteName, C);
  assert.equal(state.siteInfo.name, C);
});

// startFlow from the request to review, every step past the posted check
// stubbed to pass; canAutoOpen is the panel's own, so a queue opens the form
// unless something holds the car at review.
async function reviewWith(takenDown, { queue = true } = {}) {
  const calls = [];
  const state = {
    origin: 'https://www.example-dealer.test', posted: {}, takenDown,
    snapshotVehicles: { AAA: { name: '2020 Make Model' } },
    settings: { salesperson: { name: 'Sam' }, basis: 'website' },
  };
  const canAutoOpen = compile('canAutoOpen', {
    state, currentListing: () => ({ missing: [], assumed: [] }), dailyCap: () => ({ reached: false }), photoPatterns: () => [], refusedPhotoServers: new Set(),
  });
  const startFlow = compile('startFlow', {
    state,
    chrome: { storage: { local: { remove: async () => {} } } },
    GLOBAL_KEYS: { postRequest: 'postRequest' },
    endUpkeep: () => {}, clearFlow: async () => {}, loadSaved: async () => true, refreshGranted: async () => {},
    nameOf: (vin) => state.snapshotVehicles[vin].name,
    afterQueueStep: never('afterQueueStep'), block: never('block'),
    setStatus: () => {}, render: () => {}, saveFlow: async () => {},
    pilotNote: async () => {}, beginPost: () => null, notePostStep: () => null,
    readCarForPost: async ({ vin }) => ({ ok: true, vehicle: { vin, name: '2020 Make Model', price: 20000, location: '' } }),
    recheck: () => ({ ok: true }), shortLocation: () => '', storeNames: () => [],
    localVinCheck: () => ({ ok: true }), basisPrice: (v) => v.price,
    maybeGuessColors: async () => {},
    generate: async () => { state.guardrails = { ok: true }; },
    relistNotice, canAutoOpen,
    openForm: async () => calls.push('openForm'),
  });
  await startFlow({ origin: state.origin, vin: 'aaa', dealerTabId: null, queue });
  return { state, calls };
}

test('a car this person took down while the website still listed it reaches review with the notice, and a queue waits there', async () => {
  const now = new Date();
  const ago = (h) => new Date(now.getTime() - h * 3600e3).toISOString();
  const bump = noteTakenDown(null, { vin: 'AAA', postedAt: ago(30), stillListed: true }, ago(2), ago(2));
  const held = await reviewWith(bump);
  assert.equal(held.state.step, 'review');
  assert.deepEqual(held.state.relist, { takenDownAt: ago(2), postedAt: ago(30) });
  assert.deepEqual(held.calls, [], 'the queue does not open the form by itself');

  // a car taken down because it sold (and back on the website since), or never taken down: the queue goes on as before
  for (const log of [noteTakenDown(null, { vin: 'AAA', postedAt: ago(30), stillListed: false }, ago(2), ago(2)), null]) {
    const r = await reviewWith(log);
    assert.equal(r.state.relist, null);
    assert.deepEqual(r.calls, ['openForm']);
  }

  // what the review says: when, the rule, and that it is not refused
  const relistHtml = compile('relistHtml', { state: { relist: { takenDownAt: '2026-10-01T15:00:00.000Z' } }, esc: (x) => String(x), when: () => 'Oct 1, 3:00 PM' });
  const html = relistHtml();
  assert.match(html, /id="relistNotice"/);
  assert.match(html, /You took this car off your listings on Oct 1, 3:00 PM, while the website still listed it\./);
  assert.match(html, /no deleting and reposting to bump a listing/);
  assert.ok(POSTING_RULES.some((r) => r.text.includes('no deleting and reposting to bump a listing')), 'the words are the posting rules\' own');
  assert.match(html, /Post it again only if the old listing is gone for another reason/);
  assert.equal(compile('relistHtml', { state: { relist: null }, esc: String, when: String })(), '');
  assert.match(fnText('viewReview'), /return `\$\{relistHtml\(\)\}\$\{carCard\(\)\}/, 'the review shows it first');
});
